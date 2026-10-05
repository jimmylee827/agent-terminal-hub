#!/usr/bin/env node
//
// What a Windows host's ConPTY does to the bytes the hub depends on.
//
// Windows sshd runs the remote shell inside ConPTY, which does not relay what a
// program writes: it renders to a screen buffer and re-emits ITS OWN VT. Five
// one-off spikes against a real host found that this destroys the POSIX marker
// protocol outright — the \x1e sentinel is stripped, a marker written and then
// erased is never transmitted, a long one is cut at the pane width — and that
// escape sequences overtake the text they were written after. The PowerShell
// transport is designed around the two channels that survived: concealed text
// (ordered with output by construction) and OSC 777 (long payloads, unordered).
//
// This turns those spikes into something repeatable, because a design resting
// on how one Windows build renders must be re-checked on the next one.
//
//   GATE  a property the PowerShell transport depends on. Any failure fails.
//   INFO  a characterization, recorded but never failed on: a sentinel that
//         starts surviving on some future build is news, not breakage.
//
// The stress gate must prove the console host was actually starved; a
// "survived load" result measured on an idle machine is the vacuous pass this
// repo keeps finding in its own checks.
//
//   node scripts/conpty-probe.js HOST [--keep] [--only baseline,order,burst,repaint,input,stress]
//
// Needs key auth (BatchMode — it must never sit at a password prompt). Writes
// nothing on the host; the probe scripts travel as -EncodedCommand and are
// never typed, so they do not reach the shell's history either. The stress
// probe keeps the host's CPU busy for up to two minutes.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const host = process.argv[2];
const keep = process.argv.includes('--keep');
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt > 0 ? new Set((process.argv[onlyAt + 1] || '').split(',')) : null;
const want = (probe) => !only || only.has(probe);
if (!host || host.startsWith('-')) {
  console.error('usage: conpty-probe.js HOST [--keep] [--only probe,...]');
  process.exit(2);
}

const SOCK = `athprobe${process.pid}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'athprobe-'));
const W = 200;
const H = 50;
const UTF8_HEX = 'e4b8ade69687e29c93'; // 中文✓

const tmux = (...args) => spawnSync('tmux', ['-u', '-L', SOCK, '-f', '/dev/null', ...args], { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const gate = (name, ok, detail = '') => results.push({ kind: 'gate', name, ok: !!ok, detail });
const info = (name, detail) => results.push({ kind: 'info', name, detail });

function cleanup() {
  tmux('kill-server');
  if (!keep) fs.rmSync(work, { recursive: true, force: true });
}
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

// ---- PowerShell building blocks ---------------------------------------------
//
// No PowerShell backtick escapes and no `${` anywhere: both collide with the
// JavaScript template literals these are written in. Control bytes are built
// from [char] codes instead.
const PRELUDE = [
  '$e=[char]27; $b=[char]7; $rs=[char]30; $cr=[char]13',
  "function AthHid($t){ Write-Host -NoNewline ($e+'[8m'+$t+$e+'[28m') }",
  "function AthOsc($t){ Write-Host -NoNewline ($e+']777;ath;'+$t+$b) }",
].join('\n');
const UTF8_OUT = '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding';
const END = "Write-Host ''; Write-Host 'ATHPROBE-END'";

function rounds(prefix, count, { osc = false, burstEvery = 0 } = {}) {
  const mark = osc ? (kind) => `AthOsc ('${kind}:'+$k)` : (kind) => `AthHid ('<ATH${kind}:'+$k+'>')`;
  const burst = burstEvery
    ? `if($i % ${burstEvery} -eq 0){ 1..30 | ForEach-Object { Write-Host ('o-'+$k+'-m'+$_) } }; `
    : '';
  return (
    `foreach($i in 1..${count}){ $k='${prefix}'+$i; ${mark('S')}; Write-Host ('o-'+$k+'-a'); ` +
    `${burst}Write-Host -NoNewline ('o-'+$k+'-z'); ${mark('E')} }; Write-Host ''`
  );
}

// ---- running one probe -------------------------------------------------------

/**
 * Run a PowerShell script on the host inside a fresh tmux pane, capturing the
 * raw pane output exactly as the hub's pipe-pane would see it.
 */
async function capture(name, script, { shell = 'powershell', interactive = false, during, timeoutMs = 60_000 } = {}) {
  const ps = `${PRELUDE}\n${script}`;
  const b64 = Buffer.from(ps, 'utf16le').toString('base64');
  const remote = `${shell} -NoLogo -NoProfile${interactive ? ' -NoExit' : ''} -EncodedCommand ${b64}`;
  // cmd.exe caps a command line at 8,191 characters, and this one passes through it.
  if (remote.length > 8000) throw new Error(`${name}: encoded command is ${remote.length} chars, over cmd.exe's ceiling`);
  const boot = path.join(work, `${name}.boot`);
  const log = path.join(work, `${name}.log`);
  fs.writeFileSync(
    boot,
    `exec ssh -o BatchMode=yes -o ConnectTimeout=10 -o RemoteCommand=none -t ${host} "${remote}"\n`,
  );
  fs.writeFileSync(log, '');
  tmux('new-session', '-d', '-s', name, '-x', String(W), '-y', String(H), 'sh');
  tmux('pipe-pane', '-t', name, '-o', `cat >> '${log}'`);
  tmux('send-keys', '-t', name, `sh '${boot}'`, 'Enter');

  const read = () => fs.readFileSync(log, 'latin1');
  const ctx = {
    log,
    read,
    size: () => fs.statSync(log).size,
    keys: (text) => tmux('send-keys', '-t', name, '-l', text),
    enter: () => tmux('send-keys', '-t', name, 'Enter'),
    resize: (x) => tmux('resize-window', '-t', name, '-x', String(x)),
    screen: () => tmux('capture-pane', '-p', '-t', name).stdout,
    async waitFor(re, ms = timeoutMs) {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (re.test(read())) return true;
        await sleep(200);
      }
      return false;
    },
  };
  if (during) await during(ctx);
  // An interactive probe ends when `during` types `exit`; it prints no marker.
  const finished = interactive || (await ctx.waitFor(/ATHPROBE-END/));
  await sleep(300);
  tmux('kill-session', '-t', name);
  const raw = fs.readFileSync(log); // bytes
  if (!finished) info(`${name}: did not reach its end marker`, 'its gates judged a partial log; rerun with --keep to inspect it');
  return raw;
}

