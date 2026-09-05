import type { SessionState } from './types';

/** Commands that mean "a shell is sitting at its prompt". */
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'xonsh']);

/**
 * Commands that routinely stop to ask a human for something. Their presence is
 * corroborating evidence, not proof — `ssh host ls` never prompts. This is one
 * half of the dual signal; the text match below is the other.
 */
export const INTERACTIVE_COMMANDS = new Set([
  'sudo',
  'ssh',
  'gpg',
  'su',
  'doas',
  'op',
  'vault',
  'mysql',
  'psql',
  'scp',
  'sftp',
  'passwd',
  'security',
  'ansible-playbook',
  'kinit',
  'openconnect',
  'docker-credential-osxkeychain',
]);

/**
 * Prompts that mean a human must type something. Anchored to the end of the
 * last non-empty line, because a prompt is by definition what the terminal is
 * waiting on — matching mid-scrollback would fire on historical output.
 */
/**
 * The subset of prompts where whatever you type BECOMES a credential.
 *
 * Typing into one of these is not merely unhelpful, it is a failed
 * authentication attempt — and three of those can lock an account or alert a
 * security system. `run()` is already safe here, because it refuses a session
 * that is waiting on input; the exposure is the operator path that exists
 * precisely to answer prompts.
 */
const CREDENTIAL_PROMPT_PATTERNS: RegExp[] = [
  /password[^\n]{0,160}:\s*$/i,
  /passphrase[^\n]{0,160}:\s*$/i,
  /\[sudo\][^\n]{0,160}:\s*$/i,
];

/** True when the pane's last line is asking for a secret. */
export function looksLikeCredentialPrompt(paneText: string): boolean {
  const lastLine = paneText
    .split('\n')
    .filter((line) => line.trim() !== '')
    .pop();
  if (lastLine === undefined) return false;
  return CREDENTIAL_PROMPT_PATTERNS.some((re) => re.test(lastLine));
}

const PROMPT_PATTERNS: RegExp[] = [
  // The bounds are generous because these run against UNWRAPPED text: an ssh
  // passphrase prompt carries a full key path, easily 70+ characters between
  // the keyword and the colon. A tight bound silently misses exactly the
  // prompts that matter most.
  /password[^\n]{0,160}:\s*$/i,
  /passphrase[^\n]{0,160}:\s*$/i,
  /\[sudo\][^\n]{0,160}:\s*$/i,
  /\(y(?:es)?\/n(?:o)?\)[^\n]{0,8}$/i,
  /\[y\/n\][^\n]{0,8}$/i,
  // Unambiguous generic prompts. Kept deliberately narrow: a bare trailing
  // ": " would also match "Downloading: " from a command that is merely busy,
  // and calling that `needs-input` would park a running job forever.
  /\bpress (?:any key|enter|return)\b[^\n]{0,24}$/i,
  /\bare you sure\b[^\n]{0,24}$/i,
  /\b(?:overwrite|replace|continue|proceed)\?[^\n]{0,8}$/i,
  /\(default:[^)\n]{0,40}\)\s*$/i,
  /\bare you sure[^\n]{0,32}$/i,
  /\bdo you want to continue[^\n]{0,32}$/i,
  /verification code[^\n]{0,80}:\s*$/i,
  /\b(?:one[- ]time|otp)[^\n]{0,24}:\s*$/i,
  /\busername:\s*$/i,
  /\blogin:\s*$/i,
  /enter [^\n]{0,80}(?:code|pin|token|key)[^\n]{0,80}:\s*$/i,
  /press (?:enter|return|any key)[^\n]{0,32}$/i,
  /\byes\/no(?:\/\[fingerprint\])?\)?\?\s*$/i,
];

/**
 * Extra commands the user knows to be interactive.
 *
 * The escape hatch for the strictness `couldBePrompting` imposes: a vendor CLI
 * like `gh auth login` or `aws configure` prompts, but is not in the shipped
 * set, so `run()` will not return early for it. Naming it here restores that
 * without loosening the rule for everything.
 */
