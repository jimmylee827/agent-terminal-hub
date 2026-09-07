import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { AthError, SessionBusy, SessionGone } from './errors';
import { withSessionLock } from './lock';
import {
  HELPER_ONELINE,
  RC_DIR,
  agentTagLine,
  ensureLayout,
  frameHooksFor,
  discardedBytes,
  logPath,
  durationMarkerRe,
  rcPath,
  rotateIfNeeded,
} from './paths';
import {
  assertNotCredentialPrompt,
  capturePane,
  get,
  list,
  installHelper,
  paneStatus,
  respawn,
  sendLine,
  readMeta,
  setMeta,
  shellDepth,
  validateName,
} from './session';
import { ensureControlDir, sshLaunchLine } from './ssh';
import { clearRequest, listRequests, requestHuman } from './requests';
import { classify, couldBePrompting, isNesting, isShell, looksLikePrompt } from './state';
import type { PollResult, RunOptions, RunResult, Session, StartResult } from './types';
import { randomNonce, shellQuote, sleep, stripAnsi, toLines, trimBlankEdges } from './util';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 90;

/**
 * Grace period to let pipe-pane flush the end marker after the .rc file lands.
 * The helper prints the marker before writing .rc, so this waits on pipe
 * buffering rather than on the command.
 */
const MARKER_FLUSH_MS = 900;

/**
 * How long output must sit still before a prompt-shaped pane counts as waiting
 * on a human. Short enough to feel immediate, long enough that a command
 * pausing mid-work is not mistaken for a question.
 */
const PROMPT_STALL_MS = 1200;

/** Do not begin prompt detection until a command has had a moment to produce output. */
const PROMPT_GRACE_MS = 900;

/** How often to capture the pane while watching for a prompt. */
const PROMPT_CHECK_MS = 500;

/** Never buffer more than this from a single command; protects against a runaway process. */
const MAX_SLICE_BYTES = 16 * 1024 * 1024;

/**
 * How much output one `poll` or incremental `read` hands back by default.
 *
 * MAX_SLICE_BYTES is a MEMORY guard — 16 MB, sized to stop a runaway process
 * exhausting the process, and it does that job. It is not a context guard, and
 * nothing else was one: an agent following a build that printed 2.6 MB got all
 * 2.6 MB in a single poll. The damage is done by the time it can see the size,
 * which is why a warning on the result cannot fix this and a smaller default
 * can.
 *
 * The skipped bytes are RECOVERABLE — the result says exactly which `since`
 * returns them — so this is pagination, not truncation. Pass `maxBytes: 0` to
 * opt out and get everything, for a caller that genuinely wants the lot.
 */
const MAX_RETURN_BYTES = 64 * 1024;

/**
 * How much of a capped slice is taken from the START of the new output.
 *
 * The rest comes from the end. Both halves earn their place: the tail holds
 * the error and the exit, and the head continues from exactly where the last
 * poll stopped — dropping it would break the continuity the offset exists to
 * provide. Weighted towards the tail because that is where a job goes wrong.
 */
const CAP_HEAD_FRACTION = 0.25;

/** How much of a log `readTail` looks at. Bounded so cost is independent of log size. */
const TAIL_WINDOW_BYTES = 256 * 1024;

/**
 * Marker lines are protocol plumbing and never belong in output shown to anyone.
 *
 * Must track the end marker's optional trailing fields. Missing them here does
 * not fail loudly — it silently prints a wall of base64 into the user's output.
 */
// Every marker letter the hub emits: Start, End, Tag-ack, pRobe, Duration.
//
// Adding a marker type means adding it HERE too, or its text reaches the
// caller as if it were output. `D` was missed on its first day and the console
// hygiene check caught it immediately — which is the entire reason that check
// exists, since nothing else in the suite reads what an agent would actually
// see.
const MARKER_LINE_RE = /<ATH[SETRD]:[A-Za-z0-9]+(?::-?\d+)?(?::[A-Za-z0-9+/=]*){0,2}>/;

/** Enough of the log tail to be certain the end marker is inside it. */
const MARKER_SCAN_BYTES = 32 * 1024;

export function startMarker(nonce: string): string {
  return `<ATHS:${nonce}>`;
}

/**
 * The end marker carries the exit code: `<ATHE:<nonce>:0>`.
 *
 * Matching is on this prefix, never on a closed `<ATHE:nonce>` form, which no
 * longer occurs.
 */
export function endMarker(nonce: string): string {
  return `<ATHE:${nonce}:`;
}

/**
 * `<ATHE:nonce:rc>` or `<ATHE:nonce:rc:B64CWD:B64ENV>`.
 *
 * The trailing fields are optional on purpose. A pane may still hold an older
 * helper, and a shell without `base64` emits them empty — in both cases the
 * exit code, which is the part everything depends on, must still parse.
 */
function endMarkerRe(nonce: string): RegExp {
  // The SENTINEL is REQUIRED, not decorative.
  //
  // Without it, a command could end itself early and report whatever status it
  // liked: the nonce is echoed into the pane on the tag line, so a command can
  // read it back out of shell history and print a matching `<ATHE:…:0:…>`.
  // Demonstrated, not theorised — a command that forged exit 0 while really
  // exiting 7 was believed, and the hub reported 0.
  //
  // Every real emitter already wraps the marker in \036 (all three checked:
  // both hook paths and the fallback wrapper), and `latestHandle` has always
  // required it. This parse simply never did, so the rule the comment beside
  // it claimed — "only SENTINEL-wrapped markers count" — was true of one
  // reader and not the other.
  //
  // The severity is low: an agent already controls what it runs, so this is
  // not a privilege boundary. It matters because the exit code is the one
  // value the hub asserts as fact, and a fact that can be spoofed by the thing
  // being measured is not a fact.
  return new RegExp(
    `${SENTINEL}<ATHE:${nonce}:(-?\\d+)(?::([A-Za-z0-9+/=]*))?(?::([A-Za-z0-9+/=]*))?>`,
  );
}

export interface CommandEnd {
  code: number;
  /** Working directory the command finished in, if the helper reported it. */
  cwd?: string;
  /**
   * Wall-clock seconds, measured BY THE SHELL that ran the command.
   *
   * Present whenever that shell had `date`. This is a measurement, unlike the
   * observation bracket, which could only ever say when the hub looked.
   */
  measuredSeconds?: number;
  /**
   * The shell this command ran in still has the framing hooks.
   *
   * Reported BY the fallback wrapper, which is the only thing running when
   * framing is off — so the hub can notice that hooks are available again
   * without spending a round trip asking. Without it, one trip into a shell
   * that cannot host hooks (a `docker exec` into busybox) turned framing off
   * for the rest of the session's life, even after the human typed `exit` and
   * came back to a shell that had them all along.
   */
  hooks?: boolean;
  /**
   * An assignment the HUMAN typed, carried so a reconnect can restore it.
   * Anything typed straight into the terminal lived only in the shell the
   * dropped link took with it; this is the one channel that can rescue it.
   */
  env?: string;
}

function decodeB64(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const text = Buffer.from(value, 'base64').toString('utf8').trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Look for the end marker in the tail of the log.
 *
 * Only the tail: the marker is by definition the last thing a command emits,
 * and scanning the whole slice on every poll would be linear in the output
 * produced so far — ruinous for a command that prints a lot.
 */
async function findCommandEnd(logFile: string, nonce: string): Promise<CommandEnd | undefined> {
  const raw = await readLogTailBytes(logFile, MARKER_SCAN_BYTES);
  if (!raw) return undefined;
  // The command's own measurement, if its shell could take one. Read from the
  // same buffer, so it costs nothing. See durationMarkerRe.
  const measured = durationMarkerRe(nonce).exec(raw);
  const measuredSeconds = measured ? Number(measured[1]) : undefined;
  // Matched against the RAW capture, not against `toLines`.
  //
  // `toLines` runs `stripAnsi`, which removes control characters — including
  // the SENTINEL that makes a marker unforgeable. Requiring the sentinel while
  // matching post-strip text can therefore never match, which is exactly what
  // happened: every command timed out. `latestHandle` has always scanned the
  // raw tail for this reason; this reader simply never did.
  {
    const hit = endMarkerRe(nonce).exec(raw);
    if (hit?.[1] !== undefined) {
      // The 4th field means different things by source, and they are trivially
      // separable: the WRAPPER writes a hooks flag, exactly "0" or "1"; the
      // HOOKS write a base64 assignment, which is never one character.
      const extra = hit[3] ?? '';
      const isFlag = extra === '0' || extra === '1';
      return {
        code: Number(hit[1]),
        cwd: decodeB64(hit[2]),
        hooks: isFlag ? extra === '1' : undefined,
        env: isFlag ? undefined : decodeB64(extra),
        ...(Number.isFinite(measuredSeconds) ? { measuredSeconds } : {}),
      };
    }
  }
  return undefined;
}

async function findExitCode(logFile: string, nonce: string): Promise<number | undefined> {
  return (await findCommandEnd(logFile, nonce))?.code;
}

/**
 * Note when a command began, beside its .rc file and keyed by the same handle.
 *
 * A separate tiny file rather than session metadata: metadata is a flat set of
 * tmux options parsed positionally, and adding a field there has already cost
 * this project one silent corruption. This is per-HANDLE, which is also the
 * right granularity — the question "how long has THIS job been running" is
 * about the job, not the session.
 */
async function markStarted(nonce: string, offset: number): Promise<void> {
  await fs.mkdir(RC_DIR, { recursive: true, mode: 0o700 }).catch(() => undefined);
  await fs
    .writeFile(path.join(RC_DIR, `${nonce}.t`), `${Date.now()} ${offset}`, { mode: 0o600 })
    .catch(() => undefined);
}

/**
 * What can HONESTLY be said about how long a command took.
 *
 * Four attempts, and each failure taught the next one something:
 *
 *   1. `now - started` even when finished — a 2s job polled 48s later read 48.
 *   2. time of first sighting — a 47s job read 256, off by five times.
 *   3. withhold unless the bracket is tight — but it then said "Nobody looked
 *      while this was running" to an agent who HAD polled mid-run and been
 *      answered. Saying something false about the caller's own session is worse
 *      than saying nothing, and it threw away the bracket, which was real
 *      information: "between 26 and 60 seconds" is an answer.
 *
 * So: report the bracket. The hub never sees the instant a command ends, only
 * when something looked, and every poll that finds it still running raises the
 * floor. That is honest, always says something, and never claims a precision it
 * does not have.
 */
async function timingFor(
  nonce: string,
  done: boolean,
  /**
   * The shell's own measurement, when it took one.
   *
   * Supplied, everything below is skipped: there is nothing to estimate. The
   * bracket exists only for shells that could not measure.
   */
  measuredSeconds?: number,
): Promise<
  | {
      exact: boolean;
      seconds?: number;
      lowerSeconds?: number;
      upperSeconds?: number;
      observed: boolean;
      startOffset?: number;
    }
  | undefined
> {
  // A measurement beats every heuristic below it.
  if (done && measuredSeconds !== undefined && Number.isFinite(measuredSeconds)) {
    let startOffset: number | undefined;
    try {
      const [, o] = (await fs.readFile(path.join(RC_DIR, `${nonce}.t`), 'utf8')).trim().split(/\s+/);
      startOffset = o === undefined ? undefined : Number(o);
    } catch {
      /* the offset is a nicety; the duration is the answer */
    }
    return {
      exact: true,
      seconds: measuredSeconds,
      observed: true,
      ...(Number.isFinite(startOffset) ? { startOffset } : {}),
    };
  }

  const file = path.join(RC_DIR, `${nonce}.t`);
  let began: number;
  let startOffset: number | undefined;
  let noticed: number | undefined;
  let lastRunning: number | undefined;
  try {
    const [b, o, n, lr] = (await fs.readFile(file, 'utf8')).trim().split(/\s+/);
    began = Number(b);
    startOffset = o === undefined ? undefined : Number(o);
    noticed = n === undefined || n === '-' ? undefined : Number(n);
    lastRunning = lr === undefined || lr === '' ? undefined : Number(lr);
    if (!Number.isFinite(began)) return undefined;
  } catch {
    return undefined;
  }
  const off = Number.isFinite(startOffset) ? { startOffset } : {};
  const write = async (nv?: number, lrv?: number) =>
    fs
      .writeFile(file, `${began} ${startOffset ?? 0} ${nv ?? '-'} ${lrv ?? ''}`.trim(), {
        mode: 0o600,
      })
      .catch(() => undefined);

  if (!done) {
    // Seeing it alive raises the floor of the eventual bracket.
    await write(noticed, Date.now());
    return {
      exact: true,
      seconds: Math.max(0, Math.round((Date.now() - began) / 1000)),
      observed: true,
      ...off,
    };
  }

  if (noticed === undefined || !Number.isFinite(noticed)) {
    noticed = Date.now();
    await write(noticed, lastRunning);
  }

  const upper = Math.max(0, Math.round((noticed - began) / 1000));
  const lower = Number.isFinite(lastRunning)
    ? Math.max(0, Math.round(((lastRunning as number) - began) / 1000))
    : 0;
  // Close enough to be one number? Then say one number.
  if (upper - lower <= 2) return { exact: false, seconds: upper, observed: lower > 0, ...off };
  return { exact: false, lowerSeconds: lower, upperSeconds: upper, observed: lower > 0, ...off };
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return 0;
  }
}

