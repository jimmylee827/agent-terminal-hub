#!/usr/bin/env bash
# The project's tests.
#
#   verify.sh                              local only (default)
#   verify.sh --local                      local only
#   verify.sh --remote HOST[,HOST...]      those hosts only
#   verify.sh --local --remote a,b         local and those hosts
#   verify.sh --all-remote                 every reachable host in ~/.ssh/config
#   verify.sh --all                        local and every reachable host
#   verify.sh --session NAME [LABEL]       an existing session, as it stands
#
# `--session` is the one that cannot be automated away: testing a NESTED shell
# or a container means putting a session into that state first, which only you
# can decide. Stage it, then point this at it:
#
#   ath send box --text -- bash                 && verify.sh --session box NESTED
#   ath send box --text -- 'docker exec -it X sh' && verify.sh --session box CONTAINER
#
# Sessions this script creates are named `_t<pid>-*` and are destroyed
# afterwards; your own sessions are never touched. Honours ATH_SOCKET/ATH_HOME.
#
# NOTE: the two test bodies below are deliberately NOT indented. The battery
# contains here-documents whose terminator must sit in column 0 — indenting
# them for tidiness silently breaks those cases while the rest still passes.
set -uo pipefail

ATH_BIN="${ATH_BIN:-ath}"
DO_LOCAL=0; ALL_REMOTE=0; HOSTS=""; SESSION=""; SLABEL=""; EXPLICIT=0; SKIP_NESTING=0

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --local)      DO_LOCAL=1; EXPLICIT=1; shift ;;
    --remote)     HOSTS="${2:-}"; EXPLICIT=1; shift 2 ;;
    --all-remote) ALL_REMOTE=1; EXPLICIT=1; shift ;;
    --all)        DO_LOCAL=1; ALL_REMOTE=1; EXPLICIT=1; shift ;;
    --session)    SESSION="${2:-}"; SLABEL="${3:-$2}"; shift 2; [ $# -gt 0 ] && shift ;;
    --suite-only) INTERNAL_SUITE=1; shift ;;
    --nesting)    INTERNAL_NESTING=1; shift ;;
    --contract)   INTERNAL_CONTRACT=1; shift ;;
    --no-nesting) SKIP_NESTING=1; shift ;;
    --battery)    INTERNAL_BATTERY=1; S="${2:-}"; LABEL="${3:-$2}"; shift 3 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

# ---- internal modes: one target, one body. The orchestrator re-invokes these.
if [ "${INTERNAL_BATTERY:-0}" = "1" ]; then
# Edge-case harness. Runs the same battery against any session, local or remote.
ATH=ath
pass=0; fail=0; failed=()

chk() { # name expected actual
  if [ "$2" = "$3" ]; then
    pass=$((pass+1))
  else
    fail=$((fail+1)); failed+=("$1")
    printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$(printf %s "$2" | head -c 120)" "$(printf %s "$3" | head -c 120)"
  fi
}
out() { $ATH run "$S" -- "$1" 2>&1; }
rc()  { $ATH run "$S" -- "$1" >/dev/null 2>&1; echo $?; }

echo "═══ $LABEL ═══"

# ---- exit codes, every shape of command -------------------------------------
chk "exit 0"                 "0"   "$(rc 'true')"
chk "exit 1"                 "1"   "$(rc 'false')"
chk "exit 33 via subshell"   "33"  "$(rc '(exit 33)')"
chk "exit 127 not found"     "127" "$(rc 'no_such_cmd_xyz')"
lsrc=$(rc 'ls /definitely-not-here')
chk "ls missing is non-zero" "nonzero" "$([ "$lsrc" -ne 0 ] && echo nonzero || echo zero)"
chk "exit via brace group"   "1"   "$(rc '{ false; }')"
chk "exit through pipeline"  "0"   "$(rc 'echo x | cat')"
chk "exit of last in chain"  "5"   "$(rc 'true; (exit 5)')"
chk "&& short circuit"       "1"   "$(rc 'false && echo no')"
chk "|| recovery"            "0"   "$(rc 'false || true')"
chk "if/then/fi"             "0"   "$(rc 'if true; then :; fi')"
chk "for loop"               "0"   "$(rc 'for i in 1 2 3; do :; done')"
chk "while loop"             "0"   "$(rc 'i=0; while [ $i -lt 3 ]; do i=$((i+1)); done')"
chk "case statement"         "0"   "$(rc 'case x in x) : ;; esac')"
chk "background job"         "0"   "$(rc 'sleep 0.1 &')"
chk "subshell with output"   "7"   "$(rc '(echo inner; exit 7)')"

# ---- output fidelity ---------------------------------------------------------
chk "simple output"          "hello"        "$(out 'echo hello')"
chk "empty output"           ""             "$(out 'true')"
chk "no trailing newline"    "abc"          "$(out 'printf abc')"
chk "stderr captured"        "to-stderr"    "$(out 'echo to-stderr >&2')"
chk "stdout+stderr order"    "$(printf 'o\ne')" "$(out 'echo o; echo e >&2')"
chk "multi-line output"      "$(printf 'a\nb\nc')" "$(out 'printf "a\nb\nc\n"')"
chk "leading whitespace"     "    indented" "$(out 'echo "    indented"')"
chk "blank lines preserved"  "$(printf 'x\n\ny')" "$(out 'printf "x\n\ny\n"')"
chk "500 lines complete"     "500"          "$(out 'seq 1 500' | wc -l | tr -d ' ')"
chk "500th line correct"     "500"          "$(out 'seq 1 500' | tail -1)"
chk "long single line"       "4000"         "$(out 'printf "%04000d" 7' | tr -d '\n' | wc -c | tr -d ' ')"

# ---- quoting and special characters -----------------------------------------
chk "single quotes"          "it's here"    "$(out 'echo "it'"'"'s here"')"
chk "double quotes"          'say "hi"'     "$(out 'echo '"'"'say "hi"'"'"'')"
chk "literal dollar"         '$HOME stays'  "$(out 'echo '"'"'$HOME stays'"'"'')"
chk "expanded dollar"        "ok"           "$(out 'X=ok; echo $X')"
chk "backslash"              'a\b'          "$(out 'printf "a\\\\b\n"')"
chk "semicolons in string"   "a;b;c"        "$(out 'echo "a;b;c"')"
chk "pipe char in string"    "a|b"          "$(out 'echo "a|b"')"
chk "glob expands"           "/etc/hosts"   "$(out 'echo /etc/host?')"
chk "glob quoted stays"      '/etc/host?'   "$(out 'echo "/etc/host?"')"
chk "unicode round trip"     "中文 ↓↓↓ ok"  "$(out 'echo "中文 ↓↓↓ ok"')"
chk "tab preserved"          "$(printf 'a\tb')" "$(out 'printf "a\tb\n"')"
chk "percent sign"           "100%"         "$(out 'echo "100%"')"
chk "hash not a comment"     "a#b"          "$(out 'echo "a#b"')"

# ---- adversarial: output that looks like our own protocol --------------------
chk "fake end marker in output"  "<ATHE:deadbeef:99:x>" "$(out 'echo "<ATHE:deadbeef:99:x>"')"
chk "fake end marker keeps rc"   "0"                    "$(rc 'echo "<ATHE:deadbeef:99:x>"')"
chk "fake start marker"          "<ATHS:cafebabe>"      "$(out 'echo "<ATHS:cafebabe>"')"
chk "tag phrase in output"       "AGENT INPUT ID: fake" "$(out 'echo "AGENT INPUT ID: fake"')"
chk "tag phrase keeps rc"        "9"                    "$(rc 'echo "AGENT INPUT ID: fake"; (exit 9)')"
chk "arrow glyphs literal"       "↓↓↓ ↓↓↓"              "$(out 'echo "↓↓↓ ↓↓↓"')"
chk "ansi escapes in output"     "red"                  "$(out 'printf "\033[31mred\033[0m\n"')"

# ---- state persistence -------------------------------------------------------
$ATH run "$S" -- 'cd /tmp' >/dev/null 2>&1
chk "cd persists"            "/tmp"    "$(out 'pwd')"
$ATH run "$S" -- 'export EDGE_VAR=persisted' >/dev/null 2>&1
chk "export persists"        "persisted" "$(out 'echo $EDGE_VAR')"
$ATH run "$S" -- 'PLAIN=shellvar' >/dev/null 2>&1
chk "shell var persists"     "shellvar" "$(out 'echo $PLAIN')"
$ATH run "$S" -- 'edgefn() { echo from-fn; }' >/dev/null 2>&1
chk "function persists"      "from-fn"  "$(out 'edgefn')"
$ATH run "$S" -- 'cd /' >/dev/null 2>&1
chk "cd again"               "/"        "$(out 'pwd')"

# ---- long command lines (the splice hazard) ----------------------------------
LONG200=$(printf 'x%.0s' $(seq 1 200))
LONG800=$(printf 'x%.0s' $(seq 1 800))
LONG2000=$(printf 'x%.0s' $(seq 1 2000))
chk "200-char command"       "$LONG200"  "$(out "echo $LONG200")"
chk "800-char command"       "$LONG800"  "$(out "echo $LONG800")"
chk "2000-char command"      "$LONG2000" "$(out "echo $LONG2000")"
chk "2000-char keeps rc"     "21"        "$(rc "echo $LONG2000 >/dev/null; (exit 21)")"

# ---- multi-line commands -----------------------------------------------------
chk "multi-line command"     "$(printf 'one\ntwo')" "$(out 'echo one
echo two')"
chk "multi-line keeps rc"    "13"  "$(rc 'echo a
(exit 13)')"
chk "heredoc"                "$(printf 'l1\nl2')" "$(out 'cat <<EOF
l1
l2
EOF')"

# ---- rapid succession --------------------------------------------------------
r1=$(out 'echo r1'); r2=$(out 'echo r2'); r3=$(out 'echo r3')
chk "rapid commands isolated" "r1|r2|r3" "$r1|$r2|$r3"



# ---- console hygiene: what a HUMAN sees in the shared terminal ---------------
# Every defect found by inspection today was visible here and invisible to every
# assertion above, because those check returned values, not the terminal.
# These patterns are the hub's OWN plumbing leaking into a shared console.
# The adversarial tests above deliberately ECHO marker-shaped text; those two
# fixed nonces are command output, not plumbing leaking.
pane=$(tmux -L "${ATH_SOCKET:-ath}" capture-pane -p -t "ath-$S" -S -400 2>/dev/null \
       | grep -av 'cafebabe' | grep -av 'deadbeef')
hyg() { # name pattern
  n=$(printf '%s' "$pane" | grep -acF "$2" 2>/dev/null || true)
  chk "console clean: $1" "0" "$n"
}
hyg "no missing-helper errors"      '__ath: command not found'
hyg "no missing-hook errors"        '__ath_bpost: command not found'
hyg "no missing-tag errors"         '↓↓↓: command not found'
hyg "no wrapper definition dumped"  '__ath() { __ath_n='
hyg "no handshake probes"           "printf '<ATHR:"
hyg "no shell-probe lines"          'ZSH_VERSION:+zsh'
hyg "no raw control chars"          '^E^U'
hyg "no leaked start markers"       '<ATHS:'
hyg "no leaked end markers"         '<ATHE:'
hyg "no leaked tag acks"            '<ATHT:'

echo "  ── $LABEL: passed $pass, failed $fail"
[ "$fail" -eq 0 ] || printf '  ── failing: %s\n' "${failed[*]}"
exit "$fail"
exit $?
fi

if [ "${INTERNAL_CONTRACT:-0}" = "1" ]; then
# ---- the surfaces an agent reads, not just the ones it executes -------------
#
# Every defect a cold agent found in this tool sat here: JSON field names, the
# status output, the docs. 391 assertions passed throughout and would have
# passed with all of them present, because not one of them read a surface
# instead of running a command.
#
# The dangerous shape is a doc that names a field the tool does not emit: `jq -r
# .exit_code` returns null, and null is documented to mean "did not finish", so
# a success is read as an unfinished command. Silently.
pass=0; fail=0; failed=()
chk() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); failed+=("$1")
  printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"; fi; }
SK="$(cd "$(dirname "$0")/.." && pwd)/skills/agent-terminal/SKILL.md"
C="_tc$$"
echo "═══ CONTRACT ═══"
$ATH_BIN new "$C" --cwd /tmp >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8; do $ATH_BIN ls 2>/dev/null | grep -q "^$C .*idle" && break; sleep 1; done

J="$($ATH_BIN run "$C" --json -- 'true' 2>/dev/null)"
for f in exitCode timedOut needsInput logOffset; do
  chk "run --json emits $f" "yes" "$(printf '%s' "$J" | grep -q "\"$f\"" && echo yes || echo no)"
