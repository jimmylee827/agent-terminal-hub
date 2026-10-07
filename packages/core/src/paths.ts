import { promises as fs, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { HELPER_ONELINE, HOOKS_BOTH } from './posix';

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
    holds:
      'one <session>.log per session — every command run and every byte it printed, plus a ' +
      'tiny <session>.trim sidecar recording how much a trim discarded',
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
    // "reaped after 6h" was a shade stronger than the code. The sweep runs when
    // a session is CREATED, so entries older than six hours survive until the
    // next `new` — which, on a machine sitting idle, can be a while. Measured
    // right after a cleanup: 3 sentinels past six hours with no session left to
    // trigger the sweep. Saying when it happens costs four words.
    bounded: 'older than 6h, swept when a session is next created',
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
    bounded: 'released by the window holding it; any left orphaned are swept when a session is next created',
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
/**
 * Total bytes under log/, for surfacing growth BEFORE someone goes looking.
 *
 * Each transcript is trimmed; the directory is not, and sessions are never
 * reaped because `kill` keeps the transcript on purpose. So it only grows.
 * `doctor` has always said so plainly, which is exactly the problem a reviewer
 * named: "it accumulates silently and nothing surfaces it until you go
 * looking." They found 274 MiB, of which ~250 MiB belonged to sessions that no
 * longer existed, and had to call `doctor` out of curiosity to learn it.
 */
export async function logDirBytes(): Promise<number> {
  const names = await fs.readdir(LOG_DIR).catch(() => [] as string[]);
  let total = 0;
  for (const n of names) {
    const st = await fs.stat(path.join(LOG_DIR, n)).catch(() => undefined);
    if (st?.isFile()) total += st.size;
  }
  return total;
}

/**
 * Is the code answering this call older than the code on disk?
 *
 * Node reads a module once, at startup. A long-lived MCP server therefore keeps
 * serving the build it booted with, however many times the project is rebuilt
 * underneath it — and the preferred surface, the one the skill file tells
 * agents to use, is exactly the long-lived one. The CLI re-reads `dist` on
 * every invocation, so a fix appears there immediately.
 *
 * That split cost a reviewer twenty minutes: they ran the same command on both
 * surfaces seconds apart, got a warning from one and silence from the other,
 * and had to go through process start times to work out why. Their words, and
 * the design point: "the preferred surface is the one that silently serves
 * stale code after an update, with nothing anywhere indicating a version
 * mismatch. A build stamp visible in list or doctor would have turned twenty
 * minutes of process archaeology into one call."
 *
 * `__filename` is this module in `dist`; its mtime at load is what is running,
 * and its mtime now is what is on disk. Comparing the two needs no build step,
 * no version file, and cannot drift out of date.
 */
const BUILD_LOADED_MS = ((): number => {
  try {
    return statSync(__filename).mtimeMs;
  } catch {
    return 0;
  }
})();

export interface BuildStaleness {
  loadedMs: number;
  onDiskMs: number;
}

/** Returns the two timestamps only when the running code is behind the disk. */
export function buildStaleness(): BuildStaleness | undefined {
  if (!BUILD_LOADED_MS) return undefined;
  let onDiskMs = 0;
  try {
    onDiskMs = statSync(__filename).mtimeMs;
  } catch {
    return undefined;
  }
  // A second of slack: some filesystems round mtimes, and a false alarm here
  // would send people restarting servers that are perfectly current.
  if (onDiskMs <= BUILD_LOADED_MS + 1000) return undefined;
  return { loadedMs: BUILD_LOADED_MS, onDiskMs };
}

/**
 * What a REMOTE host is left with. One text, both surfaces.
 *
 * This paragraph is the claim an auditor leans on hardest, and it has been
 * corrected twice for accuracy — once because "the hub writes nothing" was
 * false (the login shell writes ~/.zsh_history), once because the verification
 * it recommended returns a false negative mid-session.
 *
 * Both corrections landed on the CLI. The MCP surface — the one the skill file
 * tells agents to PREFER — never carried this paragraph at all, so an agent
 * asking "what did you leave on my machine?" through MCP got the artifact table
 * and nothing about the remote host. Nobody reported it; it turned up when a
 * reviewer noted `doctor --artifacts` was "richer on the CLI".
 *
 * Living in core is the fix for the shape, not just this instance: a sentence
 * that exists once cannot be corrected on one surface and left wrong on the
 * other. See scripts/prose.js.
 */
export const REMOTE_FOOTPRINT: readonly string[] = [
  'The hub writes no files of its own: no directories, no rc-file edits.',
  'The shell helper is TYPED into the pane — functions in memory only,',
  'gone when the shell exits. tmux, the transcript and every file above',
  'live on THIS machine; ssh carries only the connection.',
  'BUT the shell it opens is a LOGIN shell, and your shell writes its own',
  'history: commands run in a remote session land in ~/.zsh_history (or',
  'your shell\'s equivalent) on THAT host, and outlive the session. Not',
  'the hub writing, but the hub is what opened the shell.',
  'On a WINDOWS host the shell is PowerShell, and three things differ: the',
  'hooks ride the ssh launch rather than being typed, and the lines the',
  'hub types (tag lines, the wrapper, the agent\'s own commands) are kept',
  'out of PSReadLine\'s history file, in memory at most. What a PERSON',
  'types in that session is saved there as usual. And PSReadLine\'s inline',
  'predictions are off in that session: they draw saved history beside',
  'the cursor, and on Windows what is drawn reaches this transcript.',
  'WHEN it is written matters: zsh flushes history when the shell EXITS,',
  'not per command. So checking mid-session shows NOTHING and is a false',
  'negative — the commands appear only after the session is killed.',
  'Assume they will be there; do not conclude from a live check that they',
  'are not. (mtime is no help either: it can read modified from an',
  'earlier flush while holding none of this session.)',
  'Two further traces are ssh, not the hub: your login in the auth log,',
  'and whatever the commands you ran did themselves.',
];

export interface StaleServer {
  pid: number;
  startedMs: number;
}

/**
 * Which running MCP servers booted BEFORE the current build.
 *
 * The per-process check above can only speak for the process running it — and
 * the CLI, which re-reads `dist` on every invocation, is never stale, so its
 * own answer is always "fine". That is useless precisely where the problem is:
 * the long-lived MCP server, which the skill file tells agents to prefer.
 *
 * The CLI is the right place to ask about OTHER processes, and a reviewer
 * already proved the method by hand — they read `ps` start times against the
 * build and found three servers, all older. This does that in one call, which
 * is what they asked for: "a build stamp visible in list or doctor would have
 * turned twenty minutes of process archaeology into one call."
 */
export async function staleServers(): Promise<StaleServer[]> {
  if (!BUILD_LOADED_MS) return [];
  let built = 0;
  try {
    built = statSync(__filename).mtimeMs;
  } catch {
    return [];
  }
  const { execFile } = await import('node:child_process');
  const out = await new Promise<string>((resolve) => {
    execFile('ps', ['-eo', 'pid,lstart,args'], { maxBuffer: 8 << 20 }, (err, stdout) =>
      resolve(err ? '' : stdout),
    );
  });
  const stale: StaleServer[] = [];
  for (const line of out.split('\n')) {
    // Our own server, not every node process, and not this grep-alike itself.
    if (!/mcp[/\\]dist[/\\]index\.js/.test(line)) continue;
    const m = line.match(/^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s/);
    if (!m) continue;
    const startedMs = Date.parse(m[2] ?? '');
    if (!Number.isFinite(startedMs)) continue;
    // A second of slack, matching the per-process check.
    if (startedMs < built - 1000) stale.push({ pid: Number(m[1]), startedMs });
  }
  return stale.sort((a, b) => a.startedMs - b.startedMs);
}

/**
 * What actually changed since a stale server booted.
 *
 * The notice told a reviewer something might be silently wrong and then said it
 * could not say what: "it's a warning that something might be silently wrong,
 * admits it can't say what". Pointing at `git log --since` was honest but left
 * the work with them, and an agent mid-audit is not going to go and run it.
 *
 * When the install IS a git checkout — which it is on the machine where this
 * matters, a developer's — the answer is a subprocess away. Subjects only, and
 * capped: enough to judge whether the gap touches anything you rely on.
 */
async function changesSince(ms: number): Promise<string[]> {
  const root = path.join(__dirname, '..', '..', '..');
  try {
    statSync(path.join(root, '.git'));
  } catch {
    return [];
  }
  const { execFile } = await import('node:child_process');
  const iso = new Date(ms).toISOString();
  return new Promise<string[]>((resolve) => {
    execFile(
      'git',
      ['-C', root, 'log', '--since', iso, '--pretty=format:%s', '--no-merges'],
      { timeout: 3000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) return resolve([]);
        resolve(
          stdout
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(0, 8),
        );
      },
    );
  });
}

