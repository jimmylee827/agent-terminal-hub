#!/usr/bin/env node
//
// Capture real PowerShell frames, through the hub, as fixtures for the screen
// reader: scripts/fixtures/conpty-screens.json.
//
//   node scripts/capture-screens.js [--set basic|edges] HOST[=ALIAS] [HOST[=ALIAS]...]
//
// `basic` (default): one of each kind of output. `edges`: what Windows 10's
// ConPTY draws differently, aimed at the pane's own width: lines around one
// and two widths, Chinese meeting the edge at every column, silent commands
// repeated (where it once swapped a reset and a conceal, 3 in 10). A capture
// replaces only that host's frames of that set.
//
// The repository is public, so a frame names its host by ALIAS (e.g. win10),
// and the remote account name, which every prompt path carries, is replaced by
// a placeholder of the SAME length: the frames are screens, and a shorter name
// would move every column after it.
//
// Each frame is stored as the raw bytes from its concealed start marker to the
// next frame's, with the size of the screen it was drawn on and the exact text
// its command prints. Every command here is deterministic, so `expect` is what
// it prints, not what the reader returned. Run against a fresh session and
// again after a screenful, because Windows 10's ConPTY changes how it draws
// once the screen is full. Writes nothing on the host; isolated hub home.
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const setAt = argv.indexOf('--set');
const SET = setAt >= 0 ? argv.splice(setAt, 2)[1] : 'basic';
if (!['basic', 'edges'].includes(SET)) {
  console.error(`unknown set ${SET}: basic or edges`);
  process.exit(2);
}
const targets = argv.map((arg) => {
  const [host, alias] = arg.split('=');
  return { host, alias: alias || host };
});
if (!targets.length) {
  console.error('usage: capture-screens.js HOST[=ALIAS] [HOST[=ALIAS]...]');
  process.exit(2);
}
/** Same length as `name`, so nothing on the screen moves. */
const placeholder = (name) => ('user' + 'x'.repeat(name.length)).slice(0, name.length);
const scrub = (s, user) => (user ? s.split(user).join(placeholder(user)) : s);
const hubHome = fs.mkdtempSync('/tmp/athe2e-');
process.env.ATH_HOME = hubHome;
process.env.ATH_SOCKET = `athcap${process.pid}`;
const CORE = path.join(__dirname, '..', 'packages', 'core', 'dist');
const a = require(path.join(CORE, 'index.js'));
const ssh = require(path.join(CORE, 'ssh.js'));
const OUT = path.join(__dirname, 'fixtures', 'conpty-screens.json');

const wide = 'C:\\x\\' + '深层目录'.repeat(30);
const BASIC = [
  ['native exit, no output', 'cmd /c exit 3', ''],
  ['cmdlet error', 'Get-Item C:\\no\\such\\ath-path', null],
  ['table', "[pscustomobject]@{A='x';B='yy'},[pscustomobject]@{A='zzz';B='w'}", 'A   B\n-   -\nx   yy\nzzz w'],
  ['multi-line, wrapped', 'Write-Output l1\nWrite-Output l2', 'l1\nl2'],
  ['long ASCII line', "'a' * 450", 'a'.repeat(450)],
  ['wide CJK line', "'C:\\x\\' + ('深层目录' * 30)", wide],
  ['exact-width and wrapped lines', "Write-Output ('b' * 200); Write-Output 'c-after'; Write-Output ('d' * 450); Write-Output ('e' * 199); Write-Output 'f-after'",
    ['b'.repeat(200), 'c-after', 'd'.repeat(450), 'e'.repeat(199), 'f-after'].join('\n')],
];

/** Cases at the pane's own edge: `w` columns. */
function edgeCases(w) {
  const out = [];
  for (const n of [w - 2, w - 1, w, w + 1, 2 * w - 1, 2 * w, 2 * w + 1]) {
    out.push([`${n}-column line, then a short one`, `Write-Output ('x' * ${n}); Write-Output 'next'`, 'x'.repeat(n) + '\nnext']);
  }
  for (let k = w - 5; k <= w; k++) {
    out.push([`Chinese after ${k} columns`, `Write-Output (('a' * ${k}) + '中文尾')`, 'a'.repeat(k) + '中文尾']);
  }
  const half = Math.floor(w / 2);
  out.push([`${half} Chinese characters (${2 * half} columns)`, `Write-Output ('中' * ${half})`, '中'.repeat(half)]);
  out.push([`${half + 1} Chinese characters (${2 * half + 2} columns)`, `Write-Output ('中' * ${half + 1})`, '中'.repeat(half + 1)]);
  out.push(['a space at the last column', `Write-Output (('y' * ${w - 1}) + ' z')`, 'y'.repeat(w - 1) + ' z']);
  for (let i = 1; i <= 3; i++) out.push([`silent command ${i}`, 'Get-Date | Out-Null', '']);
  return out;
}

