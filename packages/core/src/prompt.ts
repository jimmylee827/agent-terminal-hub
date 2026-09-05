import type { Session } from './types';
import { formatDuration } from './util';

/**
 * Text a human copies into an agent chat to hand over a terminal.
 *
 * Written as instructions to the agent, not as a description for the human:
 * it names the session, states where it is, and gives the exact commands,
 * so the agent can act without a round of questions.
 */
export function agentPrompt(session: Session, opts: { cli?: string } = {}): string {
  const cli = opts.cli || 'ath';
  const age = formatDuration(Date.now() / 1000 - session.created);

  const lines: string[] = [
    `Use the existing terminal session "${session.name}" for this work.`,
    '',
    `  cwd:     ${session.cwd}`,
    `  state:   ${session.state}${session.currentCommand ? ` (${session.currentCommand})` : ''}`,
    `  age:     ${age}`,
  ];

  if (session.remote) lines.push(`  remote:  ssh ${session.remote}`);
  if (session.label) lines.push(`  label:   ${session.label}`);
  if (session.lastCommand) {
    const rc = session.lastExitCode === undefined ? '' : ` (exit ${session.lastExitCode})`;
    lines.push(`  last:    ${session.lastCommand}${rc}`);
  }

  lines.push(
    '',
    'Drive it with:',
    `  ${cli} run ${session.name} -- <command>    # blocking; returns output + exit code`,
    `  ${cli} read ${session.name}                # recent output`,
    `  ${cli} send ${session.name} -- C-c         # raw keys (Ctrl-C, y, Enter)`,
    '',
    'It is a real terminal that persists between your calls, so state carries over:',
    'exports, activated virtualenvs, an open ssh connection, a running dev server.',
    '',
    'If a command reports needsInput, it is waiting on a password or a prompt.',
    'Do not try to answer it or type any credential. Say so and stop; I am attached',
    'to the same terminal and will type it myself, then you can continue.',
  );

  return lines.join('\n');
}

/** One-line summary for logs and status bars. */
export function summarize(session: Session): string {
  const bits = [session.name, session.state];
  if (session.currentCommand && !['zsh', 'bash', 'sh'].includes(session.currentCommand)) {
    bits.push(session.currentCommand);
  }
  if (session.pinned) bits.push('pinned');
  if (session.remote) bits.push(`ssh:${session.remote}`);
  return bits.join(' · ');
}

/**
 * Where a session's commands actually run.
 *
 * For a remote session `cwd` is `pane_current_path` — the LOCAL directory the
 * ssh process was started in — which is not where anything executes and is
 * actively misleading: a session sitting in /tmp on another host reported the
 * local repo path. Prefer the remote directory the hub tracked from the
 * command markers, falling back to the local one only before the first
 * command has reported.
 */
export function effectiveCwd(session: Session): string {
  return session.remote ? session.remoteCwd || session.cwd : session.cwd;
}

/** `host:/path` for a remote session, plain path for a local one. */
export function locationLabel(session: Session): string {
  const where = effectiveCwd(session);
  return session.remote ? `${session.remote}:${where}` : where;
}
