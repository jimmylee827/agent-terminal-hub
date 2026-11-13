#!/usr/bin/env node
'use strict';
// Local, isolated completion contract tests. Pass a scratch directory explicitly.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
if (!process.argv[2]) throw new Error('usage: completioncheck.js SCRATCH_DIRECTORY');
process.env.ATH_HOME = path.join(path.resolve(process.argv[2]), 'home');
process.env.ATH_SOCKET = `athcompletion${process.pid}`;
const core = require('../packages/core/dist');
const store = require('../packages/core/dist/completion-store');
const cli = path.resolve(__dirname, '../packages/cli/dist/index.js');
const names = new Set();
let assertions = 0;
function check(condition, message) { assert.ok(condition, message); assertions++; }
function cliAwait(name, handle, timeout = 0, extra = []) {
  const child = spawn(process.execPath, [cli, 'await', name, '--handle', handle,
    '--json', '--metadata-only', '--timeout-seconds', String(timeout), ...extra],
    { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', (b) => stdout += b);
    child.stderr.on('data', (b) => stderr += b);
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        check(stdout.trim().split('\n').length === 1, 'one JSON stdout record');
        const data = JSON.parse(stdout);
        check(!stdout.includes('DO_NOT_FORWARD') && !stderr.includes('DO_NOT_FORWARD'), 'no command/output/reason leakage');
        check(!/output|pane_tail|asked_for|cwd|reason|command"/.test(stdout), 'metadata allowlist');
        resolve({ code, data, stderr });
      } catch (err) { reject(err); }
    });
  });
}
function mcpClient() {
  const child = spawn(process.execPath, [path.resolve(__dirname, '../packages/mcp/dist/index.js')],
    { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', id = 1;
  const pending = new Map();
  child.stderr.resume();
  child.stdout.on('data', (b) => {
    buffer += b;
    for (let at; (at = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      const response = JSON.parse(line);
      const resolve = pending.get(response.id);
      if (resolve) { pending.delete(response.id); resolve(response); }
    }
  });
  function request(method, params) {
    const next = id++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(next); reject(new Error('MCP response deadline')); }, 15000);
      pending.set(next, (r) => { clearTimeout(timer); resolve(r); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n');
    });
  }
  return { request, close: () => child.kill() };
}
function metadata(response) {
  check(!response.error && !response.result.isError, 'MCP tool succeeds');
  for (const block of response.result.content) {
    try { return JSON.parse(block.text.replace(/^--- ath ---\n/, '')); } catch { /* output block */ }
  }
  throw new Error('missing MCP metadata');
}
async function create(name) {
  names.add(name);
  await core.create({ name, cwd: process.cwd() });
  await core.run(name, 'true');
}
async function expireResult(handle) {
  const file = path.join(store.COMPLETION_DIR, `${handle}.result`);
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  data.expires_at = Date.now() - 1;
  await fs.writeFile(file, JSON.stringify(data));
}
async function main() {
  await fs.mkdir(process.env.ATH_HOME, { recursive: true });
  const capability = require('node:child_process').spawnSync(process.execPath,
    [cli, 'completion-protocol', '--json'], { env: process.env, encoding: 'utf8' });
  check(capability.status === 0, 'capability available');
  assert.deepEqual(JSON.parse(capability.stdout), { schema_version: 1, metadata_only: true, per_handle: true }); assertions++;
  check(capability.stderr === '', 'capability emits no diagnostics/transcript');
  check(!(await fs.readdir(process.env.ATH_HOME)).length, 'capability does not touch hub state');
  // Null must never become zero; shell exit takes precedence over the numeric status.
  for (const [input, outcome] of [
    [{ exitCode: 0 }, 'done'], [{ exitCode: 1 }, 'finished_nonzero'],
    [{ exitCode: 130 }, 'interrupted'], [{ exitCode: 143 }, 'interrupted'],
    [{ exitCode: null }, 'outcome_unavailable'],
    [{ exitCode: null, remoteDisconnected: true }, 'remote_disconnected'],
    [{ exitCode: null, commandGone: true }, 'command_gone'],
    [{ exitCode: 0, shellExited: true }, 'shell_exited'],
  ]) check(core.classifyCompletion(input).outcome === outcome, `classify ${outcome}`);

  await create('pending');
  const job = await core.start('pending', "sleep 4; printf 'DO_NOT_FORWARD_output\\n'; (exit 7)");
  await core.requestHuman('pending', 'DO_NOT_FORWARD_reason', 'test', job.handle, false);
  const snapshot = await cliAwait('pending', job.handle);
  check(snapshot.code === 0 && snapshot.data.outcome === 'timeout', 'snapshot is observer timeout, not password status');
  const bounded = await cliAwait('pending', job.handle, 0.05);
  check(bounded.code === 0 && bounded.data.outcome === 'timeout', 'bounded observation never claims command success');
  const waiting = cliAwait('pending', job.handle, 15);
  const end = await waiting;
  check(end.code === 0 && end.data.outcome === 'finished_nonzero' && end.data.exit_code === 7, 'command rc is data, observer rc0');
  check(end.data.evidence === 'end_marker' && Number.isFinite(end.data.next_offset), 'marker evidence and cursor');
  check(typeof end.data.completion_id === 'string' && end.data.completion_id.length === 64, 'stable completion identity');
  // Re-running the waiter is a new process, not a new privileged command.
  const replay = await cliAwait('pending', job.handle);
  check(replay.data.completion_id === end.data.completion_id && replay.data.replayed, 'restart/replay deduplicable');
  await core.purgeLog('pending');
  await core.purgeSessionRequests('pending');
  await core.kill('pending');
  const afterKill = await cliAwait('pending', job.handle);
  check(afterKill.data.outcome === 'finished_nonzero' && afterKill.data.exit_code === 7, 'saved outcome outranks purge/kill');
  await expireResult(job.handle);
  const expired = await cliAwait('pending', job.handle);
  check(expired.data.outcome === 'outcome_unavailable' && expired.data.exit_code === null, 'expired result never reused');

  await create('codes');
  for (const code of [0, 1, 130, 143]) {
    const result = await core.run('codes', `(exit ${code})`);
    const got = await cliAwait('codes', result.handle);
    check(got.data.exit_code === code, `exit ${code} preserved`);
    check(got.data.outcome === (code === 0 ? 'done' : code === 130 || code === 143 ? 'interrupted' : 'finished_nonzero'), `exit ${code} classified`);
  }
  const unknown = await cliAwait('codes', 'ffffffffffff');
  check(unknown.data.outcome === 'unknown_handle' && unknown.data.exit_code === null, 'unknown handle never attaches to latest command');
  const wrongSessionJob = await core.run('codes', 'true');
  const wrongSession = await cliAwait('other', wrongSessionJob.handle);
  check(wrongSession.data.outcome === 'unknown_handle', 'handle/session binding enforced');
  const badArgs = await cliAwait('codes', '../../DO_NOT_FORWARD', 0);
  check(badArgs.code === 2 && badArgs.data.error_code === 'invalid_arguments', 'invalid args never echoed or used as paths');
  const badFlag = await cliAwait('codes', wrongSessionJob.handle, 0, ['--unexpected']);
  check(badFlag.code === 2, 'unknown flag rejected in machine mode');

  await create('reused');
  const old = await core.start('reused', 'sleep 30');
  await core.kill('reused');
  await create('reused');
  const replacement = await core.start('reused', 'sleep 2');
  const stale = await cliAwait('reused', old.handle);
  check(stale.data.outcome === 'session_gone' && stale.data.exit_code === null, 'old session cannot consume replacement completion');
  await cliAwait('reused', replacement.handle, 10);

  await create('harvest');
  const first = await core.start('harvest', 'sleep 1; (exit 9)');
  await new Promise((r) => setTimeout(r, 1500));
  await core.run('harvest', "printf 'DO_NOT_FORWARD_next\\n'");
  // New command harvests the previous handle before rotation/output can hide its marker.
  await core.purgeLog('harvest');
  const harvested = await cliAwait('harvest', first.handle);
  check(harvested.data.exit_code === 9, 'previous completion persisted before next dispatch');

  // A no-echo handoff, bounded wait, turn-end, then later completion: no real credential.
  await create('handoff');
  const wall = await core.run('handoff', "stty -echo; printf 'Continue? '; read reply; stty echo; printf 'DO_NOT_FORWARD_done\\n'", { timeoutMs: 1800 });
  check(wall.exitCode === null && !!wall.handle, 'handoff is still live');
  const timed = await cliAwait('handoff', wall.handle, 0);
  check(timed.data.outcome === 'timeout', 'bounded handoff wait does not claim answered');
  const requestsBefore = (await core.listAllRequests()).length;
  const noticeFlagsBefore = await fs.readdir(core.RC_DIR);
  let endSeen;
  const endFile = core.logPath('handoff');
  const watch = require('node:fs').watch(endFile, () => {
    void fs.readFile(endFile, 'utf8').then((s) => {
      if (s.includes(`\x1e<ATHE:${wall.handle}:0:`) && endSeen === undefined) endSeen = performance.now();
    });
  });
  const resumed = cliAwait('handoff', wall.handle, 15);
  await core.sendLine('handoff', 'continue'); // ordinary non-credential input, echo disabled
  const finished = await resumed;
  watch.close();
  const latency = endSeen === undefined ? NaN : performance.now() - endSeen;
  check(finished.data.outcome === 'done' && finished.data.exit_code === 0, 'completion arrives after bounded wait without a new command');
  check(Number.isFinite(latency) && latency < 2000, `healthy observer latency <2s (${latency}ms)`);
  check((await core.listAllRequests()).length === requestsBefore, 'metadata waiter files no new human requests');
  const newFlags = (await fs.readdir(core.RC_DIR)).filter((s) => !noticeFlagsBefore.includes(s));
  check(!newFlags.some((s) => /caveat|warn|wnote/.test(s)), 'metadata waiter consumes no output/UI notices');
  console.log(`completioncheck: no-echo completion detection ${Math.round(latency)}ms`);

  await create('shell');
  const shell = await core.start('shell', 'sleep 1; exit 4');
  const shellEnd = await cliAwait('shell', shell.handle, 10);
  check(shellEnd.data.outcome === 'shell_exited' && shellEnd.data.evidence === 'shell_exit' && shellEnd.data.exit_code === 4, 'shell exit is not regular completion');

  // Marker-only fixtures for transports: no host connection and no credential.
  await create('transport');
  const transport = await core.run('transport', 'true');
  await fs.unlink(path.join(store.COMPLETION_DIR, `${transport.handle}.result`));
  await core.purgeLog('transport');
  await core.setMeta('transport', 'remote', 'fixture-not-a-host');
  await core.setMeta('transport', 'xtok', 'cafebabe1234');
  await fs.appendFile(core.logPath('transport'), '\x1e<ATHX:cafebabe1234:255>\x1e');
  const disconnected = await cliAwait('transport', transport.handle);
  check(disconnected.data.outcome === 'remote_disconnected' && disconnected.data.exit_code === null && disconnected.data.evidence === 'remote_disconnect', 'transport loss cannot become exit0');

  await create('lost');
  const lost = await core.run('lost', 'true');
  await fs.unlink(path.join(store.COMPLETION_DIR, `${lost.handle}.result`));
  await core.purgeLog('lost');
  const lostTiming = path.join(core.RC_DIR, `${lost.handle}.t`);
  await fs.writeFile(lostTiming, `${Date.now() - 5000} 0`);
  await fs.appendFile(core.logPath('lost'), '\x1e<ATHS:h999>\x1e');
  const lostDispatch = path.join(store.COMPLETION_DIR, `${lost.handle}.json`);
  const ld = JSON.parse(await fs.readFile(lostDispatch, 'utf8')); ld.offset = 0;
  await fs.writeFile(lostDispatch, JSON.stringify(ld));
  // Ensure the new prompt's marker is after the dispatch offset, not exactly at it.
  await fs.writeFile(core.logPath('lost'), '\n\x1e<ATHS:h999>\x1e');
  const gone = await cliAwait('lost', lost.handle);
  check(gone.data.outcome === 'command_gone' && gone.data.exit_code === null, 'lost frame is explicit');

  await create('reaper');
  const live = await core.start('reaper', 'sleep 10');
  const timing = path.join(core.RC_DIR, `${live.handle}.t`);
  await fs.utimes(timing, new Date(0), new Date(0));
  await core.reapStaleRc();
  const retained = await cliAwait('reaper', live.handle);
  check(retained.data.outcome === 'timeout', 'rc reaper cannot remove registered dispatch');

  await create('expiry');
  const pending = await core.start('expiry', 'sleep 10');
  const pendingFile = path.join(store.COMPLETION_DIR, `${pending.handle}.json`);
  const dispatch = JSON.parse(await fs.readFile(pendingFile, 'utf8'));
  dispatch.expires_at = Date.now() - 1;
  await fs.writeFile(pendingFile, JSON.stringify(dispatch));
  const noLongerKnown = await cliAwait('expiry', pending.handle);
  check(noLongerKnown.data.outcome === 'outcome_unavailable', 'pending expiry is visible, not waiting-for-password');
  await fs.writeFile(pendingFile, '{');
  const broken = await cliAwait('expiry', pending.handle);
  check(broken.code === 1 && broken.data.outcome === 'observer_error', 'corrupt metadata is observer failure, no raw error');

  const mcp = mcpClient();
  try {
    await mcp.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'completion-test', version: '1' } });
    await create('mcp');
    const mcpJob = await core.start('mcp', 'sleep 7; (exit 0)');
    const timedMcp = metadata(await mcp.request('tools/call', { name: 'await_human', arguments: {
      session: 'mcp', handle: mcpJob.handle, timeout_seconds: 5, max_bytes: 1 } }));
    check(timedMcp.outcome === 'still_waiting' && timedMcp.wake_delivery === 'none', 'MCP timeout has no hidden wake subscription');
    check(!timedMcp.note.includes('Nobody has answered'), 'MCP timeout makes no password-entry claim');
    const doneMcp = metadata(await mcp.request('tools/call', { name: 'await_human', arguments: {
      session: 'mcp', handle: mcpJob.handle, timeout_seconds: 5, max_bytes: 1 } }));
    check(doneMcp.outcome === 'done' && doneMcp.exit_code === 0 && doneMcp.wake_delivery === 'none', 'ordinary MCP success preserved');
    const nullMcp = metadata(await mcp.request('tools/call', { name: 'await_human', arguments: {
      session: 'transport', handle: transport.handle, timeout_seconds: 5, max_bytes: 1 } }));
    check(nullMcp.outcome === 'remote_disconnected' && nullMcp.exit_code === null, 'MCP null status does not become zero');
    const oldMcp = metadata(await mcp.request('tools/call', { name: 'await_human', arguments: {
      session: 'pending', handle: job.handle, timeout_seconds: 5, max_bytes: 1 } }));
    check(oldMcp.outcome === 'outcome_unavailable' && oldMcp.exit_code === null, 'MCP respects expired evidence after session removal');
  } finally { mcp.close(); }
  console.log(`completioncheck: PASS (${assertions} assertions)`);
}
main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(async () => {
  // Isolated test socket only; never a production host/session.
  for (const name of names) await core.kill(name).catch(() => {});
});