// ---- parsing -----------------------------------------------------------------

const asText = (buf) => buf.toString('utf8');
/** Drop CSI sequences and CRs; keep OSC 777 so its position can be compared. */
const stripCsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');

/**
 * Split output into what a human SEES and what is concealed, by tracking SGR
 * state. ConPTY merges adjacent concealed runs and may combine parameters, so
 * a literal `\e[8m…\e[28m` wrapper cannot be matched — the state has to be
 * followed. 38/48 carry sub-parameters, so a colour index of 8 is not conceal.
 */
function splitConcealed(s) {
  let concealed = false;
  let visible = '';
  let hidden = '';
  const re = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b.|([^\x1b]+)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1] !== undefined) {
      const p = m[1] === '' ? ['0'] : m[1].split(';');
      for (let i = 0; i < p.length; i++) {
        if (p[i] === '38' || p[i] === '48') i += p[i + 1] === '5' ? 2 : p[i + 1] === '2' ? 4 : 0;
        else if (p[i] === '8') concealed = true;
        else if (p[i] === '28' || p[i] === '0') concealed = false;
      }
    } else if (m[2] !== undefined) {
      const text = m[2].replace(/\r/g, '');
      if (concealed) hidden += text;
      else visible += text;
    }
  }
  return { visible, hidden };
}

/** How many rounds kept S < output < E, each marker seen once. */
function framedRounds(text, prefix, count, osc) {
  let good = 0;
  const bad = [];
  for (let i = 1; i <= count; i++) {
    const k = `${prefix}${i}`;
    const S = osc ? `\x1b]777;ath;S:${k}\x07` : `<ATHS:${k}>`;
    const E = osc ? `\x1b]777;ath;E:${k}\x07` : `<ATHE:${k}>`;
    const s = text.indexOf(S);
    const e = text.indexOf(E);
    const a = text.indexOf(`o-${k}-a`);
    const z = text.indexOf(`o-${k}-z`);
    const mids = [...text.matchAll(new RegExp(`o-${k}-m\\d+`, 'g'))].map((x) => x.index);
    const once = text.split(S).length === 2 && text.split(E).length === 2;
    const ok = s >= 0 && a > s && z >= a && e > z && once && mids.every((p) => p > s && p < e);
    if (ok) good++;
    else if (bad.length < 3) bad.push(k);
  }
  return { good, bad };
}

