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

import { findConcealed, renderAfter, renderFrom, visible, type ScreenPos, type ScreenSize } from './conscreen';
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
  const script = (cwd?: string): string => [
    "if ($PSVersionTable.PSVersion.Major -lt 7 -and (Get-Command pwsh -ErrorAction SilentlyContinue)) {",
    "  & pwsh -NoLogo -NoExit -EncodedCommand ([Environment]::CommandLine -split '\\s+')[-1]; exit }",
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = [Console]::OutputEncoding',
    psHooksInstall(),
    // A reconnect comes back where the dropped shell was. Carried here rather
    // than typed afterwards, as the POSIX restore does, so nothing reaches the
    // pane or the history.
    ...(cwd ? [psCwdRestoreScript(cwd)] : []),
    `Write-Host -NoNewline ([char]27 + ']777;ath;<ATHR:${token}:' + (Get-Process -Id $PID).ProcessName + '>' + [char]7)`,
  ].join('\n');
  // Each character of a path costs about four on cmd.exe's line, more for one
  // outside ASCII, so a deep path — or a short one in Chinese — would push the
  // launch past the ceiling and the reconnect would fail outright. It is left
  // out instead, and comes back through the wrapper (see `psLaunchCarries`).
  const full = script(state.cwd);
  return state.cwd && remoteFor(full).length > CMD_LINE_MAX ? script() : full;
}

/** Whether a launch with this token carries this cwd, or leaves it to the wrapper. */
export function psLaunchCarries(token: string, cwd: string): boolean {
  return psLaunchScript(token, { cwd }).includes(psCwdRestoreScript(cwd));
}

/** Go back to a working directory: base64, so no path needs quoting. */
export function psCwdRestoreScript(cwd: string): string {
  return `try { Set-Location -LiteralPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(cwd, 'utf8').toString('base64')}'))) } catch {}`;
}

function remoteFor(script: string): string {
  return `powershell -NoLogo -NoExit -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

/** The command cmd.exe receives. */
export function psRemoteCommand(script: string): string {
  const remote = remoteFor(script);
  if (remote.length > CMD_LINE_MAX) {
    throw new Error(`PowerShell launch is ${remote.length} characters, over cmd.exe's ${CMD_LINE_MAX}`);
  }
  return remote;
}

/**
 * The tag line a PowerShell session is typed before each framed command.
 *
 * ASCII on purpose. The POSIX line's arrows are typed keys, and Windows 10's
 * ConPTY loses some non-ASCII input: on a 19045 host `↓↓↓ AGENT INPUT ID: <id>
 * ↓↓↓` arrived as `↓ AGENT INPUT ID: <id>` (and a typed `中文✓` as `中文`), so
 * the tag function was never found and every command was refused.
 */
export function psTagLine(nonce: string): string {
  return `vvv AGENT INPUT ID: ${nonce} vvv`;
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
  if (at < 0) return false;
  const after = log.slice(at, at + window);
  return after.includes(CONPTY_HELLO) || CONHOST_TITLE_RE.test(after);
}

/**
 * Whether a pane is showing a Windows shell at its prompt, judged by what is on
 * the screen: the last line is cmd's `C:\\…>` or PowerShell's `PS C:\\…>` (a
 * custom prefix such as `user@HOST ` allowed), AND something says Windows: its
 * ConPTY's greeting in `logTail`, or a Windows banner on the screen. Both, so a
 * POSIX prompt that happens to end in `C:\\x>` is not taken for one.
 *
 * For a shell the hub did NOT launch: an ssh typed into a local session. That
 * pane's session is not a Windows one (`conptyAnnounced` deliberately ignores a
 * greeting that is not its own launch's), but what the hub TYPES there must
 * still suit the shell actually in it.
 */
