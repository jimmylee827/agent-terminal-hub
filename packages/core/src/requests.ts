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
  await fs.writeFile(
    path.join(REQUEST_DIR, `${request.id}.json`),
    JSON.stringify(request, null, 2),
    { mode: 0o600 },
  );
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
  try {
    const request = JSON.parse(await fs.readFile(file, 'utf8')) as HumanRequest;
    if (request.resolvedAt && Date.now() - request.resolvedAt > RESOLVED_TTL_MS) {
      await fs.unlink(file).catch(() => undefined);
      return;
    }
    await fs.writeFile(file, JSON.stringify({ ...request, resolvedAt: Date.now() }), {
      mode: 0o600,
    });
  } catch {
    await fs.unlink(file).catch(() => undefined);
  }
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
  for (const request of await listRequests()) {
    if (!liveSessions.has(request.session) || now - request.createdAt > maxAgeMs) {
      await clearRequest(request.id);
    }
  }
}