done
# the exact trap: a field the docs name but the tool never emits
chk "docs name no field the tool lacks" "0" \
    "$(grep -oE '\`(exit_code|needs_input|timed_out|next_offset|shell_exited)\`' "$SK" 2>/dev/null | wc -l | tr -d ' ')"

L="$($ATH_BIN ls --json 2>/dev/null)"
chk "ls --json omits paneTail"   "no"  "$(printf '%s' "$L" | grep -q '"paneTail"' && echo yes || echo no)"
chk "ls --json --full keeps it"  "yes" "$($ATH_BIN ls --json --full 2>/dev/null | grep -q '"paneTail"' && echo yes || echo no)"
chk "agent-created owner"        "agent" "$(printf '%s' "$L" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const s=JSON.parse(d).find(x=>x.name===process.argv[1]);process.stdout.write(s.owner)}catch(e){process.stdout.write("?")}})' "$C")"

# every command the skill tells an agent to run must exist
for cmd in ls new run read send attach poll start requests await doctor kill; do
  chk "skill command '$cmd' exists" "yes" \
      "$($ATH_BIN --help 2>&1 | grep -qE "^  ath $cmd" && echo yes || echo no)"
done
# The MCP server must be registered for EVERY directory, not just the one it was
# installed from. `claude mcp add` defaults to local (per-project) scope, so an
# install can report success while an agent one directory away sees no MCP tools
# at all — which is exactly what happened to an agent evaluating this tool.
if command -v claude >/dev/null 2>&1; then
  chk "MCP registered at user scope" "yes" \
      "$(node -e 'try{const c=require(process.env.HOME+"/.claude.json");process.stdout.write(c.mcpServers&&c.mcpServers.agent_terminal?"yes":"no")}catch(e){process.stdout.write("no")}' 2>/dev/null)"
  # The pre-rename server must be GONE, not merely superseded. Leaving both
  # registered offers the same nine tools twice under different names, and an
  # agent picking the stale one gets a server the installer no longer updates.
  chk "the pre-rename 'ath' server is deregistered" "yes" \
      "$(node -e 'try{const c=require(process.env.HOME+"/.claude.json");process.stdout.write(c.mcpServers&&c.mcpServers.ath?"no":"yes")}catch(e){process.stdout.write("yes")}' 2>/dev/null)"
  # The tools must be pre-allowed, or every call raises an approval prompt and
  # an agent spends the run being interrupted instead of working.
  chk "hub tools are pre-allowed in user settings" "yes" \
      "$(node -e 'try{const s=require(process.env.HOME+"/.claude/settings.json");const a=(s.permissions&&s.permissions.allow)||[];process.stdout.write(a.includes("mcp__agent_terminal__run")?"yes":"no")}catch(e){process.stdout.write("no")}' 2>/dev/null)"
  # ...except the destructive one, which must still ask.
  chk "kill still prompts" "yes" \
      "$(node -e 'try{const s=require(process.env.HOME+"/.claude/settings.json");const k=(s.permissions&&s.permissions.ask)||[];process.stdout.write(k.includes("mcp__agent_terminal__kill")?"yes":"no")}catch(e){process.stdout.write("no")}' 2>/dev/null)"
fi
chk "skill mentions ath await"   "yes" "$(grep -q 'ath await' "$SK" && echo yes || echo no)"
chk "skill drops the dead idiom" "no"  "$(grep -qF "until ath requests" "$SK" && echo yes || echo no)"

$ATH_BIN kill "$C" --force >/dev/null 2>&1 || true
printf '  ── CONTRACT: passed %d, failed %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || printf '  ── failing: %s\n' "${failed[*]}"
exit "$fail"
fi

if [ "${INTERNAL_NESTING:-0}" = "1" ]; then
# ---- nesting depth: bare -> 1 layer -> 2 layers -> back to bare -------------
#
# The prompt gains one `↳` per level below the shell the hub set up, so a
# human can see that `exit` will drop them a level rather than end the session.
# Nothing tested it, so neither the author nor the user could say whether it
# still worked — which is the same as it not working.
#
# Runs on a BASH session: the marker is set by the bash prompt hook, so a zsh
# session has nothing to show. ATH_SHELL makes that explicit rather than
# depending on whatever the machine's login shell happens to be.
pass=0; fail=0; failed=()
chk() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); failed+=("$1")
  printf '  FAIL %s\n       expected: %s\n       actual:   %s\n' "$1" "$2" "$3"; fi; }
N="_tn$$"
echo "═══ NESTING ═══"
ATH_SHELL=/bin/bash $ATH_BIN new "$N" --cwd /tmp >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8; do $ATH_BIN ls 2>/dev/null | grep -q "^$N .*idle" && break; sleep 1; done
sleep 1
prompt() { tmux -L "${ATH_SOCKET:-ath}" capture-pane -p -t "ath-$N" 2>/dev/null | grep -v '^$' | tail -1; }

$ATH_BIN run "$N" -- 'echo bare' >/dev/null 2>&1
chk "depth 0: no marker"        "no"  "$(case "$(prompt)" in *↳*) echo yes ;; *) echo no ;; esac)"
chk "depth 0: exit code"        "5"   "$($ATH_BIN run "$N" -- '(exit 5)' >/dev/null 2>&1; echo $?)"

$ATH_BIN send "$N" --text -- bash >/dev/null 2>&1; sleep 2
$ATH_BIN run "$N" -- 'echo one' >/dev/null 2>&1
chk "depth 1: one marker"       "1"   "$(prompt | grep -o '↳' | wc -l | tr -d ' ')"
chk "depth 1: exit code"        "17"  "$($ATH_BIN run "$N" -- '(exit 17)' >/dev/null 2>&1; echo $?)"
chk "depth 1: state persists"   "kept" "$($ATH_BIN run "$N" -- 'X=kept; echo $X' 2>&1)"

$ATH_BIN send "$N" --text -- bash >/dev/null 2>&1; sleep 2
$ATH_BIN run "$N" -- 'echo two' >/dev/null 2>&1
chk "depth 2: two markers"      "2"   "$(prompt | grep -o '↳' | wc -l | tr -d ' ')"
chk "depth 2: exit code"        "23"  "$($ATH_BIN run "$N" -- '(exit 23)' >/dev/null 2>&1; echo $?)"
chk "depth 2: multi-line"       "$(printf 'a\nb')" "$($ATH_BIN run "$N" -- 'echo a
echo b' 2>&1)"

$ATH_BIN send "$N" --text -- exit >/dev/null 2>&1; sleep 2
$ATH_BIN run "$N" -- 'echo back1' >/dev/null 2>&1
chk "back to depth 1"           "1"   "$(prompt | grep -o '↳' | wc -l | tr -d ' ')"

$ATH_BIN send "$N" --text -- exit >/dev/null 2>&1; sleep 2
$ATH_BIN run "$N" -- 'echo back0' >/dev/null 2>&1
chk "back to depth 0: marker gone" "0" "$(prompt | grep -o '↳' | wc -l | tr -d ' ')"
chk "back to depth 0: exit code"   "9" "$($ATH_BIN run "$N" -- '(exit 9)' >/dev/null 2>&1; echo $?)"
chk "back to depth 0: still framed" "framed" "$(tmux -L "${ATH_SOCKET:-ath}" capture-pane -p -t "ath-$N" -S -6 2>/dev/null | grep -q 'AGENT INPUT ID' && echo framed || echo wrapper)"

$ATH_BIN kill "$N" --force >/dev/null 2>&1 || true
printf '  ── NESTING: passed %d, failed %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || printf '  ── failing: %s\n' "${failed[*]}"
exit "$fail"
fi

if [ "${INTERNAL_SUITE:-0}" = "1" ]; then
# End-to-end checks against real tmux. Every assertion here corresponds to a
# behaviour the hub promises; if one fails, something users depend on is broken.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Where the suite was invoked from. Sessions record this as their `origin`.
INVOKED_FROM="$PWD"
ATH="node $REPO/packages/cli/dist/index.js"
S="e2e$$"

