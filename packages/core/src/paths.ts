import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Dedicated tmux socket, so the hub can never disturb the user's own tmux server. */
export const SOCKET = process.env.ATH_SOCKET || 'ath';

/** Every hub session is namespaced, so we never touch a session we did not create. */
export const PREFIX = 'ath-';

export const ATH_HOME = process.env.ATH_HOME || path.join(os.homedir(), '.ath');

export const LOG_DIR = path.join(ATH_HOME, 'log');
export const RC_DIR = path.join(ATH_HOME, 'rc');
export const HELPER_PATH = path.join(ATH_HOME, 'helper.sh');
export const TMUX_CONF = path.join(ATH_HOME, 'tmux.conf');
export const NOTIFY_LOG = path.join(ATH_HOME, 'notify.log');

/** Above this, a log is trimmed; below `LOG_KEEP_BYTES` is what survives. */
export const LOG_MAX_BYTES = 32 * 1024 * 1024;
const LOG_KEEP_BYTES = 8 * 1024 * 1024;

/**
 * `notify.log` is append-only diagnostics from the editor extension, written
 * on a path that never consults the session lock. It reached 6 MB and 55,000
 * lines in four days of ordinary use with nothing in the system bounding it —
 * the same failure as an untrimmed session log, in a file `purge` cannot see.
 *
 * Rotated rather than aged out: it is the record you want AFTER a bug, so
 * dropping the oldest lines by date discards exactly the ones that explain how
 * a wedged request got that way.
 */
export const NOTIFY_MAX_BYTES = 1024 * 1024;

/**
 * Everything the hub leaves on this machine, and whether `purge` removes it.
 *
 * Exists because the honest answer to "what did that record?" was scattered
 * across six modules, and the two surfaces that should have given it — `kill`
 * and `purge` — described a fraction of it. `purge` in particular reads as the
 * thing you run when a secret lands, while touching exactly one file out of a
 * thousand.
 *
 * Declared here rather than assembled from each module's own constant because
 * those modules import THIS one; reaching back for them would be a cycle. The
 * cost is that a new directory has to be added in two places, which the
 * contract check in scripts/verify.sh enforces.
 */
export interface AthArtifact {
  /** Path relative to ~/.ath. */
  name: string;
  absolute: string;
  /** What a reader would find in it. */
  holds: string;
  /** Removed by `ath purge`? */
  purged: boolean;
  /**
   * Could a reader reconstruct something about what was done here?
   *
   * The distinction `purge` has to draw is not "file vs directory" but "leaves
   * a trace vs does not". `tmux.conf` surviving a purge is uninteresting;
   * `requests/` surviving it is not, because its reason text quotes the command.
   */
  sensitive: boolean;
  /** How it is bounded, when nothing else removes it. */
  bounded: string;
}

export const ATH_ARTIFACTS: readonly AthArtifact[] = [
  {
    name: 'log/',
    // Named for the DIRECTORY, because that is what the reported size measures.
    // Labelled `log/<session>.log` it read as one file while showing the total
    // for all of them — a number that silently answered a different question.
    absolute: LOG_DIR,
    holds: 'one <session>.log per session — every command run, and every byte it printed',
    purged: true,
    sensitive: true,
    // Says "each file" because the size printed beside it is the DIRECTORY's.
    //
    // The same mistake this entry's own name comment describes, one field over:
    // a per-file bound rendered next to an aggregate reads as a bound on the
    // aggregate. It is not one. Sessions are never reaped — `kill` keeps the
    // transcript on purpose — so the directory only grows, and two reviewers
    // reported the growth while looking straight at a line that appeared to
    // promise a ceiling. Nothing here lied; the layout answered a question
    // nobody asked.
    bounded:
      `each file trimmed to the last ${LOG_KEEP_BYTES / 1024 / 1024} MiB above ` +
      `${LOG_MAX_BYTES / 1024 / 1024} MiB. The DIRECTORY has no ceiling — ` +
      `reclaim with: ath purge --dead`,
  },
  {
    name: 'rc/',
    absolute: RC_DIR,
    holds: 'per-command sentinels — exit codes, timing, first-run flags. No command text',
    purged: false,
    sensitive: true,
    bounded: 'reaped after 6h',
  },
  {
    name: 'requests/',
    absolute: path.join(ATH_HOME, 'requests'),
    holds: 'open and recently-answered human requests. The reason text QUOTES the command',
    // Covered by `purge` now, for the purged session only — same scope as the
    // log itself. It was `false` while holding the command text verbatim, so
    // the one command you would run after leaking a secret cleaned the
    // transcript and left the quote.
    purged: true,
    sensitive: true,
    bounded: 'resolved requests expire after 1h',
  },
  {
    name: 'claim/',
    absolute: path.join(ATH_HOME, 'claim'),
    holds: 'which editor window owns a request — pid and timestamp only',
    purged: false,
    sensitive: false,
    bounded: 'cleared when the request resolves',
  },
  {
    name: 'election/',
    absolute: path.join(ATH_HOME, 'election'),
    holds: 'leader election between editor windows',
    purged: false,
    sensitive: false,
    bounded: 'transient',
  },
  {
    name: 'lock/',
    absolute: path.join(ATH_HOME, 'lock'),
    holds: 'per-session mutexes',
    purged: false,
    sensitive: false,
    bounded: 'transient',
  },
  {
    name: 'ssh/',
    absolute: path.join(ATH_HOME, 'ssh'),
    holds: 'ssh ControlMaster sockets and generated config. Hostnames, no credentials',
    purged: false,
    sensitive: true,
    bounded: 'sockets close with the connection',
  },
  {
    name: 'notify.log',
    absolute: NOTIFY_LOG,
    holds: 'UI notification diagnostics — session names and request ids',
    purged: false,
    sensitive: true,
    bounded: 'rotated at 1 MiB, one generation kept as notify.log.1',
  },
  {
    name: 'helper.sh',
    absolute: HELPER_PATH,
    holds: 'the generated shell helper. No session data',
    purged: false,
    sensitive: false,
    bounded: 'regenerated',
  },
  {
    name: 'tmux.conf',
    absolute: TMUX_CONF,
    holds: 'the generated tmux config. No session data',
    purged: false,
    sensitive: false,
    bounded: 'regenerated',
  },
];

