#!/usr/bin/env node
import {
  assertRemoteConnected,
  AthError,
  create,
  kill,
  list,
  poll,
  readSince,
  readTail,
  requestHuman,
  run,
  sendKeys,
  start,
  summarize,
  effectiveCwd,} from '@ath/core';

import { TOOL_DEFINITIONS } from './tools';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function text(body: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: body }], ...(isError ? { isError: true } : {}) };
}

function json(value: unknown): ToolResult {
  return text(JSON.stringify(value, null, 2));
}

async function dispatch(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'terminal_list': {
      const sessions = await list();
      if (sessions.length === 0) {
        return text('No sessions yet. Create one with terminal_new.');
      }
      return json(
        sessions.map((s) => ({
          name: s.name,
          state: s.state,
          // Where commands actually execute. For a remote session the raw
          // `cwd` is the LOCAL directory ssh was launched from, which is not
          // where anything runs.
          cwd: effectiveCwd(s),
          local_cwd: s.remote ? s.cwd : undefined,
          current_command: s.currentCommand,
          pinned: s.pinned,
          remote: s.remote,
          attached_humans: s.attached,
          last_command: s.lastCommand,
          last_exit_code: s.lastExitCode,
          summary: summarize(s),
        })),
      );
    }

    case 'terminal_new': {
      const session = await create({
        name: args.name as string | undefined,
        cwd: args.cwd as string | undefined,
        remote: args.remote as string | undefined,
        label: args.label as string | undefined,
        pin: Boolean(args.pin),
        owner: 'agent',
      });
      return json({
        name: session.name,
        cwd: session.cwd,
        state: session.state,
        note: 'This session persists between your calls. Reuse it rather than creating another.',
        human_can_join_with: `ath attach ${session.name}`,
      });
    }

    case 'terminal_run': {
      const session = String(args.session ?? '');
      const command = String(args.command ?? '');
      const result = await run(session, command, {
        timeoutMs: Number(args.timeout_seconds ?? 120) * 1000,
        waitForIdle: Boolean(args.wait_for_idle),
      });

      const payload: Record<string, unknown> = {
        session: result.session,
        exit_code: result.exitCode,
        output: result.output,
        state: result.state,
      };

      if (result.needsInput) {
        payload.needs_input = true;
        payload.what_to_do =
          'This command is waiting for a human. Do not answer it and do not send any credential. ' +
          `Call terminal_request_human with session "${session}" and what is needed, tell the user, ` +
          'then stop. After they respond, use terminal_read to see the result.';
      }
      if (result.timedOut && !result.needsInput) {
        payload.timed_out = true;
        payload.what_to_do =
          'Still running; the output above is partial. Poll with terminal_read, or re-run with a ' +
          'larger timeout_seconds.';
      }
      if (result.shellExited) {
        payload.shell_exited = true;
        payload.what_to_do =
          'The command ended the session shell (it contained exit). The session survived and is ' +
          'respawned automatically on the next call, but its previous shell state is gone.';
      }
      return json(payload);
    }

    case 'terminal_read': {
      const session = String(args.session ?? '');
      if (args.since !== undefined) {
        const result = await readSince(session, Number(args.since));
        return json({
          session,
          output: result.output,
          next_offset: result.nextOffset,
          note: 'Pass next_offset as `since` on your next read to avoid re-reading this output.',
        });
      }
      return text(await readTail(session, Number(args.lines ?? 200)));
    }

    case 'terminal_start': {
      const session = String(args.session ?? '');
      const started = await start(session, String(args.command ?? ''));
      return json({
        session: started.session,
        handle: started.handle,
        next_offset: started.offset,
        note:
          'Running in the background. Check it with terminal_poll using this handle and ' +
          'next_offset. Space your polls to match the work — do not spin.',
      });
    }

    case 'terminal_poll': {
      const session = String(args.session ?? '');
      const result = await poll(session, String(args.handle ?? ''), Number(args.since ?? 0));
      const payload: Record<string, unknown> = {
        session: result.session,
        done: result.done,
        output: result.output,
        next_offset: result.nextOffset,
        state: result.state,
      };
      if (result.done) payload.exit_code = result.exitCode;
      if (result.needsInput) {
        payload.needs_input = true;
        payload.what_to_do =
          'Waiting for a human. Do not answer it and do not send any credential. Call ' +
          'terminal_request_human, tell the user, then stop.';
      }
      return json(payload);
    }

    case 'terminal_send': {
      // Same guard as run(): never type into the local shell what was meant
      // for another machine.
      await assertRemoteConnected(args.session as string);
      const session = String(args.session ?? '');
      const keys = String(args.keys ?? '').split(/\s+/).filter(Boolean);
      if (keys.length === 0) return text('No keys given.', true);
      await sendKeys(session, keys);
      return text(`Sent ${keys.join(' ')} to "${session}". Use terminal_read to see the effect.`);
    }

    case 'terminal_request_human': {
      const session = String(args.session ?? '');
      const reason = String(args.reason ?? 'input needed');
      const request = await requestHuman(session, reason);
      return json({
        requested: true,
        id: request.id,
        session,
        note:
          'The human has been notified in their editor with a button that attaches them to this ' +
          'session. Tell them what you need in your reply as well, then wait for them.',
      });
    }

    case 'terminal_kill': {
      const session = String(args.session ?? '');
      // Deliberately never forced. A pin is how the human sharing this
      // terminal says "not this one"; an agent that could override it would
      // make the pin meaningless.
      await kill(session);
      return text(`Session "${session}" destroyed.`);
    }

    default:
      return text(`Unknown tool: ${name}`, true);
  }
}

async function main(): Promise<void> {
  // The SDK is ESM-only; this package stays CommonJS like the rest of the repo,
  // so it is pulled in with a dynamic import rather than a dual-package build.
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import(
    '@modelcontextprotocol/sdk/types.js'
  );

  const server = new Server(
    { name: 'agent-terminal-hub', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await dispatch(name, (args ?? {}) as Record<string, unknown>);
    } catch (err) {
      if (err instanceof AthError) {
        // Structured so the agent can react rather than just seeing a stack.
        return text(
          JSON.stringify(
            {
              error: err.code,
              message: err.message,
              what_to_do:
                err.code === 'session_gone'
                  ? 'The human killed this session. Do not recreate it silently — say so, and ask ' +
                    'whether to continue in a new one.'
                  : err.code === 'session_busy'
                    ? 'Something is already running there. Use terminal_read to see it, or pass ' +
                      'wait_for_idle.'
                    : undefined,
            },
            null,
            2,
          ),
          true,
        );
      }
      return text(String(err instanceof Error ? err.message : err), true);
    }
  });

  await server.connect(new StdioServerTransport());
  // stdout is the protocol channel; anything human-facing must go to stderr.
  process.stderr.write('agent-terminal-hub MCP server ready\n');
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
