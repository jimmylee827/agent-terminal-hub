import { appendFile } from 'node:fs/promises';
import * as vscode from 'vscode';

import {
  NOTIFY_LOG,
  ancestorPids,
  bestPathAffinity,
  claim,
  clearRequest,
  get,
  pidAlive,
  listRequests,
  openElection,
  releaseOwnClaim,
  rotateNotifyLog,
  sleep,
  type HumanRequest,
  type Session,
} from '@ath/core';

import { attachTerminal, isAttached } from './terminal';

/**
 * Sessions we have already nagged about, so one sitting on a prompt for ten
 * minutes produces one notification rather than one per poll.
 *
 * Per-window state, and deliberately still is: it stops THIS window re-entering
 * on its next poll without touching the filesystem. Stopping the OTHER windows
 * is a separate problem, solved by the contest below.
 */
const announced = new Set<string>();

/**
 * Consecutive ticks a session has been out of `needs-input`.
 *
 * Clearing on the first non-prompt tick made a flapping session re-notify on
 * every oscillation. Requiring a couple of clean ticks means the state has
 * actually settled before we are willing to interrupt again.
 */
const settledTicks = new Map<string, number>();
const TICKS_BEFORE_RE_ANNOUNCE = 2;

/**
 * Hard floor between two notifications about the same session.
 *
 * The tick counter above is not enough on its own. It counts POLLS, and the
 * idle poll is 3s, so two clean ticks is a six-second memory — any flicker in
 * a heuristic classifier then re-announces every six seconds, indefinitely.
 * Observed doing exactly that: 45 notifications for one session in four
 * minutes, each one correctly deduped across windows and still useless.
 *
 * A wall-clock floor bounds the damage no matter what the classifier does,
 * because it does not depend on why the state moved. A prompt that is still
 * waiting after this long is worth one more mention; a flicker is not.
 */
const RE_ANNOUNCE_COOLDOWN_MS = 90_000;
const lastShownAt = new Map<string, number>();

function tooSoonToRepeat(name: string): boolean {
  const last = lastShownAt.get(name);
  return last !== undefined && Date.now() - last < RE_ANNOUNCE_COOLDOWN_MS;
}

/**
 * The last session list this window's watcher saw.
 *
 * Kept so ranking can read a session's `origin` and `cwd` without asking tmux
 * again — and so a window woken by another window's contest can rank itself
 * for a session its own poll has not looked at yet.
 */
let known: Session[] = [];

export function noteSessions(sessions: Session[]): void {
  known = sessions;
}

/**
 * The session, from our last poll or straight from tmux.
 *
 * A window woken by another window's contest may not have polled yet, and the
 * ownership test is worthless without the session's creator chain — that gap is
 * precisely how two freshly-reloaded windows both announced the same prompt.
 * One tmux call is far cheaper than a duplicate notification.
 */