const hex = (buf) => buf.toString('hex');
const escaped = (buf) =>
  JSON.stringify(buf.toString('latin1')).slice(1, -1).replace(/\\u001b/g, '\\e').slice(0, 160);

// ---- the probes ---------------------------------------------------------------

async function probeBaseline(shell) {
  const tag = shell === 'pwsh' ? 'pwsh' : 'ps51';
  const raw = await capture(
    `base-${tag}`,
    [
      "Write-Host ('ENC=' + [Console]::OutputEncoding.WebName + ' CP=' + [Console]::OutputEncoding.CodePage)",
      "Write-Host ('VER=' + $PSVersionTable.PSVersion)",
      UTF8_OUT,
      "Write-Host -NoNewline ($rs+'<ATHS:erased1>'+$rs+$cr+$e+'[K'); Write-Host 'after-erase'",
      "Write-Host -NoNewline ($rs+'<ATHE:erased2:7:'+('Q'*300)+'>'+$rs+$cr+$e+'[K'); Write-Host 'after-long'",
      "AthOsc ('long:'+('W'*300))",
      "Write-Host -NoNewline ($e+']0;ttl1'+$b); Write-Host -NoNewline ($e+']0;ttl2'+$b); Write-Host -NoNewline ($e+']0;ttl3'+$b)",
      "Write-Host -NoNewline ('x'*190); AthHid '<ATHE:wrapedge:3>'; Write-Host ''",
      "Write-Host 'UTF=中文✓'",
      END,
    ].join('\n'),
    { shell },
  );
  const text = asText(raw);
  const plain = stripCsi(text);
  const enc = /ENC=(\S+) CP=(\d+)/.exec(text);
  info(`${tag}: version / default output encoding`, `${(/VER=(\S+)/.exec(text) || [])[1] || '?'} / ${enc ? `${enc[1]} (cp${enc[2]})` : '?'}`);
  info(`${tag}: \\x1e sentinel bytes that survived`, String(raw.filter((c) => c === 0x1e).length));
  info(`${tag}: written-then-erased marker transmitted`, plain.includes('<ATHS:erased1>') ? 'yes' : 'no');
  const qrun = Math.max(0, ...[...plain.matchAll(/Q+/g)].map((m) => m[0].length));
  info(`${tag}: erased 300-char marker, longest surviving run`, String(qrun));
  info(`${tag}: window titles arrived (of 3 sent)`, String(['ttl1', 'ttl2', 'ttl3'].filter((t) => text.includes(`]0;${t}`)).length));
  gate(`${tag}: OSC 777 carries a 300-char payload intact`, text.includes(`\x1b]777;ath;long:${'W'.repeat(300)}\x07`));
  gate(`${tag}: a concealed marker crossing the right edge stays whole`, plain.includes('<ATHE:wrapedge:3>'));
  const at = raw.indexOf(Buffer.from('UTF='));
  const got = at >= 0 ? hex(raw.subarray(at + 4, at + 4 + 9)) : '';
  gate(`${tag}: UTF-8 output survives once the encoding is forced`, got === UTF8_HEX, `got ${got || 'nothing'}`);
}

async function probeOrdering() {
  const raw = await capture(
    'order',
    [UTF8_OUT, rounds('ci', 20, { burstEvery: 5 }), rounds('oi', 10, { osc: true }), END].join('\n'),
  );
  const text = stripCsi(asText(raw));
  const c = framedRounds(text, 'ci', 20, false);
  const o = framedRounds(text, 'oi', 10, true);
  gate('idle: concealed markers frame their output, no sleep (20/20)', c.good === 20, `${c.good}/20${c.bad.length ? `, e.g. ${c.bad}` : ''}`);
  info('idle: OSC-only markers that framed their output', `${o.good}/10`);
  const { visible, hidden } = splitConcealed(asText(raw));
  const inHidden = (hidden.match(/<ATH[SE]:ci\d+>/g) || []).length;
  const inVisible = (visible.match(/<ATH[SE]:ci\d+>/g) || []).length;
  gate('idle: every marker arrives inside a concealed span (SGR-8 sentinel)', inHidden === 40 && inVisible === 0, `${inHidden} concealed, ${inVisible} visible`);
  gate('idle: no output leaks into the concealed spans', !/o-ci\d+-/.test(hidden));
}

