/**
 * Tool definitions, kept separate from transport wiring so the schemas stay
 * readable and can be reused by a future HTTP transport.
 *
 * Descriptions are written for the agent reading them at call time. Two things
 * they must convey, because getting them wrong is what makes agents unhelpful
 * here: a session is persistent (so state carries between calls), and
 * `needsInput` is a handoff to a human, not a failure to route around.
 */
export const TOOL_DEFINITIONS = [
  {
    name: 'list',
    annotations: { title: 'List terminals', readOnlyHint: true, destructiveHint: false },
    description:
      'List the terminal sessions in the hub, with their state (idle, busy, needs-input, dead), ' +
      'working directory, and the command each is currently running. Use this before creating a ' +
      'new session — reusing an existing one preserves its shell state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'new',
    annotations: { title: 'Open a terminal', readOnlyHint: false, destructiveHint: false },
    description:
      'Create a persistent terminal session. Unlike a normal shell tool call, this session stays ' +
      'alive between your calls and between conversations, so exports, activated virtualenvs, an ' +
      'open ssh connection or a running dev server all persist. Use --remote to open an ssh ' +
      'session to a host.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short name, e.g. "build". Auto-generated if omitted.' },
        session: {
          type: 'string',
          description: 'Alias for `name`, since every other tool calls it `session`.',
        },
        cwd: { type: 'string', description: 'Working directory to start in.' },
        width: {
          type: 'integer',
          description:
            // This said "tmux TRUNCATES output to the pane width". It does not,
            // and a cold agent disproved it in one command: 400 characters into
            // a 156-column pane came back as 400. `run` reads the pipe-pane log
            // between markers, which is a real capture, not a screen scrape.
            //
            // Worse than merely wrong — it pointed at the wrong defence. What
            // actually loses data is a program formatting ITSELF to $COLUMNS
            // (ps, lsblk, vmstat, docker ps): the bytes were never written, so
            // no capture can recover them. A wide pane helps that; it is not
            // protecting you from tmux.
            'Pane columns (default 200). Command output is NOT truncated — it is read from the ' +
            'session log, so it comes back whole however long the lines are. Width still ' +
            'matters because many programs format THEMSELVES to the terminal width (ps, ' +
            'lsblk, docker ps), and those columns are lost before anything can capture them. ' +
            'A human attaching resizes the pane, so width is never a guarantee: for anything ' +
            'you intend to parse, prefer --json/--format/-o over column layout.',
        },
        remote: { type: 'string', description: 'Host to ssh into immediately, e.g. "myserver".' },
        pin: { type: 'boolean', description: 'Protect from automatic cleanup.' },
        label: { type: 'string', description: 'Human-readable note shown in the GUI.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'run',
    annotations: { title: 'Run a command', readOnlyHint: false, destructiveHint: false },
    description:
      'Run a command in a session and wait for it to finish. Returns its combined ' +
      'stdout+stderr and the real exit code. The exit code is always exact; the OUTPUT is ' +
      'capped (see max_bytes), so a command printing megabytes comes back as head+tail with ' +
      'the middle named rather than all of it at once. IMPORTANT: if the result has needsInput=true, the ' +
      'command is waiting on a password or a confirmation prompt. Do NOT attempt to answer it and ' +
      'never send a credential — report it to the human, who is attached to the same terminal and ' +
      'will type it. Then continue with the `read` tool. (The CLI signals these as exit codes 75 ' +
      'and 76; here they are the `needs_input` and `timed_out` fields instead.) ' +
      // The second architecture-determining fact. Same reason as `start`: an
      // agent reading only the schemas plans the wrong session layout, and
      // discovers it after its human has already typed one password.
      'SUDO DOES NOT CROSS SESSIONS: the credential timestamp is per-TTY, so a password typed ' +
      'in one session does not cover another and the human is asked again. Keep all privileged ' +
      'work in ONE session.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session name.' },
        command: { type: 'string', description: 'Shell command to run.' },
        timeout_seconds: {
          type: 'number',
          description: 'How long to wait before returning partial output. Default 120.',
        },
        max_bytes: {
          type: 'integer',
          description:
            'Cap on how much output comes back (default 65536). Anything left out is taken ' +
            'from the MIDDLE; `omitted_bytes` says how much, and the note names the offset ' +
            'that returns the command\'s full region. Pass 0 for no cap when you genuinely ' +
            'want every byte in one call.',
        },
        wait_for_idle: {
          type: 'boolean',
          description: 'Queue behind a running command instead of failing if the session is busy.',
        },
      },
      required: ['session', 'command'],
      additionalProperties: false,
    },
  },
  {
    name: 'read',
    annotations: { title: 'Read terminal output', readOnlyHint: true, destructiveHint: false },
    description:
      'Read recent output from a session without running anything. Use this after a human has ' +
      'answered a prompt you reported, or to check on a long-running process. Pass `since` with ' +
      'the `next_offset` from your previous read to get ONLY what is new — do that when polling, ' +
      'so you are not re-reading the same output into your context every time. EVERY read ' +
      'returns a `next_offset`, including one with no `since`, so this call is how you get your ' +
      'first one. ' +
      // The bounded primitive, named where an agent decides how to watch a job.
      // `poll` is the documented monitor and returns EVERYTHING since the
      // offset — which for a chatty build is megabytes, arriving before the
      // caller can know it needed something smaller. An agent watching a job
      // that emitted 2.6 MB found `lines` on its own and reported that nothing
      // had pointed it here.
      'For a quick progress glance at a chatty job, this with a small `lines` is the cheapest ' +
      'thing you can do: it reads a fixed window off the end however much the command has ' +
      'printed. Use `poll` when you want the incremental slice and the exit code.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        lines: { type: 'number', description: 'How many trailing lines to return. Default 200.' },
        since: {
          type: 'number',
          description: 'Byte offset from a previous read\'s next_offset. Returns only newer output.',
        },
        max_bytes: {
          type: 'integer',
          description:
            'Cap on how much output comes back (default 65536). Anything left out is taken ' +
            'from the MIDDLE and is recoverable: the result names the `since` that returns it. ' +
            'Pass 0 for no cap when you genuinely want every byte in one call.',
        },
      },
      required: ['session'],
      additionalProperties: false,
    },
  },
  {
    name: 'start',
    annotations: { title: 'Start a background command', readOnlyHint: false, destructiveHint: false },
    description:
      'Start a command WITHOUT waiting for it, returning a handle. Use this for anything ' +
      'long-lived — a dev server, a long build, a migration — where blocking is the wrong shape. ' +
      'Poll it with the `poll` tool to get incremental output and, eventually, the real exit code. ' +
      'For ordinary commands prefer the `run` tool, which just waits. ' +
      // The fact that decides the ARCHITECTURE, stated where an agent reading
      // only the schemas will see it. A cold agent noted that these two facts
      // live in the skill file and nowhere else, so "an agent working from tool
      // schemas alone gets this wrong" — and would run sudo in a backgrounded
      // session, costing its human a second password.
      'NON-BLOCKING FOR YOU, BUT THE SESSION GOES BUSY: the next command sent to this same ' +
      'session is refused until this finishes. Concurrent work needs a SECOND session, created ' +
      'in advance — not this tool twice.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        command: { type: 'string' },
      },
      required: ['session', 'command'],
      additionalProperties: false,
    },
  },
  {
    name: 'poll',
    annotations: { title: 'Check a running command', readOnlyHint: true, destructiveHint: false },
    description:
      'Check a command started by the `start` tool. Returns only output produced since the ' +
      'offset you pass, plus `done` and the exit code once it finishes. Pass the previous ' +
      'response\'s `next_offset` as `since` on each call. Do not poll in a tight loop — space ' +
      'calls out sensibly for the work you are waiting on. Output is CAPPED (see max_bytes): a job printing megabytes would otherwise return all of them in one call, and you cannot know you wanted less until it has arrived. When the cap bites, `omitted_bytes` and `omitted_resume_from` say what was left out and which `since` returns it.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        handle: { type: 'string', description: 'The handle returned by `start`.' },
        since: {
          type: 'number',
          description:
            'Offset from `start` or the last poll. Offsets are per SESSION, not per handle: ' +
            'they keep climbing across jobs, so always pass back what you were last given ' +
            'rather than assuming a new job starts at zero.',
        },
        max_bytes: {
          type: 'integer',
          description:
            'Cap on how much output comes back (default 65536). Anything left out is taken ' +
            'from the MIDDLE and is recoverable: the result names the `since` that returns it. ' +
            'Pass 0 for no cap when you genuinely want every byte in one call.',
        },
      },
      required: ['session', 'handle'],
      additionalProperties: false,
    },
  },
  {
    name: 'send',
    annotations: { title: 'Send keys to a terminal', readOnlyHint: false, destructiveHint: false },
    description:
      'Send raw keys to a session without waiting: tmux key names like C-c, Up, Enter, or single ' +
      'characters like y. Use for interrupting a process or answering a simple y/n. NEVER use this ' +
      'to type a password, passphrase, or any other credential.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        keys: {
          type: 'string',
          description: 'Space-separated tmux key names, e.g. "C-c" or "y Enter".',
        },
      },
      required: ['session', 'keys'],
      additionalProperties: false,
    },
  },
  {
    name: 'request_human',
    annotations: { title: 'Ask the human for help', readOnlyHint: true, destructiveHint: false },
    description:
      'Ask the human to come to a terminal. Raises a notification in their editor with a button ' +
      'that attaches them to this exact session. Use when a command needs a password, a hardware ' +
      'key tap, a decision you should not make, or any input you must not supply yourself. State ' +
      'plainly in the reason what is being asked for.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        reason: {
          type: 'string',
          description: 'What you need, e.g. "sudo password for installing rosetta".',
        },
      },
      required: ['session', 'reason'],
      additionalProperties: false,
    },
  },
  {
    // The credential handoff is this tool's headline feature, and until now it
    // could not be driven from MCP alone: seeing whether a request exists, and
    // getting the answer without polling, were both CLI-only. An agent given
    // only these tools had to shell out mid-flow — or, more likely, poll in a
    // loop, which is the exact behaviour the design exists to prevent.
    name: 'requests',
    annotations: { title: 'See what needs a human', readOnlyHint: true, destructiveHint: false },
    description:
      'List what the hub is waiting on a human for, and what has since been answered. Each entry ' +
      'says which session is blocked, what was asked, and — once resolved — the exit code, so you ' +
      'can collect the outcome. Check the state of a handoff with it ONCE — do not poll it in a ' +
      'loop waiting for an answer: it is a pull-only view, and looping burns your turn learning ' +
      'nothing. To be TOLD when the human answers, use `await_human`. You also do not need this ' +
      'to discover that a request exists — whatever filed one told you so at the time.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Only requests for this session.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'await_human',
    annotations: { title: 'Wait for the human to answer', readOnlyHint: true, destructiveHint: false },
    description:
      'BLOCK until a backgrounded command finishes, then return its outcome, exit code and ' +
      'output. Despite the name this is not only for credentials — use it for ANY `start`ed job ' +
      'instead of polling in a loop, including ordinary long ones. It polls internally once a ' +
      'second, which also tightens the duration bracket you get back.  It returns the moment the command finishes, is ' +
      'interrupted, or the session dies — and if nobody has answered within the (short) timeout ' +
      'it returns `outcome: "still_waiting"`, which is NOT a failure: the request stays open. ' +
      'Read the outcome field, not just the text; "interrupted" and "still_waiting" are not ' +
      'answers. Tell the user what you need BEFORE calling this.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        handle: { type: 'string', description: 'From `start`. Omit to use the command in flight.' },
        since: {
          type: 'number',
          description:
            'Return only output produced after this byte offset, as `poll` does. Without it the ' +
            'whole command window comes back, which on a chatty command is a lot of context.',
        },
        timeout_seconds: {
          type: 'number',
          description:
            'How long to block before returning `still_waiting`. Default 45, max 120 — this ' +
            'call is synchronous, so a long wait looks like a hang to everyone watching.',
        },
      },
      required: ['session'],
      additionalProperties: false,
    },
  },
  
  
  {
    name: 'wait',
    annotations: { title: 'Wait for a session to go idle', readOnlyHint: true, destructiveHint: false },
    description:
      'Block until a session finishes what it is doing, or until the timeout. Use this after ' +
      '`start` instead of calling `poll` in a loop — an agent without it polled a 20-second job ' +
      'at 19 seconds and was effectively blind for the whole run. Returns as soon as the session ' +
      'is idle; if it is waiting on a human instead, that is reported rather than waited out, ' +
      'because no amount of waiting will clear a password prompt. PASS THE HANDLE from `start` ' +
      'whenever you have one: a foreground shell script (`brew install`, `./configure`, `rustup`) ' +
      'makes the pane look idle while it runs, and the handle is what settles the question for ' +
      'certain however much the command prints.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session to wait on.' },
        handle: {
          type: 'string',
          description:
            'The handle from `start`. Given one, this waits for THAT command to write its exit ' +
            'marker instead of judging by the look of the pane — which cannot tell a shell ' +
            'sitting at a prompt from a shell script running as `bash`.',
        },
        timeout_seconds: {
          type: 'integer',
          description: 'Give up after this long (default 60, max 300). Returns still_running.',
        },
      },
      required: ['session'],
      additionalProperties: false,
    },
  },

  {
    name: 'width',
    annotations: { title: 'Set pane width', readOnlyHint: false, destructiveHint: false },
    description:
      "Re-assert a LIVE session's pane width, in columns. tmux truncates output to the pane, " +
      'and the width is NOT stable — the terminal is shared, so a human attaching resizes it, ' +
      'and a column layout you calibrated on one call can differ on the next. Use this when you ' +
      'find output being cut; the alternative used to be recreating the session, which discards ' +
      'the sudo timestamp and costs your human another password. Check the current value with ' +
      '`pane_width` in `list`. For anything you intend to parse, width-independent output ' +
      '(--json, -o fields, --no-headers) remains the only real defence.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session to resize.' },
        columns: { type: 'integer', description: 'Pane width in columns (20-2000).' },
      },
      required: ['session', 'columns'],
      additionalProperties: false,
    },
  },
{
    name: 'purge',
    annotations: { title: 'Erase a session transcript', readOnlyHint: false, destructiveHint: true },
    description:
      "Erase a session's recorded transcript. Every session is recorded to " +
      '~/.ath/log/<name>.log — every command and every byte of output — and that file SURVIVES ' +
      '`kill`. Use this when you were told to leave nothing behind, or when something sensitive ' +
      'was printed. It clears the transcript ONLY: ~/.ath/requests/ still holds the reason text ' +
      'of any human request, which quotes the command, and ~/.ath/rc/ holds exit codes and ' +
      'timings for about 6 hours. Run `doctor` for the full list of what is left.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session whose transcript to erase.' },
      },
      required: ['session'],
      additionalProperties: false,
    },
  },
  {
    name: 'doctor',
    annotations: { title: 'What the hub left on disk', readOnlyHint: true, destructiveHint: false },
    description:
      'List everything the hub has written to this machine, with sizes, and say which of it ' +
      '`purge` removes. Use it to answer "what did this leave behind?" before reporting that a ' +
      'task left nothing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'unpin',
    annotations: { title: 'Unpin a session', readOnlyHint: false, destructiveHint: false },
    description:
      'Remove a pin so the session can be killed. A pin marks a terminal as protected; `kill` ' +
      'refuses a pinned session. If YOU pinned it, this is how you undo that — previously there ' +
      'was no way back from an MCP-only session, and the refusal said a human had claimed the ' +
      'terminal even when the agent had pinned it itself.',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string', description: 'Session to unpin.' } },
      required: ['session'],
      additionalProperties: false,
    },
  },
{
    name: 'kill',
    annotations: { title: 'Close a terminal', readOnlyHint: false, destructiveHint: true },
    description:
      'Permanently destroy a session and its shell state. Only do this when the human asked, or ' +
      'for a session you created for a finished throwaway task.',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string' } },
      required: ['session'],
      additionalProperties: false,
    },
  },
] as const;
