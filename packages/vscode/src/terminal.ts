import * as vscode from 'vscode';

import { SOCKET, TMUX_CONF, tmuxBin, tmuxName } from '@ath/core';

/**
 * Terminals this extension opened, keyed by session name, so repeated attaches
 * reveal the existing tab instead of stacking duplicate clients on one session.
 */
const attached = new Map<string, vscode.Terminal>();

/**
 * Is this window already showing a terminal for that session?
 *
 * The strongest signal there is about where a notification belongs: this window
 * is not merely near the session, it is displaying it.
 */
export function isAttached(session: string): boolean {
  return attached.has(session);
}

export function forgetTerminal(terminal: vscode.Terminal): void {
  for (const [name, known] of attached) {
    if (known === terminal) attached.delete(name);
  }
}

/**
 * Open a native VSCode terminal bound to a hub session.
 *
 * This is the feature the project exists for. tmux allows several clients on
 * one session, so the terminal opened here is *the same PTY the agent is
 * driving* — not a copy and not a view. Typing a sudo password here answers
 * the agent's blocked command directly.
 *
 * It is a real integrated terminal rather than a rendered webview, which is
 * what keeps the font, theme, copy/paste, link handling, scrollback and IME
 * behaving exactly like every other terminal in the editor.
 */
export function attachTerminal(session: string, reveal = true): vscode.Terminal {
  const existing = attached.get(session);
  if (existing) {
    if (reveal) existing.show(false);
    return existing;
  }

  const configured = vscode.workspace.getConfiguration('ath').get<string>('tmuxPath');

  const terminal = vscode.window.createTerminal({
    name: `ath: ${session}`,
    shellPath: configured && configured.trim() ? configured.trim() : tmuxBin(),
    shellArgs: ['-L', SOCKET, '-f', TMUX_CONF, 'attach-session', '-t', tmuxName(session)],
    iconPath: new vscode.ThemeIcon('terminal'),
    isTransient: true,
  });

  attached.set(session, terminal);
  if (reveal) terminal.show(false);
  return terminal;
}

export function disposeAll(): void {
  attached.clear();
}