/**
 * Output that outruns the renderer must still arrive, every line, in order.
 *
 * ConPTY transmits rendered frames. If more than a screenful scrolls past
 * between two frames, the lines that entered and left the screen in between
 * are a candidate for never being sent at all — which would hand back output
 * with lines silently missing beside an exact exit code. One write of five
 * thousand lines is far faster than any frame rate, so it forces the case.
 */
async function probeBurst() {
  const raw = await capture(
    'burst',
    [
      UTF8_OUT,
      "AthHid '<ATHS:bf>'",
      "[Console]::Out.Write(((1..5000 | ForEach-Object { 'bl-' + $_ }) -join [char]10) + [char]10); [Console]::Out.Flush()",
      "AthHid '<ATHE:bf>'",
      END,
    ].join('\n'),
    { timeoutMs: 90_000 },
  );
  const text = stripCsi(asText(raw));
  const s = text.indexOf('<ATHS:bf>');
  const e = text.indexOf('<ATHE:bf>');
  const inside = s >= 0 && e > s ? text.slice(s, e) : '';
  const seen = [...inside.matchAll(/bl-(\d+)\b/g)].map((m) => Number(m[1]));
  const missing = [];
  const have = new Set(seen);
  for (let i = 1; i <= 5000; i++) if (!have.has(i)) missing.push(i);
  const ordered = seen.every((v, i) => i === 0 || v > seen[i - 1]);
  gate('burst: both markers arrive around 5,000 lines written at once', s >= 0 && e > s);
  gate(
    'burst: no line is lost when output outruns the renderer',
    missing.length === 0,
    `${have.size}/5000 present${missing.length ? `, first missing ${missing.slice(0, 5)}` : ''}`,
  );
  gate('burst: and none is duplicated or reordered', ordered && seen.length === have.size, `${seen.length} seen, ${have.size} distinct`);
}

/**
 * Ordering must hold while the console host is STARVED — measured directly.
 *
 * Three load meters were tried on the reference host and none could be
 * trusted. Win32_Processor.LoadPercentage read 9% while the spinners' own
 * process was provably using 52% of every core. The formatted perf counters
 * need two samples, so a first read means nothing. And the spinners' own CPU
 * share — honest while idle, 58-61% — collapses to ~16% the moment console
 * writes begin, although every spinner is still running: Windows reclassifies
 * the session. Full saturation is not reachable from under sshd at all.
 *
 * So the gate measures the effect rather than a proxy for it: the same rounds
 * run idle and then under contention, and the contended run must take at
 * least three times as long. On the reference host it took ~60 s against a
 * second or two — about 100 ms per console write, a renderer that is plainly
 * starved. Spinning is native (`SpinWait`), so interpreter allocation and GC
 * pauses cannot quietly lower it, and every spinner stops itself at a deadline
 * so nothing outlives a cut-off session.
 */