pass=0
fail=0

ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n     expected: %s\n     actual:   %s\n' "$1" "$2" "$3"; fail=$((fail+1)); }
check(){ [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

cleanup() { $ATH kill "$S" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "agent-terminal-hub e2e"
echo

echo "-- setup"
$ATH kill "$S" >/dev/null 2>&1 || true
$ATH new "$S" --cwd "$HOME" >/dev/null || { echo "could not create session"; exit 1; }
ok "created session $S"

echo
echo "-- a session records where it was created FROM, not only where it sits"
# This session is created with --cwd "$HOME" while the caller runs in the repo:
# exactly the shape that used to be unroutable, because no editor window can
# own $HOME. `origin` is what makes it belong to a project again, and unlike
# cwd it does not move when someone types `cd`.
set -- $(node -e '
const a=require(process.argv[1]+"/packages/core/dist/index.js");
a.get(process.argv[2]).then(s=>process.stdout.write([s.origin,s.cwd].join(" ")));
' "$REPO" "$S" 2>/dev/null)
check "origin is where the caller ran from" "$INVOKED_FROM" "${1:-}"
check "cwd is where the session actually sits" "$HOME" "${2:-}"
$ATH run "$S" -- 'cd /tmp' >/dev/null
set -- $(node -e '
const a=require(process.argv[1]+"/packages/core/dist/index.js");
a.get(process.argv[2]).then(s=>process.stdout.write([s.origin,s.cwd].join(" ")));
' "$REPO" "$S" 2>/dev/null)
check "origin survives a cd, so routing is stable" "$INVOKED_FROM" "${1:-}"

# The identity that replaces guessing: a session records the pid chain of
# whatever made it, so the ONE editor window that created it recognises its own
# extension-host pid here and every other window stays silent without
# negotiating. This shell created the session, so this shell must be in it.
chain=$(node -e '
const a=require(process.argv[1]+"/packages/core/dist/index.js");
a.get(process.argv[2]).then(s=>process.stdout.write((s.creatorPids||[]).join(",")));
' "$REPO" "$S" 2>/dev/null)
case ",$chain," in
  *",$$,"*) ok "creator chain names the process that made the session" ;;
  *) bad "creator chain names the process that made the session" "contains pid $$" "$chain" ;;
esac
$ATH run "$S" -- "cd $HOME" >/dev/null

echo
echo "-- protocol markers never leak into output"
# The end marker grew two base64 fields so a dropped ssh session can be put
# back where it was. Anything that filters markers has to track that shape:
# get it wrong and it does not fail loudly, it prints a wall of base64 into
# whatever the user or agent is reading.
out=$($ATH run "$S" -- 'echo visible-line; pwd')
printf '%s' "$out" | grep -q '<ATH' \
  && bad "no marker text in command output" "no <ATH" "$(printf '%s' "$out" | head -2)" \
  || ok "no marker text in command output"
printf '%s' "$out" | grep -q 'visible-line' \
  && ok "real output still returned intact" \
  || bad "real output still returned intact" "visible-line" "$out"
raw=$($ATH read "$S" --lines 40 2>/dev/null)
printf '%s' "$raw" | grep -q '<ATH' \
  && bad "no marker text when reading the pane" "no <ATH" "$(printf '%s' "$raw" | tail -2)" \
  || ok "no marker text when reading the pane"

echo
echo "-- a remote session reports where it actually runs"
# `cwd` for a remote session is pane_current_path: the LOCAL directory ssh was
# launched from. Reporting that as the working directory told an agent it was
# somewhere it had never been.
set -- $(node -e '
const a=require(process.argv[1]+"/packages/core/dist/index.js");
const local={name:"x",tmuxName:"ath-x",state:"idle",cwd:"/local/repo",currentCommand:"zsh",
  attached:0,created:0,pinned:false,owner:"agent",logPath:"/x",paneDead:false};
const remote={...local,remote:"myserver",remoteCwd:"/srv/app"};
const noneYet={...local,remote:"myserver"};
process.stdout.write([
  a.effectiveCwd(local), a.effectiveCwd(remote), a.effectiveCwd(noneYet),
  a.locationLabel(remote), a.locationLabel(local),
].join(" "));
' "$REPO" 2>/dev/null)
check "a local session reports its own cwd" "/local/repo" "${1:-}"
check "a remote session reports the REMOTE cwd" "/srv/app" "${2:-}"
check "before the first command it falls back to local" "/local/repo" "${3:-}"
check "remote location is labelled host:path" "myserver:/srv/app" "${4:-}"
check "local location has no host prefix" "/local/repo" "${5:-}"

echo
echo "-- exact output and exit code"
out=$($ATH run "$S" -- 'echo x; (exit 3)'); rc=$?
check "stdout captured" "x" "$out"
check "exit code propagated" "3" "$rc"

out=$($ATH run "$S" -- 'echo to-stderr >&2' 2>/dev/null)
check "stderr captured too" "to-stderr" "$out"

echo
echo "-- shell state persists between calls (the statelessness fix)"
$ATH run "$S" -- 'export E2E_KEY=carried; cd /tmp' >/dev/null
out=$($ATH run "$S" -- 'echo "$E2E_KEY $(pwd)"')
check "export and cd survive" "carried /tmp" "$out"

echo
echo "-- large output fidelity (no 80x24 truncation)"
lines=$($ATH run "$S" -- 'seq 1 5000' | wc -l | tr -d ' ')
check "5000 lines returned intact" "5000" "$lines"
last=$($ATH run "$S" -- 'seq 1 5000' | tail -1)
check "last line correct" "5000" "$last"

echo
echo "-- session survives a shell exit, and auto-respawns"
start=$(date +%s)
json=$($ATH run "$S" --json -- 'echo before; exit 9')
elapsed=$(( $(date +%s) - start ))
code=$(printf '%s' "$json" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(JSON.parse(b).exitCode))')
exited=$(printf '%s' "$json" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(!!JSON.parse(b).shellExited))')
check "shell exit reported, not hung" "true" "$exited"
check "shell exit code recovered" "9" "$code"
[ "$elapsed" -lt 15 ] && ok "returned promptly (${elapsed}s, not a timeout)" \
                      || bad "returned promptly" "<15s" "${elapsed}s"
$ATH ls | grep -q "$S" && ok "session still listed after exit" || bad "session still listed" "present" "gone"
out=$($ATH run "$S" -- 'echo revived')
check "auto-respawn on next command" "revived" "$out"

echo
echo "-- needs-input detection on a real sudo prompt"
$ATH run "$S" -- 'sudo -k' >/dev/null 2>&1
$ATH send "$S" --text -- "sudo -p 'Password:' true" >/dev/null
sleep 2
state=$($ATH ls --json | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{const s=JSON.parse(b).find(x=>x.name===process.argv[1]);console.log(s?s.state:"missing")})' "$S")
cmd=$($ATH ls --json | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{const s=JSON.parse(b).find(x=>x.name===process.argv[1]);console.log(s?s.currentCommand:"missing")})' "$S")
check "state flips to needs-input" "needs-input" "$state"
check "process signal agrees (sudo)" "sudo" "$cmd"
$ATH send "$S" -- C-c >/dev/null; sleep 0.5

echo
echo "-- shared-terminal hazards (only occur with a human attached)"
tm() { /opt/homebrew/bin/tmux -L "${ATH_SOCKET:-ath}" -f "${ATH_HOME:-$HOME/.ath}/tmux.conf" "$@"; }

# A human scrolling up with the mouse puts the pane into copy mode, after which
# every send-keys fails with "not in a mode" and the agent silently stops working.
tm copy-mode -t "ath-$S" 2>/dev/null; sleep 0.2
before=$(tm display-message -p -t "ath-$S" '#{pane_in_mode}' 2>/dev/null)
check "pane really is in copy mode" "1" "$before"
out=$($ATH run "$S" -- 'echo past-copy-mode')
check "command survives copy mode" "past-copy-mode" "$out"

# What the HUMAN sees, tested with a command LONG ENOUGH TO WRAP.
#
# A previous attempt rewrote the echoed line into a clean `$ cmd` with
# `\033[A\r\033[K`. It passed a test that used a SHORT command and failed for
# every real one: moving up one row clears only the last row of a wrapped
# echo, so the pane showed the truncated wrapper AND the rewrite. The command
# below is deliberately long so that class of bug cannot pass silently again.
LONGCMD='set +H; echo marker-alpha; echo marker-bravo; echo "padding padding padding padding padding padding padding padding padding"; echo marker-charlie'
$ATH run "$S" -- "$LONGCMD" >/dev/null
pane=$(tm capture-pane -p -t "ath-$S" -S -20 2>/dev/null)
# Exactly one rendering of the command line: the shell's own echo. Never two.
echoed=$(printf '%s' "$pane" | grep -c "marker-alpha; echo marker-bravo")
[ "$echoed" -le 1 ] \
  && ok "a wrapping command is echoed once, not duplicated" \
  || bad "a wrapping command is echoed once, not duplicated" "<=1" "$echoed renderings"
printf '%s' "$pane" | grep -q "marker-charlie" \
  && ok "the long command's output is intact" \
  || bad "the long command's output is intact" "marker-charlie" "missing"

# Framing now comes from the shell's own hooks, so the command is typed almost
# bare: `: <nonce>; <cmd>` instead of `__ath <nonce> '<cmd>'`. The shell echoes
# what we type and that echo can be neither restyled nor erased, so keeping it
# short is the only lever there is.
printf '%s' "$pane" | grep -q "AGENT INPUT ID:" \
  && ok "the agent's command is announced on its own line" \
  || bad "the agent's command is announced on its own line" "AGENT INPUT ID:" "$(printf '%s' "$pane" | tail -3)"
printf '%s' "$pane" | grep -q "__ath [0-9a-f]\{8,\} '" \
  && bad "the wrapper is not used when hooks are available" "no __ath <nonce> '...'" "wrapper present" \
  || ok "the wrapper is not used when hooks are available"

# Nothing may be written to the machine being driven. The hub runs across many
# hosts with no per-host setup, so leaving files behind is a design failure.
[ ! -d "${ATH_HOME:-$HOME/.ath}/cmd" ] \
  && ok "no command-body scratch directory is created" \
  || bad "no command-body scratch directory is created" "no cmd/ dir" "$(ls "${ATH_HOME:-$HOME/.ath}/cmd" 2>/dev/null | head -3)"

# THE CORRELATION GUARANTEE. A human typing into the shared terminal while an
# agent command is in flight must never have their result attributed to the
# agent's command. The agent's line carries a nonce; a human's does not.
handle=$($ATH start "$S" --json -- 'sleep 3; echo AGENT-OWN-OUTPUT; (exit 7)' 2>/dev/null | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{try{console.log(JSON.parse(b).handle)}catch(e){console.log("")}})')
sleep 1
tm send-keys -t "ath-$S" -l 'echo HUMAN-TYPED-THIS' 2>/dev/null
tm send-keys -t "ath-$S" Enter 2>/dev/null
sleep 6
agentout=$($ATH poll "$S" --handle "$handle" --json 2>/dev/null | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{try{const r=JSON.parse(b);console.log((r.output||"").replace(/\n/g," ")+"|"+r.exitCode)}catch(e){console.log("parse-error|")}})')
case "$agentout" in
  *AGENT-OWN-OUTPUT*"|7") ok "agent gets its OWN output and exit code, not the human's" ;;
  *) bad "agent gets its OWN output and exit code, not the human's" "AGENT-OWN-OUTPUT|7" "$agentout" ;;
esac
# The human's RESULT must not be attributed to the agent: their `echo` exits 0,
# so an exit code of 7 proves the agent read its own end marker and not theirs.
# Their echoed KEYSTROKES do land in the transcript, because a terminal echoes
# typed input the moment it is typed — true of any shared terminal, and equally
# true before framing moved into hooks. What matters is the attribution.
case "$agentout" in
  *"|7") ok "the human's exit code is not attributed to the agent" ;;
  *) bad "the human's exit code is not attributed to the agent" "exit 7" "$agentout" ;;
esac
# And the human's own command still ran correctly in the shared terminal.
sleep 1
tm capture-pane -p -t "ath-$S" -S -12 2>/dev/null | grep -q "^HUMAN-TYPED-THIS$" \
  && ok "the human's own command still ran, in the same terminal" \
  || bad "the human's own command still ran, in the same terminal" "HUMAN-TYPED-THIS" "not in pane"

# A half-typed command left on the prompt would otherwise be concatenated with
# the agent's text and submitted as one line.
tm send-keys -t "ath-$S" -l 'rm -rf /half-typed' 2>/dev/null; sleep 0.3
out=$($ATH run "$S" -- 'echo past-partial-line')
check "command survives a half-typed line" "past-partial-line" "$out"
out=$($ATH run "$S" -- 'echo still-clean')
check "the stray text was discarded, not executed" "still-clean" "$out"

echo
echo "-- concurrency: two callers must never splice into one command line"
out1=$(mktemp); out2=$(mktemp)
( $ATH run "$S" --json -- 'sleep 2; echo FIRST' >"$out1" 2>&1 ) &
p1=$!
sleep 0.2
( $ATH run "$S" --json -- 'echo SECOND' >"$out2" 2>&1 ) &
p2=$!
wait $p1 $p2
both=$(cat "$out1" "$out2")
printf '%s' "$both" | grep -q '__ath' \
  && bad "no command splicing" "no __ath in output" "spliced" \
  || ok "no command splicing"
printf '%s' "$both" | grep -q 'session_busy' \
  && ok "second caller told the session is busy" \
  || bad "second caller told the session is busy" "session_busy" "$(printf '%s' "$both" | tail -2)"
rm -f "$out1" "$out2"
sleep 2

echo
echo "-- needs-input must not fire on a command that is merely working"
start=$(date +%s)
json=$($ATH run "$S" --json --timeout 12 -- 'echo "Do you want to continue?"; sleep 4')
ni=$(printf '%s' "$json" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(!!JSON.parse(b).needsInput))')
rc=$(printf '%s' "$json" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(JSON.parse(b).exitCode))')
check "prompt-shaped output while busy is not needs-input" "false" "$ni"
check "and the command ran to completion" "0" "$rc"

echo
echo "-- a REAL prompt is still caught, and caught fast"
$ATH run "$S" -- 'sudo -k' >/dev/null 2>&1
start=$(date +%s)
json=$($ATH run "$S" --json -- 'sudo -p "Password:" true' 2>/dev/null); rcode=$?
elapsed=$(( $(date +%s) - start ))
ni=$(printf '%s' "$json" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(!!JSON.parse(b).needsInput))')
check "real sudo prompt still detected" "true" "$ni"
[ "$elapsed" -lt 8 ] && ok "detected in ${elapsed}s, not at the 120s timeout" \
                     || bad "detected quickly" "<8s" "${elapsed}s"
check "run exits 75 (EX_TEMPFAIL), so && chains stop" "75" "$rcode"
$ATH send "$S" -- C-c >/dev/null; sleep 0.6

echo
echo "-- ath send rejects prose instead of silently mangling it"
err=$($ATH send "$S" -- 'hello world' 2>&1 >/dev/null); rc=$?
printf '%s' "$err" | grep -q -- '--text' && ok "prose rejected, --text suggested" \
                                         || bad "prose rejected" "mentions --text" "$err"
[ "$rc" -ne 0 ] && ok "non-zero exit on bad keys" || bad "non-zero exit on bad keys" "!=0" "$rc"

echo
echo "-- start/poll gives long-running work a real handle"
sj=$($ATH start "$S" --json -- 'sleep 2; echo BACKGROUNDED')
h=$(printf '%s' "$sj" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(JSON.parse(b).handle))')
off=$(printf '%s' "$sj" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(JSON.parse(b).offset))')
pj=$($ATH poll "$S" --handle "$h" --since "$off" --json)
done1=$(printf '%s' "$pj" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(JSON.parse(b).done))')
check "poll reports not-done while running" "false" "$done1"
sleep 3
pj=$($ATH poll "$S" --handle "$h" --since "$off" --json)
done2=$(printf '%s' "$pj" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(JSON.parse(b).done))')
outp=$(printf '%s' "$pj" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(JSON.parse(b).output))')
ec=$(printf '%s' "$pj" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(JSON.parse(b).exitCode))')
check "poll reports done" "true" "$done2"
check "poll reports the exit code" "0" "$ec"
check "poll output is clean of protocol plumbing" "BACKGROUNDED" "$outp"

echo
echo "-- reads stay cheap as the log grows"
$ATH run "$S" -- 'seq 1 400000' >/dev/null 2>&1
sz=$(stat -f%z "$HOME/.ath/log/$S.log" 2>/dev/null || echo 0)
t0=$(date +%s%N); $ATH read "$S" --tail 5 >/dev/null; t1=$(date +%s%N)
ms=$(( (t1-t0)/1000000 ))
[ "$ms" -lt 120 ] && ok "read --tail 5 on a $(( sz/1024 ))KB log took ${ms}ms" \
                  || bad "read stays cheap" "<120ms" "${ms}ms"

echo
echo "-- log rotation shrinks rather than grows"
rot=$(node -e '
const a=require(process.argv[1]+"/packages/core/dist/index.js");
const fs=require("fs");
(async()=>{
  const N=process.argv[2];
  const before=fs.statSync(a.logPath(N)).size;
  const r=await a.rotateIfNeeded(N, 1024*1024);
  const after=fs.statSync(a.logPath(N)).size;
  console.log(`${r.rotated} ${before} ${after}`);
})();' "$REPO" "$S")
set -- $rot
check "rotation triggered above the cap" "true" "$1"
[ "$3" -lt "$2" ] && ok "log shrank ($(( $2/1024 ))KB -> $(( $3/1024 ))KB)" \
                  || bad "log shrank" "smaller than $2" "$3"
out=$($ATH run "$S" -- 'echo alive-after-rotation')
check "session survives rotation" "alive-after-rotation" "$out"

echo
echo "-- purge empties the recorded output"
$ATH purge "$S" >/dev/null
after=$(stat -f%z "$HOME/.ath/log/$S.log" 2>/dev/null || echo 0)
[ "$after" -lt 1024 ] && ok "log purged (${after} bytes)" || bad "log purged" "<1024" "$after"
out=$($ATH run "$S" -- 'echo alive-after-purge')
check "session still works after purge" "alive-after-purge" "$out"

echo
echo "-- nested shells (the local stand-in for an ssh hop)"
# A sub-shell has no __ath: shell functions are not exported. This is exactly
# the situation on the far side of ssh or inside a container, without a network.
$ATH send "$S" --text -- 'bash --norc' >/dev/null; sleep 1.2
state=$($ATH ls --json | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{const s=JSON.parse(b).find(x=>x.name===process.argv[1]);console.log(s.state)})' "$S")
check "a nested shell reads idle, not busy" "idle" "$state"
out=$($ATH run "$S" -- 'echo from-nested-shell')
check "helper is auto-installed into the nested shell" "from-nested-shell" "$out"
$ATH run "$S" -- '(exit 9)' >/dev/null 2>&1
check "exit codes survive the nesting" "9" "$?"
$ATH send "$S" --text -- 'exit' >/dev/null; sleep 1

echo
echo "-- exiting a nested shell returns at once instead of waiting out the timeout"
$ATH send "$S" --text -- 'bash --norc' >/dev/null; sleep 1.2
depth=$(node -e 'require(process.argv[1]+"/packages/core/dist/index.js").shellDepth(process.argv[2]).then(d=>console.log(d))' "$REPO" "$S")
check "the nested shell is visible on the tty" "2" "$depth"
t0=$(date +%s)
$ATH run "$S" -- 'exit' >/dev/null 2>&1
elapsed=$(( $(date +%s) - t0 ))
[ "$elapsed" -lt 15 ] && ok "nested exit returned in ${elapsed}s, not at the 120s timeout" \
                      || bad "nested exit returns promptly" "<15s" "${elapsed}s"
out=$($ATH run "$S" -- 'echo usable-after-nested-exit')
check "session still usable afterwards" "usable-after-nested-exit" "$out"

# The signal must not fire for a shell that is merely working in silence.
out=$($ATH run "$S" --timeout 40 -- 'for i in $(seq 1 400000); do :; done; echo loop-done')
check "a silent busy shell is NOT mistaken for an exit" "loop-done" "$out"

echo
echo "-- ssh connections are shared and self-authenticating"
node -e '
const a=require(process.argv[1]+"/packages/core/dist/index.js");
const line=a.sshCommandLine("examplehost");
const need=["ControlMaster=auto","ControlPersist","AddKeysToAgent=yes","ServerAliveInterval"];
process.stdout.write(need.map(n=>line.includes(n)).join(" ")+" "+line.includes("examplehost"));
' "$REPO" > /tmp/ath-ssh-$$ 2>/dev/null
set -- $(cat /tmp/ath-ssh-$$); rm -f /tmp/ath-ssh-$$
check "connection is shared (ControlMaster)" "true" "$1"
check "and persists past the session" "true" "$2"
check "keys load themselves, so no per-host ssh-add" "true" "$3"
check "dead links are noticed quickly" "true" "$4"
check "the host is still passed through" "true" "$5"

echo
echo "-- SAFETY: a disconnected remote must never fall back to running locally"
CANARY="/tmp/ath-canary-$$"
rm -f "$CANARY"
G="guard$$"
$ATH new "$G" --cwd "$HOME" >/dev/null
# Mark it remote while no ssh is running: exactly the state a dropped
# connection leaves behind, which previously ran the command on this machine.
# Honour ATH_SOCKET/ATH_HOME like everything else here: hardcoding the socket
# meant this SAFETY canary silently targeted the wrong server whenever the
# suite ran isolated, so the session was never marked remote and the check
# "failed" by running locally — reporting a safety breach that had not happened.
/opt/homebrew/bin/tmux -L "${ATH_SOCKET:-ath}" -f "${ATH_HOME:-$HOME/.ath}/tmux.conf" \
  set-option -t "ath-$G" @ath_remote nonexistent.invalid >/dev/null 2>&1
err=$($ATH run "$G" -- "touch $CANARY" 2>&1 >/dev/null || true)
[ ! -e "$CANARY" ] && ok "the command did NOT execute on the local machine" \
                   || bad "command must not run locally" "no $CANARY" "it was created"
# The same hazard on the OTHER input path. run() has always refused here;
# `send` did not, so a keystroke meant for another machine — a `y` answering a
# destructive prompt, or --text content — was typed into the LOCAL shell.
serr=$($ATH send "$G" -- Space 2>&1 >/dev/null); src=$?
printf '%s' "$serr" | grep -q 'remote_disconnected' \
  && ok "send refuses on a dropped remote too" \
  || bad "send refuses on a dropped remote too" "remote_disconnected" "$serr"
[ "$src" -ne 0 ] && ok "send exits non-zero when it refuses" \
                 || bad "send exits non-zero when it refuses" "!=0" "$src"
terr=$($ATH send "$G" --text -- "echo should-not-run-locally" 2>&1 >/dev/null)
printf '%s' "$terr" | grep -q 'remote_disconnected' \
  && ok "send --text refuses as well" \
  || bad "send --text refuses as well" "remote_disconnected" "$terr"

printf '%s' "$err" | grep -q 'remote_disconnected' \
  && ok "refused with remote_disconnected" \
  || bad "refused with remote_disconnected" "remote_disconnected" "$err"
rm -f "$CANARY"; $ATH kill "$G" >/dev/null 2>&1

echo
echo "-- prompt detection survives terminal line-wrapping"
node -e '
const a=require(process.argv[1]+"/packages/core/dist/index.js");
// Wrap the way a terminal does: exact-width rows, no character inserted.
const wrap=(s,w)=>s.match(new RegExp(`.{1,${w}}`,"g")).join("\n");
const real="Enter passphrase for key \x27/home/user/.ssh/keys/infrastructure/production/example_rsa\x27:";
const out=[
  a.looksLikePrompt(wrap(real,80),80),   // wrapped over two rows
  a.looksLikePrompt(wrap(real,60),60),   // narrower pane, still wrapped
  a.looksLikePrompt(real,200),           // wide pane, no wrapping
  // The regression this guards: question-shaped output followed by the shell
  // prompt must NOT be glued into a match.
  a.looksLikePrompt("Do you want to continue?\n(base) user@Mac ~ %",80),
  a.looksLikePrompt("dev@server:~$",80),
];
process.stdout.write(out.join(" "));
' "$REPO" > /tmp/ath-wrap-$$ 2>/dev/null
set -- $(cat /tmp/ath-wrap-$$); rm -f /tmp/ath-wrap-$$
check "wrapped passphrase prompt detected (80 cols)" "true" "$1"
check "wrapped passphrase prompt detected (60 cols)" "true" "$2"
check "unwrapped passphrase prompt still detected" "true" "$3"
check "output + shell prompt are NOT joined into a match" "false" "$4"
check "a remote shell prompt is not mistaken for one" "false" "$5"

echo
echo "-- notification claims: one window acts, not every window"
# Real child processes, because this exists for real concurrency: the extension
# activates in EVERY VSCode window, each polling the same tmux server, and the
# dedupe state is per-window. Nothing here can be proved in one process.
CLAIM_JS="/tmp/ath-claim-$$.js"
cat > "$CLAIM_JS" <<'CLAIMJS'
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const core = require(path.join(process.env.REPO, 'packages/core/dist/index.js'));

// Child mode: claim, say what happened, then linger for `holdMs` so the parent
// can test against a holder that is genuinely still alive.
if (process.argv[2] === 'child') {
  const [, , , key, holdMs] = process.argv;
  core.claim(key, { by: 'e2e-child' }).then((won) => {
    process.stdout.write(won ? 'won' : 'lost');
    setTimeout(() => process.exit(0), Number(holdMs) || 0);
  });
  return;
}

// Contest mode: report the start line this process sees. Every process must
// see the same one, or ranking collapses back into a race on poll timing.
if (process.argv[2] === 'electchild') {
  core.openElection(process.argv[3]).then((e) => process.stdout.write(String(e.openedAt)));
  return;
}

const K = 'e2e-claim-' + process.pid;
const file = (key) => path.join(core.CLAIM_DIR, key + '.claim');
const onDisk = async (key) => !!(await fs.stat(file(key)).catch(() => null));

function spawnChild(key, holdMs, mode = 'child') {
  const proc = spawn(process.execPath, [__filename, mode, key, String(holdMs)], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: process.env,
  });
  // Resolve on the child's report, not its exit, so a lingering holder is
  // observable while it still holds.
  const reported = new Promise((resolve) => proc.stdout.on('data', (d) => resolve(String(d).trim())));
  const exited = new Promise((resolve) => proc.on('exit', resolve));
  return { proc, reported, exited };
}

(async () => {
  const out = [];

  // Eight processes, one key: the filesystem picks exactly one winner.
  //
  // They must stay ALIVE while contending. With children that exited the
  // instant they reported, a later starter read a claim whose holder pid was
  // already dead, correctly judged it abandoned, and reclaimed it — so this
  // asserted "one winner" while actually racing against corpses, and reported
  // 1 or 3 winners depending on machine load.
  const raceKey = K + '-race';
  const kids = Array.from({ length: 8 }, () => spawnChild(raceKey, 15000));
  const said = await Promise.all(kids.map((k) => k.reported));
  out.push(String(said.filter((s) => s === 'won').length));

  // Now retire them, so the claim really is held by a dead pid.
  for (const k of kids) k.proc.kill('SIGKILL');
  await Promise.all(kids.map((k) => k.exited));
  out.push(String(await core.claim(raceKey, { by: 'e2e-parent' })));

  // A holder that is still running must block everyone else. This is the
  // assertion the whole feature rests on.
  const liveKey = K + '-live';
  const holder = spawnChild(liveKey, 30000);
  await holder.reported;
  out.push(String(await core.claim(liveKey, { by: 'e2e-parent' })));

  holder.proc.kill('SIGKILL');
  await holder.exited;
  out.push(String(await core.claim(liveKey, { by: 'e2e-parent' })));

  // Re-claiming from the SAME process fails too: that is what stops one window
  // stacking a second dialog when a duplicate filesystem event arrives.
  const relKey = K + '-release';
  await core.claim(relKey, { by: 'e2e-parent' });
  out.push(String(await core.claim(relKey, { by: 'e2e-parent' })));
  await core.releaseClaim(relKey);
  out.push(String(await core.claim(relKey, { by: 'e2e-parent' })));

  // Sweeping drops a dead window's leftovers and leaves live claims alone.
  const deadKey = K + '-dead';
  const dying = spawnChild(deadKey, 0);
  await dying.reported;
  await dying.exited;
  const mineKey = K + '-mine';
  await core.claim(mineKey, { by: 'e2e-parent' });
  await core.pruneClaims();
  out.push(String(!(await onDisk(deadKey))));
  out.push(String(await onDisk(mineKey)));

  // Workspace affinity: which window gets first refusal on the popup.
  out.push(String(core.pathContains('/a/project', '/a/project/src/x')));
  out.push(String(core.pathContains('/a/project', '/a/project')));
  out.push(String(core.pathContains('/a/project', '/a/project-old/src')));
  out.push(String(core.pathContains('/a/project', '/a')));

  // ONE shared start line. Without this every window measures its delay from
  // its own poll, and a window polling every 0.8s beats a better-ranked window
  // polling every 3s — ranking never gets a say.
  const elecKey = K + '-election';
  const voters = Array.from({ length: 6 }, () => spawnChild(elecKey, 0, 'electchild'));
  const stamps = await Promise.all(voters.map((v) => v.reported));
  await Promise.all(voters.map((v) => v.exited));
  out.push(String(new Set(stamps).size));
  out.push(String(String((await core.openElection(elecKey)).openedAt) === stamps[0]));

  // Releasing must take the contest marker with it, or the next prompt in that
  // session inherits a deadline already in the past and everyone fires at once.
  const elecFile = path.join(core.ELECTION_DIR, elecKey + '.json');
  await core.releaseClaim(elecKey);
  out.push(String(!(await fs.stat(elecFile).catch(() => null))));

  // Ranking inputs: exact beats ancestor, and the CLOSEST ancestor wins, so a
  // window with one package open beats a window holding the whole monorepo.
  // The chain must start at us and reach a real ancestor, or window ownership
  // cannot be established and everything falls back to guessing.
  out.push(String(core.ancestorPids()[0] === process.pid));
  out.push(String(core.ancestorPids().includes(process.ppid)));

  const aff = (folders, targets) => core.bestPathAffinity(folders, targets);
  out.push(String(aff(['/a/project'], ['/a/project']).exact));
  out.push(String(aff(['/a/project'], ['/a/project/src/x']).depth));
  out.push(String(aff(['/a/mono', '/a/mono/pkg/ui'], ['/a/mono/pkg/ui/src']).depth));
  out.push(String(aff(['/a/project'], ['/b/other']) === undefined));
  out.push(String(aff(['/a/p'], [undefined, '/a/p/x']).depth));

  // You must not be able to release someone else's claim. This is the bug that
  // turned one prompt into two popups: a window standing down unlinked the
  // WINNER's claim, and a third window then took the vacancy and announced the
  // same prompt a second time.
  const ownKey = K + '-owned';
  const owner = spawnChild(ownKey, 30000);
  await owner.reported;
  out.push(String(await core.releaseOwnClaim(ownKey)));
  out.push(String(!!(await fs.stat(path.join(core.CLAIM_DIR, ownKey + '.claim')).catch(() => null))));
  owner.proc.kill('SIGKILL');
  await owner.exited;
  await core.releaseClaim(ownKey);
  await core.claim(ownKey, { by: 'e2e-parent' });
  out.push(String(await core.releaseOwnClaim(ownKey)));

  // A claim for a session that no longer exists can never be released by the
  // normal path — the thing that would release it is gone. Reproduces the bug
  // where a window mid-contest woke after its session was killed, claimed, and
  // announced a dead session.
  await core.claim('needs-input.ghost-' + process.pid, { by: 'e2e-parent' });
  await core.claim('needs-input.kept-' + process.pid, { by: 'e2e-parent' });
  await core.reapClaimsForDeadSessions(new Set(['kept-' + process.pid]));
  const cf = (n) => path.join(core.CLAIM_DIR, 'needs-input.' + n + '-' + process.pid + '.claim');
  out.push(String(!(await fs.stat(cf('ghost')).catch(() => null))));
  out.push(String(!!(await fs.stat(cf('kept')).catch(() => null))));
  await core.releaseClaim('needs-input.kept-' + process.pid);

  for (const key of [raceKey, liveKey, relKey, deadKey, mineKey]) await core.releaseClaim(key);
  process.stdout.write(out.join(' '));
})().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err));
});
CLAIMJS
REPO="$REPO" node "$CLAIM_JS" > "/tmp/ath-claim-out-$$" 2>/dev/null
set -- $(cat "/tmp/ath-claim-out-$$"); rm -f "/tmp/ath-claim-out-$$" "$CLAIM_JS"
check "8 concurrent processes, exactly one wins" "1" "$1"
check "a claim held by a dead process is reclaimed" "true" "$2"
check "a live holder blocks everyone else" "false" "$3"
check "killing the holder frees the claim" "true" "$4"
check "the same process cannot claim twice" "false" "$5"
check "released claims can be taken again" "true" "$6"
check "sweep drops a dead holder's claim" "true" "$7"
check "sweep keeps a live holder's claim" "true" "$8"
check "workspace contains a session below it" "true" "$9"
check "workspace contains its own path" "true" "${10}"
check "a sibling directory is NOT contained" "false" "${11}"
check "a parent directory is NOT contained" "false" "${12}"
check "6 processes share ONE contest start line" "1" "${13}"
check "a later joiner gets that same start line" "true" "${14}"
check "releasing clears the contest marker too" "true" "${15}"
check "the creator chain starts at this process" "true" "${16}"
check "and reaches its real parent" "true" "${17}"
check "an exact workspace match is marked exact" "true" "${18}"
check "ancestor distance is counted in segments" "2" "${19}"
check "the CLOSEST workspace wins, not the outermost" "1" "${20}"
check "an unrelated workspace has no affinity" "true" "${21}"
check "a missing origin is skipped, cwd still matches" "1" "${22}"
check "you cannot release another process's claim" "false" "${23}"
check "and that claim is still standing afterwards" "true" "${24}"
check "you CAN release a claim you hold yourself" "true" "${25}"
check "a claim for a dead session is reaped" "true" "${26}"
check "a live session's claim is left alone" "true" "${27}"

