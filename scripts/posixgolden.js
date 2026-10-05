#!/usr/bin/env node
//
// The POSIX shell protocol, pinned byte for byte.
//
// Everything the hub types into a POSIX shell — the wrapper, the framing hooks,
// the probe, the tag line, the ssh launch payload — is shell source assembled
// from TypeScript template literals, and `frameHooksFor` finds its two halves
// by SLICING one of them on literal text. A one-character rename once shipped a
// truncated hook to a live host. The behavioural checks catch a hook that
// breaks; nothing caught one that merely changed.
//
// Pinned when that text moved out of paths.ts into a dialect, so that "a pure
// move" became a checked fact rather than a reviewer's hope. It stays, because
// a second (PowerShell) dialect now lands beside this text, and the one thing
// that work must never do is alter what a POSIX shell receives.
//
// Both routes are checked: the dialect, and the names paths.ts still exports.
// They must agree with the fixture AND with each other.
//
//   node scripts/posixgolden.js             compare against the fixture
//   node scripts/posixgolden.js --write     regenerate after an INTENDED change
//   node scripts/posixgolden.js --selftest  prove a one-byte change is reported
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Before the first require: paths.js reads ATH_HOME when it loads.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'athgold-'));
process.env.ATH_HOME = home;

const dist = path.join(__dirname, '..', 'packages', 'core', 'dist');
const paths = require(path.join(dist, 'paths.js'));
const { posixDialect: d } = require(path.join(dist, 'dialect.js'));

const FIXTURE = path.join(__dirname, 'fixtures', 'posix-protocol.json');
const T = '0123456789ab';
const N = 'deadbeefcafe';

/** Every observed value, as [fixture key, which route produced it, value]. */
async function observe() {
  await paths.ensureLayout();
  const norm = (s) => s.split(home).join('<ATH_HOME>');
  const payload = d.launchPayload(T);
  return [
    ['token', 'fixed', T],
    ['nonce', 'fixed', N],
    ['helperOneline', 'dialect', d.helperOneline()],
    ['helperOneline', 'paths', paths.HELPER_ONELINE],
    ['hooksZsh', 'dialect', d.frameHooks('zsh', T)],
    ['hooksZsh', 'paths', paths.frameHooksFor('zsh', T)],
    ['hooksBash', 'dialect', d.frameHooks('bash', T)],
    ['hooksBash', 'paths', paths.frameHooksFor('bash', T)],
    ['probeLine', 'dialect', d.probeLine(T)],
    ['probeLine', 'paths', paths.shellProbeLine(T)],
    ['tagLine', 'dialect', d.tagLine(N)],
    ['tagLine', 'paths', paths.agentTagLine(N)],
    ['launchPayload', 'dialect', payload],
    ['launchLine', 'dialect', norm(d.launchLine('examplehost', payload, path.join(home, 'rc', 'golden.boot')))],
    ['ackLine', 'dialect', d.ackLine(T)],
    ['depthBaseline0', 'dialect', d.depthBaseline(0)],
    ['depthBaseline1', 'dialect', d.depthBaseline(1)],
    ['depthBaseline3', 'dialect', d.depthBaseline(3)],
    ['helperFile', 'ensureLayout', fs.readFileSync(paths.HELPER_PATH, 'utf8')],
  ];
}

/** Where two strings first differ, with enough context to see why. */
function firstDiff(want, got) {
  let i = 0;
  while (i < want.length && i < got.length && want[i] === got[i]) i++;
  const at = (s) => JSON.stringify(s.slice(Math.max(0, i - 20), i + 20));
  return `byte ${i}: want …${at(want)}… got …${at(got)}…`;
}

function compare(observed, fixture) {
  const problems = [];
  const keys = new Set(observed.map(([k]) => k));
  for (const k of Object.keys(fixture)) if (!keys.has(k)) problems.push(`${k}: in the fixture, never observed`);
  for (const [k, route, value] of observed) {
    if (!(k in fixture)) problems.push(`${k} (${route}): observed, missing from the fixture`);
    else if (value !== fixture[k]) problems.push(`${k} (${route}): ${firstDiff(fixture[k], value)}`);
  }
  return problems;
}

(async () => {
  const observed = await observe();
  let code = 0;

  if (process.argv.includes('--selftest')) {
    // Judged against the observed values themselves, so this proves the
    // comparison works whatever state the committed fixture is in.
    const self = Object.fromEntries(observed.map(([k, , v]) => [k, v]));
    const clean = compare(observed, self);
    const flipped = { ...self, hooksBash: `${self.hooksBash.slice(0, -1)}X` };
    const caught = compare(observed, flipped).some((p) => p.startsWith('hooksBash'));
    const ok = clean.length === 0 && caught;
    console.log(
      ok
        ? 'posixgolden --selftest: OK — identical text passes, a one-byte change is reported'
        : `posixgolden --selftest: FAILED clean=${clean.length} caught=${caught}`,
    );
    code = ok ? 0 : 1;
  } else if (process.argv.includes('--write')) {
    // Two routes disagreeing is never something to record.
    const fixture = {};
    for (const [k, route, v] of observed) {
      if (k in fixture && fixture[k] !== v) {
        console.error(`posixgolden: ${k} differs between routes (${route}) — not writing`);
        code = 1;
      }
      fixture[k] = v;
    }
    if (code === 0) {
      fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
      fs.writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
      console.log(`posixgolden: wrote ${Object.keys(fixture).length} entries to ${FIXTURE}`);
    }
  } else {
    const problems = compare(observed, JSON.parse(fs.readFileSync(FIXTURE, 'utf8')));
    if (problems.length) {
      console.error('posixgolden: the POSIX protocol text CHANGED:');
      for (const p of problems) console.error(`  ${p}`);
      console.error('If that was intended, regenerate with: node scripts/posixgolden.js --write');
      code = 1;
    } else {
      console.log(`posixgolden: ${observed.length} values byte-identical to the fixture`);
    }
  }

  fs.rmSync(home, { recursive: true, force: true });
  process.exit(code);
})().catch((e) => {
  fs.rmSync(home, { recursive: true, force: true });
  console.error(`posixgolden: ${e.stack || e}`);
  process.exit(1);
});
