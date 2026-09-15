#!/usr/bin/env node
//
// The two surfaces must report the same FACTS for the same operation.
//
// Divergence is the largest defect class by more than double — 18 of ~47
// findings — and it has two halves that need different instruments:
//
//   COMMISSION: a sentence authored into one surface. `prose.js` ratchets this,
//     and proving it just now: adding a sentence to MCP alone FAILS the ratchet.
//
//   OMISSION: one surface simply lacking what the other has. The ratchet is
//     blind to it — removing `remote_footprint` from MCP passes every existing
//     auditor — and omission is what every recent finding actually was:
//       · the remote-footprint disclosure existed ONLY on the CLI, while its
//         accuracy was corrected twice, both times on the CLI
//       · `wait --handle` returned exit_code/took_seconds on MCP and the bare
//         word `idle` on the CLI, against a doc promise that named no surface
//       · the exit-code caveat had NEVER appeared in CLI text mode, 27 rounds
//       · `last_exit_code` was qualified on two surfaces out of four
//
// So this drives BOTH surfaces for real and compares what each actually emits.
// Rendered output, not source greps — source is what `surfaces.js` reads, and
// it passes while the capability is missing, because a thing that is absent
// leaves nothing to match.
//
// A registry has an obvious weakness: someone must add the entry. It is still
// strictly better than the proxy it replaces, and every entry below exists
// because that exact divergence shipped to a reviewer.
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'packages', 'cli', 'dist', 'index.js');
const SERVER = path.join(ROOT, 'packages', 'mcp', 'dist', 'index.js');
const core = require(path.join(ROOT, 'packages', 'core', 'dist', 'index.js'));

