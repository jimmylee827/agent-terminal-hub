#!/usr/bin/env node
//
// `what_to_do` must be serialized FIRST, because that is the documented order.
//
// The documentation tells an agent to read `what_to_do` before the numbers. The
// payload said the opposite: `exit_code` is the second key of every run result
// and `what_to_do` is assigned much later, so it lands near the bottom of a long
// object. A reviewer's first probe was a `sudo` refusal:
//
//   "exit_code": 0, … "what_to_do": "…needs a credential only you can type…"
//
// The 0 belonged to a trailing `echo`, exactly as `exit_code_covers` said. They
// followed the guidance, read `what_to_do` first as instructed, and still called
// the object "contradictory on its face" — "the ordering of those fields is
// doing a lot of work."
//
// Both facts are true and both stay. Only the order changes. Asserted over the
// REAL server on the reviewer's own case, because the fix lives in the shared
// serializer and a unit test on that function would not prove the run payload
// actually goes through it.
//
// TWO ASSERTIONS, because the live one alone was not enough — and proving that
// cost nothing but running it. Reverting `json()` and re-running this probe
// still PASSED: `run` serializes through `jsonWithOutput`, so the live case
// exercises exactly one of the two serializers, and a fix missing from the
// other would have shipped looking tested. The second assertion is mechanical
// and covers the call sites the live case cannot reach.
const { spawn } = require('node:child_process');
const { readFileSync, unlinkSync } = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'packages', 'mcp', 'dist', 'index.js');
const core = require(path.join(ROOT, 'packages', 'core', 'dist', 'index.js'));

const call = (id, name, args) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

// --selftest: the ordering rule must REJECT a payload that buries the guidance.
if (process.argv.includes('--selftest')) {
  const judge = (keys) => (keys.indexOf('what_to_do') === 0 ? 'ok' : 'buried');
  const catchesBuried = judge(['session', 'exit_code', 'what_to_do']) === 'buried';
  const passesLeading = judge(['what_to_do', 'session', 'exit_code']) === 'ok';
  const ok = catchesBuried && passesLeading;
  console.log(
    ok
      ? 'ordercheck --selftest: OK — guidance after the numbers is buried, guidance first is not'
      : `ordercheck --selftest: FAILED buried=${catchesBuried} leading=${passesLeading}`,
  );
  process.exit(ok ? 0 : 1);
}

(async () => {
  const n = `oc-${process.pid}`;
  const out = [];
  try {
    await core.kill(n).catch(() => {});
    await core.create({ name: n, cwd: '/tmp' });
    for (let i = 0; i < 20; i++) {
      const s = await core.get(n).catch(() => null);
      if (s && s.state === 'idle') break;
      await new Promise((r) => setTimeout(r, 400));
    }

    const p = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'ignore'] });
    let raw = '';
    p.stdout.on('data', (c) => (raw += c));
    p.stdin.write(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05",' +
        '"capabilities":{},"clientInfo":{"name":"v","version":"0"}}}\n',
    );
    p.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    // The reviewer's exact first probe: a refusal whose exit code belongs to the
    // trailing echo, not to the command that could not run.
    p.stdin.write(`${JSON.stringify(call(2, 'run', { session: n, command: 'sudo -n true; echo done' }))}\n`);
    await new Promise((r) => setTimeout(r, 9000));
    p.kill();

    let checked = 0;
    let buried = 0;
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const j = JSON.parse(line);
        for (const c of j.result?.content ?? []) {
          const t = c.text ?? '';
          if (!t.includes('what_to_do')) continue;
          const keys = Object.keys(JSON.parse(t.slice(t.indexOf('{'))));
          checked++;
          if (keys.indexOf('what_to_do') !== 0) buried++;
        }
      } catch {
        /* not every line is a response */
      }
    }
    // A run that produced no guidance at all would pass vacuously.
    out.push(checked > 0 ? 'sawGuidance' : 'NOGUIDANCE');
    out.push(buried === 0 ? 'guidanceFirst' : `BURIED${buried}`);

    // Every payload serializer must route through actionFirst. `json` and
    // `jsonWithOutput` are the two, and the live case above can only ever reach
    // the one that `run` happens to use.
    const src = readFileSync(path.join(ROOT, 'packages', 'mcp', 'src', 'index.ts'), 'utf8');
    const routed = [...src.matchAll(/JSON\.stringify\(actionFirst\(/g)].length;
    const bare = [...src.matchAll(/JSON\.stringify\(value, null, 2\)/g)].length;
    out.push(routed === 2 && bare === 0 ? 'bothSerializers' : `SERIALIZERS routed=${routed} bare=${bare}`);
  } catch (e) {
    out.push(`THREW:${String(e.message).slice(0, 40)}`);
  } finally {
    await core.kill(n).catch(() => {});
    // Remove this probe's own transcript.
    //
    // `kill` ends the session and LEAVES the log; only `purge --dead` unlinks,
    // and that would take a human's dead sessions with it. The suite's EXIT
    // trap sweeps names it did not start with, but these probes also run
    // standalone — and each standalone run was leaving a 300 KB transcript in
    // the user's ~/.ath/log. A reviewer counted exactly this class of litter
    // and called the directory unbounded; a test harness should not be adding
    // to the pile it is meant to police.
    for (const suffix of ['.log', '.trim']) {
      try {
        unlinkSync(core.logPath(n).replace(/\.log$/, suffix));
      } catch {
        /* never existed, which is the good case */
      }
    }
  }
  process.stdout.write(out.join(' '));
})();
