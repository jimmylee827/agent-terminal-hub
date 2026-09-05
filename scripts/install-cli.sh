#!/usr/bin/env bash
# Put `ath` on PATH, register the MCP server, and install the agent skill.
# Everything here is a symlink into the repo, so `git pull` + `npm run build`
# is enough to update; nothing needs reinstalling.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${ATH_BIN_DIR:-$HOME/.local/bin}"

echo "==> building"
(cd "$REPO" && npm run build >/dev/null)

echo "==> linking ath -> $BIN_DIR/ath"
mkdir -p "$BIN_DIR"
ln -sf "$REPO/packages/cli/dist/index.js" "$BIN_DIR/ath"
chmod +x "$REPO/packages/cli/dist/index.js"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "    note: $BIN_DIR is not on your PATH. Add it in ~/.zshrc:"
     echo "          export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

echo "==> installing agent skill"
SKILL_DIR="$HOME/.claude/skills/agent-terminal"
mkdir -p "$(dirname "$SKILL_DIR")"
ln -sfn "$REPO/skills/agent-terminal" "$SKILL_DIR"
echo "    $SKILL_DIR"

echo "==> registering MCP server with Claude Code"
if command -v claude >/dev/null 2>&1; then
  claude mcp remove ath >/dev/null 2>&1 || true
  if claude mcp add ath -- node "$REPO/packages/mcp/dist/index.js" >/dev/null 2>&1; then
    echo "    registered as 'ath'"
  else
    echo "    could not register automatically. Run manually:"
    echo "    claude mcp add ath -- node $REPO/packages/mcp/dist/index.js"
  fi
else
  echo "    claude CLI not found; skipping MCP registration"
fi

echo
echo "done. verify with:  ath doctor"
