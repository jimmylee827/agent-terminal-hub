import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { ATH_HOME } from './paths';
import { randomNonce } from './util';

export const REQUEST_DIR = path.join(ATH_HOME, 'requests');

export interface HumanRequest {
  id: string;
  session: string;
  reason: string;
  createdAt: number;
  /** Who asked — an agent name, or "agent" when unknown. */
  from: string;
  /**
   * The command that was blocked, so its OUTCOME can be collected once the
   * human answers. Without it the answer is unreachable: the agent knows a
   * person was asked, but has no way back to what their answer produced.
   */
  handle?: string;
  /**
   * The command is PARKED at a live prompt, so the session leaving
   * `needs-input` proves a human answered. A non-interactive refusal
   * (`sudo -n`) never parks, so that inference does not hold for it and the
   * request must not claim to have been answered.
   */
  parked?: boolean;
  /**
   * When this stopped needing a human. Resolved requests are KEPT for a
   * while rather than deleted: an agent sent to `ath requests` by a message
   * saying a request was filed, and told \"no open requests\" seconds later,
   * cannot tell whether it was answered, cancelled, or never filed at all.
   * Silence is the one answer that means nothing.
   */
  resolvedAt?: number;
}

/**
 * Replace a request file in one step, so no reader can ever see it half-written.
 *
 * `writeFile` truncates before it writes, and NOTHING here takes a lock:
 * `pruneRequests` runs on every watcher tick in EVERY open editor window, and
 * `reapResolvedRequests` from four more call sites across the MCP server and
 * the CLI. A reader landing inside that window parses an empty file — and the
 * `catch` in `clearRequest` used to answer a parse failure by DELETING the
 * record, so two processes doing routine housekeeping could between them
 * destroy the very thing this directory exists to preserve. A human answered a
 * sudo prompt, and fifteen minutes later `ath requests` had no trace that they
 * had ever been asked.
 *
 * Same lesson `rotateNotifyLog` already learned about a file several windows
 * append to: `rename` is atomic, a truncate-then-write is a window. The temp
 * name carries its own nonce so two writers cannot collide on it either.
 */
