#!/usr/bin/env node
//
// Every consumer of a consume-once notice must PUBLISH it.
//
// `pane_width_changed` is deliberately consume-once, so it does not repeat
// forever once you have seen it. That makes every reader of it a potential
// black hole: whoever consumes the notice and does not print it has not
// suppressed a duplicate, it has performed a DELETION. The next caller sees a
// settled baseline and is told nothing, permanently.
//
// This has now been reported five times (rounds G, L, Q, W, Y) and fixed
// twice, because both fixes were aimed at the surface that happened to be in
// the report. Round W fixed `await_human` in MCP. Round Y used the CLI's `ath
// await`, which had the identical hole, and watched four commands say nothing
// after a 200 -> 156 resize.
//
// So stop fixing instances. `poll()` consumes the notice; therefore any
// surface handler that calls `poll()` must mention `paneWidthChanged`, or it
// is eating a signal. That is mechanical, so a script can hold the line where
// my attention plainly does not.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// The notice, and the call that eats it. Adding a second consume-once notice
// here is how the next one of these gets caught before a reviewer finds it.
const NOTICES = [
  {
    consumedBy: /\bpoll\s*\(/,
    published: /paneWidthChanged/,
    // An incidental peek that declares `consumeNotices: false` does not settle
    // the notice, so it is not a black hole — it leaves the signal for whoever
    // reports output next. Declaring it is the point: the flag is a statement
    // that this call was thought about.
    declines: /consumeNotices:\s*false/,
    name: 'pane_width_changed',
  },
];

const SURFACES = [
  ['packages/cli/src/index.ts', 'CLI'],
  ['packages/mcp/src/index.ts', 'MCP'],
];

// Handlers that legitimately never see a width notice, each with a reason.
// A blanket skip list would defeat the point, so these are narrow and named.
const EXEMPT = new Set([
  // Does not poll for a RESULT — it waits for the session to leave the
  // credential wall and reports the outcome. The poll-bearing branch of the
  // same handler is checked like any other.
  'CLI:requests',
]);

/** Pull out `case 'name': { ... }` blocks by brace matching. */
function caseBlocks(src) {
  const out = [];
  const re = /case\s+'([a-z_]+)':\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
    }
    out.push({ name: m[1], body: src.slice(m.index, i) });
  }
  return out;
}

let checked = 0;
const holes = [];

for (const [rel, label] of SURFACES) {
  const src = readFileSync(join(root, rel), 'utf8');
  for (const { name, body } of caseBlocks(src)) {
    for (const notice of NOTICES) {
      if (!notice.consumedBy.test(body)) continue;
      const id = `${label}:${name}`;
      if (EXEMPT.has(id)) continue;
      checked++;
      if (notice.declines?.test(body) && !notice.published.test(body)) continue;
      if (!notice.published.test(body)) {
        holes.push(`${id} calls poll() but never publishes ${notice.name} — it EATS the notice`);
      }
    }
  }
}

if (holes.length) {
  console.error('consume-once notices swallowed:\n');
  for (const h of holes) console.error(`  ${h}`);
  console.error(
    `\n${holes.length} handler(s) consume a notice without publishing it. Whoever consumes\n` +
      'a consume-once notice must publish it, or the signal is deleted rather than shown.\n',
  );
  process.exit(1);
}

console.log(`consumers: ${checked} poll-bearing handler(s), all publish pane_width_changed`);
