import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';

/**
 * Offer to reload a window whose Claude tools run an older hub build.
 *
 * An MCP server reads the hub once, when it starts, so a rebuild does not reach
 * it until the window that launched it reloads. The hub could only SAY so: every
 * `doctor` and `done-check` listed stale servers (six windows at once, one day),
 * and the fix stayed a manual Cmd+Shift+P in each. This window can act on its
 * own servers: theirs is the extension host this extension runs in (server ->
 * claude -> this process, measured), so a reload restarts exactly them.
 */

export interface Proc {
  pid: number;
  ppid: number;
  startedMs: number;
  args: string;
}

export interface StaleServer {
  pid: number;
  startedMs: number;
  builtMs: number;
}

function processes(): Promise<Proc[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-eo', 'pid=,ppid=,lstart=,args='], { maxBuffer: 8 << 20 }, (err, out) => {
      if (err) return resolve([]);
      const procs: Proc[] = [];
      for (const line of String(out).split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.*)$/.exec(line);
        if (!m) continue;
        const startedMs = Date.parse(m[3] ?? '');
        if (Number.isFinite(startedMs)) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), startedMs, args: m[4] ?? '' });
      }
      resolve(procs);
    });
  });
}

function mtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * When the build that server would load NOW was made: its own entry, and the
 * core it loads beside it (the workspace layout) or through node_modules.
 */
function builtFor(script: string): number {
  const dist = dirname(script);
  return Math.max(
    mtime(script),
    mtime(join(dist, '..', '..', 'core', 'dist', 'index.js')),
    mtime(join(dist, '..', 'node_modules', '@ath', 'core', 'dist', 'index.js')),
  );
}

/** Whether `ancestor` is among `pid`'s parents. */
function descends(procs: Map<number, Proc>, pid: number, ancestor: number): boolean {
  let p = procs.get(pid);
  for (let i = 0; p && i < 32; i++) {
    if (p.ppid === ancestor) return true;
    p = procs.get(p.ppid);
  }
  return false;
}

/** This window's hub MCP servers that started before the build they would now load. */
export async function staleInThisWindow(self = process.pid, list?: Proc[]): Promise<StaleServer[]> {
  const procs = list ?? (await processes());
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out: StaleServer[] = [];
  for (const p of procs) {
    const script = /(\S*mcp[/\\]dist[/\\]index\.js)/.exec(p.args)?.[1];
    if (!script || !descends(byPid, p.pid, self)) continue;
    const builtMs = builtFor(script);
    // A second of slack, as core's own check: filesystems round mtimes.
    if (builtMs && p.startedMs < builtMs - 1000) out.push({ pid: p.pid, startedMs: p.startedMs, builtMs });
  }
  return out;
}

/** Look now, and every few minutes; offer the reload once per build. */
export function watchStaleServers(context: vscode.ExtensionContext): void {
  const offered = new Set<number>();
  const check = async (): Promise<void> => {
    const stale = await staleInThisWindow().catch(() => [] as StaleServer[]);
    if (!stale.length) return;
    const built = Math.max(...stale.map((s) => s.builtMs));
    if (offered.has(built)) return;
    offered.add(built);
    const when = (ms: number): string => new Date(ms).toLocaleString();
    const choice = await vscode.window.showInformationMessage(
      `Agent Terminal Hub: Claude's tools in this window run hub code from ` +
        `${when(Math.min(...stale.map((s) => s.startedMs)))}, older than the build on disk ` +
        `(${when(built)}). Reload this window to use it; Claude Code resumes the conversation.`,
      'Reload Window',
      'Later',
    );
    if (choice === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow');
  };
  // After startup settles: a server launched a moment ago is current anyway.
  const first = setTimeout(() => void check(), 20_000);
  const timer = setInterval(() => void check(), 5 * 60_000);
  context.subscriptions.push({ dispose: () => (clearTimeout(first), clearInterval(timer)) });
}