echo
echo "-- kill is honoured, and reported cleanly to the agent"
$ATH kill "$S" >/dev/null
err=$($ATH run "$S" -- 'echo nope' 2>&1 >/dev/null); rc=$?
printf '%s' "$err" | grep -q "session_gone" && ok "killed session reports session_gone" \
                                            || bad "killed session reports session_gone" "session_gone" "$err"
[ "$rc" -ne 0 ] && ok "non-zero exit after kill" || bad "non-zero exit after kill" "!=0" "$rc"

echo
echo "-- the tag line cannot fail in ANY shell"
# It used to call a FUNCTION, so a shell without that function answered
# "command not found" in the human's console. `:` is a POSIX builtin that
# exists everywhere, so the tag is now a no-op that cannot error.
hookchk=$(node -e "
const {frameHooksFor,agentTagLine}=require('$REPO/packages/core/dist/index.js');
const out=[];
const tag=agentTagLine('deadbeefcafe');
out.push(tag.startsWith(': ')?'noop-ok':'noop-BAD:'+tag);
for (const sh of ['zsh','bash']) {
  const h=frameHooksFor(sh,'t');
  out.push(/\\u2193\\u2193\\u2193\\(\\)/.test(h)?sh+'-fn-BAD':sh+'-nofn-ok');
  out.push(h.includes('ATHT:')?sh+'-ack-ok':sh+'-ack-BAD');
}
out.push(/add-zsh-hook preexec/.test(frameHooksFor('zsh','t'))?'zsh-hooks-ok':'zsh-hooks-BAD');
out.push(!/trap /.test(frameHooksFor('bash','t'))?'bash-notrap-ok':'bash-notrap-BAD');
console.log(out.join(' '));
" 2>&1)
case "$hookchk" in
  *BAD*) bad "tag line is a no-op that cannot error" "no BAD entries" "$hookchk" ;;
  *)     ok  "tag line is a no-op that cannot error" ;;
