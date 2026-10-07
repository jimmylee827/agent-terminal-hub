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
//   node scripts/conpty-probe.js HOST [--keep] [--only baseline,order,burst,repaint,input,matrix,hub,stress]
//
// Needs key auth (BatchMode — it must never sit at a password prompt). Writes
// nothing on the host but one directory under %TEMP%, removed again; the probe
// scripts travel as -EncodedCommand and are never typed, so they do not reach
// the shell's history either. The stress
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

// Isolate the hub's own code BEFORE anything loads it. paths.js reads ATH_HOME
// once, when first required, so whichever probe loads core first decides where
// every later probe's sessions live — and a probe that loaded it with no
// isolation would point the rest at the user's real ~/.ath. The home is short
// and under /tmp because ssh refuses a control socket path over 104 bytes.
const hubHome = fs.mkdtempSync('/tmp/athe2e-');
process.env.ATH_HOME = hubHome;
process.env.ATH_SOCKET = `athe2e${process.pid}`;
const CORE = path.join(__dirname, '..', 'packages', 'core', 'dist');

const W = 200;
const H = 50;
const UTF8_HEX = 'e4b8ade69687e29c93'; // 中文✓
const UTF8_TEXT = '中文✓ 😀 émoji 👍🏽';

const tmux = (...args) => spawnSync('tmux', ['-u', '-L', SOCK, '-f', '/dev/null', ...args], { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const gate = (name, ok, detail = '') => results.push({ kind: 'gate', name, ok: !!ok, detail });
const info = (name, detail) => results.push({ kind: 'info', name, detail });

function cleanup() {
  tmux('kill-server');
  fs.rmSync(hubHome, { recursive: true, force: true });
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
      // This probe TYPES a line without the hooks, which would otherwise keep
      // it out of the user's history file. Probing must leave no trace there.
      "if (Get-Module PSReadLine) { Set-PSReadLineOption -HistorySaveStyle SaveNothing }",
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
        // No `exit` typed: PSReadLine would save it to the user's history file.
        // capture() ends the session from outside instead.
      },
    },
  );
  return { tag, got, psrl };
}

/**
 * The hub itself against the host: both ways a Windows session comes to exist.
 *
 * Runs in the isolated ATH_HOME and tmux socket set up at the top of this file,
 * so it can never touch a real session.
 */