/** Read a log from a byte offset. Offsets are exact because the log is append-only. */
export async function readLogFrom(file: string, offset: number): Promise<string> {
  let handle;
  try {
    handle = await fs.open(file, 'r');
  } catch {
    return '';
  }
  try {
    const { size } = await handle.stat();
    if (size <= offset) return '';
    const available = size - offset;
    const length = Math.min(available, MAX_SLICE_BYTES);
    // On overflow keep the TAIL: the end of a runaway command's output is
    // where the error and the exit are.
    const start = available > MAX_SLICE_BYTES ? size - MAX_SLICE_BYTES : offset;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    const text = buf.toString('utf8');
    return available > MAX_SLICE_BYTES
      ? `[ath: ${available - MAX_SLICE_BYTES} earlier bytes omitted]\n${text}`
      : text;
  } finally {
    await handle.close();
  }
}

/** Read an exact byte range. Offsets are exact because the log is append-only. */
async function readLogRange(file: string, start: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  let handle;
  try {
    handle = await fs.open(file, 'r');
  } catch {
    return Buffer.alloc(0);
  }
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export interface CappedSlice {
  raw: string;
  /** Bytes dropped from the middle, and the `since` that returns them. */
  omitted?: { bytes: number; resumeFrom: number };
}

/**
 * What an offset means, once the log has been trimmed under it.
 *
 * Offsets handed to callers are LOGICAL — bytes since this incarnation of the
 * session began — while the file only ever holds the tail. `discarded` is the
 * distance between the two. Everything that reads by offset resolves it here,
 * so the three ways an offset can be wrong are answered in one place instead
 * of each caller silently doing `min(since, size)` and returning nothing.
 */
interface ResolvedOffset {
  /** Where to actually read from in the file. */
  physical: number;
  /** Logical position of the end of the file. */
  logicalEnd: number;
  /** Requested bytes that have been trimmed away and cannot be returned. */
  lostBytes?: number;
  /** The offset was past the end — a stale handle, or another incarnation. */
  beyondEnd?: boolean;
}

/**
 * The offset a caller may hand back later. Logical, always.
 *
 * Every number the hub gives out as an offset has to be in the same units, or
 * the units become a trap: `run` reported `log_offset` as a physical file
 * position while `read` and `poll` returned logical ones, so passing the first
 * to the second landed in the wrong place — silently, and only after a trim,
 * which is the hardest kind of wrong to find.
 */
async function logicalEnd(name: string): Promise<number> {
  return (await discardedBytes(name)) + (await fileSize(logPath(name)));
}

async function resolveOffset(name: string, since: number): Promise<ResolvedOffset> {
  const discarded = await discardedBytes(name);
  const physSize = await fileSize(logPath(name));
  const logicalEnd = discarded + physSize;
  if (since < discarded) {
    // The bytes asked for are gone. Read from the earliest that survives and
    // SAY how much was lost, rather than quietly returning a later slice as
    // though it were the one requested.
    return { physical: 0, logicalEnd, lostBytes: discarded - since };
  }
  if (since > logicalEnd) {
    return { physical: physSize, logicalEnd, beyondEnd: true };
  }
  return { physical: since - discarded, logicalEnd };
}

/**
 * Everything after `since`, bounded, with the gap made RECOVERABLE.
 *
 * The cut is made on RAW BYTES, before any text processing, because that is
 * the only place an offset means anything. Cutting the cleaned string and then
 * reporting a byte offset would hand back a number that does not address what
 * was dropped — worse than offering none, because a caller would trust it.
 *
 * The marker goes in on its own line as plain text, so it survives
 * `cleanSlice` and `trimToCommandWindow` rather than being filtered out as
 * plumbing. The command's own markers survive the cut too: a start marker is
 * at the beginning of its output, so it lands in the head, and an end marker
 * is the last thing it writes, so it lands in the tail.
 */
async function readLogCapped(
  file: string,
  since: number,
  size: number,
  maxBytes = MAX_RETURN_BYTES,
): Promise<CappedSlice> {
  const start = Math.max(0, Math.min(since, size));
  const available = size - start;
  if (maxBytes <= 0 || available <= maxBytes) {
    return { raw: await readLogFrom(file, start) };
  }
  const headLen = Math.max(1, Math.floor(maxBytes * CAP_HEAD_FRACTION));
  const tailLen = maxBytes - headLen;

  // Both cuts land on a LINE boundary, and the offsets follow the cut rather
  // than the requested length.
  //
  // Cutting at an arbitrary byte splits whichever line straddles it: half
  // lands in the head, half begins the omitted region, and the line exists
  // WHOLE in neither what you were handed nor what you fetch back. The suite
  // caught exactly that — one line of twenty thousand, invisible to both — and
  // a gap that cannot return every line it swallowed is not pagination, it is
  // loss with a reassuring note attached. It also spliced half a line onto the
  // marker, which reads as corrupted output.
  const headBuf = await readLogRange(file, start, headLen);
  const lastNewline = headBuf.lastIndexOf(0x0a);
  const headBytes = lastNewline >= 0 ? lastNewline + 1 : headBuf.length;
  const resumeFrom = start + headBytes;

  const tailBuf = await readLogRange(file, size - tailLen, tailLen);
  const firstNewline = tailBuf.indexOf(0x0a);
  const tailSkip = firstNewline >= 0 ? firstNewline + 1 : 0;
  const tailFrom = size - tailLen + tailSkip;

  // Alignment ate the whole gap; there is nothing to omit, so do not pretend.
  if (tailFrom <= resumeFrom) return { raw: await readLogFrom(file, start) };

  const head = headBuf.subarray(0, headBytes).toString('utf8');
  const tail = tailBuf.subarray(tailSkip).toString('utf8');
  const bytes = tailFrom - resumeFrom;
  const note = `[ath: ${bytes} bytes omitted here — read them with since=${resumeFrom}]`;
  return { raw: `${head}${note}\n${tail}`, omitted: { bytes, resumeFrom } };
}

/**
 * Read only the last window of a log.
 *
 * `readTail` used to read the whole file to return five lines, which was
 * linear in log size — 6.8MB took 178ms and buffered the lot. A session
 * running a dev server has no bound on that.
 */
async function readLogTailBytes(file: string, maxBytes = TAIL_WINDOW_BYTES): Promise<string> {
  let handle;
  try {
    handle = await fs.open(file, 'r');
  } catch {
    return '';
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return '';
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, size - length);
    return buf.toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Pull a single command's output out of the pane log.
 *
 * Matches the LAST start marker before the first following end marker. The
 * helper keeps markers out of the echoed command line, but matching the last
 * occurrence stays correct even if a command echoes a marker itself.
 */
/**
 * Drop the shell's echo of the command we just typed.
 *
 * Where the start marker sits relative to the echo depends on the shell. zsh's
 * `preexec` runs AFTER the line is echoed, so the echo falls outside the frame
 * and never reaches us. bash has no preexec: it frames from PROMPT_COMMAND,
 * which runs BEFORE the prompt is drawn, so the marker, the prompt and the
 * echoed command all arrive together — and because the marker ends in `\r`,
 * the echo lands on its own line INSIDE the frame.
 *
 * Matching the command text is what makes this safe. A prompt-shaped regex
 * would eat real output from anything that prints a `$`, and there is no
 * reliable way to tell a prompt from a line of output that resembles one.
 */
/**
 * Remove zsh's "this line had no newline" marker from the end of the output.
 *
 * With PROMPT_SP (on by default) zsh marks a command whose output lacks a
 * trailing newline by printing an inverse `%` and padding spaces to the end of
 * the row. Stripped of ANSI that lands as a literal `%` plus a run of spaces
 * glued to the last line of real output — so `printf abc` came back as `abc%`
 * followed by ~200 spaces, and a 4000-character line measured 4201 bytes.
 *
 * Anchored to a `%` followed by spaces at the very end, because that is the
 * shape zsh emits; a bare trailing `%` is left alone, since `echo 100%` is
 * real output. Filtering beats unsetting `prompt_sp` in someone's shell.
 */
/**
 * Collapse carriage-return overwrites the way a terminal does.
 *
 * A progress bar prints `\r[1/200]\r[2/200]…`: one display line rewritten in
 * place, of which a human sees only the last frame. Splitting on `\r` returned
 * all 200, so `docker pull` or `apt install` handed back hundreds of lines for
 * something shown as one.
 *
 * The first attempt at this failed and had to be reverted, because a marker and
 * a progress frame were indistinguishable: both are `\r`-separated segments,
 * and `echo "<ATHS:cafebabe>"` looks exactly like the real thing. That is why
 * markers are now wrapped in RS (0x1E) at the point they are written — a byte
 * no ordinary command output carries. Keeping segments that hold it, and
 * dropping the rest of an overwritten line, is then decidable rather than
 * guessed.
 */
const SENTINEL = '\u001e';

function collapseOverwrites(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      // Strip the CR of a CRLF first, or `content\r\n` splits to ["content", ""]
      // and the empty tail wins — deleting every line of real output.
      const body = line.replace(/\r$/, '');
      if (!body.includes('\r')) return body;
      // Keep every marker segment where it sits, and collapse each RUN of
      // ordinary segments to its last member — that run is one spot on screen
      // being rewritten, and the last write is what the human ends up seeing.
      //
      // Taking "markers plus the final segment" instead was wrong: when real
      // output is followed by a marker, the final segment IS the marker, and
      // the output vanished. `printf abc` came back empty.
      const segments = body.split('\r');
      const kept: string[] = [];
      let run: string | undefined;
      for (const seg of segments) {
        if (seg.includes(SENTINEL)) {
          if (run !== undefined) kept.push(run);
          run = undefined;
          kept.push(seg);
        } else if (seg.trim() !== '' || run === undefined) {
          // A blank segment does not overwrite anything visible. zsh's
          // partial-line marker ends `\r <space> \r`, so taking the literal
          // last member of the run kept that space and threw the real output
          // away — `printf abc` came back empty.
          run = seg;
        }
      }
      if (run !== undefined) kept.push(run);
      return kept.join('\r');
    })
    .join('\n');
}

function stripZshPartialMarker(lines: string[]): string[] {
  if (lines.length === 0) return lines;
  const last = lines[lines.length - 1] ?? '';
  const trimmed = last.replace(/%[ \t]+$/, '');
  if (trimmed === last) return lines;
  return [...lines.slice(0, -1), trimmed];
}

function dropEchoedCommand(lines: string[], command?: string): string[] {
  const wanted = command?.trim();
  if (!wanted || lines.length === 0) return lines;
  const first = (lines[0] ?? '').replace(/\u0007/g, '').trimEnd();
  return first.endsWith(wanted) ? lines.slice(1) : lines;
}

export function extractBetweenMarkers(raw: string, nonce: string, command?: string): string {
  const lines = toLines(collapseOverwrites(raw));
  const start = startMarker(nonce);
  const end = endMarker(nonce);

  let startIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? '').includes(start)) startIndex = i;
  }
  if (startIndex === -1) return '';

  const out: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.includes(end)) {
      // Output that does not end in a newline shares its line with the end
      // marker: `printf abc` arrives as `abc<ATHE:…>`. Dropping the whole line
      // silently ate the last thing the command printed, and only zsh hid it —
      // its partial-line marker forces a break that bash has no equivalent of.
      const head = line.slice(0, line.indexOf(end));
      if (head !== '') out.push(head);
      break;
    }
    if (ZSH_PARTIAL_LINE_RE.test(line)) continue;
    out.push(line);
  }
  return stripZshPartialMarker(trimBlankEdges(dropEchoedCommand(out, command))).join('\n');
}

/**
 * The wrapper line tmux echoes when we type a command. Plumbing, not output.
 *
 */
const WRAPPER_ECHO_RE = /^\s*__ath\s+[0-9a-f]{8,}\s/;

/**
 * The helper definition itself, echoed when it is installed into a shell we did
 * not set up — the far side of an ssh hop, a container, a sub-shell.
 *
 * It contains literal `<ATHS:`/`<ATHE:` text, so without this an agent reading
 * a freshly connected session gets a screenful of shell source that looks like
 * protocol output.
 */