/** The note, with what changed when that can be established. */
export async function staleServersReport(servers: StaleServer[]): Promise<string> {
  const base = staleServersNote(servers);
  // ANCHOR THE LIST TO THE READER, when the reader is one of the stale ones.
  //
  // It was anchored to the oldest server in the list, which answers "what is
  // new since the oldest straggler" — not "what am I missing". A reviewer said
  // so exactly: of eight entries they could place only two empirically, because
  // the baseline was a process from five days earlier and the other six may
  // already have been in the build they were running.
  //
  // The process reading this knows when IT started. When that process is itself
  // stale, its own start is the only baseline that answers the question it
  // actually has; when it is current, nothing is missing for it and the list is
  // information about OTHER servers, which is worth saying rather than leaving
  // the reader to assume the list applies to them.
  const self = servers.find((x) => x.pid === process.pid);
  const anchor = self ?? servers.reduce((a, b) => (a.startedMs < b.startedMs ? a : b));
  const changes = await changesSince(anchor.startedMs).catch(() => []);
  const when = new Date(anchor.startedMs).toISOString().replace('T', ' ').slice(0, 19);
  const heading = self
    ? `What THIS server (pid ${self.pid}) is missing, having started ${when} UTC, newest first:`
    : `This process is current, so none of the below is missing HERE. For the oldest of ` +
      `those servers, started ${when} UTC, what has landed since, newest first:`;
  if (!changes.length) return base;
  return `${base}\n\n${heading}\n` + changes.map((c) => `  - ${c}`).join('\n');
}