export function logPath(name: string): string {
  return path.join(LOG_DIR, `${name}.log`);
}

export interface DeadLogSweep {
  /** Transcripts removed. */
  removed: number;
  /** Bytes reclaimed. */
  bytes: number;
  /** Transcripts left alone because their session is still alive. */
  live: number;
}

/**
 * Delete transcripts belonging to sessions that no longer exist.
 *
 * The directory had no way to shrink. Every other artifact is reaped, rotated
 * or expires; `log/` was the one that only grew, and it is the largest by two
 * orders of magnitude — 648 files and 57 MiB on the development machine, across
 * sessions that had been dead for days.
 *
 * NOT automatic, and that is the whole design. `kill` prints "transcript kept"
 * and means it: the record outliving the session is the point, because the
 * question "what did that thing actually do?" is usually asked after it is
 * gone. A reaper on a timer would answer that question with silence, and would
 * do it to a transcript someone was keeping deliberately. So this runs only
 * when a human types `ath purge --dead`, and it refuses to touch anything whose
 * session is still in tmux.
 *
 * Takes the live set as an argument because `session.ts` imports THIS module;
 * asking it for the list here would be a cycle. Same reason, same shape, as
 * `pruneRequests`.
 */
export async function reapDeadLogs(liveSessions: Set<string>): Promise<DeadLogSweep> {
  const sweep: DeadLogSweep = { removed: 0, bytes: 0, live: 0 };
  let entries: string[];
  try {
    entries = await fs.readdir(LOG_DIR);
  } catch {
    return sweep;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.log')) continue;
    const name = entry.slice(0, -'.log'.length);
    if (liveSessions.has(name)) {
      sweep.live++;
      continue;
    }
    const file = path.join(LOG_DIR, entry);
    try {
      sweep.bytes += (await fs.stat(file)).size;
      await fs.unlink(file);
      sweep.removed++;
    } catch {
      continue; // raced, or not ours to remove — leave the watermark alone too
    }
    // The trim watermark counts bytes discarded from a file that is now gone.
    // Left behind, it would be read as the baseline for a NEW session reusing
    // the name, whose offsets would then all be reported shifted by a number
    // belonging to its predecessor.
    await fs.unlink(trimMarkPath(name)).catch(() => undefined);
  }
  return sweep;
}

/**
 * Where tmux records this session's pane resizes.
 *
 * Named by TMUX session (`ath-foo`), not the logical one, because the hook
 * writing it only has `#{session_name}` to work with and cannot strip the
 * prefix. One conversion, here, rather than a rule every reader must remember.
 */
export function widthLogPath(name: string): string {
  return path.join(RC_DIR, `${tmuxName(name)}.width`);
}

/** Set once the long width-change explanation has been shown for a session. */
export function widthNoteFlagPath(name: string): string {
  return path.join(RC_DIR, `${name}.wnote`);
}

/**
 * The tmux command that makes resizes observable at all.
 *
 * Set as a COMMAND at session creation, deliberately, not written into
 * tmux.conf. A running tmux server does not reread its config — verified — so
 * a conf-only hook would not take effect until the server next restarted,
 * which for a long-lived hub is approximately never. `set-hook -g` applies to
 * the live server immediately.
 *
 * It also keeps the riskiest file in the project out of this entirely: a
 * malformed line in tmux.conf breaks session creation for EVERY session and
 * survives restarts, whereas a rejected `set-hook` fails alone and leaves the
 * session working.
 *
 * The path is double-quoted inside the single-quoted shell command inside the
 * double-quoted tmux string, because a home directory may contain a space —
 * tested with one, since this is exactly the shape of quoting that ships
 * broken.
 */
export function resizeHookCommand(): string[] {
  return [
    'set-hook',
    '-g',
    'window-resized',
    `run-shell 'echo #{pane_width} >> "${RC_DIR}/#{session_name}.width"'`,
  ];
}

/** Where the discard watermark for a session lives, beside its log. */
export function trimMarkPath(name: string): string {
  return path.join(LOG_DIR, `${name}.trim`);
}

/**
 * How many bytes have ever been discarded from the head of this session's log.
 *
 * The number that makes a byte offset mean something for longer than one trim.
 *
 * `rotateIfNeeded` rewrites the log in place keeping the tail, so every offset
 * issued before it becomes a lie — and silently, in two different ways. An
 * offset PAST the new end reads nothing, which looks like "no new output"; an
 * offset BEFORE it reads real bytes that are now some entirely different part
 * of the session. An agent following a 46 MB job hit the first: it polled at
 * the exact offset the hub had told it to use, got empty output and a
 * `next_offset` SMALLER than the `since` it passed, and no warning of any
 * kind. Roughly 38 MB of its output was unrecoverable, under a documented
 * promise that nothing would be lost.
 *
 * Counting what was thrown away turns physical positions into LOGICAL ones —
 * bytes since this incarnation of the session began. Those survive a trim, so
 * the follow loop keeps working across one instead of breaking; and when the
 * bytes really are gone, `since < discarded` says so exactly rather than
 * leaving the caller to infer it from a smaller number.
 *
 * Zero when the file is missing, which is every session that predates this and
 * every session that has never been trimmed — so offsets are unchanged for all
 * of them.
 */
