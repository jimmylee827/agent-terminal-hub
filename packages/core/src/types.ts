/** Lifecycle state of a hub session, as classified by `state.ts`. */
export type SessionState =
  /** A shell is at its prompt with nothing running. */
  | 'idle'
  /** A foreground process is running and not asking for anything. */
  | 'busy'
  /** A foreground process is waiting on a human: password, passphrase, y/n. */
  | 'needs-input'
  /** The pane's process exited; the session is held open by `remain-on-exit`. */
  | 'dead';

export interface Session {
  /** Logical name, without the `ath-` prefix. This is what users and agents type. */
  name: string;
  /** Real tmux session name (`ath-<name>`). */
  tmuxName: string;
  state: SessionState;
  /** Live pane directory. Moves whenever anyone `cd`s, so a weak identity hint. */
  cwd: string;
  /**
   * Directory the session was created FROM — usually the project it belongs to.
   * Unlike `cwd` this never moves, which makes it the better signal for working
   * out which editor window a session's notifications belong in.
   */
  origin?: string;
  /**
   * Pid chain of the process that created this session, nearest first.
   * The editor window whose extension-host pid appears here owns this
   * session's notifications outright — an identity, not a heuristic.
   */
  creatorPids?: number[];
  /** Command running in the active pane, e.g. `zsh`, `npm`, `sudo`. */
  currentCommand: string;
  /** Number of attached clients. > 0 means a human is watching. */
  attached: number;
  /** Session creation time, epoch seconds. */
  created: number;
  /** Pinned sessions are never reaped by `gc`. */
  pinned: boolean;
  owner: string;
  /** Set when the session was created with `--remote <host>`. */
  remote?: string;
  /**
   * Last known working directory ON THE REMOTE HOST, carried in each command's
   * end marker so a reconnect can put the new shell back where the old one was
   * — after the link drops there is nothing left to ask.
   */
  remoteCwd?: string;
  /**
   * Assignments to replay after a reconnect, agent-issued AND human-typed.
   *
   * A dropped link takes the remote shell with it, and exported variables live
   * only in that process — so `export FOO=bar` is gone after a reconnect even
   * though `cwd` comes back. Shipping the whole environment through the end
   * marker was tried and rejected: the markers must stay short enough not to
   * wrap, and an env dump painted the pane. Restoring only the exports the hub
   * itself issued would be worse than restoring none, because the caller could
   * not tell which survived. So the loss is REPORTED instead — see the
   * reconnect notice in the CLI — rather than silently half-repaired.
   */
  remoteEnv?: string;
  /** The shell that has our framing hooks installed, by pane_current_command. */
  frameShell?: string;
  /**
   * The fallback wrapper has been typed into the shell currently in the pane.
   *
   * Tracked so it is installed ONCE rather than on every command. It also keeps
   * the first command in a shell we did not set up from printing
   * "__ath: command not found" before the self-heal runs.
   */
  wrapperInstalled?: boolean;
  label?: string;
  lastCommand?: string;
  lastExitCode?: number;
  /** Absolute path of the pipe-pane log backing this session. */
  logPath: string;
  paneDead: boolean;
  /**
   * Visible pane content captured while classifying this session, carried so
   * the watcher can do staleness comparison without capturing a second time.
   */
  paneTail?: string;
  /** Pane width in columns, for wrap-aware prompt detection. */
  paneWidth?: number;
}