/** What to say about them. Shared wording, like every other notice here. */
/**
 * Who is answering, and whether that process is current.
 *
 * The staleness signals so far could only speak by ABSENCE: a stale server was
 * named, a current one said nothing, and "nothing" is also what you get from a
 * server too old to have the feature at all. A reviewer put the gap precisely —
 * the notice "reports two stale pids; it doesn't say which server is serving
 * this call" — and had to run `ps` to answer it.
 */
export function thisServer(): {
  pid: number;
  started_utc: string;
  loaded_build_utc: string;
  build_utc: string;
  current: boolean;
} {
  const iso = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  let built = 0;
  try {
    built = statSync(__filename).mtimeMs;
  } catch {
    built = 0;
  }
  // `started_utc` MEANT when this process started, and reported the build's
  // mtime instead.
  //
  // A reviewer read `this_server` from MCP — "started_utc 08:29:27" — and then
  // the CLI's stale-server report naming the same pid as "started 09:47:55".
  // 78 minutes apart, about one process. They could not tell which was wrong
  // and said so; it is the MCP one, and it was never a start time at all.
  //
  // The tell was visible in the payload and I never looked: `started_utc` and
  // `build_utc` were the SAME STRING, because both read BUILD_LOADED_MS. Two
  // differently-named fields holding one value is the shape of a mislabel.
  //
  // `process.uptime()` is the real answer, exact and free. The build this
  // process LOADED is still worth reporting — it is what staleness compares —
  // so it keeps a name that says what it is.
  const startedMs = Date.now() - process.uptime() * 1000;
  return {
    pid: process.pid,
    started_utc: iso(startedMs),
    loaded_build_utc: iso(BUILD_LOADED_MS),
    build_utc: iso(built || BUILD_LOADED_MS),
    current: buildStaleness() === undefined,
  };
}

