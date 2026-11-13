import { SessionGone } from './errors';
import { SOCKET } from './paths';
import { withObserverSignal } from './tmux';
import { handleEvidence } from './run';
import { completionId, completionIncarnation, readCompletion, readDispatch, recordCompletion,
  classifyCompletion, validCompletionTarget, type CompletionStatus } from './completion-store';

export { COMPLETION_DIR, COMPLETION_TTL_MS, DISPATCH_TTL_MS, classifyCompletion } from './completion-store';
export type { CompletionStatus, CompletionOutcome, CompletionEvidence } from './completion-store';

export function completionTimeoutNote(): string {
  return 'The bounded observation timed out without a confirmed outcome. This does NOT ' +
    'prove the command is still running or that anyone still owes a password. No ' +
    'automatic wake subscription was created. A supporting host can use the CLI ' +
    'metadata waiter for background delivery; otherwise check this handle when resumed. ' +
    'Do not call this repeatedly in a model loop.';
}

export function completionUnknownNote(session: string, outcome: string, code: number | null): string {
  return `[ath] "${session}" — ${outcome}; exit status ${code ?? 'unknown'}. ` +
    'This is not proof anyone answered. Check the session before deciding what to do.';
}

function empty(session: string, handle: string, outcome: CompletionStatus['outcome']): CompletionStatus {
  return { schema_version: 1, session, handle, outcome, evidence: 'none', exit_code: null,
    next_offset: null, observed_at: Date.now() };
}

/** One observation; no latest-handle guessing, request resolution or UI side effects. */
export async function probeCompletion(session: string, handle: string): Promise<CompletionStatus> {
  if (!validCompletionTarget(session, handle)) {
    return { ...empty('', '', 'observer_error'), error_code: 'invalid_arguments' };
  }
  try {
    const record = await readDispatch(handle);
    if (!record || record.session !== session || record.socket !== SOCKET) return empty(session, handle, 'unknown_handle');
    const saved = await readCompletion(record);
    const now = Date.now();
    if (saved) {
      if (now >= saved.expires_at!) return { ...empty(session, handle, 'outcome_unavailable'),
        completion_id: completionId(record), expires_at: saved.expires_at };
      return { ...saved, observed_at: now, replayed: true };
    }
    if (now >= record.expires_at) return { ...empty(session, handle, 'outcome_unavailable'),
      completion_id: completionId(record), expires_at: record.expires_at };
    const gone = async (): Promise<CompletionStatus> => recordCompletion(record, {
      ...empty(session, handle, 'session_gone'), evidence: 'session_gone' });
    let identity: string;
    try { identity = await completionIncarnation(session); }
    catch (err) { if (err instanceof SessionGone) return gone(); throw err; }
    if (identity !== record.incarnation) return gone();
    const seen = await handleEvidence(session, handle, record.offset);
    if (seen.outcomeUnavailable) return { ...empty(session, handle, 'outcome_unavailable'),
      next_offset: seen.nextOffset, expires_at: record.expires_at };
    // Never commit a result read across a kill/recreate of the same logical name.
    try { if (await completionIncarnation(session) !== record.incarnation) return gone(); }
    catch (err) { if (err instanceof SessionGone) return gone(); throw err; }
    if (!seen.finished) return { ...empty(session, handle, 'timeout'), next_offset: seen.nextOffset,
      expires_at: record.expires_at };
    return await recordCompletion(record, { schema_version: 1, session, handle,
      ...classifyCompletion(seen), exit_code: seen.exitCode, next_offset: seen.nextOffset,
      observed_at: Date.now(), ...(seen.seconds === undefined ? {} : { took_seconds: seen.seconds }) });
  } catch {
    return { ...empty(session, handle, 'observer_error'), error_code: 'observation_failed' };
  }
}

/** Timeout is an OBSERVER deadline, not evidence that somebody still owes a password. */
export async function waitCompletion(session: string, handle: string, timeoutSeconds = 1800): Promise<CompletionStatus> {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
    return { ...empty('', '', 'observer_error'), error_code: 'invalid_arguments' };
  }
  const deadline = performance.now() + timeoutSeconds * 1000;
  for (;;) {
    // Bound each observation too: a hung tmux/filesystem must not hold this waiter forever.
    // A snapshot still gets one bounded attempt; it never sleeps for another probe.
    const budget = timeoutSeconds === 0 ? 5000 : Math.max(1, Math.min(5000, deadline - performance.now()));
    let timer: NodeJS.Timeout | undefined;
    const controller = new AbortController();
    const res = await Promise.race([
      withObserverSignal(controller.signal, () => probeCompletion(session, handle)),
      new Promise<CompletionStatus>((resolve) => {
        timer = setTimeout(() => {
          const deadlineReached = timeoutSeconds > 0 && performance.now() >= deadline;
          resolve(deadlineReached ? empty(session, handle, 'timeout') : {
            ...empty(session, handle, 'observer_error'), error_code: 'observation_failed' });
          controller.abort();
        }, budget);
      }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
    if (res.outcome !== 'timeout' || timeoutSeconds === 0 || performance.now() >= deadline) return res;
    await new Promise((r) => setTimeout(r, Math.min(750, Math.max(0, deadline - performance.now()))));
  }
}
