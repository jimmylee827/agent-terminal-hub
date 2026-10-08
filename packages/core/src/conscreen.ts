/**
 * Reading a PowerShell session the way its screen shows it.
 *
 * Windows sshd runs the shell inside ConPTY, which does not pass bytes through:
 * it renders a screen and sends what changed. Windows 11's ConPTY sends mostly
 * new text; Windows 10's redraws whatever line it is on from its start
 * (`o-ci4-z<ATHE:ci4>`, then `\r`, then the same text again with more after
 * it), and repaints the whole screen from the top whenever PSReadLine starts
 * reading input. In the byte stream every one of those is a duplicate. On the
 * screen each one lands on the cells it already filled.
 *
 * So the log is replayed on a terminal emulator — @xterm/headless, the engine
 * behind VS Code's terminal — at the pane's exact size, starting at the exact
 * cell the frame's start marker ended on (the hooks report it). Measured on a
 * Windows 10 capture: in the byte stream 16 of 20 rounds framed correctly,
 * with 44 marker copies for 40 markers; on the replayed screen 20 of 20, with
 * 40. Concealed text (SGR 8) keeps its attribute per cell, so a marker is
 * found as concealed cells, never as text a command printed.
 */
import { Terminal } from '@xterm/headless';

export interface ScreenSize {
  cols: number;
  rows: number;
}

/** A 0-based row and column on the screen. */
export interface ScreenPos {
  row: number;
  col: number;
  /** Drawn by Windows 10's ConPTY, which does not mark a wrapped row (see `REPLAY_RE`). */
  legacy?: boolean;
}

/** Bracket a run of concealed cells in a rendered line. Never printable. */
export const HID = '\u0001';
export const VIS = '\u0002';

const HIDDEN_RUN_RE = /\u0001[^\u0002]*\u0002?/g;

/**
 * Lines a replay may hold. Each holds `cols` cells, so a chattier frame than
 * this is reported as truncated rather than read with its start missing.
 */
const SCROLLBACK = 20000;

/**
 * The two things the replay acts on itself, as it reaches them:
 *
 * - a resize, which ConPTY announces in-band (Windows 11): `\e[8;<rows>;<cols>t`;
 * - Windows 10's soft wrap. It does not let a long line wrap: it writes the
 *   full row and moves to the next one itself, so the screen it draws never
 *   marks the row as wrapped. Measured on build 19045:
 *
 *                          wrapped full row    full-width line that ends
 *     cursor on bottom row   `\b\r\n`            `\r\n`
 *     anywhere else          `\r\n`              `\r\n`   (no difference)
 *
 *   So with the cursor waiting to wrap, a `\b\r\n` is the line continuing, and
 *   on Windows 10 so is a bare `\r\n` above the bottom row: lines longer than
 *   the pane are far more common than lines exactly as wide as it, and a long
 *   line split is worse than two exact ones joined. A mode or colour change may
 *   sit before the newline (`\b\e[?25h\r\n` was seen); it is still applied.
 */
