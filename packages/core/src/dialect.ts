import {
  HELPER_ONELINE,
  ackLine,
  agentTagLine,
  depthBaseline,
  frameHooksFor,
  launchPayload,
  shellProbeLine,
} from './posix';
import { sshLaunchLine } from './ssh';

/**
 * Everything the hub has to SAY to a shell, for one family of shell.
 *
 * The hub's mechanics — logging, offsets, locking, ssh, tmux — do not care what
 * shell sits at the far end. What it types does: a POSIX shell takes `printf`
 * and `export`, PowerShell takes neither. Every string the hub types into a
 * shell goes through one of these, so a second family is a second member here
 * rather than a branch at each call site.
 *
 * Members are added in the phase that first needs them, each backed by code
 * that already exists — never as a placeholder for one that does not.
 */
export interface ShellDialect {
  readonly id: 'posix';
  /** The fallback wrapper, defined in one line. */
  helperOneline(): string;
  /** Asks the shell what it is; the answer comes back as `<ATHR:token:…>`. */
  probeLine(token: string): string;
  /** The framing hooks for one shell, ending in a marker that confirms they landed. */
  frameHooks(shell: 'zsh' | 'bash', token: string): string;
  /** Typed before each agent command, announcing whose it is. */
  tagLine(nonce: string): string;
  /** What rides the ssh line so the remote shell comes up already integrated. */
  launchPayload(token: string): string;
  /** The line typed to start that remote shell. Writes `bootFile`. */
  launchLine(host: string, payload: string, bootFile: string): string;
  /** Typed after the wrapper, so the hub knows the shell read it. */
  ackLine(token: string): string;
  /** Re-bases the hooks' depth for a shell nested `offset` levels down. */
  depthBaseline(offset: number): string;
}

export const posixDialect: ShellDialect = {
  id: 'posix',
  helperOneline: () => HELPER_ONELINE,
  probeLine: shellProbeLine,
  frameHooks: frameHooksFor,
  tagLine: agentTagLine,
  launchPayload,
  launchLine: sshLaunchLine,
  ackLine,
  depthBaseline,
};
