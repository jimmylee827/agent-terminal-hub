import * as vscode from 'vscode';

import type { Session } from '@ath/core';

/**
 * A single status bar entry summarising the hub.
 *
 * Turns amber only when something is actually blocked on the user, so the
 * ambient state is quiet and the one condition that needs them is impossible
 * to miss without opening the panel.
 */
export class StatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.item.command = 'workbench.view.extension.athHub';
    this.item.name = 'Agent Terminals';
  }

  update(sessions: Session[]): void {
    if (sessions.length === 0) {
      this.item.hide();
      return;
    }
    const waiting = sessions.filter((s) => s.state === 'needs-input').length;
    const busy = sessions.filter((s) => s.state === 'busy').length;

    const parts = [`${sessions.length}`];
    if (busy) parts.push(`${busy} running`);
    if (waiting) parts.push(`${waiting} needs input`);

    this.item.text = `$(terminal) ${parts.join(' · ')}`;
    this.item.tooltip = waiting
      ? 'A terminal is waiting for you. Click to open the hub.'
      : 'Agent Terminal Hub';
    this.item.backgroundColor = waiting
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
