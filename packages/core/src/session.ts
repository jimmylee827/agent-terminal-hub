import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { AthError, InvalidName, SessionExists, SessionGone } from './errors';
import {
  frameHooksFor,
  shellProbeLine,
  HELPER_ONELINE,
  HELPER_PATH,
  LOG_DIR,
  RC_DIR,
  ensureLayout,
  logPath,
  resetDiscardedBytes,
  resizeHookCommand,
  widthLogPath,
  widthNoteFlagPath,
  trimMarkPath,
  logicalName,
  tmuxName,
} from './paths';
import { ensureControlDir, ensureMaster, sshLaunchLine } from './ssh';
import { clearRequest, listRequests } from './requests';
import { classify, isNesting, isShell, looksLikeCredentialPrompt } from './state';
import { FS, tmux } from './tmux';
import type { CreateOptions, Session } from './types';
import { ancestorPids, shellQuote, sleep, stripAnsi } from './util';

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function validateName(name: string): string {
  const clean = logicalName(name);
  if (!NAME_RE.test(clean)) throw new InvalidName(name);
  return clean;
}

/** Fields pulled in a single `list-sessions` call, in order. */
const FIELDS = [
  '#{session_name}',
  '#{session_attached}',
  '#{session_created}',
  '#{pane_current_path}',
  '#{pane_current_command}',
  '#{pane_dead}',
  '#{@ath_pinned}',
  '#{@ath_owner}',
  '#{@ath_remote}',
  '#{@ath_label}',
  '#{@ath_last_cmd}',
  '#{@ath_last_rc}',
  '#{pane_width}',
  '#{@ath_origin}',
  '#{@ath_creator}',
  '#{@ath_rcwd}',
  '#{@ath_renv}',
  '#{@ath_frame}',
  '#{@ath_wrap}',
].join(FS);

export interface ListOptions {
  /**
   * Capture each pane to classify `needs-input`. Costs one extra tmux call per
   * session. Skip it when you only need names, e.g. for completion.
   */
  withState?: boolean;
}

/**
 * tmux user options are plain strings, so anything that might contain spaces,
 * quotes or newlines is stored base64 and decoded here.
 */
function decodeMeta(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return Buffer.from(raw, 'base64').toString('utf8') || undefined;
  } catch {
    return undefined;
  }
}

function parseRow(line: string, paneTail: string): Session | undefined {
  const parts = line.split(FS);
  const tName = parts[0] ?? '';
  if (!tName.startsWith('ath-')) return undefined; // never report sessions we do not own

  const name = logicalName(tName);
  const paneDead = (parts[5] ?? '0') === '1';
  const currentCommand = parts[4] ?? '';
  const rawRc = parts[11] ?? '';

  return {
    name,
    tmuxName: tName,
    state: classify({ paneDead, currentCommand, paneTail, paneWidth: Number(parts[12] ?? '0') || 0 }),
    cwd: parts[3] ?? '',
    currentCommand,
    attached: Number(parts[1] ?? '0') || 0,
    created: Number(parts[2] ?? '0') || 0,
    pinned: (parts[6] ?? '') === '1',
    owner: parts[7] || 'agent',
    remote: parts[8] || undefined,
    label: parts[9] || undefined,
    lastCommand: parts[10] || undefined,
    lastExitCode: rawRc === '' ? undefined : Number(rawRc),
    logPath: logPath(name),
    paneDead,
    paneTail,
    paneWidth: Number(parts[12] ?? '0') || 0,
    origin: parts[13] || undefined,
    remoteCwd: decodeMeta(parts[15]),
    remoteEnv: decodeMeta(parts[16]),
    frameShell: parts[17] || undefined,
    wrapperInstalled: parts[18] === '1',
    creatorPids: (parts[14] || '')
      .split(',')
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0),
  };
}

export async function list(opts: ListOptions = {}): Promise<Session[]> {
  const withState = opts.withState !== false;
  const { stdout, stderr } = await tmux(['list-sessions', '-F', FIELDS], { allowFail: true });
  if (!stdout.trim()) {
    // No server running is the normal empty case, not an error.
    if (stderr && !/no server running|error connecting/i.test(stderr)) {
      throw new Error(`tmux list-sessions failed: ${stderr}`);
    }
    return [];
  }

  const rows = stdout.split('\n').filter((line) => line.trim());

  // Captured in parallel: serially this was one blocking fork+exec per session
  // on every watcher tick.
  const tails = await Promise.all(
    rows.map(async (line) => {
      const parts = line.split(FS);
      const tName = parts[0] ?? '';
      const dead = (parts[5] ?? '0') === '1';
      if (!withState || dead || !tName.startsWith('ath-')) return '';
      return capturePane(logicalName(tName)).catch(() => '');
    }),
  );

  const sessions = rows
    .map((line, i) => parseRow(line, tails[i] ?? ''))
    .filter((s): s is Session => s !== undefined);

  sessions.sort((a, b) => a.name.localeCompare(b.name));
  return sessions;
}

