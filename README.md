# agent-terminal-hub

Long-lived terminals shared by an AI agent and you — on **one PTY**, so when a
command needs a password you just type it, in the terminal the agent is already
using, and it carries on.

```
┌── tmux server on a dedicated socket `-L ath` ──────────────────┐
│   (isolated from your own tmux; outlives VSCode and the agent) │
│   session ath-<name>                                           │
│     ├─ pipe-pane ──────→ ~/.ath/log/<name>.log   (agent reads) │
│     ├─ live pane ──────→ your attached client    (you type)    │
│     └─ @ath_* options   (metadata, no state file to desync)    │
└───────▲──────────────────▲──────────────────▲──────────────────┘
        │                  │                  │
   ┌────┴─────┐      ┌─────┴──────┐    ┌──────┴─────────┐
   │ ath CLI  │      │ MCP server │    │ VSCode panel   │
   │ any agent│      │ typed tools│    │ TreeView+attach│
   └──────────┘      └────────────┘    └────────────────┘
```

## Why

An agent's shell tool runs each command in a fresh process with **no TTY**.
So nothing persists between calls, and `sudo` — which reads its password from
`/dev/tty` — fails instantly with nowhere to prompt. The usual result is a
handshake: the agent gives up, you run the command somewhere else, you paste
the output back.

A hub session is a real terminal that outlives the agent, that the agent drives
programmatically, and that you can step into mid-command.

## Install

```bash
git clone https://github.com/jimmylee827/agent-terminal-hub
cd agent-terminal-hub
bash scripts/install.sh
```

That is the whole install. It checks prerequisites first and stops with a clear
message if `tmux` or a recent Node are missing, builds everything, puts `ath` on
your PATH, installs the Claude Code skill, registers the MCP server, and installs
the VS Code extension.

It then **proves each half works** rather than assuming: it speaks the MCP
protocol to the server and reports how many tools it offers, and it creates a
session, runs a command in it, and checks the exit code comes back.

The MCP server is a stdio server, so there is no daemon to start — your agent
spawns one per session. Registering it is all that is needed; verifying it
answers is what tells you the registration is worth anything.

Everything is symlinked into the repo, so updating is `git pull && npm run
build` — nothing needs reinstalling. The script is safe to re-run.

If the VS Code extension step reports that `code` is not on your PATH, either
enable it once (Cmd+Shift+P -> *Shell Command: Install 'code' command in PATH*)
and re-run, or install the `.vsix` it names via Cmd+Shift+P -> *Extensions:
Install from VSIX...*.

## Use

```bash
ath new build --cwd ~/proj      # a terminal that persists
ath run build -- npm test       # blocking; real output, real exit code
ath attach build                # you join the same terminal
ath ls                          # what exists and what it is doing
ath prompt build                # copyable handoff text for an agent
```

In VSCode, the **Agent Terminals** panel lists every session. Clicking one
attaches a normal integrated terminal to it. When a session starts waiting on a
password, its row turns amber, the status bar says so, and a notification
offers an **Attach** button.

## The password flow

This is the case the project exists for.

1. Agent runs `sudo …`; the command blocks on the prompt.
2. The hub notices, on two independent signals: the foreground process is
   `sudo`, and the last line of the pane looks like a prompt.
3. `ath run` returns `needsInput: true` — a handoff, not a failure. The agent is
   instructed to report it and stop, never to supply a credential.
4. Your row turns amber and a notification appears. Click **Attach**.
5. You type the password into the same PTY. The agent's command completes and
   it reads the result.

No copy-paste, nothing re-run, no round trip.

## Design notes

Things that are load-bearing and non-obvious:

- **Output comes from a `pipe-pane` log, not `capture-pane`.** Reading a byte
  range of an append-only log gives the exact bytes of one command, immune to
  the 80×24 window and to reflow. Screen-scraping is not.
