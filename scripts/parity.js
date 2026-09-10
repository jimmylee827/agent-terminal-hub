#!/usr/bin/env node
/**
 * Surface parity: every result field must reach every surface that should
 * carry it, or be listed here as a deliberate omission with a reason.
 *
 * Three quarters of everything fourteen cold reviewers found was this one
 * shape — a fact known in one place and not carried to another. `exit_code_covers`
 * on `run` but not `poll`. `asked_for_you` in the CLI table but not the MCP
 * listing. `omitted_bytes` in the CLI and not MCP. `max_bytes` in the handler
 * and not the schema. `launched` only when false. `fallback_shell` invisible on
 * the surface the docs tell agents to prefer.
 *
 * None of those needed an agent to find. They needed this file.
 *
 * The EXPECTED_OMISSIONS list is the important half: it forces a deliberate
 * choice to be written down, so the next reader can tell an omission from an
 * oversight. That distinction is exactly what was missing every time.
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const types = fs.readFileSync(path.join(root, 'packages/core/src/types.ts'), 'utf8');
const mcp = fs.readFileSync(path.join(root, 'packages/mcp/src/index.ts'), 'utf8');

const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** Field -> why the MCP payload deliberately does not carry it. */
const EXPECTED_OMISSIONS = {
  'RunResult.session': 'echoed at the top of the payload already',
  'RunResult.command': 'the caller just sent it; echoing costs tokens for nothing',
  'PollResult.session': 'echoed at the top of the payload already',
  'PollResult.handle': 'the caller passed it in',
  'StartResult.session': 'echoed at the top of the payload already',
  'StartResult.command': 'the caller just sent it',
  'StartResult.offset': 'published as next_offset, which is the name every other tool uses',
};

function fieldsOf(iface) {
  const i = types.indexOf(`export interface ${iface} {`);
  if (i < 0) return [];
  let depth = 0;
  let j = types.indexOf('{', i);
  let k = j;
  for (; k < types.length; k++) {
    if (types[k] === '{') depth++;
    else if (types[k] === '}') { depth--; if (!depth) break; }
  }
  return [...types.slice(j, k).matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((m) => m[1]);
}

function payloadFor(tool) {
  const i = mcp.indexOf(`case '${tool}':`);
  if (i < 0) return '';
  const j = mcp.indexOf("case '", i + 10);
  return mcp.slice(i, j < 0 ? mcp.length : j);
}

/**
 * Every result type paired with the tool that publishes it.
 *
 * This listed run, poll and start and nothing else, so `wait` was a blind spot:
 * it published `exit_code` with no `exit_code_covers` beside it, and a reviewer
 * whose command ended in `echo DONE` was handed an exit 0 belonging to the
 * echo. They said the field was "more reassuring than it is entitled to be",
 * and they were right — and this checker, written to catch exactly that shape,
 * never looked.
 *
 * The coverage list IS the checker. A tool missing from here is not checked,
 * and nothing says so, which is the same failure the EXPECTED_OMISSIONS list
 * exists to prevent one level down.
 */
const CHECKS = [
  ['RunResult', 'run'],
  ['PollResult', 'poll'],
  ['StartResult', 'start'],
];

/**
 * Tools whose payload is hand-built from a session rather than a result type,
 * with the fields they must carry when the underlying data exists.
 */
const HAND_BUILT = [
  ['wait', ['exit_code', 'exit_code_covers', 'verified', 'last_command']],
  ['poll', ['progress']],
  ['read', ['next_offset', 'omitted_bytes', 'lost_bytes']],
];

let bad = 0;
let ok = 0;
for (const [iface, tool] of CHECKS) {
  const seg = payloadFor(tool);
  for (const f of fieldsOf(iface)) {
    const key = `${iface}.${f}`;
    const wire = snake(f);
    const present = seg.includes(`${wire}:`) || seg.includes(`.${f}`);
    if (present) { ok++; continue; }
    if (EXPECTED_OMISSIONS[key]) { ok++; continue; }
    console.log(`  MISSING  ${tool} does not emit ${wire}  (${key})`);
    bad++;
  }
}
for (const [tool, fields] of HAND_BUILT) {
  const seg = payloadFor(tool);
  for (const f of fields) {
    if (seg.includes(`${f}:`) || seg.includes(`${f} =`)) { ok++; continue; }
    console.log(`  MISSING  ${tool} does not emit ${f}  (hand-built payload)`);
    bad++;
  }
}

console.log(`parity: ${ok} carried or deliberately omitted, ${bad} missing`);
process.exit(bad === 0 ? 0 : 1);
