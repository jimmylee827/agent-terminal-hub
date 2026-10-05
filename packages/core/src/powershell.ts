/**
 * The PowerShell dialect: how the hub brings up a shell on a Windows host.
 *
 * Windows sshd hands its command to cmd.exe, so the launch is
 * `powershell -EncodedCommand <UTF-16LE base64>` — a form cmd, Windows
 * PowerShell 5.1 and PowerShell 7 all pass through untouched, with nothing to
 * quote. It rides the same boot-file indirection as the POSIX launch, because
 * typing it would splice exactly as a long POSIX line once did.
 *
 * The far side is reached through ConPTY, which re-renders everything instead
 * of relaying it. scripts/conpty-probe.js measures what survives that; this
 * file only uses channels that probe gates on.
 */
import { launchFromBootFile } from './ssh';

/**
 * cmd.exe's command-line ceiling is 8,191 characters, and the encoded launch
 * passes through it. UTF-16LE then base64 costs ~2.67x, which puts the script
 * budget near 3,000 characters — so this stage carries only what must exist
 * before the first prompt.
 */
export const CMD_LINE_MAX = 8191;

/**
 * What runs first on the far side.
 *
 * - **Upgrade to PowerShell 7 when it is installed**, re-running THIS script
 *   there. The script is read back off the process's own command line rather
 *   than encoded twice, which would double a payload that has a hard ceiling.
 *   5.1 then waits, and exits when the human leaves pwsh.
 * - **Force UTF-8, input and output, on both versions.** The reference host
 *   defaults to GB2312 on 5.1 AND on 7: `✓` arrived as a literal `?`, which
 *   is data destroyed rather than mis-encoded. Input was already correct there
 *   (PSReadLine reads keys as Unicode); setting it costs nothing and holds on
 *   a host without PSReadLine.
 * - **Report ready through OSC 777**, never as text: ConPTY transmits escape
 *   sequences out of order with text, which is harmless for a one-shot keyed
 *   by its token, and an OSC never reaches the human's screen.
 *
 * The profile still loads (no -NoProfile): this is a terminal a person shares,
 * and their aliases, prompt and modules are theirs to keep.
 */
export function psLaunchScript(token: string): string {
  return [
    "if ($PSVersionTable.PSVersion.Major -lt 7 -and (Get-Command pwsh -ErrorAction SilentlyContinue)) {",
    "  & pwsh -NoLogo -NoExit -EncodedCommand ([Environment]::CommandLine -split '\\s+')[-1]; exit }",
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = [Console]::OutputEncoding',
    `Write-Host -NoNewline ([char]27 + ']777;ath;<ATHR:${token}:' + (Get-Process -Id $PID).ProcessName + '>' + [char]7)`,
  ].join('\n');
}

/** The command cmd.exe receives. */
export function psRemoteCommand(script: string): string {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const remote = `powershell -NoLogo -NoExit -EncodedCommand ${encoded}`;
  if (remote.length > CMD_LINE_MAX) {
    throw new Error(`PowerShell launch is ${remote.length} characters, over cmd.exe's ${CMD_LINE_MAX}`);
  }
  return remote;
}

export function psLaunchLine(host: string, script: string, bootFile: string): string {
  return launchFromBootFile(host, psRemoteCommand(script), bootFile);
}

/**
 * The first thing ConPTY sends on every session: its win32-input-mode request.
 *
 * Measured on every captured session — both PowerShell versions, every probe —
 * within the first ~100 bytes, before anything the shell prints, and absent
 * from every local session log. It comes from the transport, so the shell, the
 * display language and the auth method cannot change it.
 */
export const CONPTY_HELLO = '\u001b[?9001h';

/**
 * Whether the far side of the LAST launch turned out to be Windows.
 *
 * Judged only in the bytes just after that launch line's echo (found by
 * `anchor`, the boot file's name): ConPTY greets within ~100 bytes of the
 * session's output, plus whatever a password prompt adds. Searching further
 * would misread a person who ssh'd from a POSIX session into a Windows box by
 * hand as the session itself being Windows.
 */
export function conptyAnnounced(log: string, anchor: string, window = 8192): boolean {
  const at = log.lastIndexOf(anchor);
  return at >= 0 && log.slice(at, at + window).includes(CONPTY_HELLO);
}