- **Exit codes ride inside the end marker** — `<ATHE:<nonce>:0>` — printed by a
  `__ath` shell helper and then erased from the screen, so the pane stays clean
  for you while the log keeps the bytes. This replaced a sentinel *file*, which
  quietly assumed agent and shell share a filesystem: a shell on the far side of
  ssh writes that file to the far host, where the poller can never see it. A
  marker comes back through the PTY, so the same protocol works locally, over
  ssh, and inside a container.
- **`pipe-pane` is never called with `-o`.** That flag only opens a pipe if none
  exists, so calling it on an already-piping pane *toggles logging off*. Since a
  pipe survives `respawn-pane`, using `-o` there silently blinds the agent.
- **Commands run in the session's own shell**, so `cd` and `export` persist —
  which also means a command containing `exit` really ends the shell. `run()`
  watches for pane death alongside the marker and recovers the status from
  `pane_dead_status`, instead of blocking until timeout.
- **`remain-on-exit` + `respawn-pane`** keep the session alive through that, so
  an agent typing `exit` cannot destroy a terminal you wanted.
- **Metadata lives in `@ath_*` tmux options**, attached to the session itself,
  so there is no sidecar state file that can desync from reality.
- **A dedicated socket (`-L ath`) and an `ath-` name prefix** mean the hub can
  never see, resize, or kill a session from your personal tmux.
- **`window-size latest`**, so attaching from a small window does not shrink and
  wrap the pane the agent is working in.

### Hazards that only exist because a human shares the terminal

Both of these were found in live use, not by the test suite — a suite with no
one attached cannot produce either.

- **Copy mode silences the agent.** `mouse on` means scrolling up to read output
  puts the pane into copy mode, after which every `send-keys` fails with
  `not in a mode`. The agent stops working because you looked at something.
  Input paths check `#{pane_in_mode}` and send `-X cancel` first.
- **A half-typed line gets spliced onto the agent's command.** Text left at the
  prompt without Enter is concatenated with what the agent sends, and the
  combined line is submitted. `sendLine` clears with `C-e` `C-u` first. The
  tradeoff is that it can discard something you were mid-way through typing;
  that is preferred to silent corruption, which additionally never emits an end
  marker and so stalls the caller until its full timeout.
- **A command that never reaches the shell fails fast.** If the start marker has
  not appeared within 3s, `run()` installs the helper and retries once — which
  is also what makes a shell it never set up (past an ssh hop, inside a
  container) work — and only then raises `command_lost`.
- **Two callers would splice into one command line.** Both read the log offset,
  both send, and tmux interleaves the keystrokes into a single line the shell
  then runs. A per-session lock file (`~/.ath/lock/`) serialises `ath` callers;
  a second caller gets `session_busy` naming what is running, or queues with
  `--wait`. A human typing directly cannot be locked out, and stays covered by
  the line-clear and the `command_lost` backstop.

### Deciding that a terminal is waiting for a human

Two signals, and they are combined differently depending on what the answer is
used for — because the cost of being wrong is not symmetric.

`needs-input` requires prompt-shaped text **and** a foreground process that
plausibly prompts (a known interactive tool, or a shell, since `read` is a
builtin). Text alone used to be enough, which made `echo "Do you want to
continue?"; sleep 8` report as waiting — raising a notification and making
`run()` refuse the session while nothing was actually waiting.

- **`run()`** uses that strict rule, and returns the moment it fires: aborting
  a working command to report a false "needs input" is destructive, and the
  agent then tells the user something untrue. This is also what turns a real
  password prompt from a 120s stall into ~2s.
- **The watcher** additionally promotes a *stalled* session with prompt-shaped
  output even from an unknown command. A wrong amber row is cheap and the
  human can just look at the pane.

An idle shell is not caught by either, because an ordinary `PS1` (`… %`, `… $`)
matches none of the prompt patterns — only an actual question does.

### Remote hosts need no preparation

