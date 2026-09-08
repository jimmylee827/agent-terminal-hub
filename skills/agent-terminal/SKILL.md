---
name: agent-terminal
description: Use a persistent terminal that the human shares, via the `ath` CLI or the agent-terminal-hub MCP tools. Use when a task needs shell state to survive between calls (exports, virtualenvs, an ssh connection, a dev server), when a command may need sudo or any password, when a command may run long or hang and you would want to watch it, interrupt it, or answer a prompt it raises (builds, installs, migrations, `docker exec`, anything interactive), when working on a remote host, or when the user mentions ath, a terminal session, or asks you to keep a terminal open.
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
   the session log and that `ath purge <name>` clears it. Say plainly that
   purge clears the transcript **only** — see "What this leaves on disk".
3. **`needs_input` is a handoff, not an error.** Report it and stop. Do not
   retry, do not try `sudo -S`, do not work around it.
   When you come back, note that **an exit code cannot tell you a human
   answered.** Only exit 0 says the command did what it was asked; any other
   code is ambiguous between a wrong password, an interrupt (sudo traps SIGINT
   and exits 1, so it never looks like 130), and the command simply failing.
   The hub reports the code and refuses to interpret it — do the same, and
   confirm elevation with `sudo -n true` before relying on it.
4. **Plan the session layout before your first command.** Two facts combine
   into one rule, and discovering it halfway through costs the user an extra
   password prompt: elevation does not cross sessions (the sudo timestamp is
   per-tty), and `start` occupies a session for as long as its command runs.
   So: **one session for everything privileged, plus one more per long job you
   want to run alongside it.** A typical audit is two — `work` and `bulk`.
   Create them up front. Deciding later means a second prompt for the human.
5. **Do not kill sessions you did not create**, unless asked.

## Which surface to use

**If the `agent_terminal` MCP tools are in your tool list, use them.** Same
semantics, typed arguments, no shell quoting: `list`, `new`, `run`, `start`,
`poll`, `read`, `send`, `wait`, `request_human`, `requests`, `await_human`,
`kill`.
Reach for the `ath` CLI only when MCP is not registered, or for `attach`,
`purge`, `doctor` and `watch`, which have no MCP equivalent by design.