/**
 * Fetch one session.
 *
 * Queries that session directly rather than going through `list()`, which
 * capture-panes every session in the hub. `run()` calls this two to three
 * times per command, so the old O(all sessions) path made every command more
 * expensive as the user opened more terminals.
 */
export async function get(name: string): Promise<Session> {
  const clean = validateName(name);
  const { stdout, stderr } = await tmux(
    ['display-message', '-p', '-t', tmuxName(clean), FIELDS],
    { allowFail: true },
  );
  if (!stdout.trim()) throw new SessionGone(clean);
  if (stderr && /no server running|can'?t find session/i.test(stderr)) throw new SessionGone(clean);

  const firstLine = stdout.split('\n')[0] ?? '';
  const paneDead = (firstLine.split(FS)[5] ?? '0') === '1';
  const paneTail = paneDead ? '' : await capturePane(clean).catch(() => '');

  const session = parseRow(firstLine, paneTail);
  if (!session) throw new SessionGone(clean);
  return session;
}

export async function exists(name: string): Promise<boolean> {
  const clean = validateName(name);
  const { stderr } = await tmux(['has-session', '-t', tmuxName(clean)], { allowFail: true });
  return !stderr;
}

/** Visible pane content, ANSI-stripped. Used for state, never for command output. */
export async function capturePane(name: string, lines = 60): Promise<string> {
  const clean = validateName(name);
  const { stdout } = await tmux([
    'capture-pane',
    '-p',
    '-t',
    tmuxName(clean),
    '-S',
    `-${Math.max(0, lines)}`,
  ]);
  return stripAnsi(stdout);
}

/**
 * Point the pane's output at its log file.
 *
 * Deliberately does NOT pass `-o`: that flag only opens a pipe when none
 * exists, which means calling it on a pane that is already piping TOGGLES
 * LOGGING OFF. Since a pipe survives `respawn-pane`, using `-o` on the
 * respawn path silently blinded the agent while commands still reported exit
 * codes. Plain `pipe-pane` always (re)opens, which is what every caller wants.
 */
async function attachPipe(name: string): Promise<void> {
  await tmux(['pipe-pane', '-t', tmuxName(name), `cat >> ${shellQuote(logPath(name))}`]);
}

/**
 * Whether the pane's process has exited, and with what status.
 *
 * `run()` polls this alongside the .rc sentinel: a command that ends the shell
 * never writes .rc, and without this check the caller would block until its
 * full timeout on a command that finished instantly.
 */
export async function paneStatus(
  name: string,
): Promise<{ dead: boolean; status: number | null; command: string; width: number }> {
  const clean = validateName(name);
  const { stdout } = await tmux([
    'display-message',
    '-p',
    '-t', tmuxName(clean),
    `#{pane_dead}${FS}#{pane_dead_status}${FS}#{pane_current_command}${FS}#{pane_width}`,
  ]);
  const [deadRaw, statusRaw, commandRaw, widthRaw] = stdout.trim().split(FS);
  const status = Number(statusRaw ?? '');
  return {
    dead: (deadRaw ?? '0') === '1',
    status: statusRaw === '' || Number.isNaN(status) ? null : status,
    command: commandRaw ?? '',
    width: Number(widthRaw ?? '0') || 0,
  };
}

/**
 * How many shell processes are attached to a pane's tty.
 *
 * The discriminator for a nested shell exiting. `exit` inside a `bash` started
 * within a session leaves the pane alive — you simply land back in the outer
 * shell — so pane death never fires and no marker is ever written. Watching
 * only for "output stopped" cannot tell that apart from a shell builtin loop
 * grinding away silently. The count can: it drops from 2 to 1 when the inner
 * shell dies, and does not move for a busy shell.
 */
export async function shellDepth(name: string): Promise<number> {
  const clean = validateName(name);
  const { stdout: ttyOut } = await tmux([
    'display-message',
    '-p',
    '-t', tmuxName(clean),
    '#{pane_tty}',
  ]).catch(() => ({ stdout: '' }) as { stdout: string });

  const tty = ttyOut.trim().replace(/^\/dev\//, '');
  if (!tty) return 0;

  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const { stdout } = await run('ps', ['-t', tty, '-o', 'comm=']);
    return stdout
      .split('\n')
      .map((line) => line.trim().replace(/^-/, '').split('/').pop() ?? '')
      .filter((command) => command && isShell(command)).length;
  } catch {
    return 0;
  }
}

export async function setMeta(name: string, key: string, value: string): Promise<void> {
  const clean = validateName(name);
  // A stored value must never contain the field separator used by list().
  // Newlines are as dangerous as the field separator, and were missed.
  //
  // Every field is read back as ONE row of a newline-delimited list, so a value
  // containing a newline truncates the row and silently destroys every field
  // stored after it. `@ath_last_cmd` holds the command verbatim, so a single
  // multi-line command wiped `frame` and `wrap` — the hub then forgot both that
  // its hooks were live and that the wrapper was installed, and re-typed 400
  // characters of shell before every multi-line command that followed.
  const safe = value.replace(new RegExp(`[${FS}\\r\\n]`, 'g'), ' ');
  await tmux(['set-option', '-t', tmuxName(clean), `@ath_${key}`, safe]);
}

/**
 * Read back one stored value.
 *
 * `get()` returns the fields `list()` was taught to parse; this is for state
 * that only one caller cares about and does not belong in every session
 * summary. Missing options answer empty rather than throwing, because "not set
 * yet" is the ordinary first case, not an error.
 */
export async function readMeta(name: string, key: string): Promise<string> {
  const clean = validateName(name);
  const out = await tmux([
    'show-options',
    '-qv',
    '-t',
    tmuxName(clean),
    `@ath_${key}`,
  ]).catch(() => ({ stdout: '' }));
  return (out.stdout ?? '').trim();
}

/** Shells whose syntax the POSIX `__ath` helper is valid in. */
const POSIX_SHELLS = ['zsh', 'bash', 'sh', 'dash', 'ksh'];

/**
 * A POSIX shell to run the session in, or undefined to let tmux use its
 * default (which gives a proper login shell and is what we want whenever the
 * user's own shell will do).
 *
 * fish and nushell cannot parse the helper, so a user of either would get a
 * session where `source helper.sh` fails silently and every `run()` then times
 * out with no output. Falling back keeps the hub working for them; their own
 * shell is still one `exec fish` away inside the session.
 */
function nonPosixShellFallback(): string | undefined {
  const shell = process.env.ATH_SHELL || process.env.SHELL || '';
  const base = shell.split('/').pop() ?? '';
  if (POSIX_SHELLS.includes(base)) return undefined;
  for (const candidate of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export async function create(opts: CreateOptions = {}): Promise<Session> {
  await ensureLayout();

  const name = validateName(opts.name || (await nextFreeName()));
  if (await exists(name)) throw new SessionExists(name);

  const cwd = opts.cwd || process.cwd();
  const width = opts.width ?? 200;
  const height = opts.height ?? 50;

  // Truncate the log so byte offsets always refer to this incarnation.
  await fs.writeFile(logPath(name), '', { mode: 0o600 });
  // And restart the discard watermark with it. A new incarnation counts from
  // zero; carrying the old total forward would make this session's first
  // offsets start at some large number inherited from a session that no longer
  // exists. See `discardedBytes`.
  await resetDiscardedBytes(name);

  // Make resizes observable, and clear this NAME's resize state with the log.
  //
  // Best effort: a tmux that rejects the hook still gives a working session,
  // which is the whole reason this is a command rather than a line in
  // tmux.conf. Set on every create because a restarted server forgets it, and
  // `-g` means one call covers every session on the socket.
  await tmux(resizeHookCommand(), { allowFail: true }).catch(() => undefined);
  await fs.rm(widthLogPath(name), { force: true }).catch(() => undefined);
  await fs.rm(widthNoteFlagPath(name), { force: true }).catch(() => undefined);

  // Clear one-shot notices for this NAME, for the same reason.
  //
  // The compound-exit caveat is shown once per session and flagged by name, so
  // a flag left behind by a previous incarnation would silence it forever for
  // every session that reuses the name — the marker outliving the thing it
  // describes. Found by the suite: a second run of the same test never saw the
  // caveat it was asserting.
  await fs.rm(path.join(RC_DIR, `${name}.caveat`), { force: true }).catch(() => undefined);

  const fallbackShell = nonPosixShellFallback();
  await tmux([
    'new-session',
    '-d',
    '-s', tmuxName(name),
    '-x', String(width),
    '-y', String(height),
    '-c', cwd,
    '-e', `ATH_RC_DIR=${RC_DIR}`,
    '-e', `ATH_SESSION=${name}`,
    '-e', 'ATH_INSIDE=1',
    ...(fallbackShell ? [fallbackShell] : []),
  ]);

  await tmux(['set-option', '-t', tmuxName(name), 'remain-on-exit', 'on']);
  await setMeta(name, 'pinned', opts.pin ? '1' : '0');
  await setMeta(name, 'owner', opts.owner || 'agent');
  // Where the session was created FROM, which is usually the project it belongs
  // to. Recorded because `cwd` is `pane_current_path`: it moves the moment
  // anyone types `cd`, and it is frequently unrelated to the project already —
  // `ath new --cwd "$HOME"` belongs to whatever repo the caller was sitting in.
  await setMeta(name, 'origin', opts.origin || process.cwd());
  // The exact editor window that made this session, as a pid chain. An agent
  // runs as a descendant of one window's extension host, so only that window
  // finds its own pid here — which means notifications need no negotiation
  // between windows at all in the normal case.
  await setMeta(name, 'creator', (opts.creatorPids ?? ancestorPids()).join(','));
  // The width that was ASKED for, so a pane that never reached it can say so.
  //
  // `observeWidth` reports changes against a baseline taken at the first
  // command, and skips the first observation because "there is nothing to
  // compare against". There is: what the caller requested. An editor panel
  // attaching between creation and the first command resizes the pane, the
  // baseline absorbs it, and the caller is never told it did not get the width
  // it asked for. A reviewer created a session at 200, found it at 156 via an
  // unrelated `list`, and reasonably read the documented change notice as
  // broken — it was not, it had nothing to compare against.
  if (opts.width) await setMeta(name, 'w0', String(opts.width));
  if (opts.remote) await setMeta(name, 'remote', opts.remote);
  if (opts.label) await setMeta(name, 'label', opts.label);

  // pipe-pane is what lets the agent read full output while the human keeps a
  // live, unmodified pane. Both consumers, one PTY.
  await attachPipe(name);

  await waitForShell(name, 4000);

  // Load the helper, then clear so the session opens on a clean screen.
  //
  // Skipped for a remote session: the local shell there is only a launcher for
  // ssh, and the hub refuses to run a remote session's commands locally, so the
  // wrapper it installs would never be called. All it did was put another line
  // of setup in front of the human on every connect. If a local shell ever does
  // need it — the link dropped and something ran before reconnecting — the
  // self-heal installs it on demand.
  if (!opts.remote) {
    await sendLine(name, `source ${shellQuote(HELPER_PATH)} && clear`);
    // Sourcing it IS the install, so record that. Without this the first
    // multi-line command — which can never be typed as one line, so always
    // needs the wrapper — re-typed the whole 400-character definition into the
    // pane to install something that was already there.
    await setMeta(name, 'wrap', '1').catch(() => undefined);
  }
  await waitForShell(name, 4000);

  // Record which shell now holds the hooks. Without this the framing guard
  // sees no known shell, assumes the hooks are absent, and falls back to the
  // wrapper for every command — losing the clean command line entirely.
  const localShell = await get(name)
    .then((s) => s.currentCommand)
    .catch(() => '');
  if (localShell) await setMeta(name, 'frame', localShell).catch(() => undefined);

  if (opts.remote) {
    await ensureControlDir();
    // A detached master first, so this session's client is a slave and killing
    // the session can never tear the shared link out from under anyone else.
    await ensureMaster(opts.remote).catch(() => undefined);
    // The remote shell comes up ALREADY integrated: the framing hooks ride the
    // ssh command line as environment and install themselves before the first
    // prompt. See `sshLaunchLine`.
    //
    // Nothing is typed at the remote shell, which retires two hazards at once.
    // Setup cannot be spliced into a half-consumed line — the failure that made
    // a ~1000-character payload unusable over ssh. And setup cannot be typed
    // into a PASSWORD prompt: the old path slept 400ms and sent the wrapper
    // regardless of what ssh was doing, so a host that asked for a password
    // received 400 characters of shell as the answer.
    const ready = randomToken();
    // The fallback wrapper travels with the hooks, and is exported the same
    // way, because a MULTI-LINE command can never be typed as one line and so
    // always needs it. Without this a nested shell inherited the hooks but not
    // the wrapper, and every multi-line command printed
    // "__ath: command not found" and re-typed 400 characters of shell.
    const payload = `PROMPT_COMMAND=; unset ATH_B; ${HELPER_ONELINE}; export -f __ath 2>/dev/null; ${frameHooksFor('bash', ready)}`;
    const bootFile = `${RC_DIR}/${name}.boot`;
    await sendLine(name, sshLaunchLine(opts.remote, payload, bootFile));

    // A marker means the far side is bash and the hooks took. Silence means a
    // shell that ignores PROMPT_COMMAND (zsh, fish), or ssh still sitting on a
    // password or host-key prompt — the case the hub exists to serve. Either
    // way we type NOTHING; the first command self-heals into the wrapper.
    if ((await awaitMarker(name, ready, 5000)) !== undefined) {
      const shell = await get(name)
        .then((sess) => sess.currentCommand)
        .catch(() => '');
      if (shell) await setMeta(name, 'frame', shell).catch(() => undefined);
      // The payload defined AND exported the wrapper, so it is present in this
      // shell and in any child of it. Recording that keeps the first multi-line
      // command — which can never be typed as one line, so always needs the
      // wrapper — from re-typing 400 characters that are already there.
      await setMeta(name, 'wrap', '1').catch(() => undefined);
    }
  }

  return get(name);
}

async function nextFreeName(): Promise<string> {
  const taken = new Set((await list({ withState: false })).map((s) => s.name));
  for (let i = 1; i < 1000; i++) {
    const candidate = `term${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `term${Date.now()}`;
}

/**
 * Leave copy mode if the pane is in it.
 *
 * This is a shared-terminal problem with no single-user equivalent: `mouse on`
 * means a human scrolling up to read output puts the pane into copy mode, and
 * every subsequent `send-keys` then fails with "not in a mode". The agent's
 * commands silently stop working because the human looked at something.
 */
async function exitCopyMode(target: string): Promise<void> {
  const { stdout } = await tmux(['display-message', '-p', '-t', target, '#{pane_in_mode}'], {
    allowFail: true,
  });
  if (stdout.trim() === '1') {
    await tmux(['send-keys', '-t', target, '-X', 'cancel'], { allowFail: true });
  }
}

export interface SendLineOptions {
  /**
   * Clear anything already typed at the prompt before sending.
   *
   * The other shared-terminal hazard: if the human has a half-typed command
   * sitting on the line, our text appends to it and the shell runs the
   * concatenation — which produces a syntax error, never writes the .rc
   * sentinel, and leaves the caller blocked until its full timeout.
   *
   * The cost is that we can discard something the human was mid-way through
   * typing. That is the better trade: losing a partial line is visible and
   * recoverable, while a corrupted command plus a two-minute stall is neither.
   */
  clearLine?: boolean;
}

/** Type a line and press Enter. Text is sent literally; the shell parses it. */
export async function sendLine(
  name: string,
  text: string,
  options: SendLineOptions = {},
): Promise<void> {
  const clean = validateName(name);
  const target = tmuxName(clean);

  await exitCopyMode(target);

  if (options.clearLine !== false) {
    // C-e first so C-u clears the whole line under bash's kill-to-start binding
    // as well as zsh's kill-whole-line.
    await tmux(['send-keys', '-t', target, 'C-e'], { allowFail: true });
    await tmux(['send-keys', '-t', target, 'C-u'], { allowFail: true });
  }

  // Retry once through a mode cancel.
  //
  // `exitCopyMode` above is a check-then-act, and a pane can enter a mode in
  // the gap — tmux then rejects the send with "not in a mode". That failure
  // reached the caller as the command's OUTPUT, which is worse than the race:
  // an agent reading it back sees tmux's error where the command's result
  // should be. Cancel and try again rather than surface that.
  try {
    await tmux(['send-keys', '-t', target, '-l', '--', text]);
  } catch (error) {
    if (!/not in a mode/i.test(String(error))) throw error;
    await exitCopyMode(target);
    await tmux(['send-keys', '-t', target, '-l', '--', text]);
  }
  // Enter must be a separate call: bundling it with -l would type the word.
  await tmux(['send-keys', '-t', target, 'Enter']);
}

/**
 * Send raw tmux key names, e.g. `C-c`, `Up`, `y`. Never used for secrets.
 *
 * Deliberately does not clear the line: this is what answers a live prompt,
 * where whatever is on screen is the prompt itself and must be left alone.
 */
export async function sendKeys(name: string, keys: string[]): Promise<void> {
  const clean = validateName(name);
  const target = tmuxName(clean);
  await exitCopyMode(target);
  await tmux(['send-keys', '-t', target, ...keys]);
}

/**
 * Refuse to deliver keystrokes to a remote session whose ssh has dropped.
 *
 * The same hazard `run()` guards, for the other input path. When the link
 * dies the pane falls back to the LOCAL shell while every label still says
 * remote — so a keystroke meant for another machine is typed into the user's
 * own shell. A space is harmless; a `y` answering a destructive prompt, or
 * `--text` content, is not.
 *
 * Deliberately NOT inside `sendKeys`/`sendLine`: reconnecting means typing an
 * `ssh` command into exactly the dead pane this rejects, so the check belongs
 * at the operator-facing entry points instead.
 */
/**
 * Refuse to type text into a prompt that is asking for a secret.
 *
 * `send --text` is the human's way to answer a prompt, so it deliberately does
 * not check session state — but that makes it the one path that can put
 * arbitrary text into a password field. It happened in testing: a `bash --norc`
 * meant for the shell landed in a live `[sudo] password` prompt and came back
 * "Sorry, try again", twice. Nothing leaked, but two failed sudo attempts is
 * one short of a lockout on a default policy.
 *
 * The hub never types credentials. The corollary is that it must not type
 * NON-credentials into a credential prompt either: only the human at the
 * keyboard can answer these.
 */
export async function assertNotCredentialPrompt(name: string): Promise<void> {
  const pane = await capturePane(name, 6).catch(() => '');
  if (!looksLikeCredentialPrompt(stripAnsi(pane))) return;
  throw new AthError(
    'credential_prompt',
    `Session "${name}" is waiting for a password or passphrase, so nothing was ` +
      `typed. Whatever is sent now becomes a login attempt, and repeated ` +
      `failures can lock the account. A human must answer this one: ` +
      `"ath attach ${name}". To interrupt it instead: "ath send ${name} -- C-c".`,
  );
}

export async function assertRemoteConnected(name: string): Promise<void> {
  const session = await get(validateName(name));
  if (!session.remote || isNesting(session.currentCommand)) return;
  throw new AthError(
    'remote_disconnected',
    `Session "${session.name}" is a remote session on "${session.remote}", but its ssh ` +
      `connection has dropped — the pane is back at the LOCAL shell. Nothing was sent, ` +
      `because a keystroke meant for "${session.remote}" must not be typed into this ` +
      `machine's shell. Run any command on the session to reconnect it, or check it ` +
      `with "ath attach ${session.name}".`,
  );
}

export async function waitForShell(name: string, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await tmux([
        'display-message',
        '-p',
        '-t', tmuxName(validateName(name)),
        '#{pane_current_command}',
      ]);
      if (isShell(stdout.trim())) return true;
    } catch {
      return false;
    }
    await sleep(80);
  }
  return false;
}

/**
 * Revive a session whose shell exited. `remain-on-exit` keeps the session
 * listed with a dead pane; respawning restores it in place, so an agent that
 * typed `exit` does not destroy a terminal the human wanted to keep.
 */
export async function respawn(name: string, cwd?: string): Promise<void> {
  const clean = validateName(name);
  const args = ['respawn-pane', '-k', '-t', tmuxName(clean)];
  if (cwd) args.push('-c', cwd);
  await tmux(args);
  // The old pipe survives respawn-pane, so re-point it unconditionally.
  await attachPipe(clean);
  await waitForShell(clean, 4000);
  await sendLine(clean, `source ${shellQuote(HELPER_PATH)} && clear`);
  await waitForShell(clean, 4000);
}

export interface KillOptions {
  /**
   * Destroy the session even if it is pinned.
   *
   * Only a human may pass this. A pin is the one way the person sharing a
   * terminal can say "this one is mine" — if an agent could override it, it
   * would protect nothing that matters.
   */
  force?: boolean;
}

/**
 * What to tell the caller about clients attached to a session being killed.
 *
 * A session was destroyed while the human was still attached — they had just
 * typed a password into it — and the only output was `Session "box2"
 * destroyed.` The client count sits right there in `list`; not mentioning it is
 * the tool knowing something the caller needed and staying quiet.
 *
 * REPORTS, does not refuse. Refusing was the first attempt and the suite caught
 * it immediately: the VS Code panel attaches a client to every session it
 * displays, so an agent tidying up its own session would be blocked whenever
 * the user happened to have the panel open. That trades a rare silent loss for
 * constant friction, and it is not what was asked for — the ask was that the
 * tool say what it knows. The case that genuinely must not be lost, an
 * unanswered human request, is already guarded above and outranks --force.
 *
 * Split out as a plain function because an attached tmux CLIENT cannot reliably
 * be created in a test environment, and this should not be an untested branch.
 */
export function attachedClientsNote(attached: number): string | undefined {
  if (attached <= 0) return undefined;
  return (
    `${attached} client(s) were attached — someone may have been looking at it, or typing. ` +
    `Note this counts the editor panel too, so it is not proof a person was there.`
  );
}

export async function kill(
  name: string,
  reason = 'killed from the hub',
  opts: KillOptions = {},
): Promise<void> {
  const clean = validateName(name);

  // An OPEN human request outranks --force, and is checked BEFORE it.
  //
  // Killing a session with a pending ask destroys the human's answer, and the
  // log is truncated on recreate so it cannot be recovered. It happened twice
  // in one session: the agent asked for a sudo password, the human typed it,
  // and the agent then killed the session to run an unrelated test and went on
  // reporting "still waiting for you". An agent's promise not to repeat that is
  // worth nothing — `--force` must simply be unable to discard someone's work.
  //
  // Clearing the request first (`ath requests --clear`) makes discarding the
  // answer a separate, deliberate act rather than a side effect of tidying up.
  // Only a request belonging to THIS incarnation of the session counts.
  //
  // A request outlives the session it names — the pane can die, or a human can
  // remove it. Left as-is that stale entry would block every future session of
  // the same name from ever being killed, and the guard meant to protect a
  // human's answer would instead wedge the tool. Anything older than the
  // session's own start time refers to a shell that no longer exists, so it is
  // pruned rather than honoured.
  const live = await get(clean).catch(() => undefined);
  const startedAt = live ? live.created * 1000 : 0;
  // Block only while the session is ACTUALLY waiting on a person right now.
  //
  // A parked request outlives the prompt it describes — once answered or
  // interrupted the session goes idle, but the request stays until collected.
  // Honouring it then blocks ordinary cleanup forever, which is what wedged
  // the suite's own teardown. `needs-input` is the state that means someone
  // may be mid-answer, and that is the only thing worth refusing for.
  const waitingOnAHuman = live?.state === 'needs-input';
  // Only a PARKED request blocks: that is a live prompt where a human may be
  // mid-answer. A non-blocking wall (`sudo -n` refused) holds nothing anyone
  // typed, so killing loses nothing and must not be obstructed — that
  // over-broad version wedged the suite's own teardown.
  const forThisSession = (await listRequests().catch(() => [])).filter(
    (r) => r.session === clean && r.parked === true,
  );
  const openRequests: typeof forThisSession = [];
  for (const r of forThisSession) {
    if (startedAt > 0 && r.createdAt < startedAt) await clearRequest(r.id).catch(() => undefined);
    else openRequests.push(r);
  }
  if (waitingOnAHuman && openRequests.length > 0) {
    throw new AthError(
      'request_pending',
      `Session "${clean}" has an open request for a human (${openRequests[0]?.id}) and was ` +
        `NOT killed, even with --force. Killing it would throw away whatever they typed. ` +
        `Collect it with "ath poll", or run "ath requests --clear" if you genuinely mean ` +
        `to discard their answer.`,
    );
  }

  // A pin used to guard only against `gc`, so an agent could still destroy a
  // session a human had explicitly marked as theirs — which is exactly the
  // situation the pin exists for, and exactly what happened.
  if (!opts.force) {
    const pinned = await get(clean)
      .then((s) => s.pinned)
      .catch(() => false);
  if (pinned) {
      throw new AthError(
        'session_pinned',
        `Session "${clean}" is pinned, so it was NOT killed. A pin means a human ` +
          `marked this terminal as theirs. Ask them to unpin it, or to kill it ` +
          `themselves with "ath kill ${clean} --force".`,
      );
    }
  }

  // Tell anyone attached why their terminal is about to vanish; without this
  // an attached human just gets tmux's bare "server exited unexpectedly".
  await tmux(
    ['display-message', '-t', tmuxName(clean), '-d', '1500', `[ath] session ${clean} ${reason}`],
    { allowFail: true },
  );
  await tmux(['kill-session', '-t', tmuxName(clean)], { allowFail: true });
}


export async function rename(from: string, to: string): Promise<void> {
  const a = validateName(from);
  const b = validateName(to);
  if (await exists(b)) throw new SessionExists(b);
  await tmux(['rename-session', '-t', tmuxName(a), tmuxName(b)]);
  await fs.rename(logPath(a), logPath(b)).catch(() => undefined);
  // The watermark travels with the log it describes. Left behind, the renamed
  // session reads zero and every offset it hands out is wrong by whatever had
  // already been trimmed.
  await fs.rename(trimMarkPath(a), trimMarkPath(b)).catch(() => undefined);
  // The pipe still points at the old path; re-point it at the renamed log.
  await attachPipe(b).catch(() => undefined);
}

export async function setPinned(name: string, pinned: boolean): Promise<void> {
  await setMeta(name, 'pinned', pinned ? '1' : '0');
}

/**
 * Resize a LIVE session's pane.
 *
 * Width was settable only at creation, so an agent that discovered its output
 * was being truncated had exactly one remedy: destroy the session and make a
 * wider one — which throws away the sudo timestamp with it and costs the human
 * another password. That is a steep price for a column layout.
 *
 * It does not make the width permanent, and nothing here pretends otherwise:
 * `window-size latest` means the next client to attach sets the size again,
 * deliberately, because a person should not be handed a pane wrapped to
 * someone else's terminal. This buys back the ability to re-assert it.
 */
export async function setWidth(name: string, cols: number, rows?: number): Promise<number> {
  const clean = validateName(name);
  const width = Math.min(Math.max(Math.floor(cols), 20), 2000);
  const current = await get(clean);
  const height = rows === undefined ? undefined : Math.min(Math.max(Math.floor(rows), 5), 500);
  await tmux([
    'resize-window',
    '-t',
    tmuxName(clean),
    '-x',
    String(width),
    ...(height === undefined ? [] : ['-y', String(height)]),
  ]);
  void current;
  return width;
}

/** Kill unpinned sessions that have been idle longer than `maxIdleMs`. */
export async function gc(maxIdleMs = 12 * 60 * 60 * 1000): Promise<string[]> {
  const now = Date.now();
  const killed: string[] = [];
  for (const session of await list()) {
    if (session.pinned) continue;
    if (session.attached > 0) continue;
    if (session.state === 'busy' || session.state === 'needs-input') continue;
    if (now - session.created * 1000 < maxIdleMs) continue;
    await kill(session.name);
    killed.push(session.name);
  }
  return killed;
}

/** Human-facing summary used by `ath doctor`. */
export async function doctor(): Promise<{ ok: boolean; checks: [string, boolean, string][] }> {
  const checks: [string, boolean, string][] = [];
  let tmuxVersion = '';
  try {
    const { stdout } = await tmux(['-V']);
    tmuxVersion = stdout.trim();
    checks.push(['tmux found', true, tmuxVersion]);
  } catch (err) {
    checks.push(['tmux found', false, (err as Error).message]);
  }

  try {
    await ensureLayout();
    checks.push(['~/.ath layout', true, `${LOG_DIR}, ${RC_DIR}`]);
  } catch (err) {
    checks.push(['~/.ath layout', false, (err as Error).message]);
  }

  try {
    await fs.access(HELPER_PATH);
    checks.push(['shell helper', true, HELPER_PATH]);
  } catch {
    checks.push(['shell helper', false, `missing at ${HELPER_PATH}`]);
  }

  try {
    const sessions = await list({ withState: false });
    checks.push(['tmux server reachable', true, `${sessions.length} session(s)`]);
  } catch (err) {
    checks.push(['tmux server reachable', false, (err as Error).message]);
  }

  checks.push(['platform', process.platform !== 'win32', `${process.platform} ${os.release()}`]);

  return { ok: checks.every(([, pass]) => pass), checks };
}

/**
 * Install the wrapper into whatever shell the pane currently holds.
 *
 * Typed, never written to disk. The hub must leave no trace on any machine it
 * drives — that is what lets it work across many hosts with no per-host setup
 * — so the helper travels the same way everything else does, through the PTY.
 */
export interface InstallOptions {
  /** Install only the fallback wrapper — used for remote shells, see create(). */
  wrapperOnly?: boolean;
  /**
   * Install only the hooks, not the fallback wrapper.
   *
   * Used when setting a session up. The wrapper is a ~400-character line typed
   * into the pane, and it is only ever needed by a shell the hooks did not take
   * in — so paying for it up front means every session starts with a wall of
   * shell the user has to scroll past, to cover a case that usually never
   * happens. The self-heal path installs it if and when a command is lost.
   */
  hooksOnly?: boolean;
}

/**
 * Wait for a marker to come back through the PTY.
 *
 * The one mechanism that behaves identically locally, over ssh and inside a
 * container — which is why the hub carries exit codes this way rather than in a
 * file. Setup uses it too, so nothing is ever sent to a shell that has not
 * confirmed it finished the previous line.
 */
async function awaitMarker(
  name: string,
  token: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const file = logPath(name);
  const re = new RegExp(`<ATHR:${token}:([A-Za-z0-9]*)>`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = await fs.readFile(file, 'utf8').catch(() => '');
    const hit = re.exec(raw.slice(-8192));
    if (hit) return hit[1] ?? '';
    await sleep(120);
  }
  return undefined;
}

/**
 * Install framing into whatever shell the pane holds, by asking rather than
 * guessing.
 *
 * Ask what the shell is and wait for its answer; send only that shell's hooks
 * and wait for them to confirm. Previously this sent both shells' hooks as one
 * ~1000-character line and slept — over ssh the shell was still consuming it
 * when the next line arrived and tmux spliced them into one corrupt command.
 * `waitForShell` cannot help there: it keys off `pane_current_command`, which
 * is `ssh` for the entire session, so there is never a prompt to see.
 */
export async function installHelper(
  name: string,
  _remote?: string,
  opts: InstallOptions = {},
): Promise<void> {
  // NEVER type the helper into a live credential prompt.
  //
  // This installs by typing ~1.8 KB of shell into the pane. If the pane is
  // sitting at `[sudo] password for dev:`, every one of those characters
  // becomes a password attempt: the login fails, the prompt is consumed, and
  // the human walking over to answer finds it gone. It also lands the helper's
  // own source in the log, where an agent then reads it back as the output of
  // whatever it thought it was running.
  //
  // The self-heal reaches here from inside `run`, AFTER that function's own
  // credential check has passed — a prompt can appear in between, which is
  // exactly when a command has stalled and the self-heal is most likely to
  // fire. Refuse loudly rather than typing into a password field.
  await assertNotCredentialPrompt(name);

  if (!opts.hooksOnly) {
    await sendLine(name, HELPER_ONELINE).catch(() => undefined);
    const token = randomToken();
    await sendLine(name, `printf '<ATHR:${token}:ok>\\r\\x1b[K'`).catch(() => undefined);
    await awaitMarker(name, token, 6000);
  }
  if (opts.wrapperOnly) return;

  const probe = randomToken();
  await sendLine(name, shellProbeLine(probe)).catch(() => undefined);
  const shell = await awaitMarker(name, probe, 8000);
  if (shell !== 'zsh' && shell !== 'bash') return; // no hooks available here

  // Tell the shell how deep it is, because it cannot work that out alone.
  //
  // The hooks set `__ath_lvl0` from `$SHLVL` — correct for the shell the hub
  // started, wrong for one nested inside it, which sees only its own SHLVL and
  // concludes it is at the baseline. zsh cannot export functions OR the
  // baseline to a child, so on a zsh host a nested bash had no way to know, and
  // the prompt depth marker never appeared.
  //
  // The hub can count the shells on the pane's tty, so it supplies the offset
  // and the shell subtracts. Depth 1 is the session's own shell and yields the
  // unmodified value.
  const depth = await shellDepth(name).catch(() => 1);
  const offset = Math.max(0, depth - 1);
  const ready = randomToken();
  const baseline = offset > 0 ? `__ath_lvl0=$((SHLVL-${offset})); export __ath_lvl0; ` : '';
  await sendLine(name, baseline + frameHooksFor(shell, ready)).catch(() => undefined);
  if ((await awaitMarker(name, ready, 8000)) === undefined) return;

  const current = await get(name)
    .then((s) => s.currentCommand)
    .catch(() => '');
  if (current) await setMeta(name, 'frame', current).catch(() => undefined);
}

function randomToken(): string {
  return Math.random().toString(16).slice(2, 8);
}