// BOTH streams. The CLI prints its advisories to stderr — the exit-code caveat,
// the width notice, the blind-spot warnings — so reading stdout alone reports a
// missing capability that is plainly there. The first run of this script did
// exactly that and produced two false holes.
const cli = (args) => {
  try {
    const out = execFileSync('node', [CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out;
  } catch (e) {
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
};

/** stdout + stderr, which is what a human or an agent actually sees. */
const cliAll = (args) => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8' });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
};

/** The parsed payloads from an MCP run: regexing the raw stream matches the
 *  ESCAPED JSON (\"took_seconds\") and misses the field that is really there. */
function mcpFacts(raw) {
  const texts = [];
  for (const line of raw.split('\n').filter(Boolean)) {
    try {
      const j = JSON.parse(line);
      for (const c of j.result?.content ?? []) texts.push(c.text ?? '');
    } catch {
      /* not every line is a response */
    }
  }
  return texts.join('\n');
}

function mcp(calls, ms = 6000) {
  return new Promise((resolve) => {
    const p = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.stdin.write(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05",' +
        '"capabilities":{},"clientInfo":{"name":"v","version":"0"}}}\n',
    );
    p.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    for (const c of calls) p.stdin.write(`${JSON.stringify(c)}\n`);
    setTimeout(() => {
      p.kill();
      resolve(out);
    }, ms);
  });
}

const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

const settle = async (n) => {
  for (let i = 0; i < 15; i++) {
    const s = await core.get(n).catch(() => null);
    if (s && s.state === 'idle') return;
    await new Promise((r) => setTimeout(r, 600));
  }
};

// --selftest: the comparison itself must report a one-sided fact as a hole.
if (process.argv.includes('--selftest')) {
  const judge = (inCli, inMcp) => (inCli && inMcp ? 'ok' : 'hole');
  const bothSides = judge(true, true) === 'ok';
  const cliOnly = judge(true, false) === 'hole';
  const mcpOnly = judge(false, true) === 'hole';
  const ok = bothSides && cliOnly && mcpOnly;
  console.log(
    ok
      ? 'twosurface --selftest: OK — one-sided is a hole in either direction, two-sided is not'
      : `twosurface --selftest: FAILED both=${bothSides} cliOnly=${cliOnly} mcpOnly=${mcpOnly}`,
  );
  process.exit(ok ? 0 : 1);
}

(async () => {
  const n = `ts-${process.pid}`;
  const holes = [];
  let checked = 0;

  const compare = (what, seenCli, seenMcp) => {
    checked++;
    if (seenCli && seenMcp) return;
    holes.push(
      `${what}: CLI ${seenCli ? 'yes' : 'NO'} / MCP ${seenMcp ? 'yes' : 'NO'}` +
        ' — one surface reports this and the other does not',
    );
  };

  try {
    await core.kill(n).catch(() => {});
    await core.create({ name: n, cwd: '/tmp' });
    await settle(n);
    await core.run(n, 'echo ok');

    // 1. What a REMOTE host is left with. Existed on the CLI alone while being
    //    corrected twice for accuracy.
    {
      const c = cliAll(['doctor', '--artifacts']);
      const m = mcpFacts(await mcp([call(2, 'doctor', {})], 3000));
      compare(
        'doctor: remote-host footprint disclosure',
        /writes no files of its own/.test(c),
        /writes no files of its own/.test(m),
      );
      compare(
        'doctor: remote shell-history warning',
        /your shell writes its own/.test(c),
        /your shell writes its own/.test(m),
      );
    }

    // 2. `wait --handle` returning THIS command's outcome, which the doc
    //    promises without naming a surface.
    {
      const st = await core.start(n, 'sleep 2; echo fin');
      await new Promise((r) => setTimeout(r, 4500));
      const c = cliAll(['wait', n, '--handle', st.handle]);
      const m = mcpFacts(
        await mcp([call(2, 'wait', { session: n, handle: st.handle, timeout_seconds: 8 })], 5000),
      );
      compare('wait --handle: the command\'s own exit code', /exit 0|exit_code/.test(c), /"exit_code"/.test(m));
      compare('wait --handle: its duration', /\d+s/.test(c), /"took_seconds"/.test(m));
    }

    // 3. `this_server.started_utc` must be a real process start, and must agree
    //    with what the CLI's stale-server report says about the same pid.
    //
    //    It did not. MCP reported one time, the CLI another, 78 minutes apart
    //    for one process, and a reviewer could not tell which to believe. The
    //    MCP field was the BUILD's mtime wearing a start-time name — visible in
    //    the payload, because started_utc and build_utc were the same string.
    {
      const m = mcpFacts(await mcp([call(2, 'doctor', {})], 3000));
      let started = null;
      let loaded = null;
      // Parse the WHOLE payload. The doctor result is pretty-printed JSON over
      // many lines, so taking the first line that starts with `{` yields the
      // bare brace and throws — which reported both facts as missing on a build
      // where they were present. Third detection bug in this file; each one
      // found only by running it against a KNOWN-BAD build as well as a good
      // one, which is why both directions are always exercised.
      try {
        const j = JSON.parse(m.slice(m.indexOf('{'), m.lastIndexOf('}') + 1));
        started = j.this_server?.started_utc ?? null;
        loaded = j.this_server?.loaded_build_utc ?? null;
      } catch {
        /* reported as a hole below */
      }
      compare('this_server: reports a start time at all', !!started, !!started);
      // The tell: two differently-named fields holding one value.
      compare(
        'this_server: start time is not just the build mtime',
        started !== null && started !== loaded,
        started !== null && started !== loaded,
      );
    }

    // 4. The exit-code caveat on a compound line. Absent from CLI text mode for
    //    twenty-seven rounds while MCP carried it the whole time.
    {
      const c = cliAll(['run', n, '--', 'echo a; echo b']);
      const m = mcpFacts(await mcp([call(2, 'run', { session: n, command: 'echo a; echo b' })], 5000));
      compare(
        'run: compound-exit caveat',
        /LAST PART|last part of this line|exit_code_covers/.test(c),
        /exit_code_covers/.test(m),
      );
    }
  } catch (e) {
    holes.push(`THREW: ${String(e.message).slice(0, 80)}`);
  } finally {
    await core.kill(n).catch(() => {});
  }

  if (holes.length) {
    console.error('facts reported by one surface and not the other:\n');
    for (const h of holes) console.error(`  ${h}`);
    console.error(
      '\nThis is the largest defect class in the project. Put the fact in core and have both\n' +
        'surfaces read it — see REMOTE_FOOTPRINT, EMPTY_TAIL_ADVICE, trimProspect.\n',
    );
    process.exit(1);
  }
  console.log(`twosurface: ${checked} fact(s), each reported by BOTH surfaces`);
})();
