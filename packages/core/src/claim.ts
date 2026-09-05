import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { ATH_HOME } from './paths';
import { pidAlive } from './util';

export const CLAIM_DIR = path.join(ATH_HOME, 'claim');
export const ELECTION_DIR = path.join(ATH_HOME, 'election');

export interface ClaimInfo {
  /** Holder process. A dead pid makes the claim reclaimable. */
  pid: number;
  createdAt: number;
  /** Free-form label for the holder, so a claim that will not clear is debuggable. */
  by?: string;
}

/**
 * Backstop only.
 *
 * A claim is normally released explicitly, and a holder that died is detected
 * by pid, so this age limit exists purely so that a claim cannot outlive the
 * day if both of those somehow miss.
 */
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * A claim file that will not parse is usually one being written right now, in
 * the microseconds between `open` and `writeFile`. Treating that as abandoned
 * would hand the same claim to two processes — precisely the failure this
 * module exists to prevent — so a young unreadable claim counts as held.
 */
const WRITE_GRACE_MS = 5_000;

/**
 * Keys are built from session names and request ids, both already constrained,
 * but a key becomes a filename so it is sanitised rather than trusted.
 */
function sanitize(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180) || '_';
}

function claimPath(key: string): string {
  return path.join(CLAIM_DIR, `${sanitize(key)}.claim`);
}

async function write(file: string, by?: string): Promise<boolean> {
  try {
    // 'wx' fails if the path already exists. That failure IS the mechanism:
    // the kernel picks the winner, so no agreement between processes is needed.
    const handle = await fs.open(file, 'wx', 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, createdAt: Date.now(), by } satisfies ClaimInfo),
      );
    } finally {
      await handle.close();
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

async function readClaim(file: string): Promise<{ info?: ClaimInfo; mtimeMs: number } | undefined> {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const { mtimeMs } = await handle.stat();
      const raw = await handle.readFile('utf8');
      try {
        return { info: JSON.parse(raw) as ClaimInfo, mtimeMs };
      } catch {
        return { mtimeMs };
      }
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

async function isAbandoned(file: string, maxAgeMs: number): Promise<boolean> {
  const held = await readClaim(file);
  // Gone between our failed create and this read: someone released it. Report
  // abandoned so the caller races for it rather than giving up.
  if (!held) return true;

  const { info, mtimeMs } = held;
  if (!info || typeof info.pid !== 'number') return Date.now() - mtimeMs > WRITE_GRACE_MS;
  return !pidAlive(info.pid) || Date.now() - info.createdAt > maxAgeMs;
}

export interface ClaimOptions {
  /** Label recorded in the claim file; useful when inspecting a stuck claim. */
  by?: string;
  /** Override the age backstop for claims that are meant to be short-lived. */
  maxAgeMs?: number;
}

/**
 * Win, or lose, the right to do something exactly once across processes.
 *
 * Same primitive as the session lock in `lock.ts`, different purpose. A lock
 * is held for the duration of some work and everyone else queues or fails; a
 * claim is a one-shot "I've got this" and the losers simply do nothing.
 *
 * Written for the VSCode extension. It activates in every open window, each
 * window runs its own watcher against the same global tmux server, and the
 * dedupe state is per-window — so without this, one sudo prompt raises one
 * popup per window, and an explicit `request_human` call shows up
 * everywhere at once.
 *
 * Throws only on genuinely unexpected filesystem errors. Callers on a
 * notification path should treat a throw as "go ahead and notify": a duplicate
 * popup is an annoyance, a prompt nobody is told about defeats the point.
 */
export async function claim(key: string, options: ClaimOptions = {}): Promise<boolean> {
  await fs.mkdir(CLAIM_DIR, { recursive: true, mode: 0o700 });
  const file = claimPath(key);
  if (await write(file, options.by)) return true;

  if (!(await isAbandoned(file, options.maxAgeMs ?? DEFAULT_MAX_AGE_MS))) return false;

  // The holder is gone. Drop its file and race again; whoever loses THAT race
  // lost to a live process and is a genuine loser.
  await fs.unlink(file).catch(() => undefined);
  return write(file, options.by);
}

/**
 * Give up a claim, so the same key can be claimed again later.
 *
 * Idempotent, and safe to call from a process that never held it: a claim
 * describes one episode (this prompt, this request), and every window that
 * observes the episode ending is entitled to end the claim with it.
 */
export async function releaseClaim(key: string): Promise<void> {
  await fs.unlink(claimPath(key)).catch(() => undefined);
  await fs.unlink(electionPath(key)).catch(() => undefined);
}

/**
 * Release a claim only if THIS process is the one holding it.
 *
 * Use this everywhere except the deliberate "the episode is over" paths.
 * Releasing a claim you do not hold does not end anything — it vacates the
 * claim for whoever is still waiting, turning one notification into two. That
 * is not hypothetical: a window standing down unlinked the winner's claim, and
 * a third window then took the vacancy and announced the same prompt again.
 *
 * Returns whether the claim is now gone (including when there was none).
 */
export async function releaseOwnClaim(key: string): Promise<boolean> {
  const held = await readClaim(claimPath(key));
  if (held?.info && held.info.pid !== process.pid) return false;
  await releaseClaim(key);
  return true;
}

function electionPath(key: string): string {
  return path.join(ELECTION_DIR, `${sanitize(key)}.json`);
}

export interface Election {
  /**
   * When this contest opened. Every process ranks itself and waits until
   * `openedAt + itsOwnDelay`, so all of them measure from ONE instant.
   */
  openedAt: number;
}

/**
 * A marker left over with no claim behind it means a contest was abandoned. A
 * fresh prompt must not inherit its timestamp, or every window would compute a
 * deadline in the past and claim immediately — collapsing back to a race.
 */
const ELECTION_MAX_AGE_MS = 60_000;

/**
 * Open a contest for `key`, or join the one already open.
 *
 * This is what makes the winner deterministic instead of a race. Without it,
 * each window starts its own countdown when ITS OWN poll happens to notice the
 * prompt — and poll intervals differ by design (a window whose panel is hidden
 * polls every 3s, one with it open every 0.8s), so the best-ranked window
 * routinely lost to whichever window simply looked first. Ranking never got a
 * say. Sharing one `openedAt` puts every window on the same start line, so the
 * shortest delay — the best rank — wins by construction.
 *
 * Whoever creates the marker wins nothing by it: the creator ranks itself and
 * waits like everyone else.
 */
export async function openElection(key: string): Promise<Election> {
  await fs.mkdir(ELECTION_DIR, { recursive: true, mode: 0o700 });
  const file = electionPath(key);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try {
        const election: Election = { openedAt: Date.now() };
        await handle.writeFile(JSON.stringify(election));
        return election;
      } finally {
        await handle.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    const existing = await readElection(file);
    if (existing && Date.now() - existing.openedAt <= ELECTION_MAX_AGE_MS) return existing;

    // Stale or unreadable. Clear it and loop once to re-create; if another
    // process beats us to that, the second pass reads its marker instead.
    await fs.unlink(file).catch(() => undefined);
  }

  return (await readElection(file)) ?? { openedAt: Date.now() };
}

async function readElection(file: string): Promise<Election | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Election;
    return typeof parsed?.openedAt === 'number' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Drop needs-input claims, and their markers, for sessions that no longer
 * exist.
 *
 * Belt and braces behind the retire-don't-delete rule in the extension: a
 * claim for a dead session can never be released by the normal path, because
 * the thing that would release it is gone.
 */
export async function reapClaimsForDeadSessions(live: ReadonlySet<string>): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(CLAIM_DIR);
  } catch {
    return 0;
  }

  const PREFIX = 'needs-input.';
  let removed = 0;
  for (const entry of entries) {
    if (!entry.startsWith(PREFIX) || !entry.endsWith('.claim')) continue;
    const name = entry.slice(PREFIX.length, -'.claim'.length);
    if (live.has(name)) continue;
    await releaseClaim(`${PREFIX}${name}`);
    removed++;
  }
  return removed;
}

