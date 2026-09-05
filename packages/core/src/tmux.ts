import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import { SessionGone, TmuxMissing } from './errors';
import { SOCKET, TMUX_CONF } from './paths';

const execFileAsync = promisify(execFile);

const CANDIDATES = [
  '/opt/homebrew/bin/tmux',
  '/usr/local/bin/tmux',
  '/usr/bin/tmux',
  '/opt/local/bin/tmux',
];

let cachedBin: string | undefined;

/** Resolve the tmux binary once. `ATH_TMUX` wins, then well-known paths, then PATH. */
export function tmuxBin(): string {
  if (cachedBin) return cachedBin;
  const override = process.env.ATH_TMUX;
  if (override) {
    if (!existsSync(override)) throw new TmuxMissing(`ATH_TMUX=${override} does not exist`);
    cachedBin = override;
    return cachedBin;
  }
  for (const candidate of CANDIDATES) {
    if (existsSync(candidate)) {
      cachedBin = candidate;
      return cachedBin;
    }
  }
  // Fall back to PATH resolution by execFile itself.
  cachedBin = 'tmux';
  return cachedBin;
}

/** Reset the cached binary path. Only useful in tests. */
export function resetTmuxBin(): void {
  cachedBin = undefined;
}

export interface TmuxResult {
  stdout: string;
  stderr: string;
}

const GONE_PATTERNS = [
  /no server running/i,
  /can'?t find session/i,
  /session not found/i,
  /no such session/i,
  /error connecting to/i,
];

function isGone(message: string): boolean {
  return GONE_PATTERNS.some((re) => re.test(message));
}

/**
 * Run a tmux command against the hub's dedicated socket.
 *
 * `-f` pins our own config so the user's ~/.tmux.conf never applies here, and
 * a hub session never inherits surprising keybindings or hooks.
 */
export async function tmux(args: string[], opts: { allowFail?: boolean } = {}): Promise<TmuxResult> {
  const bin = tmuxBin();
  const full = ['-L', SOCKET, '-f', TMUX_CONF, ...args];
  try {
    const { stdout, stderr } = await execFileAsync(bin, full, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (e.code === 'ENOENT') {
      throw new TmuxMissing(`could not execute "${bin}"`);
    }
    const message = (e.stderr || e.message || '').trim();
    if (opts.allowFail) {
      return { stdout: e.stdout || '', stderr: message };
    }
    if (isGone(message)) {
      throw new SessionGone(extractTarget(full) ?? 'unknown');
    }
    throw new Error(`tmux ${args.join(' ')} failed: ${message}`);
  }
}

function extractTarget(args: string[]): string | undefined {
  const i = args.indexOf('-t');
  if (i >= 0 && i + 1 < args.length) {
    const raw = args[i + 1];
    return raw?.replace(/^ath-/, '');
  }
  return undefined;
}

/** True when the hub's tmux server is up. Never throws. */
export async function serverRunning(): Promise<boolean> {
  const { stderr } = await tmux(['list-sessions', '-F', '#{session_name}'], { allowFail: true });
  return !isGone(stderr);
}

/** tmux format-string field separator. Chosen to never appear in a path or command. */
export const FS = '\x1f';