const HELPER_DEF_RE = /__ath\(\)\s*\{/;

/**
 * zsh's partial-line indicator: an inverse `%` padded to the pane width.
 *
 * zsh prints it when the previous output did not end in a newline, to show
 * nothing was lost. Our end marker is erased with `\r\033[K` and so ends
 * mid-line, and now that the marker comes from `precmd` it lands exactly when
 * zsh runs that check. It is a display artifact, never command output, and
 * filtering it is preferable to unsetting `prompt_sp` in someone's shell.
 */
const ZSH_PARTIAL_LINE_RE = /^%\s*$/;

function isNoise(line: string): boolean {
  return (
    MARKER_LINE_RE.test(line) ||
    WRAPPER_ECHO_RE.test(line) ||
    HELPER_DEF_RE.test(line) ||
    ZSH_PARTIAL_LINE_RE.test(line)
  );
}

/** Clean a raw log slice for display: ANSI and backspaces resolved, plumbing removed. */
function cleanSlice(raw: string): string {
  return stripZshPartialMarker(trimBlankEdges(toLines(raw).filter((line) => !isNoise(line)))).join('\n');
}

/**
 * Narrow a slice to one command's output when the markers are present.
 *
 * Unlike `extractBetweenMarkers`, a missing start marker is fine: an
 * incremental poll begins in the middle of a command's output, where no marker
 * exists. Cutting at whichever markers ARE present is what removes the echoed
 * wrapper line before the command and the redrawn shell prompt after it.
 */
function trimToCommandWindow(raw: string, nonce: string, command?: string): string {
  const lines = toLines(raw);
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? '').includes(startMarker(nonce))) start = i + 1;
  }
  let end = lines.length;
  let tail = '';
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.includes(endMarker(nonce))) {
      end = i;
      // Same partial-line case as `extractBetweenMarkers`: keep what the
      // command printed before the marker joined it.
      tail = line.slice(0, line.indexOf(endMarker(nonce)));
      break;
    }
  }
  const body = lines.slice(start, end).filter((line) => !isNoise(line));
  if (tail !== '') body.push(tail);
  return stripZshPartialMarker(trimBlankEdges(dropEchoedCommand(body, command))).join('\n');
}

type Completion =
  | { kind: 'done'; exitCode: number; end?: CommandEnd }
  | { kind: 'shell-exited'; status: number | null }
  | { kind: 'needs-input' }
  | { kind: 'lost' }
  | { kind: 'timeout' };

/** How long to allow for the start marker before concluding the keystrokes were lost. */
const MARKER_APPEAR_MS = 3000;

/** How often to check for pane death; less frequent than the .rc poll, as it costs a tmux call. */
const DEATH_CHECK_MS = 400;

/**
 * Wait for a command to reach any conclusion.
 *
 * Four routes out, because only one of them is "it finished normally":
 *  - `.rc` sentinel written        — the normal path
 *  - pane died                     — the command ended the shell (`exit`)
 *  - prompt detected               — it is waiting on a human, report NOW
 *  - start marker never appeared   — the keystrokes never became a command
 *
 * The prompt route is what turns a password prompt from a full-timeout stall
 * (two minutes at the default) into roughly two seconds.
 */
async function waitForCompletion(
  name: string,
  timeoutMs: number,
  pollMs: number,
  logFile: string,
  offset: number,
  nonce: string,
  outerCommand: string,
  baselineShells = 0,
): Promise<Completion> {
  const began = Date.now();
  const deadline = began + timeoutMs;
  let nextDeathCheck = began + DEATH_CHECK_MS;
  let nextPromptCheck = began + PROMPT_GRACE_MS;
  const markerDeadline = began + MARKER_APPEAR_MS;

  let sawMarker = false;
  let lastSize = -1;
  let lastChangeAt = began;

  for (;;) {
    const end = await findCommandEnd(logFile, nonce);
    if (end !== undefined) return { kind: 'done', exitCode: end.code, end };

    if (Date.now() >= nextDeathCheck) {
      nextDeathCheck = Date.now() + DEATH_CHECK_MS;
      const snapshot = await paneStatus(name).catch(() => ({
        dead: false,
        status: null,
        command: '',
        width: 0,
      }));
      const { dead, status } = snapshot;
      if (dead) {
        // The marker may have been emitted microseconds before the shell died.
        const late = await findExitCode(logFile, nonce);
        if (late !== undefined) return { kind: 'done', exitCode: late };
        return { kind: 'shell-exited', status };
      }

      // A NESTED shell exiting leaves the pane very much alive — `exit` inside
      // an ssh session just drops you back to the local shell — so pane death
      // never fires and the marker never arrives. Without this the caller
      // waits out its entire timeout on a command that ended immediately.
      if (sawMarker && isNesting(outerCommand) && isShell(snapshot.command)) {
        return { kind: 'shell-exited', status: null };
      }

      // The same thing one level down: `exit` inside a plain sub-shell. The
      // foreground command is a shell before and after, so the check above
      // cannot see it — but the number of shells on the tty drops, which a
      // silently-working shell never does.
      if (sawMarker && baselineShells > 0) {
        const now = await shellDepth(name).catch(() => baselineShells);
        if (now > 0 && now < baselineShells) return { kind: 'shell-exited', status: null };
      }
    }

    // Track whether output is still moving; a prompt is where it stops.
    const size = await fileSize(logFile);
    if (size !== lastSize) {
      lastSize = size;
      lastChangeAt = Date.now();
    }

    if (!sawMarker) {
      if ((await readLogFrom(logFile, offset)).includes(startMarker(nonce))) {
        sawMarker = true;
      } else if (Date.now() >= markerDeadline) {
        // The command never started — the classic symptom of input landing on
        // a line that already had text on it. Fail fast instead of stalling.
        return { kind: 'lost' };
      }
    }

    if (Date.now() >= nextPromptCheck && Date.now() - lastChangeAt >= PROMPT_STALL_MS) {
      nextPromptCheck = Date.now() + PROMPT_CHECK_MS;
      const snapshot = await paneStatus(name).catch(() => null);
      if (snapshot && !snapshot.dead) {
        const tail = await capturePane(name).catch(() => '');
        // Deliberately stricter than the watcher's rule. Aborting a command to
        // report "needs input" is destructive if wrong: the agent stops and
        // tells the user something false about a command that was working.
        // Requiring a foreground process that plausibly prompts — a known
        // interactive tool, or a shell running a `read` builtin — rejects the
        // common false positive of a working command (`echo "continue?";
        // sleep 4`) whose last line merely looks like a question.
        //
        // The cost is a prompt from an unknown non-shell tool is not caught
        // here; that surfaces at the timeout instead, and the watcher still
        // flags it in the GUI on the looser rule, where a wrong amber row is
        // cheap and the human can see the pane.
        const plausible = couldBePrompting(snapshot.command);
        if (tail && plausible && looksLikePrompt(tail, snapshot.width)) {
          return { kind: 'needs-input' };
        }
      }
    }

    if (Date.now() >= deadline) return { kind: 'timeout' };
    await sleep(pollMs);
  }
}

/**
 * Run a command in a session and wait for it to finish.
 *
 * Returns rather than throws when the command does not complete: a prompt is a
 * handoff to the human, not a failure. Callers should check `needsInput`
 * before treating a result as an error.
 */
export async function run(
  name: string,
  command: string,
  options: RunOptions = {},
): Promise<RunResult> {
  await ensureLayout();
  const clean = validateName(name);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  return withSessionLock(
    clean,
    command,
    () => runLocked(clean, command, timeoutMs, pollMs, options),
    { wait: options.waitForIdle, timeoutMs },
  );
}

