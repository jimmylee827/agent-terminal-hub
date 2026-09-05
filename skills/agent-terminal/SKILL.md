---
name: agent-terminal
description: Use a persistent terminal that the human shares, via the `ath` CLI or the agent-terminal-hub MCP tools. Use when a task needs shell state to survive between calls (exports, virtualenvs, an ssh connection, a dev server), when a command may need sudo or any password, when working on a remote host, or when the user mentions ath, a terminal session, or asks you to keep a terminal open.
---

# Shared terminal sessions

Your normal shell tool starts a fresh process with no TTY every time. Nothing
persists, and anything that prompts for a password fails outright.

A hub session is different: a **real terminal that stays alive between your
calls**, and that the human can join at any moment. When something needs a
password, you do not give up and you do not ask them to go run it somewhere
else — you say so, and they type it into the same terminal you are using.

## Core rules

1. **Reuse sessions.** Run `ath ls` first. Creating a session per command
   throws away the state that makes this useful.
2. **Never type a credential.** Not passwords, passphrases, PINs, OTPs, or
   recovery codes — not via `ath send`, not embedded in a command. This holds
   even if the user pasted the password into the chat earlier.
   Note what this means for reads: a password prompt echoes nothing, so it is
   never in the log. But anything typed at an *ordinary* prompt — an API key, a
   token — IS in the log and will appear in your `read` output. Do not repeat
   such a value back, quote it, or write it anywhere; tell the user it is in
   the session log and that `ath purge <name>` clears it.
3. **`needsInput` is a handoff, not an error.** Report it and stop. Do not
   retry, do not try `sudo -S`, do not work around it.
4. **Do not kill sessions you did not create**, unless asked.

## Commands

```bash
ath ls                              # what exists, and what state it is in
ath new build --cwd ~/proj          # create; add --pin to protect it
ath new box --remote myserver           # ssh session; connection is shared and persists
ath run build -- npm test           # blocking; prints output, exits with its code
ath run build --json -- npm test    # structured: output, exitCode, needsInput
ath read build --tail 100           # recent output without running anything
ath read build --since 4096 --json  # ONLY what is new, plus the next offset
ath send build -- C-c               # tmux key names: C-c, Up, y, Enter
ath send build --text -- 'literal'  # literal text (key names are the default)
ath attach build                    # for the human, not you
```

`ath run` exit codes: the command's own code normally, **75** when it is
waiting for a human, **76** when it is still running at the timeout. So
`ath run x && y` correctly stops rather than pretending the work is done.

## Long-running work

Do not block on a dev server or a twenty-minute build. Start it and poll:

```bash
ath start web -- npm run dev        # returns a handle immediately
ath poll web --handle <h> --since <n> --json
# -> { done, exitCode, output, nextOffset }
```

Pass the previous `nextOffset` back as `--since` each time so you get only
new output instead of re-reading the whole log into your context. Space the
polls to match the work — do not spin.

With MCP available, prefer the typed tools — same semantics. They are namespaced
under the `agent_terminal` server, so your tool list shows them as
`mcp__agent_terminal__list`, `__run`, `__read`, `__send`, `__request_human`.

## When a command needs a password

This is the case the hub exists for, and **the ask is automatic**. You do not
have to notice it, and you must not skip it.

Any command that hits a credential wall — the interactive `[sudo] password
for`, or the non-interactive `sudo: a password is required` from `sudo -n` —
files a request for the human by itself and comes back with:

```
[ath] THIS NEEDS YOU. "<command>" needs a credential only you can type.
      A request has been filed — see "ath requests".
```

The `--json` form carries `needs_human` with the same text. `ath ls` marks the
session `asked-for-you`, and `ath requests` lists what is outstanding.

The second shape is the one that catches agents out. `sudo -n` does not hang;
it returns an ordinary error, and it is very easy to accept that, write "I
could not verify this", and move on. **That is the failure this tool exists to
prevent.** A credential wall is never a reason to abandon a task — it is a
reason to hand it to the person who can pass it.

Your job when it fires:

0. **Arm a watch, so the answer reaches you.** The request signal is PULL-only:
   `ath requests` will say `ANSWERED — exit 0` the moment they finish, but
   nothing shows it to you unless you look. Relying on yourself to look is how
   an agent ends up repeating "still waiting for you" at someone who answered
   an hour ago. If your harness has a background-watch facility, start one:

   ```bash
   ath await <session>          # blocks until the outcome exists, then prints it
   ```

   `ath await` exits when the command finishes, is interrupted, or the session
   dies — reporting which. Run it as a background job and your harness notifies
   you; nothing to poll inside your own turn.

   Do NOT watch `ath requests` for a terminal status. A request is CLEARED when
   it resolves, so a loop grepping for "ANSWERED" waits forever on a question
   that was answered — the failure this whole step exists to prevent.