let extraInteractive = new Set<string>();

export function setExtraInteractiveCommands(commands: string[]): void {
  extraInteractive = new Set(commands.map((c) => c.trim()).filter(Boolean));
}

/** User-supplied extra patterns, contributed by the VSCode setting. */
let extraPatterns: RegExp[] = [];

export function setExtraPromptPatterns(sources: string[]): void {
  extraPatterns = [];
  for (const source of sources) {
    try {
      extraPatterns.push(new RegExp(source, 'i'));
    } catch {
      /* a bad user regex must not break classification */
    }
  }
}

export function isShell(command: string): boolean {
  return SHELLS.has(command.replace(/^-/, ''));
}

/**
 * The trailing non-empty lines, plus their concatenations.
 *
 * A terminal hard-wraps a long prompt across several lines without inserting
 * any character, so `Enter passphrase for key '/very/long/path/id_rsa':`
 * arrives as two lines ending in `kvm_rsa':` — which matches nothing. Testing
 * the joins as well as the individual lines recovers the original text. This
 * is not hypothetical: an attached client narrows the pane (`window-size
 * latest`), so prompts wrap precisely when a human is watching.
 */
function tailCandidates(paneTail: string, paneWidth: number, depth = 3): string[] {
  const lines = paneTail
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '');
  if (lines.length === 0) return [];

  const width = paneWidth > 0 ? paneWidth : 80;
  const last = lines[lines.length - 1] ?? '';
  const candidates: string[] = [last];

  // Walk backwards only through lines that FILLED the pane. A line shorter
  // than the width ended because its text ended, so the line before it is a
  // separate line and must not be glued on.
  //
  // Joining unconditionally is wrong in a way that took a regression to see:
  // output reading `Do you want to continue?` followed by the shell prompt
  // joins into something matching the confirm pattern, so every finished
  // command with question-shaped output reports as waiting for a human.
  let accumulated = last;
  for (let i = lines.length - 2; i >= Math.max(0, lines.length - depth); i--) {
    const previous = lines[i] ?? '';
    if (previous.length < width) break;
    accumulated = previous + accumulated;
    candidates.push(accumulated);
  }
  return candidates;
}

export function looksLikePrompt(paneTail: string, paneWidth = 0): boolean {
  const candidates = tailCandidates(paneTail, paneWidth);
  if (candidates.length === 0) return false;
  const patterns = [...PROMPT_PATTERNS, ...extraPatterns];
  return candidates.some((text) => patterns.some((re) => re.test(text)));
}

export interface ClassifyInput {
  paneDead: boolean;
  currentCommand: string;
  /** Visible pane content, as returned by capture-pane. */
  paneTail: string;
  /** Pane width in columns; used to tell a hard-wrapped line from a real one. */
  paneWidth?: number;
}

/**
 * Commands that hand the pane to *another* shell.
 *
 * For these, `pane_current_command` is stuck on the outer process forever —
 * an ssh session sitting idle at `dev@host:~$` still reports `ssh`. Judging
 * such a pane by the command name alone marks it busy for its whole life, so
 * `run()` refuses every command and the session is unusable. For these, and
 * only these, the shape of the pane text is the better signal.
 */
export const NESTING_COMMANDS = new Set([
  'ssh',
  'mosh',
  'sshpass',
  'docker',
  'podman',
  'kubectl',
  'nerdctl',
  'lima',
  'colima',
  'distrobox',
  'toolbox',
  'nsenter',
  'chroot',
  'su',
  'sudo',
  'tmux',
  'screen',
]);

/**
 * Whether the pane is still inside a nested shell (ssh, docker exec, …).
 *
 * For a session created with `--remote`, this going false means the connection
 * dropped and the pane has fallen back to the LOCAL shell. Commands sent then
 * run on the wrong machine while every label still says "remote", so this is
 * checked before running anything rather than merely displayed.
 */
