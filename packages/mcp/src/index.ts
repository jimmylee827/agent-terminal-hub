#!/usr/bin/env node
import {
  assertRemoteConnected,
  AthError,
  create,
  get,
  kill,
  latestHandle,
  list,
  listAllRequests,
  listRequests,
  notePrompts,
  reapResolvedRequests,
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

/**
 * Metadata as JSON, command output as its OWN block.
 *
 * `content` is a list for exactly this reason. Folding output into the JSON
 * ran it through JSON.stringify, so a 93-line `ss` dump arrived as one string
 * full of literal \n — readable only after unescaping it, and noticeably worse
 * than the same command through the CLI. An agent evaluating this reasonably
 * concluded it should use the CLI whenever output was large, which defeats the
 * point of the typed tools.
 */
function jsonWithOutput(value: Record<string, unknown>, output: string): ToolResult {
  // Output FIRST. An agent reported that "the thing I care about is never at
  // the top" — metadata is the smaller, more predictable half, so it reads
  // better underneath.
  const blocks: { type: 'text'; text: string }[] = [];
  // Blocks are concatenated by some clients, so raw output ran straight into
  // the JSON: "…6% /boot/efi{\"session\": \"hk\"…". Harmless for tabular
  // output, genuinely ambiguous for a command that emits JSON itself. A
  // trailing newline and a labelled trailer keep the boundary visible however
  // the client chooses to render them.
  if (output) blocks.push({ type: 'text', text: output.endsWith('\n') ? output : `${output}\n` });
  blocks.push({ type: 'text', text: `--- ath ---\n${JSON.stringify(value, null, 2)}` });
  return { content: blocks };
}

async function dispatch(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'list': {
      const sessions = await list();
      if (sessions.length === 0) {
        return text('No sessions yet. Create one with the `new` tool.');
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

    case 'new': {
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
        // `cwd` used to be the LOCAL directory even for a remote session, so
        // creating a session on another machine answered with this Mac's path.
        // The first field a caller reads must not be the wrong one; the local
        // path is still available, named for what it is.
        cwd: effectiveCwd(session),
        ...(session.remote ? { remote: session.remote, local_cwd: session.cwd } : {}),
        state: session.state,
        note: 'This session persists between your calls. Reuse it rather than creating another.',
        human_can_join_with: `ath attach ${session.name}`,
      });
    }

    case 'run': {
      const session = String(args.session ?? '');
      const command = String(args.command ?? '');
      const result = await run(session, command, {
        timeoutMs: Number(args.timeout_seconds ?? 120) * 1000,
        waitForIdle: Boolean(args.wait_for_idle),
      });

      const payload: Record<string, unknown> = {
        session: result.session,
        exit_code: result.exitCode,
        state: result.state,
      };

      // A request was filed on the caller's behalf — SAY SO.
      //
      // The CLI prints a loud banner for this; the MCP form dropped the field
      // entirely. So a non-interactive refusal (`sudo -n`) came back as an
      // ordinary failure while a human request had silently been filed. An
      // agent then reasonably concluded no request existed, and only found out
      // by checking a second surface. The run result and the request queue
      // must not disagree.
      if (result.needsHuman) {
        payload.human_requested = true;
        payload.what_to_do =
          `A request for a human has been filed: ${result.needsHuman} Tell the user what is ` +
          `needed and stop. Do not retry it, and do not try to supply the credential yourself.`;
      }

      if (result.needsInput) {
        payload.needs_input = true;
        payload.what_to_do =
          'This command is waiting for a human. Do not answer it and do not send any credential. ' +
          'A request HAS ALREADY BEEN FILED for you — you do not need to create one. Tell the ' +
          'user which session is waiting and what for, then stop. Call request_human only to ' +
          'additionally raise a notification in their editor. After they respond, use `read` ' +
          'to see the result.';
      }
      if (result.timedOut && !result.needsInput) {
        payload.timed_out = true;
        payload.what_to_do =
          'Still running; the output above is partial. Poll with `read`, or re-run with a ' +
          'larger timeout_seconds.';
      }
      if (result.shellExited) {
        payload.shell_exited = true;
        payload.what_to_do =
          'The command ended the session shell (it contained exit). The session survived and is ' +
          'respawned automatically on the next call, but its previous shell state is gone.';
      }
      return jsonWithOutput(payload, result.output);
    }

    case 'read': {
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

    case 'start': {
      const session = String(args.session ?? '');
      const started = await start(session, String(args.command ?? ''));
      return json({
        session: started.session,
        handle: started.handle,
        next_offset: started.offset,
        // "Running in the background" reads as concurrency, and it is not.
        // It is non-blocking for the CALLER but exclusive to the SESSION: the
        // next command here fails with session_busy until this finishes. An
        // agent that tests the difference with a job which happens to finish
        // in one second concludes the session stayed usable, and builds on a
        // wrong model. Say the guarantee, and name the remedy — a second
        // session, not --wait, which would queue behind this instead of
        // running alongside it.
        // Kept to one line. The long form was three lines of boilerplate on
        // every single call — "a small, repeated context tax", mostly warning
        // about a mistake the caller was not making. The guarantee still has
        // to be here, because assuming concurrency is the expensive error.
        note:
          'Session is BUSY until this finishes (work in parallel = second session). ' +
          'Poll with this handle and next_offset; offsets are per session, not per handle.',
      });
    }

    case 'poll': {
      const session = String(args.session ?? '');
      const result = await poll(session, String(args.handle ?? ''), Number(args.since ?? 0));
      const payload: Record<string, unknown> = {
        session: result.session,
        done: result.done,
        next_offset: result.nextOffset,
        state: result.state,
      };
      // How long it actually ran. A one-second job and a sixty-seven-second
      // job were previously indistinguishable in this response, so an agent
      // that started something it believed was long-running could report the
      // work done on a command that had finished instantly. Name it when the
      // gap between intent and reality is wide enough to matter.
      if (result.elapsedSeconds !== undefined) {
        payload.elapsed_seconds = result.elapsedSeconds;
        if (result.done && result.elapsedSeconds <= 2) {
          payload.note =
            'This finished in about ' + result.elapsedSeconds + 's. If you started it ' +
            'expecting long-running work, it did NOT do what you meant — check the output ' +
            'before treating the job as done.';
        }
      }
      if (result.done) payload.exit_code = result.exitCode;
      if (result.needsInput) {
        payload.needs_input = true;
        payload.what_to_do =
          'Waiting for a human. Do not answer it and do not send any credential. A request ' +
          'HAS ALREADY BEEN FILED — do not create another. Tell the user which session is ' +
          'waiting and what for, then stop. Call request_human only to additionally raise a ' +
          'notification in their editor.';
      }
      // Output as its own block, same as `run` — it was folded into the JSON
      // here, so a long job's output came back escaped while the identical
      // output from `run` came back raw.
      return jsonWithOutput(payload, result.output);
    }

    case 'send': {
      // Same guard as run(): never type into the local shell what was meant
      // for another machine.
      await assertRemoteConnected(args.session as string);
      const session = String(args.session ?? '');
      const keys = String(args.keys ?? '').split(/\s+/).filter(Boolean);
      if (keys.length === 0) return text('No keys given.', true);
      await sendKeys(session, keys);
      return text(`Sent ${keys.join(' ')} to "${session}". Use the read tool to see the effect.`);
    }

    case 'request_human': {
      const session = String(args.session ?? '');
      const reason = String(args.reason ?? 'input needed');
      // BIND the request to the command it is about.
      //
      // Filed with no handle, a request had nothing to check itself against,
      // so it could never be resolved and sat in the queue reading "blocked —
      // needs you" long after the command it described had succeeded. The
      // session's in-flight command is what the human is being asked about, so
      // carry its handle: that is what lets the outcome be collected, and what
      // lets the request clear itself once the command ends.
      const handle = await latestHandle(session).catch(() => undefined);
      const parked = await get(session)
        .then((s) => s.state === 'needs-input')
        .catch(() => false);

      // Do not file a SECOND request for the same prompt.
      //
      // A command that hits a wall already files one automatically; the tool
      // exists to add an editor notification on top. An agent that reads
      // "call request_human" as "no request exists, create one" produced a
      // duplicate for a single prompt — the message has been fixed, but the
      // operation should be idempotent regardless, because two entries for
      // one prompt is a queue that lies about how much is owed.
      const existing = (await listRequests().catch(() => [])).find(
        (r) => r.session === session && r.handle === handle && handle !== undefined,
      );
      if (existing) {
        return json({
          requested: true,
          id: existing.id,
          already_open: true,
          note:
            'A request for this command was already open, so nothing new was filed. The human ' +
            'has been notified. Tell them what is needed and stop.',
        });
      }

      const request = await requestHuman(session, reason, 'agent', handle, parked);
      return json({
        requested: true,
        id: request.id,
        session,
        note:
          'The human has been notified in their editor with a button that attaches them to this ' +
          'session. Tell them what you need in your reply as well, then wait for them.',
      });
    }

    case 'requests': {
      await notePrompts().catch(() => undefined);
      await reapResolvedRequests().catch(() => undefined);
      const only = args.session === undefined ? undefined : String(args.session);
      const all = (await listAllRequests()).filter((r) => only === undefined || r.session === only);
      if (all.length === 0) {
        return text(
          only === undefined
            ? 'Nothing is waiting on a human.'
            : `Nothing is waiting on a human in "${only}".`,
        );
      }
      const rows = [];
      for (const r of all) {
        const res = r.handle ? await poll(r.session, r.handle).catch(() => undefined) : undefined;
        const code = res?.done ? (res.exitCode ?? null) : null;
        const interrupted = code === 130 || code === 143;
        rows.push({
          id: r.id,
          session: r.session,
          asked_for: r.reason,
          // "Finished" is not "answered": Ctrl-C at a prompt also produces an
          // exit code. Report the outcome and let the reader judge.
          status: r.resolvedAt
            ? 'resolved'
            : res?.done
              ? interrupted
                ? `NOT answered — interrupted (exit ${code})`
                : `answered — exit ${code}`
              : 'waiting for a human',
          ...(r.handle && res?.done ? { collect_with: { session: r.session, handle: r.handle } } : {}),
        });
      }
      return json(rows);
    }

    case 'await_human': {
      const session = String(args.session ?? '');
      const deadline = Date.now() + Number(args.timeout_seconds ?? 300) * 1000;
      let handle = args.handle === undefined ? undefined : String(args.handle);
      if (!handle) {
        const open = (await listRequests()).filter((r) => r.session === session && r.handle);
        handle = open[open.length - 1]?.handle ?? (await latestHandle(session).catch(() => undefined));
      }
      if (!handle) {
        return json({
          outcome: 'nothing_pending',
          note:
            `Nothing in "${session}" has a command to wait on. If you started one with \`start\`, ` +
            `pass its handle.`,
        });
      }
      for (;;) {
        const alive = await get(session).then(() => true).catch(() => false);
        if (!alive) {
          return json({ outcome: 'session_gone', note: 'The session died; any answer was lost.' });
        }
        const res = await poll(session, handle).catch(() => undefined);
        if (res?.done) {
          const code = res.exitCode ?? 0;
          await reapResolvedRequests(session).catch(() => undefined);
          return jsonWithOutput(
            {
              outcome: code === 130 || code === 143 ? 'interrupted' : 'answered',
              exit_code: code,
              session,
              handle,
            },
            res.output,
          );
        }
        if (Date.now() >= deadline) {
          return json({
            outcome: 'timeout',
            note: 'Still waiting on a human. Do not loop on this — tell the user again.',
          });
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    case 'kill': {
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
    // `annotations` must be forwarded, not dropped — this map is easy to write
    // as name/description/inputSchema and silently lose them, which is exactly
    // what happened the first time and left every title blank.
    //
    // Titles are still not the whole story, so the NAMES have to read well on
    // their own. Claude Code's CLI builds "<server> - <title> (MCP)" from the
    // title, but its VS Code panel ignores annotations entirely and renders
    // `humanizedServerName [rawToolName]`. That renderer is why the server is
    // registered as `agent_terminal` and the tools are bare verbs: it is the
    // only combination that reads as "Agent Terminal [run]" rather than as an
    // identifier. Renaming either half changes what a human sees there.
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...('annotations' in tool ? { annotations: tool.annotations } : {}),
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
                    ? 'Something is already running there. Use `read` to see it, or pass ' +
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