`--remote` runs ssh with connection sharing and self-loading keys, so nothing
has to be set up per machine:

- `AddKeysToAgent=yes` (plus `UseKeychain=yes` on macOS) means a passphrase is
  entered once **per key, ever** — not per host, not per session. Telling users
  to run `ssh-add` for each machine they touch is the thing this avoids.
- `ControlMaster=auto` with `ControlPersist=8h` keeps one authenticated
  connection alive and shared, so a reconnect costs no authentication at all.
- `ServerAlive*` notices a dead link in ~90s rather than hanging on TCP.

Override with `ATH_SSH_OPTIONS` if you need something different.

### A remote session never silently becomes a local one

If ssh drops, the pane falls back to the **local** shell while every label
still says remote. Left alone, a command meant for another machine runs on this
one and reports success — the worst failure this design could have. Before
running anything in a session with a remote host, the hub checks it is still
inside the connection, reconnects if not, and refuses (`remote_disconnected`)
rather than running locally.

### Knowing a command ended when the shell it ran in is gone

Three different situations, none of which write an end marker:

| Case | How it is caught |
|---|---|
| The pane's own shell exits | `pane_dead` — the pane really is gone |
| A nested shell exits (`exit` in an ssh session) | the foreground command falls back from `ssh` to a shell |
| A plain sub-shell exits (`exit` in a nested `bash`) | the count of shells on the pane's tty drops |

The last one needs the process count because the foreground command is a shell
both before and after. "Output stopped moving" cannot distinguish it from a
shell builtin loop working in silence — the tty count can, and does not move
for the busy case.

### sudo caching comes free

A session is a real, persistent tty, so sudo's default per-tty credential cache
works normally: one password entry covers every later `sudo` the agent runs in
that session, for the sudoers timeout. There is no need to weaken sudoers with
`timestamp_type=global` to make an agent workflow usable — which is the usual
advice, and which trades away per-tty isolation for every process you own.

## Security

The agent has a `send` primitive for `C-c` and `y/n`. It must never type a
credential, and the shipped skill and MCP tool descriptions say so explicitly.
Secrets are typed by you, into the attached pane, going straight to the PTY.

**What reaches the log, precisely** — this distinction is the one that matters,
and it is not the intuitive one:

| Typed at | Reaches `~/.ath/log/` ? | Examples |
|---|---|---|
| A prompt with terminal echo **off** | **No.** Never captured. | `sudo` password, ssh passphrase, `read -s` |
| An ordinary **echoing** prompt | **Yes**, and an agent can read it back | API key, token, username, `read -p` answers |

`pipe-pane` records what the terminal displays. A password prompt displays
nothing as you type, so nothing is recorded — the common case is safe. An API
key pasted at a normal prompt is displayed, so it is recorded.

Logs are `0600`. Wipe one with `ath purge <session>`, or **Purge Recorded
Output** in the panel. That is deliberately not an MCP tool: discarding the
record is a human's decision, not an agent's.

## Verify

```bash
bash scripts/verify.sh
```

The regression suite — 111 assertions against real tmux: exit-code fidelity for
every shape of command, stdout+stderr capture, state persistence, output
integrity, survival of `exit`, locking, claims, and the framing protocol.

```bash
bash scripts/verify.sh <session> "LABEL"
```

The edge battery — 70 assertions run against a session you already have, so the
same checks can be pointed at every context that matters:

```bash
ath new work --cwd ~           && bash scripts/verify.sh work "LOCAL"
ath new box --remote myserver  && bash scripts/verify.sh box  "REMOTE"
ath send box --text -- bash    && bash scripts/verify.sh box  "NESTED"
```

It covers exit codes across compound commands, quoting, output that impersonates
the framing protocol, long-command splicing, and console hygiene — asserting the
hub's own plumbing never appears in the terminal a human is watching.

## Requirements

macOS or Linux (tmux). Node 18+. Windows would need WSL.
