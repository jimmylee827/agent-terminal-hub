import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { ATH_HOME, SOCKET, tmuxName } from './paths';
import { tmux } from './tmux';
import { SessionGone } from './errors';
import { randomNonce } from './util';

/** Local, metadata-only records. Never command text, output, cwd, env or reasons. */
export const COMPLETION_DIR = path.join(ATH_HOME, 'completion');
export const COMPLETION_TTL_MS = 60 * 60 * 1000;
export const DISPATCH_TTL_MS = 24 * 60 * 60 * 1000;
export type CompletionOutcome = 'done' | 'finished_nonzero' | 'interrupted' | 'shell_exited' |
  'remote_disconnected' | 'command_gone' | 'session_gone' | 'unknown_handle' |
  'outcome_unavailable' | 'timeout' | 'observer_error';
export type CompletionEvidence = 'end_marker' | 'shell_exit' | 'remote_disconnect' |
  'session_gone' | 'command_gone' | 'none';

export interface CompletionStatus {
  schema_version: 1;
  session: string;
  handle: string;
  outcome: CompletionOutcome;
  evidence: CompletionEvidence;
  exit_code: number | null;
  next_offset: number | null;
  observed_at: number;
  completion_id?: string;
  took_seconds?: number;
  expires_at?: number;
  replayed?: boolean;
  /** Safe, fixed code only. Never an exception's text. */
  error_code?: 'invalid_arguments' | 'observation_failed';
}

/** Shared by metadata observation, run/poll persistence, and MCP rendering. */
export function classifyCompletion(result: {
  exitCode: number | null; remoteDisconnected?: boolean; shellExited?: boolean; commandGone?: boolean;
}): { outcome: CompletionOutcome; evidence: CompletionEvidence } {
  if (result.remoteDisconnected) return { outcome: 'remote_disconnected', evidence: 'remote_disconnect' };
  if (result.shellExited) return { outcome: 'shell_exited', evidence: 'shell_exit' };
  if (result.commandGone) return { outcome: 'command_gone', evidence: 'command_gone' };
  const code = result.exitCode;
  if (code === null || !Number.isFinite(code)) return { outcome: 'outcome_unavailable', evidence: 'none' };
  return { outcome: code === 0 ? 'done' : code === 130 || code === 143 ? 'interrupted' : 'finished_nonzero',
    evidence: 'end_marker' };
}

export interface DispatchRecord {
  version: 1;
  socket: string;
  session: string;
  handle: string;
  incarnation: string;
  dispatched_at: number;
  offset: number;
  expires_at: number;
  completion?: CompletionStatus;
}

export function validCompletionTarget(session: string, handle: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(session) && /^[0-9a-f]{12}$/.test(handle);
}

/** No pane capture, and no inference from session name or second-resolution creation time. */
export async function completionIncarnation(session: string): Promise<string> {
  const { stdout, stderr } = await tmux(['display-message', '-p', '-t', tmuxName(session),
    '#{session_id}:#{session_created}:#{pid}:#{@ath_generation}'], { allowFail: true });
  if (stderr || !stdout.trim()) {
    if (/no server running|can'?t find session|no such session|session not found|No such file or directory|Connection refused/i.test(stderr)) {
      throw new SessionGone(session);
    }
    throw new Error('completion_identity_unavailable');
  }
  const identity = stdout.trim();
  if (!/^\$\d+:\d+:\d+:(?:[0-9a-f]{24})?$/.test(identity)) {
    throw new Error('completion_identity_unavailable');
  }
  return createHash('sha256').update(`${SOCKET}:${identity}`).digest('hex');
}

export function completionId(record: DispatchRecord): string {
  return createHash('sha256').update(`${record.incarnation}:${record.handle}`).digest('hex');
}

