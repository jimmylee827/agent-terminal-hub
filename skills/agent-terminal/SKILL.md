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
   Note what this means for reads: a password prompt echoes nothing, so a
   password is never in the log and there is nothing to purge after a sudo
   handoff. But anything typed at an *ordinary* prompt — an API key, a
   token — IS in the log and will appear in your `read` output. Do not repeat
   such a value back, quote it, or write it anywhere; tell the user it is in
   the session log and that `ath purge <name>` clears it.
3. **`needsInput` is a handoff, not an error.** Report it and stop. Do not
   retry, do not try `sudo -S`, do not work around it.
   When you come back, note that **an exit code cannot tell you a human
   answered.** Only exit 0 says the command did what it was asked; any other
   code is ambiguous between a wrong password, an interrupt (sudo traps SIGINT
   and exits 1, so it never looks like 130), and the command simply failing.
   The hub reports the code and refuses to interpret it — do the same, and
   confirm elevation with `sudo -n true` before relying on it.
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

**`start` is non-blocking for YOU, not concurrent for the session.** The
session is busy until that command finishes, and anything else you send there
fails with `session_busy`. To do other work meanwhile, **create a second
session** — `--wait` queues behind the job rather than running alongside it,
which is the opposite of what you want.

Do not test this with a command that finishes quickly. A job that ends in a
second leaves the session idle again before you look, which reads as "the
session stayed usable" and is how you end up building on the wrong model.

With MCP available, prefer the typed tools — same semantics. They are namespaced
under the `agent_terminal` server: `mcp__agent_terminal__list`, `__new`, `__run`,
`__start`, `__poll`, `__read`, `__send`, `__request_human`, `__requests`,
`__await_human`, `__kill`. The whole credential handoff can be driven from MCP
alone — `__requests` to see what is outstanding, `__await_human` instead of
polling in a loop.

The offset you pass back when polling is per SESSION, not per handle. It keeps
climbing across jobs, so hand back whatever you were last given rather than
assuming a new job starts at zero. (The CLI calls it `nextOffset`; the MCP
tools use the snake_case spelling.)

## When a command needs a password

This is the case the hub exists for, and **the ask is automatic**. You do not
have to notice it, and you must not skip it.

The two shapes are handled differently, and the difference matters:

- **It PARKS at a prompt** (`[sudo] password for …`). The command is still
  alive, waiting. A request is filed automatically and the human is notified —
  what they type answers *this* command directly.
- **It was REFUSED without prompting** (`sudo: a password is required` from
  `sudo -n`). The command has already exited, so there is nothing for anyone to
  answer. No request is filed, and none should be: a person who accepts a
  notification and attaches would find an idle shell. You are told instead, and
  the move is yours — re-run it interactively so it parks, then relay.

An interactive credential wall comes back with:

```
[ath] THIS NEEDS YOU. "<command>" needs a credential only you can type.
      A request has been filed — see "ath requests".
```

That banner is the **CLI** form. The `--json` form carries `needs_human` with
the same text, and the **MCP** tools return `human_requested: true` plus a
`what_to_do` saying the request is already filed. Whichever surface you are on,
the result itself tells you — you should never have to check `ath requests` to
discover that a request exists. If the result says nothing, none was filed.

`ath ls` marks the session `asked-for-you` while a request is outstanding, and
stops once the command it describes has finished. `ath requests` lists what is
still open, and keeps recently-resolved ones visible with their exit code so
you can collect an answer you were told about a moment earlier.

**Do not discard stderr on a NON-INTERACTIVE privileged command.** With `-n`
(or `--batch`, `BatchMode=yes`) there is no prompt to park on, and the only
signal is `a password is required` on stderr — so `sudo -n … 2>/dev/null`
deletes the evidence before the hub can see it: no request, nobody asked, and an
ordinary-looking success for a command that never ran. `2>&1` keeps the text.

An *interactive* `sudo … 2>/dev/null` is fine: sudo writes its prompt to
`/dev/tty`, not stderr, so it still parks and still files a request. The hub
warns only about the first case — an earlier version warned about both, which
is how a warning gets ignored on the occasion it matters.

**The sudo timestamp is per session, and it persists inside that session.**
Two halves, and the second one changes how you should work:

- Separate sessions are separate TTYs (`tty_tickets` is on by default), so a
  password typed in one session does NOT cover another. Keep privileged work in
  one session rather than making the human type it twice.
- Within that session the timestamp is cached for about 15 minutes, so
  **subsequent `sudo` commands run without prompting again**. Check with
  `sudo -n true` before assuming either way.
