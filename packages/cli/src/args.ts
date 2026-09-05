export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
  /** Everything after a bare `--`, joined. This is the user's shell command. */
  rest: string;
}

/**
 * Minimal parser, deliberately dependency-free.
 *
 * The one rule that matters: everything after a bare `--` is passed through
 * untouched. A command like `ath run build -- ls -la | grep x` must reach the
 * session exactly as typed, so no flag parsing may happen past that point.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] ?? 'help';
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let rest = '';

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i] ?? '';

    if (arg === '--') {
      rest = argv.slice(i + 1).join(' ');
      break;
    }

    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) {
      const body = arg.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[body] = next;
        i++;
      } else {
        flags[body] = true;
      }
      continue;
    }

    positional.push(arg);
  }

  return { command, positional, flags, rest };
}

export function flagString(
  flags: Record<string, string | boolean>,
  name: string,
  fallback?: string,
): string | undefined {
  const value = flags[name];
  if (typeof value === 'string') return value;
  return fallback;
}

export function flagNumber(
  flags: Record<string, string | boolean>,
  name: string,
  fallback: number,
): number {
  const value = flags[name];
  if (typeof value === 'string') {
    const n = Number(value);
    if (!Number.isNaN(n)) return n;
  }
  return fallback;
}

export function flagBool(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true || flags[name] === 'true';
}