async function probeHub(hasPwsh) {
  const a = require(path.join(CORE, 'index.js'));
  const ssh = require(path.join(CORE, 'ssh.js'));
  const expectShell = hasPwsh ? 'pwsh' : 'powershell';
  const readyIn = (name) => (/<ATHR:[0-9a-z]+:(pwsh|powershell)>/.exec(fs.readFileSync(a.logPath(name), 'latin1')) || [])[1];
  const run = async (name, command) => {
    try {
      return await a.run(name, command, { timeoutMs: 60_000 });
    } catch (e) {
      return { error: e.code || String(e) };
    }
  };
  const said = (r) => (r.error ? r.error : `exit ${r.exitCode}, ${JSON.stringify(r.output).slice(0, 80)}`);
  try {
    // Key auth: the probe answers over the master, before anything is launched.
    const probed = await a.create({ name: 'e2e-probe', remote: host });
    gate('hub: a key-auth Windows host is recognised before launch', probed.remoteOs === 'windows', `remoteOs=${probed.remoteOs}`);
    gate(`hub: it comes up as PowerShell (${expectShell})`, readyIn('e2e-probe') === expectShell, readyIn('e2e-probe') || 'no ready marker');
    // The hooks rode the launch: the chained prompt opened its first frame —
    // concealed, after the ready marker — and the user's own prompt still drew.
    {
      const psm = require(path.join(CORE, 'powershell.js'));
      for (let i = 0; i < 20 && !/PS [A-Z]:\\[^\r\n]*>/.test(fs.readFileSync(a.logPath('e2e-probe'), 'latin1')); i++) await sleep(500);
      const raw = fs.readFileSync(a.logPath('e2e-probe'), 'latin1');
      const ready = raw.search(/<ATHR:[0-9a-z]+:(pwsh|powershell)>/);
      const first = raw.indexOf('<ATHS:h1>', ready);
      gate('hub: the hooks are live at the first prompt (concealed <ATHS:h1>)', ready >= 0 && first > ready && psm.concealedAt(raw, first), first < 0 ? 'missing' : psm.concealedAt(raw, first) ? '' : 'found, not concealed');
      gate("hub: and the user's own prompt still draws", /PS [A-Z]:\\[^\r\n]*>/.test(raw.slice(Math.max(first, 0))));
    }
    // run, through every path a command can take.
    const histBefore = historyLines();
    // Lines wider than the pane. ConPTY wraps them two ways: streamed, while the
    // screen has room (a wide character that misses the last column leaves a
    // padding cell, written as a space), and with the screen FULL by CRLF and
    // a move back onto the row's last cell. The second turned a 164-character
    // path into two lines, one indented by 198 spaces; every long line late in
    // a session went that way. Each pattern must really occur, or its pass
    // proves nothing.
    {
      const wide = [
        ["'C:\\x\\' + ('深层目录' * 30)", 'C:\\x\\' + '深层目录'.repeat(30)],
        ["'a' * 450", 'a'.repeat(450)],
        ["('中' * 120) + 'END'", '中'.repeat(120) + 'END'],
        ["'ab ' + ('中文' * 120)", 'ab ' + '中文'.repeat(120)],
      ];
      const broken = [];
      const startAt = fs.statSync(a.logPath('e2e-probe')).size;
      let fillerAt = 0;
      for (const phase of ['room on screen', 'screen full']) {
        if (phase === 'screen full') {
          fillerAt = fs.statSync(a.logPath('e2e-probe')).size;
          await run('e2e-probe', '1..80 | ForEach-Object { "filler $_" }');
        }
        for (const [cmd, want] of wide) {
          const r = await run('e2e-probe', cmd);
          const back = await a.readSince('e2e-probe', r.logOffset);
          if (r.output !== want) broken.push(`${phase}: ${cmd} -> ${(r.output || r.error || '').length} chars`);
          else if (!back.output.split('\n').includes(want)) broken.push(`${phase}: ${cmd} via read`);
        }
      }
      gate('hub: lines wider than the pane come back whole, from run and read (8 cases)', broken.length === 0, broken.slice(0, 2).join('; '));
      // Byte offsets, so the log is cut as bytes and decoded after.
      const buf = fs.readFileSync(a.logPath('e2e-probe'));
      const roomy = buf.subarray(startAt, fillerAt).toString('utf8');
      const full = buf.subarray(fillerAt).toString('utf8');
      const width = (await a.get('e2e-probe')).paneWidth;
      const reemit = new RegExp(`\\r\\n(?:\\x1b\\[[0-9;?]*[a-zA-Z])*\\x1b\\[\\d+;(?:${width - 1}|${width})H`);
      gate("hub: and both of ConPTY's wraps really occurred (padding, re-emit)", /[\u4e00-\u9fff] [\u4e00-\u9fff]/.test(roomy) && reemit.test(full), `width ${width}`);
    }
    const native = await run('e2e-probe', 'Write-Output hub-ok; cmd /c exit 3');
    gate('hub: run returns a native exit code and exactly what was printed', native.exitCode === 3 && native.output === 'hub-ok' && !native.captureIncomplete, said(native));
    const multi = await run('e2e-probe', 'Write-Output l1\nWrite-Output l2\ncmd /c exit 5');
    gate('hub: a multi-line command goes through the wrapper', multi.exitCode === 5 && multi.output === 'l1\nl2', said(multi));
    const long = await run('e2e-probe', `Write-Output '${'a'.repeat(700)}'`);
    gate('hub: a long command arrives whole, typed in pieces', long.exitCode === 0 && long.output === 'a'.repeat(700), said(long));
    // Three times: whether ConPTY ends the echo line with a newline or with an
    // absolute move to the next row depends on frame timing, and the second
    // once drew the header over the echo (2 runs in 3 on one evening).
    let table;
    const tables = [];
    for (let i = 0; i < 3; i++) {
      table = await run('e2e-probe', "[pscustomobject]@{A='x';B='yy'},[pscustomobject]@{A='zzz';B='w'}");
      tables.push(table);
    }
    const badTable = tables.find((t) => t.output !== 'A   B\n-   -\nx   yy\nzzz w');
    gate('hub: aligned columns survive ConPTY (3 runs)', !badTable, badTable ? said(badTable) : '');
    const reread = await a.readSince('e2e-probe', table.logOffset);
    gate('hub: read --since shows the same columns, spacing intact', /^x   yy$/m.test(reread.output) && /^zzz w$/m.test(reread.output), JSON.stringify(reread.output).slice(0, 90));
    gate('hub: and no raw control character reaches the reader', !/[\x00-\x08\x0b-\x1f]/.test(reread.output), JSON.stringify((reread.output.match(/[\x00-\x08\x0b-\x1f]/g) || []).slice(0, 5)));
    // PSReadLine's inline predictions draw saved history beside the cursor
    // whenever input arrives in pieces, and ConPTY sends what is drawn: one put
    // a bearer token from the user's history into the transcript. Typing only a
    // prefix is the deterministic form; it must draw nothing but what was typed.
    {
      await run('e2e-probe', "$zq_pred = 'zq-predicted-7f3'");
      const before = fs.statSync(a.logPath('e2e-probe')).size;
      await a.sendKeys('e2e-probe', ['$', 'z', 'q']);
      await sleep(1500);
      const drawn = fs.readFileSync(a.logPath('e2e-probe')).subarray(before).toString('utf8');
      await a.sendKeys('e2e-probe', ['M-F12']);
      await sleep(500);
      const src = await run('e2e-probe', '"$((Get-PSReadLineOption).PredictionSource)"');
      gate('hub: typing draws no history: predictions are off in a hub session', src.output === 'None' && /\$zq/.test(drawn) && !/predicted-7f3/.test(drawn), `PredictionSource=${src.output} drew-history=${/predicted-7f3/.test(drawn)}`);
    }
    await run('e2e-probe', 'Set-Location C:\\Windows');
    const cwd = await run('e2e-probe', '(Get-Location).Path');
    gate('hub: the working directory persists between commands', cwd.output === 'C:\\Windows', said(cwd));
    gate('hub: and the hub records it (what ath ls shows)', (await a.get('e2e-probe')).remoteCwd === 'C:\\Windows', String((await a.get('e2e-probe')).remoteCwd));
    // A background job, followed the way an agent follows one.
    const job = await a.start('e2e-probe', 'Start-Sleep -Seconds 2; Write-Output job-done; cmd /c exit 4').catch((e) => ({ error: e.code || String(e) }));
    gate('hub: start launches a PowerShell job', !job.error && job.launched !== false && /^[0-9a-f]{12}$/.test(job.handle || ''), job.error || `launched=${job.launched}`);
    if (!job.error) {
      gate('hub: latestHandle finds that job', (await a.latestHandle('e2e-probe')) === job.handle);
      let since = job.offset, last, printed = [];
      for (let i = 0; i < 60; i++) {
        last = await a.poll('e2e-probe', job.handle, since);
        if (last.output) printed.push(last.output);
        since = last.nextOffset;
        if (last.done) break;
        await sleep(500);
      }
      gate('hub: poll follows it to its real exit code', last && last.done && last.exitCode === 4, last ? `done=${last.done} exit=${last.exitCode}` : 'no poll');
      gate('hub: and returns what it printed, without the typed echo', printed.join('\n') === 'job-done', JSON.stringify(printed.join('\n')).slice(0, 80));
      const outcome = await a.commandOutcome('e2e-probe', job.handle);
      gate('hub: wait reads the same outcome from the handle', outcome.finished && outcome.exitCode === 4, JSON.stringify(outcome));
    }
    // A resize mid-command — a person attaching, or `width` — makes ConPTY
    // replay the whole screen into the log. Every path that returns output must
    // then give exactly what an undisturbed run gives, or say it cannot
    // (capture_incomplete, with the reason): never a silently different copy.
    // poll used to hand the replay back as new output, lines repeated, beside
    // nothing but a width note. Each resize must really have repainted.
    {
      const psm = require(path.join(CORE, 'powershell.js'));
      const log = () => fs.readFileSync(a.logPath('e2e-probe'));
      const repaintedSince = (at) => psm.psRepainted(log().subarray(at).toString('utf8'));
      const jiggle = async (after) => {
        await sleep(after);
        await a.setWidth('e2e-probe', 150);
        await sleep(700);
        await a.setWidth('e2e-probe', 200);
      };
      const job = '1..10 | ForEach-Object { "row $_"; Start-Sleep -Milliseconds 300 }';
      const base = await run('e2e-probe', job);
      let at = log().length;
      const [resized] = await Promise.all([run('e2e-probe', job), jiggle(1200)]);
      const runHit = repaintedSince(at);
      gate('hub: a resize mid-run: the same output, or capture_incomplete (repainted)', runHit && (resized.output === base.output || (resized.captureIncomplete && resized.captureRepainted)), `repainted=${runHit} same=${resized.output === base.output} flagged=${!!resized.captureRepainted}`);
      at = log().length;
      const bg = await a.start('e2e-probe', job).catch((e) => ({ error: e.code || String(e) }));
      const slices = [];
      let flagged = 0, since = bg.offset, last;
      for (let i = 0; !bg.error && i < 80; i++) {
        if (i === 4) await a.setWidth('e2e-probe', 150);
        if (i === 7) await a.setWidth('e2e-probe', 200);
        last = await a.poll('e2e-probe', bg.handle, since);
        if (last.output) slices.push(last.output);
        if (last.captureRepainted && last.captureIncomplete) flagged++;
        since = last.nextOffset;
        if (last.done) break;
        await sleep(250);
      }
      const pollHit = repaintedSince(at);
      const joined = slices.join('\n');
      gate('hub: and a resize mid-job: poll gives the same output, or flags the slice', !bg.error && pollHit && last && last.done && (joined === base.output || flagged > 0), bg.error || `repainted=${pollHit} same=${joined === base.output} flagged=${flagged}`);
      // The partial path: what a command parked on a prompt returns, and the
      // moment a person is most likely to attach.
      at = log().length;
      const [cut] = await Promise.all([
        a.run('e2e-probe', job, { timeoutMs: 2500 }).catch((e) => ({ error: e.code || String(e) })),
        jiggle(800),
      ]);
      const cutHit = repaintedSince(at);
      gate('hub: and a run that times out after one says so too', cutHit && cut.timedOut === true && cut.captureIncomplete === true && cut.captureRepainted === true, cut.error || `repainted=${cutHit} timedOut=${cut.timedOut} flagged=${!!cut.captureRepainted}`);
      for (let i = 0; i < 40 && cut.handle && !(await a.commandOutcome('e2e-probe', cut.handle)).finished; i++) await sleep(250);
    }
    // What the exit code covers here, as the caveat now says it. A pipeline
    // reports an earlier stage's failure (so it is NOT marked), a failure inside
    // a block run as a command is lost (so it IS), and `&&` — offered on
    // PowerShell 7 — stops at the first failure and reports its code.
    const piped = await run('e2e-probe', 'cmd /c exit 3 | Out-Null');
    gate("hub: a pipeline reports an earlier stage's failure, and is not marked", piped.exitCode === 3 && !piped.exitCodeCovers, `exit ${piped.exitCode}, covers=${piped.exitCodeCovers}`);
    const blocked = await run('e2e-probe', '1 | ForEach-Object { cmd /c exit 4 }');
    gate('hub: a failure inside a { } block is not in the code, and is marked so', blocked.exitCode === 0 && blocked.exitCodeCovers === 'outside-script-blocks-only', `exit ${blocked.exitCode}, covers=${blocked.exitCodeCovers}`);
    if (hasPwsh) {
      const chained = await run('e2e-probe', 'cmd /c exit 3 && Write-Output not-reached');
      gate('hub: && stops at the first failure and reports its code', chained.exitCode === 3 && chained.output === '', said(chained));
    }
    // PowerShell's own prompts must park the command as needs_input, well
    // before the timeout, rather than sit silent until it: each did. Every one
    // is cancelled with Ctrl-C, so nothing is created and nothing is answered.
    {
      const parked = [];
      await run('e2e-probe', "function global:Deploy-AthProbe { param([Parameter(Mandatory, HelpMessage='Which environment')][string]$Target) $Target }");
      for (const [label, cmd] of [
        ['a mandatory parameter left out', 'New-Item -ItemType File'],
        // A help message adds "(Type !? for Help.)" under the header.
        ['one with a help message', 'Deploy-AthProbe'],
        ['-Confirm', 'New-Item -ItemType Directory -Path $env:TEMP\\ath-probe-confirm -Confirm'],
        ['PromptForChoice', "$Host.UI.PromptForChoice('Deploy', 'Proceed?', @('&Yes','&No'), 1)"],
        ['Get-Credential', 'Get-Credential'],
        ['choice.exe', 'choice /C YN /M "Continue"'],
      ]) {
        const t0 = Date.now();
        const r = await a.run('e2e-probe', cmd, { timeoutMs: 20_000 }).catch((e) => ({ error: e.code || String(e) }));
        if (!(r.needsInput === true && Date.now() - t0 < 15_000)) parked.push(`${label}: ${r.error || `state=${r.state}`}`);
        await a.sendKeys('e2e-probe', ['C-c']);
        for (let i = 0; i < 20 && (await a.get('e2e-probe')).state !== 'idle'; i++) await sleep(300);
      }
      const left = await run('e2e-probe', 'Test-Path $env:TEMP\\ath-probe-confirm');
      gate('hub: PowerShell prompts park as needs_input (6 kinds), and Ctrl-C leaves nothing', parked.length === 0 && left.output === 'False', parked.join('; ') || `left=${left.output}`);
    }
    // A dropped link: tear down the shared connection out from under the
    // session, then run. It must reconnect, come back in the same directory
    // with nothing typed to get there, and still report exact exit codes.
    // And the environment: set one, REMOVE one that existed when the shell
    // began, and append to PATH (a long value), all of which must come back.
    const envSet = await run('e2e-probe', "$env:ATH_PROBE_X = 'v1 \"q\" 中文'; Remove-Item env:PROCESSOR_LEVEL; $env:Path += ';C:\\ath-probe-dir'");
    gate('hub: environment changes are made', envSet.exitCode === 0, said(envSet));
    await ssh.closeSharedConnection(host);
    for (let i = 0; i < 20 && (await a.get('e2e-probe')).currentCommand === 'ssh'; i++) await sleep(500);
    const back = await run('e2e-probe', '(Get-Location).Path; cmd /c exit 6');
    gate('hub: after the link drops, run reconnects and says so', back.reconnecting === true, said(back));
    gate('hub: and comes back in the same directory, exit codes intact', back.output === 'C:\\Windows' && back.exitCode === 6, said(back));
    const envBack = await run('e2e-probe', "[string]$env:ATH_PROBE_X + '|' + [string]$env:PROCESSOR_LEVEL + '|' + $env:Path.EndsWith(';C:\\ath-probe-dir')");
    gate('hub: and with its environment: set, removed and PATH all restored', envBack.output === 'v1 "q" 中文||True', said(envBack));
    // A directory too long to ride the relaunch — a path costs about four
    // characters per character on cmd.exe's line, far more outside ASCII — must
    // come back through the wrapper instead. Only meaningful if it really was
    // too long, so that is checked first.
    const deepDir = await run('e2e-probe', "$d = Join-Path $env:TEMP ('ath-probe-' + ('深层目录' * 30)); New-Item -ItemType Directory -Force -Path $d | Out-Null; Set-Location -LiteralPath $d; (Get-Location).Path");
    const deepPath = deepDir.output;
    const carried = require(path.join(CORE, 'powershell.js')).psLaunchCarries('0123456789ab', deepPath || '');
    gate('hub: a deep, non-ASCII directory is too long to ride the relaunch', deepDir.exitCode === 0 && /深层目录/.test(deepPath) && !carried, `${(deepPath || '').length} chars, carried=${carried}`);
    await ssh.closeSharedConnection(host);
    for (let i = 0; i < 20 && (await a.get('e2e-probe')).currentCommand === 'ssh'; i++) await sleep(500);
    const deepBack = await run('e2e-probe', '(Get-Location).Path');
    gate('hub: and still comes back after a reconnect, through the wrapper', deepBack.reconnecting === true && deepBack.output === deepPath, said(deepBack));
    // The reconnect started a new shell, so `$d` is gone: name the path.
    if (/^[^']+$/.test(deepPath || '')) await run('e2e-probe', `Set-Location C:\\Windows; Remove-Item -LiteralPath '${deepPath}' -Force`);
    const histAfter = historyLines();
    gate("hub: nothing the hub typed reached the user's history file", histBefore >= 0 && histAfter === histBefore, `${histBefore} -> ${histAfter} lines`);

    // The password-host route, forced: launch as POSIX onto Windows. cmd.exe
    // rejects the payload and the link closes; the next command must read the
    // ConPTY greeting, relaunch as PowerShell, and then run there.
    await a.create({ name: 'e2e-detect', remote: host, os: 'posix' });
    for (let i = 0; i < 40; i++) {
      if ((await a.get('e2e-detect')).currentCommand !== 'ssh') break;
      await sleep(500);
    }
    const detectRun = await run('e2e-detect', 'Write-Output detect-ok');
    const detected = await a.get('e2e-detect');
    gate('hub: a POSIX launch that lands on Windows is recognised from ConPTY', detected.remoteOs === 'windows', `remoteOs=${detected.remoteOs}`);
    gate('hub: and relaunched as PowerShell', readyIn('e2e-detect') === expectShell, readyIn('e2e-detect') || 'no ready marker');
    gate('hub: and the command then runs there', detectRun.exitCode === 0 && detectRun.output === 'detect-ok', said(detectRun));
  } finally {
    // The deep directory, if a failure left it behind.
    spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no', host,
      `pwsh -NoLogo -NonInteractive -EncodedCommand ${Buffer.from("Get-ChildItem -LiteralPath $env:TEMP -Filter 'ath-probe-*' -Directory | Remove-Item -Recurse -Force", 'utf16le').toString('base64')}`]);
    for (const n of ['e2e-probe', 'e2e-detect']) await a.kill(n).catch(() => undefined);
    await ssh.closeSharedConnection(host).catch(() => undefined);
  }
}

