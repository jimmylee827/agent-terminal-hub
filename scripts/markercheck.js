#!/usr/bin/env node
//
// An omission marker must OWN its line.
//
// Both cap sites align their cut to a line boundary, and both fall back to an
// arbitrary byte when the head window holds no newline at all — one line longer
// than the window, which is ordinary for `shasum` output or any small
// `max_bytes`. The marker was then welded into the middle of a line:
//
//   …a316643c6d36a61829b51d6d4838736  /System/L[ath: 26238934 bytes omitted…]
//
// The reviewer who hit it was READING, so it merely looked wrong — and then
// named the real cost exactly: "if I had been parsing the poll stream rather
// than reading it, this would have corrupted it silently." A checksum line that
// exists whole in neither half is the same loss the aligned cut already refuses
// to accept; the fallback simply was not held to the same rule.
//
// Driven through a REAL session and a real `poll`, because the defect lives in
// the interaction between the cut and the line length — a unit test on the
// join function would pass while the caller handed it a mid-line head.
//
// A file rather than a `node -e` inside the suite: the nested-quoting sandwich
// that needs has been written wrong five times in scripts/verify.sh.
const { unlinkSync } = require('node:fs');
const path = require('node:path');

const core = require(path.join(__dirname, '..', 'packages', 'core', 'dist', 'index.js'));

// Lines comfortably longer than the smallest head window below, so the
// no-newline fallback is genuinely exercised rather than merely available.
const LINE =
  'printf "%064d  /System/Library/Frameworks/Foundation.framework/Versions/C/Resources/file_%d.txt\\n", i, i';
const CAPS = [200, 400, 4096];

// --selftest: a mid-line marker must be REPORTED, or this proves nothing.
if (process.argv.includes('--selftest')) {
  const judge = (text) => {
    const i = text.indexOf('[ath:');
    return i <= 0 || text[i - 1] === '\n' ? 'ok' : 'spliced';
  };
  const catchesSplice = judge('abc/System/L[ath: 1 bytes omitted]') === 'spliced';
  const passesOwnLine = judge('abc\n[ath: 1 bytes omitted]') === 'ok';
  const ok = catchesSplice && passesOwnLine;
  console.log(
    ok
      ? 'markercheck --selftest: OK — a mid-line marker is a splice, a line-leading one is not'
      : `markercheck --selftest: FAILED splice=${catchesSplice} ownLine=${passesOwnLine}`,
  );
  process.exit(ok ? 0 : 1);
}

(async () => {
  const n = `mk-${process.pid}`;
  const cleanup = [n];
  const out = [];
  try {
    await core.kill(n).catch(() => {});
    await core.create({ name: n, cwd: '/tmp' });
    for (let i = 0; i < 20; i++) {
      const s = await core.get(n).catch(() => null);
      if (s && s.state === 'idle') break;
      await new Promise((r) => setTimeout(r, 400));
    }
    const st = await core.start(n, `awk 'BEGIN{for(i=0;i<2000;i++) ${LINE}}'`);
    await new Promise((r) => setTimeout(r, 2500));

    let seen = 0;
    let spliced = 0;
    for (const maxBytes of CAPS) {
      const r = await core.poll(n, st.handle, 0, maxBytes);
      const text = r.output ?? '';
      const i = text.indexOf('[ath:');
      if (i < 0) continue;
      seen++;
      if (i > 0 && text[i - 1] !== '\n') spliced++;
    }
    // A run that never reached the cap would pass vacuously.
    out.push(seen > 0 ? 'sawMarker' : 'NOMARKER');
    out.push(spliced === 0 ? 'ownLine' : `SPLICED${spliced}`);

    // THE EXPLANATION DECAYS, THE FACTS DO NOT.
    //
    // A reviewer polling a chatty job got "~700 bytes of warning for ~60 bytes
    // of data" every call and concluded "the progress instrument isn't poll" —
    // they left for another session to `wc -l` the output file. A follow loop
    // polls the same session by design, so this is exactly where repetition
    // lands.
    // A SECOND session, because the cap loop above has already spent this
    // session's budget — the first version of this assertion measured the
    // decayed form as if it were the first and reported a hole that was its own
    // ordering.
    const d = `${n}-decay`;
    cleanup.push(d);
    await core.create({ name: d, cwd: '/tmp', creatorPids: [process.pid, process.pid + 1, 991001, 991002] });
    for (let i = 0; i < 20; i++) {
      const sd = await core.get(d).catch(() => null);
      if (sd && sd.state === 'idle') break;
      await new Promise((r) => setTimeout(r, 400));
    }
    const sd = await core.start(d, `awk 'BEGIN{for(i=0;i<2000;i++) ${LINE}}'`);
    await new Promise((r) => setTimeout(r, 2500));
    const markers = [];
    for (let i = 0; i < 3; i++) {
      const r = await core.poll(d, sd.handle, 0, 2048);
      const m = (r.output ?? '').match(/\[ath:[^\]]*\]/);
      if (m) markers.push(m[0]);
    }
    if (markers.length >= 3) {
      out.push(/read them with|durable storage|too much to read/.test(markers[0]) ? 'firstExplains' : 'FIRSTTERSE');
      out.push(markers[2].length < markers[0].length / 2 ? 'laterBrief' : 'LATERSTILLLONG');
      // Both facts must survive the shortening, or this traded noise for a hole.
      out.push(/\d+ bytes omitted/.test(markers[2]) ? 'briefKeepsBytes' : 'BRIEFLOSTBYTES');
      out.push(/since=\d+/.test(markers[2]) ? 'briefKeepsOffset' : 'BRIEFLOSTOFFSET');
    } else {
      out.push(`ONLY${markers.length}MARKERS`);
    }
  } catch (e) {
    out.push(`THREW:${String(e.message).slice(0, 40)}`);
  } finally {
    for (const c of cleanup) await core.kill(c).catch(() => {});
    // Remove this probe's own transcript.
    //
    // `kill` ends the session and LEAVES the log; only `purge --dead` unlinks,
    // and that would take a human's dead sessions with it. The suite's EXIT
    // trap sweeps names it did not start with, but these probes also run
    // standalone — and each standalone run was leaving a 300 KB transcript in
    // the user's ~/.ath/log. A reviewer counted exactly this class of litter
    // and called the directory unbounded; a test harness should not be adding
    // to the pile it is meant to police.
    for (const c of cleanup) {
      for (const suffix of ['.log', '.trim']) {
        try {
          unlinkSync(core.logPath(c).replace(/\.log$/, suffix));
        } catch {
          /* never existed, which is the good case */
        }
      }
    }
  }
  process.stdout.write(out.join(' '));
})();
