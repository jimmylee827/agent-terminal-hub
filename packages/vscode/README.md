# Agent Terminal Hub

Long-lived terminals shared by an AI agent and you.

The **Agent Terminals** panel lists every session an agent has open. Click one
and a normal VSCode terminal attaches to **the same PTY the agent is driving** —
not a copy, not a view.

That matters most when a command needs a password. The agent cannot type it and
should not try. Instead the session's row turns amber, the status bar says
`needs input`, and a notification offers **Attach**. You type the password into
the terminal the agent is already blocked on, and it carries on. Nothing is
re-run and nothing is pasted back and forth.

## Panel

- **Attach** — join the session in a native integrated terminal
- **Pin** — protect a session from automatic cleanup
- **Kill** — destroy it, even while an agent is using it (the agent is told)
- **Copy Agent Prompt** — puts ready-to-paste handoff text on your clipboard

## Requires

`tmux` (`brew install tmux`) and the `ath` CLI from the
[agent-terminal-hub](https://github.com/jimmylee827/agent-terminal-hub) repo.
Run `ath doctor` to check the setup.

## Settings

| Setting | Purpose |
|---|---|
| `ath.tmuxPath` | Path to tmux; empty auto-detects |
| `ath.pollIntervalMs` | Poll rate while something is running (default 800) |
| `ath.idlePollIntervalMs` | Slower rate when everything is idle (default 3000) |
| `ath.notifyOnNeedsInput` | Notify when a terminal starts waiting (default on) |
| `ath.extraPromptPatterns` | Extra regexes that mean "waiting for input" — for tools with unusual or non-English prompts |