export interface RunResult {
  session: string;
  command: string;
  /** A problem with the command itself that the hub can see but cannot fix. */
  warning?: string;
  /** Terse marker: `exitCode` covers only part of a compound command. */
  exitCaveat?: string;
  /** The full explanation, shown once per session so it cannot become noise. */
  exitCaveatNote?: string;
  /** null when the command did not finish (timed out or is awaiting input). */
  exitCode: number | null;
  /** Combined stdout+stderr for this command only, ANSI-stripped. */
  output: string;
  timedOut: boolean;
  /**
   * True when the command is parked on a prompt. This is a handoff signal,
   * not a failure: a human should attach and answer.
   */
  needsInput: boolean;
  state: SessionState;
  /** Byte offset in the log where this command's output began. */
  logOffset: number;
  /**
   * The command ended the session's shell (it contained `exit`, or killed the
   * shell some other way). Commands run in the session's own shell so that
   * `cd` and `export` persist, which means `exit` really does exit. The pane is
   * held by `remain-on-exit` and respawned on the next call, so the session
   * survives — but this command's exit code comes from the shell, not `.rc`.
   */
  shellExited?: boolean;
  /**
   * The pane was resized since this session's previous command.
   *
   * The one condition in the hub that can silently corrupt output, and until
   * now the one with no runtime signal: a human attaching to answer a password
   * prompt resizes the pane, so a column layout calibrated before the handoff
   * reads differently after it. Two agents hit it; the second put it plainly —
   * "the errors are excellent; the silent state changes are the gap".
   */
  paneWidthChanged?: {
    from: number;
    to: number;
    /** Every distinct width seen, when tmux recorded more than the endpoints. */
    seen?: number[];
    /** False once the long explanation has been given for this session. */
    explain?: boolean;
  };
  /**
   * Present when the command is still running (a prompt or a timeout). Pass it
   * to `poll` to pick the same command back up rather than re-running it.
   */
  handle?: string;
  /** Set when a dropped remote connection was being re-established. */
  reconnecting?: boolean;
  /**
   * This command hit a wall only a human can pass — a password, a passphrase,
   * a privilege check — and a request for that human has ALREADY been raised.
   *
   * The hub exists so an agent can hand work back to a person instead of
   * abandoning it. Relying on the agent to notice and volunteer is the part
   * that fails: it is far easier to write "I could not verify this" and move
   * on. So the detection is the system's job, not the agent's discipline, and
   * it fires whether or not the agent was paying attention.
   */
  needsHuman?: string;
  /**
   * This command ran in a shell the hub did not set up — a nested `bash`, a
   * `docker exec`, a `sudo -i` — so it used the fallback wrapper.
   *
   * Reported because the human usually cannot see it. A nested bash inherits
   * the same PS1, so the prompt is identical and the only visible change is
   * that the hub's command lines suddenly look different. Set once, on the
   * transition, rather than on every command.
   */
  fallbackShell?: boolean;
  /**
   * The output could not be framed, so `output` is NOT trustworthy.
   *
   * `extractBetweenMarkers` returns an empty string when it cannot find this
   * command's start marker, and that was handed back as the command's output
   * beside `exit_code: 0` — identical in shape to a command that genuinely
   * printed nothing. An agent running `netstat | grep LISTEN` got exit 0 and
   * no output and was one step from reporting "no listening ports"; a `read` a
   * moment later showed sixteen.
   *
   * Set when the markers had not both arrived within the flush window. Re-read
   * with `read --since <logOffset>` rather than trusting `output`.
   */
  captureIncomplete?: boolean;
}

export interface StartResult {
  session: string;
  command: string;
  /** Opaque handle for `poll`. Internally the same nonce the blocking path uses. */
  handle: string;
  /** Byte offset to pass as the first `poll(..., since)`. */
  offset: number;
  /**
   * A hazard in the command itself, same as `run` reports.
   *
   * `start` computed none at all, so a command whose stderr was discarded ran
   * silently here while the identical command through `run` was flagged. A
   * cold agent lost 50 GB from a `du` total that way — the guard existed and
   * simply was not wired to this path.
   */
  warning?: string;
  /**
   * Present and false when the frame never confirmed it opened.
   *
   * `start` could not fail: it sent the wrapper and returned a handle
   * unconditionally, so a shell without the hub's helper produced
   * "__ath: command not found" while the caller got a handle, an offset and a
   * note about polling that were indistinguishable from success. The handle
   * then belonged to a command that had never run. Absent means confirmed.
   */
  launched?: boolean;
}