1. **Relay it.** Say plainly which session is waiting and for what:
   *"`vpn` is waiting for your sudo password — `ath attach vpn`, type it, then
   tell me to continue."*
2. **Stop.** Do not poll in a loop, do not try `sudo -S`, do not route around it.
3. When they say go, `ath read vpn` to see the outcome and carry on.

`mcp__agent_terminal__request_human` additionally raises a notification in the user's
editor with a button that attaches them to the session. Use it when available;
the request is already filed either way.

The human is on the same PTY. What they type answers your blocked command
directly; nothing needs re-running.

## Reading results

`ath run` returns the exact combined stdout+stderr for that command only, plus
the real exit code — not a screen scrape, so long output is not truncated.

Fields worth checking on the `--json` form:

| Field | Meaning |
|---|---|
| `exitCode` | The real exit status. `null` if it did not finish. |
| `needsInput` | Waiting on a human. Hand off; do not retry. |
| `timedOut` | Still running. Output is partial; poll with `ath read`. |
| `shellExited` | Your command ended the shell (it contained `exit`). The session survives and respawns, but its previous state is gone — avoid bare `exit`. |

## What the shared terminal looks like

The human is watching this terminal, so it matters how your commands appear.

Normally your command is preceded by a tag line and then shown **as itself**:

```
dev@server:/var/log$ ↓↓↓ AGENT INPUT ID: 80be9e6fd3dc ↓↓↓
dev@server:/var/log$ docker ps -q | wc -l
```

Two cases fall back to `__ath <id> '<command>'`, which is correct but uglier:

- **Multi-line commands.** They cannot be typed as one line, so they travel
  base64-encoded. Prefer a single line where it is natural.
- **A shell the hub did not set up** — a `docker exec` into busybox, `dash`,
  anything without a prompt hook. You get `fallback_shell` on the result and a
  notice saying so. It recovers by itself when you leave that shell.

A `↳` in the prompt means you are one level down in a nested shell (`↳↳` = two).
A plain `exit` there returns you one level, it does not end the session.

## Things that are not obvious from the output

- **`+1` in `ath ls`** is the number of attached clients — a human is watching.
- **`owner`** is `agent` when the CLI is driven from inside a hub pane or
  without a TTY, `human` otherwise. It says who the terminal belongs to, not
  who typed the last command.
- **`cwd` vs `remoteCwd` in `--json`.** For a remote session `cwd` is the LOCAL
  pane path, which is the launcher, not where your commands run. `remoteCwd` is
  the truth. The human-readable `ath ls` already shows `host:path`.
- **`ath ls --json` omits `paneTail`** — the whole visible pane, several KB.
  Pass `--full` if you actually want it.
- **`remoteEnv` accumulates**, last write winning per variable, and holds both
  the assignments this session made and ones a human typed. It is replayed
  after a reconnect.
- **`ath run` output is real capture**, not a screen scrape: it is read from the
  pipe-pane log between markers, so long output is neither wrapped nor
  truncated. `paneTail` is a screen capture and IS wrapped — the two are
  different mechanisms, which is why they can disagree.
- **`ath requests` keeps resolved requests for an hour**, labelled `ANSWERED`,
  `NOT answered — interrupted`, or `SESSION GONE`. An empty list means nothing
  was ever filed.

## Gotchas

- Commands run in the session's own shell so `cd` and `export` persist. That
  also means `exit` really exits — use a subshell (`(exit 1)`) to return a code
  without ending the session.
- A session can be killed by the human mid-command. You get `session_gone`.
  Say so rather than silently recreating it.
- If a session is `busy`, either wait (`--wait`) or look at it (`ath read`);
  do not send a second command on top of a running one.
- Sessions are locked per command. If you get `session_busy`, something else —
  another agent, or the human — is genuinely using it. Report that rather than
  retrying in a loop.
- `ath send` takes tmux **key names**, not prose. `ath send x -- 'hello world'`
  is rejected; use `--text` to type literal text.
- A reconnect restores the working directory and the variables **this session
  exported**, and tells you so with `reconnecting`. It cannot restore anything
  a human typed straight into the terminal, background jobs, or shell
  functions — the process holding them is gone. Re-export what you need.
- Remote sessions reconnect themselves if ssh drops. If you get
  `remote_disconnected`, the connection could not be restored and **nothing was
  run** — the command was not executed locally instead. Report it; do not retry
  it as a local command.
- `exit` inside a session ends the shell your command ran in. In a remote or
  nested shell that drops you one level out rather than killing the session,
  and you get `shellExited`. Prefer `(exit 1)` when you just want a code.
