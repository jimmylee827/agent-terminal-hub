import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { SessionBusy } from './errors';
import { ATH_HOME } from './paths';
import { formatDuration, pidAlive, sleep } from './util';

export const LOCK_DIR = path.join(ATH_HOME, 'lock');

export interface LockInfo {
  pid: number;
  startedAt: number;
  command: string;
}

/**
 * A lock older than this is assumed abandoned even if its pid still exists —
 * covers a pid that was recycled onto an unrelated process.
 */
const MAX_LOCK_AGE_MS = 30 * 60 * 1000;

function lockPath(name: string): string {
  return path.join(LOCK_DIR, `${name}.lock`);
}

async function readLock(file: string): Promise<LockInfo | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as LockInfo;
  } catch {
    return undefined;
  }
}

type Acquisition = { ok: true } | { ok: false; holder?: LockInfo };

async function tryAcquire(name: string, command: string): Promise<Acquisition> {
  await fs.mkdir(LOCK_DIR, { recursive: true, mode: 0o700 });
  const file = lockPath(name);

  try {
    // 'wx' fails if the file exists, which is what makes this atomic.
    const handle = await fs.open(file, 'wx', 0o600);
    try {
      const info: LockInfo = { pid: process.pid, startedAt: Date.now(), command };
      await handle.writeFile(JSON.stringify(info));
    } finally {
      await handle.close();
    }
    return { ok: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  const holder = await readLock(file);
  const stale =
    !holder || !pidAlive(holder.pid) || Date.now() - holder.startedAt > MAX_LOCK_AGE_MS;

  if (stale) {
    // The previous holder died mid-command; reclaim rather than deadlock forever.
    await fs.unlink(file).catch(() => undefined);
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, startedAt: Date.now(), command } satisfies LockInfo),
        );
      } finally {
        await handle.close();
      }
      return { ok: true };
    } catch {
      // Another process reclaimed it first; fall through and report contention.
      return { ok: false, holder: await readLock(file) };
    }
  }

  return { ok: false, holder };
}

async function release(name: string): Promise<void> {
  await fs.unlink(lockPath(name)).catch(() => undefined);
}

export interface LockOptions {
  /** Queue for the lock instead of failing immediately. */
  wait?: boolean;
  /** How long to queue for when `wait` is set. */
  timeoutMs?: number;
}

/**
 * Serialise access to one session.
 *
 * Without this, two callers each read the log offset, each send their command,
 * and tmux interleaves the keystrokes — producing a single spliced line like
 * `SECOND__ath da4aede27f8f sleep 2` that the shell then runs. That is
 * arbitrary command corruption in a shell the user shares, so it is guarded
 * rather than merely detected.
 *
 * Scope is honest: this serialises `ath` callers. A human typing directly into
 * the pane cannot be locked out, and stays covered by the line-clear in
 * `sendLine` plus the `command_lost` backstop in `run`.
 */
export async function withSessionLock<T>(
  name: string,
  command: string,
  fn: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);

  for (;;) {
    const attempt = await tryAcquire(name, command);
    if (attempt.ok) break;

    const holder = attempt.holder;
    if (!options.wait || Date.now() >= deadline) {
      const detail = holder
        ? `"${holder.command}" (started ${formatDuration((Date.now() - holder.startedAt) / 1000)} ago)`
        : 'another command';
      throw new SessionBusy(name, detail);
    }
    await sleep(120);
  }

  try {
    return await fn();
  } finally {
    await release(name);
  }
}

/** Who currently holds a session's lock, if anyone. Used by `ath ls`. */
export async function lockHolder(name: string): Promise<LockInfo | undefined> {
  const holder = await readLock(lockPath(name));
  if (!holder) return undefined;
  if (!pidAlive(holder.pid) || Date.now() - holder.startedAt > MAX_LOCK_AGE_MS) return undefined;
  return holder;
}