async function runLocked(
  clean: string,
  command: string,
  timeoutMs: number,
  pollMs: number,
  options: RunOptions,
): Promise<RunResult> {
  let session = await get(clean); // throws SessionGone if killed

  if (session.paneDead) {
    await respawn(clean, session.cwd);
    session = await get(clean);
  }

  // A session held at a PROMPT is not "busy", and must not be described as it.
  //
  // Both cases used to raise the same SessionBusy: `already running "zsh" …
  // queue behind it with --wait`. Every part of that misleads at a password
  // prompt. It is not running zsh, it is stopped waiting for a person; and
  // --wait, the one remedy offered, blocks until its timeout because nothing
  // will move until a human types — while nobody has told the human. An agent
  // that follows the advice burns its timeout and reports the session as stuck.
  if (session.state === 'needs-input') {
    throw new AthError(
      'needs_human',
      `Session "${clean}" is stopped at a prompt that only a person can answer, so ` +
        `nothing was sent. Do NOT queue behind it with --wait: nothing will run until ` +
        `it is answered. Tell the user, then let them answer it with ` +
        `"ath attach ${clean}" — or interrupt it with "ath send ${clean} -- C-c". ` +
        `See what it is asking with "ath read ${clean}".`,
    );
  }
  // The lock stops other ath callers; this catches a command started with
  // `start()` or typed directly by the human, neither of which holds it.
  //
  // Judged by `state` alone, knowingly. `state` cannot tell a shell at its
  // prompt from a shell SCRIPT running as `bash` (see `lastCommandSettled`),
  // so this does wave through a command that then sits in the tty buffer as
  // type-ahead until the script finishes. Corroborating with the exit marker
  // was tried and reverted: a command whose shell died mid-frame — a killed
  // pane, a nested `exit` — never writes an end marker, so the dangling start
  // marker is permanent and every later `run` throws `session_busy` on a
  // perfectly usable session. The suite caught it as five wedged sessions.
  //
  // A veto needs a signal that clears itself. The marker only settles the
  // question for a caller holding the HANDLE, which `run` never does for
  // someone else's command; `wait` and `poll`, which can be handed one, use it.
  if (session.state === 'busy') {
    if (!options.waitForIdle) {
      throw new SessionBusy(clean, busyDetail(session));
    }
    const idleDeadline = Date.now() + timeoutMs;
    while (Date.now() < idleDeadline) {
      await sleep(200);
      session = await get(clean);
      if (session.state === 'idle') break;
    }
    if (session.state !== 'idle') {
      throw new SessionBusy(clean, busyDetail(session));
    }
  }

  // Same guard as `start()`: a prompt the classifier has not caught up with
  // still reads as `busy`, and the state check above lets the command through
  // to be typed into it. Refusing costs a caller one clear error; the
  // alternative spends the human's password prompt on a failed login attempt
  // made of the command text.
  await assertNotCredentialPrompt(clean);

  // A remote session whose ssh has died falls back to the LOCAL shell while
  // still being labelled remote everywhere. Running here would execute a
  // command meant for another machine on this one, silently and successfully.
  // Reconnect first, and refuse rather than run if that does not work.
  let reconnected = false;
  if (session.remote && !isNesting(session.currentCommand)) {
    await ensureControlDir();
    // Reconnect the SAME way the session was created: the hooks ride the ssh
    // command line and install themselves before the first prompt.
    //
    // This used to send a plain ssh line and then type the wrapper, a probe and
    // ~400 characters of hooks into the pane — so a dropped link left a wall of
    // shell in the shared console, the very noise the launch-time path exists
    // to avoid. Creation was clean and reconnect was not, which is the worst
    // arrangement: the mess appears exactly when something has already gone
    // wrong and the human is most likely to be looking.
    const readyToken = randomNonce();
    const bootFile = `${RC_DIR}/${clean}.boot`;
    await sendLine(
      clean,
      sshLaunchLine(
        session.remote,
        `PROMPT_COMMAND=; unset ATH_B; ${HELPER_ONELINE}; export -f __ath 2>/dev/null; ${frameHooksFor('bash', readyToken)}`,
        bootFile,
      ),
    );
    const reconnectDeadline = Date.now() + 20_000;
    for (;;) {
      await sleep(300);
      session = await get(clean);
      // Both conditions matter: `ssh` appears the instant the process starts,
      // long before the remote shell is at a prompt. Sending then puts the
      // command into the handshake, where it is simply swallowed.
      if (isNesting(session.currentCommand) && session.state === 'idle') {
        reconnected = true;
        // Did the hooks take on their own? If so nothing needs typing at all.
        const raw = await fs.readFile(logPath(clean), 'utf8').catch(() => '');
        const hooksReady = new RegExp(`<ATHR:${readyToken}:ok>`).test(raw.slice(-8192));
        await restoreRemoteState(clean, session, hooksReady);
        break;
      }
      if (session.state === 'needs-input') {
        return {
          session: clean,
          command,
          exitCode: null,
          // Just the question, not the screen. A raw capture here returned the
          // whole scrollback — old commands, the injected helper, previous
          // attempts — which is pure noise in a caller's context when the only
          // useful fact is what is being asked.
          output: await promptExcerpt(clean),
          timedOut: false,
          needsInput: true,
          state: 'needs-input',
          logOffset: await logicalEnd(clean),
          reconnecting: true,
        };
      }
      if (Date.now() >= reconnectDeadline) {
        throw new AthError(
          'remote_disconnected',
          `Session "${clean}" is a remote session on "${session.remote}", but the ssh ` +
            `connection has dropped and could not be re-established. Nothing was run — ` +
            `a command meant for "${session.remote}" must not execute locally. ` +
            `Check it with "ath attach ${clean}".`,
        );
      }
    }
  }

  // Safe here and nowhere else: we hold the lock, so no offset is in flight.
  await rotateIfNeeded(clean).catch(() => undefined);

  const log = logPath(clean);
  let nonce = randomNonce();
  let offset = await fileSize(log);
  // Physical, because everything below reads the file with it. What is
  // RETURNED gets `discarded` added, so callers only ever see logical offsets.
  // Stable for this call: the lock is held and the trim above already ran.
  const discarded = await discardedBytes(clean);

  const outerCommand = session.currentCommand;
  // Only measured when the pane is already sitting in a shell — the only case
  // where a nested exit is invisible to every other signal.
  const baselineShells = isShell(outerCommand) ? await shellDepth(clean).catch(() => 0) : 0;

  // Two lines: the tag naming whose command this is, then the command itself,
  // bare. The shell echoes what we type and that echo can be neither restyled
  // nor erased, so the command line is left completely clean and the
  // attribution goes on a line of its own.
  // Only send the command bare when this shell is KNOWN to have the hooks.
  //
  // Without them the tag line is "command not found" and the bare command runs
  // anyway, producing no markers — so `run` concludes it was lost and sends it
  // AGAIN. That is double execution with side effects. The wrapper form fails
  // safely instead: `__ath` being undefined means nothing runs at all.
  const bare = commandLine(nonce, command);
  const framed = bare !== undefined && (await hooksActive(clean, session));
  let usedFraming = false;
  let enteredUnknownShell = false;
  if (framed) {
    await sendLine(clean, agentTagLine(nonce));

    // WAIT for the tag to acknowledge before sending the bare command.
    //
    // This is a correctness gate, not an optimisation. If the tag function is
    // absent the tag line is "command not found" — and the bare command that
    // follows RUNS anyway, emits no markers, and looks lost, so `run` sends it
    // a second time. That is double execution of an arbitrary command, and it
    // happened on a live host: `echo` twice is harmless, a deploy script twice
    // is not. Locally the shell-name check catches a nested shell; over ssh
    // `pane_current_command` is `ssh` throughout, so nothing caught it.
    //
    // The tag now answers through the PTY. No answer, nothing was typed that
    // could run, and the wrapper — which fails safely when absent — takes over.
    usedFraming = await awaitTagAck(clean, nonce, 1500);
    if (usedFraming) {
      // The line is empty: we just pressed Enter on the tag ourselves. Clearing
      // it again sends C-e/C-u to a shell that may still be starting, which
      // echoes them as a literal `^E^U` into the shared console.
      await sendLine(clean, bare as string, { clearLine: false });
    } else {
      await setMeta(clean, 'frame', '').catch(() => undefined);
      // The wrapper flag describes a SHELL, not a session, so it is stale the
      // instant we learn we are in a different one. Left set, the next command
      // trusted it, sent `__ath …` to a shell that had never seen it, and put
      // "__ath: not found" in the human's console before self-healing.
      await setMeta(clean, 'wrap', '').catch(() => undefined);
      enteredUnknownShell = true;
    }
  }
  if (!usedFraming) {
    // Install the wrapper BEFORE the first command that needs it.
    //
    // Sending `__ath …` to a shell that has never seen it prints
    // "__ath: command not found" in the human's console, and only then does the
    // self-heal run. The error was described in the code as expected; expected
    // is not the same as acceptable when a red line lands in a shared terminal.
    if (!(await wrapperReady(clean))) {
      await installHelper(clean, session.remote);
      await setMeta(clean, 'wrap', '1').catch(() => undefined);
    }
    await sendLine(clean, `__ath ${nonce} ${await deliverCommand(clean, command)}`);
  }
  // Record the command AT DISPATCH, with no exit code.
  //
  // `run` recorded only on completion, so a command that PARKED at a prompt
  // was never recorded at all — and `ath ls` went on showing the previous
  // command beside the previous exit code. An agent watching a session parked
  // on `sudo -v` was shown `last_command: "sudo -n true", last_exit_code: 1`:
  // true of a command that had already finished, and read together, the exact
  // opposite of what was happening. It called that "quietly wrong data, which
  // is worse than an error, because there is nothing to prompt a second look".
  //
  // An empty `last_rc` already means "still running" everywhere else — it is
  // how `busyDetail` tells an in-flight command from a finished one, and how
  // `start` has always behaved. `run` simply never took part.
  await recordLast(clean, command, null);
  let completion = await waitForCompletion(
    clean, timeoutMs, pollMs, log, offset, nonce, outerCommand, baselineShells,
  );

  // The helper is missing whenever the pane holds a shell we did not set up:
  // the far side of an ssh hop, a `docker exec`, a `sudo -i`, a manually
  // started sub-shell. Rather than fail, install it and try once more — which
  // is what makes driving a remote host work at all, without special-casing
  // ssh anywhere in the protocol.
  if (completion.kind === 'lost') {
    // Install the HOOKS into a shell we did not set up, not just the wrapper.
    //
    // This used to be wrapper-only, because bash's DEBUG trap fired inside
    // subshells where the state it set was lost — `(exit 9)` reported 0. That
    // trap is gone: bash frames from PROMPT_COMMAND alone now, which sees a
    // compound command like any other. The restriction outlived its reason.
    //
    // It matters beyond tidiness. A nested shell with no hooks has no prompt
    // depth marker, so a human cannot see that `exit` drops them a level
    // rather than ending the session — and on a zsh host nothing is inherited,
    // because zsh cannot export functions. Installing on demand is the only
    // way that shell ever gets them.
    await installHelper(clean, session.remote);
    await setMeta(clean, 'wrap', '1').catch(() => undefined);
    // Give up on framing ONLY if the install could not provide it.
    //
    // `installHelper` records the shell it hooked, so a successful install has
    // already set `frame` — clearing it unconditionally threw that away and sent
    // every later command through the wrapper regardless. The hooks were being
    // installed and then immediately disowned, which is why a nested shell had
    // no prompt depth marker even though the install had run.
    //
    // When the shell genuinely cannot be hooked (dash, busybox, anything with
    // no prompt hook) `frame` is still empty and clearing is right: over ssh
    // `pane_current_command` is `ssh` from connect to disconnect, so a nested
    // shell is invisible to the check that catches this locally, and something
    // has to stop the tag lines.
    const hooked = await get(clean)
      .then((x) => !!x.frameShell)
      .catch(() => false);
    if (!hooked) {
      await setMeta(clean, 'frame', '').catch(() => undefined);
    }
    nonce = randomNonce();
    offset = await fileSize(log);
    await sendLine(clean, `__ath ${nonce} ${await deliverCommand(clean, command)}`);
    completion = await waitForCompletion(
      clean, timeoutMs, pollMs, log, offset, nonce, outerCommand, baselineShells,
    );
  }

  const partial = async (): Promise<string> =>
    extractBetweenMarkers(await readLogFrom(log, offset), nonce, command);

  if (completion.kind === 'lost') {
    throw new AthError(
      'command_lost',
      `The command never reached the shell in "${clean}", even after reinstalling the ` +
        `helper. The pane may have text already typed on its command line, or be showing ` +
        `something that is not a shell. Check it with "ath read ${clean}".`,
    );
  }

  if (completion.kind === 'shell-exited') {
    await recordLast(clean, command, completion.status);
    return {
      session: clean,
      command,
      exitCode: completion.status,
      output: await partial(),
      timedOut: false,
      needsInput: false,
      state: 'dead',
      logOffset: discarded + offset,
      shellExited: true,
    };
  }

  if (completion.kind === 'needs-input' || completion.kind === 'timeout') {
    let state: RunResult['state'] = completion.kind === 'needs-input' ? 'needs-input' : 'busy';
    if (completion.kind === 'timeout') {
      state = await get(clean)
        .then((s) => s.state)
        .catch(() => {
          throw new SessionGone(clean);
        });
    }
    // A command PARKED on a prompt is the main reason this hub exists, so file
    // the request here too — not only on the non-interactive refusal.
    //
    // This path returns early, so the detection at the end of `run` never saw
    // it: the loudest case, a command sitting at a live password prompt, was
    // the one that raised nothing. The handle goes with it, so whoever picks
    // this up can collect the OUTCOME instead of re-running the command and
    // asking the human a second time.
    let parkedAsk: string | undefined;
    if (state === 'needs-input') {
      parkedAsk =
        `${quoteForMessage(command)} is waiting at a prompt in "${clean}". ` +
        `Attach with "ath attach ${clean}" and answer it.`;
      await requestHuman(clean, parkedAsk, 'agent', nonce, true).catch(() => undefined);
    }

    return {
      session: clean,
      command,
      exitCode: null,
      output: await partial(),
      timedOut: completion.kind === 'timeout',
      needsInput: state === 'needs-input',
      state,
      logOffset: discarded + offset,
      handle: nonce,
      ...(parkedAsk ? { needsHuman: parkedAsk } : {}),
    };
  }

  // The marker that carried the exit code is already in the log by definition,
  // but the output BEFORE it may still be in flight through pipe-pane.
  const flushDeadline = Date.now() + MARKER_FLUSH_MS;
  let raw = await readLogFrom(log, offset);
  while (!raw.includes(endMarker(nonce)) && Date.now() < flushDeadline) {
    await sleep(40);
    raw = await readLogFrom(log, offset);
  }

  const exitCode = completion.exitCode;
  await recordLast(clean, command, exitCode);
  // Remember where the remote shell now is, and what it now exports. Recorded
  // on every command because once the link drops there is nothing left to ask,
  // and a reconnect that lands in the wrong directory runs the next command in
  // the wrong place while reporting success.
  if (session.remote) await recordRemoteState(clean, completion.end, command, session);

  // Framing recovers on its own.
  //
  // Turning it off is easy and correct — a shell that cannot host hooks must
  // not be sent bare commands. Turning it back ON never happened: `exit` from
  // that shell returned to one with hooks, and the hub kept using the wrapper
  // forever. The wrapper itself now reports what it found, so recovery costs
  // nothing and needs no one to remember.
  if (completion.end?.hooks === true) {
    const now = await get(clean).catch(() => undefined);
    if (now && !now.frameShell) {
      await setMeta(clean, 'frame', now.currentCommand).catch(() => undefined);
    }
  }

  // "Finished, exit 0" and "busy" must not co-occur.
  //
  // The state is classified from the pane, and the pane can still be mid-redraw
  // in the instant after a command ends — so a completed command came back as
  // `exit_code: 0, state: "busy"`. An agent read that, could not explain it, and
  // reasonably expected the next dispatch to be refused with session_busy.
  //
  // We hold the lock, so nothing of ours can be running. Look once more after a
  // short settle rather than asserting idle outright: the human CAN have typed
  // something into the shared pane, and inventing "idle" over that would be its
  // own lie.
  const classifyNow = async (): Promise<{ state: RunResult['state']; pane: string }> => {
    const pane = await capturePane(clean).catch(() => '');
    const now = await get(clean).catch(() => null);
    return {
      state: classify({
        paneDead: false,
        currentCommand: now?.currentCommand ?? 'zsh',
        paneTail: pane,
        paneWidth: now?.paneWidth ?? 0,
      }),
      pane,
    };
  };
  let { state, pane: paneTail } = await classifyNow();
  if (state === 'busy') {
    await sleep(PROMPT_CHECK_MS);
    ({ state, pane: paneTail } = await classifyNow());
  }

  const output = extractBetweenMarkers(raw, nonce, command);
  const needsHuman = await raiseHumanWall(clean, command, output, nonce);
  // The pane can be resized by a human attaching — most often to answer the
  // very password prompt this command raised. Checked here, once per command,
  // so the change surfaces on the first result after it happens.
  const widthChange = await noteWidthChange(
    clean,
    (await get(clean).catch(() => undefined))?.paneWidth,
  ).catch(() => undefined);

  return {
    session: clean,
    command,
    exitCode,
    output,
    ...(needsHuman ? { needsHuman } : {}),
    // Only when no wall fired: if one did, the request exists and the warning
    // would be noise. The dangerous case is the SILENT one.
    // The credential blind-spot only matters when the command FAILED.
    //
    // `sudo -n true` that exits 0 proves the timestamp is cached: nothing was
    // hidden, because there was nothing to hide. Warning anyway told an agent
    // its deliberate, successful cache-check "may mean the command never ran"
    // — while it was looking at the SUDO_CACHED=yes the command had printed.
    // The traversal warning gets no such reprieve: `du` exits 0 while
    // under-reporting, which is the entire hazard.
    ...(!needsHuman &&
    ((exitCode !== 0 ? credentialBlindSpot(command) : undefined) ?? traversalBlindSpot(command))
      ? {
          warning:
            (exitCode !== 0 ? credentialBlindSpot(command) : undefined) ??
            traversalBlindSpot(command),
        }
      : {}),
    // Marked only when the number can actually MISLEAD, explained once.
    //
    // It used to mark every compound line. An agent that batches probes with
    // `;` — the natural shape for a survey, and the one this tool's
    // one-command-per-session rhythm pushes you toward — saw it on nearly
    // every call and reported that it "stopped carrying information... visual
    // noise by the fourth call". A signal that never varies is not a signal.
    //
    // It only misleads on exit 0: that is the case where an earlier failure is
    // hidden behind a later success. A NON-ZERO code has already told the
    // reader to go look, so the marker adds nothing there.
    ...(compoundExitCaveat(command) &&
    // `;`-joined: only exit 0 can mislead — a non-zero code already sends the
    // reader to the output. A PIPELINE is different and stays marked either
    // way: its code is the last stage's, so a non-zero tells you that stage
    // failed and still says nothing about the ones before it. Filtering both
    // the same way would have silently dropped the harder case.
    (compoundExitCaveat(command) === 'last-pipeline-stage-only' || exitCode === 0)
      ? {
          exitCaveat: compoundExitCaveat(command),
          ...((await firstCaveatFor(clean))
            ? {
                exitCaveatNote:
                  'The exit code above is the status of only the last part of this line — an ' +
                  'earlier failure can be hidden by a later success, and a pipeline reports its ' +
                  'last stage. Read the output rather than trusting the number. ' +
                  // NOT a prescription to use `&&`.
                  //
                  // That was the previous wording, and the next agent rebutted
                  // it precisely: `&&` "is often wrong for exploration, where I
                  // want later parts to run when an earlier one fails" — which
                  // is exactly what happened when its `ufw status` failed and
                  // the following `iptables -S` held the answer it needed.
                  //
                  // `;` is the RIGHT choice there, and a meaningless exit code
                  // is a trade the caller accepted, not a mistake to correct.
                  // So both options are stated as options.
                  (compoundExitCaveat(command) === 'last-command-only'
                    ? 'If you need the code to mean something, join with `&&` — the line then ' +
                      'stops at the first failure and reports it. If you are exploring and want ' +
                      'every part to run regardless, `;` is right and reading the output is the ' +
                      'correct way to check it. '
                    : 'For a pipeline, `set -o pipefail` makes the exit code reflect any failing ' +
                      'stage rather than only the last. ') +
                  '(Shown once per session; the short marker stays on every affected command.)',
              }
            : {}),
        }
      : {}),
    timedOut: false,
    needsInput: state === 'needs-input',
    state,
    ...(widthChange ? { paneWidthChanged: widthChange } : {}),
    logOffset: discarded + offset,
    // Surfaced even on success. The directory and environment are restored,
    // but a reconnect still means the remote shell is a NEW process: anything
    // not captured in exported state — a background job, a shell function, an
    // unexported variable — did not survive, and a caller silently assuming
    // otherwise is exactly the failure this flag exists to prevent.
    ...(reconnected ? { reconnecting: true } : {}),
    ...(enteredUnknownShell ? { fallbackShell: true } : {}),
  };
}