export async function discardedBytes(name: string): Promise<number> {
  try {
    const value = Number((await fs.readFile(trimMarkPath(name), 'utf8')).trim());
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** Record that `bytes` more were discarded. Callers hold the session lock. */
async function addDiscardedBytes(name: string, bytes: number): Promise<void> {
  if (bytes <= 0) return;
  const total = (await discardedBytes(name)) + bytes;
  await fs.writeFile(trimMarkPath(name), String(total), { mode: 0o600 }).catch(() => undefined);
}

/** Start this session's offsets from zero again. For a fresh incarnation only. */
export async function resetDiscardedBytes(name: string): Promise<void> {
  await fs.rm(trimMarkPath(name), { force: true }).catch(() => undefined);
}

export function rcPath(nonce: string): string {
  return path.join(RC_DIR, `${nonce}.rc`);
}

export function tmuxName(name: string): string {
  return name.startsWith(PREFIX) ? name : PREFIX + name;
}

export function logicalName(tmux: string): string {
  return tmux.startsWith(PREFIX) ? tmux.slice(PREFIX.length) : tmux;
}

/**
 * Sourced into every session's shell at creation. Keeping the wrapper in a
 * function means the line tmux echoes is short (`__ath a1b2 'npm test'`)
 * instead of a wall of marker plumbing, which keeps the human's pane readable.
 *
 * Marker ordering matters: the end marker is printed BEFORE the .rc file is
 * written, so by the time a watcher observes the .rc the marker is already
 * on its way through pipe-pane. Markers are erased with \r\033[K, so the log
 * keeps the bytes while the pane shows nothing.
 */
/**
 * The wrapper, as one line.
 *
 * One line because it has to be injectable through `send-keys` into whatever
 * shell the pane currently holds — including a shell on the far side of an
 * ssh hop or a `docker exec`, where nothing was sourced at session creation.
 *
 * No `local`, and no rc file. `local` is absent from some POSIX shells we may
 * land in; the rc file is worse, because a nested shell writes it to ITS
 * filesystem, which the poller cannot see. The exit code therefore travels
 * inside the end marker, through the PTY, which is the one channel that
 * reaches back no matter how many shells deep the command ran.
 *
 * The end marker also carries the working directory, base64. That is what lets
 * a dropped ssh session be put back where it was: once the link dies there is
 * nothing left to ask, so the directory has to have already travelled back.
 * Without it a reconnect silently reset the remote shell to $HOME while still
 * reporting success, so a command written for one directory ran in another.
 *
 * base64 because its alphabet is `A-Za-z0-9+/=` — it cannot contain the `:` or
 * `>` delimiters, so no path can break marker parsing. It degrades to empty if
 * `base64` is missing, and the parser treats the field as optional, so a shell
 * without it still reports exit codes.
 *
 * NOTHING is written to the far host. That is a hard rule, not an oversight:
 * the hub is used across many machines with no per-host setup, so it must
 * leave no trace on any of them. Everything it needs comes back through the
 * PTY, which is why the same protocol works locally, over ssh and inside a
 * container.
 *
 * The environment is therefore NOT restored after a dropped connection. It
 * would need state outliving the shell — a remote file (an artifact) or the
 * whole environment sent back through the PTY (a base64 wall in the pane and
 * every exported secret copied into the local log). Both are worse than doing
 * without. The working directory still rides in the marker, and `reconnecting`
 * warns the caller that the shell is a new process.
 *
 * The marker erase is wrap-aware, but only when `COLUMNS` is known:
 * over-erasing would delete real output, which is worse than a leftover.
 *
 * It does NOT try to rewrite the line the shell echoed. That was tried — a
 * `\033[A\r\033[K` to replace `__ath 9f2c1a 'npm test'` with `$ npm test` —
 * and it only works when the echoed line fits one row. Real commands are
 * hundreds of characters and wrap over several, so moving up ONE row cleared
 * the last row and left the rest, printing BOTH the truncated wrapper and the
 * rewritten line. Worse than doing nothing.
 *
 * Erasing it correctly needs the prompt's printed width, which this function
 * cannot know — `dev@host:~$` and `dev@host:~/a/deep/path$` differ by 18
 * columns, so any measured value goes stale on the next `cd`, and guessing
 * high deletes real output. Suppressing the echo at the terminal (`stty
 * -echo`) is the approach that can actually work, and belongs in the hub, not
 * here.
 */
export const HELPER_ONELINE =
  `__ath() { __ath_n="$1"; shift; ` +
  `printf '\\036<ATHS:%s>\\036\\r\\033[K' "$__ath_n"; ` +
  // The command times ITSELF. See ATHD below.
  `__ath_t0=$(date +%s 2>/dev/null); ` +
  `eval "$@"; __ath_rc=$?; ` +
  `__ath_m="<ATHE:$__ath_n:$__ath_rc:$(pwd 2>/dev/null | base64 2>/dev/null | tr -d '\\n'):$(command -v __ath_bpost >/dev/null 2>&1 || command -v __ath_post >/dev/null 2>&1 && echo 1 || echo 0)>"; ` +
  `printf '\\036%s\\036\\r\\033[K' "$__ath_m"; ` +
  `if [ -n "$__ath_t0" ]; then printf '\\036<ATHD:%s:%s>\\036\\r\\033[K' "$__ath_n" "$(( $(date +%s) - __ath_t0 ))"; __ath_t0=""; fi; ` +
  `if [ -n "$COLUMNS" ]; then __ath_r=$(( \${#__ath_m} / COLUMNS )); ` +
  `while [ "$__ath_r" -gt 0 ]; do printf '\\033[A\\033[2K'; __ath_r=$((__ath_r-1)); done; fi; ` +
  `return $__ath_rc; }`;

/**
 * The readable entry point: reads the command from a file and announces it.
 *
 * Exists to keep the SHELL'S echo short. Typing the command inline means the
 * shell draws `__ath 9ccdbe7cf707 'set +H; echo ...'` — often 400 characters
 * wrapping over several rows — and that echo cannot be restyled or erased,
 * because the shell drew it before any of our code ran. Typing `agent_command`
 * instead is 13 characters that can never wrap, and the command is then
 * printed BY US, where we control it completely.
 *
 * The announcement is deliberately printed before the start marker, so it sits
 * outside the range `extractBetweenMarkers` returns and never pollutes output.
 *
 * Delegates to `__ath` rather than duplicating it, so the inline path stays the
 * single implementation of the protocol and remains the fallback wherever the
 * hub cannot reach the shell's filesystem — inside `docker exec`, a nested
 * container, a shell it did not set up.
 */

/**
 * Framing from the shell's own hooks, so the command never has to be wrapped.
 *
 * The wrapper exists only to print markers around a command. Shells already run
 * hooks around every command, so moving the markers there lets the hub type the
 * command almost bare — `: a1b2c3; npm test` instead of
 * `__ath b75ca6d2de4d 'npm test'`. The shell echoes what is typed and that echo
 * can be neither restyled nor erased, so making it short is the only lever
 * there is, and this is the shortest it can be while staying unambiguous.
 *
 * `: <nonce>;` rather than a trailing `# <nonce>` comment: zsh has
 * `interactive_comments` OFF by default, so a trailing comment is passed to the
 * command as an argument and silently changes what runs. `:` is the POSIX null
 * command, valid everywhere, and it runs FIRST so the exit code the caller
 * receives is still the real command's.
 *
 * Hooks are ADDED, never assigned: `add-zsh-hook` for zsh, and bash's
 * PROMPT_COMMAND is appended to. Overwriting either would break a user's
 * existing prompt on every machine the hub touches.
 *
 * Commands the HUMAN types are framed too, with an `h<n>` id. That is a
 * capability rather than a side effect: the hub can finally see what its human
 * ran and what it returned, in a terminal it calls shared.
 *
 * Self-detecting so one line covers both shells, and a shell that is neither
 * simply installs nothing and falls back to the wrapper.
 */
const HOOKS_BOTH =
  `if [ -n "$ZSH_VERSION" ]; then ` +
  // A no-op so the tag LINE is a valid command in this shell and prints no
  // error. The nonce is not taken from here — both shells parse it from the
  // line itself — so a shell that lacks this still frames correctly.
  `\u2193\u2193\u2193() { :; }; ` +
  `__ath_pending=""; __ath_n=""; __ath_h=0; ` +
  // Match the tag line EXACTLY, anchored at its first character.
  //
  // A `*"AGENT INPUT ID"*` substring match also matched real commands that
  // merely CONTAIN the phrase — `echo "AGENT INPUT ID: fake"`, or a grep for it
  // in a log. Those were then skipped, emitted no markers, looked lost, and
  // were re-sent through the wrapper: run twice. The tag always begins with the
  // arrows, so requiring them costs nothing and makes a command's own text
  // incapable of impersonating the hub.
  `__ath_pre() { case "$1" in "\u2193\u2193\u2193 AGENT INPUT ID: "*) ` +
  `__ath_pending="\${1#*AGENT INPUT ID: }"; __ath_pending="\${__ath_pending%% *}"; ` +
  // A nonce is 12 lowercase hex characters. Anything else is not one.
  `case "$__ath_pending" in ""|*[^0-9a-f]*) __ath_pending="" ;; ` +
  `*) printf '\\036<ATHT:%s>\\036\\r\\033[K' "$__ath_pending" ;; esac; return ;; esac; ` +
  `if [ -n "$__ath_pending" ]; then __ath_n="$__ath_pending"; __ath_pending=""; ` +
  `else __ath_h=$((__ath_h+1)); __ath_n="h$__ath_h"; fi; ` +
  `printf '\\036<ATHS:%s>\\036\\r\\033[K' "$__ath_n"; __ath_t0=$(date +%s 2>/dev/null); }; ` +
  `__ath_post() { __ath_rc=$?; [ -n "$__ath_n" ] || return; ` +
  `printf '\\036<ATHE:%s:%d:%s>\\036\\r\\033[K' "$__ath_n" "$__ath_rc" "$(pwd 2>/dev/null | base64 2>/dev/null | tr -d '\\n')"; ` +
  `if [ -n "$__ath_t0" ]; then printf '\\036<ATHD:%s:%s>\\036\\r\\033[K' "$__ath_n" "$(( $(date +%s) - __ath_t0 ))"; __ath_t0=""; fi; ` +
  `__ath_n=""; }; ` +
  `autoload -Uz add-zsh-hook; add-zsh-hook preexec __ath_pre; add-zsh-hook precmd __ath_post; ` +
  `elif [ -n "$BASH_VERSION" ]; then ` +
  // bash frames from PROMPT_COMMAND ALONE — no DEBUG trap.
  //
  // The trap was the wrong instrument twice over. It fires "before every
  // SIMPLE command", so a compound one — `(exit 33)`, `{ ...; }` — never fires
  // it in the parent shell and could not be framed at all. And because bash
  // runs PROMPT_COMMAND as a string in the current shell, the trap also fired
  // for our own bookkeeping, consuming the nonce meant for the next command:
  // whether framing landed on the right line was a race.
  //
  // PROMPT_COMMAND runs after EVERY command whatever its syntax, so one hook
  // closes the previous frame and opens the next. zsh keeps preexec/precmd,
  // which have neither problem.
  // A no-op so the tag LINE is a valid command in this shell and prints no
  // error. The nonce is not taken from here — both shells parse it from the
  // line itself — so a shell that lacks this still frames correctly.
  `\u2193\u2193\u2193() { :; }; ` +
  `__ath_pending=""; __ath_n=""; __ath_h=0; ` +
  // The depth of the shell we integrated. Exported, so a child can tell how far
  // below it sits; `:-` keeps the ORIGINAL value when a child re-runs this.
  `__ath_lvl0=\${__ath_lvl0:-\$SHLVL}; export __ath_lvl0; ` +
  `__ath_bpost() { __ath_rc=$?; ` +
  // Mark the prompt when this shell is not the one we set up.
  //
  // A nested bash inherits the same PS1, so `dev@server:/var/log$` looks
  // identical whether it is the ssh shell or three levels below it — the human
  // has no way to know a plain `exit` will not log them out, or why the hub is
  // behaving differently. One `\u21b3` per level down, prepended once.
  //
  // Deliberately additive: the rest of the prompt is left exactly as the host
  // configured it, colours and all.
  // Marked by DEPTH only, with no shell-type label.
  //
  // A label was tried and removed. Only bash runs these hooks, so it could only
  // ever say one word — and on a host whose login shell IS bash, which is the
  // ordinary case, it never appeared at all. That left code that could only
  // fire on a host nobody here could test without changing its login shell.
  // The arrow is the part that carries real information: you are not in the
  // shell you started in, and a plain `exit` will not log you out.
  `if [ -z "$__ath_ps1" ] && [ "\${SHLVL:-1}" -gt "\${__ath_lvl0:-1}" ]; then __ath_ps1=1; ` +
  `__ath_d=$((SHLVL-__ath_lvl0)); __ath_mk=""; ` +
  // The arrow is built from an OCTAL ESCAPE, never typed as a literal.
  //
  // Remote hooks travel base64-encoded and arrive byte-exact, but local hooks
  // are typed into the shell — and a multibyte character sent that way came
  // back mangled, rendering the depth marker as replacement characters. Octal
  // escapes keep the whole payload ASCII, so no transport can corrupt it.
  `__ath_ar="$(printf '\\342\\206\\263')"; ` +
  `while [ "$__ath_d" -gt 0 ]; do __ath_mk="$__ath_mk$__ath_ar"; __ath_d=$((__ath_d-1)); done; ` +
  `PS1="$__ath_mk $PS1"; fi; ` +
  `[ -n "$__ath_n" ] && { printf '\\036<ATHE:%s:%d:%s:%s>\\036\\r\\033[K' "$__ath_n" "$__ath_rc" "$(pwd 2>/dev/null | base64 2>/dev/null | tr -d '\\n')" "$__ath_env"; ` +
  `if [ -n "$__ath_t0" ]; then printf '\\036<ATHD:%s:%s>\\036\\r\\033[K' "$__ath_n" "$(( $(date +%s) - __ath_t0 ))"; __ath_t0=""; fi; ` +
  `__ath_n=""; }; ` +
  // bash has no preexec, so the tag is recovered from history instead. It is
  // the line that just ran, by definition, and reading it needs nothing typed.
  `__ath_last="$(HISTTIMEFORMAT= history 1 2>/dev/null)"; ` +
  // Carry a HUMAN's assignment so a reconnect can restore it.
  //
  // The hub replays assignments IT issued; anything typed straight into the
  // terminal lived only in the shell the dropped link took away. The command
  // that just ran is already in hand for the tag, so recognising an assignment
  // costs nothing, and the marker has room for one more field.
  //
  // The pattern is written with a QUOTED prefix, not `export\ `: an unquoted
  // space ends a case-pattern word, and a backslash-space does not survive a
  // TypeScript template literal — that exact escaping shipped a payload the
  // shell echoed instead of running.
  '__ath_env=""; __ath_cmd="\${__ath_last#*[0-9]  }"; ' +
  // A REGEX, not a glob. `[A-Za-z_]*=*` looks like "a name, then =", but glob
  // `*` spans anything: it matched every command containing an `=` anywhere —
  // including the base64 padding inside a wrapper invocation, which was then
  // captured as if it were a variable and stuffed into every end marker.
  // The anchored form requires the `=` to follow the name immediately.
  'if [[ "$__ath_cmd" =~ ^(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*= ]]; then ' +
  '__ath_env="$(printf %s "$__ath_cmd" | base64 2>/dev/null | tr -d \'\\n\')"; fi; ' +
  `case "$__ath_last" in *"\u2193\u2193\u2193 AGENT INPUT ID: "*) ` +
  `__ath_pending="\${__ath_last#*AGENT INPUT ID: }"; __ath_pending="\${__ath_pending%% *}"; ` +
  `case "$__ath_pending" in ""|*[^0-9a-f]*) __ath_pending="" ;; ` +
  `*) printf '\\036<ATHT:%s>\\036\\r\\033[K' "$__ath_pending" ;; esac ;; esac; ` +
  `if [ -n "$__ath_pending" ]; then __ath_n="$__ath_pending"; __ath_pending=""; ` +
  `else __ath_h=$((__ath_h+1)); __ath_n="h$__ath_h"; fi; ` +
  `printf '\\036<ATHS:%s>\\036\\r\\033[K' "$__ath_n"; __ath_t0=$(date +%s 2>/dev/null); }; ` +
  // FIRST in the chain: `$?` at entry is the real command's status, and
  // anything running ahead of us would overwrite the exit code we exist to
  // carry. Still appended, never assigned — a user's prompt keeps working.
  // bash has no preexec, so the tag is read back from history: it is the
  // line that just ran, by definition, and reading it needs nothing typed.
  `__ath_last="$(HISTTIMEFORMAT= history 1 2>/dev/null)"; ` +
  `case "$__ath_last" in *": \u2193\u2193\u2193 AGENT INPUT ID: "*) ` +
  `__ath_pending="\${__ath_last#*AGENT INPUT ID: }"; __ath_pending="\${__ath_pending%% *}"; ` +
  `case "$__ath_pending" in ""|*[^0-9a-f]*) __ath_pending="" ;; ` +
  `*) printf '\\036<ATHT:%s>\\036\\r\\033[K' "$__ath_pending" ;; esac ;; esac; ` +
  `PROMPT_COMMAND="__ath_bpost\${PROMPT_COMMAND:+; $PROMPT_COMMAND}"; ` +
  // Hand the whole kit to child shells, functions included.
  //
  // PROMPT_COMMAND arrives through the ssh environment, so it is already
  // exported — but bash exports variables and NOT functions, so a nested
  // `bash` inherited the name `__ath_bpost` with nothing behind it and printed
  // "command not found" at every prompt it drew. Exporting the functions too
  // closes that gap and does much more: a nested shell comes up ALREADY
  // integrated, with nothing typed into it.
  //
  // That is what makes `bash` inside an ssh session invisible. Before this the
  // hub had to notice the hooks were missing, print an error, type a
  // 400-character wrapper into the shared console, and then show every command
  // as `__ath <nonce> '…'` instead of as itself. Now the child just works.
  //
  // Safe for non-bash children: zsh, dash and sh ignore both PROMPT_COMMAND and
  // bash's function-export encoding. And it stays shell state — nothing is
  // written to any disk, so a remote host is left exactly as it was found.
  // The tag no-op goes too, or a child shell inherits the hooks WITHOUT it
  // and every tag line answers "command not found" — 38 times in one battery.
  `export -f \u2193\u2193\u2193 __ath_bpost 2>/dev/null; export PROMPT_COMMAND 2>/dev/null; ` +
  `fi`;

/**
 * `<ATHD:nonce:seconds>` — the command's OWN measurement of how long it took.
 *
 * A separate marker rather than a field appended to `<ATHE:…>`, because that
 * marker already carries a variable number of optional trailing fields whose
 * meaning depends on which shell emitted it (the wrapper's fourth field is a
 * 0/1 flag, bash's is base64). A fifth would be ambiguous with both. A new
 * marker type collides with nothing, and any parser that does not know it
 * simply skips it.
 *
 * It exists because the hub's own estimate was not merely imprecise, it was
 * useless, and three cold agents said so independently: a 47s job reported as
 * 256s, a 44s job as a 170-second-wide bracket, and the same 44s job as
 * [38,185] — "worse than no number", "decoration, not data". Every one of them
 * ended up timing commands by hand with `date +%s`, which is precisely what
 * this now does for them.
 *
 * The hub could only ever report when it LOOKED. The shell that ran the
 * command knows when it started and when it stopped, on one clock, so there is
 * no observation window and no skew to correct for.
 *
 * Degrades silently: a shell without `date` sets no start time, emits no
 * marker, and the caller falls back to the observation bracket as before.
 */
export function durationMarkerRe(nonce: string): RegExp {
  return new RegExp(`<ATHD:${nonce}:(\\d+)>`);
}

/** The line typed before each command, announcing whose it is. */
export function agentTagLine(nonce: string): string {
  return `\u2193\u2193\u2193 AGENT INPUT ID: ${nonce} \u2193\u2193\u2193`;
}

const HELPER_SH = `# agent-terminal-hub shell helper. Generated -- do not edit.
# Sourced into each hub session so commands report an exact exit code.
#
# The exit code rides inside the end marker rather than a sentinel file, so the
# same protocol works locally, over ssh, and inside a container: the marker
# comes back through the terminal, a file on the far host would not.
${HELPER_ONELINE}
${HOOKS_BOTH}
`;

/**
 * Applied to the hub's tmux server only. `window-size latest` is the important
 * one: without it, a human attaching with a small window shrinks the pane the
 * agent is driving, and wraps its output.
 */
const TMUX_CONF_BODY = `# agent-terminal-hub tmux config. Generated -- do not edit.
# Applies only to the hub's dedicated socket, never your personal tmux.

# A newly attached client sets the size; do not shrink to the smallest client.
set -g window-size latest
set -g aggressive-resize on

# Keep panes alive after their process exits so a session survives an agent
# sending 'exit'. The pane becomes dead and is respawned on next use.
set -g remain-on-exit on

# Generous scrollback; the agent reads the pipe-pane log, but humans scroll.
set -g history-limit 50000

# The hub owns the chrome; this reads as a plain terminal when embedded.
set -g status off
set -g mouse on
set -g escape-time 10
set -g default-terminal "screen-256color"
`;

/**
 * Create ~/.ath and refresh the generated assets. Safe to call repeatedly;
 * every entry point calls it before touching tmux.
 *
 * Every directory, from `ATH_ARTIFACTS` — not just the two this used to name.
 * `mkdir` with `recursive: true` applies its mode only when it CREATES the
 * directory, so whichever process got there first set the permissions, and the
 * editor extension got there first with a bare `mkdir` that took the umask.
 * On a stock macOS umask of 022 that left `requests/` world-readable — the one
 * directory whose own artifact entry says its reason text quotes the command —
 * while `election/`, created first by core on the same machine, was 0700. That
 * split is the signature of the race, not a considered difference.
 *
 * The `chmod` is what repairs an install already in the wrong state: fixing
 * the creating call alone would leave every existing `~/.ath` at 0755 forever,
 * because `mkdir` on an existing directory does nothing at all.
 */
export async function ensureLayout(): Promise<void> {
  await fs.mkdir(ATH_HOME, { recursive: true, mode: 0o700 });
  await fs.chmod(ATH_HOME, 0o700).catch(() => undefined);
  for (const artifact of ATH_ARTIFACTS) {
    if (!artifact.name.endsWith('/')) continue;
    await fs.mkdir(artifact.absolute, { recursive: true, mode: 0o700 }).catch(() => undefined);
    await fs.chmod(artifact.absolute, 0o700).catch(() => undefined);
  }
  // `notify.log` is created by `appendFile` in the editor extension, which
  // likewise took the umask and left it 0644 — and unlike `requests/`, where
  // the 0600 entries stayed private behind a readable directory, here the
  // world-readable thing is the CONTENT. Only repaired when it exists; this
  // must not create it.
  await fs.chmod(NOTIFY_LOG, 0o600).catch(() => undefined);
  // The rotated generation holds the same content and predates the fix.
  await fs.chmod(`${NOTIFY_LOG}.1`, 0o600).catch(() => undefined);
  // Enforce the bound `ATH_ARTIFACTS` advertises, rather than merely hoping.
  //
  // Rotation was only ever triggered by the editor extension writing a line,
  // so a file that crossed the cap and then went quiet stayed over it forever.
  // `doctor --artifacts` reported "rotated at 1 MB" beside a 2.3 MB file with
  // no rotated generation — the one command the skill tells an agent to trust
  // instead of guessing, wrong about the tool's own housekeeping. An agent
  // reported it, and by the time it was looked at the file had reached 3 MB.
  //
  // Here because every entry point calls this, so the bound is now enforced by
  // using ath at all rather than by an editor happening to be open. Costs one
  // stat; `rotateNotifyLog` returns immediately when the file is under the cap.
  await rotateNotifyLog().catch(() => undefined);
  await writeIfChanged(HELPER_PATH, HELPER_SH);
  await writeIfChanged(TMUX_CONF, TMUX_CONF_BODY);
}

async function writeIfChanged(file: string, body: string): Promise<void> {
  try {
    if ((await fs.readFile(file, 'utf8')) === body) return;
  } catch {
    /* missing -> write */
  }
  await fs.writeFile(file, body, { mode: 0o600 });
}

/**
 * Trim a session's log if it has grown past the cap.
 *
 * A session running a dev server appends forever, and nothing else in the
 * system bounds it. Rewrites in place keeping the tail, so the file keeps its
 * identity and the pipe-pane fd stays valid.
 *
 * Callers MUST hold the session lock: byte offsets taken before a trim are
 * meaningless after it, and an in-flight `run()` is holding one.
 */
export async function rotateIfNeeded(
  name: string,
  maxBytes = LOG_MAX_BYTES,
): Promise<{ rotated: boolean; from?: number; to?: number }> {
  const file = logPath(name);
  let size: number;
  try {
    size = (await fs.stat(file)).size;
  } catch {
    return { rotated: false };
  }
  if (size <= maxBytes) return { rotated: false };

  // Never keep more than the file holds, nor more than half the cap — a fixed
  // keep size larger than `maxBytes` would read from a negative offset and
  // write the buffer's zero padding back, growing the file instead of
  // shrinking it.
  const keep = Math.min(LOG_KEEP_BYTES, Math.floor(maxBytes / 2), size);

  const handle = await fs.open(file, 'r');
  let tail: Buffer;
  try {
    tail = Buffer.alloc(keep);
    await handle.read(tail, 0, keep, size - keep);
  } finally {
    await handle.close();
  }

  // Truncate then write, rather than replacing the file, so the writer's fd
  // (held open by pipe-pane) continues to point at this same inode.
  await fs.truncate(file, 0);
  await fs.writeFile(file, tail, { flag: 'r+' });
  // Count what was thrown away BEFORE returning, so no offset issued after
  // this point can be interpreted against the old file. See `discardedBytes`.
  await addDiscardedBytes(name, size - keep);
  return { rotated: true, from: size, to: keep };
}

export interface PurgeResult {
  /** Bytes discarded from the session log. */
  bytes: number;
  /** Still on disk after this call, and still telling a reader something. */
  survives: readonly AthArtifact[];
}

/**
 * Empty a session's log.
 *
 * Exists because input typed at an *echoing* prompt (an API key, a token) is
 * captured here and is readable by any agent with `read` access. Not exposed
 * over MCP: discarding the record is a human's decision.
 *
 * Returns what it did NOT cover, because the name promises more than the
 * function delivers. It truncates one file; nine other things the hub wrote
 * are untouched, and one of them (`requests/`) quotes the command back. A
 * caller that prints only "purged" is making a claim this cannot support.
 */
export async function purgeLog(name: string): Promise<PurgeResult> {
  const file = logPath(name);
  let bytes = 0;
  try {
    bytes = (await fs.stat(file)).size;
  } catch {
    /* never written */
  }
  await fs.truncate(file, 0).catch(() => undefined);
  // A purge discards every byte, so offsets must keep climbing past them
  // rather than restarting — an offset a caller is still holding refers to
  // content that is now gone, and must be reported as gone, not as valid.
  await addDiscardedBytes(name, bytes);
  return { bytes, survives: ATH_ARTIFACTS.filter((a) => !a.purged && a.sensitive) };
}

/**
 * Sentinel files that outlive the command that made them.
 *
 * Every extension the hub writes into `rc/` belongs here. It listed only `.rc`
 * for a long time while three more accumulated beside it — `.t` (timing), and
 * `.caveat`/`.boot` (one-shot flags) — so the reaper cleaned 9 files out of
 * 241 and the oldest survivor was four days old. Adding state without adding
 * it here is the bug this comment exists to prevent.
 */
const RC_SUFFIXES = ['.rc', '.t', '.caveat', '.boot', '.width', '.wnote'] as const;

/** Remove sentinels left behind by commands that never completed. */
export async function reapStaleRc(maxAgeMs = 6 * 60 * 60 * 1000): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(RC_DIR);
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!RC_SUFFIXES.some((s) => entry.endsWith(s))) continue;
    const file = path.join(RC_DIR, entry);
    try {
      const stat = await fs.stat(file);
      if (stat.mtimeMs < cutoff) {
        await fs.unlink(file);
        removed++;
      }
    } catch {
      /* raced with another reaper */
    }
  }
  return removed;
}

