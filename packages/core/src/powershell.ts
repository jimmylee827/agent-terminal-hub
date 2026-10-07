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
import { gzipSync } from 'node:zlib';

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
/**
 * The one line that installs the hooks, gzipped.
 *
 * The hooks are most of the payload and cmd.exe's ceiling is hard: uncompressed,
 * hooks plus launch left ~400 of 8,191 characters. Shared with the harness, so
 * what it tests is the install the product performs, not a look-alike.
 */
export function psHooksInstall(): string {
  const packed = gzipSync(Buffer.from(psHooksScript(), 'utf8')).toString('base64');
  return `. ([scriptblock]::Create([IO.StreamReader]::new([IO.Compression.GZipStream]::new([IO.MemoryStream]::new([Convert]::FromBase64String('${packed}')), [IO.Compression.CompressionMode]::Decompress)).ReadToEnd()))`;
}

export function psLaunchScript(token: string, state: { cwd?: string } = {}): string {
  return [
    "if ($PSVersionTable.PSVersion.Major -lt 7 -and (Get-Command pwsh -ErrorAction SilentlyContinue)) {",
    "  & pwsh -NoLogo -NoExit -EncodedCommand ([Environment]::CommandLine -split '\\s+')[-1]; exit }",
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = [Console]::OutputEncoding',
    psHooksInstall(),
    // A reconnect comes back where the dropped shell was. Carried here rather
    // than typed afterwards, as the POSIX restore does, so nothing reaches the
    // pane or the history; base64, so no path needs quoting.
    ...(state.cwd
      ? [`try { Set-Location -LiteralPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(state.cwd, 'utf8').toString('base64')}'))) } catch {}`]
      : []),
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
    // PSReadLine, when present. In its default Windows mode C-e/C-u are not
    // editing keys — they are TYPED, as literal control characters, and turned
    // the tag line into a command that did not exist. An otherwise-unused chord
    // clears the line in every edit mode (Escape would enter Vi command mode).
    // And the history FILE is the user's: lines the hub types — the tag, the
    // wrapper, the agent's own command — stay out of it (in memory where
    // PSReadLine supports that), so they are neither left on disk nor offered
    // back to the person as predictions. A handler they had keeps running.
    'if (Get-Module PSReadLine) {',
    "  Set-PSReadLineKeyHandler -Chord 'Alt+F12' -Function RevertLine",
    "  $global:__ath_skip = if ('Microsoft.PowerShell.AddToHistoryOption' -as [type]) { [Microsoft.PowerShell.AddToHistoryOption]::MemoryOnly } else { $false }",
    '  if (-not $global:__ath_hist0) { $global:__ath_hist0 = (Get-PSReadLineOption).AddToHistoryHandler }',
    '  Set-PSReadLineOption -AddToHistoryHandler { param([string]$line)',
    "    if (($global:__ath_n -and $global:__ath_n -notlike 'h*') -or $line -match '^(\\u2193\\u2193\\u2193 AGENT INPUT ID: |\\. __ath |\\$__ath_b )') { return $global:__ath_skip }",
    // A DELEGATE, not a scriptblock: `&` on it throws, on 5.1 and 7 alike, which
    // hung 5.1 outright and would have broken every line a person types on 7.
    '    if ($global:__ath_hist0) { return $global:__ath_hist0.Invoke($line) }; $true }',
    '}',
    '$global:__ath_h = 0; $global:__ath_n = $null; $global:__ath_pending = $null; $global:__ath_lec = $global:LASTEXITCODE',
    // The environment as this shell began (after the profile), so a reconnect can
    // replay exactly what changed since. Reported as a cumulative diff, and only
    // when it changes: the latest report is always the whole truth, and an
    // ordinary prompt sends nothing. Removed variables are reported as null.
    'if (-not $global:__ath_env0) { $global:__ath_env0 = @{}; foreach ($e in (Get-ChildItem env:)) { $global:__ath_env0[$e.Name] = $e.Value } }',
    'function global:__ath_envreport([string]$id) {',
    '  $d = [ordered]@{}; $now = @{}; foreach ($e in (Get-ChildItem env:)) { $now[$e.Name] = $e.Value }',
    '  foreach ($k in $now.Keys) { if (-not $global:__ath_env0.ContainsKey($k) -or $global:__ath_env0[$k] -cne $now[$k]) { $d[$k] = $now[$k] } }',
    '  foreach ($k in $global:__ath_env0.Keys) { if (-not $now.ContainsKey($k)) { $d[$k] = $null } }',
    '  $j = ConvertTo-Json -Compress -InputObject $d',
    "  if ($j -cne $global:__ath_envj) { $global:__ath_envj = $j; __ath_osc ('env;' + $id + ';' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))) }",
    '}',
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
    // Where the command left the shell, keyed by its frame: OSC order does not
    // matter, and the hub needs it to answer `ath ls` and to reconnect in place.
    "  if ($global:__ath_n) { __ath_osc ('cwd;' + $global:__ath_n + ';' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Location).Path))); __ath_envreport $global:__ath_n }",
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
    "  __ath_osc ('cwd;' + $__ath_id + ';' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Location).Path))); __ath_envreport $__ath_id",
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
  let lines = psLines(body);
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

/**
 * The body as the screen ends up showing it, one entry per line.
 *
 * Each line is RENDERED, not stripped: ConPTY re-emits what changed on screen
 * as cursor moves, overwrites and erases, so the text a person sees is the
 * result of applying them. Half-measures failed in turn — stripping cursor-
 * forward deleted runs of spaces, treating a CR as "keep the last segment"
 * deleted text ending `\r\e[m\n`, and honouring backspace while ignoring
 * erase-to-end left the tail of a longer PSReadLine redraw glued to the typed
 * echo, so the echo was no longer recognised. Handled: CR, BS, TAB, cursor
 * right/left (C/D), absolute column (G, and the column of H/f), erase in line
 * (K) and erase characters (X). Concealed text is dropped; it only ever sits on
 * a marker line of its own. Escapes never contain a newline, so line N here is
 * line N of the raw bytes, which is what lets a caller map a line to an offset.
 */
function psLines(body: string): string[] {
  const lines: string[] = [];
  let cells: string[] = [];
  let x = 0;
  let concealed = false;
  const flush = (): void => {
    let line = '';
    for (let i = 0; i < cells.length; i++) line += cells[i] ?? ' ';
    lines.push(line.trimEnd());
    cells = [];
    x = 0;
  };
  const re =
    /\u001b\[([0-9;?]*)[ -/]*([@-~])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]|([^\u001b]+)/g;
  for (const m of body.matchAll(re)) {
    const final = m[2];
    if (final !== undefined) {
      const raw = m[1] ?? '';
      const p = raw.replace(/^\?/, '').split(';');
      const num = (i: number, fallback: number): number => {
        const v = Number(p[i]);
        return p[i] !== undefined && p[i] !== '' && Number.isFinite(v) ? v : fallback;
      };
      if (final === 'm' && !raw.startsWith('?')) {
        const sgr = raw === '' ? ['0'] : raw.split(';');
        for (let i = 0; i < sgr.length; i++) {
          // 38/48 carry sub-parameters: a colour index of 8 is not conceal.
          if (sgr[i] === '38' || sgr[i] === '48') i += sgr[i + 1] === '5' ? 2 : sgr[i + 1] === '2' ? 4 : 0;
          else if (sgr[i] === '8') concealed = true;
          else if (sgr[i] === '28' || sgr[i] === '0') concealed = false;
        }
      } else if (final === 'C') x += Math.max(1, num(0, 1));
      else if (final === 'D') x = Math.max(0, x - Math.max(1, num(0, 1)));
      else if (final === 'G') x = Math.max(0, num(0, 1) - 1);
      else if (final === 'H' || final === 'f') x = Math.max(0, num(1, 1) - 1);
      else if (final === 'K') {
        const mode = num(0, 0);
        if (mode === 0) cells.length = Math.min(cells.length, x);
        else if (mode === 1) for (let i = 0; i <= x && i < cells.length; i++) cells[i] = ' ';
        else cells = [];
      } else if (final === 'X') {
        for (let i = x; i < x + Math.max(1, num(0, 1)) && i < cells.length; i++) cells[i] = ' ';
      }
      continue;
    }
    const text = m[3];
    if (text === undefined) continue;
    for (const ch of text) {
      if (ch === '\n') flush();
      else if (ch === '\r') x = 0;
      else if (ch === '\b') x = Math.max(0, x - 1);
      else if (ch === '\t') x = (Math.floor(x / 8) + 1) * 8;
      else if (ch < ' ' || concealed) continue;
      else {
        while (cells.length < x) cells.push(' ');
        cells[x++] = ch;
      }
    }
  }
  flush();
  return lines;
}

/**
 * How many lines after the start marker the typed echo occupies — once it is
 * COMPLETE, i.e. a newline has closed the line that ends with the command.
 * Undefined while it is still being drawn.
 *
 * PSReadLine draws the echo after the frame opens and re-renders it on Enter,
 * so a poll that starts too early catches a partial echo and the NEXT poll
 * catches the re-render, with nothing left in its slice to say it is echo. A
 * caller that waits for this can start polling past the echo instead.
 */
export function psEchoLines(raw: string, nonce: string, command: string): number | undefined {
  const marker = `<ATHS:${nonce}>`;
  const s = firstConcealed(raw, marker);
  if (s < 0) return undefined;
  const lines = psLines(raw.slice(s + marker.length));
  const wanted = command.trim();
  // `lines.length - 1`: the last entry has no newline after it yet.
  for (let i = 0, joined = ''; i < Math.min(lines.length - 1, 8); i++) {
    joined += lines[i];
    if (joined.endsWith(wanted)) return i + 1;
  }
  return undefined;
}

/**
 * A frame that has not closed: from the first concealed start marker to
 * whatever has arrived. For results that end before the command does — a
 * timeout, a prompt, a shell that exited — where demanding both markers would
 * throw away output sitting in the log.
 */
export function psPartial(raw: string, nonce: string): string {
  const marker = `<ATHS:${nonce}>`;
  const s = firstConcealed(raw, marker);
  return s < 0 ? '' : raw.slice(s + marker.length);
}

/** Where the command's concealed start marker is, or -1. */
export function psStartAt(raw: string, nonce: string): number {
  return firstConcealed(raw, `<ATHS:${nonce}>`);
}

/**
 * The most recent AGENT frame opened in `raw`: 12 hex characters, concealed.
 * Never a person's `h<n>` frame, one of which is open at every idle prompt.
 */
export function psLatestHandle(raw: string): string | undefined {
  let found: string | undefined;
  for (const m of raw.matchAll(/<ATHS:([0-9a-f]{12})>/g)) {
    if (concealedAt(raw, m.index ?? 0)) found = m[1];
  }
  return found;
}

/**
 * One command's part of a slice that may begin or end mid-command — what a
 * poll sees. Cut at its concealed start when the slice holds it, and at its
 * concealed end when that has arrived. `opened` says whether the start was in
 * the slice, i.e. whether the typed echo can be in it too.
 */
export function psWindow(raw: string, nonce: string): { body: string; opened: boolean } {
  const startMarker = `<ATHS:${nonce}>`;
  const s = firstConcealed(raw, startMarker);
  const from = s < 0 ? 0 : s + startMarker.length;
  const e = firstConcealed(raw, `<ATHE:${nonce}:`, from);
  return { body: raw.slice(from, e < 0 ? raw.length : e), opened: s >= 0 };
}

/** The directory a command left the shell in, from its keyed OSC record. */
export function psFindCwd(raw: string, nonce: string): string | undefined {
  const m = new RegExp(`\\u001b\\]777;ath;cwd;${nonce};([A-Za-z0-9+/=]*)\\u0007`).exec(raw);
  if (!m || !m[1]) return undefined;
  const text = Buffer.from(m[1], 'base64').toString('utf8');
  return text || undefined;
}

/** The latest environment report in `raw`: the cumulative diff, as JSON. */
export function psFindEnv(raw: string): string | undefined {
  let last: string | undefined;
  for (const m of raw.matchAll(/\u001b\]777;ath;env;[^;\u0007]+;([A-Za-z0-9+/=]*)\u0007/g)) last = m[1];
  if (last === undefined) return undefined;
  return Buffer.from(last, 'base64').toString('utf8') || undefined;
}

/**
 * The script that puts a remembered environment diff back after a reconnect.
 *
 * The diff travels as base64 JSON and is parsed by PowerShell itself, so no
 * value — quotes, newlines, a semicolon in PATH, non-ASCII — needs escaping
 * here. A null means the variable was removed, and is removed again. Run
 * through the wrapper rather than carried in the relaunch: a changed PATH alone
 * would carry its whole value, and the relaunch has a hard ceiling.
 */
export function psEnvRestoreScript(json: string): string {
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  return [
    `$__ath_d = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`,
    "foreach ($__ath_p in $__ath_d.PSObject.Properties) { if ($null -eq $__ath_p.Value) { Remove-Item -LiteralPath ('env:' + $__ath_p.Name) -ErrorAction SilentlyContinue } else { Set-Item -LiteralPath ('env:' + $__ath_p.Name) -Value ([string]$__ath_p.Value) } }",
    'Remove-Variable __ath_d, __ath_p -ErrorAction SilentlyContinue',
  ].join('\n');
}
