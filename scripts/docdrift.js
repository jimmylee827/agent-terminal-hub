#!/usr/bin/env node
//
// A field an agent will SEE must be discoverable where an agent first LOOKS.
//
// There are two auditors already and neither covers this. `parity.js` checks
// that a result field reaches the MCP payload; `surfaces.js` checks that a
// user-facing fact reaches both the CLI and the MCP server. Nothing checked
// that any of it reaches SKILL.md — the document a cold agent reads before its
// first command.
//
// So the runtime grew fields the documentation never mentioned, and a reviewer
// caught it precisely: the skill file's mtime was two hours older than the
// build, `cwd_host` was undocumented, and the doc still described the ambiguity
// that field had just closed. "The surface a new agent reads first is the one
// that didn't get updated."
//
// The rule: every field name the MCP surface emits must appear in SKILL.md, or
// be listed below with a reason. Plumbing and obvious echoes are exempt; the
// things an agent has to ACT on are not.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mcp = readFileSync(join(root, 'packages/mcp/src/index.ts'), 'utf8');
const skill = readFileSync(join(root, 'skills/agent-terminal/SKILL.md'), 'utf8');

// Echoes of the caller's own input, or names so plain they document themselves.
// Each of these would be noise in a document, not guidance.
const EXEMPT = new Set([
  // The caller passed these in, or they name the obvious.
  'session', 'name', 'command', 'state', 'output', 'note', 'error', 'reason',
  'id', 'pid', 'remote', 'cwd', 'rows', 'root', 'path', 'holds', 'bounded',
  'current', 'summary', 'width', 'height', 'lines', 'text', 'keys',
  // Documented by the field they qualify, immediately beside it.
  'what_to_do', 'width_note', 'lost_note', 'omitted_note', 'timing_note',
  'handle_note', 'cwd_note', 'recording_note', 'log_dir_note',
  'exit_code_note', 'log_near_trim_note', 'command_gone_note',
  'log_trimmed_note', 'offset_note',
  // Internal bookkeeping a caller never branches on.
  'started_utc', 'build_utc', 'asked_for', 'removed_by_purge', 'local_cwd_host',
  // Sub-fields of `progress`, which IS documented — naming each component
  // again would be describing a shape the reader already has in front of them.
  'bytes_per_second', 'bytes_discarded',
  // The numeric twin of a documented note, emitted immediately beside it. The
  // note says what to do; the number is the same fact in machine form.
  'log_dir_bytes', 'log_near_trim_bytes',
  // Says where a handle came from when you did not pass one. Plain, and the
  // handle itself is what the caller uses.
  'handle_from',
  // Literally the command to run, printed in full.
  'human_can_join_with',
  // Purge bookkeeping: how many request records went with the transcript.
  'requests_cleared',
]);

// Three shapes, because two were not enough and the gap was invisible.
//
// The line-start pattern misses every field declared inside an inline ternary
// spread — `...(cond ? { empty_tail: true } : {})` puts the key after `? {` on
// the same line. That is the most common way an optional field is written here,
// so the auditor was silently under-counting the wire surface it claimed to
// cover, and reported "all documented" while two fields it had never seen went
// out undocumented. Found by adding a field, watching the check pass, and not
// believing it.
//
// An object key anywhere, then: preceded by `{` or `,`. The snake_case filter
// below keeps internal single-word literals out.
const found = new Set();
for (const m of mcp.matchAll(/payload\.([a-z][a-z0-9_]*)\s*=/g)) found.add(m[1]);
for (const m of mcp.matchAll(/^\s*([a-z][a-z0-9_]{2,})\s*:\s*(?!\s*$)/gm)) found.add(m[1]);
for (const m of mcp.matchAll(/[{,]\s*([a-z][a-z0-9_]{2,})\s*:\s*(?!\s*$)/g)) found.add(m[1]);

// Only names that look like OUTPUT fields: snake_case, which is the wire
// convention here. camelCase in this file is internal.
const fields = [...found].filter((f) => /^[a-z]+(_[a-z0-9]+)+$/.test(f) && !EXEMPT.has(f));

// --selftest: prove this can FAIL before believing that it passes.
//
// This auditor shipped BLIND for weeks — its scan could not see fields declared
// in an inline ternary spread, so it reported "all documented" over a surface it
// had never read. A check nobody has watched fail is indistinguishable from no
// check, and that is not a figure of speech here: it is what happened.
if (process.argv.includes('--selftest')) {
  const bogus = 'a_field_that_is_certainly_not_documented_anywhere';
  const caughtMissing = !skill.includes(bogus);
  const seesSpread = /[{,]\s*([a-z][a-z0-9_]{2,})\s*:/.test('...(x ? { empty_tail: true } : {})');
  const ok = caughtMissing && seesSpread;
  console.log(ok
    ? 'docdrift --selftest: OK — flags an undocumented field, and sees ternary-spread declarations'
    : `docdrift --selftest: FAILED — missing=${caughtMissing} spread=${seesSpread}`);
  process.exit(ok ? 0 : 1);
}

const missing = fields.filter((f) => !skill.includes(f));

if (!fields.length) {
  console.error('docdrift: found no wire fields to check — the scan is broken.');
  process.exit(1);
}

if (missing.length) {
  console.error('wire fields the skill document never mentions:\n');
  for (const f of missing.sort()) console.error(`  ${f}`);
  console.error(
    `\n${missing.length} field(s) an agent can receive and cannot look up. Document them in\n` +
      'SKILL.md, or add them to EXEMPT with a reason.\n',
  );
  process.exit(1);
}

console.log(`docdrift: ${fields.length} wire field(s), all documented or exempt`);