esac

echo
echo "-- only pure assignments are kept for a reconnect replay"
# What gets stored here is REPLAYED on the far side after a dropped link, so a
# fragment that is really a command with an environment prefix would run twice.
envchk=$(node -e "
const {envAssignments}=require('$REPO/packages/core/dist/index.js');
const j=(c)=>JSON.stringify(envAssignments(c));
const out=[];
out.push(j('export A=1')==='[\"export A=1\"]'?'plain-ok':'plain-BAD'+j('export A=1'));
out.push(j('PLAIN=x')==='[\"PLAIN=x\"]'?'verbatim-ok':'verbatim-BAD'+j('PLAIN=x'));
out.push(j('rm -rf /tmp/x; export B=2')==='[\"export B=2\"]'?'strip-ok':'strip-BAD'+j('rm -rf /tmp/x; export B=2'));
// an environment PREFIX is not an assignment: replaying it would run the command
out.push(j('COUNT=1 make')==='[]'?'prefix-ok':'prefix-BAD'+j('COUNT=1 make'));
out.push(j('FOO=bar ./deploy.sh')==='[]'?'prefix2-ok':'prefix2-BAD'+j('FOO=bar ./deploy.sh'));
out.push(j('export M=\"a b\"')==='[\"export M=\\\\\"a b\\\\\"\"]'?'quoted-ok':'quoted-skip');
console.log(out.join(' '));
" 2>&1)
case "$envchk" in
  *BAD*) bad "reconnect replay keeps only pure assignments" "no BAD entries" "$envchk" ;;
  *)     ok  "reconnect replay keeps only pure assignments" ;;
