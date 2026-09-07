# agent-terminal-hub

**Your AI coding agent and you, sharing one real terminal.**

When a command needs a password, the agent doesn't give up and ask you to go run
it somewhere else. It stops, tells you, and you type the password into the same
terminal it is already using — then it carries on with the output.

Built for **macOS + VS Code + an AI coding agent**. Works on Linux too.

---

## The problem it fixes

Your agent's built-in shell tool starts a **fresh process with no terminal**
every time it runs a command. Two consequences you have probably already hit:

**`sudo` simply fails.** It reads passwords from `/dev/tty`, and there isn't
one. The agent gets `sudo: a password is required` and writes *"I couldn't
verify this — please check manually."*

**Nothing persists.** `cd /some/path` and `export TOKEN=…` are gone by the next
command, because the next command is a different process.

So you end up as a copy-paste relay: the agent asks, you run it in your own
terminal, you paste the output back.

**With the hub**, the agent works in a real, long-lived terminal that you can
join at any moment:

```
you ask the agent to audit a server
  → agent: "I need sudo for the firewall rules"        ← it asks once, up front
  → a notification appears in VS Code with an Attach button
  → you click it, type your password, walk away
  → agent continues, and the password stays valid for the rest of its work
```

You typed one password. You never pasted a command or an output.

---

## What you need

| | |
|---|---|
| **macOS** or Linux | Windows needs WSL |
| **tmux** | `brew install tmux` |
| **Node 18+** | `brew install node` |
| **An AI coding agent** | Claude Code, in VS Code or the terminal |

Nothing needs installing on any remote server you connect to. That is a hard
rule of the design — the hub leaves no trace on machines it drives.

---

## Install

### Option 1 — ask your agent to do it

Paste this to your AI agent:

```
Install agent-terminal-hub for me:

  git clone https://github.com/jimmylee827/agent-terminal-hub
  cd agent-terminal-hub
  bash scripts/install.sh

Then run `ath doctor` and tell me if anything failed.
```

That is safe to hand over — the installer only writes to this repo, `~/.local/bin`,
`~/.claude`, and VS Code's extension folder, and it is safe to re-run.

### Option 2 — do it yourself

```bash
brew install tmux node                                    # if you don't have them
git clone https://github.com/jimmylee827/agent-terminal-hub
cd agent-terminal-hub
bash scripts/install.sh
```

### Either way, that is the whole install

The script checks prerequisites **before** touching anything, then builds and
wires up all four pieces:

- the **`ath` command**, on your PATH
- the **agent skill**, so your agent knows how to use it without being told
- the **MCP server**, registered for your whole machine, not one folder
- the **VS Code extension**, giving you a session list and an Attach button

It then **proves each half works** instead of assuming — it speaks the MCP
protocol to the server and counts the tools that answer, then creates a real
session, runs a command in it, and checks the exit code comes back.

Everything is symlinked into the repo, so updating is `git pull && npm run build`.
Nothing needs reinstalling.

> If it says `code` is not on your PATH: press <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>
> in VS Code, run *Shell Command: Install 'code' command in PATH*, and re-run the
> installer. Or install the `.vsix` it names via *Extensions: Install from VSIX…*.

---

## Check it worked

```bash
ath doctor
```

Every line should say `ok`. Then ask your agent:

> *"Use the terminal hub to create a session and tell me what OS this machine is."*

If it creates a session and answers, you are done. **You do not need to teach it
anything** — the skill and the typed tools are already in front of it.

---

## Using it

Most of the time you don't. **The agent drives it; you only step in for
passwords.** But it is an ordinary command-line tool as well:

```bash
ath ls                          # what sessions exist, and what each is doing
ath attach build                # join a session and type in it yourself
ath new box --remote myserver   # a session that lives on another machine over ssh
ath purge build                 # erase a session's recorded transcript
ath doctor --artifacts          # everything the hub has written to this machine
```

Sessions outlive VS Code, the agent, and your terminal window. Closing your
laptop lid does not kill a build.

---

## The password handoff

This is the part that makes the rest worth having.

1. The agent runs something needing `sudo`. The command **stops at the prompt**
   and stays alive.
2. A request is filed **automatically** — the agent cannot forget to do this —
   and a notification appears in VS Code.
3. You attach, type the password, and detach. It is a normal terminal; nothing
   about it is special.
4. The agent collects the output and carries on. The `sudo` timestamp stays warm
   for that session, so it can keep working without asking again — for however
   long *this machine's* `sudoers` allows, which varies (`timestamp_timeout`
   is commonly 5 or 15 minutes, and can be 0). Nothing the agent reads names a
   duration, deliberately: it is told to re-check with `sudo -n true` rather
   than assume one.

**The agent never sees, types, or handles your password.** The skill and every
tool description say so explicitly, and the design makes handing off to you
*easier* than working around you — which is the only version of this that holds
up in practice.

---

## What gets recorded, exactly

Every session is written to `~/.ath/log/<name>.log` — the commands and their
output. The file survives `ath kill`. This distinction is the one that matters,
and it is not the intuitive one:

| Typed at | Ends up in the log? | Examples |
|---|---|---|
| A prompt with echo **off** | **No.** Never captured. | `sudo` password, ssh passphrase, `read -s` |
| An ordinary **echoing** prompt | **Yes** — and the agent can read it back | API key, token, `read -p` answers |

The log records what the terminal *displays*. A password prompt displays nothing
as you type, so nothing is recorded. An API key pasted at a normal prompt is
displayed, so it is.

Logs are `0600`. `ath purge <session>` erases one; `ath doctor --artifacts`
lists everything the hub has ever written, and says which of it `purge` does not
reach.

---

## How it works

```
┌── tmux server on its own socket `-L ath` ──────────────────────┐
│   (isolated from your own tmux; outlives VS Code and the agent)│
│   session ath-<name>                                           │
│     ├─ pipe-pane ──────→ ~/.ath/log/<name>.log   (agent reads) │
│     ├─ live pane ──────→ your attached client    (you type)    │
│     └─ @ath_* options   (metadata, no state file to desync)    │
└───────▲──────────────────▲──────────────────▲──────────────────┘
        │                  │                  │
   ┌────┴─────┐      ┌─────┴──────┐    ┌──────┴─────────┐
   │ ath CLI  │      │ MCP server │    │ VS Code panel  │
   │ any agent│      │ typed tools│    │ list + attach  │
   └──────────┘      └────────────┘    └────────────────┘
```

One PTY, three ways in. The agent and you are looking at the same terminal —
that is the whole idea, and it is why the password flow needs no special
machinery.

Exit codes travel back **inside the terminal output**, wrapped in a control byte
so a command cannot forge its own status. Nothing is written to remote machines,
which is why the same protocol works locally, over ssh, and inside a container.

See [DESIGN.md](DESIGN.md) for the non-obvious parts — prompt detection,
reconnect behaviour, and the hazards that exist only because a human shares the
terminal.

---

## Tested by agents that had never seen it

Every design decision here was checked by giving a fresh AI agent a real task on
a real server, with no documentation beyond what ships in the repo, and reading
what it got wrong. Thirteen such runs, each one fixing what the last one tripped
over — a hang, a timing figure that was wrong by 4×, a status field that said a
password prompt had been answered when it had not.

If a message in this tool reads like it was written by someone watching an agent
make that exact mistake, it was.

---

## Verify

```bash
bash scripts/verify.sh --local
```

370+ assertions covering the CLI, the MCP surface, nested shells, and the
credential path.

---

## License

MIT.
