// A literal tab inside a quoted pattern must reach the shell.
// In a real TTY a tab is a completion keystroke, so before the fix it vanished
// and the command silently matched nothing while exiting 0.
const c = require(require('path').join(__dirname, '..', 'packages/core/dist/index.js'));
(async () => {
  const name = 'tabck';
  try {
    await c.create({ name, cwd: '/tmp' });
    for (let i = 0; i < 12; i++) {
      const s = await c.get(name).catch(() => null);
      if (s && s.state === 'idle') break;
      await new Promise((r) => setTimeout(r, 700));
    }
    const TAB = '\t';
    const cmd = `printf 'a${TAB}b\\n' | grep -c '${TAB}'`;
    const r = await c.run(name, cmd, { timeoutMs: 20000 });
    process.stdout.write((r.output || '').trim() === '1' ? 'yes' : 'no');
  } catch {
    process.stdout.write('no');
  } finally {
    await c.kill('tabck').catch(() => {});
  }
})();