export function windowsShellOnScreen(screen: string, logTail: string): boolean {
  const lines = screen.split('\n').map((l) => l.trimEnd()).filter((l) => l !== '');
  const last = lines[lines.length - 1] ?? '';
  if (!WINDOWS_PROMPT_RE.test(last)) return false;
  return (
    logTail.includes(CONPTY_HELLO) ||
    CONHOST_TITLE_RE.test(logTail) ||
    /Microsoft Windows \[Version \d|Windows PowerShell|^PowerShell \d/m.test(screen)
  );
}

const WINDOWS_PROMPT_RE = /(?:^|\s)(?:PS )?[A-Za-z]:\\[^\n<>|"]*>$/;

/**
 * Windows 10's ConPTY sends no `\e[?9001h`. What both versions do send, once,
 * as a session opens, is a window title naming conhost itself — Windows 10
 * right after its clear-and-home, Windows 11 after its hello. A POSIX host
 * would have to title its own terminal after a Windows binary to match.
 */
const CONHOST_TITLE_RE = /\u001b\]0;[^\u0007\u001b]*\\conhost\.exe(?:\u0007|\u001b\\)/i;

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
    // Where on the screen a frame begins: the row and column just past its start
    // marker. The hub replays ConPTY's output on a screen of its own, and
    // ConPTY's cursor moves name absolute rows, so that screen has to start
    // where the real one was. Under ConPTY the buffer IS the screen (window at
    // 0,0, buffer the pane's size), measured on Windows 10 and 11 alike.
    // The Windows build rides along: Windows 10's ConPTY draws a wrapped line
    // differently from Windows 11's, and the replay has to know which it is.
    "function global:__ath_pos([string]$id) { try { $c = $Host.UI.RawUI.CursorPosition; $w = $Host.UI.RawUI.WindowPosition; __ath_osc ('pos;' + $id + ';' + ($c.Y - $w.Y) + ';' + $c.X + ';' + [Environment]::OSVersion.Version.Build) } catch {} }",
    // No read of a variable that may not exist: a profile with `Set-StrictMode
    // -Version Latest` makes that THROW, which left the hooks half-installed and
    // every later prompt failing — commands then never reported an end. Its
    // strict mode stays as it is; the hooks just never trip it.
    'if (-not (Test-Path variable:global:__ath_prompt0)) { $global:__ath_prompt0 = $function:prompt }',
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
    // Predictions draw the person's saved history beside the cursor whenever
    // input arrives in pieces, and ConPTY sends what is drawn: one put a bearer
    // token from that history into the transcript the agent reads. Off in this
    // session only; 5.1's PSReadLine has none.
    "  if ((Get-Command Set-PSReadLineOption).Parameters.ContainsKey('PredictionSource')) { Set-PSReadLineOption -PredictionSource None }",
    "  $global:__ath_skip = if ('Microsoft.PowerShell.AddToHistoryOption' -as [type]) { [Microsoft.PowerShell.AddToHistoryOption]::MemoryOnly } else { $false }",
    '  if (-not (Test-Path variable:global:__ath_hist0)) { $global:__ath_hist0 = (Get-PSReadLineOption).AddToHistoryHandler }',
    '  Set-PSReadLineOption -AddToHistoryHandler { param([string]$line)',
    "    if (($global:__ath_n -and $global:__ath_n -notlike 'h*') -or $line -match '^(vvv AGENT INPUT ID: |\\. __ath |\\$__ath_b )') { return $global:__ath_skip }",
    // A DELEGATE, not a scriptblock: `&` on it throws, on 5.1 and 7 alike, which
    // hung 5.1 outright and would have broken every line a person types on 7.
    '    if ($global:__ath_hist0) { return $global:__ath_hist0.Invoke($line) }; $true }',
    '}',
    '$global:__ath_h = 0; $global:__ath_n = $null; $global:__ath_pending = $null; $global:__ath_w = $false; $global:__ath_hid = $null; $global:__ath_envj = $null',
    // `$LASTEXITCODE` does not exist until a native command has run.
    '$global:__ath_lec = Get-Variable LASTEXITCODE -Scope Global -ValueOnly -ErrorAction Ignore',
    // The environment as this shell began (after the profile), so a reconnect can
    // replay exactly what changed since. Reported as a cumulative diff, and only
    // when it changes: the latest report is always the whole truth, and an
    // ordinary prompt sends nothing. Removed variables are reported as null.
    'if (-not (Test-Path variable:global:__ath_env0)) { $global:__ath_env0 = @{}; foreach ($e in (Get-ChildItem env:)) { $global:__ath_env0[$e.Name] = $e.Value } }',
    'function global:__ath_envreport([string]$id) {',
    '  $d = [ordered]@{}; $now = @{}; foreach ($e in (Get-ChildItem env:)) { $now[$e.Name] = $e.Value }',
    '  foreach ($k in $now.Keys) { if (-not $global:__ath_env0.ContainsKey($k) -or $global:__ath_env0[$k] -cne $now[$k]) { $d[$k] = $now[$k] } }',
    '  foreach ($k in $global:__ath_env0.Keys) { if (-not $now.ContainsKey($k)) { $d[$k] = $null } }',
    '  $j = ConvertTo-Json -Compress -InputObject $d',
    "  if ($j -cne $global:__ath_envj) { $global:__ath_envj = $j; __ath_osc ('env;' + $id + ';' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))) }",
    '}',
    // The tag line names the next command. It is a command itself, so it must
    // exist in this shell, and it acknowledges so the hub knows it does. ASCII
    // (see `psTagLine`): Windows 10's ConPTY mangles typed arrows.
    'function global:vvv {',
    "  $n = [string]$args[3]",
    "  if ($n -match '^[0-9a-f]{12}$') { $global:__ath_pending = $n; $global:LASTEXITCODE = 0; __ath_osc ('<ATHT:' + $n + '>') }",
    '}',
    'function global:prompt {',
    '  $ok = $?; $lec = Get-Variable LASTEXITCODE -Scope Global -ValueOnly -ErrorAction Ignore',
    // A line that failed to PARSE never ran, so `$?` is still the previous
    // line's, and the console does not put the error in `$Error` either. Its
    // history entry is new and says Failed; a re-parse tells it from a line
    // that ran and failed, whose status `$?` already has right.
    "  $hl = Get-History -Count 1; if ($ok -and $hl -and $hl.Id -ne $global:__ath_hid -and \"$($hl.ExecutionStatus)\" -eq 'Failed') { $pe = $null; [void][Management.Automation.Language.Parser]::ParseInput($hl.CommandLine, [ref]$null, [ref]$pe); if ($pe) { $ok = $false } }; if ($hl) { $global:__ath_hid = $hl.Id }",
    "  $agent = $global:__ath_n -and $global:__ath_n -notlike 'h*'",
    '  $rc = if ($ok) { 0 } elseif ($lec -and ($agent -or $lec -ne $global:__ath_lec)) { $lec } else { 1 }',
    '  $global:__ath_lec = $lec',
    // Where the command left the shell, keyed by its frame: OSC order does not
    // matter, and the hub needs it to answer `ath ls` and to reconnect in place.
    "  if ($global:__ath_n) { __ath_osc ('cwd;' + $global:__ath_n + ';' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Location).Path))); __ath_envreport $global:__ath_n }",
    "  $m = if ($global:__ath_n) { '<ATHE:' + $global:__ath_n + ':' + $rc + '>' } else { '' }",
    '  if ($global:__ath_pending) { $global:__ath_n = $global:__ath_pending; $global:__ath_pending = $null }',
    "  else { $global:__ath_h++; $global:__ath_n = 'h' + $global:__ath_h }",
    "  __ath_mark ($m + '<ATHS:' + $global:__ath_n + '>'); __ath_pos $global:__ath_n; Write-Host ''",
    // The user's prompt sees the status of THEIR line, not of ours: `$?` cannot
    // be assigned, but a failing statement sets it, and an ignored error is not
    // added to `$Error`. After the wrapper, the line was `. __ath …`, which
    // always succeeds, so its own result stands in for it.
    '  if ($global:__ath_w) { $ok = $global:__ath_ok; $global:__ath_w = $false }',
    "  if (-not $ok) { Write-Error '' -ErrorAction Ignore }",
    '  & $global:__ath_prompt0',
    '}',
    // Dot-sourced by the hub (`. __ath <nonce> <b64>`), so it runs in the
    // session's scope; its own variables carry a prefix for that reason.
    'function global:__ath([string]$__ath_id, [string]$__ath_b64) {',
    '  $global:LASTEXITCODE = 0; $global:__ath_ok = $true',
    "  __ath_mark ('<ATHS:' + $__ath_id + '>'); __ath_pos $__ath_id; Write-Host ''",
    // Parsed alone first, so a syntax error is shown against the agent's own
    // lines, as a typed one would be. Left to `Create`, it surfaced as a failed
    // call on THIS function's source line, pointing into the status line below.
    '  $__ath_src = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($__ath_b64)); $__ath_perr = $null',
    '  [void][Management.Automation.Language.Parser]::ParseInput($__ath_src, [ref]$null, [ref]$__ath_perr)',
    '  if ($__ath_perr) { $global:__ath_ok = $false; [Management.Automation.ParseException]::new($__ath_perr).ErrorRecord | Out-Default }',
    "  else { try { . ([scriptblock]::Create($__ath_src + [char]10 + '$global:__ath_ok = $?')) | Out-Default } catch { $global:__ath_ok = $false; $_ | Out-Default } }",
    '  $__ath_rc = if ($global:__ath_ok) { 0 } elseif ($global:LASTEXITCODE) { $global:LASTEXITCODE } else { 1 }',
    "  __ath_osc ('cwd;' + $__ath_id + ';' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Location).Path))); __ath_envreport $__ath_id",
    "  __ath_mark ('<ATHE:' + $__ath_id + ':' + $__ath_rc + '>'); $global:__ath_w = $true",
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
 * A resize, announced in-band by Windows 11's ConPTY (`\e[8;<rows>;<cols>t`).
 * The replay follows it, but a re-laid screen is where a replay is most likely
 * to differ from the real one, so a frame holding one is flagged. Windows 10
 * announces nothing; there the hub's own width observation stands in.
 */
const RESIZE_RE = /\u001b\[8;\d+;\d+t/;

/** Where a frame begins on the screen: the cell just past its start marker. */
export function psFindPos(raw: string, nonce: string): ScreenPos | undefined {
  const m = new RegExp(`\\u001b\\]777;ath;pos;${nonce};(\\d+);(\\d+)(?:;(\\d+))?\\u0007`).exec(raw);
  if (!m) return undefined;
  const build = m[3] === undefined ? undefined : Number(m[3]);
  // Windows 11 is build 22000 and up; its ConPTY marks a wrapped row as wrapped.
  return { row: Number(m[1]), col: Number(m[2]), ...(build !== undefined && build < 22000 ? { legacy: true } : {}) };
}

export interface PsFrame {
  /** The frame's start marker was found. */
  opened: boolean;
  /** Its end marker has been written: the command finished. */
  closed: boolean;
  /**
   * Its lines as the screen shows them, from where it began, before the typed
   * echo is dropped. The last may still be being drawn.
   */
  lines: string[];
  /** How many of `lines` are the prompt and the typed echo. */
  echo: number;
  /** The command's output: the lines after the echo, trimmed. */
  output: string;
  /** A resize was announced inside the frame. */
  repainted: boolean;
  /** The replay could not hold the whole frame. */
  truncated: boolean;
  /** Its start position was reported; without one the replay began at the top. */
  positioned: boolean;
}

const NOT_OPENED: PsFrame = {
  opened: false,
  closed: false,
  lines: [],
  echo: 0,
  output: '',
  repainted: false,
  truncated: false,
  positioned: false,
};

/**
 * One command's output, read off a replay of its screen (see `conscreen.ts`).
 *
 * `raw` must hold the frame's concealed start marker; its `pos` record may sit
 * anywhere in it, since OSC is not ordered with text. The replay starts on the
 * cell the marker ended on and runs to the end of `raw`: Windows 10 can redraw
 * the end marker's line after the bytes where it first appeared. Read up to the
 * end marker's CELL, so a line redrawn from its start is read once.
 *
 * `command`, when given, is the line the agent typed. The prompt and its echo
 * open the frame (PSReadLine draws the echo several times, syntax-coloured, but
 * the screen holds it once) and are dropped up to the line that ends with it.
 * The wrapper passes none: its echo comes before the frame opens.
 */
export async function psReadFrame(raw: string, nonce: string, size: ScreenSize, command?: string): Promise<PsFrame> {
  const marker = `<ATHS:${nonce}>`;
  const s = firstConcealed(raw, marker);
  if (s < 0) return NOT_OPENED;
  const from = s + marker.length;
  const e = firstConcealed(raw, `<ATHE:${nonce}:`, from);
  const pos = psFindPos(raw, nonce);
  const rendered = await renderAfter(raw.slice(from), size, marker, pos, `<ATHE:${nonce}:`);
  const end = findConcealed(rendered.lines, `<ATHE:${nonce}:`);
  const cut = end ? rendered.lines.slice(0, end.line + 1) : [...rendered.lines];
  if (end) cut[end.line] = (cut[end.line] ?? '').slice(0, end.start);
  const lines = cut.map(visible);
  const echo = echoLines(lines, command);
  const out = lines.slice(echo);
  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  return {
    opened: true,
    closed: e >= 0,
    lines,
    echo,
    output: out.join('\n'),
    repainted: RESIZE_RE.test(raw.slice(from, e < 0 ? raw.length : e)),
    truncated: rendered.truncated,
    positioned: !!pos,
  };
}

/** How far into a frame its typed echo is looked for. */
const ECHO_WINDOW = 8;

/** How many leading lines are the prompt and the typed echo of `command`. */
function echoLines(lines: string[], command?: string): number {
  const wanted = command?.trim();
  if (!wanted) return 0;
  for (let i = 0, joined = ''; i < Math.min(lines.length, ECHO_WINDOW); i++) {
    joined += lines[i];
    if (joined.endsWith(wanted)) return i + 1;
  }
  return 0;
}

export interface PsPoll {
  /** Lines completed since `since`, and the rest once the command has ended. */
  output: string;
  /** The command's end marker has been written. */
  closed: boolean;
  /** A line returned before has since been redrawn differently, or the screen was resized. */
  changed: boolean;
  /** The frame's start was not in `raw`. */
  opened: boolean;
}

/**
 * What a frame printed between two moments, for `poll`.
 *
 * The frame is replayed twice from its start — up to `since` and up to now —
 * and only lines that were not yet complete at `since` are returned. A line
 * still being drawn is held back until it is finished or the command ends, so
 * a progress line rewritten in place is never returned twice. If a line that
 * WAS complete reads differently now, something redrew history (a resize
 * repaint), and the result says so instead of returning it as new.
 */
export async function psPollFrame(
  raw: string,
  since: number,
  nonce: string,
  size: ScreenSize,
  command?: string,
): Promise<PsPoll> {
  const now = await psReadFrame(raw, nonce, size, command);
  if (!now.opened) return { output: '', closed: false, changed: false, opened: false };
  const before = since > 0 ? await psReadFrame(raw.slice(0, since), nonce, size, command) : NOT_OPENED;
  const done = settled(before, command);
  const from = Math.max(done, now.echo);
  // Only a resize that arrived since \`since\`; an earlier one was reported then.
  let changed = now.repainted && !before.repainted;
  for (let i = now.echo; i < Math.min(done, now.lines.length); i++) {
    if ((before.lines[i] ?? '') !== (now.lines[i] ?? '')) changed = true;
  }
  const fresh = now.lines.slice(from, Math.max(from, settled(now, command)));
  if (from === now.echo) while (fresh.length && fresh[0] === '') fresh.shift();
  while (fresh.length && fresh[fresh.length - 1] === '' && now.closed) fresh.pop();
  return { output: fresh.join('\n'), closed: now.closed, changed, opened: true };
}

/**
 * How many of a frame's lines are settled enough to hand out: all of them once
 * it has ended. Before that, not the last line (it may be half drawn), not
 * blank lines at the end (a command's output ends with some, which the final
 * read trims), and nothing while the typed echo is still being drawn and so
 * cannot yet be told from output — Windows 10 redraws the echo's row in place
 * with the row below still showing what was there before.
 */
function settled(frame: PsFrame, command?: string): number {
  if (!frame.opened) return 0;
  if (frame.closed) return frame.lines.length;
  if (command?.trim() && frame.echo === 0 && frame.lines.length <= ECHO_WINDOW) return 0;
  let n = Math.max(0, frame.lines.length - 1);
  while (n > frame.echo && frame.lines[n - 1] === '') n--;
  return n;
}

/**
 * A stretch of a session as its screen shows it, for `read`.
 *
 * Replayed from the last frame start before `since` whose position is known,
 * so the replay is aligned with the real screen; without one, from the top of
 * `raw`. Returns the lines not yet complete at `since`, as `psPollFrame`
 * does, so a line that was half drawn is shown whole.
 */
export async function psReadSince(raw: string, since: number, size: ScreenSize): Promise<string[]> {
  let anchor = 0;
  let marker: string | undefined;
  let until: string | undefined;
  let pos: ScreenPos | undefined;
  for (const m of raw.matchAll(/<ATHS:([0-9a-z]{1,16})>/g)) {
    const at = m.index ?? 0;
    if (at >= Math.max(since, 1)) break;
    if (!concealedAt(raw, at)) continue;
    const p = psFindPos(raw, m[1] ?? '');
    if (p) {
      anchor = at + m[0].length;
      marker = m[0];
      until = `<ATHE:${m[1]}:`;
      pos = p;
    }
  }
  const replay = (text: string): Promise<{ lines: string[] }> =>
    marker ? renderAfter(text, size, marker, pos, until) : renderFrom(text, size);
  const now = (await replay(raw.slice(anchor))).lines.map(visible);
  const before = since > anchor ? (await replay(raw.slice(anchor, since))).lines : [];
  const done = Math.max(0, before.length - 1);
  const out = now.slice(Math.min(done, now.length));
  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/**
 * The end of a session as its screen shows it, for `read --tail`: replayed
 * from the EARLIEST frame start in `raw` whose position is known, so the
 * replay is aligned for as much of the window as possible.
 */
export async function psReadTail(raw: string, size: ScreenSize): Promise<string[]> {
  let lines: string[] | undefined;
  for (const m of raw.matchAll(/<ATHS:([0-9a-z]{1,16})>/g)) {
    const at = m.index ?? 0;
    const pos = concealedAt(raw, at) ? psFindPos(raw, m[1] ?? '') : undefined;
    if (!pos) continue;
    lines = (await renderAfter(raw.slice(at + m[0].length), size, m[0], pos, `<ATHE:${m[1]}:`)).lines;
    break;
  }
  const out = (lines ?? (await renderFrom(raw, size)).lines).map(visible);
  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
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
