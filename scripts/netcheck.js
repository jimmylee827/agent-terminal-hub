#!/usr/bin/env node
//
// Does the LAN-mismatch warning fire precisely?
//
// Presence is easy and worthless; precision is the whole question. A warning
// that fires on every address is the noise earlier rounds complained about, and
// one that fires on none is the prose-only guardrail a reviewer nearly walked
// past. So this drives `run` against THIS machine's real interfaces and asserts
// both directions.
//
// A file rather than a `node -e` inside the suite: the nested-quoting sandwich
// that needs has now been written wrong five times in scripts/verify.sh, which
// is four more than it is worth. Extracting it is the standing fix.
const os = require('node:os');
const path = require('node:path');

const core = require(path.join(__dirname, '..', 'packages', 'core', 'dist', 'index.js'));

const addrs = [];
for (const list of Object.values(os.networkInterfaces())) {
  for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) addrs.push(i.address);
}

// An RFC1918 address this host is definitely NOT on, whatever network it is on.
const off = addrs.some((a) => a.startsWith('10.')) ? '192.168.231.7' : '10.231.7.9';

const NAME = 'nbt';

(async () => {
  const out = [];
  try {
    await core.kill(NAME).catch(() => {});
    await core.create({ name: NAME, cwd: '/tmp' });
    for (let i = 0; i < 12; i++) {
      const s = await core.get(NAME).catch(() => null);
      if (s && s.state === 'idle') break;
      await new Promise((r) => setTimeout(r, 700));
    }
    // `echo` so nothing actually probes anything — the warning is computed from
    // the command TEXT, and a test that really reached out would be a different
    // and much slower test.
    const warns = async (cmd) => {
      const r = await core.run(NAME, `echo ${cmd}`);
      return /private address on a network/.test(r.warning || '');
    };
    out.push((await warns(`nc-z-${off}-22`)) ? 'offSubnetWarns' : 'OFFSUBNETSILENT');
    out.push((await warns('ping-8.8.8.8')) ? 'PUBLICWARNS' : 'publicQuiet');
    // 100.64.0.0/10 is CGNAT — the range Tailscale and similar use. Not RFC1918,
    // so it must never warn: a VPN address is exactly the RIGHT way to reach a
    // host on another network, and warning about it would punish the fix.
    out.push((await warns('curl-100.100.100.100')) ? 'CGNATWARNS' : 'cgnatQuiet');
    out.push((await warns('hello-world')) ? 'NOIPWARNS' : 'noIpQuiet');
    // The address this machine IS on must never warn, or the check is just
    // "does the command contain an IP".
    if (addrs.length) {
      out.push((await warns(`ssh-${addrs[0]}`)) ? 'OWNADDRWARNS' : 'ownAddrQuiet');
    }
  } finally {
    await core.kill(NAME).catch(() => {});
  }
  process.stdout.write(out.join(' '));
})();