async function probeStress() {
  const raw = await capture(
    'stress',
    [
      UTF8_OUT,
      // The same rounds, idle, first: the yardstick for the slowdown below.
      '$w1=[Diagnostics.Stopwatch]::StartNew()',
      rounds('sw', 50, { burstEvery: 5 }),
      "Write-Host ('IDLEMS=' + $w1.ElapsedMilliseconds)",
      '$n=[Environment]::ProcessorCount; $until=[DateTime]::UtcNow.AddSeconds(150)',
      '$spin=1..$n | ForEach-Object { $p=[powershell]::Create(); [void]$p.AddScript({ param($u) while([DateTime]::UtcNow -lt $u){ [Threading.Thread]::SpinWait(20000000) } }).AddArgument($until); [pscustomobject]@{p=$p; h=$p.BeginInvoke()} }',
      'Start-Sleep -Milliseconds 800',
      '$p0=(Get-Process -Id $PID).TotalProcessorTime; $w0=[Diagnostics.Stopwatch]::StartNew(); Start-Sleep -Seconds 3',
      "Write-Host ('PRE=' + [int](((Get-Process -Id $PID).TotalProcessorTime - $p0).TotalMilliseconds / ($w0.ElapsedMilliseconds * $n) * 100) + ' STATE=' + $spin[0].p.InvocationStateInfo.State + ' RUNNING=' + @($spin | Where-Object { -not $_.h.IsCompleted }).Count)",
      '$t0=(Get-Process -Id $PID).TotalProcessorTime; $w=[Diagnostics.Stopwatch]::StartNew()',
      rounds('st', 50, { burstEvery: 5 }),
      rounds('so', 20, { osc: true }),
      'Start-Sleep -Seconds 2',
      "Write-Host ('SHARE=' + [int](((Get-Process -Id $PID).TotalProcessorTime - $t0).TotalMilliseconds / ($w.ElapsedMilliseconds * $n) * 100) + ' CORES=' + $n + ' MS=' + $w.ElapsedMilliseconds)",
      '$spin | ForEach-Object { $_.p.Stop(); $_.p.Dispose() }',
      END,
    ].join('\n'),
    { timeoutMs: 200_000 },
  );
  const text = stripCsi(asText(raw));
  const idleMs = Number((/IDLEMS=(\d+)/.exec(text) || [])[1] ?? -1);
  const busyMs = Number((/ MS=(\d+)/.exec(text) || [])[1] ?? -1);
  const share = (/SHARE=(\d+)/.exec(text) || [])[1] ?? '?';
  const cores = (/CORES=(\d+)/.exec(text) || [])[1] || '?';
  info('stress: spinners while idle (3s window) / their state', ((/PRE=(\d+) STATE=(\S+) RUNNING=(\d+)/.exec(text) || []).slice(1).join(' / ')) || '?');
  // Not the gate: this share collapses the moment console writes begin, while
  // the spinners demonstrably keep running. Recorded so the next reader does
  // not rediscover it.
  info('stress: spinners\' CPU share during the rounds (unreliable as a load meter)', `${share}% of ${cores} logical cores`);
  // The gate is the thing itself: the console host must have been starved,
  // measured as the same rounds taking several times longer than they do idle.
  const loaded = idleMs > 0 && busyMs >= 3 * idleMs;
  gate(
    'stress: the console host was measurably starved (rounds >= 3x slower)',
    loaded,
    `${idleMs} ms idle -> ${busyMs} ms contended (${idleMs > 0 ? (busyMs / idleMs).toFixed(1) : '?'}x)`,
  );
  info('stress: the same rounds while idle', `${framedRounds(text, 'sw', 50, false).good}/50 framed`);
  const c = framedRounds(text, 'st', 50, false);
  const o = framedRounds(text, 'so', 20, true);
  gate('stress: concealed markers frame their output under load (50/50)', loaded && c.good === 50, `${c.good}/50${c.bad.length ? `, e.g. ${c.bad}` : ''}`);
  info('stress: OSC-only markers that framed their output', `${o.good}/20`);
}

async function probeRepaint() {
  let before = '';
  const marks = {};
  const raw = await capture(
    'repaint',
    [
      UTF8_OUT,
      "AthHid '<ATHS:rp1>'; Write-Host 'rp-body-1'; AthHid '<ATHE:rp1:0>'; Write-Host ''",
      "AthHid '<ATHS:rp2>'; Write-Host 'rp-before'; Write-Host 'ATHPROBE-RESIZE-NOW'; Start-Sleep -Seconds 6",
      "Write-Host 'rp-after'; AthHid '<ATHE:rp2:0>'",
      END,
    ].join('\n'),
    {
      during: async (ctx) => {
        await ctx.waitFor(/ATHPROBE-RESIZE-NOW/);
        await sleep(400);
        before = ctx.screen();
        marks.a = ctx.size();
        ctx.resize(140);
        await sleep(1500);
        marks.b = ctx.size();
        ctx.resize(W);
        await sleep(1500);
        marks.c = ctx.size();
      },
    },
  );
  const text = stripCsi(asText(raw));
  info('capture-pane lines carrying concealed marker text', String((before.match(/<ATH[SE]:/g) || []).length));
  const count = (s) => text.split(s).length - 1;
  info('one resize-and-back: completed marker replayed', `${count('<ATHE:rp1:0>')}x (1 = no replay)`);
  info('one resize-and-back: completed output replayed', `${count('rp-body-1')}x`);
  const s = text.indexOf('<ATHS:rp2>');
  const e = text.indexOf('<ATHE:rp2:0>');
  const inside = s >= 0 && e > s ? text.slice(s, e) : '';
  info('mid-command resize: copies of rp-before inside the frame', `${inside.split('rp-before').length - 1} (1 = clean)`);
  info('mid-command resize: start marker copies before the end marker', String(inside.split('<ATHS:rp2>').length - 1));
  if (marks.a !== undefined) {
    info('repaint signature, first resize', escaped(raw.subarray(marks.a, marks.a + 120)));
    info('repaint signature, resize back', escaped(raw.subarray(marks.b, marks.b + 120)));
  }
  gate('repaint: the first start and first end marker still bracket the command', s >= 0 && e > s && text.indexOf('rp-after') > s && text.indexOf('rp-after') < e);
}

