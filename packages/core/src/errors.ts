export class AthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AthError';
    this.code = code;
  }
}

/**
 * The session no longer exists — killed from the GUI or CLI, possibly while an
 * agent was mid-command. Callers should report this and move on rather than
 * retry: a killed session is a deliberate human act.
 */
export class SessionGone extends AthError {
  constructor(name: string) {
    super('session_gone', `Session "${name}" no longer exists (it was killed or never created).`);
    this.name = 'SessionGone';
  }
}

export class SessionExists extends AthError {
  constructor(name: string) {
    super('session_exists', `Session "${name}" already exists.`);
    this.name = 'SessionExists';
  }
}

export class SessionBusy extends AthError {
  /** `detail` is pre-formatted by the caller, so it may carry timing as well as the command. */
  constructor(name: string, detail: string) {
    super(
      'session_busy',
      `Session "${name}" is already running ${detail}. ` +
        `Watch it with "ath read ${name}", or queue behind it with --wait.`,
    );
    this.name = 'SessionBusy';
  }
}

export class TmuxMissing extends AthError {
  constructor(detail: string) {
    super('tmux_missing', `tmux is required but unusable: ${detail}. Install it with: brew install tmux`);
    this.name = 'TmuxMissing';
  }
}

export class InvalidName extends AthError {
  constructor(name: string) {
    super(
      'invalid_name',
      `Invalid session name "${name}". Use letters, digits, dot, dash or underscore (max 64).`,
    );
    this.name = 'InvalidName';
  }
}
