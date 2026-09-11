#!/usr/bin/env node
//
// A handle that will never complete must not be reported as running.
//
// Two shapes, both of which left `poll` counting upwards forever:
//
//   never-framed — the wrapper did not run at all (a shell with no helper).
//     This is `launched: false` seen from the other end. A reviewer hit it,
//     and said `poll` "cheerfully reported 116 B produced in 10s (12 B/s) with
//     running_for_seconds climbing". The documented way to spot it — "poll
//     never advances" — fails precisely here, because the ERROR TEXT is
//     output: the offset moves once and stops, which looks like a quiet job.
//     They only escaped because `start` had flagged it.
//
//   killed — the command began and its shell went away before framing an exit.
//     Rarer, because an ordinary Ctrl-C is caught by the wrapper and reported
//     honestly as exit 130; this is the case where even that does not happen.
//
// The negative matters as much: a job that is genuinely running, and one that
// finished normally, must never carry the flag.
const path = require('node:path');
const core = require(path.join(__dirname, '..', 'packages', 'core', 'dist', 'index.js'));

const settle = async (n) => {
  for (let i = 0; i < 15; i++) {
    const s = await core.get(n).catch(() => null);
    if (s && s.state === 'idle') return;
    await new Promise((r) => setTimeout(r, 600));
  }
};

(async () => {
  const out = [];
  const names = [];
  try {
    // --- never-framed: a real unhooked shell, not a stub --------------------
    {
      const n = `dh-nf-${process.pid}`;
      names.push(n);
      await core.create({ name: n, cwd: '/tmp' });
      await settle(n);
      await core.run(n, 'echo ok');
      await core.sendLine(n, 'exec env -i PATH=/usr/bin:/bin bash --norc --noprofile');
      await new Promise((r) => setTimeout(r, 2500));
      const st = await core.start(n, 'sleep 30');
      out.push(st.launched === false ? 'startFlagged' : 'STARTNOTFLAGGED');
      // Past the 3s grace window the detector allows.
      await new Promise((r) => setTimeout(r, 4000));
      const p = await core.poll(n, st.handle, st.offset);
      out.push(p.commandGone === true ? 'deadHandleSeen' : 'DEADHANDLEMISSED');
      out.push(p.done === true ? 'deadHandleDone' : 'DEADHANDLESTILLRUNNING');
      out.push(/NEVER OPENED ITS FRAME/.test(p.commandGoneNote || '') ? 'neverFramedNamed' : 'WRONGREASON');
    }

    // --- a healthy job must not be flagged, running or finished -------------
    {
      const n = `dh-ok-${process.pid}`;
      names.push(n);
      await core.create({ name: n, cwd: '/tmp' });
      await settle(n);
      await core.run(n, 'echo ok');
      const st = await core.start(n, 'sleep 8');
      await new Promise((r) => setTimeout(r, 4500));
      const mid = await core.poll(n, st.handle, st.offset);
      out.push(mid.commandGone ? 'RUNNINGFLAGGED' : 'runningNotFlagged');
      await new Promise((r) => setTimeout(r, 5500));
      const end = await core.poll(n, st.handle, st.offset);
      out.push(end.commandGone ? 'FINISHEDFLAGGED' : 'finishedNotFlagged');
      out.push(end.done && end.exitCode === 0 ? 'finishedReportsZero' : 'FINISHEDWRONG');
    }
  } catch (e) {
    out.push(`THREW:${String(e.message).slice(0, 50)}`);
  } finally {
    for (const n of names) await core.kill(n).catch(() => {});
  }
  process.stdout.write(out.join(' '));
})();