const REPLAY_RE = /(\u001b\[8;\d+;\d+t|\u0008?(?:\u001b\[\??[0-9;]*[hlm])*\r\n)/;
const RESIZE_RE = /^\u001b\[8;(\d+);(\d+)t$/;
const NEWLINE_RE = /^(\u0008?)((?:\u001b\[\??[0-9;]*[hlm])*)\r\n$/;

/**
 * Whether the text since the last newline could have filled a row: a cheap
 * filter, so the replay stops to look at the cursor only where a row might be
 * full. Never too low — wide characters count two, any cursor move counts as
 * possibly filling the row.
 */
function mayFillRow(segment: string, cols: number): boolean {
  if (/\u001b\[[0-9;]*[CGHf]/.test(segment)) return true;
  const text = segment.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b./g, '');
  let width = 0;
  for (const ch of text) width += ch.charCodeAt(0) < 0x80 ? 1 : 2;
  return width >= cols;
}

export interface Rendered {
  /** Logical lines from `start` on: wrapped rows joined, concealed runs bracketed. */
  lines: string[];
  /** The replay ran out of scrollback, so its first lines are gone. */
  truncated: boolean;
}

/**
 * Replay `raw` on a fresh screen of `size`, the cursor first placed at `start`,
 * and read back everything from `start` on, in reading order.
 *
 * Anything drawn ABOVE `start` — a repaint redrawing the screen from the top —
 * is not returned: it is outside whatever began there.
 */
export async function renderFrom(
  raw: string,
  size: ScreenSize,
  start?: ScreenPos,
  /** Place the cursor at `start` but read the whole screen, from the top. */
  readAll = false,
  /** Windows 10's ConPTY drew it, even if `start` is unknown. */
  legacyHint = false,
): Promise<Rendered> {
  const cols = Math.max(20, Math.floor(size.cols) || 200);
  const rows = Math.max(5, Math.floor(size.rows) || 50);
  const term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
  try {
    const write = (data: string): Promise<void> => new Promise((resolve) => term.write(data, resolve));
    const at = start ? { row: clamp(start.row, 0, rows - 1), col: clamp(start.col, 0, cols - 1) } : { row: 0, col: 0 };
    if (start) await write(`\u001b[${at.row + 1};${at.col + 1}H`);
    const legacy = !!start?.legacy || legacyHint;
    let pending = '';
    let segment = '';
    for (const piece of raw.split(REPLAY_RE)) {
      if (!piece) continue;
      const resize = RESIZE_RE.exec(piece);
      const newline = resize ? null : NEWLINE_RE.exec(piece);
      if (!resize && !newline) {
        pending += piece;
        segment += piece;
        continue;
      }
      if (newline && !mayFillRow(segment, term.cols)) {
        pending += piece;
        segment = '';
        continue;
      }
      await write(pending);
      pending = '';
      segment = '';
      if (resize) {
        await write(piece);
        term.resize(Math.max(20, Number(resize[2])), Math.max(5, Number(resize[1])));
        continue;
      }
      // xterm holds the cursor one past the last column while a wrap is due.
      const buf = term.buffer.active;
      const due = buf.cursorX >= term.cols;
      const soft = due && (newline?.[1] === '\u0008' || (legacy && buf.cursorY < term.rows - 1));
      await write(soft ? (newline?.[2] ?? '') : piece);
    }
    await write(pending);
    const buf = term.buffer.active;
    // The start row's index in the buffer moves only if scrollback overflowed.
    const truncated = buf.length >= SCROLLBACK + term.rows;
    return { lines: readAll ? readLines(term, 0, 0) : readLines(term, at.row, at.col), truncated };
  } finally {
    term.dispose();
  }
}

/**
 * Replay what followed a concealed `marker`, and read back everything after
 * wherever that marker ends up on the screen.
 *
 * `start` is the cell just past the marker when it was written (the hooks
 * report it), so the replay begins aligned with the real screen. But where it
 * ENDS UP is what counts. On a full screen Windows 10 scrolled once with a
 * newline, then repainted the whole screen already scrolled twice more — scrolls
 * the byte stream never carried. Read from the reported cell, the frame began
 * two rows late, halfway through the typed echo. The repaint redraws the
 * marker's line too, at its true row, overwriting the stale copy; so the marker
 * is drawn first, at its reported place, and read back from its last place.
 *
 * Its last place that `until` (the end marker) follows, when `until` was drawn:
 * a repaint that stops short of the bottom would leave the stale copy below the
 * real one, with nothing of the frame after it. ConPTY's repaints measured so
 * far redraw every row, so this is a guard, not a case seen.
 */
export async function renderAfter(
  raw: string,
  size: ScreenSize,
  marker: string,
  start?: ScreenPos,
  until?: string,
): Promise<Rendered> {
  const at =
    start && start.col >= marker.length ? { ...start, col: start.col - marker.length } : undefined;
  const rendered = await renderFrom(`\u001b[8m${marker}\u001b[28m${raw}`, size, at, true, start?.legacy);
  const all = allConcealed(rendered.lines, marker);
  const ends = until ? allConcealed(rendered.lines, until) : [];
  const follows = (s: Found, e: Found): boolean => e.line > s.line || (e.line === s.line && e.start >= s.end);
  const found = [...all].reverse().find((s) => ends.some((e) => follows(s, e))) ?? all[all.length - 1];
  if (!found) return rendered;
  const lines = rendered.lines.slice(found.line);
  lines[0] = continueRun(lines[0] ?? '', found.end);
  return { lines, truncated: rendered.truncated };
}

/** `line` from `index` on, still marked hidden if `index` fell inside a hidden run. */
function continueRun(line: string, index: number): string {
  const before = line.slice(0, index);
  const open = before.lastIndexOf(HID) > before.lastIndexOf(VIS);
  return (open ? HID : '') + line.slice(index);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

interface Cell {
  ch: string;
  hidden: boolean;
  wide: boolean;
  /** Something was drawn in it; a cell never touched reads as a space. */
  written: boolean;
}

/** The buffer from (row, col) on, as logical lines. */
function readLines(term: Terminal, row: number, col: number): string[] {
  const buf = term.buffer.active;
  const cell = buf.getNullCell();
  const logical: Cell[][] = [];
  // Rows below both the cursor and the last thing drawn are the screen's blank
  // remainder, not lines: read as lines, a half-drawn line would not be last.
  let lastRow = Math.min(buf.length - 1, buf.baseY + buf.cursorY);
  for (let y = buf.length - 1; y > lastRow; y--) {
    const line = buf.getLine(y);
    let drawn = false;
    for (let x = 0; line && x < line.length && !drawn; x++) drawn = line.getCell(x, cell)?.getChars() !== '';
    if (drawn) {
      lastRow = y;
      break;
    }
  }
  // How far the previous physical row was drawn, for Windows 10's wide wrap.
  let prevReach = -1;
  for (let y = row; y <= lastRow; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const cells: Cell[] = [];
    let reach = -1;
    for (let x = y === row ? col : 0; x < line.length; x++) {
      line.getCell(x, cell);
      const width = cell.getWidth();
      if (width === 0) {
        reach = x; // the second half of a wide character
        continue;
      }
      const written = cell.getChars() !== '';
      if (written) reach = x;
      cells.push({ ch: cell.getChars() || ' ', hidden: !!cell.isInvisible(), wide: width === 2, written });
    }
    const prev = logical[logical.length - 1];
    if (line.isWrapped && y > row && prev) {
      // A wide character that did not fit in the last column left that cell
      // blank, and ConPTY writes the blank as a space: padding, not output.
      const last = prev[prev.length - 1];
      if (cells[0]?.wide && last && last.ch === ' ' && !last.hidden) prev.pop();
      prev.push(...cells);
    } else if (prev && y > row && cells[0]?.wide && !cells[0].hidden && prevReach === term.cols - 2) {
      // Windows 10, same case: the row is drawn to one cell short of the edge,
      // that cell is never touched, and a bare CRLF follows. The next row
      // opening with a wide character finishes it. A line that really ends a
      // cell short, followed by one opening with a wide character, is sent
      // with the same bytes (measured, on and above the bottom row), and is
      // joined too: a CJK line meeting the edge is far the likelier.
      while (prev.length && !prev[prev.length - 1]!.written) prev.pop();
      prev.push(...cells);
    } else logical.push(cells);
    prevReach = reach;
  }
  return logical.map((cells) => {
    let s = '';
    let hidden = false;
    for (const c of cells) {
      if (c.hidden !== hidden) {
        s += c.hidden ? HID : VIS;
        hidden = c.hidden;
      }
      s += c.ch;
    }
    if (hidden) s += VIS;
    return s.replace(/ +$/, '');
  });
}

/** A rendered line as a person sees it: concealed runs gone, no trailing blanks. */
export function visible(line: string): string {
  return line.replace(HIDDEN_RUN_RE, '').replace(/\s+$/, '');
}

/**
 * Where `marker` sits in `lines`, as concealed cells: the line, and the indexes
 * of its first character and of the one just past it. The first occurrence, or
 * with `last` the final one.
 */
export function findConcealed(lines: string[], marker: string, from = 0, last = false): Found | undefined {
  const all = allConcealed(lines, marker, from, !last);
  return last ? all[all.length - 1] : all[0];
}

interface Found {
  line: number;
  end: number;
  start: number;
}

/** Every place `marker` sits in `lines` as concealed cells, in reading order. */
function allConcealed(lines: string[], marker: string, from = 0, firstOnly = false): Found[] {
  const found: Found[] = [];
  for (let i = from; i < lines.length; i++) {
    const l = lines[i] ?? '';
    for (const m of l.matchAll(HIDDEN_RUN_RE)) {
      const run = m[0];
      for (let at = run.indexOf(marker); at >= 0; at = run.indexOf(marker, at + 1)) {
        const start = (m.index ?? 0) + at;
        found.push({ line: i, start, end: start + marker.length });
        if (firstOnly) return found;
      }
    }
  }
  return found;
}
