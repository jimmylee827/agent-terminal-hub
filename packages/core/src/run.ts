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
  logPath,
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

/** How much of a log `readTail` looks at. Bounded so cost is independent of log size. */
const TAIL_WINDOW_BYTES = 256 * 1024;

/**
 * Marker lines are protocol plumbing and never belong in output shown to anyone.
 *
 * Must track the end marker's optional trailing fields. Missing them here does
 * not fail loudly — it silently prints a wall of base64 into the user's output.
 */
const MARKER_LINE_RE = /<ATH[SETR]:[A-Za-z0-9]+(?::-?\d+)?(?::[A-Za-z0-9+/=]*){0,2}>/;

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
  return new RegExp(`<ATHE:${nonce}:(-?\\d+)(?::([A-Za-z0-9+/=]*))?(?::([A-Za-z0-9+/=]*))?>`);
}

export interface CommandEnd {
  code: number;
  /** Working directory the command finished in, if the helper reported it. */
  cwd?: string;
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
  for (const line of toLines(raw)) {
    const hit = endMarkerRe(nonce).exec(line);
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
          logOffset: await fileSize(logPath(clean)),
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
      logOffset: offset,
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
        `"${command.slice(0, 80)}" is waiting at a prompt in "${clean}". ` +
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
      logOffset: offset,
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

  const paneTail = await capturePane(clean).catch(() => '');
  const finished = await get(clean).catch(() => null);
  const state = classify({
    paneDead: false,
    currentCommand: finished?.currentCommand ?? 'zsh',
    paneTail,
    paneWidth: finished?.paneWidth ?? 0,
  });

  const output = extractBetweenMarkers(raw, nonce, command);
  const needsHuman = await raiseHumanWall(clean, command, output, nonce);

  return {
    session: clean,
    command,
    exitCode,
    output,
    ...(needsHuman ? { needsHuman } : {}),
    // Only when no wall fired: if one did, the request exists and the warning
    // would be noise. The dangerous case is the SILENT one.
    ...(!needsHuman && (credentialBlindSpot(command) ?? traversalBlindSpot(command))
      ? { warning: credentialBlindSpot(command) ?? traversalBlindSpot(command) }
      : {}),
    // ALWAYS marked, explained ONCE. See firstCaveatFor.
    ...(compoundExitCaveat(command)
      ? {
          exitCaveat: compoundExitCaveat(command),
          ...((await firstCaveatFor(clean))
            ? {
                exitCaveatNote:
                  'The exit code above is the status of only the last part of this line — an ' +
                  'earlier failure can be hidden by a later success, and a pipeline reports its ' +
                  'last stage. Read the output rather than trusting the number. (Shown once per ' +
                  'session; the short marker stays on every affected command.)',
              }
            : {}),
        }
      : {}),
    timedOut: false,
    needsInput: state === 'needs-input',
    state,
    logOffset: offset,
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
  return command
    .split(/[;\n]|&&/)
    .map((part) => part.trim())
    .filter(isPureAssignment);
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
    const offset = await fileSize(logPath(clean));
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

    return { session: clean, command, handle: nonce, offset };
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
  const re = new RegExp(`${SENTINEL}<ATHS:([A-Za-z0-9]+)>`, 'g');
  let found: string | undefined;
  for (let m = re.exec(tail); m !== null; m = re.exec(tail)) found = m[1];
  return found;
}

/**
 * Check on a command started with `start`, returning only what is new.
 *
 * `since` should be the previous call's `nextOffset` (or `start`'s `offset`),
 * so a caller polling a long job does not re-read the same output every time.
 */
export async function poll(name: string, handle: string, since = 0): Promise<PollResult> {
  const clean = validateName(name);
  const log = logPath(clean);

  const size = await fileSize(log);
  const output = trimToCommandWindow(await readLogFrom(log, Math.min(since, size)), handle);

  let exitCode: number | null = null;
  let done = false;

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

  const timing = await timingFor(handle, done);
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
    nextOffset: size,
    state: session.state,
    needsInput: session.state === 'needs-input',
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

/** Commands that can stop at a credential wall. */
const PRIVILEGE_CMD_RE = /(^|[\s;|&(`$])(sudo|doas|su|ssh|scp|sftp|rsync|passwd|gpg)\b/;

/**
 * Redirections that send stderr where the hub cannot read it.
 *
 * `2>&1` is fine — stderr merges into stdout and is still captured. What blinds
 * the detector is stderr going to /dev/null or a file, or the whole lot going
 * there with `&>`.
 */
/** Flags that suppress the prompt, leaving stderr as the only signal. */
const NON_INTERACTIVE_RE = /(^|\s)(-n|--non-interactive|--batch|-o\s*BatchMode=yes|BatchMode=yes)(\s|$)/;

const STDERR_DISCARDED_RE = /(^|[\s;|&(])(2\s*>\s*(?!&\s*1)\S+|&>\s*\S+|>&\s*\/dev\/null)/;

/** Tools that walk a tree and skip what they cannot read. */
const TRAVERSAL_CMD_RE = /(^|[\s;|&(])(du|find|grep|rsync|tar|cp|ls)\b/;

/** Paths where an unprivileged walk WILL hit unreadable areas. */
const SYSTEM_PATH_RE = /(^|\s)\/(?:$|\s)|(^|\s)\/(var|etc|root|home|usr|opt|srv|proc|sys)\b/;

/**
 * Warn when discarded stderr is hiding permission errors from a tree walk.
 *
 * An agent ran `du -xh -d2 / 2>/dev/null`, got `20G` against df's `70G`, and
 * nearly filed it: the walk could not read /var/lib/docker, its own redirect
 * ate the errors, and the exit code was 0. A 50 GB understatement that looked
 * entirely plausible, caught only by cross-checking df.
 *
 * The credential blind-spot warning did not cover this and should not — the
 * command was unprivileged. But the shape is the same one this tool keeps
 * getting bitten by: stderr thrown away, a success reported, and a silently
 * incomplete answer. Different cause, same class, worth its own warning.
 */
function traversalBlindSpot(command: string): string | undefined {
  if (!TRAVERSAL_CMD_RE.test(command) || !STDERR_DISCARDED_RE.test(command)) return undefined;
  if (!SYSTEM_PATH_RE.test(command)) return undefined;
  return (
    'This walks a system path with stderr discarded, so permission errors are being thrown ' +
    'away — anything unreadable is silently omitted and the exit code will still be 0. A total ' +
    'from this may be far short of the truth. Keep stderr (2>&1), or run it with the privilege ' +
    'it needs, and cross-check totals against an independent source.'
  );
}

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
    `"${command.slice(0, 80)}" needs a credential only you can type, and it has already ` +
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
export async function readTail(name: string, lines = 200): Promise<string> {
  const clean = validateName(name);
  const raw = await readLogTailBytes(logPath(clean));
  if (!raw) return capturePane(clean, lines);
  const all = trimBlankEdges(toLines(raw).filter((line) => !MARKER_LINE_RE.test(line)));
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}

/** Incremental read for pollers: everything after `since`, plus where to resume. */
export async function readSince(
  name: string,
  since: number,
): Promise<{ output: string; nextOffset: number }> {
  const clean = validateName(name);
  const log = logPath(clean);
  const size = await fileSize(log);
  const output = cleanSlice(await readLogFrom(log, Math.min(since, size)));
  return { output, nextOffset: size };
}

export { stripAnsi };