export function staleServersNote(servers: StaleServer[]): string {
  const when = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  let built = 0;
  try {
    built = statSync(__filename).mtimeMs;
  } catch {
    built = 0;
  }
  // HOW FAR behind, not just "behind".
  //
  // A reviewer acted on this notice and still could not scope their own
  // uncertainty: "it doesn't say which behaviours differ". Enumerating those
  // honestly is not possible from here — but the SIZE of the gap is, and a
  // server three days old is a different problem from one three minutes old.
  // The build date lets a reader go and look, which is the most this can
  // truthfully offer.
  const list = servers
    .map((s) => {
      const days = built ? (built - s.startedMs) / 86400000 : 0;
      // Minutes below an hour: "0h behind" reads as NOT behind, which is the
      // opposite of what the row is there to say.
      const mins = built ? Math.max(1, Math.round((built - s.startedMs) / 60000)) : 0;
      const behind = !built
        ? ''
        : days >= 1
          ? `, ${Math.floor(days)}d behind`
          : mins >= 60
            ? `, ${Math.round(mins / 60)}h behind`
            : `, ${mins}m behind`;
      // Mark the process doing the reporting.
      //
      // "It never says whether I am stale. It reports two stale pids; it
      // doesn't say which server is serving this call" — a reviewer had to run
      // `ps` to find they were on a fourth, current one, and called it "the
      // only version question I actually have". The answer was always in hand:
      // the process knows its own pid.
      const me = s.pid === process.pid ? ' ← THIS server, the one answering you' : '';
      return `pid ${s.pid} (started ${when(s.startedMs)} UTC${behind})${me}`;
    })
    .join(', ');
  return (
    `${servers.length} agent_terminal MCP server${servers.length === 1 ? '' : 's'} ` +
    `${servers.length === 1 ? 'is' : 'are'} running code older than the current build: ${list}. ` +
    `Node reads its modules once at startup, so those processes do NOT have fixes built since ` +
    `then — an agent using the MCP tools will see the old behaviour while this CLI shows the ` +
    `new one. ` +
    (built ? `The build on disk is from ${when(built)} UTC; ` : '') +
    `what changed in between is whatever landed in the project since each start time above. ` +
    `Restart the client that launched each server to pick the build up.`
  );
}

/** The sentence both surfaces show for it. Shared, so they cannot disagree. */
export function staleBuildNote(s: BuildStaleness): string {
  const when = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
  return (
    `THIS PROCESS IS RUNNING STALE CODE. It loaded the hub at ${when(s.loadedMs)} UTC, and the ` +
    `build on disk is from ${when(s.onDiskMs)} UTC — newer. Node reads its modules once at ` +
    `startup, so a fix built since then is NOT in effect here, even though the same command run ` +
    `through the "ath" CLI would use it. If a documented behaviour seems missing, this is the ` +
    `first thing to rule out: restart this server (for an MCP server, restart the client that ` +
    `launched it) and try again.`
  );
}

/** Past this, `new` says so once. Chosen to sit under the 274 MiB a reviewer met. */
export const LOG_DIR_NOTICE_BYTES = 192 * 1024 * 1024;

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

// The POSIX shell protocol lives in posix.ts now. These names stay importable
// from here so that no existing caller had to change when it moved.
export { HELPER_ONELINE, agentTagLine, frameHooksFor, shellProbeLine } from './posix';

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

  // Start the kept tail at a LINE boundary.
  //
  // This kept a fixed byte count, so the surviving log began mid-line and the
  // first thing any reader saw was a fragment of whatever had been running. A
  // reviewer inferred it from arithmetic alone — the trim reported exactly
  // 8,388,608 bytes, "which suggests it cuts mid-line" — and was right.
  //
  // The CAP already goes to some length to cut on newlines, for the reason
  // written there: a line whole in neither half is loss wearing the shape of
  // pagination. The trim, which destroys rather than elides, was doing the
  // cruder thing. Costs at most one line out of 8 MiB.
  //
  // `discarded` is computed from the ALIGNED length, because every offset a
  // caller holds is interpreted against it; using the pre-alignment number
  // would shift every subsequent read by the length of one line.
  const firstNewline = tail.indexOf(0x0a);
  const aligned =
    firstNewline >= 0 && firstNewline + 1 < tail.length ? tail.subarray(firstNewline + 1) : tail;

  // Truncate then write, rather than replacing the file, so the writer's fd
  // (held open by pipe-pane) continues to point at this same inode.
  await fs.truncate(file, 0);
  await fs.writeFile(file, aligned, { flag: 'r+' });
  // Count what was thrown away BEFORE returning, so no offset issued after
  // this point can be interpreted against the old file. See `discardedBytes`.
  await addDiscardedBytes(name, size - aligned.length);
  return { rotated: true, from: size, to: aligned.length };
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
const RC_SUFFIXES = ['.rc', '.t', '.caveat', '.warn', '.boot', '.width', '.wnote'] as const;

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
