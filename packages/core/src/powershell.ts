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
 * - **Install the hooks** (`psHooksScript`) before the first prompt. Carried
 *   here rather than typed afterwards: typed, they would echo into the shared
 *   pane AND be saved to PSReadLine's history file on someone else's disk.
 * - **Report ready through OSC 777**, never as text: ConPTY transmits escape
 *   sequences out of order with text, which is harmless for a one-shot keyed
 *   by its token, and an OSC never reaches the human's screen.
 *
 * The profile still loads (no -NoProfile): this is a terminal a person shares,
 * and their aliases, prompt and modules are theirs to keep. It loads BEFORE
 * this script, which is what lets the hooks chain the prompt it defined.
 */
export function psLaunchScript(token: string): string {
  return [
    "if ($PSVersionTable.PSVersion.Major -lt 7 -and (Get-Command pwsh -ErrorAction SilentlyContinue)) {",
    "  & pwsh -NoLogo -NoExit -EncodedCommand ([Environment]::CommandLine -split '\\s+')[-1]; exit }",
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = [Console]::OutputEncoding',
    psHooksScript(),
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

// ---- the protocol inside PowerShell ------------------------------------------
//
// ConPTY strips the \x1e sentinel, never sends text that was written and then
// erased, and lets escape sequences overtake text. So the POSIX markers cannot
// travel here, and two channels replace them, each used only for what the
// harness gates on:
//
//   ordered  concealed text (SGR 8): `<ATHS:n>` and `<ATHE:n:rc>`. Rendered
//            into the same buffer as the output, so it cannot overtake it.
//   keyed    OSC 777: the tag acknowledgement and other one-shots, whose order
//            relative to text does not matter because each names its nonce.

/**
 * The hooks, installed once per shell.
 *
 * - **`prompt` is CHAINED, never replaced.** The user's prompt is captured the
 *   first time and called last, so their prompt, colours and modules survive —
 *   the PowerShell form of "hooks are added, never assigned".
 * - **`$?` is read as the prompt's first statement**, which is the only place
 *   it still describes the command that just ran.
 * - **`$LASTEXITCODE` is sticky**: a cmdlet does not touch it, so after a
 *   failing native command every later failure would report that command's
 *   code. The tag function resets it — but only for the AGENT'S next command,
 *   whose code is the one the hub reports. A person's own `$LASTEXITCODE` is
 *   never written: their frames use it only when it changed since the last
 *   prompt, and otherwise report a plain 1.
 * - **Markers sit on their own line** above the prompt, so nothing shifts the
 *   prompt sideways and PSReadLine's redraws of the input line never touch
 *   them. The cost is one visually blank line per prompt.
 * - **The wrapper** runs commands that cannot be typed as one line. It is
 *   dot-sourced, so `cd` and variables persist like a typed command, and its
 *   output goes through `Out-Default` BEFORE the end marker is written — table
 *   formatting otherwise buffers, and the marker would overtake the table.
 */
export function psHooksScript(): string {
  return [
    "function global:__ath_mark([string]$t) { Write-Host -NoNewline ([char]27 + '[8m' + $t + [char]27 + '[28m') }",
    "function global:__ath_osc([string]$t) { Write-Host -NoNewline ([char]27 + ']777;ath;' + $t + [char]7) }",
    'if (-not $global:__ath_prompt0) { $global:__ath_prompt0 = $function:prompt }',
    '$global:__ath_h = 0; $global:__ath_n = $null; $global:__ath_pending = $null; $global:__ath_lec = $global:LASTEXITCODE',
    // The tag line names the next command. It is a command itself, so it must
    // exist in this shell, and it acknowledges so the hub knows it does.
    'function global:↓↓↓ {',
    "  $n = [string]$args[3]",
    "  if ($n -match '^[0-9a-f]{12}$') { $global:__ath_pending = $n; $global:LASTEXITCODE = 0; __ath_osc ('<ATHT:' + $n + '>') }",
    '}',
    'function global:prompt {',
    '  $ok = $?; $lec = $global:LASTEXITCODE',
    "  $agent = $global:__ath_n -and $global:__ath_n -notlike 'h*'",
    '  $rc = if ($ok) { 0 } elseif ($lec -and ($agent -or $lec -ne $global:__ath_lec)) { $lec } else { 1 }',
    '  $global:__ath_lec = $lec',
    "  $m = if ($global:__ath_n) { '<ATHE:' + $global:__ath_n + ':' + $rc + '>' } else { '' }",
    '  if ($global:__ath_pending) { $global:__ath_n = $global:__ath_pending; $global:__ath_pending = $null }',
    "  else { $global:__ath_h++; $global:__ath_n = 'h' + $global:__ath_h }",
    "  __ath_mark ($m + '<ATHS:' + $global:__ath_n + '>'); Write-Host ''",
    '  & $global:__ath_prompt0',
    '}',
    // Dot-sourced by the hub (`. __ath <nonce> <b64>`), so it runs in the
    // session's scope; its own variables carry a prefix for that reason.
    'function global:__ath([string]$__ath_id, [string]$__ath_b64) {',
    '  $global:LASTEXITCODE = 0; $global:__ath_ok = $true',
    "  __ath_mark ('<ATHS:' + $__ath_id + '>'); Write-Host ''",
    '  try { . ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($__ath_b64)) + [char]10 + \'$global:__ath_ok = $?\')) | Out-Default }',
    '  catch { $global:__ath_ok = $false; $_ | Out-Default }',
    '  $__ath_rc = if ($global:__ath_ok) { 0 } elseif ($global:LASTEXITCODE) { $global:LASTEXITCODE } else { 1 }',
    "  __ath_mark ('<ATHE:' + $__ath_id + ':' + $__ath_rc + '>')",
    '}',
  ].join('\n');
}

/** Whether the conceal attribute is on at `index`, following every SGR before it. */
export function concealedAt(raw: string, index: number): boolean {
  let on = false;
  for (const m of raw.slice(Math.max(0, index - 8192), index).matchAll(/\u001b\[([0-9;]*)m/g)) {
    const p = (m[1] ?? '') === '' ? ['0'] : (m[1] ?? '').split(';');
    for (let i = 0; i < p.length; i++) {
      // 38/48 carry sub-parameters: a colour index of 8 is not conceal.
      if (p[i] === '38' || p[i] === '48') i += p[i + 1] === '5' ? 2 : p[i + 1] === '2' ? 4 : 0;
      else if (p[i] === '8') on = true;
      else if (p[i] === '28' || p[i] === '0') on = false;
    }
  }
  return on;
}

/** Where `marker` first occurs inside a concealed span, at or after `from`. */
function firstConcealed(raw: string, marker: string, from = 0): number {
  for (let i = raw.indexOf(marker, from); i >= 0; i = raw.indexOf(marker, i + 1)) {
    if (concealedAt(raw, i)) return i;
  }
  return -1;
}

/**
 * The exit code from the FIRST concealed end marker for `nonce`, or undefined.
 *
 * Concealed only: a command that prints `<ATHE:…:0>` as text cannot end
 * itself early or forge its status. First only: a repaint replays markers
 * still on screen, and the original is the one that was actually written.
 */
export function psFindEnd(raw: string, nonce: string): number | undefined {
  const re = new RegExp(`<ATHE:${nonce}:(-?\\d+)>`, 'g');
  for (const m of raw.matchAll(re)) {
    if (concealedAt(raw, m.index ?? 0)) return Number(m[1]);
  }
  return undefined;
}

/**
 * ConPTY repaints by hiding the cursor and homing it — measured on every
 * resize, and never seen in an ordinary frame, which hides it once at start
 * and then clears rather than homes.
 */
const REPAINT_RE = /\u001b\[\?25l(?:\u001b\[[0-9;]*[mt])*\u001b\[H/;

export interface PsFrame {
  /** Both markers were found, in order. */
  framed: boolean;
  /** Raw bytes between them: the command's output, still to be cleaned. */
  body: string;
  /** A repaint landed inside the frame, so the body may hold replayed screen. */
  repainted: boolean;
}

/** The command's frame: from the first concealed start to the first end after it. */
export function psFrame(raw: string, nonce: string): PsFrame {
  const startMarker = `<ATHS:${nonce}>`;
  const s = firstConcealed(raw, startMarker);
  const e = s < 0 ? -1 : firstConcealed(raw, `<ATHE:${nonce}:`, s);
  if (s < 0 || e < 0) return { framed: false, body: '', repainted: false };
  const body = raw.slice(s + startMarker.length, e);
  return { framed: true, body, repainted: REPAINT_RE.test(body) };
}

/**
 * A frame's body as the command printed it.
 *
 * The POSIX cleaner cannot be reused, for three measured reasons:
 *
 * - **ConPTY writes runs of spaces as cursor-forward** (`\e[10C` inside an
 *   error's underline). Stripped like any other escape, the spaces vanish and
 *   every aligned column collapses — silently. Translated back, they survive.
 * - **ConPTY ends lines `\r\e[m\n`.** The POSIX cleaner treats a CR as an
 *   overwrite and keeps the last segment, which here is the colour reset: the
 *   line's real text would be deleted. Escapes go first, then CRs.
 * - **The markers are concealed text**, not escape sequences, so they are
 *   removed by following the SGR state, not by matching their spelling — a
 *   command that PRINTS a marker-shaped string keeps it in its output.
 *
 * `command`, when given, is the line the agent typed. PSReadLine redraws it as
 * it arrives (predictions, syntax colour, absolute cursor moves), so the echo
 * is several renders run together — but the last always ends with the exact
 * command. It is dropped with whatever precedes it: a prompt may span lines,
 * and a long command may wrap. The wrapper path passes no command: its echo is
 * printed before the frame opens.
 */
export function psClean(body: string, command?: string): string {
  let concealed = false;
  let text = '';
  const re =
    /\u001b\[([0-9;]*)m|\u001b\[(\d*)C|\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]|([^\u001b]+)/g;
  for (const m of body.matchAll(re)) {
    if (m[1] !== undefined) {
      const p = m[1] === '' ? ['0'] : m[1].split(';');
      for (let i = 0; i < p.length; i++) {
        if (p[i] === '38' || p[i] === '48') i += p[i + 1] === '5' ? 2 : p[i + 1] === '2' ? 4 : 0;
        else if (p[i] === '8') concealed = true;
        else if (p[i] === '28' || p[i] === '0') concealed = false;
      }
    } else if (m[2] !== undefined) {
      if (!concealed) text += ' '.repeat(Number(m[2] || '1'));
    } else if (m[3] !== undefined && !concealed) {
      text += m[3];
    }
  }
  let lines = text.split('\n').map((line) => {
    const l = line.replace(/\r$/, '');
    if (!l.includes('\r')) return l.trimEnd();
    // A bare CR still left is a redraw of the same row: the last write is what
    // the screen ended up showing.
    const segments = l.split('\r').filter((s) => s.trim() !== '');
    return (segments[segments.length - 1] ?? '').trimEnd();
  });
  const wanted = command?.trim();
  if (wanted) {
    for (let i = 0, joined = ''; i < Math.min(lines.length, 8); i++) {
      joined += lines[i];
      if (joined.endsWith(wanted)) {
        lines = lines.slice(i + 1);
        break;
      }
    }
  }
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