async function probeInput(shell, utf8In) {
  const tag = `${shell === 'pwsh' ? 'pwsh' : 'ps51'}-${utf8In ? 'utf8in' : 'defaultin'}`;
  let got = '';
  let psrl = '?';
  await capture(
    `in-${tag}`,
    [
      UTF8_OUT,
      utf8In ? '[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)' : '',
      "Write-Host ('READY PSRL=' + [int][bool](Get-Module PSReadLine) + ' IN=' + [Console]::InputEncoding.WebName)",
    ].join('\n'),
    {
      shell,
      interactive: true,
      during: async (ctx) => {
        if (!(await ctx.waitFor(/READY PSRL=/, 30_000))) return;
        await sleep(800);
        // Hex-encoded by the REMOTE, so only the input path is being judged:
        // the answer comes back as ASCII and output encoding cannot muddy it.
        ctx.keys("Write-Host ('HEX=' + (([Text.Encoding]::UTF8.GetBytes('中文✓') | ForEach-Object { $_.ToString('x2') }) -join ''))");
        ctx.enter();
        await ctx.waitFor(/HEX=[0-9a-f]{4}/, 15_000);
        const t = ctx.read();
        got = (/HEX=([0-9a-f]+)/.exec(t) || [])[1] || '';
        psrl = (/READY PSRL=(\d)/.exec(t) || [])[1] || '?';
        ctx.keys('exit');
        ctx.enter();
        await sleep(1500);
      },
    },
  );
  return { tag, got, psrl };
}

// ---- main ---------------------------------------------------------------------

(async () => {
  const pre = spawnSync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no', host, 'echo %COMSPEC%'],
    { encoding: 'utf8' },
  );
  if (!/cmd\.exe/i.test(pre.stdout || '')) {
    console.error(`conpty-probe: ${host} is not reachable as a Windows host with key auth:\n${(pre.stderr || pre.stdout || '').trim()}`);
    cleanup();
    process.exit(1);
  }
  const hasPwsh = /pwsh/i.test(
    spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no', host, 'where pwsh'], { encoding: 'utf8' }).stdout || '',
  );

  if (want('baseline')) {
    await probeBaseline('powershell');
    if (hasPwsh) await probeBaseline('pwsh');
    else info('pwsh', 'not installed; 5.1 only');
  }
  if (want('order')) await probeOrdering();
  if (want('burst')) await probeBurst();
  if (want('repaint')) await probeRepaint();
  for (const shell of !want('input') ? [] : hasPwsh ? ['powershell', 'pwsh'] : ['powershell']) {
    for (const utf8In of [false, true]) {
      const r = await probeInput(shell, utf8In);
      const line = `${r.got || 'no answer'} (PSReadLine loaded: ${r.psrl})`;
      if (utf8In) gate(`${r.tag}: typed 中文✓ arrives as UTF-8`, r.got === UTF8_HEX, line);
      else info(`${r.tag}: typed 中文✓ arrives as`, r.got === UTF8_HEX ? `UTF-8 ${line}` : line);
    }
  }
  if (want('stress')) await probeStress();

  let pass = 0;
  let fail = 0;
  for (const r of results) {
    if (r.kind === 'info') {
      console.log(`  \x1b[2minfo\x1b[0m ${r.name}: ${r.detail}`);
    } else if (r.ok) {
      pass++;
      console.log(`  \x1b[32mok\x1b[0m   ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
    } else {
      fail++;
      console.log(`  \x1b[31mFAIL\x1b[0m ${r.name}  [${r.detail}]`);
    }
  }
  console.log(`  ── WINDOWS ${host}: passed ${pass}, failed ${fail}`);
  if (keep) console.log(`  raw logs kept in ${work}`);
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(`conpty-probe: ${e.stack || e}`);
  cleanup();
  process.exit(1);
});
