#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

import {
  assertNotCredentialPrompt,
  assertRemoteConnected,
  attachedClientsNote,
  AthError,
  SOCKET,
  TMUX_CONF,
  Watcher,
  agentPrompt,
  create,
  doctor,
  gc,
  get,
  kill,
  list,
  clearRequest,
  listAllRequests,
  formatDuration,
  latestHandle,
  listRequests,
  notePrompts,
  reapResolvedRequests,
  lockHolder,
  poll,
  purgeLog,
  reapStaleRc,
  readSince,
  readTail,
  rename,
  run,
  sendKeys,
  sendLine,
  setPinned,
  start,
  tmuxBin,
  tmuxName,
  effectiveCwd,} from '@ath/core';

import { flagBool, flagNumber, flagString, parseArgs } from './args';
import { invalidKeys } from './keys';

/**
 * Exit codes. A command that is merely waiting on a human must NOT look like
 * success, or `ath run … && next` proceeds as though the work was done.
 * 75/76 follow sysexits.h EX_TEMPFAIL: try again later.
 */
const EXIT_NEEDS_INPUT = 75;
const EXIT_STILL_RUNNING = 76;

/**
 * Exit quietly when whatever we are piped into goes away first.
 *
 * `ath ls | grep -q x` or `| head -1` closes the pipe as soon as it is
 * satisfied, and Node's default is to raise an unhandled EPIPE and print a
 * stack trace — which looks like ath crashed, and pollutes the output of
 * anything scripting around it. Every other Unix tool just stops.
 */
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
};

const STATE_GLYPH: Record<string, string> = {
  idle: '·',
  busy: '▶',
  'needs-input': '!',
  dead: 'x',
};

function paintState(state: string): string {
  const text = `${STATE_GLYPH[state] ?? '?'} ${state}`;
  if (state === 'needs-input') return c.yellow(text);
  if (state === 'busy') return c.green(text);
  if (state === 'dead') return c.red(text);
  return c.dim(text);
}

const HELP = `${c.bold('ath')} — long-lived terminals shared by agents and humans

${c.bold('Sessions')}
  ath new [name] [--cwd DIR] [--remote HOST] [--pin] [--label TEXT]
  ath ls [--json]
  ath kill <name> · ath rename <old> <new> · ath pin|unpin <name>
  ath gc [--max-idle-hours N]

${c.bold('Driving a session')}
  ath run <name> -- <command>      blocking; prints output, exits with its code
       [--timeout SEC] [--wait] [--json]
  ath start <name> -- <command>    non-blocking; prints a handle for polling
  ath poll <name> --handle H [--since N]
  ath send <name> -- <keys>        tmux key names (C-c, Up, y, Enter)
  ath requests [--clear]           what the hub needs a human for
  ath await <name> [--handle H]    BLOCK until the human answers (for callbacks)
       [--text]                    send literal text plus Enter instead
  ath read <name> [--tail N] [--since N] [--json]
  ath wait <name> [--timeout SEC]

${c.bold('Humans')}
  ath attach <name>                enter the terminal the agent is using
  ath prompt <name>                copyable handoff text for an agent
  ath purge <name> | --all         wipe a session's recorded output
  ath watch [--json]               stream state changes
  ath doctor

${c.bold('Exit codes for run')}
  0    the command succeeded          ${c.dim('(or its own non-zero code)')}
  ${EXIT_NEEDS_INPUT}   waiting for a human           ${c.dim('attach and answer it')}
  ${EXIT_STILL_RUNNING}   still running at timeout      ${c.dim('output so far was printed')}

${c.dim('A session outlives the agent and the editor. When a command needs a')}
${c.dim('password, attach and type it yourself — the agent never does.')}
`;