const concealedAt = (raw, i) => {
  let on = false;
  for (const m of raw.slice(Math.max(0, i - 8192), i).matchAll(/\u001b\[([0-9;]*)m/g)) {
    for (const p of (m[1] || '0').split(';')) if (p === '8') on = true; else if (p === '28' || p === '0') on = false;
  }
  return on;
};

(async () => {
  const aliases = targets.map((x) => x.alias);
  const frames = fs.existsSync(OUT)
    ? JSON.parse(fs.readFileSync(OUT, 'utf8')).frames.filter((f) => !(aliases.includes(f.host) && (f.set ?? 'basic') === SET))
    : [];
  for (const { host, alias } of targets) {
    const name = `cap-${host.replace(/[^a-z0-9]/gi, '')}`;
    try {
      await a.create({ name, remote: host });
      const s = await a.get(name);
      const size = { cols: s.paneWidth || 200, rows: s.paneHeight || 50 };
      const build = (await a.run(name, '[Environment]::OSVersion.Version.Build')).output.trim();
      const user = (await a.run(name, '$env:USERNAME')).output.trim();
      for (const phase of ['fresh screen', 'full screen']) {
        if (phase === 'full screen') await a.run(name, '1..80 | ForEach-Object { "filler $_" }', { timeoutMs: 60000 });
        for (const [label, command, expect] of SET === 'edges' ? edgeCases(size.cols) : BASIC) {
          const r = await a.run(name, command, { timeoutMs: 60000 });
          const log = fs.readFileSync(a.logPath(name), 'utf8');
          const sMark = `<ATHS:${r.handle}>`;
          let at = -1;
          for (let i = log.indexOf(sMark); i >= 0; i = log.indexOf(sMark, i + 1)) if (concealedAt(log, i)) { at = i; break; }
          if (at < 0) { console.error(`${host} ${label}: no start marker`); continue; }
          // Windows 11 forwards an OSC ahead of the text written before it, so the
          // frame's position record can arrive BEFORE its start marker.
          const posAt = log.indexOf(`\u001b]777;ath;pos;${r.handle};`);
          const open = Math.min(log.lastIndexOf('\u001b[8m', at), posAt < 0 ? Infinity : posAt);
          const eAt = log.indexOf(`<ATHE:${r.handle}:`, at);
          const next = log.indexOf('<ATHS:', eAt + 1);
          const raw = log.slice(open, next < 0 ? log.length : next + 30);
          const typed = !command.includes('\n') && !/[^\x00-\x7f]/.test(command);
          const truth = expect === null ? r.output : expect;
          frames.push({
            name: `${alias} (build ${build}), ${phase}: ${label}`,
            host: alias,
            set: SET,
            size,
            nonce: r.handle,
            command: typed ? command : null,
            raw: scrub(raw, user),
            // `null`: an error view, whose wording is PowerShell's; recorded as returned, reviewed by eye.
            expect: scrub(truth, user),
            // What the reader made of it, when that was not the truth: kept for
            // review, never taken as expected. Only a documented ambiguity may
            // be marked `knownLimit`, by hand, after that review.
            ...(r.output === truth ? {} : { reads: scrub(r.output, user) }),
          });
          console.log(`${host} ${phase}: ${label} -> ${r.output === truth ? 'matches' : 'DIFFERS'}`);
        }
      }
    } finally {
      await a.kill(name).catch(() => {});
      await ssh.closeSharedConnection(host).catch(() => {});
    }
  }
  require('node:child_process').spawnSync('tmux', ['-L', process.env.ATH_SOCKET, 'kill-server']);
  fs.rmSync(hubHome, { recursive: true, force: true });
  const note =
    'Real ConPTY frames captured through the hub by scripts/capture-screens.js, from Windows 11 and Windows 10 hosts, on a fresh screen and on a full one. ' +
    'raw runs from the frame\'s concealed start marker (its pos record inside) to the next frame\'s. expect is what the command prints; an error view is recorded as returned and reviewed by eye.';
  fs.writeFileSync(OUT, JSON.stringify({ note, frames }, null, 2) + '\n');
  console.log(`${frames.length} frames written to ${path.relative(process.cwd(), OUT)}`);
})();