/**
 * The exit-code matrix: the place PowerShell would be quietly wrong.
 *
 * A native command sets `$LASTEXITCODE`; a cmdlet sets only `$?` and may
 * throw instead; and `$LASTEXITCODE` is sticky, so after a failing native
 * command every later failure would report that command's code. Each case
 * below exists for one of those, run IN ORDER (the sticky cases depend on
 * it), through the real hooks from core, on both paths an agent's command can
 * take: typed bare after the tag line, and through the wrapper.
 */
const MATRIX = [
  ['native exit 0', 'cmd /c exit 0', 0],
  ['native exit 3', 'cmd /c exit 3', 3],
  ['cmdlet success', 'Get-Date | Out-Null', 0],
  ['terminating throw', "throw 'boom'", 1],
  ['non-terminating cmdlet error', 'Get-Item C:\\no\\such\\ath-path', 1],
  ['native 7 (makes $LASTEXITCODE sticky)', 'cmd /c exit 7', 7],
  ['then a succeeding cmdlet', 'Get-Date | Out-Null', 0],
  ['then a FAILING cmdlet: 1, not the sticky 7', 'Get-Item C:\\no\\such\\ath-path', 1],
  ['$? false without a throw', "Write-Error 'soft'", 1],
  ['compound, last part a succeeding cmdlet', 'cmd /c exit 3; Get-Date | Out-Null', 0],
  ['compound, last part native', 'Get-Date | Out-Null; cmd /c exit 4', 4],
  ['an assignment', '$athv = 42', 0],
  ['and it persists into the next command', "if ($athv -ne 42) { throw 'lost' }", 0],
  ['a pipeline that yields nothing', "'a','b' | Where-Object { $_ -eq 'c' }", 0],
  ['a syntax error', 'Write-Output )', 1],
];