/** Drop contest markers left behind by windows that closed mid-prompt. */
export async function pruneElections(maxAgeMs = ELECTION_MAX_AGE_MS): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(ELECTION_DIR);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const file = path.join(ELECTION_DIR, entry);
    const election = await readElection(file);
    if (election && Date.now() - election.openedAt <= maxAgeMs) continue;
    await fs.unlink(file).catch(() => undefined);
    removed++;
  }
  return removed;
}

/** Who holds a claim, if anyone still does. For diagnostics and tests. */
export async function claimHolder(
  key: string,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
): Promise<ClaimInfo | undefined> {
  const file = claimPath(key);
  const held = await readClaim(file);
  if (!held?.info) return undefined;
  if (await isAbandoned(file, maxAgeMs)) return undefined;
  return held.info;
}

/**
 * Drop claims whose holder died or that outlived the backstop.
 *
 * Claims are released explicitly in the normal course of things; this covers
 * the window that was closed while a notification was still on screen.
 */
export async function pruneClaims(maxAgeMs = DEFAULT_MAX_AGE_MS): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(CLAIM_DIR);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.claim')) continue;
    const file = path.join(CLAIM_DIR, entry);
    if (!(await isAbandoned(file, maxAgeMs))) continue;
    await fs.unlink(file).catch(() => undefined);
    removed++;
  }
  return removed;
}