async function resolveSession(name: string): Promise<Session | undefined> {
  const cached = known.find((s) => s.name === name);
  if (cached) return cached;
  try {
    const fetched = await get(name);
    log(`${name} not in our poll yet; fetched from tmux (creator=${fetched.creatorPids?.join(',')})`);
    return fetched;
  } catch (err) {
    log(`${name} COULD NOT RESOLVE: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Per-window trace of how each contest was decided.
 *
 * Added because four rounds of this were debugged by inference from claim files
 * on disk, which showed one claim while two windows announced — true, and
 * useless. Each window logs its own rank, wait and claim result, so "which
 * window did what" is answered by reading, not deducing.
 */
let channel: vscode.OutputChannel | undefined;
function log(line: string): void {
  const entry = `${new Date().toISOString().slice(11, 23)} pid=${process.pid} ${line}`;
  channel ??= vscode.window.createOutputChannel('Agent Terminal Hub');
  channel.appendLine(entry);
  // Also to a file, and deliberately so: an OutputChannel lives inside one
  // window and can only be read by a human looking at that window. Five rounds
  // of this were spent asking which window did what. All windows append here,
  // so the whole picture is one file read.
  void appendFile(NOTIFY_LOG, `${entry}\n`).catch(() => undefined);
  maybeRotate();
}

/**
 * Nothing else bounds this file. It reached 6 MB and 55,000 lines in four days
 * of ordinary use, and `ath purge` cannot see it.
 *
 * Checked every `ROTATE_EVERY` lines rather than on each append: a `stat` per
 * line is pure waste on the hot path, and the cap does not need to be exact —
 * overshooting by a few hundred lines costs nothing, and the counter starts at
 * the limit so a window that opens on an already-huge file rotates at once.
 */
const ROTATE_EVERY = 200;
let sinceRotateCheck = ROTATE_EVERY;
function maybeRotate(): void {
  if (++sinceRotateCheck < ROTATE_EVERY) return;
  sinceRotateCheck = 0;
  void rotateNotifyLog().catch(() => undefined);
}

const needsInputKey = (name: string): string => `needs-input.${name}`;
const requestKey = (id: string): string => `request.${id}`;

/** Recover the session name from a contest marker filename. */
export function sessionOfElectionFile(filename: string): string | undefined {
  const base = filename.endsWith('.json') ? filename.slice(0, -'.json'.length) : undefined;
  return base?.startsWith('needs-input.') ? base.slice('needs-input.'.length) : undefined;
}

/**
 * Pids between this extension host and the root, so the shared VSCode main
 * process can be told apart from another window's extension host. Both appear
 * in a creator chain; only the latter means "a different window owns this".
 */
const myAncestors = new Set(ancestorPids());

type Ownership = 'mine' | 'another-window' | 'nobody';

/**
 * Who owns this session, by identity rather than inference.
 *
 * An agent runs as a descendant of exactly one window's extension host, so
 * that host's pid is in the creator chain and no other window's is. This is
 * the whole reason the general contest below is now a fallback: when a session
 * has a living owner there is nothing to negotiate, because only one window
 * can possibly match and the rest simply stay quiet.
 */
function ownership(session: Session | undefined): Ownership {
  const chain = session?.creatorPids;
  if (!chain || chain.length === 0) return 'nobody';
  if (chain.includes(process.pid)) return 'mine';
  // A pid that is alive, is not us, and is not one of OUR ancestors, is another
  // window's extension host. Excluding our ancestors matters: the VSCode main
  // process is in every window's chain, and treating it as an owner would make
  // every window stand down and nobody notify.
  const owned = chain.some((pid) => pid !== process.pid && !myAncestors.has(pid) && pidAlive(pid));
  return owned ? 'another-window' : 'nobody';
}

/**
 * How long this window waits before claiming, when nobody owns the session.
 *
 * Only reached for orphans — a session created outside any editor window, or
 * whose creating window has since closed. When a session HAS a living owner,
 * `ownership` settles it outright and none of this runs.
 *
 * Every window measures this from the same instant (the contest's `openedAt`),
 * so the ladder decides rather than whose poll fired first. Lower is better:
 * already showing that session's terminal, then owning its origin or cwd
 * (closest folder first), then merely focused, then having any workspace, and
 * a blank window last — it can never own anything, so a Welcome screen should
 * only win when there is nowhere better.
 */
function rankDelayMs(name: string, session: Session | undefined): number {
  if (isAttached(name)) return 0;
  if (ownership(session) === 'mine') return 0;

  const folders = (vscode.workspace.workspaceFolders ?? [])
    .filter((f) => f.uri.scheme === 'file')
    .map((f) => f.uri.fsPath);

  const affinity = bestPathAffinity(folders, [session?.origin, session?.cwd]);
  if (affinity?.exact) return 60;
  // Capped so a very deep match never falls behind an unrelated window.
  if (affinity) return Math.min(120 + affinity.depth * 15, 340);

  if (vscode.window.state.focused) return 450;
  return folders.length > 0 ? 650 : 900;
}

function settled(name: string): boolean {
  return (settledTicks.get(name) ?? 0) >= TICKS_BEFORE_RE_ANNOUNCE;
}

/**
 * Fails open. If the filesystem misbehaves, every window notifies: a duplicate
 * popup is an annoyance, but a password prompt nobody is told about is the
 * exact failure the hub exists to prevent.
 */
async function claimSafely(key: string): Promise<boolean> {
  try {
    return await claim(key, { by: `vscode:${process.pid}` });
  } catch {
    return true;
  }
}

/**
 * Stand for a notification and, if this window ranks best, show it.
 *
 * `startedAt` lets the caller supply an already-shared instant — a request file
 * carries its own `createdAt`, so that path needs no marker of its own.
 */
async function contest(
  key: string,
  name: string,
  session: Session | undefined,
  startedAt: number | undefined,
  show: () => Promise<void>,
  /**
   * Stand down if the session stops prompting while we wait. Only correct for
   * the needs-input path: an explicit agent request stands on its own, and a
   * session that is merely idle accumulates settled ticks constantly — using
   * this there would abort every request_human a couple of seconds after the
   * agent made it.
   */
  abortIfSettled: boolean,
): Promise<void> {
  let openedAt = startedAt;
  if (openedAt === undefined) {
    try {
      ({ openedAt } = await openElection(key));
    } catch {
      openedAt = Date.now();
    }
  }

  // The decisive short-circuit. If another live window created this session, it
  // will announce it — so say nothing at all, and in particular do not take the
  // claim. No deferral, no race, nothing to get wrong.
  const owner = ownership(session);
  log(`${key} ownership=${owner} myPid=${process.pid} chain=${session?.creatorPids?.join(',') ?? 'NONE'}`);
  if (owner === 'another-window') {
    log(`${key} stand down: created by another window (${session?.creatorPids?.join(',')})`);
    return;
  }

  const rank = rankDelayMs(name, session);
  const wait = openedAt + rank - Date.now();
  log(
    `${key} enter rank=${rank}ms wait=${Math.round(wait)}ms ` +
      `session=${session ? `${session.origin ?? '-'} | ${session.cwd}` : 'UNKNOWN(not polled yet)'}`,
  );
  if (wait > 0) await sleep(wait);

  // The prompt can be answered while we wait our turn. Nothing has been shown
  // yet, so stand down rather than interrupting about a password already typed.
  //
  // Standing down must NOT release the claim: we do not hold it. Unlinking it
  // here does not end the episode, it hands the notification to whichever
  // window is still waiting — which is how one prompt produced two popups. The
  // winner announced, a second window stood down and deleted the winner's
  // claim, and a third window then claimed the vacancy and announced again.
  if (abortIfSettled && settled(name)) {
    log(`${key} stand down (settled before claiming) — NOT releasing, not ours`);
    return;
  }
  const won = await claimSafely(key);
  log(`${key} claim=${won ? 'WON' : 'lost'}`);
  if (!won) return;
  // Past here the claim is ours, so releasing it is our business alone.
  if (abortIfSettled && settled(name)) {
    await releaseOwnClaim(key);
    log(`${key} settled after winning; released our own claim`);
    return;
  }

  log(`${key} SHOWING NOTIFICATION`);
  await show();
}

export function noteNotWaiting(name: string): void {
  const seen = settledTicks.get(name) ?? 0;
  if (seen >= TICKS_BEFORE_RE_ANNOUNCE) return; // already settled and released
  const next = seen + 1;
  settledTicks.set(name, next);
  if (next < TICKS_BEFORE_RE_ANNOUNCE) return;

  announced.delete(name);
  // Only OUR claim. "The prompt is over" is this window's local, heuristic
  // reading of a pane, and windows poll at different moments — so one window
  // deciding the episode ended must not delete the claim of a window that is
  // showing the popup right now. Doing exactly that is what kept producing two
  // popups: the winner announced, another window released the winner's claim,
  // and a third took the vacancy and announced again. Cross-window cleanup is
  // reapClaimsForDeadSessions, which checks the session really is gone rather
  // than trusting one window's opinion.
  void releaseOwnClaim(needsInputKey(name));
}

export function forgetSession(name: string): void {
  announced.delete(name);
  lastShownAt.delete(name);
  // Retired, NOT deleted. A window part-way through a contest is asleep on its
  // rank delay; deleting the entry resets its settled count to zero, so it wakes
  // up believing the prompt is still live, claims, and announces a session that
  // has been killed — leaving a claim nothing will ever release. Marking it
  // settled is the evidence that the contest is over.
  settledTicks.set(name, TICKS_BEFORE_RE_ANNOUNCE);
  void releaseOwnClaim(needsInputKey(name));
}

function enabled(): boolean {
  return vscode.workspace.getConfiguration('ath').get<boolean>('notifyOnNeedsInput', true);
}

async function showNeedsInput(name: string, session: Session | undefined): Promise<void> {
  lastShownAt.set(name, Date.now());
  const command = session?.currentCommand;
  const choice = await vscode.window.showWarningMessage(
    `Terminal "${name}" is waiting for input${command ? ` (${command})` : ''}.`,
    { modal: false },
    'Attach',
    'Ignore',
  );
  if (choice === 'Attach') attachTerminal(name);
}

/** Fired when THIS window's watcher sees a session start waiting on a human. */
export async function announceNeedsInput(session: Session): Promise<void> {
  if (!enabled()) return;
  if (announced.has(session.name)) return;
  if (tooSoonToRepeat(session.name)) {
    log(`needs-input.${session.name} suppressed: announced under 90s ago`);
    announced.add(session.name);
    return;
  }
  // Marked before the first await, so a second poll cannot re-enter while we
  // are still standing in the contest.
  announced.add(session.name);
  settledTicks.set(session.name, 0);

  await contest(
    needsInputKey(session.name),
    session.name,
    session,
    undefined,
    () => showNeedsInput(session.name, session),
    true,
  );
}

/**
 * Fired when ANOTHER window opened a contest and our directory watch woke us.
 *
 * This is what lets a window with the right project open compete even though
 * its own poll has not come round yet — the case that made ranking useless
 * before, since a hidden panel polls every 3s and an open one every 0.8s.
 */
export async function joinNeedsInputElection(name: string): Promise<void> {
  if (!enabled()) return;
  if (announced.has(name)) return;
  if (tooSoonToRepeat(name)) {
    log(`needs-input.${name} suppressed: announced under 90s ago`);
    announced.add(name);
    return;
  }
  announced.add(name);
  settledTicks.set(name, 0);

  const session = await resolveSession(name);
  // A session we cannot resolve is gone. Announcing it told the user a script
  // was waiting for input when it had already finished — the log literally
  // recorded "COULD NOT RESOLVE" and then showed the notification anyway.
  if (!session) {
    log(`needs-input.${name} stand down: session no longer exists`);
    announced.delete(name);
    return;
  }
  await contest(
    needsInputKey(name),
    name,
    session,
    undefined,
    () => showNeedsInput(name, session),
    true,
  );
}

/**
 * Fired when an agent explicitly calls the MCP `request_human` tool. Distinct from
 * the heuristic above: the agent has told us exactly what it needs, so the
 * message quotes its reason rather than guessing from the pane.
 *
 * No contest marker needed — the request file already carries a `createdAt`
 * every window reads, and the directory watch wakes them all at once, so that
 * timestamp is the shared start line.
 */
export async function announceRequest(request: HumanRequest): Promise<void> {
  const key = requestKey(request.id);
  const session = await resolveSession(request.session);

  await contest(
    key,
    request.session,
    session,
    request.createdAt,
    async () => {
      const choice = await vscode.window.showWarningMessage(
        `Agent needs you at "${request.session}": ${request.reason}`,
        { modal: false },
        'Attach',
        'Dismiss',
      );
      // Clear ONLY when the human dismisses it.
      //
      // Clearing on notify destroyed the one signal that says the human has
      // already answered: the agent asked, the human typed the password, and
      // `ath requests` then reported "no open requests" — indistinguishable
      // from never having asked. The agent went on saying "still waiting for
      // you" for an hour. Attaching means they are dealing with it, so the
      // request stays until the outcome is collected or they dismiss it.
      if (choice === 'Dismiss') await clearRequest(request.id);
      await releaseOwnClaim(key);
      if (choice === 'Attach') attachTerminal(request.session);
    },
    false,
  );
}

/**
 * Drain any requests that arrived while the editor was closed.
 *
 * Safe to call repeatedly and from every window: a request already being shown
 * is claimed, and the claim is held by the showing window's own pid, so a
 * re-drain skips it rather than stacking a second dialog.
 */
export async function drainRequests(): Promise<void> {
  for (const request of await listRequests()) {
    void announceRequest(request);
  }
}
