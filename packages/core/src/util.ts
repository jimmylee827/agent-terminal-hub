import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Does this pid still exist?
 *
 * EPERM means it exists but belongs to another user, which still counts as
 * alive: reporting it dead would let one user's process steal a lock or a
 * claim that another user is actively holding.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Is `child` the same directory as `parent`, or inside it?
 *
 * Compared through `path.relative` rather than by string prefix, because a
 * prefix test claims `/a/project-old` is inside `/a/project`. Path segments
 * are the unit that matters, not characters.
 *
 * Case is folded on macOS and Windows, whose filesystems are case-insensitive
 * by default. That is a platform heuristic rather than a fact — a
 * case-sensitive APFS volume exists — so only use this where being wrong is
 * cosmetic, never to decide access to something.
 */
function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'darwin' || process.platform === 'win32'
    ? resolved.toLowerCase()
    : resolved;
}

export function pathContains(parent: string, child: string): boolean {
  if (!parent || !child) return false;
  const a = normalizePath(parent);
  const b = normalizePath(child);
  if (a === b) return true;
  const rel = path.relative(a, b);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Single-quote for POSIX shells, escaping embedded single quotes. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Built from \u escapes rather than literal control bytes so the source stays
 * greppable and survives any editor or transport that normalises whitespace.
 * Covers CSI sequences, OSC strings (hyperlinks, title sets) and charset
 * selection — everything a shell prompt or a progress bar emits.
 */
const ANSI_RE = new RegExp(
  [
    // CSI: ESC [ ... final-byte
    '[\\u001B\\u009B][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-nqry=><]',
    // OSC: ESC ] ... BEL or ST
    '\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)',
    // Charset selection: ESC ( B
    '\\u001B[()][B0UK]',
  ].join('|'),
  'g',
);

export function stripAnsi(input: string): string {
  // RS (0x1E) brackets every marker the hub writes, so a marker can be told
  // apart from a command that merely printed the same characters. It is
  // plumbing, never content, and must not survive into anyone's output.
  return input.replace(ANSI_RE, '').replace(/\u001e/g, '');
}

/**
 * Normalise a raw pipe-pane capture into lines.
 *
 * Carriage returns become newlines rather than being dropped: the run protocol
 * writes each marker followed by `\r[K`, so a CR is a real line boundary
 * here. Dropping them would merge a marker with the output that follows it and
 * break extraction.
 */
export function toLines(raw: string): string[] {
  return stripAnsi(raw)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(resolveBackspaces);
}

/**
 * Apply backspaces the way a terminal would.
 *
 * Interactive shells redraw the line they are editing, so a pipe-pane log is
 * full of sequences like `_\b__ath …`. Replaying the backspaces yields what
 * was actually on screen instead of the keystroke history that produced it.
 */
export function resolveBackspaces(line: string): string {
  if (!line.includes('\b')) return line;
  const out: string[] = [];
  for (const ch of line) {
    if (ch === '\b') out.pop();
    else out.push(ch);
  }
  return out.join('');
}

/**
 * Every process between `pid` and init, `pid` first.
 *
 * Recorded when a session is created so a notification can be delivered to the
 * exact editor window that made it. An agent runs as a descendant of one
 * window's extension host, so that host's pid appears in this chain and in no
 * other window's. That is an identity, not a guess — unlike matching
 * directories, which cannot tell two windows on the same project apart and
 * cannot place a session whose cwd belongs to no project at all.
 *
 * Captured eagerly because the creating process is usually short-lived: by the
 * time a prompt appears the chain would no longer be walkable.
 */
export function ancestorPids(pid: number = process.pid, ppidOf?: Map<number, number>): number[] {
  const parents = ppidOf ?? readProcessTree();
  const chain: number[] = [];
  const seen = new Set<number>();
  let current: number | undefined = pid;
  while (current !== undefined && current > 1 && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = parents.get(current);
  }
  return chain;
}

function readProcessTree(): Map<number, number> {
  const map = new Map<number, number>();
  try {
    // One fork for the whole table, rather than one per level.
    const out = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
    for (const line of (out.stdout || '').split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (Number.isFinite(pid) && Number.isFinite(ppid)) map.set(pid as number, ppid as number);
    }
  } catch {
    /* no process table available; callers degrade to an empty chain */
  }
  return map;
}

export interface PathAffinity {
  /** A folder IS the target, rather than merely an ancestor of it. */
  exact: boolean;
  /** Path segments between the folder and the target; 0 when exact. */
  depth: number;
}

/**
 * Best relationship between a set of folders and a set of candidate paths.
 *
 * Used to rank editor windows against a session: the folders are one window's
 * workspace roots, the targets are the session's `origin` and `cwd`.
 *
 * Depth matters, and is why this is not just `pathContains`. With a monorepo
 * open in one window and a package of it open in another, both contain the
 * session — but the package window is the specific one, and returning the
 * closer ancestor is what lets the caller prefer it.
 */
export function bestPathAffinity(
  folders: readonly string[],
  targets: readonly (string | undefined)[],
): PathAffinity | undefined {
  let best: PathAffinity | undefined;
  for (const folder of folders) {
    for (const target of targets) {
      if (!target || !pathContains(folder, target)) continue;
      const depth = segmentDistance(folder, target);
      const found: PathAffinity = { exact: depth === 0, depth };
      if (!best || found.depth < best.depth) best = found;
    }
  }
  return best;
}

function segmentDistance(parent: string, child: string): number {
  // Normalised the same way pathContains compares, so a case-insensitive match
  // does not then produce a nonsense `../../..` distance.
  const rel = path.relative(normalizePath(parent), normalizePath(child));
  if (rel === '') return 0;
  return rel.split(path.sep).filter(Boolean).length;
}

export function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? '').trim() === '') start++;
  while (end > start && (lines[end - 1] ?? '').trim() === '') end--;
  return lines.slice(start, end);
}

export function randomNonce(bytes = 6): string {
  const chars = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < bytes * 2; i++) {
    out += chars[Math.floor(Math.random() * 16)] ?? '0';
  }
  return out;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d${h % 24 ? ` ${h % 24}h` : ''}`;
}