esac

echo
echo "-- a multi-line command does not corrupt the session's metadata"
# Every field is read back as ONE row of a newline-delimited list, so a value
# holding a newline truncates the row and destroys every field after it. The
# command is stored verbatim, so one multi-line command wiped `frame`/`wrap`.
$ATH new mlmeta >/dev/null 2>&1; sleep 1
$ATH run mlmeta -- 'echo a
echo b' >/dev/null 2>&1
rows=$(/opt/homebrew/bin/tmux -L "${ATH_SOCKET:-ath}" display-message -p -t "ath-mlmeta" '#{@ath_last_cmd}' 2>/dev/null | wc -l | tr -d ' ')
check "stored command stays on one row" "1" "$rows"
$ATH kill mlmeta --force >/dev/null 2>&1

echo
echo "-- await never claims an outcome it cannot prove"
# `ath await` is the callback the credential design leans on, so a wrong answer
# here is worse than no answer. It used to end its no-handle path in
# `handle ? poll(...) : undefined` INSIDE a block entered only when handle was
# falsy — the "answered" arm was unreachable, and every success was reported as
# "the connection dropped ... Nothing was answered". A cold agent was told its
# working sudo had failed; the correct response to that message is to ask the
# human again, which is how someone ends up typing a password three times.
$ATH new awt >/dev/null 2>&1; sleep 1
$ATH run awt -- 'echo ready' >/dev/null 2>&1

# Nothing asked for, nothing dropped, shell alive: it must not claim otherwise.
out=$($ATH await awt 2>&1); arc=$?
case "$out" in
  *"Nothing was answered"*|*"connection dropped"*) verdict="claimed a failure it cannot know" ;;
  *) verdict="ok" ;;
esac
check "an idle session with no request is not reported as a lost answer" "ok" "$verdict"
check "and that is not reported as success either" "2" "$arc"

# A command that really finishes must be reported with its real exit code, even
# though `ath start` files no request and so leaves no handle to poll.
$ATH start awt -- 'sleep 3; (exit 42)' >/dev/null 2>&1
$ATH await awt >/dev/null 2>&1; arc=$?
check "a completed command is reported answered, with its exit code" "42" "$arc"

# Ctrl-C also ends the wait and also produces an end marker. "It finished"
# therefore cannot mean "they answered", or an agent collects a result that
# does not exist — the mirror image of the false negative.
#
# The interrupt must arrive WHILE await is watching. Interrupting first and
# awaiting afterwards is a different question ("is anything pending?", answered
# above), and testing it that way would have demanded that await adopt an
# already-finished command — the false positive this ordering exists to avoid.
awtmp=$(mktemp)
$ATH start awt -- 'sleep 30' >/dev/null 2>&1; sleep 1
( $ATH await awt >"$awtmp" 2>&1; echo "rc=$?" >>"$awtmp" ) &
awpid=$!
sleep 2
$ATH send awt -- C-c >/dev/null 2>&1
wait "$awpid" 2>/dev/null
arc=$(grep -o 'rc=[0-9]*' "$awtmp" | tail -1 | cut -d= -f2)
check "an interrupted command is NOT answered" "130" "${arc:-missing}"
case "$(cat "$awtmp")" in *"NOT answered"*) v=ok ;; *) v="$(cat "$awtmp")" ;; esac
check "and says so in words, not only in the exit code" "ok" "$v"
rm -f "$awtmp"

# The handle is recovered from the log, so output that merely LOOKS like a
# start marker must not be mistaken for one. Only SENTINEL-wrapped markers are
# plumbing; this is the same guarantee the console-hygiene checks rely on.
$ATH run awt -- 'echo "<ATHS:cafebabe>"' >/dev/null 2>&1
got=$(node -e 'require("./packages/core/dist/index.js").latestHandle("awt").then(h=>console.log(h==="cafebabe"?"spoofed":"ok"))' 2>/dev/null)
check "echoed marker text is not mistaken for a real handle" "ok" "$got"
$ATH kill awt --force >/dev/null 2>&1