/**
 * Put a freshly reconnected remote shell back where the old one was.
 *
 * Without this a dropped link silently reset the session to $HOME with its
 * exports gone, while the next command still returned exit 0 — so a command
 * written for one directory ran in another and reported success. That is the
 * same class of fault as running a remote command locally, and is guarded for
 * the same reason.
 *
 * Best effort by design: failing to restore must never block the reconnect,
 * because refusing to run is worse than running in $HOME with `reconnecting`
 * set. The flag is what keeps the caller honest either way.
 */
async function restoreRemoteState(
  name: string,
  session: Session,
  hooksReady = false,
): Promise<void> {
  if (session.remoteCwd) {
    await sendLine(name, `cd ${shellQuote(session.remoteCwd)} 2>/dev/null || true`).catch(
      () => undefined,
    );
    await sleep(120);
  }

  // Put back the exports this session made. Only assignments are replayed, so
  // nothing else the original commands did can happen twice.
  const assignments = (session.remoteEnv ?? '').split('\n').filter(Boolean);
  if (assignments.length > 0) {
    await sendLine(name, assignments.join('; ')).catch(() => undefined);
    await sleep(120);
  }

  // Re-arm the helper only if the shell did NOT come up integrated. When the
  // launch-time hooks took, typing anything here would just be noise.
  if (hooksReady) {
    await setMeta(name, 'frame', session.currentCommand).catch(() => undefined);
    return;
  }
  await installHelper(name, session.remote);
}

/**
 * The last few meaningful lines of a pane — enough to show what is being
 * asked, and no more. Used when handing a prompt back to a caller.
 */
async function promptExcerpt(name: string, lines = 4): Promise<string> {
  const tail = await capturePane(name, 12).catch(() => '');
  const meaningful = tail
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '' && !isNoise(line));
  return meaningful.slice(-lines).join('\n');
}

/**
 * Persist the remote shell's working directory and exported environment.
 *
 * Held as tmux user options rather than a file so it shares the session's
 * lifetime exactly: killed with the session, and never stale for a session
 * that no longer exists.
 */
async function recordRemoteState(
  name: string,
  end: CommandEnd | undefined,
  command?: string,
  session?: Session,
): Promise<void> {
  if (!end) return;
  if (end.cwd)
    await setMeta(name, 'rcwd', Buffer.from(end.cwd, 'utf8').toString('base64')).catch(
      () => undefined,
    );

  // A human's assignment arrives through the marker; the agent's comes from
  // the command it just sent. Both deserve to survive a reconnect.
  // Harvest the HUMAN's assignments too.
  //
  // `end` belongs to the command the AGENT just ran, so an assignment typed
  // straight into the terminal never passed through here — it rides its own
  // `h` frame, which nothing was reading. Scanning the recent log for those
  // is what makes "the human typed export FOO=bar" survive a reconnect.
  const humanEnv: string[] = [];
  const tail = await readLogTailBytes(logPath(name), MARKER_SCAN_BYTES).catch(() => '');
  for (const m of tail.matchAll(/<ATHE:h\d+:-?\d+:[A-Za-z0-9+/=]*:([A-Za-z0-9+/=]+)>/g)) {
    const decoded = decodeB64(m[1]);
    if (decoded) humanEnv.push(...envAssignments(decoded));
  }
  const added = [
    ...envAssignments(command ?? ''),
    ...envAssignments(end.env ?? ''),
    ...humanEnv,
  ];
  if (added.length === 0) return;
  const merged = mergeAssignments(session?.remoteEnv ?? '', added);
  await setMeta(name, 'renv', Buffer.from(merged, 'utf8').toString('base64')).catch(
    () => undefined,
  );
}

/**
 * The environment assignments in a command, and nothing else.
 *
 * A dropped link takes the remote shell and its exports with it, so a reconnect
 * has to put them back — but replaying the whole command would re-run whatever
 * else it contained. `rm -rf build; export TAG=v2` must not delete anything a
 * second time. So only the assignment fragments are kept, split on the
 * separators that end a statement, and each must match an assignment from its
 * first character: an `export` buried inside a longer word or a quoted string
 * never starts a fragment.
 */
/**
 * A fragment that is an assignment AND NOTHING ELSE.
 *
 * Anchoring only the start is not enough, and the difference is a command
 * execution bug: `FOO=bar make` begins with an assignment, but it is really a
 * one-shot environment prefix to `make`. Stored and replayed on reconnect it
 * would run the build a second time — the exact "nothing happens twice" promise
 * that keeping assignments-only was supposed to deliver.
 *
 * So the value must be a single word. Quoted spans are removed before the test
 * so `MSG="hello world"` still qualifies, while any whitespace surviving that
 * means another word follows and the fragment is discarded.
 */
function isPureAssignment(fragment: string): boolean {
  const body = fragment.replace(/^export\s+/, '');
  const eq = body.indexOf('=');
  if (eq <= 0) return false;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(body.slice(0, eq))) return false;
  const value = body
    .slice(eq + 1)
    .replace(/'[^']*'/g, '')
    .replace(/"(?:[^"\\]|\\.)*"/g, '');
  return !/\s/.test(value);
}

/**
 * Kept VERBATIM, `export` and all.
 *
 * Adding a missing `export` would change what the shell did: `PLAIN=x` sets a
 * shell variable that child processes cannot see, and restoring it as an
 * exported one hands it to every command that follows. Restoring state means
 * restoring it as it was, not as a tidier version of it.
 */
export function envAssignments(command: string): string[] {
  if (!command) return [];
  // Split on separators that are NOT inside quotes.
  //
  // Splitting the raw text made every `;` a boundary, including the ones
  // inside a quoted program. `ss -tlnp | awk '{a=$4; p=""; print}'` therefore
  // yielded the fragment `p=""`, which is a perfectly good assignment in
  // isolation — so the hub stored `p` as a session variable and would have
  // replayed it on reconnect. An agent found exactly that in its `remote_env`
  // and said, correctly, that it makes the restore guarantee weaker than the
  // documentation claims.
  //
  // This is the SAME bug already fixed on the shell side, where an unanchored
  // glob matched an `=` anywhere in the line. It was fixed there and left
  // here, in the other language, doing the same thing to the same input.
  //
  // Quoted spans are blanked to equal-length filler before splitting, so
  // offsets are preserved and the split lands only on real separators. The
  // technique is lifted from `compoundExitCaveat`, one function away, which
  // has been doing it correctly the whole time.
  const masked = command
    .replace(/'[^']*'/g, (m) => "'".padEnd(m.length, ' '))
    .replace(/"[^"]*"/g, (m) => '"'.padEnd(m.length, ' '));
  const out: string[] = [];
  let start = 0;
  const boundary = /[;\n]|&&/g;
  for (let m = boundary.exec(masked); m !== null; m = boundary.exec(masked)) {
    out.push(command.slice(start, m.index));
    start = m.index + m[0].length;
  }
  out.push(command.slice(start));
  return out.map((part) => part.trim()).filter(isPureAssignment);
}

/** Variable name an assignment fragment sets, for last-one-wins merging. */
function assignedName(fragment: string): string {
  return fragment.replace(/^export\s+/, '').split('=')[0] ?? '';
}

/**
 * Merge new assignments over the stored ones, last write winning per variable.
 *
 * Without this, `export TAG=v1` then `export TAG=v2` would restore BOTH in
 * order — harmless here, but the list grows without bound across a long
 * session and eventually cannot be typed as one line. Capped for the same
 * reason: a session that sets thousands of variables restores the most recent
 * ones rather than failing to restore anything.
 */
const MAX_RESTORED_ASSIGNMENTS = 64;

function mergeAssignments(stored: string, added: string[]): string {
  const byName = new Map<string, string>();
  for (const fragment of [...stored.split('\n').filter(Boolean), ...added]) {
    const key = assignedName(fragment);
    if (key) byName.set(key, fragment);
  }
  return [...byName.values()].slice(-MAX_RESTORED_ASSIGNMENTS).join('\n');
}

/**
 * Name the command that is holding a busy session.
 *
 * `currentCommand` is the pane's foreground PROCESS. On a remote session that
 * is `ssh` — the transport, never the work — so a 70-second checksum job was
 * reported as `Session "box" is already running "ssh"`, which names nothing
 * the caller can act on and reads like a bug in the session rather than a busy
 * one.
 *
 * The command the hub launched is recorded on the session, and an absent exit
 * code is what marks it still in flight. Only then does it describe what is
 * running now: after it finishes the field lingers, and reporting a finished
 * command as the blocker would be its own kind of lie — so fall back to the
 * process name, which is at least true.
 */
function busyDetail(session: Session): string {
  const inFlight = session.lastExitCode === undefined && session.lastCommand?.trim();
  if (inFlight) {
    const cmd = session.lastCommand as string;
    return `"${cmd.length > 70 ? `${cmd.slice(0, 67)}…` : cmd}"`;
  }
  return `"${session.currentCommand || 'something'}"`;
}

/**
 * Notice that the pane was resized between two commands.
 *
 * `window-size latest` means a human attaching sets the size — which is
 * correct for a shared terminal, and is exactly what happens when they attach
 * to answer a password prompt. The consequence is that output shape can change
 * in the middle of a survey, and until now nothing said so at the time: the
 * width was visible in `list` if you thought to look, documented if you had
 * read that far, and announced never.
 *
 * Comparing against the last value costs one string read, so the only silent
 * corruption path in the tool now announces itself on the first command after
 * it happens.
 */
async function noteWidthChange(
  name: string,
  now: number | undefined,
): Promise<{ from: number; to: number } | undefined> {
  if (!now || now <= 0) return undefined;
  const previous = Number(await readMeta(name, 'pw').catch(() => '')) || 0;
  await setMeta(name, 'pw', String(now)).catch(() => undefined);
  // A first command has nothing to compare against, and is not a change.
  if (!previous || previous === now) return undefined;
  return { from: previous, to: now };
}

async function recordLast(name: string, command: string, code: number | null): Promise<void> {
  await setMeta(name, 'last_cmd', command.slice(0, 200)).catch(() => undefined);
  await setMeta(name, 'last_rc', code === null ? '' : String(code)).catch(() => undefined);
}

/**
 * Send a command and return immediately with a handle.
 *
 * The first-class path for anything long-lived — a dev server, a big build, a
 * migration — where blocking is the wrong shape and `send` gives no completion
 * signal or exit code. The handle is the same nonce the blocking path uses, so
 * this reuses the `.rc` machinery exactly.
 *
 * The lock is held only across the send: once the command is running it is the
 * session's `busy` state, not the lock, that keeps other callers out.
 */