async function main(): Promise<number> {
  const { command, positional, flags, rest } = parseArgs(process.argv.slice(2));

  switch (command) {
    case 'new':
    case 'create': {
      const session = await create({
        name: positional[0],
        cwd: flagString(flags, 'cwd') ?? process.cwd(),
        remote: flagString(flags, 'remote'),
        label: flagString(flags, 'label'),
        pin: flagBool(flags, 'pin'),
        // `owner` said "human" for every session, including ones an agent
        // created — the field exists to say who a terminal belongs to, and
        // answering the same thing regardless made it useless. ATH_INSIDE is
        // set in the panes this tool creates, so an agent driving the CLI from
        // inside one is distinguishable from a person typing at a prompt.
        owner:
          flagString(flags, 'owner') ??
          (process.env.ATH_INSIDE || !process.stdin.isTTY ? 'agent' : 'human'),
      });
      if (flagBool(flags, 'json')) {
        console.log(JSON.stringify(session, null, 2));
      } else {
          // Show the REMOTE host for a remote session. Printing the local cwd
          // for `ath new box --remote myserver` reads as though --remote had
          // been ignored, which is the first thing anyone checks when a remote
          // session misbehaves.
          const where = session.remote
            ? `${session.remote}:${session.remoteCwd ?? '~'}`
            : session.cwd;
          console.log(`${c.green('created')} ${c.bold(session.name)}  ${c.dim(where)}`);
        console.log(c.dim(`attach with:  ath attach ${session.name}`));
      }
      return 0;
    }

    case 'ls':
    case 'list': {
      const sessions = await list();
      if (flagBool(flags, 'json')) {
        // `paneTail` is the whole visible pane, wrapped to the pane width. It
        // is carried on the session so the watcher can classify state without a
        // second capture — it was never meant for a caller asking "is this
        // busy?". Returned here it re-emitted the last command's entire output,
        // words split mid-token, several KB for a two-line state check. An
        // agent pays for that in context every time it looks.
        //
        // `--full` keeps it for the rare caller that wants the raw pane.
        const full = flagBool(flags, 'full');
        console.log(
          JSON.stringify(
            full ? sessions : sessions.map(({ paneTail: _drop, ...rest }) => rest),
            null,
            2,
          ),
        );
        return 0;
      }
      if (sessions.length === 0) {
        console.log(c.dim('no sessions. create one with:  ath new'));
        return 0;
      }
      // Reap first: a resolved request left the session flagged `asked-for-you`
      // while it sat idle and finished, so the listing told a human they still
      // owed an answer they had already given.
      await notePrompts().catch(() => undefined);
      await reapResolvedRequests().catch(() => undefined);
      const requested = new Set((await listRequests()).map((r) => r.session));
      const width = Math.max(...sessions.map((s) => s.name.length), 4);
      for (const s of sessions) {
        const marks: string[] = [];
        if (requested.has(s.name)) marks.push(c.yellow('asked-for-you'));
        if (s.pinned) marks.push(c.cyan('pin'));
        if (s.attached > 0) marks.push(c.cyan(`+${s.attached}`));
        const holder = await lockHolder(s.name);
        if (holder) marks.push(c.dim(`locked:${holder.command.slice(0, 24)}`));
        const cmd = s.currentCommand ? ` ${c.dim(s.currentCommand)}` : '';
        console.log(
          `${c.bold(s.name.padEnd(width))}  ${paintState(s.state).padEnd(useColor ? 26 : 14)}` +
            `${c.dim(s.remote ? `${s.remote}:${shortenPath(effectiveCwd(s))}` : shortenPath(s.cwd))}${cmd}${marks.length ? ` ${marks.join(' ')}` : ''}`,
        );
      }
      return 0;
    }

    case 'run': {
      const name = requireName(positional[0]);
      const cmd = rest || positional.slice(1).join(' ');
      if (!cmd) return fail('nothing to run. usage: ath run <name> -- <command>');

      const result = await run(name, cmd, {
        timeoutMs: flagNumber(flags, 'timeout', 120) * 1000,
        waitForIdle: flagBool(flags, 'wait'),
      });

      if (flagBool(flags, 'json')) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.output) {
        console.log(result.output);
      }

      // A reconnect silently resets the remote shell's environment. Say so:
      // `cwd` is restored from the end marker, but exported variables lived in
      // the process the dropped link took with it, and cannot be recovered.
      // Left unsaid, the next command reads an empty $VAR and looks merely wrong.
      if (result.reconnecting) {
        console.error(
          c.yellow(
            `\n[ath] "${name}" reconnected after the link dropped.\n` +
              `      Working directory and exported variables were restored —` +
              ` including ones you\n      typed by hand. Not recoverable:` +
              ` background jobs and shell functions, which\n      lived only in the` +
              ` process the dropped link took with it.`,
          ),
        );
      }

      // The human usually cannot see this: a nested bash keeps the same prompt,
      // so the only visible change is that our command lines start looking
      // different. Say what happened and how to get back.
      // Loud, and raised by the system rather than by the agent choosing to.
      if (result.needsHuman) {
        // Only claim a request exists when one does. A non-interactive refusal
        // files nothing — the command has already exited and there is nothing
        // for a human to answer — so pointing at `ath requests` would send the
        // reader to an empty queue.
        const filed = result.needsInput === true;
        console.error(
          c.yellow(
            `\n[ath] ${filed ? 'THIS NEEDS YOU.' : 'NEEDS ELEVATION.'} ${result.needsHuman}` +
              (filed ? `\n      A request has been filed — see "ath requests".` : ''),
          ),
        );
      }

      if (result.fallbackShell) {
        console.error(
          c.yellow(
            `\n[ath] "${name}" is inside a shell this session did not start` +
              ` (a nested shell, docker exec, sudo -i).\n` +
              `      Commands still run and exit codes are still exact, but they` +
              ` appear as "__ath …" lines\n      instead of plain ones. Type "exit"` +
              ` in the terminal to come back up a level.`,
          ),
        );
      }

      if (result.needsInput) {
        console.error(
          c.yellow(
            `\n[ath] "${name}" is waiting for input. Attach and answer it:\n` +
              `      ath attach ${name}` +
              (result.handle ? `\n      then: ath poll ${name} --handle ${result.handle}` : ''),
          ),
        );
        return EXIT_NEEDS_INPUT;
      }
      if (result.timedOut) {
        console.error(
          c.yellow(
            `\n[ath] still running after timeout; the output above is partial.` +
              (result.handle ? `\n      ath poll ${name} --handle ${result.handle}` : ''),
          ),
        );
        return EXIT_STILL_RUNNING;
      }
      return result.exitCode ?? 1;
    }

    case 'start': {
      const name = requireName(positional[0]);
      const cmd = rest || positional.slice(1).join(' ');
      if (!cmd) return fail('nothing to start. usage: ath start <name> -- <command>');
      const started = await start(name, cmd);
      if (flagBool(flags, 'json')) {
        console.log(JSON.stringify(started, null, 2));
      } else {
        console.log(`${c.green('started')} ${c.bold(name)}  handle ${started.handle}`);
        console.log(c.dim(`poll with:  ath poll ${name} --handle ${started.handle} --since ${started.offset}`));
      }
      return 0;
    }

    case 'poll': {
      const name = requireName(positional[0]);
      const handle = flagString(flags, 'handle');
      if (!handle) return fail('a --handle is required. get one from: ath start');
      const result = await poll(name, handle, flagNumber(flags, 'since', 0));
      if (flagBool(flags, 'json')) {
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }
      if (result.output) console.log(result.output);
      if (!result.done) {
        console.error(c.dim(`\n[ath] still running · resume with --since ${result.nextOffset}`));
        return EXIT_STILL_RUNNING;
      }
      return result.exitCode ?? 0;
    }

    case 'send': {
      const name = requireName(positional[0]);
      const payload = rest || positional.slice(1).join(' ');
      if (!payload) return fail('nothing to send. usage: ath send <name> -- C-c');

      // Never type into the local shell what was meant for another machine.
      await assertRemoteConnected(name);

      if (flagBool(flags, 'text')) {
        // Never put arbitrary text into a password field: it becomes a failed
        // login attempt, and enough of those lock the account.
        await assertNotCredentialPrompt(name);
        await sendLine(name, payload);
        return 0;
      }

      const tokens = payload.split(/\s+/).filter(Boolean);
      const bad = invalidKeys(tokens);
      if (bad.length > 0) {
        return fail(
          `not valid tmux key names: ${bad.join(', ')}\n` +
            `send expects key names like C-c, Enter, Up, y.\n` +
            `To type literal text, use:  ath send ${name} --text -- ${payload}`,
        );
      }
      await sendKeys(name, tokens);
      return 0;
    }

    case 'read': {
      const name = requireName(positional[0]);
      if (flags.since !== undefined) {
        const result = await readSince(name, flagNumber(flags, 'since', 0));
        if (flagBool(flags, 'json')) console.log(JSON.stringify(result, null, 2));
        else {
          if (result.output) console.log(result.output);
          console.error(c.dim(`\n[ath] resume with --since ${result.nextOffset}`));
        }
        return 0;
      }
      const text = await readTail(name, flagNumber(flags, 'tail', 200));
      if (flagBool(flags, 'json')) {
        console.log(JSON.stringify({ ...(await get(name)), output: text }, null, 2));
      } else {
        console.log(text);
      }
      return 0;
    }

    case 'wait': {
      const name = requireName(positional[0]);
      const deadline = Date.now() + flagNumber(flags, 'timeout', 300) * 1000;
      for (;;) {
        const session = await get(name);
        if (session.state === 'idle' || session.state === 'dead') {
          console.log(session.state);
          return 0;
        }
        if (session.state === 'needs-input') {
          console.error(c.yellow(`[ath] "${name}" needs input — attach: ath attach ${name}`));
          return EXIT_NEEDS_INPUT;
        }
        if (Date.now() >= deadline) {
          console.error(c.yellow(`[ath] timed out waiting for "${name}"`));
          return EXIT_STILL_RUNNING;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    case 'attach': {
      const name = requireName(positional[0]);
      await get(name); // fail fast with a clear message if it is gone
      // Hand our real TTY to tmux: the moment a human joins the PTY the agent
      // is already driving.
      const res = spawnSync(
        tmuxBin(),
        ['-L', SOCKET, '-f', TMUX_CONF, 'attach-session', '-t', tmuxName(name)],
        { stdio: 'inherit' },
      );
      return res.status ?? 0;
    }

    case 'prompt': {
      const name = requireName(positional[0]);
      console.log(agentPrompt(await get(name)));
      return 0;
    }

    case 'purge': {
      if (flagBool(flags, 'all')) {
        const all = await list({ withState: false });
        for (const s of all) await purgeLog(s.name);
        console.log(`purged ${all.length} log(s)`);
        return 0;
      }
      const name = requireName(positional[0]);
      await purgeLog(name);
      console.log(`purged recorded output for ${name}`);
      return 0;
    }

    case 'pin':
    case 'unpin': {
      const name = requireName(positional[0]);
      await setPinned(name, command === 'pin');
      console.log(`${name} ${command === 'pin' ? 'pinned' : 'unpinned'}`);
      return 0;
    }

    case 'rename': {
      const from = requireName(positional[0]);
      const to = requireName(positional[1]);
      await rename(from, to);
      console.log(`${from} -> ${to}`);
      return 0;
    }

    case 'kill': {
      const name = requireName(positional[0]);
      // Look BEFORE destroying it: once the session is gone the client count
      // is gone with it, and "destroyed." on its own told a caller nothing
      // about the person who was attached at the time.
      const attached = await get(name)
        .then((s) => s.attached)
        .catch(() => 0);
      await kill(name, 'killed from the hub', { force: flagBool(flags, 'force') });
      const note = attachedClientsNote(attached);
      console.log(`${name} killed`);
      if (note) console.error(c.yellow(`[ath] ${note}`));
      return 0;
    }

    case 'gc': {
      const killed = await gc(flagNumber(flags, 'max-idle-hours', 12) * 3600 * 1000);
      const stale = await reapStaleRc();
      console.log(killed.length ? `reaped: ${killed.join(', ')}` : c.dim('nothing to reap'));
      if (stale) console.log(c.dim(`removed ${stale} stale rc sentinel(s)`));
      return 0;
    }

    case 'watch': {
      const json = flagBool(flags, 'json');
      const watcher = new Watcher();
      watcher.on('change', (change) => {
        if (json) console.log(JSON.stringify({ type: 'change', ...change }));
        else console.log(`${change.name}: ${change.previous} -> ${change.current}`);
      });
      watcher.on('error', (err: Error) => console.error(c.red(`[ath] ${err.message}`)));
      watcher.start();
      await new Promise(() => undefined); // run until killed
      return 0;
    }

    case 'await': {
      // BLOCK until the human's answer lands, so a caller can be PUSHED to
      // rather than having to poll.
      //
      // Every signal before this was pull-only: `ath requests` reported the
      // answer correctly and instantly, and an agent still had to think to look
      // — so it repeated "still waiting for you" at someone who had answered an
      // hour earlier. A command that simply does not return until the outcome
      // exists turns any harness's "notify me when this exits" into a real
      // callback, with no polling in the agent's own turn and nothing for it to
      // remember.
      const name = requireName(positional[0]);
      const deadline = Date.now() + flagNumber(flags, 'timeout', 1800) * 1000;
      let handle = flagString(flags, 'handle');
      if (!handle) {
        const open = (await listRequests()).filter((r) => r.session === name && r.handle);
        handle = open[open.length - 1]?.handle;
      }
      // Still nothing? Ask the LOG which command is in flight — but ONLY once
      // it is established that something is actually pending.
      //
      // `ath start` files no request, so a backgrounded command stopped at a
      // password prompt leaves no handle anywhere, and without one this command
      // cannot prove an outcome. The log can supply it: every framed command
      // writes a start marker.
      //
      // The order matters, and the first version got it wrong. Recovering the
      // handle unconditionally made `ath await` on an IDLE session poll
      // whatever ran last and report "answered — exit 0" — an answer to a
      // question nobody asked. That is a false POSITIVE, which is worse than
      // the false negative being fixed here: it sends an agent off to collect a
      // result that does not exist. So establish that something is pending
      // first, and only then adopt the in-flight command.
      if (!handle) {
        const s = await get(name).catch(() => undefined);
        if (!s) {
          console.error(c.red(`[ath] "${name}" is gone — any answer was lost.`));
          return 1;
        }
        const pending = s.state === 'needs-input' || s.state === 'busy';
        const anyRequest = (await listRequests()).some((r) => r.session === name);
        if (!pending && !anyRequest) {
          console.error(
            c.yellow(
              `[ath] nothing in "${name}" is waiting on a human, and no request is open — ` +
                `there is nothing to await. If you started the command with "ath start", ` +
                `pass its handle: ath await ${name} --handle <handle>.`,
            ),
          );
          return 2;
        }
        handle = await latestHandle(name).catch(() => undefined);
      }
      // A missing request must not end the wait.
      //
      // The request can be cleared by something else — an editor notification,
      // a human tidying up — while the human is still standing at the prompt.
      // Exiting then defeats the whole point: the callback dies before the
      // answer arrives. With no handle we fall back to watching the SESSION,
      // which is the thing actually holding the person.
      if (!handle) {
        // NOTHING HERE CAN POLL, so nothing here may claim an outcome.
        //
        // This branch used to end in `handle ? await poll(...) : undefined`,
        // inside a block entered only when `handle` is falsy and never
        // reassigning it. The ternary could only ever yield undefined, so the
        // "answered" arm was unreachable and EVERY answer on this path was
        // reported as "the connection dropped ... Nothing was answered". A cold
        // agent hit it, was told its successful sudo had failed, and only got
        // the right answer because it distrusted this command and checked with
        // `sudo -n id` itself.
        //
        // The path is reached constantly, because `ath start` files no request
        // at all — so a credential prompt met by a backgrounded command has no
        // handle to find here.
        //
        // A false negative is not the safe direction. It tells an agent the
        // human never answered, whose correct response is to ask them again —
        // the exact loop that made someone type a password three times.
        const before = await get(name).catch(() => undefined);
        const baseline = { cmd: before?.lastCommand, rc: before?.lastExitCode };
        const anyRequest = (await listRequests()).some((r) => r.session === name);
        if (!anyRequest && before && before.state !== 'needs-input' && before.state !== 'busy') {
          console.error(
            c.yellow(
              `[ath] nothing in "${name}" is waiting on a human, and no request is open. ` +
                `If you started the command with "ath start", pass its handle: ` +
                `ath await ${name} --handle <handle>.`,
            ),
          );
          return 2;
        }
        for (;;) {
          const s = await get(name).catch(() => undefined);
          if (s === undefined) {
            console.error(c.red(`[ath] "${name}" is gone — any answer was lost.`));
            return 1;
          }
          if (s.state !== 'needs-input' && s.state !== 'busy') {
            // Leaving the wall is not proof of an answer: it also happens on a
            // dropped link, a Ctrl-C, or a dead shell. The one piece of
            // evidence available without a handle is the session's own last
            // completion — if a command finished while we watched, something
            // was answered, and its exit code is the honest thing to report.
            const completed =
              s.lastExitCode !== undefined &&
              (s.lastCommand !== baseline.cmd || s.lastExitCode !== baseline.rc);
            if (completed) {
              const code = s.lastExitCode as number;
              console.error(
                code === 130 || code === 143
                  ? c.red(`[ath] "${name}" was interrupted (exit ${code}) — NOT answered.`)
                  : c.green(`[ath] "${name}" answered — exit ${code}.`),
              );
              return code;
            }
            // No handle and no completion: say that, rather than inventing a
            // cause. "I cannot tell" sends an agent to look; "nothing was
            // answered" sends it to ask a human who already answered.
            console.error(
              c.yellow(
                `[ath] "${name}" is no longer waiting, but nothing completed while ath ` +
                  `watched, and this request carries no handle — so whether it was ` +
                  `answered CANNOT be determined from here. Check with "ath read ${name}" ` +
                  `before assuming either way.`,
              ),
            );
            return 3;
          }
          if (Date.now() >= deadline) {
            console.error(c.yellow(`[ath] gave up waiting on "${name}" after the timeout.`));
            return 76;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      for (;;) {
        // A vanished session must END the wait, not be polled forever.
        //
        // The handle path swallowed every error, so when the tmux server died
        // the callback kept looping against nothing until its timeout — the
        // human's answer was already unrecoverable and the watcher still
        // reported "waiting". Silence is the wrong output for "it is gone".
        const stillThere = await get(name)
          .then(() => true)
          .catch(() => false);
        if (!stillThere) {
          console.error(
            c.red(`[ath] "${name}" no longer exists — the session died and any answer with it.`),
          );
          return 1;
        }
        const res = await poll(name, handle).catch(() => undefined);
        // The same "stopped waiting without completing" check the no-handle
        // branch has. Its absence here meant a dropped link left this polling
        // in silence until the timeout — the answer was already unreachable
        // and the watcher still said nothing, which is the failure this whole
        // command exists to remove.
        if (!res?.done && res?.state !== 'needs-input' && res?.state !== 'busy') {
          console.error(
            c.red(
              `[ath] "${name}" stopped waiting WITHOUT completing — the connection ` +
                `dropped, the prompt was interrupted, or the shell exited. Nothing was ` +
                `answered; re-run the command.`,
            ),
          );
          return 1;
        }
        if (res?.done) {
          if (res.output) console.log(res.output);
          const code = res.exitCode ?? 0;
          console.error(
            code === 130 || code === 143
              ? c.red(`[ath] "${name}" was interrupted (exit ${code}) — NOT answered.`)
              : c.green(`[ath] "${name}" answered — exit ${code}.`),
          );
          return code;
        }
        if (Date.now() >= deadline) {
          console.error(c.yellow(`[ath] gave up waiting on "${name}" after the timeout.`));
          return 76;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    case 'requests': {
      await reapResolvedRequests().catch(() => undefined);
      // Somewhere to actually READ what the hub asked you for. A request that
      // is filed but has no surface is not an ask, it is a dropped message.
      const open = await listAllRequests();
      if (flagBool(flags, 'clear')) {
        for (const r of open) await clearRequest(r.id);
        console.log(`cleared ${open.length} request(s)`);
        return 0;
      }
      if (open.length === 0) {
        console.log('no requests — none has been filed for any session');
        return 0;
      }
      for (const r of open) {
        const age = formatDuration((Date.now() - r.createdAt) / 1000);
        // Say whether the HUMAN HAS ALREADY ANSWERED. A request that only ever
        // says "waiting" lets an agent repeat "still waiting for you" forever
        // at someone who answered an hour ago — and that is exactly what
        // happened. The session leaving `needs-input` is the answer signal.
        const state = await get(r.session)
          .then((s) => s.state)
          .catch(() => undefined);
        // "Answered" means the blocked command actually FINISHED — not merely
        // that the session stopped waiting.
        //
        // Leaving `needs-input` also happens when the prompt is cancelled with
        // Ctrl-C, or times out, or the human gives up. Treating those as an
        // answer tells the agent to go collect a result that does not exist —
        // the mirror image of the false negative this whole signal exists to
        // prevent. The command's own end marker is the only honest proof.
        // Report the OUTCOME, do not infer intent.
        //
        // Ctrl-C at a prompt still produces an end marker — the command really
        // did finish, with 130. So "it finished" cannot mean "they answered".
        // Rather than guess, show the exit code and name the signal codes for
        // what they are, and let the reader decide.
        const res =
          r.handle !== undefined
            ? await poll(r.session, r.handle).catch(() => undefined)
            : undefined;
        const finished = res?.done === true;
        const code = res?.exitCode ?? null;
        const interrupted = code === 130 || code === 143;
        const answered = finished && !interrupted;
        const abandoned =
          r.parked === true && !finished && state !== undefined && state !== 'needs-input';
        const tag = state === undefined
          ? c.red('SESSION GONE — the answer was lost')
          : answered
            ? c.green(`ANSWERED — exit ${code}`)
            : finished && interrupted
              ? c.red(`NOT answered — interrupted (exit ${code})`)
              : abandoned
                ? c.red('NOT answered — the prompt was cancelled or timed out')
              : r.parked
                ? c.yellow('waiting for a human')
                : c.yellow('blocked — needs you, session not held');
        console.log(`${c.yellow(r.id)}  ${c.bold(r.session)}  ${age} ago  ${tag}`);
        console.log(`      ${r.reason}`);
        if (answered && r.handle) {
          console.log(`      collect it: ath poll ${r.session} --handle ${r.handle}`);
        }
      }
      return 0;
    }

    case 'doctor': {
      const { ok, checks } = await doctor();
      for (const [label, pass, detail] of checks) {
        console.log(`${pass ? c.green('ok  ') : c.red('FAIL')}  ${label.padEnd(24)} ${c.dim(detail)}`);
      }
      console.log(ok ? c.green('\nall good') : c.red('\nsome checks failed'));
      return ok ? 0 : 1;
    }

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;

    case 'version':
    case '--version':
      console.log('0.1.0');
      return 0;

    default:
      console.error(`unknown command: ${command}\n`);
      console.log(HELP);
      return 2;
  }
}

function requireName(value: string | undefined): string {
  if (!value) {
    console.error('a session name is required');
    process.exit(2);
  }
  return value;
}

function fail(message: string): number {
  console.error(message);
  return 2;
}

function shortenPath(p: string): string {
  const home = process.env.HOME;
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    if (err instanceof AthError) {
      console.error(c.red(`[${err.code}] ${err.message}`));
      process.exit(1);
    }
    console.error(c.red(String(err instanceof Error ? err.message : err)));
    process.exit(1);
  });