async function atomicRecord(record: DispatchRecord): Promise<void> {
  await fs.mkdir(COMPLETION_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(COMPLETION_DIR, `${record.handle}.json`);
  const tmp = `${file}.${randomNonce(8)}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
    await fs.rename(tmp, file);
  } finally {
    await fs.unlink(tmp).catch(() => undefined);
  }
}

export async function readDispatch(handle: string): Promise<DispatchRecord | undefined> {
  if (!/^[0-9a-f]{12}$/.test(handle)) return undefined;
  let raw: string;
  try { raw = await fs.readFile(path.join(COMPLETION_DIR, `${handle}.json`), 'utf8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const r = JSON.parse(raw) as DispatchRecord;
  if (r.version !== 1 || r.handle !== handle || !validCompletionTarget(r.session, handle) ||
      typeof r.incarnation !== 'string' || !/^[0-9a-f]{64}$/.test(r.incarnation) ||
      !Number.isFinite(r.dispatched_at) || !Number.isFinite(r.offset) || !Number.isFinite(r.expires_at)) {
    throw new Error('invalid_completion_record');
  }
  return r;
}

/** Called under the session's dispatch lock, BEFORE any command is typed. */
export async function recordDispatch(session: string, handle: string, offset: number): Promise<void> {
  if (!validCompletionTarget(session, handle)) throw new Error('invalid_completion_target');
  // Old live sessions predate this option. Initialize once while holding their command lock.
  const { stdout } = await tmux(['show-options', '-qv', '-t', tmuxName(session), '@ath_generation']);
  if (!/^[0-9a-f]{24}$/.test(stdout.trim())) {
    await tmux(['set-option', '-t', tmuxName(session), '@ath_generation', randomNonce(12)]);
  }
  const now = Date.now();
  await atomicRecord({ version: 1, socket: SOCKET, session, handle,
    incarnation: await completionIncarnation(session), dispatched_at: now, offset,
    expires_at: now + DISPATCH_TTL_MS });
  await tmux(['set-option', '-t', tmuxName(session), '@ath_active_handle', handle]);
  await reapCompletionRecords(now);
}

/** First conclusive observation wins; exclusive hard-link publication is atomic across readers. */
export async function recordCompletion(record: DispatchRecord, status: CompletionStatus): Promise<CompletionStatus> {
  const file = path.join(COMPLETION_DIR, `${record.handle}.result`);
  const tmp = `${file}.${randomNonce(8)}.tmp`;
  const saved: CompletionStatus = { ...status, completion_id: completionId(record),
    expires_at: Date.now() + COMPLETION_TTL_MS };
  try {
    await fs.writeFile(tmp, JSON.stringify(saved), { mode: 0o600 });
    try { await fs.link(tmp, file); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
    return (await readCompletion(record))!;
  } finally { await fs.unlink(tmp).catch(() => undefined); }
}

export async function readCompletion(record: DispatchRecord): Promise<CompletionStatus | undefined> {
  let raw: string;
  try { raw = await fs.readFile(path.join(COMPLETION_DIR, `${record.handle}.result`), 'utf8'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const r = JSON.parse(raw) as CompletionStatus;
  const outcomes: CompletionOutcome[] = ['done', 'finished_nonzero', 'interrupted', 'shell_exited',
    'remote_disconnected', 'command_gone', 'session_gone', 'outcome_unavailable'];
  const evidence: CompletionEvidence[] = ['end_marker', 'shell_exit', 'remote_disconnect', 'session_gone', 'command_gone', 'none'];
  if (r.schema_version !== 1 || r.session !== record.session || r.handle !== record.handle ||
      !outcomes.includes(r.outcome) || !evidence.includes(r.evidence) ||
      (r.exit_code !== null && !Number.isInteger(r.exit_code)) ||
      (r.next_offset !== null && (!Number.isSafeInteger(r.next_offset) || r.next_offset < 0)) ||
      !Number.isFinite(r.observed_at) ||
      (r.took_seconds !== undefined && (!Number.isFinite(r.took_seconds) || r.took_seconds < 0)) ||
      r.completion_id !== completionId(record) || !Number.isFinite(r.expires_at)) {
    throw new Error('invalid_completion_result');
  }
  // Explicit allowlist on reads too: a viewer/old writer must not add text to the protocol.
  return { schema_version: 1, session: r.session, handle: r.handle, outcome: r.outcome,
    evidence: r.evidence, exit_code: r.exit_code, next_offset: r.next_offset,
    observed_at: r.observed_at, completion_id: r.completion_id, expires_at: r.expires_at,
    ...(r.took_seconds === undefined ? {} : { took_seconds: r.took_seconds }) };
}

/** Dispatch expires after 24h; retain its tombstone another day so expiry is explicit. */
export async function reapCompletionRecords(now = Date.now()): Promise<void> {
  // CLI processes are short-lived: a process-local throttle would still scan
  // every record on EVERY command. Persist the sweep watermark, not output.
  const sweep = path.join(COMPLETION_DIR, '.sweep');
  const previous = await fs.stat(sweep).catch(() => undefined);
  if (previous && now - previous.mtimeMs < COMPLETION_TTL_MS) return;
  await fs.writeFile(sweep, String(now), { mode: 0o600 });
  const entries = await fs.readdir(COMPLETION_DIR).catch(() => [] as string[]);
  for (const name of entries) {
    if (!/^[0-9a-f]{12}\.(json|result)(\.[0-9a-f]+\.tmp)?$/.test(name)) continue;
    const file = path.join(COMPLETION_DIR, name);
    const st = await fs.stat(file).catch(() => undefined);
    if (st && now - st.mtimeMs > 2 * DISPATCH_TTL_MS) await fs.unlink(file).catch(() => undefined);
  }
}