The examples below are written in CLI syntax because it is the more compact
form to read. **Both surfaces use the same field names** — `exit_code`,
`needs_input`, `timed_out`, `next_offset`, `log_offset`, `last_command`,
`pane_width` — so nothing needs translating as you read. (They diverged once,
CLI camelCase against MCP snake_case, and this file carried a mapping table;
an agent noted that a table "means the doc knows this is a cost and passes it
to me anyway". Both now serialise through one function.)

MCP results additionally carry fields the CLI prints as prose rather than data:
`what_to_do`, `parallel_work`, `exit_code_covers`, `took_seconds`,
`human_requested`, `recorded_to`, `warning`. Read `what_to_do` first when it is
present — it is the instruction, and the rest is context for it.

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

**Check that it started.** A shell without the hub's helper — a nested shell,
a reconnected remote — answers the wrapper with `__ath: command not found`,
and the command never runs. `start` used to hand back a handle anyway, so that
looked exactly like success and the handle could never complete. It now
reports `launched: false` (the CLI prints `sent … (unconfirmed)` instead of
`started`). If you see it, read the session before polling — and do **not**
just send it again: if the session was merely slow, the command is queued and
re-sending runs it twice.

Pass the previous `next_offset` back as `--since` each time so you get only
new output instead of re-reading the whole log into your context. Space the
polls to match the work — do not spin. Every `read` returns a `next_offset`,
including one with no `--since`, so that is where your first one comes from.

**Output is capped, and the cap paginates.** A job printing megabytes would
otherwise hand you all of them in one call, and you cannot know you wanted
less until it has arrived. `poll` and `read --since` return at most 64 KB by
default: a head, then a marker, then the tail. What the *cap* leaves out is
still on disk — the marker and the `omitted_resume_from` field both name the
`since` that returns it. `next_offset` still points at the end, so an ordinary
follow loop just carries on.

**But the transcript is not durable storage, and above 32 MB it really does
lose data.** The session log is rewritten to its last 8 MB once it passes
32 MB. Anything older is gone for good — no offset brings it back. This
paragraph used to say "nothing is lost" without that qualification, and an
agent following a 46 MB job believed it: it polled at the offset the hub had
given it, and ~38 MB of its results no longer existed.

You are told when it happens now — `lost_bytes` with a note, or a red line
from the CLI — and offsets survive a trim rather than breaking on one, so the
follow loop keeps working. That is damage reporting, not a fix.

**So for a job whose output you actually need, write it to a file on the host
and read the file.** Use the session to watch progress and get the exit code:

```sh
ath start bulk -- 'big-job > /tmp/run.out 2>/tmp/run.err; echo done'
ath read bulk --tail 3                      # progress, bounded, any volume
ath wait bulk --handle <h> --timeout 60     # finish, exact
ath run bulk -- 'wc -l /tmp/run.out; tail -20 /tmp/run.out'   # the real output
```

The other two ways to read, when the transcript is the right place:

```sh
ath poll bulk --handle <h> --since <n>                 # incremental + exit code
ath poll bulk --handle <h> --since <n> --max-bytes 0   # opt out of the cap
```

**Keep the handle, and give it to `wait`.** A session running a shell SCRIPT
looks idle: the pane reports its foreground process, and `brew install`,
`./configure`, `rustup` and `nvm` all run as `bash`. So `ath ls` will say
`idle` in the middle of a build, and that is not a bug you can fix by looking
harder at the pane. `wait` and `poll` settle it from the command's own exit
marker instead — but only `poll`, and `wait --handle`, are given the handle
that makes the answer exact:

```sh
ath wait web --handle <h> --timeout 60    # exact: waits for THIS command
ath wait web --timeout 60                 # best-effort, no handle to check
```

Given the handle, `wait` also returns that command's **own** `exit_code` and
`took_seconds` when it reports `idle` — so the usual "did it work, and how
long?" needs no follow-up `poll`. Without a handle you get `last_exit_code`,
which is the SESSION's last recorded code and may belong to something else.

**Without the handle, treat an `idle` from `wait` as a guess.** The check
scans the tail of the log for the command's markers, and a command that prints
a lot pushes its own start marker out of that window — so the answer falls
back to the pane, which is the thing that was wrong to begin with. Installers
and builds are exactly the chatty case, so this is the norm for them, not a
corner. When that happens `wait` says so: the MCP result carries
`verified: false` with an `unverified_because`, and the CLI prints an
`unverified` note. **Do not treat an unverified `idle` as "the build finished"
— re-run with the handle.**

Exit **76** (MCP `still_running`) means still running. It is not a failure, and
calling again is the right response.

**A resize is reported to `poll` too, not just `run`.** A human attaching sets
the pane size — usually to answer the prompt your job raised — and width-aware
tools (`ps`, `docker ps`, `lsblk`) format themselves to it. `pane_width_changed`
now arrives on every poll while it differs, so you learn mid-job rather than
after. The long explanation is given once per session; the short marker keeps
coming.

Watch for `from` equal to `to` with a `seen` list. That means the pane moved
**and moved back** between looks: comparing before and after shows no change,
but output written in between was formatted to a different width. It is the one
case a width check cannot catch by sampling, and the reason the full sequence
is reported at all.

**A dropped ssh link ends the command.** For a `--remote` session, losing the
connection does not kill the pane — it falls back to the LOCAL shell — so the
command is gone but nothing looks dead. `poll` reports `remote_disconnected`
with `done: true` and a **null** exit code, because the command's outcome is
genuinely unknowable. Do not keep polling that handle; it can never complete.
Reconnect by running any command, then check on the host whether the work
actually finished before re-running it. (This used to report `done: false`
with the elapsed time climbing indefinitely — an agent watched it call a job
that had died eight minutes earlier "running for 516 seconds".)

**`start` is non-blocking for YOU, not concurrent for the session.** The
session is busy until that command finishes, and anything else you send there
fails with `session_busy`. To do other work meanwhile, **create a second
session** — `--wait` queues behind the job rather than running alongside it,
which is the opposite of what you want.

Do not test this with a command that finishes quickly. A job that ends in a
second leaves the session idle again before you look, which reads as "the
session stayed usable" and is how you end up building on the wrong model.

The offset you pass back when polling is per SESSION, not per handle. It keeps
climbing across jobs, so hand back whatever you were last given rather than
assuming a new job starts at zero. (The CLI calls it `next_offset`; the MCP
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

The whole handoff can be driven from MCP alone: `request_human` to raise the
editor notification, `requests` to see what is outstanding, and `await_human`
instead of polling in a loop.

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
- Within that session the timestamp is cached, so subsequent `sudo` commands
  usually run without prompting again. **You cannot know for how long, and you
  must not plan around it.** The lifetime is a local `sudoers` setting
  (`timestamp_timeout`) that differs from machine to machine — the two hosts
  this tool was developed against are set to 5 and 15 minutes — and a site can
  set `0`, meaning every command prompts.

  This file used to name a single figure as though it were a property of the
  hub. An agent read it, laid out its whole session plan around it, confirmed
  elevation with `sudo -n true`, and had the very next privileged command ask
  for a password anyway — an extra interruption for its human, bought with a
  number this tool was never in a position to promise.

  So: confirm with **`sudo -n true` immediately before** each privileged
  command you rely on. Never infer elevation from elapsed time.
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
| `exit_code` | The real exit status. `null` if it did not finish. |
| `needs_input` | Waiting on a human. Hand off; do not retry. |
| `timed_out` | Still running. Output is partial; poll with `ath read`. |
| `shell_exited` | Your command ended the shell (it contained `exit`). The session survives and respawns, but its previous state is gone — avoid bare `exit`. |

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
- **`cwd` vs `remote_cwd` in `--json`.** For a remote session `cwd` is the LOCAL
  pane path, which is the launcher, not where your commands run. `remote_cwd` is
  the truth. The human-readable `ath ls` already shows `host:path`.
- **`ath ls --json` omits `pane_tail`** — the whole visible pane, several KB.
  Pass `--full` if you actually want it.
- **`remote_env` accumulates**, last write winning per variable, and holds both
  the assignments this session made and ones a human typed. It is replayed
  after a reconnect.
- **`ath run` output is real capture**, not a screen scrape: it is read from the
  pipe-pane log between markers, so long output is neither wrapped nor
  truncated. `pane_tail` is a screen capture and IS wrapped — the two are
  different mechanisms, which is why they can disagree.

  **Your output cannot impersonate a marker.** Every real marker is wrapped in
  a control byte the shell never emits by accident, so a command that prints
  `<ATHE:deadbeefcafe:99:…>` — deliberately or from a log it is echoing — is
  passed through as ordinary output and the real exit code still wins. Print
  whatever you like; you cannot end your own command early or forge its status.
- **`ath requests` keeps resolved requests for an hour**, labelled `ANSWERED`,
  `NOT answered — interrupted`, or `SESSION GONE`. An empty list means nothing
  was ever filed.

## Questions the rest of this file kept raising

Four things a cold agent worked out it could not answer from the docs. The
answers are cheap to state and each one changes a decision.

**A command can be both timed out and parked.** `timed_out` and `needs_input` are
independent flags, not a choice. If a command parks at a prompt one second
before its timeout you get **both** true — and the human request is still filed,
because parking is what files it. Act on `needs_input` first: a timeout you can
retry, a prompt you cannot. Only `timed_out` alone means "still running".

**A prompt has to be quiet to count.** Detection is pattern-based over the last
pane line, unwrapped first so a hard-wrapped line is not mistaken for two. But a
match alone is not enough — output must go quiet for **1.2 s** before a
prompt-shaped line is treated as parked. So a command printing a prompt-like
string in a stream of output does not trip it, and a genuinely slow command is
never mistaken for a parked one unless it also stops printing.

**`took_seconds` is measured by the shell that ran the command, not estimated
by the hub.** It is exact and does not depend on how often you polled — a
44-second job polled once, ten seconds late, still reports 44.

The old estimate is still there as a fallback, and you can tell them apart: an
exact figure arrives as `took_seconds`, a fallback as `ran_between_seconds`
with a `timing_note` saying so. You will only see the fallback where the remote
shell has no `date`. If you do get a bracket, treat it as "when the hub
looked", not as a duration — its upper bound is the first moment *any* code
path noticed the command had finished, which may be the editor's watcher rather
than your own call, so it can be far wider than your polling interval.

**Two remote sessions to the same host share one ssh connection, not one
shell.** `ControlMaster` keeps a single TCP connection per host, so the second
session costs no handshake — but each gets its own channel and its own TTY.
That is why the sudo timestamp does *not* carry across them and each needs its
own password. One connection, two terminals.

## What this leaves on disk

Every session is recorded. `pipe-pane` appends **everything printed in the
pane** — your commands, your output, and the human's, whether or not you read
it — to `~/.ath/log/<session>.log`. It outlives the session, the agent and the
editor. Nothing rotates it until 32 MB.

Tell the user this exists when it matters (before they type a secret at an
echoing prompt, or after they already have). Do not treat `kill` as cleanup.

`ath purge <name>` truncates **that one transcript**, and nothing else. Two
things survive it and still describe what happened:

| survives purge | holds |
| --- | --- |
| `~/.ath/requests/` | the reason text of each human request — it **quotes the command** |
| `~/.ath/rc/` | exit codes and timings per command. No command text. Reaped after 6h |

`ath doctor --artifacts` prints the full list of ten, with sizes and what each
one is bounded by. Use it when the human asks what the hub left behind; do not
guess from this table, which names only the two that matter most.

A password prompt is the one safe case: it echoes nothing, so the password is
in no file, and there is nothing to purge after a sudo handoff.

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
- Timing is measured by the shell, so it is exact and independent of your
  polling. Three earlier versions of this field were estimates and all three
  were badly wrong — a 47-second job reported as 256, and a 44-second job as
  `[38, 185]` — which is why it now comes from the machine that ran the command
  rather than from anything the hub observed.
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
- **The TTY that makes `sudo` work also changes program output.** Commands run
  under a real terminal, so tools that adapt to one behave differently than they
  would in a pipe — and it happens even when you redirect to a file. A real
  case: `vmstat 1 45 > out.txt` reprinted its column header four times mid-
  capture; an `awk` average parsed those rows as zeros and moved idle CPU by
  eight points. The numbers looked entirely plausible.

  This is inherent to the design, not a bug, and nothing detects it. When you
  intend to PARSE output, defend against it: prefer a machine format
  (`--json`, `-o` fields, `--no-headers`), sanity-check that totals add up, or
  filter the repeats (`grep -v '^ *r '`). Anything width- or height-aware —
  `vmstat`, `iostat`, `ps`, `docker ps`, `column`, `top` — can do this.
- **The pane width can CHANGE BETWEEN TWO CALLS, so output shape is not stable
  within one session.** This is the part that catches people: it is not that
  the pane is narrow, it is that it does not stay the same. The terminal is
  shared, and a human attaching resizes it — `window-size latest` is deliberate,
  because a person should not be handed a pane wrapped to someone else's
  dimensions. So a column layout you calibrated on one call can silently differ
  on the next, with nothing announcing the change.

  One agent watched `lsblk` print `MOUNTPOIN`, reported a truncation defect,
  then re-measured and found the pane at 156 columns printing `MOUNTPOINT` in
  full — the width had moved underneath it because someone attached in between.
  It was right the first time about what it saw and wrong about why.

  Check it with `pane_width` in `list`, set it at creation with `--width` /
  `width`, and change it on a live session with `ath width <name> <cols>` (or
  the `width` MCP tool) — which costs nothing, where recreating the session
  would throw away the sudo timestamp and cost your human another password.
  None of that makes it *guaranteed*: the only real defence is output that does
  not depend on width.
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
  and you get `shell_exited`. Prefer `(exit 1)` when you just want a code.