/**
 * Rotate `notify.log` once it passes the cap, keeping one generation.
 *
 * By RENAME, not by rewriting in place. Several editor windows append to this
 * file, each with its own open/write/close, and none of them takes the session
 * lock — a read-tail-truncate-write cycle would silently drop whatever landed
 * between the read and the write. `rename` is atomic, and the next append
 * recreates the file.
 *
 * One generation, overwritten: the ceiling is two files, so the cap is a real
 * bound rather than a slower leak.
 */
export async function rotateNotifyLog(maxBytes = NOTIFY_MAX_BYTES): Promise<boolean> {
  try {
    if ((await fs.stat(NOTIFY_LOG)).size <= maxBytes) return false;
  } catch {
    return false; // never written
  }
  try {
    await fs.rename(NOTIFY_LOG, `${NOTIFY_LOG}.1`);
    return true;
  } catch {
    return false; // raced another window; it rotated, we did not
  }
}

/**
 * Ask the shell what it is, and answer through the PTY.
 *
 * The hub's founding insight is that a marker travelling back through the
 * terminal works identically locally, over ssh and inside a container — which
 * is why the exit code is not a file. Setup was the one thing that never used
 * it: it sent code and GUESSED when the shell had finished, with a sleep or by
 * watching `pane_current_command`. Over ssh both guesses fail — the command is
 * `ssh` for the whole session, so there is no prompt to detect, and a sleep
 * races a shell still consuming a 1000-character line. tmux then splices the
 * next line into it.
 *
 * Asking, and waiting for the answer, makes that impossible rather than
 * unlikely.
 */
