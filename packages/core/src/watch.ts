import { EventEmitter } from 'node:events';

import { list } from './session';
import { refineWithHistory } from './state';
import type { Session, SessionState, StateChange } from './types';

interface Tracked {
  state: SessionState;
  paneTail: string;
  paneChangedAt: number;
}

export interface WatcherOptions {
  /** Poll interval while any session is busy. */
  activeMs?: number;
  /** Slower interval when everything is idle, to stay cheap in the background. */
  idleMs?: number;
  /** How long an interactive command must stall before it counts as prompting. */
  stallMs?: number;
}

/**
 * Polls the hub and emits state transitions.
 *
 * Holding history is what enables the process-based half of the dual signal:
 * a `sudo` whose output has not moved for 1.5s is prompting even when its
 * prompt text matches no pattern we ship — a custom `read -p`, a vendor CLI,
 * or a localized prompt.
 *
 * Events:
 *  - `change`     (StateChange)  any transition, including gone/appeared
 *  - `needs-input` (Session)     a session started waiting on a human
 *  - `list`       (Session[])    every poll, for UI refresh
 *  - `error`      (Error)
 */
export class Watcher extends EventEmitter {
  private timer: NodeJS.Timeout | undefined;
  private tracked = new Map<string, Tracked>();
  private stopped = true;
  private throttled = false;
  private readonly activeMs: number;
  private readonly idleMs: number;
  private readonly stallMs: number;

  constructor(opts: WatcherOptions = {}) {
    super();
    this.activeMs = opts.activeMs ?? 800;
    this.idleMs = opts.idleMs ?? 3000;
    this.stallMs = opts.stallMs ?? 1500;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Force an immediate poll, e.g. right after a command is issued. */
  poke(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    void this.tick();
  }

  /**
   * Slow to the idle rate regardless of activity.
   *
   * Used when the UI showing this data is not on screen. Note it throttles
   * rather than stops: the panel is hidden most of the time, and stopping
   * would mean no "needs input" notification precisely when the user is not
   * looking at the panel — which is when they most need telling.
   */
  setThrottled(throttled: boolean): void {
    if (this.throttled === throttled) return;
    this.throttled = throttled;
    if (!throttled) this.poke();
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    let sessions: Session[] = [];
    let anyActive = false;

    try {
      sessions = await list({ withState: true });

      for (const session of sessions) {
        const previous = this.tracked.get(session.name);
        // Reuse the capture `list()` already took. Capturing again here meant
        // two fork+execs per session per tick, for identical bytes.
        const paneTail = session.paneTail ?? '';
        const changed = !previous || previous.paneTail !== paneTail;
        const paneChangedAt = changed ? Date.now() : (previous?.paneChangedAt ?? Date.now());

        const refined = refineWithHistory(
          session.state,
          session.currentCommand,
          Date.now() - paneChangedAt,
          this.stallMs,
          paneTail,
          session.paneWidth ?? 0,
        );
        session.state = refined;

        if (refined === 'busy' || refined === 'needs-input') anyActive = true;

        if (!previous) {
          this.tracked.set(session.name, { state: refined, paneTail, paneChangedAt });
          this.emit('change', {
            name: session.name,
            previous: 'gone',
            current: refined,
            session,
          } satisfies StateChange);
          if (refined === 'needs-input') this.emit('needs-input', session);
          continue;
        }

        if (previous.state !== refined) {
          this.emit('change', {
            name: session.name,
            previous: previous.state,
            current: refined,
            session,
          } satisfies StateChange);
          if (refined === 'needs-input') this.emit('needs-input', session);
        }
        this.tracked.set(session.name, { state: refined, paneTail, paneChangedAt });
      }

      const live = new Set(sessions.map((s) => s.name));
      for (const name of [...this.tracked.keys()]) {
        if (!live.has(name)) {
          const previous = this.tracked.get(name);
          this.tracked.delete(name);
          this.emit('change', {
            name,
            previous: previous?.state ?? 'gone',
            current: 'gone',
          } satisfies StateChange);
        }
      }

      this.emit('list', sessions);
    } catch (err) {
      this.emit('error', err as Error);
    }

    if (this.stopped) return;
    const delay = anyActive && !this.throttled ? this.activeMs : this.idleMs;
    this.timer = setTimeout(() => void this.tick(), delay);
  }
}
