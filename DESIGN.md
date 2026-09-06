# Design notes

Why agent-terminal-hub is built the way it is. The README covers what it
does and how to install it; this covers the parts that are load-bearing and
not obvious from the outside.


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

Security and what gets recorded are covered in the [README](README.md).
