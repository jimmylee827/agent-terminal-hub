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
const { unlinkSync } = require('node:fs');
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

    // What the adopted session is CARRYING, rather than an instruction to go
    // and find out. `parallel_work` used to say the session "may carry a
    // working directory and exported variables... check with `pwd` and `env`
    // before trusting the context". A reviewer read that, did not check, and
    // discovered by accident at the end of its audit that the session it had
    // adopted still held AUDIT_RUN from a PREVIOUS run of the same task. It
    // escaped damage only by having spelled a literal path instead of using
    // $AUDIT_DIR. The hub records both facts already, so it was asking the
    // agent to discover something it knew.
    const carried = core.inheritedContextNote([
      { name: 'bulk', remote: 'h', remoteCwd: '/tmp/old', remoteEnv: 'AUDIT_RUN=stale-value' },
    ]);
    out.push(/AUDIT_RUN=stale-value/.test(carried) ? 'showsStaleVar' : 'HIDESSTALEVAR');
    out.push(/cwd \/tmp\/old/.test(carried) ? 'showsCwd' : 'HIDESCWD');
    // Absence must not read as "nothing is set": env is harvested for ssh
    // replay, so a LOCAL session has none recorded and must say so rather than
    // list nothing.
    const localCarried = core.inheritedContextNote([{ name: 'l', cwd: '/tmp' }]);
    out.push(/not tracked for local sessions/.test(localCarried) ? 'localSaysUntracked' : 'LOCALSILENT');
    // And a closing clause must not contradict the item it closes.
    const emptyCarried = core.inheritedContextNote([{ name: 'e', remote: 'h', remoteCwd: '/x' }]);
    out.push(/ALREADY SET/.test(emptyCarried) ? 'CLAIMSSETWITHNONE' : 'noFalseSetClaim');
  } catch (e) {
    out.push(`THREW:${String(e.message).slice(0, 50)}`);
  } finally {
    for (const n of names) await core.kill(n).catch(() => {});
    // This probe's own transcripts. `kill` leaves them; only `purge --dead`
    // unlinks, and that would take a human's dead sessions with it.
    for (const n of names) {
      for (const suffix of ['.log', '.trim']) {
        try {
          unlinkSync(core.logPath(n).replace(/\.log$/, suffix));
        } catch {
          /* never existed, which is the good case */
        }
      }
    }
  }
  process.stdout.write(out.join(' '));
})();
