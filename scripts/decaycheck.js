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
  } catch (e) {
    out.push(`THREW:${String(e.message).slice(0, 50)}`);
  } finally {
    for (const n of names) await core.kill(n).catch(() => {});
  }
  process.stdout.write(out.join(' '));
})();