// `strict`: the whole matrix again with `Set-StrictMode -Version Latest` in force
// before the hooks install, as a profile would set it. Reading a variable that
// does not exist then throws, and the hooks once did: half-installed, every
// later prompt failing, commands never reporting an end.
async function probeMatrix(shell, strict = false) {
  const ps = require(path.join(CORE, 'powershell.js'));
  const tag = (shell === 'pwsh' ? 'pwsh' : 'ps51') + (strict ? '-strict' : '');
  const nonce = () => [...Array(12)].map(() => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  const results = { framed: [], wrapper: [] };
  await capture(
    `matrix-${tag}`,
    // The product's own install line (gzipped), not the raw hooks: the probe tests
    // what ships, and the raw form no longer fits cmd.exe's ceiling.
    // The user's prompt is swapped for one that prints `$?`, standing in for a
    // status-aware prompt (oh-my-posh, starship): after every case it must show
    // the status the hub reports, not the status of the hub's own prompt code.
    [...(strict ? ['Set-StrictMode -Version Latest'] : []), UTF8_OUT, ps.psHooksInstall(), "$global:__ath_prompt0 = { 'PSQ[' + $? + ']> ' }", "Write-Host 'ATHPROBE-READY'"].join('\n'),
    {
      shell,
      interactive: true,
      timeoutMs: 30_000,
      during: async (ctx) => {
        if (!(await ctx.waitFor(/<ATHS:h1>/, 30_000))) return;
        await sleep(500);
        // One command, one way; resolves to its exit code and frame.
        const drive = async (via, command) => {
          const n = nonce();
          const text = command.split('NONCE').join(n);
          if (via === 'framed') {
            ctx.keys(`\u2193\u2193\u2193 AGENT INPUT ID: ${n} \u2193\u2193\u2193`);
            ctx.enter();
            if (!(await ctx.waitFor(new RegExp(`<ATHT:${n}>`), 10_000))) return { err: 'no tag ack' };
            ctx.keys(text);
          } else {
            ctx.keys(`. __ath ${n} ${Buffer.from(text, 'utf8').toString('base64')}`);
          }
          ctx.enter();
          for (const deadline = Date.now() + 20_000; Date.now() < deadline; await sleep(150)) {
            const rc = ps.psFindEnd(ctx.read(), n);
            if (rc !== undefined) {
              await sleep(300);
              // The first prompt drawn after this command's REAL end marker (the
              // forged case prints a plain-text one before it).
              let saw;
              for (const until = Date.now() + 3000; !saw && Date.now() < until; await sleep(150)) {
                const raw = ctx.read();
                let at = raw.indexOf(`<ATHE:${n}:`);
                while (at >= 0 && !ps.concealedAt(raw, at)) at = raw.indexOf(`<ATHE:${n}:`, at + 1);
                saw = at < 0 ? undefined : (/PSQ\[(True|False)\]>/.exec(raw.slice(at)) || [])[1];
              }
              return { rc, saw, frame: ps.psFrame(ctx.read(), n) };
            }
          }
          return { err: 'no end marker' };
        };
        for (const via of ['framed', 'wrapper']) {
          for (const [name, command, want] of MATRIX) results[via].push({ name, want, ...(await drive(via, command)) });
          // The end marker must not be forgeable by the command being measured:
          // this one PRINTS a matching marker as text, then really exits 9.
          results[via].push({ name: 'forged end marker', want: 9, ...(await drive(via, "Write-Host ('<ATHE:'+'NONCE'+':0>'); cmd /c exit 9")) });
          // Output must be fully rendered BEFORE the end marker. Bare objects, no
          // formatter: PowerShell then waits up to 300 ms to measure columns, which
          // is exactly when a marker written meanwhile would overtake the table. An
          // explicit Format-Table renders at once and could not catch it.
          const table = await drive(via, "[pscustomobject]@{Col='tbl-x'},[pscustomobject]@{Col='tbl-y'}");
          results[via].push({ name: 'table', want: 0, ...table });
          results[via].table = table;
        }
        // A syntax error through the wrapper, which parses the whole command first.
        results.syntax = await drive('wrapper', "Write-Output ran-anyway\nif (");
        // Text outside ASCII and outside the BMP, typed key by key and carried as
        // base64: the console defaults to GB2312 here, which turns ✓ into `?`.
        results.utf8 = [await drive('framed', `Write-Output '${UTF8_TEXT}'`), await drive('wrapper', `Write-Output '${UTF8_TEXT}'`)];
        // The history handler, asked directly rather than by typing into the real
        // file: a person's line goes where it always did, a hub line stays in memory.
        results.history = await drive('wrapper', "$f=(Get-PSReadLineOption).AddToHistoryHandler; [string]$f.Invoke('Get-Date') + '|' + [string]$f.Invoke('. __ath x y')");
        // Only the wrapper can carry a command that spans lines.
        results.wrapper.push({ name: 'multi-line command', want: 3, ...(await drive('wrapper', '$a = 1\n$b = 2\ncmd /c exit ($a + $b)')) });
        // No `exit` typed: PSReadLine would save it to the user's history file.
        // capture() ends the session from outside instead.
        results.raw = ctx.read();
      },
    },
  );
  if (strict) {
    const tripped = (results.raw || '').match(/has not been set|VariableIsUndefined|PropertyNotFoundStrict|outside the bounds of the array/);
    gate(`${tag}: strict mode set first trips nothing in the hooks`, !!results.raw && results.raw.includes('<ATHS:') && !tripped, tripped ? tripped[0] : '');
  }
  const h = results.history;
  const said = h && h.frame ? require(path.join(CORE, 'powershell.js')).psClean(h.frame.body) : (h && h.err) || '';
  gate(`${tag}: the history handler keeps a person's line and drops a hub line`, /MemoryAndFile\|MemoryOnly/.test(said), said.slice(0, 80));
  for (const via of ['framed', 'wrapper']) {
    const rows = results[via];
    const wrong = rows.filter((r) => r.rc !== r.want).map((r) => `${r.name}: ${r.err ?? `got ${r.rc}`}, want ${r.want}`);
    gate(`${tag} ${via}: every exit code exact (${rows.length} cases)`, rows.length > 0 && wrong.length === 0, wrong.length ? wrong.slice(0, 3).join('; ') : `${rows.length}/${rows.length}`);
    const t = results[via].table;
    gate(`${tag} ${via}: a table is fully rendered before the end marker`, !!t && !!t.frame && t.frame.body.includes('tbl-y'), t && t.err ? t.err : '');
    const blind = rows.filter((r) => !r.err && r.saw !== (r.rc === 0 ? 'True' : 'False')).map((r) => `${r.name}: exit ${r.rc}, prompt saw ${r.saw}`);
    gate(`${tag} ${via}: the user's prompt sees the status the hub reports`, rows.some((r) => r.saw) && blind.length === 0, blind.length ? blind.slice(0, 3).join('; ') : '');
  }
  const [u8typed, u8wrapped] = results.utf8 || [];
  // The capture is read one byte per character; this check needs the text.
  const u8 = (r, cmd) =>
    r && r.frame
      ? require(path.join(CORE, 'powershell.js')).psClean(Buffer.from(r.frame.body, 'latin1').toString('utf8'), cmd)
      : (r && r.err) || '';
  const u8got = [u8(u8typed, `Write-Output '${UTF8_TEXT}'`), u8(u8wrapped)];
  gate(`${tag}: 中文✓, emoji and accents arrive intact, typed and wrapped`, u8got.every((o) => o === UTF8_TEXT), JSON.stringify(u8got).slice(0, 100));
  const sx = results.syntax;
  const sxOut = sx && sx.frame ? require(path.join(CORE, 'powershell.js')).psClean(sx.frame.body) : (sx && sx.err) || '';
  gate(`${tag}: a wrapped syntax error names the agent's line, and nothing ran`, !!sx && sx.rc === 1 && /\bif \(/.test(sxOut) && /Missing/.test(sxOut) && !/__ath|Create|MethodInvocation|ran-anyway/.test(sxOut), JSON.stringify(sxOut).slice(0, 100));
}

/** Lines in the user's PSReadLine history file, read without typing anything. */
function historyLines() {
  const script = '(Get-Content (Get-PSReadLineOption).HistorySavePath).Count';
  const out = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'RemoteCommand=none', '-o', 'RequestTTY=no', host,
    `pwsh -NoLogo -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`], { encoding: 'utf8' });
  return Number(((out.stdout || '').match(/^(\d+)\s*$/m) || [])[1] ?? -1);
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

  // The whole run, not one probe: a leak once came from a probe that no
  // per-probe count was watching (it typed `exit`, which is a person's line).
  const historyAtStart = historyLines();
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
  if (want('matrix')) {
    for (const shell of hasPwsh ? ['powershell', 'pwsh'] : ['powershell']) {
      await probeMatrix(shell);
      await probeMatrix(shell, true);
    }
  }
  if (want('hub')) await probeHub(hasPwsh);
  if (want('stress')) await probeStress();
  const historyAtEnd = historyLines();
  gate("the whole run left the user's history file untouched", historyAtStart >= 0 && historyAtEnd === historyAtStart, `${historyAtStart} -> ${historyAtEnd} lines`);

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
