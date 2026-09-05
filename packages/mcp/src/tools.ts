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
      'Run a command in a session and wait for it to finish. Returns the exact combined ' +
      'stdout+stderr and the real exit code. IMPORTANT: if the result has needsInput=true, the ' +
      'command is waiting on a password or a confirmation prompt. Do NOT attempt to answer it and ' +
      'never send a credential — report it to the human, who is attached to the same terminal and ' +
      'will type it. Then continue with the `read` tool. (The CLI signals these as exit codes 75 ' +
      'and 76; here they are the `needs_input` and `timed_out` fields instead.)',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session name.' },
        command: { type: 'string', description: 'Shell command to run.' },
        timeout_seconds: {
          type: 'number',
          description: 'How long to wait before returning partial output. Default 120.',
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
      'so you are not re-reading the same output into your context every time.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        lines: { type: 'number', description: 'How many trailing lines to return. Default 200.' },
        since: {
          type: 'number',
          description: 'Byte offset from a previous read\'s next_offset. Returns only newer output.',
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
      'For ordinary commands prefer the `run` tool, which just waits.',
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
      'calls out sensibly for the work you are waiting on.',
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
      'can collect the outcome. Use it to check the state of a handoff. You do NOT need it to ' +
      'discover that a request exists: whatever filed one told you so at the time.',
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
      'Wait for a human to answer the prompt in this session, then return the outcome and exit ' +
      'code. Use it instead of polling in a loop. It returns the moment the command finishes, is ' +
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