export async function start(name: string, command: string): Promise<StartResult> {
  await ensureLayout();
  const clean = validateName(name);

  return withSessionLock(clean, command, async () => {
    let session = await get(clean);
    if (session.paneDead) {
      await respawn(clean, session.cwd);
      session = await get(clean);
    }
    // Same distinction as `run`: a prompt is not a busy command, and telling a
    // caller to wait it out is the one piece of advice that cannot work.
    if (session.state === 'needs-input') {
      throw new AthError(
        'needs_human',
        `Session "${clean}" is stopped at a prompt that only a person can answer, so ` +
          `nothing was started. Tell the user, then let them answer it with ` +
          `"ath attach ${clean}" — or interrupt it with "ath send ${clean} -- C-c".`,
      );
    }
    if (session.state === 'busy') {
      throw new SessionBusy(clean, busyDetail(session));
    }

    // Never type a command into a live password prompt.
    //
    // `state === 'needs-input'` above catches the case the hub has already
    // classified, but classification lags the pane: a prompt that appeared
    // between the last poll and now still reads as `busy`, and the command was
    // typed straight into it. Whatever is typed then becomes a login attempt —
    // the command text goes into the auth log as a failed password, the prompt
    // is consumed, and the human walking over to answer finds it gone. That is
    // exactly what a cold agent hit: its `sudo -v` prompt was "dismissed before
    // you could type".
    await assertNotCredentialPrompt(clean);

    await rotateIfNeeded(clean).catch(() => undefined);

    const nonce = randomNonce();
    // Logical, so `poll --since <this>` still resolves after a trim — a long
    // job is exactly the one that trims its own log out from under its handle.
    const offset = await logicalEnd(clean);
    await markStarted(nonce, offset);

    // Show the HUMAN the command, not the plumbing.
    //
    // `start` always used the `__ath <nonce> '<cmd>'` wrapper, even for a
    // one-line command in a fully hooked shell where `run` would have sent the
    // bare line. So the shared pane displayed
    //
    //     dev@server:~$ __ath 6cead31129ac 'sudo ss -tulpn'
    //     [sudo] password for dev:
    //
    // The whole premise of the handoff is that a person looks at the terminal
    // and decides whether to type their password into it. Showing them an
    // opaque wrapper at exactly that moment inverts it — the agent had to
    // describe the command in prose because the terminal would not.
    //
    // Same gate as `run`: bare only when the shell is KNOWN to be hooked, and
    // only after the tag acknowledges, because an unhooked shell would run the
    // bare command with no markers and look lost. The wrapper remains the safe
    // fallback, unchanged.
    const bare = commandLine(nonce, command);
    let framed = false;
    if (bare !== undefined && (await hooksActive(clean, session))) {
      await sendLine(clean, agentTagLine(nonce));
      framed = await awaitTagAck(clean, nonce, 1500);
      if (framed) await sendLine(clean, bare);
    }
    if (!framed) {
      await sendLine(clean, `__ath ${nonce} ${await deliverCommand(clean, command)}`);
    }
    await recordLast(clean, command, null);

    // Same hazards as `run`. See StartResult.warning: this path reported none,
    // so the one command shape most likely to be backgrounded — a long
    // filesystem walk with stderr thrown away — was also the one nothing
    // checked.
    const startWarning = credentialBlindSpot(command) ?? traversalBlindSpot(command);

    // Confirm the frame actually opened, because `start` could not fail.
    //
    // It sent the wrapper and returned a handle unconditionally — so a shell
    // with no `__ath` produced `__ath: command not found`, and the caller got
    // a handle, an offset and a cheerful note about polling that were
    // indistinguishable from success. The handle then belonged to a command
    // that had never run and could never finish, which is the same corpse
    // `poll` used to count upwards forever. A cold agent lost a job to this
    // and had to invent its own `type __ath` pre-check; the docs meanwhile
    // promised a `fallback_shell` signal that only `run` has ever set.
    //
    // The start marker is ground truth: the frame prints it BEFORE the command
    // runs, so it appears in milliseconds when things are working, whatever
    // the command goes on to do.
    const launched = await awaitStartMarker(clean, nonce, START_CONFIRM_MS);
    return {
      session: clean,
      command,
      handle: nonce,
      offset,
      // Reported, not thrown. The command may be sitting in the tty buffer
      // about to run — a session that merely LOOKS idle is exactly the case
      // `lastCommandEvidence` documents — and turning a delayed start into an
      // error would invite a retry that runs it twice. So the claim is
      // narrowed to what is actually known: this was not confirmed.
      // `launched` and `warning` stay separate: `warning` means "a hazard in
      // the command you wrote" everywhere it appears, and folding a delivery
      // failure into it would make one field mean two things. Each surface
      // renders its own guidance for this, in its own idiom.
      ...(launched ? {} : { launched: false }),
      ...(startWarning ? { warning: startWarning } : {}),
    };
  });
}

/**
 * File a request for any session sitting at a prompt nobody has noticed.
 *
 * Detection used to happen only inside `poll`, which an agent spotted as a hole
 * in the design rather than in the code: "if it only fires when I poll, a
 * backgrounded start that hits a password and is never polled would sit
 * silently forever — and the whole design assumes that can't happen." Exactly
 * right. `start` returns before the command runs, so nothing observes the
 * prompt until someone chooses to look.
 *
 * There is no daemon to fix this properly, but `list` is the call agents make
 * constantly — and the human's editor is watching the request directory — so
 * noticing here converts "never" into "as soon as anything looks at the hub".
 * A session at a prompt with no open request gets one, once.
 */
export async function notePrompts(): Promise<number> {
  const sessions = await list().catch(() => []);
  const open = await listRequests().catch(() => []);
  let filed = 0;
  for (const s of sessions) {
    if (s.state !== 'needs-input') continue;
    if (open.some((r) => r.session === s.name)) continue;
    const handle = await latestHandle(s.name).catch(() => undefined);
    await requestHuman(
      s.name,
      `"${(s.lastCommand ?? 'a command').slice(0, 80)}" is waiting at a prompt in "${s.name}". ` +
        `Attach with "ath attach ${s.name}" and answer it.`,
      'agent',
      handle,
      true,
    ).catch(() => undefined);
    filed += 1;
  }
  return filed;
}

/**
 * Clear requests whose command has since finished.
 *
 * Nothing resolved a request unless it was PARKED, so every non-parked one
 * lived forever. After a completed run an agent saw a queue where three of
 * four entries still read "blocked — needs you", including one it had filed
 * itself for a command that had succeeded, and `ath ls` kept flagging the
 * session `asked-for-you` while it sat idle and finished. A human glancing at
 * that owes three answers they have already given — which is the same false
 * "you still owe me something" this whole signal exists to stop.
 *
 * The command's own exit marker is the honest resolution signal: it is in the
 * log, it is per-handle, and it means the thing the request described is over
 * regardless of how it ended. Requests with no handle are left alone — there
 * is nothing to check them against, and guessing would clear a request the
 * human has not seen yet.
 */
export async function reapResolvedRequests(name?: string): Promise<number> {
  const open = await listRequests().catch(() => []);
  let cleared = 0;
  for (const r of open) {
    if (r.resolvedAt !== undefined || !r.handle) continue;
    if (name !== undefined && r.session !== name) continue;
    const code = await findExitCode(logPath(r.session), r.handle).catch(() => undefined);
    if (code !== undefined) {
      await clearRequest(r.id).catch(() => undefined);
      cleared += 1;
    }
  }
  return cleared;
}

/**
 * The handle of the most recent command framed in this session.
 *
 * `ath start` files no human request, so when a backgrounded command stops at a
 * credential prompt there is nothing carrying a handle, and a caller asking
 * "was it answered?" has no way to poll for the outcome. That gap is what let
 * `ath await` report a confident "nothing was answered" about a sudo that had
 * in fact succeeded.
 *
 * The log already knows: every framed command writes `<ATHS:nonce>` before it
 * runs, so the newest one names the command in flight and `poll` can take it
 * from there. Only SENTINEL-wrapped markers count — output that merely looks
 * like a marker (`echo "<ATHS:cafebabe>"`) is not plumbing, and the edge suite
 * asserts exactly that case.
 */
export async function latestHandle(name: string): Promise<string | undefined> {
  const clean = validateName(name);
  const log = logPath(clean);
  const size = await fileSize(log);
  const tail = await readLogFrom(log, Math.max(0, size - MARKER_SCAN_BYTES));
  // AGENT frames only — never a human's.
  //
  // `[A-Za-z0-9]+` also matched the `h<n>` frames the hooks open around
  // commands the HUMAN types, and one of those is open at every idle prompt by
  // construction: the shell draws a prompt, the frame opens, and it does not
  // close until the person runs something. So the moment a human answered a
  // password prompt, this returned THEIR open frame instead of the agent's
  // finished command.
  //
  // `await_human` then polled a handle that can never complete. The command it
  // was actually waiting on had exited 0 seconds earlier, and the agent sat
  // there reporting "still waiting" at a prompt the human had already answered
  // — the precise failure this function was written to prevent, arriving
  // through the other door. A handle is 12 hex characters; require that.
  const re = new RegExp(`${SENTINEL}<ATHS:([0-9a-f]{12})>`, 'g');
  let found: string | undefined;
  for (let m = re.exec(tail); m !== null; m = re.exec(tail)) found = m[1];
  return found;
}

/**
 * Whether the command framed by `handle` has finished.
 *
 * The exit marker, never the pane. Robust however much the command printed:
 * a finished command's marker is by definition the last thing it emitted, so
 * it is in the tail; a running command has not written one anywhere.
 */
export async function commandFinished(name: string, handle: string): Promise<boolean> {
  return (await commandOutcome(name, handle)).finished;
}

export interface CommandOutcome {
  finished: boolean;
  /** The command's OWN exit code, from its end marker. */
  exitCode?: number;
  /** Seconds, as measured by the shell that ran it. */
  seconds?: number;
}

/**
 * What a specific command did, from its own end marker.
 *
 * `wait` used to answer "is it done?" and then hand back the SESSION's last
 * recorded exit code — a different question. That value comes from metadata
 * written when something last polled, so for a command nobody polled it is
 * stale or simply absent. An agent that waited on a three-minute job got
 * `verified: true` and no usable code, and had to spend a second call on
 * `poll` to learn what it had just been told was finished.
 *
 * The end marker already carries both the code and the shell's own duration,
 * and reading it costs one tail scan. Asking the handle rather than the
 * session makes the answer belong to the command the caller asked about.
 */
export async function commandOutcome(name: string, handle: string): Promise<CommandOutcome> {
  const clean = validateName(name);
  const end = await findCommandEnd(logPath(clean), handle).catch(() => undefined);
  if (end === undefined) return { finished: false };
  return {
    finished: true,
    ...(Number.isFinite(end.code) ? { exitCode: end.code } : {}),
    ...(end.measuredSeconds !== undefined && Number.isFinite(end.measuredSeconds)
      ? { seconds: end.measuredSeconds }
      : {}),
  };
}

/**
 * Whether a session that LOOKS idle has actually finished what it was running.
 *
 * `pane_current_command` names the foreground PROCESS, and a shell script runs
 * as `bash` — so `classify` reads `brew install` (Homebrew's `brew` is a
 * `#!/bin/bash` script), `./configure`, `rustup`, `nvm` or any other script as
 * an idle shell sitting at a prompt. `wait` told an agent its install was
 * `idle` while Homebrew was still unpacking; only polling anyway, with the
 * handle, showed it was still going.
 *
 * THREE answers, not two, because the third is the one that bites. Collapsing
 * `unknown` into `finished` is what made this look fixed when it was not: a
 * chatty command pushes its own start marker out of the scan window, so the
 * check finds nothing, and "nothing to contradict the pane" silently became
 * "the pane is right". A 93 KB build measured exactly that — `wait` answered
 * `idle` instantly while the job had twenty-five seconds left. Installers are
 * chatty by nature, so this is the common case, not the corner.
 *
 * - `running`  — a framed command has no end marker. Proof it is still going.
 * - `finished` — the newest framed command has one. Proof it is not.
 * - `unknown`  — no framed command in the window. Says nothing either way,
 *                and callers MUST surface that rather than round it to idle.
 *
 * `running` is not a veto either. It covers a command whose shell died
 * mid-frame — a killed pane, a nested `exit` — which never writes an end
 * marker, so its start marker dangles forever. Anything that REFUSES on it
 * refuses forever: putting this in `run`'s busy guard wedged five sessions in
 * the suite, each perfectly usable. Use it only where the caller gives up on
 * its own, as `wait` does at its deadline.
 *
 * For an answer with none of these caveats, hold the handle and use
 * `commandFinished`.
 */
export async function lastCommandEvidence(
  name: string,
): Promise<'running' | 'finished' | 'unknown'> {
  const handle = await latestHandle(name).catch(() => undefined);
  if (handle === undefined) return 'unknown';
  return (await commandFinished(name, handle).catch(() => true)) ? 'finished' : 'running';
}

/**
 * Check on a command started with `start`, returning only what is new.
 *
 * `since` should be the previous call's `nextOffset` (or `start`'s `offset`),
 * so a caller polling a long job does not re-read the same output every time.
 */
