import * as os from 'node:os';
import * as vscode from 'vscode';

import {
  effectiveCwd,
  formatDuration,
  isShell,
  type Session,
  type SessionState,
} from '@ath/core';

export type Node = GroupNode | SessionNode;

export interface GroupNode {
  kind: 'group';
  state: SessionState;
  label: string;
  sessions: Session[];
}

export interface SessionNode {
  kind: 'session';
  session: Session;
}

/** Most urgent first: a session waiting on you should never be below the fold. */
const GROUP_ORDER: { state: SessionState; label: string }[] = [
  { state: 'needs-input', label: 'Needs your input' },
  { state: 'busy', label: 'Running' },
  { state: 'idle', label: 'Idle' },
  { state: 'dead', label: 'Dead' },
];

const STATE_ICON: Record<SessionState, { id: string; color?: string }> = {
  'needs-input': { id: 'warning', color: 'notificationsWarningIcon.foreground' },
  busy: { id: 'play-circle', color: 'testing.iconPassed' },
  idle: { id: 'circle-outline' },
  dead: { id: 'circle-slash', color: 'testing.iconFailed' },
};

/**
 * The state in words, shown first in every row.
 *
 * The icon alone cannot carry this: an icon has no label, and the group
 * headers that would supply one are hidden for short lists. Putting the word
 * first also means it survives the truncation a narrow sidebar imposes on the
 * path — losing the end of a directory name costs less than losing the state.
 */
const STATE_LABEL: Record<SessionState, string> = {
  'needs-input': 'needs you',
  busy: 'running',
  idle: 'idle',
  dead: 'exited',
};

function shortenPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export class SessionTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private sessions: Session[] = [];

  update(sessions: Session[]): void {
    this.sessions = sessions;
    this.emitter.fire(undefined);
  }

  getSessions(): Session[] {
    return this.sessions;
  }

  find(name: string): Session | undefined {
    return this.sessions.find((s) => s.name === name);
  }

  getChildren(element?: Node): Node[] {
    if (!element) {
      // Collapse the grouping when there is little to group: a single flat list
      // reads better than one header per session.
      if (this.sessions.length <= 3) {
        return this.sessions.map((session) => ({ kind: 'session', session }));
      }
      return GROUP_ORDER.flatMap(({ state, label }) => {
        const inGroup = this.sessions.filter((s) => s.state === state);
        if (inGroup.length === 0) return [];
        return [{ kind: 'group', state, label, sessions: inGroup } satisfies GroupNode];
      });
    }
    if (element.kind === 'group') {
      return element.sessions.map((session) => ({ kind: 'session', session }));
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(
        `${node.label}  (${node.sessions.length})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.contextValue = 'athGroup';
      return item;
    }

    const { session } = node;
    const item = new vscode.TreeItem(session.name, vscode.TreeItemCollapsibleState.None);

    // A running command names itself ("running npm"); otherwise the bare state.
    const foreground = isShell(session.currentCommand) ? '' : session.currentCommand;
    const head =
      session.state === 'busy' && foreground
        ? `${STATE_LABEL.busy} ${foreground}`
        : STATE_LABEL[session.state];

    // Where its commands actually run, not where ssh was launched from.
    const bits: string[] = [
      head,
      session.remote
        ? `${session.remote}:${shortenPath(effectiveCwd(session))}`
        : shortenPath(session.cwd),
    ];
    if (session.remote) bits.push(`ssh ${session.remote}`);
    if (session.attached > 0) bits.push(`${session.attached} attached`);
    // A literal glyph, not a `$(codicon)`: TreeItem.description does not render
    // codicons and would print the markup verbatim. It also has to live in the
    // row rather than relying on the inline pin button, because inline actions
    // only appear on hover — the state must be visible without one.
    if (session.pinned) bits.push('📌');
    item.description = bits.join(' · ');

    const icon = STATE_ICON[session.state];
    item.iconPath = new vscode.ThemeIcon(
      icon.id,
      icon.color ? new vscode.ThemeColor(icon.color) : undefined,
    );

    item.tooltip = this.tooltip(session);

    // Encodes state and pin so package.json `when` clauses can target them.
    item.contextValue = `athSession.${session.state}${session.pinned ? '.pinned' : ''}`;

    // Single click attaches: the whole point of the panel is getting into the
    // terminal fast, and there is nothing else a click could usefully mean.
    item.command = {
      command: 'ath.attach',
      title: 'Attach',
      arguments: [node],
    };
    return item;
  }

  private tooltip(session: Session): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
    md.appendMarkdown(`**${session.name}** — ${session.state}\n\n`);
    if (session.label) md.appendMarkdown(`_${session.label}_\n\n`);
    md.appendMarkdown(`- **cwd**: \`${effectiveCwd(session)}\`\n`);
    if (session.remote) {
      md.appendMarkdown(`- **host**: \`${session.remote}\`\n`);
      md.appendMarkdown(`- **local cwd**: \`${session.cwd}\` (where ssh was started)\n`);
    }
    md.appendMarkdown(`- **running**: \`${session.currentCommand || 'nothing'}\`\n`);
    md.appendMarkdown(`- **age**: ${formatDuration(Date.now() / 1000 - session.created)}\n`);
    md.appendMarkdown(
      session.pinned
        ? `- $(pinned) **pinned** — kept alive, never reaped by cleanup\n`
        : `- $(pin) not pinned — may be reaped once idle\n`,
    );
    if (session.remote) md.appendMarkdown(`- **remote**: \`ssh ${session.remote}\`\n`);
    if (session.lastCommand) {
      const rc = session.lastExitCode === undefined ? '' : ` → exit ${session.lastExitCode}`;
      md.appendMarkdown(`- **last**: \`${session.lastCommand}\`${rc}\n`);
    }
    md.appendMarkdown(`- **log**: \`${session.logPath}\`\n`);
    if (session.state === 'needs-input') {
      md.appendMarkdown(`\n$(warning) Waiting for you. Click to attach and answer it.\n`);
    }
    if (session.state === 'dead') {
      md.appendMarkdown(`\nShell exited. It respawns automatically on next use.\n`);
    }
    return md;
  }
}
