#!/usr/bin/env node
//
// A sentence that exists ONCE cannot diverge.
//
// Counting 38 rounds of cold-agent findings, one class outnumbers every other by
// two to one: the same fact known on one surface and not carried to the other.
// `empty_tail` fixed in MCP and not the CLI. The width notice published by
// `await_human` and not by `ath await`. The trim claim made at three sites and
// fixed at one. `log_dir_note` on MCP alone. The exit-code caveat that had NEVER
// appeared in CLI text mode in twenty-seven rounds. `last_exit_code` qualified
// on two surfaces out of four.
//
// `surfaces.js` was written for exactly this and cannot see it. It matches core
// EXPORT NAMES, and the actual failure is writing a new sentence straight into a
// surface file — which creates no export, so there is nothing to check. 321 such
// sentences exist today. The auditor is blind to all of them.
//
// So stop detecting it and make it unrepresentable: user-facing text lives in
// core, once, and the surfaces reference it. The pattern already works —
// EMPTY_TAIL_ADVICE, trimProspect(), logNearTrimNote() — and not one of them has
// diverged since it was unified.
//
// A RATCHET, NOT A MIGRATION. Rewriting 321 strings in one go is the kind of
// project that does not finish. Instead: record today's counts, and fail if they
// rise. New divergence becomes impossible immediately, and the debt burns down
// whenever a file is touched for some other reason. The numbers below may only
// ever go DOWN.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Where prose must not accumulate. These are the two surfaces an agent reads,
// and the two that have diverged from each other eighteen times.
const SURFACES = [
  'packages/cli/src/index.ts',
  'packages/mcp/src/index.ts',
];

const BASELINE_FILE = join(root, 'scripts', 'prose-baseline.json');

/**
 * Sentence-shaped string literals, comments stripped.
 *
 * A sentence is 45+ characters containing a space-then-lowercase — long enough
 * to be prose rather than an identifier, a path, or a tmux flag. Deliberately
 * the same rule `docdrift` learned the hard way: count what is EMITTED, and do
 * not be fooled by the comments explaining it.
 */
export function countProse(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  let n = 0;
  for (const m of code.matchAll(/([`"'])((?:[^\\\n]|\\.)*?)\1/g)) {
    const body = m[2];
    if (body.length < 45) continue;
    if (!/ [a-z]/.test(body)) continue;
    n++;
  }
  return n;
}

const counts = {};
for (const rel of SURFACES) counts[rel] = countProse(readFileSync(join(root, rel), 'utf8'));

// ---- second invariant: assertions must not grep PROSE out of source --------
//
// A message is a runtime value. Matching it against the SOURCE means matching
// against whatever the formatter did to it, and a phrase that wraps across two
// lines silently stops matching. That has broken assertions in verify.sh more
// often than any other single mistake — five times at least, each one costing a
// confused re-run.
//
// The fix has existed since it was first written down: assert the RENDERED
// string from the built code (see the TRIMRENDER and TRIMA probes). This
// ratchets the remaining ones so no new prose-grep can be added.
const verify = readFileSync(join(root, 'scripts', 'verify.sh'), 'utf8');
let proseGreps = 0;
for (const m of verify.matchAll(/grep -[qc]+ .([^'"]{30,}). "\$RP\/packages\/[^"]*src\//g)) {
  const pat = m[1];
  const words = pat.trim().split(/\s+/).length;
  const looksLikeCode = /[(){}=>;.[\]$]/.test(pat);
  if (words >= 5 && !looksLikeCode) proseGreps++;
}
counts['scripts/verify.sh (prose greps)'] = proseGreps;


if (process.argv.includes('--record')) {
  writeFileSync(BASELINE_FILE, `${JSON.stringify(counts, null, 2)}\n`);
  console.log('prose: baseline recorded');
  for (const [k, v] of Object.entries(counts)) console.log(`  ${String(v).padStart(4)}  ${k}`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
} catch {
  console.error('prose: no baseline. Run with --record once, then commit it.');
  process.exit(1);
}

// --selftest: prove the ratchet can FAIL before trusting that it passes.
//
// Three auditors in this directory could not be made to fail, and one of them
// shipped blind for weeks as a result. A check nobody has watched fail is
// indistinguishable from no check.
if (process.argv.includes('--selftest')) {
  const sample = readFileSync(join(root, SURFACES[0]), 'utf8');
  const before = countProse(sample);
  const after = countProse(
    `${sample}\nconst x = 'a newly authored sentence written straight into a surface file';\n`,
  );
  const ok = after === before + 1;
  console.log(
    ok
      ? `prose --selftest: OK — adding one surface sentence moved the count ${before} -> ${after}`
      : `prose --selftest: FAILED — the counter did not notice a new sentence (${before} -> ${after})`,
  );
  process.exit(ok ? 0 : 1);
}

const risen = [];
const fell = [];
const unbaselined = [];
for (const [rel, n] of Object.entries(counts)) {
  const was = baseline[rel];
  if (was === undefined) {
    // NEVER skip silently. Placing this invariant after `--record` meant it was
    // absent from the baseline, and this loop skipped it — so the ratchet I had
    // just written to catch blind checks was itself blind, for one run, exactly
    // like `docdrift`. An unknown key is now a failure, not a shrug.
    unbaselined.push(rel);
    continue;
  }
  if (n > was) risen.push(`${rel}: ${was} -> ${n}`);
  if (n < was) fell.push(`${rel}: ${was} -> ${n}`);
}

if (unbaselined.length) {
  console.error('prose: these invariants are not in the baseline, so they check nothing:\n');
  for (const u of unbaselined) console.error(`  ${u}`);
  console.error('\nRun --record once so they have a number to hold.\n');
  process.exit(1);
}

if (risen.length) {
  console.error('prose: user-facing sentences INCREASED in a surface layer:\n');
  for (const r of risen) console.error(`  ${r}`);
  console.error(
    '\nA sentence written into a surface is a sentence that can diverge from the other\n' +
      'surface — the single most common defect in this project. Put the text in core and\n' +
      'have both surfaces reference it (see EMPTY_TAIL_ADVICE, trimProspect,\n' +
      'logNearTrimNote), or lower the baseline deliberately with --record and say why.\n',
  );
  process.exit(1);
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(
  `prose: ${total} surface sentence(s), at or below baseline` +
    (fell.length ? ` — down: ${fell.join(', ')}` : ''),
);