export async function poll(
  name: string,
  handle: string,
  since = 0,
  maxBytes = MAX_RETURN_BYTES,
): Promise<PollResult> {
  const clean = validateName(name);
  const log = logPath(clean);

  const size = await fileSize(log);
  const at = await resolveOffset(clean, since);
  const discarded = at.logicalEnd - size;
  const slice = await readLogCapped(log, at.physical, size, maxBytes);
  const output = trimToCommandWindow(slice.raw, handle);

  let exitCode: number | null = null;
  let done = false;
  /** The ssh link for a remote session dropped while this command was running. */
  let remoteLost = false;

  // Use the FULL end marker, not just the code: it also carries the directory
  // the command finished in.
  //
  // Only `run` recorded that, so a `cd` issued through `start` never registered
  // and `ath ls` went on reporting the session's old directory — it said
  // `box:~` for a shell sitting in /tmp/infra-survey-…, which is exactly the
  // place a caller looks to find out where a session is. Wrong quietly, which
  // is the worst way to be wrong.
  const end = await findCommandEnd(log, handle);
  const code = end?.code;
  if (code !== undefined) {
    exitCode = code;
    done = true;
    await setMeta(clean, 'last_rc', String(code)).catch(() => undefined);
    const sess = await get(clean).catch(() => undefined);
    if (sess?.remote) await recordRemoteState(clean, end, undefined, sess).catch(() => undefined);
  } else {
    const { dead, status } = await paneStatus(clean).catch(() => ({
      dead: false,
      status: null,
      command: '',
      width: 0,
    }));
    if (dead) {
      done = true;
      exitCode = status;
    } else {
      // A remote command whose ssh link dropped is NOT still running.
      //
      // The only liveness check here was `paneDead`, and a dropped connection
      // does not kill the pane — it falls back to the LOCAL shell, which is
      // very much alive. So no end marker ever arrives, nothing is dead, and
      // `done: false` is returned forever with `running_for_seconds` counting
      // up. An agent watched that report a corpse as running for 516 seconds,
      // eight minutes after the job died, and reasonably called the field
      // unfalsifiable: absent a marker the hub simply assumed "still running".
      //
      // `assertRemoteConnected` has always known how to spot this — a remote
      // session whose pane is no longer in a nested shell. Poll never asked.
      //
      // `done` with a null exit code is exactly the documented shape for "it
      // ended without a recoverable status", which is the honest answer: the
      // command is gone, and what it did is unknowable.
      const sess = await get(clean).catch(() => undefined);
      if (sess?.remote && !isNesting(sess.currentCommand)) {
        done = true;
        exitCode = null;
        remoteLost = true;
      }
    }
  }

  const session = await get(clean).catch(() => null);
  if (!session) throw new SessionGone(clean);

  // A BACKGROUND command stopped at a prompt must ask for a human too.
  //
  // `start()` returns before the command has run, so it can never see a
  // credential prompt, and only `run()` filed requests. The result was that the
  // hub's loudest case — a long job parked on a password — raised nothing: no
  // editor notification, no request for `ath requests` or `ath await` to find.
  // The human was never told, and the agent was left polling a job that would
  // never move.
  //
  // Poll is the first moment anything observes the prompt, so it is where the
  // ask belongs. The handle goes with it, so whoever picks it up collects the
  // OUTCOME rather than re-running the command and asking a second time.
  if (!done && session.state === 'needs-input') {
    // File once. Poll is called in a loop by design, and a request per poll
    // would bury the editor in notifications for a single prompt.
    const already = await listRequests()
      .then((rs) => rs.some((r) => r.session === clean && r.handle === handle && !r.resolvedAt))
      .catch(() => false);
    if (!already) {
      await requestHuman(
        clean,
        `"${(session.lastCommand ?? 'a background command').slice(0, 80)}" is waiting at a ` +
          `prompt in "${clean}". Attach with "ath attach ${clean}" and answer it.`,
        'agent',
        handle,
        true,
      ).catch(() => undefined);
    }
  }

  const timing = await timingFor(handle, done, end?.measuredSeconds);
  // Offsets are per SESSION, so `since` from an earlier job is silently valid
  // and silently wrong: it re-reads the previous command's output, which a
  // caller may then attribute to this one. Nothing errored, so nothing warned.
  const staleSince =
    timing?.startOffset !== undefined && since > 0 && since < timing.startOffset;
  return {
    session: clean,
    handle,
    done,
    exitCode,
    output,
    nextOffset: at.logicalEnd,
    state: session.state,
    needsInput: session.state === 'needs-input',
    // Surfaced as FIELDS, not only as the note inside the text. A caller
    // deciding whether to go back for the gap should not have to parse prose
    // out of the command's own output to find out there is one.
    ...(slice.omitted === undefined
      ? {}
      : {
          omittedBytes: slice.omitted.bytes,
          omittedResumeFrom: discarded + slice.omitted.resumeFrom,
        }),
    // Trimmed out from under the caller. Reported rather than left to be
    // inferred from a `next_offset` smaller than the `since` that was passed —
    // which is all the hub used to say, and says nothing at all.
    ...(at.lostBytes === undefined ? {} : { lostBytes: at.lostBytes }),
    ...(at.beyondEnd ? { offsetBeyondEnd: true } : {}),
    ...(remoteLost ? { remoteDisconnected: true } : {}),
    ...(timing?.seconds === undefined
      ? {}
      : { elapsedSeconds: timing.seconds, elapsedExact: timing.exact }),
    ...(timing?.lowerSeconds === undefined
      ? {}
      : { elapsedLowerSeconds: timing.lowerSeconds, elapsedUpperSeconds: timing.upperSeconds }),
    ...(timing === undefined ? {} : { elapsedObserved: timing.observed }),
    ...(staleSince
      ? {
          warning:
            `The offset you passed (${since}) is from before this command started ` +
            `(${timing?.startOffset}), so the output above includes an EARLIER job's. ` +
            `Offsets are per session, not per handle — pass back the next_offset you were ` +
            `last given for THIS handle.`,
        }
      : {}),
  };
}

/**
 * Quote a command for the `__ath` helper.
 *
 * Single-line commands pass through literally so the human sees a readable
 * line in their pane. Multi-line commands are base64'd, because a raw newline
 * in `send-keys -l` would submit the line early and strand the shell in a
 * continuation.
 */

/**
 * How a command is handed to the shell.
 *
 * `: <nonce>; <command>` when the shell's hooks provide the framing. The shell
 * echoes what we type, and that echo can be neither restyled nor erased — four
 * attempts proved it — so making it short is the only lever there is, and this
 * is the shortest form that stays unambiguous. A command the HUMAN types
 * carries no nonce, so it can never be mistaken for ours.
 *
 * The wrapper form is kept for a multi-line command, which cannot be typed as a
 * single line, and is also the fallback for shells with no hooks. If the hooks
 * are absent the markers never appear, `run` reports `command_lost`, and the
 * retry uses the wrapper — the self-heal path that already existed.
 */
/**
 * Is the pane's CURRENT shell the one we installed hooks into?
 *
 * Recorded per shell rather than per session: entering a nested shell — `bash`
 * inside the session, a `docker exec`, the far side of an ssh hop — lands in a
 * shell that has never seen our hooks, and sending a bare command there runs it
 * with no framing at all.
 */
/** Whether the wrapper has already been typed into the shell now in the pane. */
async function wrapperReady(name: string): Promise<boolean> {
  return await get(name)
    .then((s) => s.wrapperInstalled === true)
    .catch(() => false);
}

/** How long to wait for a frame to open before saying it was not confirmed. */
const START_CONFIRM_MS = 2500;

/**
 * Wait for a command's frame to actually open.
 *
 * Ground truth for "did this start", and cheap: the frame prints its start
 * marker BEFORE running the command, so it lands within milliseconds whenever
 * things are working, whatever the command then goes on to do.
 */
async function awaitStartMarker(name: string, nonce: string, timeoutMs: number): Promise<boolean> {
  const file = logPath(name);
  const marker = `${SENTINEL}<ATHS:${nonce}>`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const raw = await readLogTailBytes(file, MARKER_SCAN_BYTES).catch(() => '');
    if (raw.includes(marker)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(60);
  }
}

/**
 * Wait for the tag line to say the hooks are really there.
 *
 * The tag function prints its acknowledgement and erases it, so this costs the
 * human nothing on screen and travels the one path that works identically
 * locally, over ssh and inside a container.
 */
async function awaitTagAck(name: string, nonce: string, timeoutMs: number): Promise<boolean> {
  const file = logPath(name);
  const marker = `<ATHT:${nonce}>`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const raw = await fs.readFile(file, 'utf8').catch(() => '');
    if (raw.slice(-8192).includes(marker)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(60);
  }
}

async function hooksActive(name: string, session: Session): Promise<boolean> {
  const want = `${session.currentCommand}`;
  const seen = await get(name)
    .then((s) => s.frameShell)
    .catch(() => undefined);
  return !!seen && seen === want;
}

/**
 * Things only a person at the keyboard can get past.
 *
 * Both shapes matter. The interactive prompt parks the session in
 * `needs-input`, which is already surfaced — but the NON-interactive refusal
 * ("sudo: a password is required", from `sudo -n`) just returns an error, and
 * an agent can quietly accept that and report the task as blocked. That is the
 * failure this catches.
 */
