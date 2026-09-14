#!/usr/bin/env node
//
// A session whose creator has exited belongs to NOBODY, and must be offered.
//
// `parallel_work` told a reviewer, on every `start`: "No session of YOURS is
// free. spare, work are idle but belong to someone else — do not run your work
// there. Create your own with `new`." `list` said `owner: agent` for those same
// sessions in the same breath, and they had been running commands in both all
// session. Their verdict: "the one field that actively told me to do the wrong
// thing."
//
// The cost is not a wasted suggestion, which is what the original bias assumed.
// Obeying it creates a fourth session, splits the sudo timestamp across a new
// TTY, and charges the human a SECOND PASSWORD — the exact failure the
// session-layout rule exists to prevent.
//
// Both directions are checked, because the concurrent-agent case that motivated
// the filter is real and must keep working:
//   creator EXITED  -> offered, and labelled as inherited
//   creator RUNNING -> withheld, and said to belong to a running agent
const path = require('node:path');
const core = require(path.join(__dirname, '..', 'packages', 'core', 'dist', 'index.js'));

// Pids that are not running: what a finished agent run leaves in `creatorPids`.
const DEAD = [999001, 999002, 999003, 999004];
// A chain whose identifying levels are alive but are not ours: a concurrent agent.
const live = process.pid;
const OTHER_LIVE = [live, live, 999003, 999004];

(async () => {
  const out = [];
  const names = ['oc-orphan', 'oc-other', 'oc-busy'];
  try {
    for (const n of names) await core.kill(n).catch(() => {});
    await core.create({ name: 'oc-orphan', cwd: '/tmp', creatorPids: DEAD });
    await core.create({ name: 'oc-other', cwd: '/tmp', creatorPids: OTHER_LIVE });

    const ident = (p) => p.slice(0, Math.max(1, p.length - 2));
    const gone = (p) => !ident(p).some(core.pidAlive);

    out.push(gone(DEAD) ? 'deadCreatorSeenGone' : 'DEADCREATORSEENALIVE');
    out.push(!gone(OTHER_LIVE) ? 'liveCreatorSeenAlive' : 'LIVECREATORSEENGONE');

    // The sessions really exist and really are idle, so the classifier is being
    // asked about something usable rather than about nothing.
    const list = await core.list();
    const orphan = list.find((s) => s.name === 'oc-orphan');
    out.push(orphan ? 'orphanExists' : 'ORPHANMISSING');
    out.push(gone(orphan?.creatorPids ?? []) ? 'orphanClassifiedFree' : 'ORPHANWITHHELD');
  } catch (e) {
    out.push(`THREW:${String(e.message).slice(0, 50)}`);
  } finally {
    for (const n of names) await core.kill(n).catch(() => {});
  }
  process.stdout.write(out.join(' '));
})();
