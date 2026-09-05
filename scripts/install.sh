#!/usr/bin/env bash
# One command to install everything: the `ath` CLI, the agent skill, the MCP
# server, and the VS Code extension.
#
# Everything is a symlink into this repo, so updating is `git pull &&
# npm run build` — nothing needs reinstalling.
#
# Safe to re-run.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${ATH_BIN_DIR:-$HOME/.local/bin}"
ok=0; warn=0

say()  { printf '%s\n' "$*"; }
good() { printf '  \033[32m✓\033[0m %s\n' "$*"; ok=$((ok+1)); }
bad()  { printf '  \033[33m!\033[0m %s\n' "$*"; warn=$((warn+1)); }

# ---------------------------------------------------------------- prerequisites
#
# Checked BEFORE anything is installed. A missing tmux does not announce itself
# — every session simply fails later, in a way that looks like a bug in this
# tool rather than a missing dependency.
say "==> checking prerequisites"

if ! command -v tmux >/dev/null 2>&1; then
  say ""
  say "  tmux is required and was not found. Install it, then re-run this script:"
  say ""
  say "      brew install tmux"
  say ""
  exit 1
fi
good "tmux $(tmux -V 2>/dev/null | awk '{print $2}')"

if ! command -v node >/dev/null 2>&1; then
  say ""
  say "  Node.js is required and was not found. Install it, then re-run:"
  say ""
  say "      brew install node"
  say ""
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  say ""
  say "  Node 18 or newer is required (found $(node -v)). Upgrade, then re-run."
  say ""
  exit 1
fi
good "node $(node -v)"

# ---------------------------------------------------------------------- build
say ""
say "==> building"
(cd "$REPO" && npm install --silent >/dev/null 2>&1 || npm install >/dev/null)
(cd "$REPO" && npm run build >/dev/null 2>&1)
good "core, cli, mcp, extension"

# ------------------------------------------------------------------------ CLI
say ""
say "==> installing the ath command"
mkdir -p "$BIN_DIR"
ln -sf "$REPO/packages/cli/dist/index.js" "$BIN_DIR/ath"
chmod +x "$REPO/packages/cli/dist/index.js"
good "$BIN_DIR/ath"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    bad "$BIN_DIR is not on your PATH — add this to ~/.zshrc and open a new terminal:"
    say "        export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac

# ---------------------------------------------------------------------- skill
say ""
say "==> installing the agent skill"
SKILL_DIR="$HOME/.claude/skills/agent-terminal"
mkdir -p "$(dirname "$SKILL_DIR")"
ln -sfn "$REPO/skills/agent-terminal" "$SKILL_DIR"
good "$SKILL_DIR"

# ------------------------------------------------------------------------ MCP
say ""
say "==> registering the MCP server"
if command -v claude >/dev/null 2>&1; then
  claude mcp remove ath >/dev/null 2>&1 || true
  if claude mcp add ath -- node "$REPO/packages/mcp/dist/index.js" >/dev/null 2>&1; then
    good "registered with Claude Code as 'ath'"
  else
    bad "could not register automatically. Run:"
    say "        claude mcp add ath -- node $REPO/packages/mcp/dist/index.js"
  fi
else
  bad "the 'claude' CLI was not found, so MCP was not registered."
  say "        For any other MCP client, point it at:"
  say "        node $REPO/packages/mcp/dist/index.js"
fi

# An MCP stdio server is not a daemon — the client spawns one per session, so
# there is nothing to start here. What CAN go wrong is registering a server that
# does not work: the entry is added, `claude mcp list` looks healthy, and the
# failure only appears when an agent first tries to use it. So actually speak
# the protocol to it once and count what it offers.
TOOLS="$(printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"install","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node "$REPO/packages/mcp/dist/index.js" 2>/dev/null \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      const line=d.trim().split("\n").filter(Boolean).pop()||"";
      try{process.stdout.write(String(JSON.parse(line).result.tools.length))}catch(e){process.stdout.write("0")}})' 2>/dev/null || echo 0)"
if [ "${TOOLS:-0}" -gt 0 ]; then
  good "the server answers and offers $TOOLS tools"
else
  bad "the MCP server did not answer an initialize handshake — agents will not"
  say "        be able to use it. Try: node $REPO/packages/mcp/dist/index.js"
fi

# ------------------------------------------------------------- VS Code extension
#
# `code --install-extension` is the documented way, but on macOS that command
# does not exist until the user runs "Shell Command: Install 'code' command in
# PATH" from the palette — which most people never have. Falling back to a
# copy into the extensions directory means the install still completes.
say ""
say "==> installing the VS Code extension"
VSIX="$(ls -t "$REPO"/packages/vscode/*.vsix 2>/dev/null | head -1 || true)"
if [ -z "$VSIX" ]; then
  (cd "$REPO/packages/vscode" && npm run package >/dev/null 2>&1) || true
  VSIX="$(ls -t "$REPO"/packages/vscode/*.vsix 2>/dev/null | head -1 || true)"
fi

if [ -z "$VSIX" ]; then
  bad "could not build the .vsix. Build it by hand:"
  say "        cd $REPO/packages/vscode && npm run package"
elif command -v code >/dev/null 2>&1; then
  if code --install-extension "$VSIX" --force >/dev/null 2>&1; then
    good "installed into VS Code ($(basename "$VSIX"))"
  else
    bad "code --install-extension failed. Install $VSIX by hand."
  fi
else
  bad "the 'code' command is not on your PATH, so the extension was not installed."
  say ""
  say "        Either enable it once — in VS Code press Cmd+Shift+P and run"
  say "        \"Shell Command: Install 'code' command in PATH\" — then re-run"
  say "        this script;"
  say ""
  say "        or install it by hand: Cmd+Shift+P -> \"Extensions: Install from"
  say "        VSIX...\" and choose"
  say "        $VSIX"
fi

# ------------------------------------------------------------------ smoke test
#
# Proving it works is the point of an installer. A green summary that has not
# actually started a session is how someone discovers the problem an hour later.
say ""
say "==> verifying"
ATH="$REPO/packages/cli/dist/index.js"
SMOKE="ath-install-check-$$"
if node "$ATH" new "$SMOKE" --cwd /tmp >/dev/null 2>&1; then
  sleep 2
  # `|| true` / `|| rc=$?` are required: `set -e` would abort the script on the
  # deliberately non-zero exit below, which is the very thing being verified.
  out="$(node "$ATH" run "$SMOKE" -- 'echo installed-ok' 2>/dev/null | tr -d '\n' || true)"
  rc=0
  node "$ATH" run "$SMOKE" -- '(exit 7)' >/dev/null 2>&1 || rc=$?
  node "$ATH" kill "$SMOKE" --force >/dev/null 2>&1 || true
  if [ "$out" = "installed-ok" ] && [ "$rc" = "7" ]; then
    good "created a session, ran a command, got its exit code back"
  else
    bad "a session started but did not behave correctly (output='$out' rc=$rc)"
    say "        Run '$BIN_DIR/ath doctor' for details."
  fi
else
  bad "could not create a test session. Run '$BIN_DIR/ath doctor' for details."
fi

# --------------------------------------------------------------------- summary
say ""
if [ "$warn" -eq 0 ]; then
  say "Done — $ok checks passed, nothing outstanding."
else
  say "Done — $ok checks passed, $warn need your attention (marked ! above)."
fi
say ""
say "Try it:"
say "    ath new work            # a terminal that outlives your commands"
say "    ath run work -- pwd"
say "    ath attach work         # join the same terminal yourself"
say ""