const HUMAN_WALL_RE =
  /a (?:password|passphrase) is required|^\[sudo\] password for|sudo: no tty present|Permission denied \(publickey|Authentication failure|must be run as root|are you root\?/im;

/**
 * Warn when `exit_code` is not the status of the command the caller means.
 *
 * The shell reports the LAST segment's status, which is correct and is exactly
 * what misleads. `sudo -n true 2>&1; echo "exit=$?"` came back as
 * `exit_code: 0` while its own output read `exit=1`, because the last command
 * was the echo. The same agent was bitten again by a line ending in `grep -c`,
 * which returned 1 for finding zero matches even though the real work had
 * succeeded. Its point stands: the one machine-readable field in the response
 * is the one most likely to be wrong about what the caller asked.
 *
 * `&&` and `||` are excluded on purpose — there the propagated status is
 * usually the answer you wanted. It is `;` and `|` that hide it.
 */
function compoundExitCaveat(command: string): string | undefined {
  // Ignore separators inside quotes: `echo "a;b"` is not a compound command.
  const bare = command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  const hasSemicolon = /;/.test(bare);
  const hasPipe = /\|(?!\|)/.test(bare.replace(/\|\|/g, '&&'));
  if (!hasSemicolon && !hasPipe) return undefined;
  return hasPipe && !hasSemicolon ? 'last-pipeline-stage-only' : 'last-command-only';
}

/**
 * True the FIRST time a session would show the LONG form of the caveat.
 *
 * Two agents complained about this field in opposite directions, one round
 * apart, and both were right about a different failure:
 *
 *   "I stopped reading it"       — a full sentence on nearly every result.
 *   "it fired once and went      — shown once, then silent while the hazard
 *    quiet while I kept running     stayed; lost entirely to a context summary
 *    misleading pipelines"          or to an agent joining mid-session.
 *
 * Neither "always" nor "once" is right for the same text. So the marker is now
 * always present and costs three words, and the explanation is shown once. The
 * hazard is never silent, and the paragraph never repeats.
 */
async function firstCaveatFor(session: string): Promise<boolean> {
  const flag = path.join(RC_DIR, `${session}.caveat`);
  try {
    await fs.access(flag);
    return false;
  } catch {
    await fs.mkdir(RC_DIR, { recursive: true, mode: 0o700 }).catch(() => undefined);
    await fs.writeFile(flag, '1', { mode: 0o600 }).catch(() => undefined);
    return true;
  }
}

/**
 * Quote a command for a message without chopping it mid-token.
 *
 * A bare `slice(0, 80)` cut an agent's command inside its own quoted string, so
 * the advisory ended `... || echo "-> no, as` — a fragment that reads like it
 * describes some other command, and the agent had to re-read the output to be
 * sure it did not. If it must be shortened, say so.
 */
function quoteForMessage(command: string, max = 80): string {
  const flat = command.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return `"${flat}"`;
  // Prefer a space boundary so the fragment ends on a whole word.
  const cut = flat.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `"${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…" (truncated)`;
}

/** Commands that can stop at a credential wall. */
const PRIVILEGE_CMD_RE = /(^|[\s;|&(`$])(sudo|doas|su|ssh|scp|sftp|rsync|passwd|gpg)\b/;

/**
 * Redirections that DESTROY stderr — not merely move it.
 *
 * The first version matched any `2>` target, so `2>>du-errors.txt` was called
 * discarding. An agent had deliberately redirected to a file and then read it
 * (0 lines, which is how it knew the walk was clean) and was told it had
 * "thrown away" the evidence. That is a flat false positive on a careful
 * caller.
 *
 * It cost more than one wrong message. That warning and one other piece of
 * noise arrived BEFORE the single true positive, so by the time the real one
 * came — a `sudo du ... 2>/dev/null` inside a loop silently producing five
 * blank sizes — the reader had already learned to discount it. The skill warns
 * about precisely this dynamic, and the implementation walked into it.
 *
 * Only /dev/null and a closed descriptor destroy the text. A file keeps it;
 * `2>&1` keeps it. Neither is the caller's problem.
 */
/** Flags that suppress the prompt, leaving stderr as the only signal. */
const NON_INTERACTIVE_RE = /(^|\s)(-n|--non-interactive|--batch|-o\s*BatchMode=yes|BatchMode=yes)(\s|$)/;

/** Tools that walk a tree and skip what they cannot read. */
/**
 * Tools that walk a tree and skip what they cannot read.
 *
 * RECURSION is the hazard, not the command name. `du` and `find` always
 * descend; `grep`, `ls`, `cp` and `rsync` only do so when asked, and their
 * flags differ — `-a` means archive (recursive) for cp and rsync, but "all
 * files" for ls, which is not recursive at all.
 *
 * The first version matched on the name alone, so `ls /var/lib/apt/periodic/`
 * drew a warning about silently omitted subtrees when it descends into
 * nothing. An agent met it three times in one session, twice spuriously, and
 * named the consequence precisely: it is the same fatigue dynamic this project
 * has already been bitten by twice. A warning that fires when it cannot apply
 * teaches the reader to skip it on the occasion it does.
 */
const ALWAYS_RECURSIVE_RE = /(^|[\s;|&(])(du|find|tar)\b/;
function walksRecursively(command: string): boolean {
  if (ALWAYS_RECURSIVE_RE.test(command)) return true;
  // Simple, readable fallback: the tool plus a recursive flag for that tool.
  if (/(^|[\s;|&(])grep\b[^;|&]*\s-[A-Za-z]*[rR]/.test(command)) return true;
  if (/(^|[\s;|&(])ls\b[^;|&]*\s-[A-Za-z]*R/.test(command)) return true;
  if (/(^|[\s;|&(])(cp|rsync)\b[^;|&]*\s-[A-Za-z]*[rRa]/.test(command)) return true;
  return false;
}

/** Paths where an unprivileged walk WILL hit unreadable areas. */
const SYSTEM_PATH_RE = /(^|\s)\/(?:$|\s)|(^|\s)\/(var|etc|root|home|usr|opt|srv|proc|sys)\b/;

const STDERR_DISCARDED_RE =
  /(^|[\s;|&(])(2\s*>>?\s*\/dev\/null|2\s*>\s*&\s*-|&>>?\s*\/dev\/null|>&\s*\/dev\/null)(\s|$|[;|&)])/;

/**
 * Warn when a command has switched off the very thing this hub is for.
 *
 * The wall detector reads a command's OUTPUT, so `sudo … 2>/dev/null` deletes
 * the evidence before it exists: no request is filed, nobody is asked, and the
 * result comes back looking like an ordinary success. An agent hit this within
 * five minutes of picking the tool up and described it exactly — "the result
 * reported success for a command that never ran, and nothing anywhere said
 * this produced no output and exited instantly". It was not being clever;
 * `2>/dev/null` on a `du` is a completely routine idiom.
 *
 * No amount of watching harder can fix that, because the text never arrives.
 * The command string is the one place the problem is still visible, so say so
 * there. A warning rather than a refusal: discarding stderr is legitimate, and
 * the caller may know exactly what it is doing.
 */
function credentialBlindSpot(command: string): string | undefined {
  if (!PRIVILEGE_CMD_RE.test(command) || !STDERR_DISCARDED_RE.test(command)) return undefined;
  // Only the NON-INTERACTIVE shape is actually blinded.
  //
  // This warned about every privileged command that discarded stderr, and an
  // agent checked: in a PTY, sudo writes its prompt to /dev/tty, not stderr, so
  // `sudo id 2>/dev/null` still parks and still files a request. Verified here
  // — the session goes to needs-input and the pane shows `Password:`. The
  // warning was right about `sudo -n`, where there IS no prompt and the whole
  // signal is the "a password is required" line on stderr, and wrong about
  // everything else. A warning that cries wolf on the common case teaches the
  // reader to skip it on the case that matters.
  if (!NON_INTERACTIVE_RE.test(command)) return undefined;
  return (
    'This runs non-interactively AND discards stderr. There is no prompt to park on, and the ' +
    '"a password is required" line that would otherwise raise the handoff goes to stderr — ' +
    'which you just threw away. So the hub cannot see it, nobody is asked, and a silent ' +
    'success here may mean the command never ran. Use 2>&1, or drop the -n so it parks at a ' +
    'real prompt.'
  );
}

/**
 * Warn when discarded stderr is hiding permission errors from a tree walk.
 *
 * An agent ran `du -xh -d2 / 2>/dev/null`, got 20G against df's 70G, and nearly
 * filed it: the walk could not read /var/lib/docker, its own redirect ate the
 * errors, and the exit code was 0. A 50 GB understatement that looked entirely
 * plausible, caught only by cross-checking df.
 */
function traversalBlindSpot(command: string): string | undefined {
  // Both halves must be in the SAME segment of a compound line.
  //
  // Testing the whole line meant a `/dev/null` anywhere re-triggered the
  // warning about the walker — including on the very command that had FOLLOWED
  // the advice: an agent re-ran its `du` with `2>/tmp/du.err` and a line count,
  // and was warned again for the unrelated redirect in the second half. It
  // said two false positives in twelve commands were enough that it "began
  // skimming them", which is how it under-weighted the one that was right.
  const segments = command.split(/;|&&|\|\|/);
  const guilty = segments.some(
    (seg) => walksRecursively(seg) && STDERR_DISCARDED_RE.test(seg) && SYSTEM_PATH_RE.test(seg),
  );
  if (!guilty) return undefined;
  // State what is OBSERVED, never a cause that was not.
  //
  // This used to say "permission errors are being destroyed". It fired on a
  // `sudo du -x` that reported 498 MB against a true 20 GB — right that the
  // number was wrong, right about the magnitude, and wrong about why: the agent
  // redirected stderr to a file on the retry and found it EMPTY. There were no
  // permission errors. `-x` had refused to cross into the overlay mounts.
  //
  // The agent's verdict is the reason this wording changed: "a warning that
  // misdiagnoses is a warning that eventually gets ignored". It nearly was —
  // running under sudo, "permission errors" is exactly the premise a reader can
  // dismiss, and dismissing it would have shipped the wrong number.
  //
  // So the claim is now the one thing actually known from the command text:
  // stderr is gone. What it would have said — a permission denial, a mount not
  // crossed, a vanished path — is unknowable from here, and naming one guess
  // stakes the warning's credibility on it.
  return (
    'This walks a filesystem and discards stderr, so ANY error it hits is invisible — a ' +
    'permission denial, a mount it declined to cross (-x/--one-file-system), a path that ' +
    'vanished mid-walk — and the exit code stays 0 regardless. A total from this can be far ' +
    'short of the truth. Send stderr to a FILE and read it (or use 2>&1), and cross-check the ' +
    'total against an independent source such as df or docker system df.'
  );
}

/**
 * Raise a request for a human, automatically, when a command hits such a wall.
 *
 * Deliberately not conditional on the agent choosing to. The request is written
 * where the human's tooling watches for it, so the ask happens even if the
 * agent never mentions it.
 */
async function raiseHumanWall(
  name: string,
  command: string,
  output: string,
  handle?: string,
): Promise<string | undefined> {
  if (!HUMAN_WALL_RE.test(output)) return undefined;
  // TELL THE AGENT, do not summon the human.
  //
  // This fires on a command that has already EXITED — a non-interactive refusal
  // like `sudo -n`. Nothing is parked, so there is no prompt for anyone to
  // answer: a person who accepts the notification and attaches finds an idle
  // shell and nothing to type into. An agent probing its own environment with
  // `sudo -n true` had a request raised against its user for a question the
  // user could not usefully answer, and then had to raise a second one for the
  // actual work.
  //
  // The useful move belongs to the agent: run the command WITHOUT `-n` so it
  // parks at a real prompt. That path files a parked request, and then the
  // human's keystrokes answer the command itself rather than a notification
  // about one. So return the guidance and file nothing here.
  return (
    `${quoteForMessage(command)} needs a credential only you can type, and it has already ` +
    `exited — nothing is waiting at a prompt, so there is nothing for anyone to answer yet. ` +
    `Re-run it interactively (drop any -n / --non-interactive) so it PARKS at the prompt: ` +
    `the hub then asks the user, and what they type answers this command directly. Tell them ` +
    `what you need first.`
  );
}

function commandLine(nonce: string, command: string): string | undefined {
  // Multi-line commands cannot be typed as one line, so they keep the wrapper.
  if (command.includes('\n')) return undefined;
  return command;
}

/**
 * The longest line we will type into a shell in one go.
 *
 * A tty's input buffer is finite and far smaller than people expect: busybox
 * inside `docker exec` truncated a 2000-character line to 229 — AND RAN THE
 * TRUNCATED RESULT. A shortened `echo` is harmless; a shortened command with a
 * path is not, and nothing about it looked like a failure. So a long command is
 * never typed as one line.
 */
const MAX_TYPED_LINE = 500;

/**
 * Deliver a command that is too long to type, by building it from short lines.
 *
 * Each fragment is appended to a shell variable, so every line that reaches the
 * tty is well under any plausible buffer, and the command is reassembled on the
 * far side before it runs. Works in any POSIX shell — no here-docs, no files,
 * nothing written anywhere.
 */
async function deliverCommand(session: string, command: string): Promise<string> {
  const inline = encodeCommand(command);
  if (inline.length <= MAX_TYPED_LINE) return inline;

  const b64 = Buffer.from(command, 'utf8').toString('base64');
  const chunks = b64.match(/.{1,400}/g) ?? [];
  await sendLine(session, `__ath_b=${shellQuote(chunks[0] ?? '')}`);
  for (const chunk of chunks.slice(1)) {
    await sendLine(session, `__ath_b="$__ath_b"${shellQuote(chunk)}`);
  }
  return '"$(printf %s "$__ath_b" | base64 -d)"';
}

function encodeCommand(command: string): string {
  if (!command.includes('\n')) return shellQuote(command);
  const b64 = Buffer.from(command, 'utf8').toString('base64');
  return `"$(printf %s ${shellQuote(b64)} | base64 -d)"`;
}

/** Tail a session's output. Cost is bounded by the window, not the log size. */
/**
 * The last `lines` of a session, AND where to resume from.
 *
 * The offset is not decoration. The documented way to follow a session is to
 * pass `nextOffset` back as `since` — but only the `since` shape returned one,
 * so an agent with no offset yet had no way to obtain its first. It had to
 * guess a number, or read the whole log to learn where the end was, which is
 * the exact thing the offset exists to avoid. A cold agent hit this and said
 * so: "the documented round-trip can't be bootstrapped from --tail".
 *
 * Both shapes carry it now, so either one starts the loop.
 */
export async function readTail(
  name: string,
  lines = 200,
): Promise<{ output: string; nextOffset: number }> {
  const clean = validateName(name);
  const log = logPath(clean);
  // Taken BEFORE the read, so the offset can never point past what was
  // returned. A command still printing would otherwise let the file grow
  // between the two calls, and resuming from the later offset would skip
  // whatever landed in the gap — silent loss, which is worse than overlap.
  // Logical, matching every other offset the hub hands out: a caller cannot
  // tell which shape it was given, so there must only be one shape.
  const nextOffset = await logicalEnd(clean);
  const raw = await readLogTailBytes(log);
  if (!raw) return { output: await capturePane(clean, lines), nextOffset };
  const all = trimBlankEdges(toLines(raw).filter((line) => !MARKER_LINE_RE.test(line)));
  return { output: all.slice(Math.max(0, all.length - lines)).join('\n'), nextOffset };
}

/** Incremental read for pollers: everything after `since`, plus where to resume. */
export async function readSince(
  name: string,
  since: number,
  maxBytes = MAX_RETURN_BYTES,
): Promise<{
  output: string;
  nextOffset: number;
  omittedBytes?: number;
  omittedResumeFrom?: number;
  /** Requested bytes trimmed away before this call. Output starts later. */
  lostBytes?: number;
  /** The offset was past the end of the log. */
  offsetBeyondEnd?: boolean;
}> {
  const clean = validateName(name);
  const log = logPath(clean);
  const size = await fileSize(log);
  const at = await resolveOffset(clean, since);
  // Capped for the same reason `poll` is, and it must be BOTH: this is the
  // other half of the documented follow loop, so bounding one and leaving the
  // other just moves the flood to whichever the caller happened to pick.
  const slice = await readLogCapped(log, at.physical, size, maxBytes);
  const discarded = at.logicalEnd - size;
  return {
    output: cleanSlice(slice.raw),
    nextOffset: at.logicalEnd,
    ...(slice.omitted === undefined
      ? {}
      : {
          omittedBytes: slice.omitted.bytes,
          // Back to LOGICAL before it leaves, or the caller resumes at a
          // physical position that means something else after the next trim.
          omittedResumeFrom: discarded + slice.omitted.resumeFrom,
        }),
    ...(at.lostBytes === undefined ? {} : { lostBytes: at.lostBytes }),
    ...(at.beyondEnd ? { offsetBeyondEnd: true } : {}),
  };
}

export { stripAnsi };
