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
  # --scope user, or the server exists only in the directory you installed from.
  #
  # `claude mcp add` defaults to LOCAL scope, which is stored per project path in
  # ~/.claude.json. The install reports success, `claude mcp list` says
  # "✔ Connected" when run from the repo — and an agent started from any other
  # directory sees no MCP tools at all. That is not "installed on this machine",
  # which is the only thing anyone means by installing it.
  #
  # The server name is not just a key: Claude Code's VS Code panel labels every
  # call `<HumanizedServerName> [<rawToolName>]` and never consults the tool's
  # title annotation. `ath` rendered as "Ath [terminal_new]" — an identifier, not
  # language. `agent_terminal` plus bare verbs renders "Agent Terminal [new]".
  #
  # `ath` is removed first so an upgrade does not leave both registered and the
  # same nine tools offered twice under different names.
  for stale in ath agent_terminal; do
    claude mcp remove "$stale" >/dev/null 2>&1 || true
    claude mcp remove "$stale" --scope user >/dev/null 2>&1 || true
  done
  if claude mcp add agent_terminal --scope user -- node "$REPO/packages/mcp/dist/index.js" >/dev/null 2>&1; then
    good "registered with Claude Code as 'agent_terminal' (user scope — every directory)"
  else
    bad "could not register automatically. Run:"
    say "        claude mcp add agent_terminal --scope user -- node $REPO/packages/mcp/dist/index.js"
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

# --------------------------------------------------------------- MCP permissions
#
# Registering the server is not the same as being able to use it. Without an
# allow-list every single call raises a permission prompt, and the only choices
# the dialog offers are "yes, once" or "yes, for this project" — so an agent
# doing ten terminal operations interrupts the human ten times, and the person
# who clicks "for this project" gets nothing the next directory along.
#
# Reading output and running a command are the ordinary path and are allowed.
# `kill` destroys a session someone may be attached to, so it stays on `ask`,
# which outranks `allow` and therefore keeps prompting even if a broader rule is
# added later.
say ""
say "==> allowing the hub's tools without a prompt each time"
PERM_OUT="$(node -e '
const fs=require("fs"), os=require("os"), path=require("path");
const file = path.join(os.homedir(), ".claude", "settings.json");
const PREFIX = "mcp__agent_terminal__";
const ALLOW = ["list","new","run","read","start","poll","send","request_human"]
                .map(t => PREFIX + t);
const ASK = [PREFIX + "kill"];

// Rules this installer wrote before the server was renamed. The `ath` server no
// longer exists, so they match nothing and are dead weight in a file the user
// reads. Only these exact strings are removed — never a rule someone else put
// there, and never one that is merely similar.
const OBSOLETE = new Set(
  ["list","new","run","read","start","poll","send","request_human","kill"]
    .map(t => "mcp__ath__terminal_" + t));

let settings = {}, existed = fs.existsSync(file);
if (existed) {
  try { settings = JSON.parse(fs.readFileSync(file, "utf8")) || {}; }
  catch (e) { console.log("PARSE_FAIL"); process.exit(0); }
}
if (typeof settings !== "object" || Array.isArray(settings)) { console.log("PARSE_FAIL"); process.exit(0); }

const p = (settings.permissions && typeof settings.permissions === "object" && !Array.isArray(settings.permissions))
  ? settings.permissions : (settings.permissions = {});
const arr = k => Array.isArray(p[k]) ? p[k] : [];

// Never override a decision the user made themselves: a tool they put in deny
// or ask is left exactly where they put it.
const blocked = new Set([...arr("deny"), ...arr("ask")]);
const wanted  = ALLOW.filter(r => !blocked.has(r));

let changed = 0;
const merge = (key, rules) => {
  const cur = arr(key);
  const missing = rules.filter(r => !cur.includes(r));
  if (missing.length) { p[key] = cur.concat(missing); changed += missing.length; }
};
merge("allow", wanted);
merge("ask", ASK.filter(r => !arr("deny").includes(r)));

// Sweep the pre-rename rules out of every list they could be in.
for (const key of ["allow", "ask", "deny"]) {
  if (!Array.isArray(p[key])) continue;
  const kept = p[key].filter(r => !OBSOLETE.has(r));
  if (kept.length !== p[key].length) { changed += p[key].length - kept.length; p[key] = kept; }
}

if (!changed) { console.log("UNCHANGED"); process.exit(0); }

// Back up before the first modification, then write atomically — a settings.json
// truncated by a crash mid-write disables every setting in it silently.
if (existed) fs.copyFileSync(file, file + ".before-ath");
fs.mkdirSync(path.dirname(file), { recursive: true });
const tmp = file + ".ath-tmp";
fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
fs.renameSync(tmp, file);
console.log("CHANGED " + changed);
' 2>/dev/null || echo ERROR)"

case "$PERM_OUT" in
  UNCHANGED)  good "already allowed in ~/.claude/settings.json" ;;
  CHANGED*)   good "allowed in ~/.claude/settings.json ('kill' still asks)"
              say "        previous file kept as ~/.claude/settings.json.before-ath" ;;
  PARSE_FAIL) bad "~/.claude/settings.json is not valid JSON, so it was left untouched."
              say "        Fix it, re-run this script, or add these to permissions.allow:"
              say "        mcp__agent_terminal__ + run, read, start, poll, send, new, list, request_human" ;;
  *)          bad "could not update ~/.claude/settings.json; the tools will prompt each call." ;;
esac

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
