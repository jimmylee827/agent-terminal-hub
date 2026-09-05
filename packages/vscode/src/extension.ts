import { existsSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';

import {
  ELECTION_DIR,
  REQUEST_DIR,
  configuredHosts,
  Watcher,
  agentPrompt,
  create,
  doctor,
  ensureLayout,
  gc,
  kill,
  pruneClaims,
  pruneElections,
  pruneRequests,
  reapClaimsForDeadSessions,
  purgeLog,
  rename,
  setExtraInteractiveCommands,
  setExtraPromptPatterns,
  setPinned,
  type Session,
  type StateChange,
} from '@ath/core';

import {
  announceNeedsInput,
  drainRequests,
  forgetSession,
  joinNeedsInputElection,
  noteNotWaiting,
  noteSessions,
  sessionOfElectionFile,
} from './notify';
import { StatusBar } from './status';
import { attachTerminal, disposeAll, forgetTerminal } from './terminal';
import { SessionTreeProvider, type Node } from './tree';

let watcher: Watcher | undefined;
let requestWatcher: FSWatcher | undefined;
let electionWatcher: FSWatcher | undefined;

/** Last successful poll, used to reap claims whose session has since died. */
let polledOnce = false;
let liveSessions = new Set<string>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await ensureLayout();

  const tree = new SessionTreeProvider();
  const status = new StatusBar();

  const view = vscode.window.createTreeView('athSessions', {
    treeDataProvider: tree,
    showCollapseAll: false,
  });
  context.subscriptions.push(view, status);

  applyPromptPatterns();

  // ---- polling watcher -------------------------------------------------

  const startWatcher = (): void => {
    watcher?.stop();
    const config = vscode.workspace.getConfiguration('ath');
    watcher = new Watcher({
      activeMs: config.get<number>('pollIntervalMs', 800),
      idleMs: config.get<number>('idlePollIntervalMs', 3000),
    });

    watcher.on('list', (sessions: Session[]) => {
      // Before noteNotWaiting/announceNeedsInput, which read this to work out
      // whether this window's workspace owns the session that is prompting.
      noteSessions(sessions);
      for (const session of sessions) {
        if (session.state !== 'needs-input') noteNotWaiting(session.name);
      }
      tree.update(sessions);
      status.update(sessions);
      view.badge =
        sessions.some((s) => s.state === 'needs-input')
          ? { value: sessions.filter((s) => s.state === 'needs-input').length, tooltip: 'Waiting for you' }
          : undefined;
      const live = new Set(sessions.map((s) => s.name));
      void pruneRequests(live);
      // Only once a poll has actually succeeded: an empty list from a failed
      // poll would otherwise look like "every session died" and reap the
      // claims of sessions that are prompting right now.
      polledOnce = true;
      liveSessions = live;
    });

    watcher.on('needs-input', (session: Session) => void announceNeedsInput(session));

    watcher.on('change', (change: StateChange) => {
      if (change.current === 'gone') forgetSession(change.name);
    });

    // tmux not being installed should surface once, not once per poll.
    let reportedError = false;
    watcher.on('error', (err: Error) => {
      if (reportedError) return;
      reportedError = true;
      void vscode.window.showErrorMessage(`Agent Terminal Hub: ${err.message}`);
    });

    watcher.start();
  };

  startWatcher();

  // Throttle rather than stop while the panel is hidden: the panel is hidden
  // most of the time, and that is exactly when a "needs input" notification
  // matters most.
  watcher?.setThrottled(!view.visible);
  context.subscriptions.push(
    view.onDidChangeVisibility((e) => watcher?.setThrottled(!e.visible)),
  );

  // Sessions otherwise accumulate forever; nothing else reaps them. Claims are
  // swept alongside: they are normally released explicitly, so what is left
  // here is a window that was closed with a notification still on screen.
  const sweep = (): void => {
    void gc().catch(() => undefined);
    void pruneClaims().catch(() => undefined);
    void pruneElections().catch(() => undefined);
  };
  sweep();
  const gcTimer = setInterval(sweep, 6 * 60 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(gcTimer) });

  // ---- explicit agent requests ----------------------------------------

  await fs.mkdir(REQUEST_DIR, { recursive: true }).catch(() => undefined);
  void drainRequests();
  try {
    let debounce: NodeJS.Timeout | undefined;
    requestWatcher = fsWatch(REQUEST_DIR, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void drainRequests(), 150);
    });
  } catch {
    // Watching is a convenience; requests are still drained on activation.
  }

  // Re-drain periodically. Claims make this idempotent — a request already on
  // screen in some window is skipped — and it closes the hole that per-window
  // deduping opens: previously every window showed a request, so closing one
  // left the others; now exactly one window owns it, and if THAT window is
  // closed with the dialog still up, someone has to pick the request back up.
  const drainTimer = setInterval(() => {
    void drainRequests();
    if (polledOnce) void reapClaimsForDeadSessions(liveSessions).catch(() => undefined);
    // A window still mid-contest when the prompt clears re-creates the marker
    // just after it was released, so markers outlive their contest. Harmless —
    // a stale one is replaced rather than obeyed — but sweeping them here
    // rather than only in the six-hourly pass stops ~/.ath/election silting up.
    void pruneElections().catch(() => undefined);
  }, 10_000);
  context.subscriptions.push({ dispose: () => clearInterval(drainTimer) });

  // ---- notification contests -------------------------------------------

  // The piece that makes ranking mean anything. Whichever window's poll notices
  // a prompt first opens a contest; this watch wakes every OTHER window within
  // milliseconds, so a window with the right project open competes even though
  // its own poll has not come round yet. Poll intervals differ by design — 3s
  // when a panel is hidden, 0.8s when it is open — and without this the window
  // that merely looked first always won, whatever its rank.
  await fs.mkdir(ELECTION_DIR, { recursive: true }).catch(() => undefined);
  try {
    electionWatcher = fsWatch(ELECTION_DIR, (_event, filename) => {
      if (!filename) return;
      const name = sessionOfElectionFile(String(filename));
      if (!name) return;
      // Only a marker that EXISTS is an invitation to contest.
      //
      // fs.watch reports creation and deletion identically, and releasing a
      // claim DELETES the marker — so treating every event as a new contest
      // meant answering a prompt immediately started a fresh round of
      // notifications about that same prompt, which then released, which
      // notified again. Observed as an endless drip about a script that had
      // already finished, including for sessions that no longer existed.
      if (!existsSync(join(ELECTION_DIR, String(filename)))) return;
      void joinNeedsInputElection(name);
    });
  } catch {
    // Without the watch each window still competes on its own poll, which is
    // the pre-contest behaviour: a worse winner, never a missed notification.
  }

  // ---- commands --------------------------------------------------------

  const sessionOf = (node?: Node): Session | undefined => {
    if (node && node.kind === 'session') return node.session;
    return undefined;
  };

  const pickSession = async (node: Node | undefined, title: string): Promise<Session | undefined> => {
    const direct = sessionOf(node);
    if (direct) return direct;
    const sessions = tree.getSessions();
    if (sessions.length === 0) {
      void vscode.window.showInformationMessage('No terminal sessions yet.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      sessions.map((s) => ({ label: s.name, description: `${s.state} · ${s.cwd}`, session: s })),
      { title },
    );
    return picked?.session;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('ath.refresh', () => watcher?.poke()),

    vscode.commands.registerCommand('ath.newSession', async () => {
      const name = await vscode.window.showInputBox({
        title: 'New terminal session',
        prompt: 'Name for this terminal (leave empty to auto-name)',
        placeHolder: 'build',
        validateInput: (value) =>
          value && !/^[A-Za-z0-9._-]{1,64}$/.test(value)
            ? 'Letters, digits, dot, dash or underscore only'
            : undefined,
      });
      if (name === undefined) return;

      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      try {
        const session = await create({ name: name || undefined, cwd, owner: 'human' });
        watcher?.poke();
        attachTerminal(session.name);
      } catch (err) {
        void vscode.window.showErrorMessage(`Could not create session: ${message(err)}`);
      }
    }),

    // The GUI half of "remote is native". Until now --remote was CLI-only, so
    // a remote session could not be started from the editor at all.
    vscode.commands.registerCommand('ath.newRemoteSession', async () => {
      const hosts = await configuredHosts().catch(() => [] as string[]);
      const OTHER = 'Other host…';
      let host: string | undefined;

      if (hosts.length > 0) {
        const picked = await vscode.window.showQuickPick([...hosts, OTHER], {
          title: 'Connect a terminal to which host?',
          placeHolder: 'From your ~/.ssh/config',
        });
        if (picked === undefined) return;
        host = picked === OTHER ? undefined : picked;
      }

      if (host === undefined) {
        host = await vscode.window.showInputBox({
          title: 'Remote host',
          prompt: 'Anything ssh accepts: an alias, user@host, or a hostname',
          placeHolder: 'dev@example.com',
          validateInput: (v) => (v.trim() ? undefined : 'A host is required'),
        });
        if (!host) return;
        host = host.trim();
      }

      const name = await vscode.window.showInputBox({
        title: `New terminal on ${host}`,
        prompt: 'Name for this terminal (leave empty to auto-name)',
        placeHolder: host.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 20),
        validateInput: (value) =>
          value && !/^[A-Za-z0-9._-]{1,64}$/.test(value)
            ? 'Letters, digits, dot, dash or underscore only'
            : undefined,
      });
      if (name === undefined) return;

      try {
        // Progress, because the first connection to a host can stop on a
        // passphrase or host-key prompt — which is the hub's whole point, but
        // looks like a hang if nothing says what is happening.
        const session = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Connecting to ${host}…` },
          () => create({ name: name || undefined, remote: host, owner: 'human' }),
        );
        watcher?.poke();
        attachTerminal(session.name);
      } catch (err) {
        void vscode.window.showErrorMessage(`Could not connect to ${host}: ${message(err)}`);
      }
    }),

    vscode.commands.registerCommand('ath.attach', async (node?: Node) => {
      const session = await pickSession(node, 'Attach to terminal');
      if (session) attachTerminal(session.name);
    }),

    vscode.commands.registerCommand('ath.kill', async (node?: Node) => {
      const session = await pickSession(node, 'Kill terminal');
      if (!session) return;
      const confirm = await vscode.window.showWarningMessage(
        `Kill terminal "${session.name}"?`,
        { modal: true, detail: 'Its shell state is lost. Any agent using it is told the session is gone.' },
        'Kill',
      );
      if (confirm !== 'Kill') return;
      // A human clicked through a modal confirmation, so a pin is theirs to
      // override. The guard exists to stop an AGENT killing a pinned session.
      await kill(session.name, 'killed from the hub', { force: true });
      watcher?.poke();
    }),

    // Three commands for one concept, because an inline menu icon is fixed per
    // command: showing a filled pin when pinned and an outline when not needs
    // a separate command per state, selected by a `when` clause on the row's
    // contextValue. A single toggle button never changes appearance, which
    // leaves no way to tell which state you are in.
    vscode.commands.registerCommand('ath.pin', async (node?: Node) => {
      const session = await pickSession(node, 'Keep alive');
      if (!session) return;
      await setPinned(session.name, true);
      watcher?.poke();
    }),

    vscode.commands.registerCommand('ath.unpin', async (node?: Node) => {
      const session = await pickSession(node, 'Stop keeping alive');
      if (!session) return;
      await setPinned(session.name, false);
      watcher?.poke();
    }),

    vscode.commands.registerCommand('ath.togglePin', async (node?: Node) => {
      const session = await pickSession(node, 'Toggle keep-alive');
      if (!session) return;
      await setPinned(session.name, !session.pinned);
      watcher?.poke();
    }),

    vscode.commands.registerCommand('ath.copyPrompt', async (node?: Node) => {
      const session = await pickSession(node, 'Copy agent prompt');
      if (!session) return;
      await vscode.env.clipboard.writeText(agentPrompt(session));
      void vscode.window.showInformationMessage(
        `Copied handoff prompt for "${session.name}". Paste it to your agent.`,
      );
    }),

    vscode.commands.registerCommand('ath.showLog', async (node?: Node) => {
      const session = await pickSession(node, 'Show session log');
      if (!session) return;
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(session.logPath));
      await vscode.window.showTextDocument(doc, { preview: true });
    }),

    vscode.commands.registerCommand('ath.rename', async (node?: Node) => {
      const session = await pickSession(node, 'Rename session');
      if (!session) return;
      const next = await vscode.window.showInputBox({
        title: `Rename "${session.name}"`,
        value: session.name,
        validateInput: (value) =>
          /^[A-Za-z0-9._-]{1,64}$/.test(value) ? undefined : 'Letters, digits, dot, dash or underscore only',
      });
      if (!next || next === session.name) return;
      try {
        await rename(session.name, next);
        watcher?.poke();
      } catch (err) {
        void vscode.window.showErrorMessage(`Rename failed: ${message(err)}`);
      }
    }),

    vscode.commands.registerCommand('ath.purge', async (node?: Node) => {
      const session = await pickSession(node, 'Purge recorded output');
      if (!session) return;
      const confirm = await vscode.window.showWarningMessage(
        `Purge recorded output for "${session.name}"?`,
        {
          modal: true,
          detail:
            'Anything you typed at an echoing prompt (an API key, a token) is recorded in this ' +
            'log and readable by agents. Purging empties it. The session itself keeps running.',
        },
        'Purge',
      );
      if (confirm !== 'Purge') return;
      await purgeLog(session.name);
      void vscode.window.showInformationMessage(`Purged the log for "${session.name}".`);
    }),

    vscode.commands.registerCommand('ath.doctor', async () => {
      const channel = vscode.window.createOutputChannel('Agent Terminal Hub');
      const { ok, checks } = await doctor();
      channel.clear();
      for (const [label, pass, detail] of checks) {
        channel.appendLine(`${pass ? 'ok  ' : 'FAIL'}  ${label.padEnd(24)} ${detail}`);
      }
      channel.appendLine(ok ? '\nall good' : '\nsome checks failed');
      channel.show();
    }),
  );

  // A terminal the user closed is no longer a live attachment.
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => forgetTerminal(terminal)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('ath.extraPromptPatterns') ||
        event.affectsConfiguration('ath.extraInteractiveCommands')
      ) {
        applyPromptPatterns();
      }
      if (
        event.affectsConfiguration('ath.pollIntervalMs') ||
        event.affectsConfiguration('ath.idlePollIntervalMs')
      ) {
        startWatcher();
      }
    }),
  );
}

function applyPromptPatterns(): void {
  const config = vscode.workspace.getConfiguration('ath');
  setExtraPromptPatterns(config.get<string[]>('extraPromptPatterns', []));
  setExtraInteractiveCommands(config.get<string[]>('extraInteractiveCommands', []));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function deactivate(): void {
  watcher?.stop();
  watcher = undefined;
  requestWatcher?.close();
  requestWatcher = undefined;
  electionWatcher?.close();
  electionWatcher = undefined;
  disposeAll();
}
