#!/usr/bin/env node
import { promises as fsp } from 'node:fs';

import {
  augmentRequestReason,
  assertRemoteConnected,
  attachedClientsNote,
  AthError,
  commandOutcome,
  type CommandOutcome,
  create,
  get,
  kill,
  lastCommandEvidence,
  latestHandle,
  list,
  listAllRequests,
  listRequests,
  logPath,
  ATH_ARTIFACTS,
  ATH_HOME,
  notePrompts,
  reapResolvedRequests,
  poll,
  readSince,
  readTail,
  purgeLog,
  requestHuman,
  run,
  setPinned,
  setWidth,
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
/**
 * How a resize is told, in one place, so `run` and `poll` cannot drift.
 *
 * `from === to` is not a no-op: it means the pane moved and moved back between
 * observations, and `seen` is the only surviving evidence that anything written
 * in between was formatted to a different width.
 *
 * The long paragraph rides on `explain`, which is true only the first time for
 * a session. Two agents complained about the exit-code caveat in opposite
 * directions — one stopped reading a sentence repeated on every result, the
 * other missed a hazard announced once and then never again. The resolution
 * there applies here: the marker is always present and costs nothing, and the
 * explanation is given once.
 */
function widthNote(w: { from: number; to: number; seen?: number[]; explain?: boolean }): string {
  const moved =
    w.from === w.to
      ? `The pane was resized and put back (${(w.seen ?? []).join(' → ')}) while this was running`
      : `The pane was resized from ${w.from} to ${w.to} columns`;
  if (!w.explain) {
    return `${moved}. Column layouts measured earlier may no longer hold.`;
  }
  return (
    `${moved} — a human attaching does that, usually to answer a prompt. ` +
    `Width-aware tools (ps, docker ps, lsblk, vmstat) format themselves to the pane, so a ` +
    `layout you calibrated earlier may not hold for output written after the change. If you ` +
    `are parsing by column, re-read rather than trusting it, or switch to width-independent ` +
    `output (--json/--format/-o). ` +
    (w.from === w.to
      ? `Note the width ended where it started: comparing before and after would show no ` +
        `change at all, which is why the full sequence is reported.`
      : '')
  );
}

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
          // Omitted for a remote session, where it is always "ssh".
          //
          // It is tmux's `pane_current_command`, and for a remote session that
          // is the transport, not the work — an agent reported it as "ssh" for
          // all three of its sessions and said it "carries no information".
          // Reporting the same constant for every session is worse than
          // reporting nothing: it looks like an answer. `last_command` is the
          // field that actually says what ran.
          ...(s.remote && s.currentCommand === 'ssh'
            ? {}
            : { current_command: s.currentCommand }),
          // Who created this session. Set at creation and never surfaced
          // anywhere, so an agent that read about it in the docs could not find
          // it in any output and could not say what drove it.
          owner: s.owner,
          pinned: s.pinned,
          remote: s.remote,
          // NOT necessarily humans. This is tmux's client count, and the VS
          // Code panel attaches a real client per session it displays — so a
          // session nobody has touched shows 1 whenever the editor is showing
          // it. Labelled `attached_humans`, that read as "a person is here",
          // and an agent reasonably could not account for the number.
          attached_clients: s.attached,
          // Reported because the docs warn that tmux truncates to this width
          // and then gave no way to see it. An agent found `MOUNTPOINT`
          // rendered as `MOUNTPOIN`, correctly identified the cause from the
          // docs, and had no surface telling it the pane was 156 columns.
          pane_width: s.paneWidth,
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
        width: args.width === undefined ? undefined : Number(args.width),
        owner: 'agent',
      });
      return json({
        name: session.name,
        // `cwd` used to be the LOCAL directory even for a remote session, so
        // creating a session on another machine answered with this Mac's path.
        // The first field a caller reads must not be the wrong one; the local
        // path is still available, named for what it is.
        // For a REMOTE session this must be the remote path, as it is in `list`.
        //
        // `effectiveCwd` falls back to the local directory until the remote
        // shell has reported one — and at creation it never has, so `new`
        // answered with this Mac's path while `list` answered with the remote
        // one. Same key, opposite meaning, one call apart. A fresh remote
        // session's shell sits in the remote home, so say that.
        cwd: session.remote ? (session.remoteCwd ?? '~') : effectiveCwd(session),
        ...(session.remote ? { remote: session.remote, local_cwd: session.cwd } : {}),
        state: session.state,
        note: 'This session persists between your calls. Reuse it rather than creating another.',
        human_can_join_with: `ath attach ${session.name}`,
        // Disclosed at creation, because no later call has a reason to mention
        // it and the recording has already started. An agent that knows the
        // transcript exists can warn its human before echoing a secret into
        // the pane; one that does not, cannot. It also outlives this session,
        // so the caller is told how it goes away.
        recorded_to: logPath(session.name),
        recording_note:
          'Everything printed in this session is appended there, including output you did not read. It survives `kill`; remove it with `ath purge ' +
          session.name +
          '`.',
      });
    }

    case 'run': {
      const session = String(args.session ?? '');
      const command = String(args.command ?? '');
      const result = await run(session, command, {
        timeoutMs: Number(args.timeout_seconds ?? 120) * 1000,
        waitForIdle: Boolean(args.wait_for_idle),
        maxBytes: args.max_bytes === undefined ? undefined : Number(args.max_bytes),
      });

      const payload: Record<string, unknown> = {
        session: result.session,
        exit_code: result.exitCode,
        state: result.state,
        // The doc names this as a shared field and MCP never emitted it, so an
        // agent working here could not find what it had been promised — the
        // same shape of gap as a doc naming a field in the wrong spelling.
        log_offset: result.logOffset,
      };

      // The only silent-corruption path in the tool, finally given a voice.
      // A human attaching — usually to answer a password prompt this very
      // command raised — resizes the pane, so anything parsed by column reads
      // differently from here on. Two agents hit it; neither was told.
      // An unreliable capture outranks everything else this result can say.
      if (result.captureIncomplete) {
        payload.capture_incomplete = true;
        payload.what_to_do =
          'The output below could NOT be framed and may be empty or partial — do not treat it ' +
          'as what the command printed. The exit code is still exact; only the capture is in ' +
          `doubt. Re-read with the \`read\` tool and since=${result.logOffset} before drawing ` +
          'any conclusion, especially a negative one: "no results" from this call is not ' +
          'evidence there were none.';
      }
      // Promised by this tool's own schema, and not emitted until now — the
      // same gap the comment above `log_offset` describes, one field over and
      // introduced by the change that added the cap. A marker in the text
      // saying bytes were dropped, with no field saying how many, forces the
      // agent to parse prose to learn something it was told would be data.
      if (result.omittedBytes !== undefined) {
        payload.omitted_bytes = result.omittedBytes;
        payload.omitted_resume_from = result.omittedResumeFrom;
      }
      if (result.paneWidthChanged) {
        payload.pane_width_changed = result.paneWidthChanged;
        // Do not overwrite the louder notice above.
        if (!result.captureIncomplete) payload.what_to_do = widthNote(result.paneWidthChanged);
      }

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
      if (result.exitCodeCovers) payload.exit_code_covers = result.exitCodeCovers;
      if (result.exitCodeCaveat) payload.exit_code_caveat = result.exitCodeCaveat;

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
        const result = await readSince(
          session,
          Number(args.since),
          args.max_bytes === undefined ? undefined : Number(args.max_bytes),
        );
        return json({
          session,
          output: result.output,
          next_offset: result.nextOffset,
          ...(result.lostBytes === undefined
            ? {}
            : {
                lost_bytes: result.lostBytes,
                lost_note:
                  `${result.lostBytes} bytes before this point were TRIMMED AWAY and cannot be ` +
                  `recovered — a session log is rewritten to its last 8 MB once it passes 32 MB, ` +
                  `which invalidates offsets issued before that. The output below resumes from ` +
                  `the earliest byte that still exists. For a job this size, write it to a file ` +
                  `on the host and read that instead of relying on the transcript.`,
              }),
          ...(result.offsetBeyondEnd ? { offset_beyond_end: true } : {}),
          ...(result.omittedBytes === undefined
            ? {}
            : {
                omitted_bytes: result.omittedBytes,
                omitted_resume_from: result.omittedResumeFrom,
                omitted_note:
                  `${result.omittedBytes} bytes were left out of the middle to keep this ` +
                  `readable. They are NOT lost — read them with since=${result.omittedResumeFrom}. ` +
                  `Pass max_bytes: 0 if you want everything in one call.`,
              }),
          note: 'Pass next_offset as `since` on your next read to avoid re-reading this output.',
        });
      }
      // Output block PLUS metadata, like every other tool that returns both.
      //
      // This branch alone returned bare text, so it carried no `next_offset`
      // and no `--- ath ---` trailer — an agent reported both, as one symptom
      // ("the documented round-trip can't be bootstrapped") and one puzzle
      // ("two results had no metadata block at all; I couldn't tell whether
      // that was intentional"). It was not intentional.
      const tail = await readTail(session, Number(args.lines ?? 200));
      return jsonWithOutput(
        {
          session,
          next_offset: tail.nextOffset,
          note: 'Pass next_offset as `since` on your next read to get ONLY what is new.',
        },
        tail.output,
      );
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
          `Poll with this handle and next_offset (${started.offset}) — that number continues ` +
          `session "${started.session}"'s byte stream, so a NEW job does not start at 0. Pass ` +
          'back whatever you were last given.',
        // Named at the point of DECISION, not the point of failure.
        //
        // `session_busy` already explains itself well when a caller trips it;
        // an agent rated that message best-in-class. But it only arrives after
        // the second dispatch has been refused. The fact that decides whether
        // to dispatch at all — is there another session free right now — was
        // available here and never offered, so the caller had to fail first to
        // learn it. Computed live because a stale name is worse than none.
        parallel_work: await parallelHint(started.session),
        // A start that could not be confirmed must not read as a start.
        ...(started.launched === false
          ? {
              launched: false,
              what_to_do:
                'The command was sent but its frame never opened, so it may not be running. ' +
                'Read the session (`read` with a small `lines`) to see what actually happened ' +
                'before you poll — this handle may never complete. Do NOT just send it again: ' +
                'if the session was only slow, the command is queued and re-sending runs it ' +
                'twice.',
            }
          : {}),
        ...(started.warning ? { warning: started.warning } : {}),
      });
    }

    case 'poll': {
      const session = String(args.session ?? '');
      const result = await poll(
        session,
        String(args.handle ?? ''),
        Number(args.since ?? 0),
        args.max_bytes === undefined ? undefined : Number(args.max_bytes),
      );
      const payload: Record<string, unknown> = {
        session: result.session,
        done: result.done,
        next_offset: result.nextOffset,
        state: result.state,
      };
      // The same caveat `run` carries, withheld here until now — which is the
      // worse way round. `poll` is what you call after being AWAY, so an
      // unqualified exit code is least likely to be questioned exactly here. A
      // reviewer polled a job ending in `; date`, got `exit_code: 0` with no
      // caveat, and noted that an agent which had learned "the hub flags this
      // for me" would be walked into the trap by the flag's absence.
      if (result.exitCodeCovers) payload.exit_code_covers = result.exitCodeCovers;
      // Output that is GONE, said out loud.
      //
      // A session log is rewritten to its last 8 MB once it passes 32 MB,
      // which invalidates every offset issued before that. The only signal
      // used to be an empty `output` and a `next_offset` SMALLER than the
      // `since` that was passed — an agent following a 46 MB job read that as
      // "no new output", and ~38 MB of its results were gone under a
      // documented promise that nothing would be.
      if (result.lostBytes !== undefined) {
        payload.lost_bytes = result.lostBytes;
        payload.lost_note =
          `${result.lostBytes} bytes of this command's output were TRIMMED AWAY before this ` +
          `call and cannot be recovered: the log is rewritten to its last 8 MB once it passes ` +
          `32 MB. The output below resumes from the earliest byte that still exists. A job ` +
          `this chatty should write to a file on the host and be read from there — the ` +
          `transcript is not durable storage.`;
      }
      // A dropped remote link, said plainly instead of counted forever.
      // Reported on every poll while it differs, because an agent parsing
      // columns mid-job needs it then, not in a summary after the fact.
      if (result.paneWidthChanged) {
        payload.pane_width_changed = result.paneWidthChanged;
        payload.width_note = widthNote(result.paneWidthChanged);
      }
      if (result.remoteDisconnected) {
        payload.remote_disconnected = true;
        payload.what_to_do =
          'The ssh connection for this remote session dropped while the command was running, ' +
          'so the command is gone and its outcome cannot be recovered — that is why exit_code ' +
          'is null rather than a number. Do NOT keep polling; this handle can never complete. ' +
          'Run any command on the session to reconnect it, then check on the host whether the ' +
          'work actually finished before re-running it.';
      }
      if (result.offsetBeyondEnd) {
        payload.offset_beyond_end = true;
        payload.offset_note =
          'The `since` you passed is past the end of this log, so nothing could be returned. ' +
          'The session was recreated, purged, or this handle belongs to an earlier incarnation. ' +
          'Read with no `since` to get a fresh offset.';
      }
      // Say what is known, in the terms it is known in.
      //
      // The previous version withheld a number whenever the bracket was wide,
      // and told the caller "nobody looked while this was running" — to an
      // agent that HAD polled mid-run and been answered. That statement was
      // false about their own session, and it discarded the bracket, which is
      // the actual answer: "between 26 and 60 seconds" is information.
      // `exact` no longer implies "still running".
      //
      // It used to: the only exact figure available was "how long since I
      // started it", which is a duration-so-far. Now a finished command can
      // report its OWN measurement, taken by the shell that ran it, so the
      // label has to come from `done` rather than from the precision.
      // Mislabelling a finished 6-second job as `running_for_seconds` would be
      // a new way to be wrong about the same field.
      if (result.elapsedSeconds !== undefined) {
        if (result.done) {
          payload.took_seconds = result.elapsedSeconds;
          if (result.elapsedExact) {
            payload.timing_note =
              'Measured by the shell that ran the command, not estimated by the hub.';
          }
        } else {
          payload.running_for_seconds = result.elapsedSeconds;
        }
      } else if (result.elapsedLowerSeconds !== undefined) {
        payload.ran_between_seconds = [result.elapsedLowerSeconds, result.elapsedUpperSeconds];
        payload.timing_note = result.elapsedObserved
          ? 'A bracket, not a measurement: the shell running this could not time it (no `date`), ' +
            'so this is only when the hub looked — it was still running at one check and done by ' +
            'the next. Poll more often for a tighter figure.'
          : `Upper bound only. The 0 is because nothing ever saw it running; the ` +
            `${result.elapsedUpperSeconds}s is simply how long ago YOU started it — this check ` +
            `is the first look, so all that is known is that it finished somewhere in between. ` +
            `Poll while a job runs if you need its duration.`;
        // Both branches above tell the caller to poll harder, which makes the
        // bracket tighter and never exact — the hub can only report when it
        // LOOKED. A command that timestamps itself is measured by the machine
        // running it, so it does not depend on this tool's cadence at all.
        payload.timing_note +=
          ' For an exact figure, time it inside the command itself — the hub can only report when it looked.';
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
        // Keep the caller's reason instead of dropping it on the floor.
        //
        // A parked command files its own request first, so an agent explaining
        // WHY it needs the password arrives second and used to be answered
        // with `already_open: true` and silence. The human was then asked for
        // a credential with no statement of what it was for.
        const merged = await augmentRequestReason(existing.id, reason).catch(() => undefined);
        return json({
          requested: true,
          id: existing.id,
          already_open: true,
          ...(merged && merged.reason !== existing.reason
            ? { reason_added: true, reason: merged.reason }
            : {}),
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
      // Where the handle comes from when the caller did not pass one.
      //
      // An agent noticed this returned a handle for a command it had launched
      // with `run`, not `start`, and said it "appeared without explanation".
      // Fair: a handle is documented as a `start` thing. Every framed command
      // has one — `run` just does not surface it — so this recovers it from the
      // open request, or failing that from the session log. Say which, because
      // an unexplained identifier is one more thing to wonder about.
      let handleSource = 'you passed it';
      if (!handle) {
        // RESOLVED requests count, and are in fact the better evidence.
        //
        // This filtered to OPEN requests only — so the instant a human answered
        // and the request was marked resolved, the one record that proved they
        // had answered became invisible here. The lookup then fell through to
        // the log, which handed back the human's own open prompt frame, and the
        // tool reported "still_waiting" at a prompt that had been answered and
        // a command that had exited 0. The agent believed the password had not
        // been typed and moved on to other work.
        //
        // A request resolved seconds ago is exactly what this is looking for.
        const mine = (await listAllRequests().catch(() => []))
          .filter((r) => r.session === session && r.handle)
          .sort((a, b) => (a.resolvedAt ?? a.createdAt) - (b.resolvedAt ?? b.createdAt));
        handle = mine[mine.length - 1]?.handle;
        handleSource = mine[mine.length - 1]?.resolvedAt
          ? 'a request for this session that has since been answered'
          : 'the open request for this session';
        if (!handle) {
          handle = await latestHandle(session).catch(() => undefined);
          handleSource = 'the last command framed in this session';
        }
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
              handle_from: handleSource,
              // An agent called this "a handle I never created and do not
              // fully understand". Saying where it came from was not enough
              // without saying what it IS.
              ...(args.handle === undefined
                ? {
                    handle_note:
                      'The hub mints a handle for every command it frames, including ones you ran ' +
                      'with `run` rather than `start` — so this identifies a command you did issue, ' +
                      'even though you were never handed the id. It is valid until the session ends, ' +
                      'and polling a finished one returns its result again rather than an error.',
                  }
                : {}),
              next_offset: res.nextOffset,
              // Say that the credential is now cached, rather than leaving it
              // to be guessed — but do NOT name a duration.
              //
              // This said "~15 min" for a long time. The exact figure was never
              // the point: `timestamp_timeout` is a per-machine sudoers setting
              // — the two hosts this was developed against are 5 and 15 — so
              // ANY number stated here is a guess wearing the clothes of a
              // fact. An agent laid out its session plan around the 15,
              // confirmed elevation with `sudo -n true`, and had the very next
              // privileged command prompt anyway. Saying nothing about the
              // duration is strictly better than saying something plannable.
              ...(answered
                ? {
                    note:
                      'If that was a sudo password, its timestamp is now cached for THIS ' +
                      'session, per-tty — another session will still prompt. You cannot know ' +
                      'how long it lasts and must not plan around it: timestamp_timeout is a ' +
                      'local sudoers setting that differs between machines and may be 0. ' +
                      'Confirm with `sudo -n true` immediately before each privileged command ' +
                      'you rely on, never from elapsed time. The password itself is NOT in ' +
                      'the session log (a prompt echoes nothing), so there is nothing to purge.',
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

    case 'wait': {
      const session = String(args.session ?? '');
      // Bounded, and it does NOT wait out a human prompt.
      //
      // A session parked on a password will never go idle on its own, so
      // blocking on it burns the whole timeout and then reports a timeout —
      // hiding the one fact the caller needed. Report the prompt immediately
      // instead; that is a handoff, not a delay.
      const limit = Math.min(Math.max(Number(args.timeout_seconds ?? 60), 1), 300);
      const deadline = Date.now() + limit * 1000;
      // An idle-LOOKING pane is not proof the command finished.
      //
      // `pane_current_command` names the foreground process, and a shell script
      // runs as `bash`, which classifies as an idle shell. This returned `idle`
      // twice during a `brew install` — Homebrew's `brew` being a `#!/bin/bash`
      // script — while `poll`, which reads the exit marker, correctly said busy.
      // An agent that trusts the first answer acts on a half-finished install.
      //
      // With a handle the marker settles it outright. Without one the answer
      // can be `unknown` — a chatty command outruns the scan window — and that
      // is reported rather than rounded to idle, because rounding it is how
      // this bug looked fixed while a 93 KB build still answered `idle` with
      // half a minute to run. See `lastCommandEvidence`.
      const handle = typeof args.handle === 'string' && args.handle ? args.handle : undefined;
      // Keep the command's OWN result, not just whether it is over.
      //
      // `wait` answered "is it done?" and then returned the SESSION's last
      // exit code — a different question, and stale or absent for a command
      // nobody polled. An agent that waited on a 188-second job got
      // `verified: true` and nothing usable, then had to call `poll` to learn
      // the outcome of the thing it had just been told was finished. The end
      // marker carries the code and the shell's own duration; read them here.
      let outcome: CommandOutcome | undefined;
      const evidence = async (): Promise<'running' | 'finished' | 'unknown'> => {
        if (handle === undefined) return lastCommandEvidence(session).catch(() => 'unknown');
        outcome = await commandOutcome(session, handle).catch(() => undefined);
        return outcome?.finished ? 'finished' : 'running';
      };
      for (;;) {
        const s = await get(session).catch(() => undefined);
        if (!s) return json({ session, outcome: 'session_gone' });
        if (s.state === 'needs-input') {
          return json({
            session,
            outcome: 'needs_human',
            last_command: s.lastCommand,
            what_to_do:
              'This is parked at a prompt only a person can answer, so waiting will not clear ' +
              'it. A request has already been filed. Tell the user which session is waiting and ' +
              'what for, then stop — or use `await_human` to block until they answer.',
          });
        }
        // A dead pane runs nothing, whatever the markers say.
        if (s.paneDead) {
          return json({
            session,
            outcome: 'idle',
            verified: true,
            last_command: s.lastCommand,
            last_exit_code: s.lastExitCode,
          });
        }
        if (s.state === 'idle') {
          const seen = await evidence();
          if (seen !== 'running') {
            return json({
              session,
              outcome: 'idle',
              // From the handle's own marker when we have one, so the caller
              // does not need a second call to learn what it just waited for.
              ...(outcome?.exitCode === undefined ? {} : { exit_code: outcome.exitCode }),
              ...(outcome?.seconds === undefined ? {} : { took_seconds: outcome.seconds }),
              // Say WHICH of the two idles this is. `false` means the pane
              // looked idle and nothing could confirm it — the exact answer
              // that sent an agent off to act on a half-finished install.
              verified: seen === 'finished',
              last_command: s.lastCommand,
              // The SESSION's last recorded code — not necessarily the command
              // you waited on. `exit_code` above, when present, is that one.
              last_exit_code: s.lastExitCode,
              ...(seen === 'unknown'
                ? {
                    unverified_because:
                      'No exit marker for this session was in the scan window — a command that ' +
                      'prints a lot pushes its own marker out of it. This is the pane\'s answer, ' +
                      'not the command\'s. If you started this with `start`, call again passing ' +
                      'its `handle` for a definitive one.',
                  }
                : {}),
            });
          }
        }
        if (Date.now() >= deadline) {
          return json({
            session,
            outcome: 'still_running',
            last_command: s.lastCommand,
            // `state` is reported because it can legitimately read `idle` here:
            // a foreground shell script looks like a shell at a prompt, and the
            // exit marker is what kept this loop going. A caller comparing this
            // against `ls` would otherwise think one of them was lying.
            state: s.state,
            note:
              `Still running after ${limit}s. Call again, or poll with the handle from ` +
              `\`start\`.`,
          });
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    case 'width': {
      const session = String(args.session ?? '');
      const applied = await setWidth(session, Number(args.columns));
      const s = await get(session).catch(() => undefined);
      return json({
        session,
        pane_width: applied,
        note:
          'Re-asserted, not fixed: `window-size latest` means the next client to attach sets it ' +
          'again. Check `pane_width` in `list` if a later result looks cut differently.',
        ...(s?.remote ? { remote: s.remote } : {}),
      });
    }

    case 'purge': {
      const session = String(args.session ?? '');
      // Exposed over MCP after two agents reported the same thing: told to
      // leave nothing behind, they could not, because the one command that
      // erases the transcript existed only on the CLI. Withholding it was a
      // deliberate call — discarding a record is a human's decision — but an
      // agent that has been INSTRUCTED to clean up is carrying out the human's
      // decision, not substituting its own. It still cannot reach anyone
      // else's data: one named session, transcript only.
      const { bytes, survives } = await purgeLog(session);
      return json({
        session,
        bytes_discarded: bytes,
        cleared: 'the session transcript only',
        still_on_disk: survives.map((a) => ({ path: `~/.ath/${a.name}`, holds: a.holds })),
        note: 'Run the `doctor` tool for the complete list, including what nothing removes.',
      });
    }

    case 'doctor': {
      const rows = [];
      for (const a of ATH_ARTIFACTS) {
        rows.push({
          path: `~/.ath/${a.name}`,
          holds: a.holds,
          removed_by_purge: a.purged,
          bounded: a.bounded,
        });
      }
      return json({
        root: ATH_HOME,
        artifacts: rows,
        note: '`purge` clears only the entry marked removed_by_purge, and only for one session.',
      });
    }

    case 'unpin': {
      const session = String(args.session ?? '');
      await setPinned(session, false);
      return json({
        session,
        pinned: false,
        note: `"${session}" can now be killed. Re-pin from the CLI with \`ath pin ${session}\`.`,
      });
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
      // "Destroyed" is not the whole truth while the transcript is still there.
      // An agent told only that is entitled to report the session cleaned up,
      // and it has just left a file holding every byte the session printed.
      const kept = await logSize(session);
      const keptNote = kept
        ? ` The transcript remains at ${logPath(session)} (${kept}); a human can remove it with \`ath purge ${session}\`.`
        : '';
      return text(`Session "${session}" destroyed.${note ? ` ${note}` : ''}${keptNote}`);
    }

    default:
      return text(`Unknown tool: ${name}`, true);
  }
}

/**
 * The transcript's size, human-readable, or empty when there is none.
 *
 * Reported rather than merely mentioned: "a log exists" is easy to skim past,
 * "4.2 MB" is not, and an agent relaying this to its human should be able to
 * convey how much was recorded.
 */
/**
 * What the caller can use for concurrent work, right now.
 *
 * Returns names, not advice: "create another session" is guessable, whereas
 * "hk2 is idle" is a fact the caller cannot obtain without a second call it
 * has no reason to make. Failure is non-fatal — this is a convenience on a
 * successful dispatch, and must never turn one into an error.
 */
async function parallelHint(current: string): Promise<string> {
  try {
    // A session with an OPEN REQUEST is never offered, whatever its state says.
    //
    // Filtering on `state === 'idle'` alone was not enough. Classification
    // reads the pane, and the pane lags: a session that has just been sent
    // `sudo -v` still reads idle until the prompt renders. A cold agent was
    // told a session parked at a password prompt was "idle and usable right
    // now" and said, correctly, that acting on it would have meant typing into
    // the human's password field.
    //
    // An open request is durable state on disk, written the moment a command
    // parks, so it does not race the pane. (`run` and `start` both refuse a
    // live credential prompt anyway, so the worst case was a refusal rather
    // than a leaked keystroke — but a suggestion that has to be rescued by a
    // downstream guard should not be made.)
    const asked = new Set((await listRequests().catch(() => [])).map((r) => r.session));
    const free = (await list())
      .filter(
        (s) => s.name !== current && s.state === 'idle' && !s.paneDead && !asked.has(s.name),
      )
      .map((s) => s.name);
    if (free.length === 0) {
      return `No other session is free. To run something ALONGSIDE this, create one first (\`new\`) — reusing "${current}" will be refused until this finishes.`;
    }
    return (
      `Idle as of this call, for work alongside this: ${free.slice(0, 4).join(', ')}` +
      `${free.length > 4 ? `, +${free.length - 4} more` : ''}. ` +
      `A session can park on a prompt between now and your next call; that is refused, not typed into.`
    );
  } catch {
    return 'To run something alongside this, use a different session — this one is occupied until it finishes.';
  }
}

async function logSize(session: string): Promise<string> {
  try {
    const { size } = await fsp.stat(logPath(session));
    if (size <= 0) return '';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = size;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
  } catch {
    return '';
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
