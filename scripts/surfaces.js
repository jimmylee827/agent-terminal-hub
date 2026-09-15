#!/usr/bin/env node
//
// A fact the user can be told must reach BOTH surfaces, or be excused by name.
//
// Roughly three quarters of everything twenty-six rounds of cold review has
// found is one shape: something known on one surface and not carried to the
// other. `parity.js` covers result fields reaching the MCP payload, and
// `consumers.js` covers consume-once notices being published. Neither had an
// opinion about a NEW user-facing message existing on only one surface — which
// is how `log_dir_note` shipped to MCP alone, in the very commit titled "stop
// fixing the width bug one surface at a time". A reviewer found it by grepping
// packages/cli and getting nothing.
//
// The rule here is mechanical and, importantly, RETROACTIVE: any core export
// whose name marks it as user-facing wording (…Note, …ADVICE, …_NOTICE_BYTES,
// and the helpers that feed them) must be referenced by both the CLI and the
// MCP server, or be listed below with a reason. New helpers are caught by
// naming convention rather than by anyone remembering to register them.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const cli = read('packages/cli/src/index.ts');
const mcp = read('packages/mcp/src/index.ts');
const barrel = read('packages/core/src/index.ts');

// Exported names that carry wording a caller is meant to SEE.
const USER_FACING = /^(?:[a-z][A-Za-z]*Note|[A-Z_]*ADVICE|[A-Z_]*NOTICE_BYTES|logDirBytes)$/;

// One-sided on purpose. Each needs a reason, and the reason is the point.
const EXCUSED = new Map([
  [
    'logNearTrimNote',
    'MCP only: the CLI reports a near-trim through its own inline omission ' +
      'marker in the output stream, which is the same fact in the place a ' +
      'terminal reader actually looks.',
  ],
  [
    'inheritedContextNote',
    'MCP only: it qualifies `parallel_work`, which exists because a tool-calling ' +
      'agent cannot see the other sessions on the box. A human running `ath ' +
      'start` is already in a shell and can read its own `pwd` and `env`; the ' +
      'CLI has no parallel-work surface for this to attach to.',
  ],
]);

const names = [];
for (const line of barrel.split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*),\s*$/);
  if (m && USER_FACING.test(m[1])) names.push(m[1]);
}

// --selftest: run the REAL classification over synthetic surfaces.
//
// A first version of this asserted that a name absent from a file reads as
// absent — true by construction, and therefore worthless. That is the same
// "passes without doing anything" failure this whole exercise is about, so it
// now drives the actual rule: one-sided is a hole, two-sided is not.
if (process.argv.includes('--selftest')) {
  const classify = (name, inC, inM) => {
    const c = inC ? `uses ${name} here` : 'nothing';
    const m = inM ? `uses ${name} here` : 'nothing';
    const seenC = new RegExp(`\\b${name}\\b`).test(c);
    const seenM = new RegExp(`\\b${name}\\b`).test(m);
    return seenC && seenM ? 'ok' : 'hole';
  };
  const catchesOneSided = classify('SOME_ADVICE', false, true) === 'hole';
  const passesTwoSided = classify('SOME_ADVICE', true, true) === 'ok';
  const ok = catchesOneSided && passesTwoSided;
  console.log(
    ok
      ? 'surfaces --selftest: OK — a one-sided fact is a hole, a two-sided one is not'
      : `surfaces --selftest: FAILED — oneSided=${catchesOneSided} twoSided=${passesTwoSided}`,
  );
  process.exit(ok ? 0 : 1);
}

const holes = [];
let checked = 0;
for (const n of names) {
  const inCli = new RegExp(`\\b${n}\\b`).test(cli);
  const inMcp = new RegExp(`\\b${n}\\b`).test(mcp);
  if (inCli && inMcp) {
    checked++;
    continue;
  }
  if (EXCUSED.has(n)) {
    checked++;
    continue;
  }
  const has = inCli ? 'CLI' : inMcp ? 'MCP' : 'NEITHER';
  holes.push(
    `${n} reaches ${has} only — a user-facing fact on one surface. Carry it to the ` +
      'other, or add it to EXCUSED with the reason.',
  );
}

if (!names.length) {
  console.error('surfaces: found no user-facing exports to check — the barrel scan is broken.');
  process.exit(1);
}

if (holes.length) {
  console.error('user-facing facts that reach only one surface:\n');
  for (const h of holes) console.error(`  ${h}`);
  console.error('');
  process.exit(1);
}

console.log(`surfaces: ${checked} user-facing fact(s), each on both surfaces or excused by name`);