export function isNesting(currentCommand: string): boolean {
  return NESTING_COMMANDS.has(currentCommand);
}

/**
 * A shell prompt awaiting a command, e.g. `dev@server:~$`, `root@box:/#`, `… %`.
 *
 * Deliberately only consulted for `NESTING_COMMANDS`. Applied everywhere it
 * would misread a working command whose output happens to end in `$` as idle,
 * and `run()` would then fire a second command on top of a running one.
 */
export function looksLikeShellPrompt(paneTail: string): boolean {
  const lines = paneTail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trimEnd();
    if (line.trim() === '') continue;
    return /(?:^|\s)[^\s]*[$#%>]\s*$/.test(line);
  }
  return false;
}

/**
 * Decide what a session is doing.
 *
 * `needs-input` requires TWO corroborating signals: prompt-shaped text AND a
 * foreground process known to ask humans things. Text alone used to be enough,
 * which made `echo "Do you want to continue?"; sleep 8` report as waiting —
 * raising a notification and, worse, making `run()` refuse the session as busy
 * while nothing was actually waiting.
 *
 * The cost of requiring corroboration is that a prompt from a command outside
 * `INTERACTIVE_COMMANDS` is not caught here. That case is deliberately handled
 * by staleness instead — `refineWithHistory` for the watcher, and the poll loop
 * in `run()` — because "output stopped moving at a prompt-shaped line" is real
 * evidence, whereas the text alone is not.
 */
export function classify({
  paneDead,
  currentCommand,
  paneTail,
  paneWidth = 0,
}: ClassifyInput): SessionState {
  if (paneDead) return 'dead';
  if (looksLikePrompt(paneTail, paneWidth) && couldBePrompting(currentCommand)) return 'needs-input';
  if (isShell(currentCommand)) return 'idle';
  // A nested shell (ssh, docker exec, sudo -i) sitting at its own prompt.
  if (NESTING_COMMANDS.has(currentCommand) && looksLikeShellPrompt(paneTail)) return 'idle';
  return 'busy';
}

/**
 * Whether this foreground process could plausibly be asking a human something.
 *
 * A shell counts because `read` is a builtin: a script or a user running
 * `read -p "token: "` leaves the foreground command as `zsh`. That does not
 * make an idle shell look busy, because an ordinary PS1 (`… %`, `… $`) matches
 * none of the prompt patterns — only an actual question does.
 *
 * Shared by the classifier and by `run()`'s early return so the GUI and the
 * agent never disagree about whether a session is waiting on someone.
 */
export function couldBePrompting(currentCommand: string): boolean {
  return (
    INTERACTIVE_COMMANDS.has(currentCommand) ||
    extraInteractive.has(currentCommand) ||
    isShell(currentCommand)
  );
}

/**
 * Second-pass refinement for callers that track history (the watcher).
 *
 * An interactive command whose output has not moved for a while is almost
 * certainly parked on a prompt we do not have a pattern for — a custom
 * `read -p`, a vendor CLI, a localized prompt. Catching these is the whole
 * point of the process-based half of the dual signal.
 */
export function refineWithHistory(
  state: SessionState,
  currentCommand: string,
  msSinceOutputChanged: number,
  stallMs = 1500,
  paneTail = '',
  paneWidth = 0,
): SessionState {
  if (state !== 'busy') return state;
  if (msSinceOutputChanged < stallMs) return state;

  // Either signal is enough once output has genuinely stopped moving: a known
  // interactive command, or prompt-shaped text from anything else. Requiring
  // both here would re-blind us to the custom prompts this exists to catch.
  if (INTERACTIVE_COMMANDS.has(currentCommand)) return 'needs-input';
  if (paneTail && looksLikePrompt(paneTail, paneWidth)) return 'needs-input';
  return state;
}