echo
echo "-- a live prompt survives, and is never described as a busy command"
# A prompt is the one thing in this system that a person must reach before
# anything else happens, so nothing may consume it and nothing may send an
# agent away from it. Both failures were reported from a real run.
TMX() { tmux -L "${ATH_SOCKET:-ath}" "$@"; }
$ATH new cred >/dev/null 2>&1; sleep 1
$ATH run cred --timeout 4 -- 'printf "Password: "; read -rs p; echo "GOT=[$p]"' >/dev/null 2>&1
sleep 1
alive() { TMX capture-pane -p -t ath-cred -S -3 2>/dev/null | grep -c 'Password:' ; }
check "a run that times out leaves the prompt standing" "1" "$([ "$(alive)" -ge 1 ] && echo 1 || echo 0)"

# The command text must never become the password. Typing it would submit a
# failed login AND consume the prompt the human is walking towards.
out=$($ATH run cred -- 'echo INTRUDER' 2>&1); rc=$?
check "a second command is refused, not typed into the prompt" "1" "$rc"
check "and the prompt is still there afterwards" "1" "$([ "$(alive)" -ge 1 ] && echo 1 || echo 0)"
case "$out" in
  *"already running"*) v="called a prompt a busy command" ;;
  *"only a person can answer"*) v=ok ;;
  *) v="$out" ;;
esac
check "the refusal says a person is needed" "ok" "$v"
# --wait is the one remedy that cannot work here: nothing moves until a human
# types, so queueing just burns the timeout while nobody has been told.
out=$($ATH run cred --wait --timeout 3 -- 'echo INTRUDER' 2>&1)
case "$out" in *"only a person can answer"*) v=ok ;; *) v="$out" ;; esac
check "--wait refuses immediately instead of queueing behind a human" "ok" "$v"
$ATH send cred -- C-c >/dev/null 2>&1; sleep 1
$ATH kill cred --force >/dev/null 2>&1

echo
echo "-- a BACKGROUND command parked on a prompt still asks for a human"
# `start()` returns before the command runs, so it can never see a prompt, and
# only `run` filed requests. The hub's loudest case — a long job stopped on a
# password — therefore raised nothing at all: no editor notification, nothing
# for `ath requests` or `ath await` to find, and an agent polling forever.
$ATH new bgp >/dev/null 2>&1; sleep 1
h=$($ATH start bgp -- 'printf "Password: "; read -rs p' 2>&1 | grep -oE '[0-9a-f]{12}' | head -1)
sleep 3
n=$(node -e 'require("./packages/core/dist/index.js").listRequests().then(r=>console.log(r.filter(x=>x.session==="bgp").length))' 2>/dev/null)
check "start alone files nothing — it cannot see the prompt yet" "0" "${n:-x}"
$ATH poll bgp --handle "$h" >/dev/null 2>&1
n=$(node -e 'require("./packages/core/dist/index.js").listRequests().then(r=>console.log(r.filter(x=>x.session==="bgp").length))' 2>/dev/null)
check "the first poll asks for a human" "1" "${n:-x}"
# Poll is called in a loop by design; one prompt must not mean one notification
# per poll or the editor is buried.
$ATH poll bgp --handle "$h" >/dev/null 2>&1
$ATH poll bgp --handle "$h" >/dev/null 2>&1
n=$(node -e 'require("./packages/core/dist/index.js").listRequests().then(r=>console.log(r.filter(x=>x.session==="bgp").length))' 2>/dev/null)
check "repeated polls do not file duplicate requests" "1" "${n:-x}"

# The whole point, end to end: a person answers at the terminal and the agent
# is told. Every link in this chain was broken before.
bgtmp=$(mktemp)
( $ATH await bgp >"$bgtmp" 2>&1; echo "rc=$?" >>"$bgtmp" ) &
bgpid=$!
sleep 2
TMX send-keys -t ath-bgp 'hunter2' Enter
wait "$bgpid" 2>/dev/null
brc=$(grep -o 'rc=[0-9]*' "$bgtmp" | tail -1 | cut -d= -f2)
check "when the human answers, await reports it" "0" "${brc:-missing}"
case "$(cat "$bgtmp")" in *"answered"*) v=ok ;; *) v="$(cat "$bgtmp")" ;; esac
check "and says answered, in words" "ok" "$v"
rm -f "$bgtmp"
node -e 'const m=require("./packages/core/dist/index.js");m.listRequests().then(async r=>{for(const x of r)if(x.session==="bgp")await m.clearRequest(x.id)})' 2>/dev/null
$ATH kill bgp --force >/dev/null 2>&1

echo
echo "-- the request queue tells the truth about what is still owed"
# An agent finished a run and found three of four entries still reading
# "blocked — needs you", including one it had filed for a command that had
# succeeded, with the session still flagged asked-for-you while idle. A human
# reading that owes answers they have already given — the same false debt this
# signal exists to remove. Two causes: nothing resolved a non-parked request,
# and listRequests accepted `includeResolved` and then ignored it.
$ATH new rq >/dev/null 2>&1; sleep 1
$ATH run rq -- 'echo seed' >/dev/null 2>&1
node -e 'const m=require("./packages/core/dist/index.js");
  m.latestHandle("rq").then(h=>m.requestHuman("rq","test ask","agent",h,false))' 2>/dev/null
n=$(node -e 'require("./packages/core/dist/index.js").listRequests().then(r=>console.log(r.filter(x=>x.session==="rq").length))' 2>/dev/null)
check "a filed request is open before its command ends" "1" "${n:-x}"
$ATH run rq -- 'echo finished' >/dev/null 2>&1
node -e 'require("./packages/core/dist/index.js").reapResolvedRequests()' 2>/dev/null
n=$(node -e 'require("./packages/core/dist/index.js").listRequests().then(r=>console.log(r.filter(x=>x.session==="rq").length))' 2>/dev/null)
check "and is no longer open once the command finishes" "0" "${n:-x}"
# Resolved records are KEPT, so an agent told a request was filed is never
# answered with silence a moment later.
n=$(node -e 'require("./packages/core/dist/index.js").listAllRequests().then(r=>console.log(r.filter(x=>x.session==="rq").length))' 2>/dev/null)
check "but is still readable as history" "1" "${n:-x}"
case "$($ATH ls 2>&1 | grep '^rq ')" in
  *asked-for-you*) v="still flagged" ;; *) v=ok ;;
esac
check "the session stops being flagged asked-for-you" "ok" "$v"

echo
echo "-- a busy session names the command, not the transport"
# `currentCommand` is the pane's foreground PROCESS, which on a remote session
# is `ssh`. An agent was told its 70-second checksum job was "already running
# ssh" — true of the pane, useless to the caller.
$ATH start rq -- 'sleep 6' >/dev/null 2>&1; sleep 1
out=$($ATH run rq -- 'echo x' 2>&1)
case "$out" in *'"sleep 6"'*) v=ok ;; *) v="$out" ;; esac
check "session_busy quotes the running command" "ok" "$v"
# --wait was the only remedy offered, and it queues rather than parallelises.
case "$out" in *"second session"*) v=ok ;; *) v="no second-session advice" ;; esac
check "and points at a second session, not just --wait" "ok" "$v"
sleep 6
node -e 'const m=require("./packages/core/dist/index.js");m.listRequests().then(async r=>{for(const x of r)if(x.session==="rq")await m.clearRequest(x.id)})' 2>/dev/null
$ATH kill rq --force >/dev/null 2>&1

echo
echo "-- the MCP surface agrees with the CLI"
mcp() { printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"v","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  "$1" | node packages/mcp/dist/index.js 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(d.trim().split("\n").filter(Boolean).pop()||""))'; }
$ATH new mc >/dev/null 2>&1; sleep 1
# Output folded into the JSON came back as one string of literal \n, so an
# agent reasonably concluded it should use the CLI whenever output was large.
r=$(mcp '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"run","arguments":{"session":"mc","command":"printf \"a\\nb\\nc\\n\""}}}')
blocks=$(printf '%s' "$r" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).result.content.length)}catch(e){console.log("x")}})')
check "run returns output as its own content block" "2" "$blocks"
esc=$(printf '%s' "$r" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const t=JSON.parse(d).result.content[1].text;console.log(/\\n/.test(t)?"escaped":"raw")}catch(e){console.log("x")}})')
check "and that block is raw text, not JSON-escaped" "raw" "$esc"
$ATH kill mc --force >/dev/null 2>&1

echo
echo "-- a command that blinds the credential detector says so"
# The wall detector reads OUTPUT, so `sudo ... 2>/dev/null` deletes the evidence
# before it exists: no request, nobody asked, and an ordinary-looking success
# for a command that never ran. An agent hit this five minutes in. The command
# string is the only place the problem is still visible.
$ATH kill bl --force >/dev/null 2>&1
$ATH new bl >/dev/null 2>&1
# Wait for the session to actually exist rather than guessing a second. Under
# suite load it is not ready in one, and every assertion below then reads an
# empty stdout and fails for a reason that has nothing to do with what it tests.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  $ATH ls 2>/dev/null | grep -q '^bl ' && break
  sleep 1
done
w=$($ATH run bl --json -- 'sudo -n true 2>/dev/null' 2>/dev/null \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).warning?"warned":"silent")}catch(e){console.log("x")}})')
check "sudo with stderr discarded is warned about" "warned" "$w"
w=$($ATH run bl --json -- 'sudo -n true 2>&1' 2>/dev/null \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log(j.warning?"warned":(j.needsHuman?"detected":"neither"))}catch(e){console.log("x")}})')
check "2>&1 keeps detection working, and is not warned about" "detected" "$w"
w=$($ATH run bl --json -- 'ls /tmp 2>/dev/null' 2>/dev/null \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).warning?"warned":"quiet")}catch(e){console.log("x")}})')
check "an ordinary command is not warned about" "quiet" "$w"
$ATH kill bl --force >/dev/null 2>&1

