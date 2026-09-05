import * as os from 'node:os';
import { promises as fs, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { ATH_HOME } from './paths';
import { shellQuote } from './util';

export const SSH_CONTROL_DIR = path.join(ATH_HOME, 'ssh');

/**
 * `%C` is a hash of (host, port, user, proxy), so one socket per destination
 * with a fixed-length name. Length matters: a control path is a unix socket,
 * capped near 104 bytes on macOS, and a readable `%r@%h:%p` blows that for
 * long hostnames. This lands around 69.
 */
const CONTROL_PATH = path.join(SSH_CONTROL_DIR, '%C');

/**
 * Options every hub ssh connection gets.
 *
 * These exist so the user never has to prepare a machine before using it, and
 * never has to repeat themselves per host:
 *
 * - `AddKeysToAgent` + `UseKeychain` mean a passphrase is typed once **per
 *   key, ever** — not per host and not per session. The first successful use
 *   stores it; every later connection to any host using that key is silent.
 *   This is the whole reason we pass options here rather than telling someone
 *   to run `ssh-add` for each machine.
 * - `ControlMaster`/`ControlPersist` keep one authenticated connection alive
 *   and share it. A dropped session reconnects instantly over the existing
 *   socket with no authentication at all, which is what makes an agent's
 *   reconnect invisible instead of a fresh password prompt.
 * - `ServerAlive*` notices a dead link in ~90s instead of hanging until TCP
 *   gives up, so a session reports `needs-input`/disconnected while the human
 *   is still around to care.
 *
 * `ATH_SSH_OPTIONS` (space-separated `-o` values) appends to these for anyone
 * who needs something different; nothing here is mandatory.
 */
/** The option values themselves, `Key=value`, without the `-o` flags. */
export function sshOptionValues(): string[] {
  const options = [
    'ControlMaster=auto',
    `ControlPath=${CONTROL_PATH}`,
    'ControlPersist=8h',
    'AddKeysToAgent=yes',
    'ServerAliveInterval=30',
    'ServerAliveCountMax=3',
  ];
  // UseKeychain is macOS-only; passing it elsewhere makes ssh exit with a
  // config error rather than connect.
  if (process.platform === 'darwin') options.push('UseKeychain=yes');

  const extra = (process.env.ATH_SSH_OPTIONS ?? '').trim();
  if (extra) options.push(...extra.split(/\s+/).filter(Boolean));

  return options;
}

export function sshOptions(): string[] {
  return sshOptionValues().flatMap((option) => ['-o', option]);
}

/** The ssh command line to type into a pane, fully quoted. */
export function sshCommandLine(host: string): string {
  const parts = ['ssh', ...sshOptions(), host];
  return parts.map((part) => (/^[-\w=/.@:%]+$/.test(part) ? part : shellQuote(part))).join(' ');
}

/**
 * The ssh line for a session that should come up ALREADY integrated.
 *
 * The remote shell is not set up by typing at it. Everything it needs travels
 * as environment on the ssh command line, so the shell is integrated before it
 * has drawn its first prompt:
 *
 *     ATH_B=<base64> PROMPT_COMMAND=<bootstrap> exec "$SHELL" -i
 *
 * bash inherits `PROMPT_COMMAND` from its environment and runs it before the
 * first prompt. That one fact is what makes this work: the bootstrap decodes
 * the payload, installs the framing hooks, and reports back through the PTY.
 *
 * Three properties follow, and each replaces something that used to be a risk:
 *
 * - **Nothing is typed.** Setup cannot be spliced into a half-read line, and
 *   cannot be typed into a password prompt — the failure the old path courted
 *   every time it slept 400ms and sent the wrapper regardless.
 * - **Nothing is written.** No rcfile, no scratch dir; `--rcfile` was rejected
 *   for exactly that reason. The payload lives in the process environment and
 *   dies with the shell.
 * - **Nothing needs detecting.** A shell that ignores `PROMPT_COMMAND` (zsh,
 *   fish) simply starts normally and never reports back, and the caller uses
 *   the wrapper. Non-bash remotes lose nothing; they behave as they do today.
 *
 * `$SHELL` is expanded on the far side, so the user keeps their login shell.
 * The remote text contains no single quotes — spaces, `"`, `$` and `|` inside
 * the bootstrap are backslash-escaped — which is what lets the whole thing sit
 * inside one single-quoted argument on the line we type locally.
 */
export function sshLaunchLine(host: string, payload: string, bootFile: string): string {
  const b64 = Buffer.from(payload, 'utf8').toString('base64');
  // Every metacharacter is backslash-escaped so the far-side shell stores this
  // as a literal string instead of running it at launch. The parentheses matter
  // as much as the `$`: `\$(` leaves an UNQUOTED `(`, which is a syntax error,
  // not a command substitution deferred to later.
  const boot = 'eval\\ \\"\\$\\(echo\\ \\$ATH_B\\|base64\\ -d\\)\\"';
  const remote = `ATH_B=${b64} PROMPT_COMMAND=${boot} exec "$SHELL" -i`;
  writeFileSync(bootFile, remote, { mode: 0o600 });

  // The remote command is read from a LOCAL file rather than typed.
  //
  // Typed in full this line ran past 1200 characters and spliced — the pane
  // received a fragment, the far side answered `-o: command not found`, and
  // the connection dropped. Keeping what we type short and letting the local
  // shell expand `$(cat …)` moves the bulk out of the terminal entirely: the
  // tty carries ~240 characters, ssh still receives the whole payload as one
  // argument, and the file never leaves this machine.
  // Options live in a config file so the TYPED line stays short.
  //
  // Spelled out, the eight `-o` flags made a 215-character line that wrapped
  // over three rows of the shared console and was redrawn by the shell each
  // time it re-wrapped — so a human attaching saw the same connect command
  // three times before anything useful happened. Nothing about it was
  // informative; it is the same options on every connect, to every host.
  return `ssh -F ${shellQuote(configFile())} -t ${host} "$(cat ${shellQuote(bootFile)})"`;
}

/**
 * Our ssh options as a config file, written next to the control sockets.
 *
 * `Include` comes first and pulls in the user's own config, because ssh takes
 * the FIRST value it obtains for a setting — so their `Host myserver` block still
 * resolves the alias and still wins on anything it sets. Ours are defaults
 * underneath, never overrides. Included only when the file exists: ssh treats a
 * missing include as an error, and a user with no ~/.ssh/config would then be
 * unable to connect at all.
 */
function configFile(): string {
  const file = path.join(SSH_CONTROL_DIR, 'config');
  const userConfig = path.join(os.homedir(), '.ssh', 'config');
  const lines: string[] = [];
  if (existsSync(userConfig)) lines.push(`Include ${userConfig}`, '');
  lines.push('Host *');
  for (const option of sshOptionValues()) {
    const [key, ...rest] = option.split('=');
    lines.push(`  ${key} ${rest.join('=')}`);
  }
  mkdirSync(SSH_CONTROL_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  return file;
}

/**
 * Make sure a DETACHED master exists before a session connects.
 *
 * With `ControlMaster=auto` the first client to arrive becomes the master and
 * carries the shared connection inside its own process. That makes connection
 * sharing a hostage of session lifecycle: `kill`, `gc` and `respawn` all
 * destroy a session's ssh, and if that client happened to be the master, every
 * other user of the link sees "Shared connection to … closed" — including a
 * human standing at a live password prompt. It looks like the session died for
 * no reason.
 *
 * Starting `-M -N -f` first makes the master a process nobody's session owns,
 * so a session's client is always a slave and killing it can only ever end
 * that one session. Best effort: if it fails (host down, auth needed) the
 * session still connects normally and simply becomes the master as before.
 */
export async function ensureMaster(host: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  await ensureControlDir();
  const alive = await run('ssh', [...sshOptions(), '-O', 'check', host])
    .then(() => true)
    .catch(() => false);
  if (alive) return;
  await run('ssh', [...sshOptions(), '-M', '-N', '-f', '-o', 'BatchMode=yes', host]).catch(
    () => undefined,
  );
}

export async function ensureControlDir(): Promise<void> {
  await fs.mkdir(SSH_CONTROL_DIR, { recursive: true, mode: 0o700 });
}

/**
 * Drop any shared connection to a host.
 *
 * A persistent master outlives the session that opened it, which is the point
 * — but it also means a genuinely broken link would be reused. Callers tear
 * one down before giving up on a host.
 */
export async function closeSharedConnection(host: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  await run('ssh', [...sshOptions(), '-O', 'exit', host]).catch(() => undefined);
}

/**
 * Host aliases defined in the user's ~/.ssh/config.
 *
 * Offered as a pick list so creating a remote session is a choice rather than
 * a remembered string. Read-only: the hub supplies its own ssh options and
 * never writes to this file, because the user requires zero per-host setup.
 *
 * Patterns containing wildcards or negations are skipped — `Host *` is a
 * defaults block, not somewhere you can connect to.
 */
export async function configuredHosts(): Promise<string[]> {
  const file = path.join(os.homedir(), '.ssh', 'config');
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }

  const hosts: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^\s*Host\s+(.+?)\s*(?:#.*)?$/i.exec(line);
    if (!match?.[1]) continue;
    for (const alias of match[1].split(/\s+/)) {
      if (!alias || alias.includes('*') || alias.includes('?') || alias.startsWith('!')) continue;
      if (!hosts.includes(alias)) hosts.push(alias);
    }
  }
  return hosts;
}


