#!/usr/bin/env node
import {
  assertRemoteConnected,
  attachedClientsNote,
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

/**
 * Refuse arguments the tool does not have.
 *
 * `new` accepted a `session` parameter that is not in its schema, ignored it,
 * and returned success — which is, as the agent that hit it put it, "how an
 * agent convinces itself a flag works when it doesn't". Every schema here
 * already declares `additionalProperties: false`; nothing was enforcing it.
 */
function rejectUnknownArgs(name: string, args: Record<string, unknown>): string | undefined {
  const def = TOOL_DEFINITIONS.find((t) => t.name === name);
  const schema = def?.inputSchema as { properties?: Record<string, unknown> } | undefined;
  if (!schema?.properties) return undefined;
  const known = new Set(Object.keys(schema.properties));
  const unknown = Object.keys(args).filter((k) => !known.has(k));
  if (unknown.length === 0) return undefined;
  return (
    `${name} has no parameter${unknown.length > 1 ? 's' : ''} ${unknown.map((u) => `"${u}"`).join(', ')}. ` +
    `Nothing was run. Valid: ${[...known].join(', ') || '(none)'}.`
  );
}

async function dispatch(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const bad = rejectUnknownArgs(name, args);
  if (bad) return text(bad, true);

  switch (name) {
    case 'list': {
      const sessions = await list();
      // An empty hub answered `[]` from the CLI and a sentence from here — the
      // same question in two shapes, so a caller parsing one had to special-case
      // the other. A list tool returns a list; the hint rides alongside it.
      if (sessions.length === 0) {
        return {
          content: [
            { type: 'text', text: '[]' },
            { type: 'text', text: 'No sessions yet. Create one with the `new` tool.' },
          ],
        };
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
          // NOT necessarily humans. This is tmux's client count, and the VS
          // Code panel attaches a real client per session it displays — so a
          // session nobody has touched shows 1 whenever the editor is showing
          // it. Labelled `attached_humans`, that read as "a person is here",
          // and an agent reasonably could not account for the number.
          attached_clients: s.attached,
          last_command: s.lastCommand,
          last_exit_code: s.lastExitCode,
          summary: summarize(s),
        })),
      );
    }

    case 'new': {
      // Accept `session` as an alias for `name`. Every other tool here takes
      // `session`, so an agent that has used any of them reaches for it, gets
      // refused, and spends a retry on an inconsistency that is the tool's, not
      // theirs. The strict unknown-argument check makes that a hard error, so
      // the alias has to be real rather than merely tolerated.
      const session = await create({
        name: (args.name ?? args.session) as string | undefined,
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
      // A warning nobody is shown is not a warning.
      //
      // `warning` has been computed in core for several rounds and displayed by
      // NEITHER surface — so the credential blind-spot guard and the tree-walk
      // guard were both invisible, and an agent walked into the 50 GB `du`
      // trap the second one exists to prevent. The tests passed because they
      // read `--json`, which dumps every field: they checked that the data was
      // produced, never that anyone could see it.
      if (result.warning) payload.warning = result.warning;
      if (result.exitCaveat) payload.exit_code_covers = result.exitCaveat;
      if (result.exitCaveatNote) payload.exit_code_caveat = result.exitCaveatNote;

      if (result.needsHuman) {
        // `needsHuman` covers two different situations, and this said the same
        // thing about both: "A request for a human has been filed", followed by
        // guidance explaining that nothing is waiting and nobody can answer yet.
        // A flag that contradicts its own explanation is a trap — an agent that
        // branched on it would have sent someone to answer a prompt that did
        // not exist. Only the PARKED case files anything.
        const filed = result.needsInput === true;
        payload.human_requested = filed;
        payload.what_to_do = filed
          ? `A request for a human has been filed: ${result.needsHuman} Tell the user what is ` +
            `needed and stop. Do not retry it, and do not try to supply the credential yourself.`
          : `${result.needsHuman} No request was filed, because there is nothing for anyone to ` +
            `answer yet — do not send the user to look at an idle terminal.`;
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
      // Say what is known, in the terms it is known in.
      //
      // The previous version withheld a number whenever the bracket was wide,
      // and told the caller "nobody looked while this was running" — to an
      // agent that HAD polled mid-run and been answered. That statement was
      // false about their own session, and it discarded the bracket, which is
      // the actual answer: "between 26 and 60 seconds" is information.
      if (result.elapsedExact && result.elapsedSeconds !== undefined) {
        payload.running_for_seconds = result.elapsedSeconds;
      } else if (result.elapsedSeconds !== undefined) {
        payload.took_seconds = result.elapsedSeconds;
      } else if (result.elapsedLowerSeconds !== undefined) {
        payload.ran_between_seconds = [result.elapsedLowerSeconds, result.elapsedUpperSeconds];
        payload.timing_note = result.elapsedObserved
          ? 'A bracket, not a measurement: it was still running when last checked and finished ' +
            'before the next look. Poll more often for a tighter figure.'
          : 'Upper bound only — nothing observed it while it ran, so all that is known is that ' +
            'it finished before this check. Poll while a job runs if you need its duration.';
        if ((result.elapsedUpperSeconds ?? 0) <= 2) {
          payload.what_to_do =
            'This finished within a couple of seconds. If you started it expecting long-running ' +
            'work, it did NOT do what you meant — check the output before treating it as done.';
        }
      }
      if (result.warning) payload.warning = result.warning;
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
        // "Nothing is waiting on a human" is three different states wearing one
        // sentence — never asked, already answered, or abandoned — and an agent
        // read it moments after a human had typed a password. Say which.
        const where = only === undefined ? '' : ` in "${only}"`;
        return text(
          `No requests exist${where}, open or recently resolved. That means none was ever ` +
            `filed — NOT that one was answered. If you are checking whether a human answered a ` +
            `command, use the \`poll\` tool with that command's handle: its exit code is the ` +
            `answer. A resolved request would still be listed here for an hour.`,
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
          // Resolved used to short-circuit to the bare word "resolved", which
          // threw away the exit code — the one thing a caller checking "did
          // they answer?" actually needs. Report the OUTCOME either way and let
          // `resolved` be a suffix, not a replacement.
          // Never claim "answered" from an exit code alone. An agent Ctrl-C'd
          // its own `sudo id` and this said `answered — exit 1`, because sudo
          // traps SIGINT and exits 1 rather than 130. Believing that means
          // believing a credential was supplied.
          status: res?.done
            ? interrupted
              ? `NOT answered — interrupted (exit ${code})${r.resolvedAt ? ', resolved' : ''}`
              : code === 0
                ? `done — exit 0${r.resolvedAt ? ', resolved' : ''}`
                : `finished — exit ${code}, NOT proof anyone answered${r.resolvedAt ? ', resolved' : ''}`
            : r.resolvedAt
              ? 'resolved without a recorded outcome'
              : 'waiting for a human',
          ...(r.handle && res?.done ? { collect_with: { session: r.session, handle: r.handle } } : {}),
        });
      }
      return json(rows);
    }

    case 'await_human': {
      const session = String(args.session ?? '');
      // BOUNDED, and short by default.
      //
      // This blocked for up to five minutes. An MCP call is synchronous from
      // the agent's side, so a five-minute block is indistinguishable from a
      // hang — and it was read as one: the user had to interrupt with "the wait
      // tool use is bugged and let you stucked". The CLI's `ath await` is meant
      // to be BACKGROUNDED by a harness; there is no backgrounding here, so the
      // same duration that is correct there is wrong here.
      //
      // A short wait that returns `still_waiting` keeps the agent responsive and
      // lets it say something useful to the person it is waiting on.
      const waitMs = Math.min(Math.max(Number(args.timeout_seconds ?? 45), 5), 120) * 1000;
      const deadline = Date.now() + waitMs;
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
      // Never let one slow call swallow the deadline. `poll` shells out to
      // tmux; if that stalls, an unguarded await sits inside it forever and the
      // deadline below is never even evaluated. Racing each attempt against the
      // remaining time means the tool always returns something.
      const withDeadline = async <T>(p: Promise<T>): Promise<T | undefined> =>
        Promise.race([
          p.catch(() => undefined),
          new Promise<undefined>((r) => setTimeout(() => r(undefined), Math.max(1000, deadline - Date.now()))),
        ]);

      for (;;) {
        const alive = (await withDeadline(get(session).then(() => true))) ?? false;
        if (!alive && Date.now() < deadline) {
          return json({ outcome: 'session_gone', note: 'The session died; any answer was lost.' });
        }
        const res = await withDeadline(poll(session, handle, Number(args.since ?? 0)));
        if (res?.done) {
          const code = res.exitCode ?? 0;
          await reapResolvedRequests(session).catch(() => undefined);
          // Same trap as the requests listing: sudo traps SIGINT and exits 1,
          // so an interrupted credential prompt never shows 130/143. Only
          // exit 0 is safe to state positively.
          const interrupted = code === 130 || code === 143;
          const answered = code === 0;
          return jsonWithOutput(
            {
              outcome: answered ? 'done' : interrupted ? 'interrupted' : 'finished_nonzero',
              exit_code: code,
              session,
              handle,
              next_offset: res.nextOffset,
              // Say that the credential is now cached, rather than leaving it to
              // be guessed. An agent guessed "the usual 15 minutes" and said it
              // was gambling — a wrong guess costs the human a second
              // interruption for nothing.
              ...(answered
                ? {
                    note:
                      'If that was a sudo password, its timestamp is now cached for THIS session ' +
                      '(~15 min, per-tty). Further sudo commands here will not prompt again — ' +
                      'confirm with `sudo -n true`. Another session will still prompt. The ' +
                      'password itself is NOT in the session log (a prompt echoes nothing), so ' +
                      'there is nothing to purge.',
                  }
                : {
                    note:
                      `The command ended with exit ${code}. That is NOT proof a human answered: a ` +
                      'wrong password, an interrupt, and the command failing on its own all look ' +
                      'the same from here. Read the output before assuming you have elevation.',
                  }),
            },
            res.output,
          );
        }
        if (Date.now() >= deadline) {
          return json({
            outcome: 'still_waiting',
            session,
            handle,
            note:
              'Nobody has answered yet — this is NOT a failure and the request is still open. ' +
              'Tell the user what you need and stop. If you are resuming after they said they ' +
              'answered, call this again, or check with the `poll` tool using this handle. Do ' +
              'not call it repeatedly in a loop.',
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
      const attached = await get(session)
        .then((x) => x.attached)
        .catch(() => 0);
      await kill(session);
      const note = attachedClientsNote(attached);
      return text(`Session "${session}" destroyed.${note ? ` ${note}` : ''}`);
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
