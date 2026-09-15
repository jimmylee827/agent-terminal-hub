#!/usr/bin/env node
//
// The exit-code caveat must decay, and the blind-spot advice must know where in
// a command's life it arrived.
//
// Both come from one reviewer's session:
//
//   "by the eighth repetition I was skimming it" — the one-line caveat rode
//   nearly every command, because exploration is full of `;`. Skimming is the
//   failure the doc itself warns about for over-broad warnings, so the prose
//   decays to the bare token while the token stays on every affected command.
//
//   "nothing about what to do now that the command is already running. There is
//   no indication of whether it is a pre-launch or post-launch warning." The
//   stderr-discard warning is the most valuable thing this tool does and it
//   stopped at how you should have written the command.
//
// The negatives matter as much: a simple command must carry nothing at all, and
// must not consume the decay budget.
const path = require('node:path');
const core = require(path.join(__dirname, '..', 'packages', 'core', 'dist', 'index.js'));

const settle = async (n) => {
  for (let i = 0; i < 15; i++) {
    const s = await core.get(n).catch(() => null);
    if (s && s.state === 'idle') return;
    await new Promise((r) => setTimeout(r, 600));
  }
};

const form = (r) =>
  r.exitCodeCaveat ? 'full' : r.exitCodeShortNote ? 'line' : r.exitCodeCovers ? 'token' : 'none';

(async () => {
  const out = [];
  const names = [];
  try {
    {
      const n = `dc-${process.pid}`;
      names.push(n);
      await core.create({ name: n, cwd: '/tmp' });
      await settle(n);
      // A simple command first: it must carry nothing AND not spend the budget.
      const plain = await core.run(n, 'echo plain');
      out.push(form(plain) === 'none' ? 'simpleCarriesNothing' : 'SIMPLECARRIES');
      const seen = [];
      for (let i = 0; i < 5; i++) seen.push(form(await core.run(n, 'echo a; echo b')));
      out.push(seen[0] === 'full' ? 'firstIsFull' : `FIRSTWAS${seen[0]}`);
      out.push(seen[1] === 'line' && seen[2] === 'line' ? 'thenTwoLines' : 'WRONGMIDDLE');
      out.push(seen[3] === 'token' && seen[4] === 'token' ? 'thenTokenOnly' : 'WRONGTAIL');
    }

    // Lifecycle: the SAME command through `run` and through `start` must give
    // different next steps, and both must actually say which phase they are in.
    {
      const n = `dc-run-${process.pid}`;
      names.push(n);
      await core.create({ name: n, cwd: '/tmp' });
      await settle(n);
      const r = await core.run(n, 'find /System/Library/Fonts -type f 2>/dev/null | wc -l');
      out.push(/ALREADY FINISHED/.test(r.warning || '') ? 'runSaysFinished' : 'RUNPHASEMISSING');
      out.push(/ALREADY RUNNING/.test(r.warning || '') ? 'RUNSAYSRUNNING' : 'runNotConfused');
    }
    {
      const n = `dc-start-${process.pid}`;
      names.push(n);
      await core.create({ name: n, cwd: '/tmp' });
      await settle(n);
      await core.run(n, 'echo ok');
      const st = await core.start(n, 'find /System/Library/Fonts -type f 2>/dev/null | wc -l');
      out.push(/ALREADY RUNNING/.test(st.warning || '') ? 'startSaysRunning' : 'STARTPHASEMISSING');
      out.push(/kill it and re-issue/.test(st.warning || '') ? 'startOffersKill' : 'STARTNOKILL');
    }
    {
      // ONCE PER AGENT, not once per session.
      //
      // The decay was keyed on the session name, so a reviewer running the
      // four-session layout this tool recommends was handed the same ~90-word
      // paragraph four times: "correct content, but I'd read it on the first
      // one." A second reviewer the same round: "by the tenth time it was noise
      // I was skipping, which is how a warning gets missed on the occasion it
      // matters." The paragraph explains how SHELLS treat `;` — a property of
      // the reader, not of the session.
      // BOTH identities derived from this pid, so each run is a fresh pair.
      //
      // The "other agent" was a pair of fixed pids, so its hash was the same on
      // every run and rc/ still held its spent budget: this assertion passed
      // once and reported OTHERAGENTSILENCED on every run after. Caught by
      // running the probe three times in a row rather than once — a real agent
      // run has new pids, and the fixture has to as well.
      const mine = [process.pid, process.pid + 1, 999001, 999002];
      const other = [process.pid + 5000, process.pid + 5001, 999001, 999002];
      const a1 = `dc-a1-${process.pid}`;
      const a2 = `dc-a2-${process.pid}`;
      const b1 = `dc-b1-${process.pid}`;
      names.push(a1, a2, b1);
      for (const [n, pids] of [[a1, mine], [a2, mine], [b1, other]]) {
        await core.create({ name: n, cwd: '/tmp', creatorPids: pids });
        await settle(n);
      }
      // Retry on session_busy rather than treating it as a failure.
      //
      // `settle` waits for state 'idle', and classification reads the PANE,
      // which lags — so a session whose init `clear` has not finished rendering
      // reads idle and then refuses the next command. This threw on one run in
      // three: "Session dc-a2 is already running clear". The lag is real
      // product behaviour the docs describe; a fixture that treats it as a
      // failure is testing the timing of its own setup.
      const runWhenFree = async (name, cmd) => {
        for (let i = 0; i < 10; i++) {
          try {
            return await core.run(name, cmd);
          } catch (e) {
            if (!/already running/.test(String(e.message))) throw e;
            await new Promise((r) => setTimeout(r, 600));
          }
        }
        throw new Error(`${name} never went free`);
      };
      const r1 = await runWhenFree(a1, 'echo a; echo b');
      const r2 = await runWhenFree(a2, 'echo a; echo b');
      const r3 = await runWhenFree(b1, 'echo a; echo b');
      out.push(r1.exitCodeCaveat ? 'agentGetsParagraph' : 'AGENTNOPARAGRAPH');
      // The second session of the SAME agent must not repeat it...
      out.push(!r2.exitCodeCaveat ? 'secondSessionQuiet' : 'PARAGRAPHREPEATED');
      // ...but a DIFFERENT agent must still be told. Silencing a cold agent is
      // the expensive direction of this fix, so it is asserted explicitly.
      out.push(r3.exitCodeCaveat ? 'otherAgentStillTold' : 'OTHERAGENTSILENCED');
      // The machine-readable fact rides every affected command regardless.
      out.push(
        r1.exitCodeCovers && r2.exitCodeCovers && r3.exitCodeCovers
          ? 'markerEveryCommand'
          : 'MARKERMISSING',
      );
    }
  } catch (e) {
    out.push(`THREW:${String(e.message).slice(0, 50)}`);
  } finally {
    for (const n of names) await core.kill(n).catch(() => {});
    const { unlinkSync } = require('node:fs');
    for (const n of names) {
      for (const suffix of ['.log', '.trim']) {
        try {
          unlinkSync(core.logPath(n).replace(/\.log$/, suffix));
        } catch {
          /* never existed, which is the good case */
        }
      }
    }
  }
  process.stdout.write(out.join(' '));
})();