export interface PollResult {
  session: string;
  handle: string;
  done: boolean;
  /** Set once `done`; null if the command ended without a recoverable status. */
  exitCode: number | null;
  /** Only output produced since the requested offset. */
  output: string;
  /** Pass as `since` on the next poll. */
  nextOffset: number;
  /**
   * Bytes dropped from the MIDDLE of `output` because it exceeded the cap.
   *
   * Present only when something was dropped. `omittedResumeFrom` is the
   * `since` that returns them, so the gap is recoverable and this is
   * pagination rather than truncation — reading it is a choice, not a
   * consolation. `nextOffset` still points at the END, so an ordinary follow
   * loop carries on live and does not have to detour.
   */
  omittedBytes?: number;
  /** The `since` that returns what `omittedBytes` counts. */
  omittedResumeFrom?: number;
  /**
   * Output that was TRIMMED AWAY before this call and cannot be returned.
   *
   * A session log is rewritten to its last 8 MB once it passes 32 MB, which
   * invalidates every offset issued before that. Silence here used to be the
   * only signal: the caller got empty output and a `nextOffset` smaller than
   * the `since` it passed, and was left to work out that ~38 MB of its job had
   * gone. `output` resumes from the earliest byte that survives.
   */
  lostBytes?: number;
  /** The `since` was past the end — a stale handle, or another incarnation. */
  offsetBeyondEnd?: boolean;
  /**
   * The remote session's ssh link dropped while this command was running.
   *
   * `done` is true and `exitCode` null: the command is gone and its outcome is
   * unknowable. Reported because the alternative was reporting it as still
   * running forever — a dropped link does not kill the pane, it falls back to
   * the local shell, so nothing looked dead and no end marker ever came.
   */
  remoteDisconnected?: boolean;
  /**
   * The pane was resized while this command ran, or since the last observation.
   *
   * Only `run` ever reported this, so a job driven by start/poll — the one a
   * human is most likely to attach to — never learned. Reported on every poll
   * while it differs, and the baseline only moves on the poll that reports
   * `done`, so a polling loop cannot swallow the notice before a later `run`
   * sees it.
   */
  paneWidthChanged?: { from: number; to: number; seen?: number[]; explain?: boolean };
  state: SessionState;
  needsInput: boolean;
  /**
   * How long this command has been running, in seconds.
   *
   * A one-second job and a sixty-seven-second job returned IDENTICAL shapes,
   * so an agent that started something it believed was long-running had no way
   * to notice it had finished instantly — and would report the work done. The
   * only reason one caught it was that it had wrapped the command in its own
   * timer. The duration is knowable here; not saying it made a silent wrong
   * answer the default.
   */
  elapsedSeconds?: number;
  /**
   * True when `elapsedSeconds` is the real running time; false when it is only
   * an upper bound (the command had already finished when we first looked).
   */
  elapsedExact?: boolean;
  /** Bracket for a finished command: it took at least this long. */
  elapsedLowerSeconds?: number;
  /** Bracket for a finished command: and no longer than this. */
  elapsedUpperSeconds?: number;
  /** True when a poll actually saw the command running, which raises the floor. */
  elapsedObserved?: boolean;
  /** A problem with how this poll was called that the hub can see but not fix. */
  warning?: string;
}

export interface CreateOptions {
  name?: string;
  cwd?: string;
  /** Defaults to the creating process's cwd. See `Session.origin`. */
  origin?: string;
  /** Defaults to the creating process's ancestor chain. See `Session.creatorPids`. */
  creatorPids?: number[];
  /** Host to `ssh` into as the session's first act. */
  remote?: string;
  pin?: boolean;
  owner?: string;
  label?: string;
  /**
   * Pane columns. Defaults to 200.
   *
   * Worth setting wide when output will be PARSED: tmux truncates to the pane,
   * so `lsblk -o …,MOUNTPOINT` printed its header as `MOUNTPOIN` at 156
   * columns and anything read by column position would have been silently
   * wrong. An agent hit exactly that and could find no lever for it.
   *
   * It is not a guarantee. `window-size latest` means a human attaching sets
   * the size — which is the correct trade for a terminal they share, and why
   * one session measured 156 (a person attached to type a password) while its
   * sibling stayed at 200. For output you intend to parse, prefer a format
   * that does not depend on width at all: `--json`, `--format`, `-o`.
   */
  width?: number;
  height?: number;
}

export interface RunOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** Wait for a busy session to go idle instead of throwing. */
  waitForIdle?: boolean;
  /**
   * Cap on the output handed back, in bytes. Defaults to the same 64 KiB
   * `poll` and `read` use; 0 returns everything.
   *
   * `run` was the one surface with no context guard, which made the tool most
   * likely to flood exactly where a caller was least expecting it.
   */
  maxBytes?: number;
}

export interface StateChange {
  name: string;
  previous: SessionState | 'gone';
  current: SessionState | 'gone';
  session?: Session;
}