- **Elevation does not cross sessions, and `start` occupies a session.** Those
  two facts together mean you cannot run a privileged command in parallel with
  other work without asking for a second password. Plan for it: keep ONE
  privileged session and put every `sudo` there, and make any parallel sessions
  unprivileged. Discovering this halfway through costs the user an extra prompt.
- To warm it deliberately, run **`sudo -v`** first. That parks on the prompt
  and does nothing else, so you can ask once, up front, before you know exactly
  which privileged commands you will need — rather than discovering it
  mid-investigation and interrupting the person again.

Do NOT read "make them type it once" as "batch everything into one big script".
That was a real cost: an agent bundled nine lines into a single privileged
heredoc to save a second prompt, baked a wrong flag into it, and reported a
disk figure that was off by 20 GB. During exploration you do not know what you
need until you have seen the previous answer. Ask once, then keep asking small
questions while the timestamp holds.

**What counts as a credential prompt.** Detection is pattern-based on the last
line of the pane, not magic, so it is worth knowing the shape of it:

| Prompt | Session parks | Refuses typing |
| --- | --- | --- |
| `[sudo] password for …:` | yes | yes |
| `Enter passphrase for key …:` | yes | yes |
| `Password for 'https://…':` | yes | yes |
| `Enter API key:` / `Enter your access token:` | yes | yes |
| `API key:` / `Access token:` (bare label) | yes | yes |
| `Verification code:` / OTP | yes | yes |
| `Username for 'https://…':` (git) | yes | no — it is not a secret |
| `Downloading:` and other progress | no | no |

Anything it does not recognise will simply hang rather than being answered
wrongly, so an unusual prompt costs you a timeout, not a leaked secret. If you
hit one, say so — the pattern list is meant to grow.

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

   The MCP `await_human` tool is the same idea but **bounded**, because an MCP
   call is synchronous: it waits a short while and, if nobody has answered yet,
   returns `outcome: "still_waiting"`. That is NOT a failure and the request
   stays open — say what you need and stop, rather than calling it again in a
   loop. To check later whether an answer landed, `poll` the command's handle:
   its exit code is the answer. `requests` listing nothing means none was ever
   filed, not that one was answered.

   Read the exit code, not just the text. `0` or the command's own code means
   answered; `130`/`143` mean interrupted, NOT answered; `2` means nothing was
   pending to wait for; `3` means it is no longer waiting and the outcome
   cannot be proved from here — check with `ath read` before assuming either
   way. `3` is not a failure of the command you ran; treating it as one is how
   you end up asking a person to answer something twice.

   Do NOT poll `ath requests` in a loop waiting for an answer. It is a pull-only
   view: it tells you the state when you look, and looking repeatedly burns your
   turn doing nothing. Arm the watch above instead — that is the whole point of
   this step. (Resolved requests ARE retained for an hour with their exit code,
   so a look after the fact does find them; an earlier version cleared them
   immediately, which is why older advice says a loop waits forever.)

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
- `needs_human` is NOT `session_busy`, and `--wait` is the wrong response to
  it. The session is stopped at a prompt only a person can answer, so nothing
  moves until they answer it — waiting just burns your timeout while the human
  has not been told. Relay it (step 1 above) and stop. Nothing you send can
  answer it: whatever you type lands in the password field as a failed login
  and consumes the prompt they were walking over to answer.
- `attached` / `attached_clients` counts tmux CLIENTS, not people. The VS Code
  panel attaches one per session it displays, so a session nobody has touched
  commonly shows 1. Use it to know someone *could* be watching, never as proof
  a human is present.
- Timing is exact only while a command is RUNNING. Once it has finished the hub
  can only bracket it — it never sees the instant a command ends, just when
  something looked — so it reports a bound if you polled while the job ran, and
  reports nothing at all if you did not. A withheld number is deliberate: an
  earlier version guessed, and a 47-second job came back as 256. If you need a
  real duration, time the command itself.
- **If the ssh connection drops**, the session does not die and does not hang.
  The next command reconnects automatically and comes back with
  `reconnecting: true` — the working directory and anything this session
  *exported* are restored. Background jobs, shell functions and unexported
  variables are NOT: they lived in the process the dropped link took with it,
  so re-export what you need. If the link cannot be restored you get
  `remote_disconnected` and **nothing is sent** — a keystroke meant for the
  remote host is never typed into your local shell.
- The reported exit code is the status of the LAST command on the line. `a; b`
  reports b's, and a pipeline reports its last stage's — so `sudo -n true; echo
  done` looks successful and `… | grep -c` looks failed. The hub flags this
  whenever it sees `;` or `|`, but read the output rather than trusting the
  number.
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