async function writeRequestFile(file: string, request: HumanRequest): Promise<void> {
  const tmp = `${file}.${randomNonce(4)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(request, null, 2), { mode: 0o600 });
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/**
 * Ask a human to come to a terminal.
 *
 * A small file rather than a socket: the agent, the CLI and the editor are
 * separate processes with independent lifetimes, and a request must survive
 * the editor not being open yet. The VSCode extension watches this directory
 * and raises a notification; `ath watch` prints them.
 */
export async function requestHuman(
  session: string,
  reason: string,
  from = 'agent',
  handle?: string,
  parked = false,
): Promise<HumanRequest> {
  await fs.mkdir(REQUEST_DIR, { recursive: true, mode: 0o700 });
  const request: HumanRequest = {
    id: randomNonce(4),
    session,
    reason: reason.slice(0, 500),
    createdAt: Date.now(),
    from,
    ...(handle ? { handle } : {}),
    ...(parked ? { parked: true } : {}),
  };
  await writeRequestFile(path.join(REQUEST_DIR, `${request.id}.json`), request);
  return request;
}

export async function listRequests(
  opts: { includeResolved?: boolean } = {},
): Promise<HumanRequest[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(REQUEST_DIR);
  } catch {
    return [];
  }
  const out: HumanRequest[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const body = await fs.readFile(path.join(REQUEST_DIR, entry), 'utf8');
      const request = JSON.parse(body) as HumanRequest;
      // OPEN means open. This option was accepted and then ignored, so every
      // caller asking for outstanding requests also got resolved ones: `ath ls`
      // kept flagging a finished session `asked-for-you`, and a human reading
      // the queue was told they still owed answers they had already given.
      // Resolved records are still KEPT — `listAllRequests` is how you read
      // them, so an agent told "a request was filed" is never answered with
      // silence a moment later.
      if (request.resolvedAt !== undefined && !opts.includeResolved) continue;
      out.push(request);
    } catch {
      /* partially written or corrupt; ignore */
    }
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

const RESOLVED_TTL_MS = 60 * 60 * 1000;

/**
 * Mark a request resolved, keeping it briefly so the outcome is readable.
 *
 * Deleting it made the record indistinguishable from one that never existed.
 * It is removed for real once it is older than the TTL.
 */
export async function clearRequest(id: string): Promise<void> {
  const file = path.join(REQUEST_DIR, `${id}.json`);
  let request: HumanRequest;
  try {
    request = JSON.parse(await fs.readFile(file, 'utf8')) as HumanRequest;
  } catch {
    // A read or parse failure is NOT permission to delete.
    //
    // This branch used to unlink, which made every transient failure —
    // a concurrent writer, a full disk, a slow network home directory —
    // silently destroy a human's answer. Writes go through `writeRequestFile`
    // now, so a torn read should not happen at all; if one somehow does, the
    // record is left alone. An unparseable file is inert rather than harmful:
    // `listRequests` already skips it, and `ath requests --clear` removes it
    // when a human decides to.
    return;
  }
  if (request.resolvedAt && Date.now() - request.resolvedAt > RESOLVED_TTL_MS) {
    await fs.unlink(file).catch(() => undefined);
    return;
  }
  await writeRequestFile(file, { ...request, resolvedAt: Date.now() }).catch(() => undefined);
}

/**
 * Delete a request outright, for a human who said "get rid of it".
 *
 * `clearRequest` MARKS resolved — correct for the automatic path, where a
 * resolved record is kept so an agent can still learn its outcome. It is the
 * wrong verb for `ath requests --clear`, which reached for it and therefore
 * deleted nothing: on an already-resolved request it just rewrote `resolvedAt`
 * to now. An agent ran it twice, was told "cleared 1 request(s)" both times,
 * and had to remove the file by hand — a command reporting success while doing
 * nothing, in the one workflow this tool exists for.
 */
export async function deleteRequest(id: string): Promise<boolean> {
  try {
    await fs.unlink(path.join(REQUEST_DIR, `${id}.json`));
    return true;
  } catch {
    return false; // already gone
  }
}

/**
 * Remove every request file, readable or not.
 *
 * `--clear` is a person saying "get rid of it", and it worked off
 * `listAllRequests` — which silently skips anything it cannot parse. That was
 * survivable while `clearRequest` deleted on a parse failure; now that it does
 * not (it was destroying good records to do it), an unparseable file would
 * otherwise have no route off the disk at all. This is that route, and it is
 * deliberately the only one, reached only when a human asks.
 *
 * Returns how many files it actually removed, because the count this command
 * prints has been wrong before.
 */
export async function clearAllRequests(): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(REQUEST_DIR);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.json') && !entry.endsWith('.tmp')) continue;
    try {
      await fs.unlink(path.join(REQUEST_DIR, entry));
      removed++;
    } catch {
      /* already gone */
    }
  }
  return removed;
}

/**
 * Remove every request record belonging to one session, answered or not.
 *
 * `purge` exists for the moment a secret lands in a transcript, and it emptied
 * the transcript while leaving this directory untouched — where `reason` quotes
 * the command verbatim. Two independent reviewers called that out in the same
 * words: purging the log and keeping the quoted command is "the opposite of
 * what purge implies". They were right. The name is a promise about traces of a
 * session, not about one file.
 *
 * Scoped to the session on purpose. `clearAllRequests` is the human-only escape
 * hatch and stays that way; purging one session must not silently discard
 * another session's open handoff, which someone may be walking over to answer.
 *
 * Returns the count, because the number `purge` prints is a claim about what is
 * gone and has been wrong before.
 */
export async function purgeSessionRequests(name: string): Promise<number> {
  let removed = 0;
  for (const request of await listAllRequests()) {
    if (request.session !== name) continue;
    if (await deleteRequest(request.id)) removed++;
  }
  return removed;
}

/** Every request, resolved ones included. `listRequests` returns only open. */
export async function listAllRequests(): Promise<HumanRequest[]> {
  return listRequests({ includeResolved: true });
}

/** Whether a request is still outstanding. */
export function isOpen(request: HumanRequest): boolean {
  return request.resolvedAt === undefined;
}

/** Drop requests for sessions that no longer exist, plus anything stale. */
export async function pruneRequests(
  liveSessions: Set<string>,
  maxAgeMs = 60 * 60 * 1000,
): Promise<void> {
  const now = Date.now();
  // `listAllRequests`, not `listRequests`, and that is the fix.
  //
  // The TTL branch inside `clearRequest` — the one that finally deletes a
  // resolved record — could never run. Every caller of `clearRequest` reaches
  // it through `listRequests`, which returns OPEN requests only, so the moment
  // a record was marked resolved nothing ever looked at it again. Resolved
  // requests therefore accumulated forever, while `ATH_ARTIFACTS` told readers
  // this directory was "bounded: resolved requests expire".
  //
  // Worth stating plainly because it also settles a bug report: within this
  // code a resolved request can only be RETAINED. A `requests/` that empties
  // itself minutes after a handoff is not something the hub can do to itself.
  for (const request of await listAllRequests()) {
    if (request.resolvedAt !== undefined) {
      if (now - request.resolvedAt > RESOLVED_TTL_MS) await deleteRequest(request.id);
      continue;
    }
    if (!liveSessions.has(request.session) || now - request.createdAt > maxAgeMs) {
      await clearRequest(request.id);
    }
  }
  await reapRequestTemps(maxAgeMs);
}

/**
 * Remove `.tmp` files a crash left between the write and the rename.
 *
 * The atomic write in `writeRequestFile` trades one failure mode for a smaller
 * one: a process killed at exactly the wrong instant leaves a temp file nobody
 * will ever rename. They are invisible to every reader (`listRequests` takes
 * only `.json`), so this is about not leaking, not about correctness — and the
 * age bound matters, because a temp file belonging to a write happening RIGHT
 * NOW must not be swept out from under it.
 */
async function reapRequestTemps(maxAgeMs: number): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(REQUEST_DIR);
  } catch {
    return;
  }
  const cutoff = Date.now() - Math.max(maxAgeMs, 60 * 1000);
  for (const entry of entries) {
    if (!entry.endsWith('.tmp')) continue;
    const file = path.join(REQUEST_DIR, entry);
    try {
      if ((await fs.stat(file)).mtimeMs < cutoff) await fs.unlink(file);
    } catch {
      /* raced another reaper, or vanished on its own */
    }
  }
}