export function shellProbeLine(token: string): string {
  return `printf '\\036<ATHR:${token}:%s>\\036\\r\\033[K' "\${ZSH_VERSION:+zsh}\${BASH_VERSION:+bash}"`;
}

/** Hooks for one shell only, ending in a marker that confirms they landed. */
export function frameHooksFor(shell: 'zsh' | 'bash', token: string): string {
  const both = HOOKS_BOTH;
  const zshStart = both.indexOf('if [ -n "$ZSH_VERSION" ]; then ') + 'if [ -n "$ZSH_VERSION" ]; then '.length;
  const zshEnd = both.indexOf('elif [ -n "$BASH_VERSION" ]; then ');
  // Both branches define the same tag function, so an edit that matches on it
  // can silently take the wrong one and leave this slicing a truncated shell
  // snippet — which is exactly how a one-character function name (`\u27e8`
  // instead of `\u2193\u2193\u2193`) once shipped to a remote host. Fail loudly instead.
  if (zshEnd < 0) throw new Error('HOOKS_BOTH lost its shell markers');
  const bashStart = zshEnd + 'elif [ -n "$BASH_VERSION" ]; then '.length;
  const bashEnd = both.lastIndexOf('fi');
  const body = shell === 'zsh' ? both.slice(zshStart, zshEnd) : both.slice(bashStart, bashEnd);
  return `${body} printf '\\036<ATHR:${token}:ok>\\036\\r\\033[K'`;
}