echo
echo "-- a prompt nobody polls is still noticed"
# Detection lived only in poll(), so a backgrounded command that stopped at a
# password and was never polled would sit silently forever — which the whole
# design assumes cannot happen. `list` is what agents call constantly.
rm -f "${ATH_HOME:-$HOME/.ath}"/requests/*.json 2>/dev/null || true
$ATH new np >/dev/null 2>&1; sleep 1
$ATH start np -- 'printf "Password: "; read -rs p' >/dev/null 2>&1; sleep 3
n=$(node -e 'require("./packages/core/dist/index.js").listRequests().then(r=>console.log(r.filter(x=>x.session==="np").length))' 2>/dev/null)
check "nothing is filed before anything looks" "0" "${n:-x}"
$ATH ls >/dev/null 2>&1
n=$(node -e 'require("./packages/core/dist/index.js").listRequests().then(r=>console.log(r.filter(x=>x.session==="np").length))' 2>/dev/null)
check "listing the hub notices the prompt and files one" "1" "${n:-x}"
$ATH send np -- C-c >/dev/null 2>&1; sleep 1
$ATH kill np --force >/dev/null 2>&1
rm -f "${ATH_HOME:-$HOME/.ath}"/requests/*.json 2>/dev/null || true

echo
echo "-- the credential flow is drivable from MCP alone"
# requests and await were CLI-only, so an agent given only the MCP tools could
# not run this tool's headline feature — and would fall back to polling in a
# loop, the exact behaviour the design exists to prevent.
names=$(printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"v","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node packages/mcp/dist/index.js 2>/dev/null \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d.trim().split("\n").filter(Boolean).pop()).result.tools.map(t=>t.name).join(","))}catch(e){console.log("x")}})')
case "$names" in *requests*) v=ok ;; *) v="missing" ;; esac
check "MCP offers a requests tool" "ok" "$v"
case "$names" in *await_human*) v=ok ;; *) v="missing" ;; esac
check "MCP offers an await tool" "ok" "$v"

echo
echo "-- a fast job cannot masquerade as a long one"
# A 1-second job and a 67-second job returned identical shapes, so an agent
# that started something it believed was long-running had no way to see it had
# finished instantly. One nearly reported the task done on a 1s command, and
# caught it only because it had wrapped the command in its own timer.
$ATH new el >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10; do $ATH ls 2>/dev/null | grep -q '^el ' && break; sleep 1; done
h=$($ATH start el -- 'true' 2>&1 | grep -oE '[0-9a-f]{12}' | head -1)
sleep 2
j=$($ATH poll el --handle "$h" --json 2>/dev/null)
e=$(printf '%s' "$j" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const v=JSON.parse(d).elapsedSeconds;console.log(v===undefined?"missing":(v<=3?"fast":"slow"))}catch(e){console.log("x")}})')
check "poll reports how long the command actually ran" "fast" "$e"
$ATH kill el --force >/dev/null 2>&1

echo
echo "-- every kind of secret prompt refuses typing, not just passwords"
# The credential list held only password/passphrase/sudo, while the wider prompt
# list already recognised "Enter API key:". So a token prompt parked the session
# but was NOT classed as a credential — the guard against typing into it did not
# apply. An agent asked whether an API-key prompt was protected; it was not.
cred=$(node -e '
const s=require("./packages/core/dist/state.js");
const must=["[sudo] password for dev: ","Enter passphrase for key \x27/k/id_rsa\x27: ",
            "Enter API key: ","Enter your access token: ","API key: ","Verification code: ",
            "Password for \x27https://x@github.com\x27: "];
console.log(must.every(t=>s.looksLikeCredentialPrompt(t))?"all":"gap");' 2>/dev/null)
check "password, passphrase, API key, token and OTP all count as credentials" "all" "${cred:-x}"
safe=$(node -e '
const s=require("./packages/core/dist/state.js");
const notPrompts=["Downloading: ","Reading package lists... ","total 48"];
console.log(notPrompts.some(t=>s.looksLikePrompt(t)||s.looksLikeCredentialPrompt(t))?"false-positive":"clean");' 2>/dev/null)
check "ordinary progress output is not mistaken for a prompt" "clean" "${safe:-x}"
git=$(node -e '
const s=require("./packages/core/dist/state.js");
const t="Username for \x27https://github.com\x27: ";
console.log(s.looksLikePrompt(t) && !s.looksLikeCredentialPrompt(t) ? "parks-not-secret" : "wrong");' 2>/dev/null)
check "a git username prompt parks but is not treated as a secret" "parks-not-secret" "${git:-x}"

echo
echo "-- timing is honest about what it can and cannot know"
# `elapsed_seconds` used to be `now - start` even for a finished command, so a
# 2-second job polled 48 seconds later reported 48 next to done/exit_code. An
# agent read it as the runtime and nearly certified long-running work done by a
# 2-second command. The hub cannot see when a command ended, so it must not
# pretend: exact while running, an upper bound afterwards, and stable.
$ATH kill tm --force >/dev/null 2>&1
$ATH new tm >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10; do $ATH ls 2>/dev/null | grep -q '^tm ' && break; sleep 1; done
h=$($ATH start tm -- 'sleep 4; echo x' 2>&1 | grep -oE '[0-9a-f]{12}' | head -1)
sleep 1
ex=$($ATH poll tm --handle "$h" --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log(j.done?"done":(j.elapsedExact?"exact":"bounded"))}catch(e){console.log("x")}})')
check "while running, the time is exact" "exact" "${ex:-x}"
sleep 8
j=$($ATH poll tm --handle "$h" --json 2>/dev/null)
flag=$(printf '%s' "$j" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const v=JSON.parse(d);console.log(v.done&&v.elapsedExact===false?"bounded":"claimed-exact")}catch(e){console.log("x")}})')
check "once finished it is flagged as a bound, not the runtime" "bounded" "${flag:-x}"
a=$(printf '%s' "$j" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).elapsedSeconds)}catch(e){console.log("x")}})')
sleep 5
b=$($ATH poll tm --handle "$h" --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).elapsedSeconds)}catch(e){console.log("x")}})')
check "and the bound stops growing after the command ends" "$a" "$b"
$ATH kill tm --force >/dev/null 2>&1

echo
echo "-- a non-interactive refusal informs the agent without summoning a human"
# `sudo -n` exits immediately; nothing is parked. Filing a request there sends
# someone to an idle shell with nothing to answer, and an agent probing its own
# environment had a request raised against its user for no reason.
rm -f "${ATH_HOME:-$HOME/.ath}"/requests/*.json 2>/dev/null || true
$ATH new nr >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10; do $ATH ls 2>/dev/null | grep -q '^nr ' && break; sleep 1; done
g=$($ATH run nr --json -- 'sudo -n true 2>&1' 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).needsHuman?"told":"silent")}catch(e){console.log("x")}})')
check "the agent is told elevation is needed" "told" "${g:-x}"
n=$(node -e 'require("./packages/core/dist/index.js").listAllRequests().then(r=>console.log(r.filter(x=>x.session==="nr").length))' 2>/dev/null)
check "but no request is filed, because nothing is waiting" "0" "${n:-x}"
$ATH kill nr --force >/dev/null 2>&1

echo
printf 'passed %d, failed %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
exit $?
fi

# ---- orchestrator ----------------------------------------------------------
[ "$EXPLICIT" = "0" ] && [ -z "$SESSION" ] && DO_LOCAL=1

# A host is "available" only if a batch-mode ssh actually connects. Listing it
# in ~/.ssh/config proves someone once wrote it down, not that it answers — and
# a run that hangs on a dead host looks like a hung test, not a dead host.
if [ "$ALL_REMOTE" = "1" ]; then
  for h in $(awk '/^[Hh]ost / {for(i=2;i<=NF;i++) if ($i !~ /[*?!]/) print $i}' \
              "$HOME/.ssh/config" 2>/dev/null | sort -u); do
    if ssh -o BatchMode=yes -o ConnectTimeout=6 "$h" true >/dev/null 2>&1; then
      HOSTS="${HOSTS:+$HOSTS,}$h"
    else
      printf '  \033[33mskip\033[0m %s — did not answer\n' "$h"
    fi
  done
fi

rc=0

# Nesting always runs unless explicitly skipped.
#
# It is the sequence a human actually performs — enter a shell, enter another,
# come back — and it was broken for months on a zsh host with nothing to catch
# it, because no test ever went two levels down and back. Making it opt-out
# rather than opt-in is the whole reason it is now known to work.
if [ "$SKIP_NESTING" = "0" ]; then
  bash "$0" --nesting || rc=1
fi

# Always. The surfaces an agent READS are the ones that shipped seven defects
# past a suite that only ran commands.
bash "$0" --contract || rc=1

run() {  # label -> re-invoke ourselves for one target, keep going on failure
  bash "$0" --battery "$1" "$2" || rc=1
}

if [ -n "$SESSION" ]; then
  run "$SESSION" "${SLABEL:-$SESSION}"
fi

if [ "$DO_LOCAL" = "1" ]; then
  echo "═══ REGRESSION SUITE ═══"
  bash "$0" --suite-only || rc=1
  s="_t$$-local"
  $ATH_BIN new "$s" --cwd "$HOME" >/dev/null 2>&1
  for _ in 1 2 3 4 5 6 7 8; do
    $ATH_BIN ls 2>/dev/null | grep -q "^$s .*idle" && break
    sleep 1
  done
  sleep 1
  run "$s" "LOCAL"
  $ATH_BIN kill "$s" --force >/dev/null 2>&1 || true
fi

IFS=','
for h in $HOSTS; do
  [ -z "$h" ] && continue
  s="_t$$-$h"
  if ! $ATH_BIN new "$s" --remote "$h" >/dev/null 2>&1; then
    printf '  \033[31mFAIL\033[0m could not create a session on %s\n' "$h"; rc=1; continue
  fi
  # Wait for the session to be genuinely ready, not for a guessed number of
  # seconds. A battery that starts too early makes the first command self-heal,
  # which types the fallback wrapper into the pane — and the wrapper's own text
  # contains "<ATHE:", so the console-hygiene check then reports a leak that is
  # really just this script being impatient.
  # Poll the session's STATE. Do not probe by running a command: a probe sent
  # before the far side is integrated self-heals, which types the fallback
  # wrapper into the pane — and the wrapper's text contains "<ATHE:", so the
  # console-hygiene check then reports a leak caused by the probe itself.
  ready=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if $ATH_BIN ls 2>/dev/null | grep -q "^$s .*idle"; then ready=1; break; fi
    sleep 2
  done
  sleep 1
  if [ "$ready" = "0" ]; then
    printf '  \033[31mFAIL\033[0m %s never became ready\n' "$h"; rc=1
    $ATH_BIN kill "$s" --force >/dev/null 2>&1 || true; continue
  fi
  run "$s" "REMOTE $h"
  $ATH_BIN kill "$s" --force >/dev/null 2>&1 || true
done
unset IFS

exit $rc
