#!/usr/bin/env node
//
// A constant must be stated once, and an ambiguous pair must be labelled.
//
// Two findings from one reviewer, both about payload text rather than behaviour:
//
//   - The stale-server block ran in full on every `new`. Creating four sessions
//     got them the same ~400-word warning four times: "four times is three
//     times too many". It describes THIS PROCESS, so it cannot change between
//     sessions — a per-session throttle is the wrong grain.
//
//   - `cwd` and `local_cwd` are different machines, and identical strings when
//     the username matches on both. "I genuinely cannot distinguish them from
//     the output, and this is exactly the 'which host am I speaking as'
//     confusion the docs warn about — here created by the field values rather
//     than caught by them."
//
// Driven through the real MCP server over stdio, because both are properties of
// what that server actually emits, and the first one only appears across
// SEVERAL calls to one long-lived process.
const { spawn } = require('node:child_process');
const path = require('node:path');

const server = path.join(__dirname, '..', 'packages', 'mcp', 'dist', 'index.js');

function drive(requests, ms = 5000) {
  return new Promise((resolve) => {
    const p = spawn('node', [server], { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.stdin.write(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05",' +
        '"capabilities":{},"clientInfo":{"name":"v","version":"0"}}}\n',
    );
    p.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    for (const r of requests) p.stdin.write(`${JSON.stringify(r)}\n`);
    setTimeout(() => {
      p.kill();
      const results = [];
      for (const line of out.split('\n').filter(Boolean)) {
        try {
          const j = JSON.parse(line);
          if (j.result?.content) results.push(JSON.parse(j.result.content[0].text));
        } catch {
          /* not every line is a result */
        }
      }
      resolve(results);
    }, ms);
  });
}

const call = (id, name, args) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

(async () => {
  const out = [];
  const made = ['no1', 'no2', 'no3'];
  try {
    const res = await drive([
      call(2, 'new', { name: 'no1', cwd: '/tmp' }),
      call(3, 'new', { name: 'no2', cwd: '/tmp' }),
      call(4, 'new', { name: 'no3', cwd: '/tmp' }),
    ]);
    const created = res.filter((r) => r.name);
    out.push(created.length >= 3 ? 'threeCreated' : `ONLY${created.length}CREATED`);
    const withStale = created.filter((r) => r.stale_servers).length;
    // 0 is a pass too: it means nothing was stale to report. What must never
    // happen is the same constant repeated across every creation.
    out.push(withStale <= 1 ? 'staleSaidAtMostOnce' : `STALEREPEATED${withStale}`);
    // The per-call facts must still ride every call — they are one line, and
    // they are the answer to "which build am I on".
    out.push(created.every((r) => r.this_server) ? 'identityEveryCall' : 'IDENTITYMISSING');
  } catch (e) {
    out.push(`THREW:${String(e.message).slice(0, 40)}`);
  } finally {
    const core = require(path.join(__dirname, '..', 'packages', 'core', 'dist', 'index.js'));
    for (const n of made) await core.kill(n).catch(() => {});
  }
  process.stdout.write(out.join(' '));
})();
