/**
 * tmux key names that `send-keys` understands without `-l`.
 *
 * Used to reject prose before it is silently mangled: `ath send x -- 'hello
 * world'` used to be split on whitespace into two "keys" and arrive as
 * `helloworld`, losing the space with no warning.
 */
const NAMED_KEYS = new Set(
  [
    'Enter', 'Escape', 'Space', 'Tab', 'BTab', 'BSpace', 'Backspace',
    'Up', 'Down', 'Left', 'Right',
    'Home', 'End', 'PageUp', 'PPage', 'PageDown', 'NPage',
    'Insert', 'IC', 'Delete', 'DC',
    'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  ].map((k) => k.toLowerCase()),
);

/** `C-c`, `M-x`, `S-Up`, and combinations thereof. */
const MODIFIER_RE = /^(?:[CMS]-)+(.+)$/;

export function isKeyName(token: string): boolean {
  const modified = MODIFIER_RE.exec(token);
  const base = modified?.[1] ?? token;
  if (NAMED_KEYS.has(base.toLowerCase())) return true;
  // A single character is a valid key; more than one is prose.
  return [...base].length === 1;
}

export function invalidKeys(tokens: string[]): string[] {
  return tokens.filter((token) => !isKeyName(token));
}
