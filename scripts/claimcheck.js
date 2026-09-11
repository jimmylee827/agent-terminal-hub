#!/usr/bin/env node
//
// The tool must not claim a person was there when one was not.
//
// A reviewer singled out this hub's refusal to overclaim as the reason they
// extended it trust — and in the same report caught it asserting, of a bare
// `sleep 8`, that a "prompt answered" and that the pane resized "while you were
// at the keyboard". They had resized it themselves with `ath width`, and
// nothing had prompted.
//
// That matters more than a wording nit because `attached_clients` was retired:
// a resize is now the ONLY evidence the docs offer that a human is present. A
// signal that fires on the agent's own actions is worse than no signal.
//
// Both directions are checked. A guard that only proves the quiet case would
// pass just as well if the notice never fired at all.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const core = require(path.join(__dirname, '..', 'packages', 'core', 'dist', 'index.js'));

const settle = async (n) => {
  for (let i = 0; i < 15; i++) {
    const s = await core.get(n).catch(() => null);
    if (s && s.state === 'idle') return;
    await new Promise((r) => setTimeout(r, 600));
  }
};

(async () => {
  const out = [];
  const names = [];
  try {
    // --- a resize WE performed must be marked as ours ---------------------
    {
      const n = `cc-hub-${process.pid}`;
      names.push(n);
      await core.create({ name: n, cwd: '/tmp', width: 140 });
      await settle(n);
      await core.run(n, 'echo ok');
      await core.setWidth(n, 170);
      await new Promise((r) => setTimeout(r, 800));
      const r = await core.run(n, 'echo after');
      out.push(r.paneWidthChanged?.byHub === true ? 'hubResizeMarked' : 'HUBRESIZEUNMARKED');
    }

    // --- a resize we did NOT perform must not be ---------------------------
    // Driven through tmux directly, which is what a client attaching does.
    {
      const n = `cc-ext-${process.pid}`;
      names.push(n);
      await core.create({ name: n, cwd: '/tmp', width: 140 });
      await settle(n);
      await core.run(n, 'echo ok');
      execFileSync('tmux', ['-L', core.SOCKET ?? 'ath', 'resize-window', '-t', `ath-${n}`, '-x', '170']);
      await new Promise((r) => setTimeout(r, 800));
      const r = await core.run(n, 'echo after');
      const w = r.paneWidthChanged;
      // It must still be REPORTED — only the attribution changes.
      out.push(w ? 'externalResizeSeen' : 'EXTERNALRESIZEMISSED');
      out.push(w && !w.byHub ? 'externalNotBlamedOnHub' : 'EXTERNALMISATTRIBUTED');
    }
  } catch (e) {
    out.push(`THREW:${String(e.message).slice(0, 60)}`);
  } finally {
    for (const n of names) await core.kill(n).catch(() => {});
  }
  process.stdout.write(out.join(' '));
})();
