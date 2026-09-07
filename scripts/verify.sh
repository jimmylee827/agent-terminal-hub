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
# `[!0-9a-f]` inside the hooks is a glob negation to sh, but interactive zsh
# reads `!0` as history expansion and answers "event not found: 0" — once per
# command, in a console a human is watching. `[^...]` means the same to both
# shells and triggers nothing.
hyg "no history expansion"          'event not found'
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
RP="$(cd "$(dirname "$0")/.." && pwd)"
SK="$RP/skills/agent-terminal/SKILL.md"
C="_tc$$"
echo "═══ CONTRACT ═══"
$ATH_BIN new "$C" --cwd /tmp >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8; do $ATH_BIN ls 2>/dev/null | grep -q "^$C .*idle" && break; sleep 1; done

# ---- large stdout must survive a PIPE ---------------------------------------
#
# `process.exit` discards buffered stdout, and a write to a pipe is buffered.
# `ath read big --json | jq` therefore returned exactly 65536 bytes — one pipe
# buffer — of a 3.3 MB document: valid-looking JSON, cut mid-string, exit 0.
# Redirected to a file the same command was complete, which is the worst shape
# a bug can take: correct while you check it by eye, truncated the instant
# anything consumes it.
#
# Compared against a REDIRECT rather than a fixed number, so this measures the
# discrepancy itself and not a size that will drift.
$ATH_BIN run "$C" -- 'for i in $(seq 1 4000); do echo "pipe-check-$i-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; done' >/dev/null 2>&1
$ATH_BIN read "$C" --since 0 --max-bytes 0 --json >"/tmp/athpipe$$.json" 2>/dev/null
PIPED_LEN="$($ATH_BIN read "$C" --since 0 --max-bytes 0 --json 2>/dev/null | wc -c | tr -d ' ')"
FILE_LEN="$(wc -c < "/tmp/athpipe$$.json" | tr -d ' ')"
rm -f "/tmp/athpipe$$.json"
chk "large stdout is not truncated by a pipe" "$FILE_LEN" "$PIPED_LEN"
chk "and it is well past one pipe buffer"     "yes" \
    "$([ "${FILE_LEN:-0}" -gt 65536 ] && echo yes || echo no)"

J="$($ATH_BIN run "$C" --json -- 'true' 2>/dev/null)"
for f in exit_code timed_out needs_input log_offset; do
  chk "run --json emits $f" "yes" "$(printf '%s' "$J" | grep -q "\"$f\"" && echo yes || echo no)"
done
# The exact trap: a field the docs name but NEITHER surface emits.
#
# This used to ban the snake_case spellings outright, assuming the skill file
# described the CLI only. That assumption expired: three cold agents worked
# almost entirely through MCP and one called the CLI-shaped doc "a translation
# tax on every read", so the file now carries an explicit CLI-to-MCP field
# mapping. Banning those names would ban the fix.
#
# The original intent survives — a doc must not name a field nothing emits — so
# this now verifies the mapping is TRUE rather than absent.
for f in exit_code needs_input timed_out next_offset; do
  if grep -q "$f" "$SK" 2>/dev/null; then
    chk "doc's MCP field $f really exists" "yes" \
        "$(grep -q "$f" "$RP/packages/mcp/src/index.ts" && echo yes || echo no)"
  fi
done
# `shell_exited` was on this list when the doc was CLI-only and the tool emitted
# `shellExited`; the snake_case spelling was invented then. After unification it
# is the REAL name — verified emitted on `run --json` when a shell exits — so
# banning it would ban the truth. Second check in this suite to outlive its own
# assumption after that rename; the first was "docs name no field the tool
# lacks", which banned the very spellings the fix introduced.
chk "docs name no invented field" "0" \
    "$(grep -oE '`(exit_status|is_done|exitStatus|isDone)`' "$SK" 2>/dev/null | wc -l | tr -d ' ')"

L="$($ATH_BIN ls --json 2>/dev/null)"
chk "ls --json omits pane_tail"  "no"  "$(printf '%s' "$L" | grep -q '"pane_tail"' && echo yes || echo no)"
chk "ls --json --full keeps it"  "yes" "$($ATH_BIN ls --json --full 2>/dev/null | grep -q '"pane_tail"' && echo yes || echo no)"
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
  # Every non-destructive tool must be allowed, not just the eight the list was
  # born with. It drifted from 8 tools to 16 without the allow-list following, so
  # `wait`, `purge` and `doctor` each raised an approval prompt on every call —
  # the exact friction this block exists to prevent, silently reintroduced.
  ALLOWED="$(node -pe 'try{JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude/settings.json","utf8")).permissions.allow.join(" ")}catch(e){""}' 2>/dev/null)"
  ASKED="$(node -pe 'try{JSON.parse(require("fs").readFileSync(process.env.HOME+"/.claude/settings.json","utf8")).permissions.ask.join(" ")}catch(e){""}' 2>/dev/null)"
  MISSING=""
  for t in list new run read start poll send request_human requests await_human wait width doctor unpin; do
    case " $ALLOWED " in *" mcp__agent_terminal__$t "*) ;; *) MISSING="$MISSING $t" ;; esac
  done
  chk "every non-destructive tool is pre-allowed" "" "$MISSING"
  # ...except the destructive ones, which must still ask.
  case " $ASKED " in *" mcp__agent_terminal__purge "*) PA=yes ;; *) PA=no ;; esac
  chk "purge still prompts" "yes" "$PA"
  chk "kill still prompts" "yes" \
      "$(node -e 'try{const s=require(process.env.HOME+"/.claude/settings.json");const k=(s.permissions&&s.permissions.ask)||[];process.stdout.write(k.includes("mcp__agent_terminal__kill")?"yes":"no")}catch(e){process.stdout.write("no")}' 2>/dev/null)"
fi
chk "skill mentions ath await"   "yes" "$(grep -q 'ath await' "$SK" && echo yes || echo no)"
chk "skill drops the dead idiom" "no"  "$(grep -qF "until ath requests" "$SK" && echo yes || echo no)"

# ---- disclosure: what the hub leaves behind, said where it is read ---------
#
# A cold agent rated the tool 8/10 and found no bugs, having driven it for a
# full survey — and never learned that every byte was being recorded, because
# no surface said so. These assertions exist so that silence cannot come back.
# They check the DELIVERY, not the data: an earlier warning was computed
# correctly and displayed by neither surface, and the tests passed because they
# read --json, which dumps every field whether or not a human would ever see it.

chk "new discloses the transcript" "yes" \
    "$($ATH_BIN new "${C}d" --cwd /tmp 2>&1 | grep -q 'recording to:' && echo yes || echo no)"

# kill must name BOTH the surviving file and the command that removes it.
KOUT="$($ATH_BIN kill "${C}d" --force 2>&1)"
chk "kill names the surviving transcript" "yes" \
    "$(printf '%s' "$KOUT" | grep -q 'transcript kept:' && echo yes || echo no)"
chk "kill names the purge command"        "yes" \
    "$(printf '%s' "$KOUT" | grep -q 'ath purge' && echo yes || echo no)"

# purge must not claim more than it does.
POUT="$($ATH_BIN purge "$C" 2>&1)"
chk "purge states its own limit"    "yes" \
    "$(printf '%s' "$POUT" | grep -q 'transcript only' && echo yes || echo no)"
chk "purge names requests/ as surviving" "yes" \
    "$(printf '%s' "$POUT" | grep -q 'requests/' && echo yes || echo no)"

# The enumeration must be complete. Counted, not eyeballed: the previous count
# was given as "six" from memory when the real figure was ten, twice in a row.
DOUT="$($ATH_BIN doctor --artifacts 2>&1)"
chk "doctor --artifacts lists all ten" "10" \
    "$(printf '%s' "$DOUT" | grep -cE '^  (log/|rc/|requests/|claim/|election/|lock/|ssh/|notify\.log|helper\.sh|tmux\.conf)')"

# Every directory the hub actually creates must appear in that enumeration.
# This is the check the ATH_ARTIFACTS comment promises: the list is hand-written
# beside the code that creates these paths, so nothing stops the two diverging.
for d in log rc requests claim election lock ssh; do
  chk "artifact list covers $d/" "yes" \
      "$(printf '%s' "$DOUT" | grep -q "^  $d/" && echo yes || echo no)"
done

# Retention is exercised, not read.
#
# The first draft of these two grepped the SOURCE for a suffix list and a
# symbol name — which is the same mistake as testing a warning by reading
# --json: it confirms the code says the right thing, not that running it does
# the right thing. Both run against a scratch ATH_HOME instead.
RETEN="$(ATH_HOME="$(mktemp -d)" node -e '
const a=require("'"$RP"'/packages/core/dist/index.js");
const fs=require("fs"), path=require("path"), out=[];
(async()=>{
  // reaper: every suffix the hub writes into rc/, and nothing it does not.
  fs.mkdirSync(path.dirname(a.rcPath("x")),{recursive:true});
  const old=new Date(Date.now()-24*3600*1000);
  for (const e of ["rc","t","caveat","boot","other"]) {
    const f=path.join(path.dirname(a.rcPath("x")),`aaaa1111.${e}`);
    fs.writeFileSync(f,""); fs.utimesSync(f,old,old);
  }
  out.push((await a.reapStaleRc())===4?"reap4":"reapBAD");
  out.push(fs.existsSync(path.join(path.dirname(a.rcPath("x")),"aaaa1111.other"))?"keptUnknown":"ateUnknown");
  // notify: under the cap nothing moves; over it, exactly one generation.
  fs.writeFileSync(a.NOTIFY_LOG,"x".repeat(64));
  out.push((await a.rotateNotifyLog())===false?"underNoop":"underBAD");
  fs.writeFileSync(a.NOTIFY_LOG,"y".repeat(a.NOTIFY_MAX_BYTES+10));
  out.push((await a.rotateNotifyLog())===true?"overRotates":"overBAD");
  fs.writeFileSync(a.NOTIFY_LOG,"z".repeat(a.NOTIFY_MAX_BYTES+10));
  await a.rotateNotifyLog();
  const gens=fs.readdirSync(path.dirname(a.NOTIFY_LOG)).filter(f=>f.startsWith("notify.log."));
  out.push(gens.length===1?"oneGeneration":"gensBAD:"+gens.length);
  process.stdout.write(out.join(" "));
})();
' 2>/dev/null)"
chk "reaper covers every rc suffix"      "yes" "$(printf '%s' "$RETEN" | grep -q reap4        && echo yes || echo no)"
chk "reaper leaves unknown files alone"  "yes" "$(printf '%s' "$RETEN" | grep -q keptUnknown  && echo yes || echo no)"
chk "notify.log untouched under the cap" "yes" "$(printf '%s' "$RETEN" | grep -q underNoop   && echo yes || echo no)"
chk "notify.log rotates over the cap"    "yes" "$(printf '%s' "$RETEN" | grep -q overRotates && echo yes || echo no)"
chk "notify.log keeps ONE generation"    "yes" "$(printf '%s' "$RETEN" | grep -q oneGeneration && echo yes || echo no)"

# ---- housekeeping must never destroy a human's answer ----------------------
#
# Found by a cold agent: it filed two sudo requests, the human answered them,
# and fifteen minutes later ~/.ath/requests was EMPTY — no record it had ever
# asked. `clearRequest` wrote with a plain truncate-then-write and answered a
# parse failure by unlinking, while `pruneRequests` runs on every watcher tick
# in every open editor window and `reapResolvedRequests` from four more call
# sites. Two routine passes racing were enough to delete the record between
# them. "Silence is the one answer that means nothing" is the whole point of
# keeping resolved requests, so this is exercised, not read.
REQ="$(ATH_HOME="$(mktemp -d)" node -e '
const a=require("'"$RP"'/packages/core/dist/index.js");
const fs=require("fs"), path=require("path"), out=[];
const home=process.env.ATH_HOME;
(async()=>{
  const r=await a.requestHuman("t","need password","agent","c5206908f3d2",true);
  const file=path.join(home,"requests",`${r.id}.json`);
  // Twenty housekeeping passes at once, as several editor windows would.
  await Promise.all(Array.from({length:20},()=>a.clearRequest(r.id)));
  out.push(fs.existsSync(file)?"survivesConcurrent":"DESTROYED");
  try { JSON.parse(fs.readFileSync(file,"utf8")); out.push("staysParseable"); }
  catch { out.push("CORRUPT"); }
  out.push((await a.listAllRequests()).some(x=>x.id===r.id)?"stillReadable":"VANISHED");
  // A read that fails is not permission to delete. Deterministic where the
  // race above is not: the old catch-all unlinked on any parse error.
  const junk=path.join(home,"requests","dead0000.json");
  fs.writeFileSync(junk,"{ truncated");
  await a.clearRequest("dead0000");
  out.push(fs.existsSync(junk)?"keepsUnparseable":"ATEUNPARSEABLE");
  // The temp files the atomic write introduces must not leak. Backdated,
  // because a temp file belonging to a write happening RIGHT NOW must survive
  // — the reaper floors its cutoff at a minute for exactly that reason.
  const tmp=path.join(home,"requests","x.json.abcd.tmp");
  fs.writeFileSync(tmp,"x");
  const old=new Date(Date.now()-24*3600*1000);
  fs.utimesSync(tmp,old,old);
  await a.pruneRequests(new Set(["t"]),0);
  out.push(fs.readdirSync(path.join(home,"requests")).filter(f=>f.endsWith(".tmp")).length===0
    ?"reapsTemps":"TEMPLEAK");
  // `--clear` is the ONE route off the disk for a file the reader cannot
  // parse, now that a failed read no longer deletes. It sweeps the directory
  // rather than the parsed list, so the junk above must go with the rest.
  // A resolved record is kept for the TTL and then actually goes. The delete
  // inside clearRequest was unreachable — every caller iterated OPEN requests
  // only — so resolved ones accumulated forever behind a docs claim that they
  // expire. Both halves are asserted: fresh survives, stale goes.
  const r2=await a.requestHuman("t","another ask","agent","dd44dd44dd44",true);
  const f2=path.join(home,"requests",`${r2.id}.json`);
  await a.clearRequest(r2.id);
  await a.pruneRequests(new Set(["t"]));
  out.push(fs.existsSync(f2)?"freshResolvedKept":"ATEFRESH");
  const rec=JSON.parse(fs.readFileSync(f2,"utf8"));
  rec.resolvedAt=Date.now()-2*60*60*1000;            // older than the 1h TTL
  fs.writeFileSync(f2,JSON.stringify(rec));
  await a.pruneRequests(new Set(["t"]));
  out.push(!fs.existsSync(f2)?"staleResolvedExpires":"LEAKSFOREVER");
  const swept=await a.clearAllRequests();
  const rest=fs.readdirSync(path.join(home,"requests"))
    .filter(f=>f.endsWith(".json")||f.endsWith(".tmp"));
  out.push(swept>=2&&rest.length===0?"clearReachesJunk":"CLEARMISSED:"+swept+"/"+rest.length);
  process.stdout.write(out.join(" "));
})();
' 2>/dev/null)"
chk "concurrent clears keep the record"   "yes" "$(printf '%s' "$REQ" | grep -q survivesConcurrent && echo yes || echo no)"
chk "concurrent clears keep it parseable" "yes" "$(printf '%s' "$REQ" | grep -q staysParseable     && echo yes || echo no)"
chk "a resolved request stays readable"   "yes" "$(printf '%s' "$REQ" | grep -q stillReadable      && echo yes || echo no)"
chk "a failed read does NOT delete"       "yes" "$(printf '%s' "$REQ" | grep -q keepsUnparseable   && echo yes || echo no)"
chk "atomic-write temp files are reaped"  "yes" "$(printf '%s' "$REQ" | grep -q reapsTemps         && echo yes || echo no)"
chk "--clear reaches an unparseable file" "yes" "$(printf '%s' "$REQ" | grep -q clearReachesJunk     && echo yes || echo no)"
chk "a just-answered request is kept"     "yes" "$(printf '%s' "$REQ" | grep -q freshResolvedKept    && echo yes || echo no)"
chk "a resolved request finally expires"  "yes" "$(printf '%s' "$REQ" | grep -q staleResolvedExpires && echo yes || echo no)"

# ---- ~/.ath is private, and stays private ----------------------------------
#
# `requests/` was 0755 on a stock macOS umask because the editor extension
# created it with a bare mkdir and won the race against core's 0700 one —
# `mkdir` applies its mode only when it CREATES. Same umask left notify.log,
# which is CONTENT rather than metadata, at 0644. The repair matters as much
# as the fix: mkdir on an existing directory does nothing, so without a chmod
# every install already out there stays loose forever.
PERM="$(ATH_HOME="$(mktemp -d)" node -e '
const a=require("'"$RP"'/packages/core/dist/index.js");
const fs=require("fs"), out=[];
const mode=f=>fs.statSync(f).mode & 0o777;
(async()=>{
  await a.ensureLayout();
  const dirs=a.ATH_ARTIFACTS.filter(x=>x.name.endsWith("/"));
  const bad=dirs.filter(x=>mode(x.absolute)!==0o700).map(x=>x.name);
  out.push(bad.length===0?"allDirs700":"LOOSE:"+bad.join(","));
  out.push(dirs.length>=7?"coversAll":"MISSINGDIRS:"+dirs.length);
  fs.chmodSync(dirs[0].absolute,0o755);
  await a.ensureLayout();
  out.push(mode(dirs[0].absolute)===0o700?"repairsDir":"NOREPAIR");
  fs.writeFileSync(a.NOTIFY_LOG,"x"); fs.chmodSync(a.NOTIFY_LOG,0o644);
  await a.ensureLayout();
  out.push(mode(a.NOTIFY_LOG)===0o600?"repairsNotify":"NOTIFYLOOSE");
  process.stdout.write(out.join(" "));
})();
' 2>/dev/null)"
chk "every artifact dir is 0700"       "yes" "$(printf '%s' "$PERM" | grep -q allDirs700    && echo yes || echo no)"
chk "layout covers every artifact dir" "yes" "$(printf '%s' "$PERM" | grep -q coversAll     && echo yes || echo no)"
chk "a loosened dir is repaired"       "yes" "$(printf '%s' "$PERM" | grep -q repairsDir    && echo yes || echo no)"
chk "a loosened notify.log is repaired" "yes" "$(printf '%s' "$PERM" | grep -q repairsNotify && echo yes || echo no)"

# ---- the follow loop must be startable from a standing start ---------------
#
# The documented way to follow a session is to pass `next_offset` back as
# `since`. Only the `since` shape returned one, so an agent holding no offset
# could not obtain its first — it had to invent a number or read the whole log
# to find the end, which is the cost the offset exists to avoid. A cold agent
# hit exactly this: "the documented round-trip can't be bootstrapped from
# --tail". Asserted as a ROUND TRIP, because that is the claim: the offset a
# tail read hands you must be usable as `since`.
OFFS="$(ATH_HOME="$(mktemp -d)" node -e '
const a=require("'"$RP"'/packages/core/dist/index.js");
const fs=require("fs"), path=require("path"), out=[];
const home=process.env.ATH_HOME;
fs.mkdirSync(path.join(home,"log"),{recursive:true});
const log=path.join(home,"log","f.log");
(async()=>{
  fs.writeFileSync(log,"alpha\nbravo\ncharlie\n");
  const t=await a.readTail("f",2);
  out.push(typeof t.nextOffset==="number"?"tailHasOffset":"NOOFFSET");
  out.push(t.nextOffset===fs.statSync(log).size?"offsetIsEnd":"OFFSETWRONG");
  out.push(t.output.includes("charlie")?"tailHasOutput":"NOOUTPUT");
  // Round trip: resuming from it returns nothing, because nothing is new.
  const s1=await a.readSince("f",t.nextOffset);
  out.push(s1.output.trim()===""?"resumeIsEmpty":"RESUMEDUP:"+JSON.stringify(s1.output));
  // And picks up exactly what lands afterwards.
  fs.appendFileSync(log,"delta\n");
  const s2=await a.readSince("f",t.nextOffset);
  out.push(s2.output.includes("delta")&&!s2.output.includes("alpha")
    ?"resumeGetsNew":"RESUMEWRONG");
  // The offset must never point PAST what was returned, or a command still
  // printing loses whatever landed between the size read and the tail read.
  out.push(t.nextOffset<=fs.statSync(log).size?"neverPastEnd":"OVERSHOT");
  process.stdout.write(out.join(" "));
})();
' 2>/dev/null)"
chk "a tail read returns an offset"      "yes" "$(printf '%s' "$OFFS" | grep -q tailHasOffset && echo yes || echo no)"
chk "that offset is the log end"         "yes" "$(printf '%s' "$OFFS" | grep -q offsetIsEnd   && echo yes || echo no)"
chk "a tail read still returns output"   "yes" "$(printf '%s' "$OFFS" | grep -q tailHasOutput && echo yes || echo no)"
chk "resuming from it repeats nothing"   "yes" "$(printf '%s' "$OFFS" | grep -q resumeIsEmpty && echo yes || echo no)"
chk "resuming from it gets what is new"  "yes" "$(printf '%s' "$OFFS" | grep -q resumeGetsNew && echo yes || echo no)"
chk "the offset never points past output" "yes" "$(printf '%s' "$OFFS" | grep -q neverPastEnd && echo yes || echo no)"

# ---- the generated ssh config must not discard the system's -------------------
#
# `ssh -F` makes ssh IGNORE /etc/ssh/ssh_config entirely, and the generated file
# replaced it with only our own options. On macOS that file carries
# `SendEnv LANG LC_*`, which is the ONLY way a Mac gets a locale over ssh — it
# has no /etc/default/locale the way Linux does. Without it the remote shell ran
# as US-ASCII, the hooks' multi-byte tag name was mangled, the hooks never
# installed, and EVERY command fell back to the wrapper. Not cosmetic:
# `verify.sh --remote <a mac>` failed 44 checks on it, and passed 70 after.
#
# Invisible against Linux remotes, which supply their own locale — which is why
# it survived so long. Asserted here with `ssh -G`, which resolves precedence
# without connecting to anything.
SSHCFG="$(ATH_HOME="$(mktemp -d)" node -e '
const a=require("'"$RP"'/packages/core/dist/index.js");
const fs=require("fs"), os=require("os"), path=require("path"), out=[];
// `sshLaunchLine` is the path that uses `-F` and therefore suppresses the
// system config; it writes the file as a side effect. `sshCommandLine` passes
// `-o` flags instead and never suppresses anything, so it is not the risk.
a.sshLaunchLine("examplehost","payload","/tmp/none.boot");
const cfg=path.join(process.env.ATH_HOME,"ssh","config");
const text=fs.readFileSync(cfg,"utf8");
out.push(/Include \/etc\/ssh\/ssh_config/.test(text)?"includesSystem":"NOSYSTEM");
// It must come LAST: ssh takes the first value it obtains, so anywhere earlier
// and the system would start overriding our own defaults.
const iSys=text.indexOf("Include /etc/ssh/ssh_config");
const iHost=text.indexOf("Host *");
out.push(iSys>iHost?"systemIsLast":"SYSTEMTOOEARLY");
process.stdout.write(out.join(" "));
' 2>/dev/null)"
chk "generated ssh config includes the system's" "yes" \
    "$(printf '%s' "$SSHCFG" | grep -q includesSystem && echo yes || echo no)"
chk "and it comes LAST, so ours still win"       "yes" \
    "$(printf '%s' "$SSHCFG" | grep -q systemIsLast  && echo yes || echo no)"
# Precedence proven against ssh itself, not just by reading the file.
if command -v ssh >/dev/null 2>&1; then
  TCFG="$(mktemp)"; TSYS="$(mktemp)"
  printf 'Host *\n  ConnectTimeout 999\n' > "$TSYS"
  printf 'Host *\n  ConnectTimeout 7\n\nInclude %s\n' "$TSYS" > "$TCFG"
  chk "ours beat an included system value" "7" \
      "$(ssh -G -F "$TCFG" examplehost 2>/dev/null | awk '/^connecttimeout /{print $2}')"
  rm -f "$TCFG" "$TSYS"
fi

# ---- no surface may promise a sudo timeout it cannot know --------------------
#
# Five places said the timestamp lasts "~15 min". `man sudoers` says the
# default is FIVE, and it is a per-machine setting that can be anything,
# including 0 for "always prompt". A cold agent planned its whole session
# layout around the 15, confirmed elevation with `sudo -n true`, and had the
# very next privileged command prompt again — a second interruption for its
# human, bought with a number this tool invented.
#
# The hub cannot read sudoers, so it cannot know the answer; a guess stated as
# a fact is worse than saying nothing. Checked as a CONTRACT because the number
# is the kind of friendly detail that gets helpfully added back.
# The VALUE is not what is checked, because the value was never the problem.
# Two of the machines this was developed against are set to 5 and 15, both
# stock — so a correct-looking figure is just a guess that happens to hold on
# one of them. What is banned is a duration stated in a form an agent can
# budget against, whatever the number.
SUDO_CLAIM=0
for f in "$RP"/packages/cli/src/index.ts "$RP"/packages/mcp/src/index.ts \
         "$RP"/packages/mcp/src/tools.ts "$SK"; do
  # Any "N minutes" within a sentence about the timestamp being cached or warm.
  # Lines that RECOUNT the old mistake, or say the value varies, are the point
  # and are allowed to name figures.
  if grep -nE "(cached|warm|lasts|good)[^.]{0,60}[0-9]+ ?(min|minute)" "$f" 2>/dev/null \
       | grep -viE "used to|this said|were developed|developed against|differs|varies|cannot know|never the point" \
       | grep -q .; then
    SUDO_CLAIM=1
    echo "  states a budgetable sudo duration: $f"
  fi
done
chk "no surface promises a sudo timeout" "0" "$SUDO_CLAIM"
# And the honest guidance is actually present where an agent reads it.
chk "the skill says to re-check, not to count" "yes" \
    "$(grep -qi 'infer elevation from elapsed time' "$SK" && echo yes || echo no)"
chk "the skill names timestamp_timeout"        "yes" \
    "$(grep -q 'timestamp_timeout' "$SK" && echo yes || echo no)"

# ---- a start that did not start must not look like one ----------------------
#
# `start` could not fail. It sent the wrapper and returned a handle
# unconditionally, so a shell without the hub's helper answered
# "__ath: command not found" while the caller got a handle, an offset and a
# cheerful note about polling — indistinguishable from success. The handle then
# belonged to a command that had never run and could never finish. A cold agent
# lost a job to this and had to invent its own `type __ath` pre-check, while the
# docs promised a `fallback_shell` signal only `run` has ever set.
#
# Driven through a REAL unhooked shell, not a stub: `exec env -i bash --norc`
# leaves a pane with neither the framing hooks nor the wrapper, which is exactly
# what a reconnected remote looks like.
LAUNCH="$(ATH_HOME="$(mktemp -d)" ATH_SOCKET="athl$$" node -e '
const a=require("'"$RP"'/packages/core/dist/index.js");
const out=[];
(async()=>{
  await a.create({name:"lp",cwd:"/tmp"});
  for(let i=0;i<12;i++){const s=await a.get("lp").catch(()=>null);if(s&&s.state==="idle")break;await new Promise(r=>setTimeout(r,700));}
  // A healthy shell must NOT be flagged, or the signal is worthless.
  const good=await a.start("lp","sleep 1");
  out.push(good.launched===undefined?"healthyNotFlagged":"FALSEALARM");
  await new Promise(r=>setTimeout(r,2500));
  // Now a shell with neither hooks nor wrapper.
  await a.sendLine("lp","exec env -i PATH=/usr/bin:/bin bash --norc --noprofile");
  await new Promise(r=>setTimeout(r,2500));
  const bad=await a.start("lp","sleep 1");
  out.push(bad.launched===false?"unlaunchedFlagged":"SILENTSUCCESS");
  out.push(typeof bad.handle==="string"&&bad.handle.length===12?"handleStillGiven":"NOHANDLE");
  await a.kill("lp").catch(()=>{});
  process.stdout.write(out.join(" "));
})();
' 2>/dev/null)"
chk "a healthy start is not flagged"     "yes" "$(printf '%s' "$LAUNCH" | grep -q healthyNotFlagged && echo yes || echo no)"
chk "a start that did NOT start is"      "yes" "$(printf '%s' "$LAUNCH" | grep -q unlaunchedFlagged && echo yes || echo no)"
chk "and the handle is still returned"   "yes" "$(printf '%s' "$LAUNCH" | grep -q handleStillGiven  && echo yes || echo no)"

# ---- a half-eaten marker must not reach the caller ---------------------------
#
# A `since` is an arbitrary byte position and can land inside a marker. The
# opening `<ATHE:` stays behind and the tail arrives at the head of the slice,
# matching no marker pattern — so every filter passes it through as output. An
# agent saw `275d2:0:L3RtcC9qbWF4aS1hdWRpdA==:0>` in its results and had to
# decode the base64 to satisfy itself it was not part of its own job.
FRAG="$(ATH_HOME="$(mktemp -d)" node -e '
const a=require("'"$RP"'/packages/core/dist/index.js");
const fs=require("fs"), path=require("path"), out=[];
const home=process.env.ATH_HOME, S="\x1e";
fs.mkdirSync(path.join(home,"log"),{recursive:true});
const log=path.join(home,"log","m.log");
fs.writeFileSync(log,"before\n"+S+"<ATHE:275d2abc0000:0:L3RtcC9hdWRpdA==:0>"+S+"\nreal output line\n");
(async()=>{
  const inside=Buffer.from("before\n"+S+"<ATHE:2").length;
  const r=await a.readSince("m",inside,0);
  out.push(/:0>|L3RtcC9hdWRpdA==/.test(r.output)?"FRAGMENTLEAKED":"noFragment");
  out.push(r.output.includes("real output line")?"keptRealOutput":"ATEREALOUTPUT");
  // An offset on a clean boundary must be untouched.
  const whole=await a.readSince("m",0,0);
  out.push(whole.output.includes("before")?"keepsHead":"ATEHEAD");
  process.stdout.write(out.join(" "));
})();
' 2>/dev/null)"
chk "a split marker does not leak"        "yes" "$(printf '%s' "$FRAG" | grep -q noFragment     && echo yes || echo no)"
chk "and real output survives the fix"    "yes" "$(printf '%s' "$FRAG" | grep -q keptRealOutput && echo yes || echo no)"
chk "a clean offset is left alone"        "yes" "$(printf '%s' "$FRAG" | grep -q keepsHead      && echo yes || echo no)"

# The advertised bound must be one the tool actually enforces. `doctor` said
# "rotated at 1 MiB" beside a 2.3 MB file with no rotated generation — the one
# command the skill tells an agent to trust, wrong about its own housekeeping.
BOUND="$(ATH_HOME="$(mktemp -d)" node -e '
const a=require("'"$RP"'/packages/core/dist/index.js");
const fs=require("fs"), out=[];
(async()=>{
  await a.ensureLayout();
  fs.writeFileSync(a.NOTIFY_LOG,"x".repeat(a.NOTIFY_MAX_BYTES+5000));
  await a.ensureLayout();                     // any ath entry point
  // Rotation RENAMES the file, so "gone" is the correct post-rotation state —
  // the next append recreates it. Either absent or under the cap counts.
  const live=fs.existsSync(a.NOTIFY_LOG)?fs.statSync(a.NOTIFY_LOG).size:0;
  out.push(live<=a.NOTIFY_MAX_BYTES?"boundEnforced":"OVERCAP:"+live);
  out.push(fs.existsSync(a.NOTIFY_LOG+".1")?"generationKept":"NOGENERATION");
  process.stdout.write(out.join(" "));
})();
' 2>/dev/null)"
chk "the notify.log bound is enforced"    "yes" "$(printf '%s' "$BOUND" | grep -q boundEnforced  && echo yes || echo no)"
chk "and one generation is kept"          "yes" "$(printf '%s' "$BOUND" | grep -q generationKept && echo yes || echo no)"

# ---- `wait` must answer with the command's OWN result ------------------------
#
# It answered "is it done?" and then handed back the SESSION's last exit code —
# a different question. That value is written when something polls, so for a
# command nobody polled it is stale or absent. A cold agent waited on a
# 188-second job, got `verified: true` and nothing usable, and had to spend a
# second call on `poll` to learn the outcome of the thing it had just been told
# was finished.
#
# The end marker carries the code AND the shell's own duration. Asked by handle,
# both come back in the call that reports completion.
WOUT="$(ATH_HOME="$(mktemp -d)" ATH_SOCKET="athw$$" node -e '
const a=require("'"$RP"'/packages/core/dist/index.js");
const out=[];
(async()=>{
  await a.create({name:"wq",cwd:"/tmp"});
  for(let i=0;i<12;i++){const s=await a.get("wq").catch(()=>null);if(s&&s.state==="idle")break;await new Promise(r=>setTimeout(r,700));}
  // A subshell exit: non-zero WITHOUT killing the session shell, which would
  // take the paneDead path and prove nothing about the marker.
  const st=await a.start("wq","sleep 2; (exit 7)");
  await new Promise(r=>setTimeout(r,5000));
  const o=await a.commandOutcome("wq",st.handle);
  out.push(o.finished===true?"finished":"NOTFINISHED");
  out.push(o.exitCode===7?"ownExitCode":"WRONGCODE:"+o.exitCode);
  out.push(typeof o.seconds==="number"?"hasDuration":"NODURATION");
  // An unknown handle must not invent an answer.
  const u=await a.commandOutcome("wq","ffffffffffff");
  out.push(u.finished===false&&u.exitCode===undefined?"unknownIsHonest":"UNKNOWNBAD");
  await a.kill("wq").catch(()=>{});
  process.stdout.write(out.join(" "));
})();
' 2>/dev/null)"
chk "wait knows the command finished"      "yes" "$(printf '%s' "$WOUT" | grep -q finished       && echo yes || echo no)"
chk "and reports ITS exit code, not the session's" "yes" "$(printf '%s' "$WOUT" | grep -q ownExitCode  && echo yes || echo no)"
chk "and its duration, in the same call"   "yes" "$(printf '%s' "$WOUT" | grep -q hasDuration    && echo yes || echo no)"
chk "an unknown handle invents nothing"    "yes" "$(printf '%s' "$WOUT" | grep -q unknownIsHonest && echo yes || echo no)"

# ---- a dead remote command must stop reporting itself as running ------------
#
# `poll`'s only liveness check was `paneDead`, and a dropped ssh link does not
# kill the pane — it falls back to the LOCAL shell, which is very much alive.
# So no end marker ever arrived, nothing looked dead, and `done: false` came
# back forever with `running_for_seconds` climbing. An agent watched that
# report a corpse as running for 516 seconds, eight minutes after the job died,
# and correctly called the field unfalsifiable.
#
# Driven WITHOUT a real remote host: the condition is "session says remote, and
# the pane is no longer in a nested shell", so a local session tagged remote
# reproduces it exactly. Both directions are asserted — a local session with
# the same dangling marker must NOT be flagged, or every long job would be
# declared dead.
DROP="$(ATH_HOME="$(mktemp -d)" ATH_SOCKET="athd$$" node -e '
const a=require("'"$RP"'/packages/core/dist/index.js");
const fs=require("fs"), path=require("path"), out=[];
const S="\x1e";
(async()=>{
  await a.create({name:"rem",cwd:"/tmp"});
  await a.create({name:"loc",cwd:"/tmp"});
  for(let i=0;i<12;i++){const s=await a.get("rem").catch(()=>null);if(s&&s.state==="idle")break;await new Promise(r=>setTimeout(r,700));}
  // A command that started and never wrote an end marker: the exact residue a
  // dropped link leaves behind.
  for (const n of ["rem","loc"]) fs.appendFileSync(a.logPath(n),`${S}<ATHS:ccccccccccc1>${S}\nworking\n`);
  const before=await a.poll("rem","ccccccccccc1",0);
  out.push(before.done===false?"liveNotFlagged":"FALSEDEAD");
  // Now it is a remote session whose pane sits in a plain local shell.
  await a.setMeta("rem","remote","fakehost");
  const after=await a.poll("rem","ccccccccccc1",0);
  out.push(after.done===true?"dropIsDone":"STILLRUNNING");
  out.push(after.remoteDisconnected===true?"dropIsFlagged":"NOFLAG");
  out.push(after.exitCode===null?"outcomeUnknown":"FAKEEXITCODE:"+after.exitCode);
  // A LOCAL session with the identical dangling marker must be untouched.
  const local=await a.poll("loc","ccccccccccc1",0);
  out.push(local.done===false&&local.remoteDisconnected===undefined
    ?"localUnaffected":"LOCALBROKEN");
  await a.kill("rem").catch(()=>{}); await a.kill("loc").catch(()=>{});
  process.stdout.write(out.join(" "));
})();
' 2>/dev/null)"
chk "a live command is not called dead"    "yes" "$(printf '%s' "$DROP" | grep -q liveNotFlagged  && echo yes || echo no)"
chk "a dropped remote stops counting up"   "yes" "$(printf '%s' "$DROP" | grep -q dropIsDone      && echo yes || echo no)"
chk "and the drop is named, not implied"   "yes" "$(printf '%s' "$DROP" | grep -q dropIsFlagged   && echo yes || echo no)"
chk "its outcome is admitted as unknown"   "yes" "$(printf '%s' "$DROP" | grep -q outcomeUnknown  && echo yes || echo no)"
chk "a local session is unaffected"        "yes" "$(printf '%s' "$DROP" | grep -q localUnaffected && echo yes || echo no)"

# ---- a trimmed log must not silently swallow an offset ----------------------
#
# The log is rewritten to its last 8 MB once it passes 32 MB, which invalidates
# every offset issued before it — and did so in two silent ways. An offset PAST
# the new end read nothing, which is indistinguishable from "no new output"; an
# offset BEFORE it read real bytes belonging to some other part of the session.
#
# A cold agent following a 46 MB job hit the first. It polled at the exact
# offset the hub had told it to use, got empty output and a `next_offset`
# SMALLER than the `since` it passed, and no warning — while the skill file
# promised in as many words that nothing would be lost. ~38 MB of its results
# were gone. Silent loss under an affirmative promise of no loss.
#
# Offsets are LOGICAL now — bytes since the session began — so they survive a
# trim instead of breaking on one, and what genuinely cannot be returned is
# named. Both halves are asserted.
TRIM="$(ATH_HOME="$(mktemp -d)" node -e '
const a=require("'"$RP"'/packages/core/dist/index.js");
const fs=require("fs"), path=require("path"), out=[];
const home=process.env.ATH_HOME;
fs.mkdirSync(path.join(home,"log"),{recursive:true});
const log=path.join(home,"log","t.log");
const line=(i)=>`entry-${String(i).padStart(7,"0")}-`+"y".repeat(40);
(async()=>{
  const rows=[]; for(let i=0;i<12000;i++) rows.push(line(i));
  fs.writeFileSync(log,rows.join("\n")+"\n");
  const beforeSize=fs.statSync(log).size;
  // An offset handed out BEFORE the trim, exactly as `start` would.
  const mid=await a.readSince("t",0,0);
  out.push(mid.nextOffset===beforeSize?"offsetIsLogical":"OFFSETWRONG");
  // Trim to a fraction, as rotateIfNeeded does past the cap.
  const r=await a.rotateIfNeeded("t", 40*1024);
  out.push(r.rotated?"trimmed":"NOTRIM");
  const discarded=await a.discardedBytes("t");
  out.push(discarded>0?"watermarkRecorded":"NOWATERMARK");
  // THE bug: resume from the offset the hub itself issued.
  const after=await a.readSince("t",mid.nextOffset,0);
  out.push(after.nextOffset>=mid.nextOffset?"offsetsStayMonotonic":"WENTBACKWARDS");
  out.push(after.lostBytes===undefined&&!after.offsetBeyondEnd?"noFalseAlarm":"FALSEALARM");
  // New output after the trim is still reachable from that same offset.
  fs.appendFileSync(log,line(999999)+"\n");
  const tailRead=await a.readSince("t",mid.nextOffset,0);
  out.push(tailRead.output.includes("entry-0999999")?"newOutputReachable":"NEWOUTPUTLOST");
  // An offset whose bytes really were discarded must SAY so, not return empty.
  const old=await a.readSince("t",0,0);
  out.push(old.lostBytes>0?"lossIsReported":"LOSSSILENT");
  out.push(old.output.length>0?"stillReturnsWhatSurvives":"RETURNSNOTHING");
  // And an offset past the end is named rather than answered with silence.
  const future=await a.readSince("t",old.nextOffset+50000,0);
  out.push(future.offsetBeyondEnd===true?"beyondEndFlagged":"BEYONDSILENT");
  process.stdout.write(out.join(" "));
})();
' 2>/dev/null)"
chk "an issued offset is logical"          "yes" "$(printf '%s' "$TRIM" | grep -q offsetIsLogical          && echo yes || echo no)"
chk "a trim records its watermark"         "yes" "$(printf '%s' "$TRIM" | grep -q watermarkRecorded        && echo yes || echo no)"
chk "offsets never go backwards"           "yes" "$(printf '%s' "$TRIM" | grep -q offsetsStayMonotonic     && echo yes || echo no)"
chk "a surviving offset raises no alarm"   "yes" "$(printf '%s' "$TRIM" | grep -q noFalseAlarm             && echo yes || echo no)"
chk "output after a trim is still reachable" "yes" "$(printf '%s' "$TRIM" | grep -q newOutputReachable     && echo yes || echo no)"
chk "trimmed-away bytes are REPORTED"      "yes" "$(printf '%s' "$TRIM" | grep -q lossIsReported           && echo yes || echo no)"
chk "and what survives is still returned"  "yes" "$(printf '%s' "$TRIM" | grep -q stillReturnsWhatSurvives && echo yes || echo no)"
chk "an offset past the end is named"      "yes" "$(printf '%s' "$TRIM" | grep -q beyondEndFlagged         && echo yes || echo no)"

# Every offset the hub hands out must be in the SAME units.
#
# `run` reported `log_offset` as a physical file position while `read` and
# `poll` returned logical ones. Identical until the first trim, then silently
# divergent — and the docs invite exactly the mix, listing `next_offset` and
# `log_offset` side by side as things you pass back. Asserted across all three
# producers on one trimmed session, because the bug is only visible after a
# trim and only when they are compared.
UNITS="$(ATH_HOME="$(mktemp -d)" ATH_SOCKET="athu$$" node -e '
const a=require("'"$RP"'/packages/core/dist/index.js");
const fs=require("fs"), out=[];
(async()=>{
  await a.create({name:"un",cwd:"/tmp"});
  for(let i=0;i<12;i++){const s=await a.get("un").catch(()=>null);if(s&&s.state==="idle")break;await new Promise(r=>setTimeout(r,700));}
  await a.run("un","printf \"pad-%s\\n\" $(seq 1 400)",{timeoutMs:20000});
  await a.rotateIfNeeded("un", 2048);            // force a trim
  const discarded=await a.discardedBytes("un");
  out.push(discarded>0?"trimHappened":"NOTRIM");
  const physical=fs.statSync(a.logPath("un")).size;
  const r=await a.run("un","echo units",{timeoutMs:20000});
  const t=await a.readTail("un",1);
  const s=await a.start("un","true");
  // Every one of them must exceed the physical file size, which is only true
  // if each added the discard watermark.
  out.push(r.logOffset>physical?"runIsLogical":"RUNPHYSICAL");
  out.push(t.nextOffset>physical?"readIsLogical":"READPHYSICAL");
  out.push(s.offset>physical?"startIsLogical":"STARTPHYSICAL");
  await a.kill("un").catch(()=>{});
  process.stdout.write(out.join(" "));
})();
' 2>/dev/null)"
chk "the units test really trimmed"        "yes" "$(printf '%s' "$UNITS" | grep -q trimHappened   && echo yes || echo no)"
chk "run's log_offset is logical"          "yes" "$(printf '%s' "$UNITS" | grep -q runIsLogical   && echo yes || echo no)"
chk "read's next_offset is logical"        "yes" "$(printf '%s' "$UNITS" | grep -q readIsLogical  && echo yes || echo no)"
chk "start's offset is logical"            "yes" "$(printf '%s' "$UNITS" | grep -q startIsLogical && echo yes || echo no)"

# ---- a capped read must PAGINATE, never truncate ---------------------------
#
# An agent following a build that printed 2.6 MB got all 2.6 MB in one poll:
# MAX_SLICE_BYTES is 16 MB and guards MEMORY, not context, and nothing else
# guarded context. The damage lands before the caller can see the size, so a
# warning on the result cannot fix it and a smaller default can.
#
# The whole bet is that the omitted middle is RECOVERABLE. If the resume offset
# does not actually return the omitted bytes, this is not pagination, it is
# silent data loss with a reassuring note attached — so that is what is
# asserted, byte for byte.
CAPPED="$(ATH_HOME="$(mktemp -d)" node -e '
const a=require("'"$RP"'/packages/core/dist/index.js");
const fs=require("fs"), path=require("path"), out=[];
const home=process.env.ATH_HOME;
fs.mkdirSync(path.join(home,"log"),{recursive:true});
const log=path.join(home,"log","c.log");
// 400 KB of numbered lines, well past the 64 KB default.
const lines=[]; for(let i=0;i<20000;i++) lines.push(`line-${String(i).padStart(6,"0")}-xxxxxxxxxxxxxxx`);
fs.writeFileSync(log,lines.join("\n")+"\n");
const total=fs.statSync(log).size;
(async()=>{
  const r=await a.readSince("c",0);
  out.push(r.output.length < total/2 ? "isCapped" : "UNCAPPED");
  out.push(typeof r.omittedBytes==="number" ? "reportsOmission" : "SILENT");
  out.push(r.output.includes("line-000000") ? "keepsHead" : "NOHEAD");
  out.push(r.output.includes(`line-${String(19999).padStart(6,"0")}`) ? "keepsTail" : "NOTAIL");
  out.push(r.nextOffset===total ? "endOffsetIntact" : "ENDWRONG");
  // The marker names the same offset the field does — a caller reading either
  // must land in the same place.
  const m=/since=(\d+)/.exec(r.output);
  out.push(m && Number(m[1])===r.omittedResumeFrom ? "markerAgrees" : "MARKERDISAGREES");
  // THE claim: resuming from it returns the bytes that were left out.
  const gap=await a.readSince("c",r.omittedResumeFrom,0);   // 0 = uncapped
  const missing=[];
  for(let i=0;i<20000;i++){
    const tag=`line-${String(i).padStart(6,"0")}`;
    if(!r.output.includes(tag) && !gap.output.includes(tag)) missing.push(tag);
  }
  out.push(missing.length===0 ? "gapIsRecoverable" : "LOST:"+missing.length);
  // Opting out returns everything in one call.
  const all=await a.readSince("c",0,0);
  out.push(all.omittedBytes===undefined && all.output.includes("line-010000")
    ? "optOutWorks" : "OPTOUTBAD");
  // Under the cap, nothing is added and nothing is claimed.
  fs.writeFileSync(path.join(home,"log","s.log"),"tiny\n");
  const small=await a.readSince("s",0);
  out.push(small.omittedBytes===undefined && !small.output.includes("omitted")
    ? "smallUntouched" : "SMALLTOUCHED");
  process.stdout.write(out.join(" "));
})();
' 2>/dev/null)"
chk "a large slice is capped"             "yes" "$(printf '%s' "$CAPPED" | grep -q isCapped         && echo yes || echo no)"
chk "the omission is reported as a field" "yes" "$(printf '%s' "$CAPPED" | grep -q reportsOmission  && echo yes || echo no)"
chk "the head is kept"                    "yes" "$(printf '%s' "$CAPPED" | grep -q keepsHead        && echo yes || echo no)"
chk "the tail is kept"                    "yes" "$(printf '%s' "$CAPPED" | grep -q keepsTail        && echo yes || echo no)"
chk "next_offset still points at the end" "yes" "$(printf '%s' "$CAPPED" | grep -q endOffsetIntact  && echo yes || echo no)"
chk "the marker and the field agree"      "yes" "$(printf '%s' "$CAPPED" | grep -q markerAgrees     && echo yes || echo no)"
chk "the omitted middle is recoverable"   "yes" "$(printf '%s' "$CAPPED" | grep -q gapIsRecoverable && echo yes || echo no)"
chk "max_bytes 0 opts out of the cap"     "yes" "$(printf '%s' "$CAPPED" | grep -q optOutWorks      && echo yes || echo no)"
chk "a small slice is left alone"         "yes" "$(printf '%s' "$CAPPED" | grep -q smallUntouched   && echo yes || echo no)"

# ---- an idle-LOOKING pane is not a finished command ------------------------
#
# `pane_current_command` names the foreground PROCESS, so a shell script runs
# as `bash` and classifies as a shell at its prompt. A cold agent's `wait`
# returned `idle` twice during `brew install` — Homebrew's `brew` is a
# `#!/bin/bash` script — while `poll`, reading the exit marker, said busy. It
# only noticed because it polled anyway; trusting `wait` means acting on a
# half-finished install. The marker is the tiebreak.
SETTLED="$(ATH_HOME="$(mktemp -d)" node -e '
const a=require("'"$RP"'/packages/core/dist/index.js");
const fs=require("fs"), path=require("path"), out=[];
const home=process.env.ATH_HOME, S="\x1e";
fs.mkdirSync(path.join(home,"log"),{recursive:true});
const log=path.join(home,"log","r.log");
(async()=>{
  // Started, printing, no end marker: provably still running.
  fs.writeFileSync(log,`${S}<ATHS:aaaaaaaaaaaa>${S}\nunpacking\n`);
  out.push((await a.lastCommandEvidence("r"))==="running"?"runningNotIdle":"FALSEIDLE");
  fs.appendFileSync(log,`${S}<ATHE:aaaaaaaaaaaa:0:Lw==:>${S}\n`);
  out.push((await a.lastCommandEvidence("r"))==="finished"?"finishedIsIdle":"STUCKBUSY");
  out.push((await a.commandFinished("r","aaaaaaaaaaaa"))===true?"handleFinished":"HANDLEBAD");
  // No framed agent command at all. Must be `unknown`, NOT `finished`:
  // collapsing the two is what let a chatty build — whose own start marker
  // scrolled out of the scan window — answer `idle` with half a minute to run.
  fs.writeFileSync(path.join(home,"log","q.log"),"just output\n");
  out.push((await a.lastCommandEvidence("q"))==="unknown"?"unknownIsUnknown":"ROUNDEDTOIDLE");
  // The real shape of it: a start marker pushed out by the command'"'"'s own
  // output. The handle still answers exactly; the scan alone cannot.
  const big=path.join(home,"log","big.log");
  fs.writeFileSync(big,`${S}<ATHS:bbbbbbbbbbbb>${S}\n`+"x".repeat(64*1024)+"\n");
  out.push((await a.lastCommandEvidence("big"))==="unknown"?"chattyIsUnknown":"CHATTYWRONG");
  out.push((await a.commandFinished("big","bbbbbbbbbbbb"))===false?"handleStillExact":"HANDLELOST");
  process.stdout.write(out.join(" "));
})();
' 2>/dev/null)"
chk "a running command is not idle"      "yes" "$(printf '%s' "$SETTLED" | grep -q runningNotIdle      && echo yes || echo no)"
chk "a finished command reads idle"      "yes" "$(printf '%s' "$SETTLED" | grep -q finishedIsIdle      && echo yes || echo no)"
chk "the handle settles it outright"     "yes" "$(printf '%s' "$SETTLED" | grep -q handleFinished      && echo yes || echo no)"
chk "no marker reports unknown, not idle" "yes" "$(printf '%s' "$SETTLED" | grep -q unknownIsUnknown  && echo yes || echo no)"
chk "a chatty command reads unknown"      "yes" "$(printf '%s' "$SETTLED" | grep -q chattyIsUnknown   && echo yes || echo no)"
chk "the handle stays exact when chatty"  "yes" "$(printf '%s' "$SETTLED" | grep -q handleStillExact  && echo yes || echo no)"

# ---- await_human must not report "still waiting" at an answered prompt -----
#
# Found by a cold agent mid-run. It asked for a password, the human typed it,
# `sudo -v` exited 0 — and await_human answered `still_waiting`, so the agent
# concluded the password had NOT been typed and went off to do other work.
#
# Two independent causes, so two checks. Either one alone reproduces it.
AWAIT="$(ATH_HOME="$(mktemp -d)" node -e '
const fs=require("fs"), path=require("path"), out=[];
const a=require("'"$RP"'/packages/core/dist/index.js");
const home=process.env.ATH_HOME, S="\x1e";
fs.mkdirSync(path.join(home,"log"),{recursive:true});
// An agent command that finished, then the human prompt frame the shell opens
// at every idle prompt and does not close until the person runs something.
fs.writeFileSync(path.join(home,"log","t.log"),
  `${S}<ATHS:c5206908f3d2>${S}\nout\n${S}<ATHE:c5206908f3d2:0:Lw==:>${S}\n${S}<ATHS:h8>${S}\n`);
(async()=>{
  out.push((await a.latestHandle("t"))==="c5206908f3d2"?"agentNonce":"HUMANFRAME");
  // A resolved request must still be findable: it is the proof a human answered.
  const r=await a.requestHuman("t","need password","agent","c5206908f3d2",true);
  await a.clearRequest(r.id);
  const all=await a.listAllRequests();
  out.push(all.some(x=>x.handle==="c5206908f3d2"&&x.resolvedAt)?"resolvedVisible":"resolvedLOST");
  out.push((await a.listRequests()).length===0?"openExcludes":"openBAD");
  process.stdout.write(out.join(" "));
})();
' 2>/dev/null)"
chk "latestHandle ignores human frames"      "yes" "$(printf '%s' "$AWAIT" | grep -q agentNonce      && echo yes || echo no)"
chk "an answered request stays discoverable" "yes" "$(printf '%s' "$AWAIT" | grep -q resolvedVisible && echo yes || echo no)"
chk "…while dropping out of the open list"   "yes" "$(printf '%s' "$AWAIT" | grep -q openExcludes    && echo yes || echo no)"

# ---- start() must warn about the same hazards run() does -------------------
#
# A cold agent backgrounded `du -x / 2>/dev/null` and got a total 50 GB short,
# because /var/lib/docker is root-only and the errors went to the bin. The
# traversal guard already existed — it was simply never wired to `start`, so
# the one command shape most likely to be backgrounded was the one nothing
# checked. Tested through the real path, not by reading the source.
SW="$(ATH_HOME="$(mktemp -d)" ATH_SOCKET="athv$$" node -e '
const a=require("'"$RP"'/packages/core/dist/index.js");
(async()=>{
  await a.create({name:"w",cwd:"/tmp"});
  for(let i=0;i<10;i++){const s=await a.get("w").catch(()=>null);if(s&&s.state==="idle")break;await new Promise(r=>setTimeout(r,700));}
  const r=await a.start("w","du -x --max-depth=2 / 2>/dev/null");
  process.stdout.write(r.warning?"warned":"SILENT");
  await a.kill("w").catch(()=>{});
})();
' 2>/dev/null)"
chk "start warns on discarded stderr" "warned" "$SW"

# ---- never offer a session a human is being asked about --------------------
#
# `parallel_work` told an agent a session parked at a sudo prompt was "idle and
# usable right now". State alone races the pane; an open request does not.
PW="$(ATH_HOME="$(mktemp -d)" node -e '
const a=require("'"$RP"'/packages/core/dist/index.js");
(async()=>{
  await a.requestHuman("parked","password needed","agent","aaaaaaaaaaaa",true);
  const asked=new Set((await a.listRequests()).map(r=>r.session));
  process.stdout.write(asked.has("parked")?"withheld":"OFFERED");
})();
' 2>/dev/null)"
chk "a session with an open request is withheld" "withheld" "$PW"

# The two facts that decide the session ARCHITECTURE must be in the tool
# schemas, not only the skill file: an agent reading schemas alone planned the
# wrong layout and would have cost its human a second password.
chk "start schema states the session goes busy" "yes" \
    "$(grep -q 'SESSION GOES BUSY' "$RP/packages/mcp/src/tools.ts" && echo yes || echo no)"
chk "run schema states sudo is per-session"     "yes" \
    "$(grep -q 'SUDO DOES NOT CROSS SESSIONS' "$RP/packages/mcp/src/tools.ts" && echo yes || echo no)"

# ---- timing is MEASURED, not observed ---------------------------------------
#
# Three cold agents in a row reported this field as useless: a 47s job as 256s,
# a 44s job as a 170-second bracket, the same job as [38,185]. All three ended
# up timing commands by hand. The shell now times itself, so the figure no
# longer depends on when anyone looked.
#
# Tested with ONE LATE POLL — the exact shape that produced [38,185]. Polling
# promptly would hide a regression back to the observation window.
TIMING="$(ATH_HOME="$(mktemp -d)" ATH_SOCKET="atht$$" node -e '
const a=require("'"$RP"'/packages/core/dist/index.js");
(async()=>{
  await a.create({name:"tq",cwd:"/tmp"});
  for(let i=0;i<12;i++){const s=await a.get("tq").catch(()=>null);if(s&&s.state==="idle")break;await new Promise(r=>setTimeout(r,700));}
  const s=await a.start("tq","sleep 5");
  await new Promise(r=>setTimeout(r,9000));      // look LATE, and only once
  const p=await a.poll("tq",s.handle,s.offset);
  process.stdout.write(`${p.done} ${p.elapsedExact} ${p.elapsedSeconds}`);
  await a.kill("tq").catch(()=>{});
})();
' 2>/dev/null)"
chk "a 5s job polled once, late, reports 5s" "true true 5" "$TIMING"

# The marker must not reach the caller as output. Every marker letter has to be
# in MARKER_LINE_RE; `D` was missed on its first day.
chk "every marker letter is filtered from reads" "yes" \
    "$(grep -q 'ATH\[SETRD\]' "$RP/packages/core/src/run.ts" && echo yes || echo no)"

# ---- the request record must never call an answered prompt unanswered ------
#
# An agent's password WAS typed and the command completed; `ath requests`
# rendered it as "NOT answered — the prompt was cancelled or timed out",
# because `finished` is polled from a log that had since been purged. The agent
# said it would have re-prompted its human. `resolvedAt` is written the moment
# a human acts and survives the purge — three separate branches ignored it.
#
# And `--clear` reported "cleared 1 request(s)" twice while deleting nothing:
# it called clearRequest, which MARKS resolved, so on an already-resolved
# record it only refreshed the timestamp.
REQ="$(ATH_HOME="$(mktemp -d)" node -e '
const a=require("'"$RP"'/packages/core/dist/index.js");
(async()=>{
  const r=await a.requestHuman("s","sudo -v is waiting","agent","abc123abc123",true);
  await a.clearRequest(r.id);                       // the human answers
  const rec=(await a.listAllRequests())[0];
  const marked = rec && rec.resolvedAt ? "marked" : "NOTMARKED";
  const gone  = (await a.deleteRequest(rec.id)) ? "deleted" : "NOTDELETED";
  const left  = (await a.listAllRequests()).length;
  process.stdout.write(`${marked} ${gone} left=${left}`);
})();
' 2>/dev/null)"
chk "answering a request records resolvedAt" "yes" \
    "$(printf '%s' "$REQ" | grep -q marked  && echo yes || echo no)"
chk "--clear actually deletes the record"    "yes" \
    "$(printf '%s' "$REQ" | grep -q deleted && echo yes || echo no)"
chk "and nothing is left behind"             "yes" \
    "$(printf '%s' "$REQ" | grep -q 'left=0' && echo yes || echo no)"
# The renderer must not contradict the record it just read — asserted on the
# TEXT A PERSON SEES, not by grepping the source for a variable name. A source
# grep proves the code says something, never that running it prints it; that
# distinction is why the original bug survived a passing suite.
RH="$(mktemp -d)"
RENDER="$(ATH_HOME="$RH" ATH_SOCKET="athr$$" sh -c '
  '"$ATH_BIN"' new rq --cwd /tmp >/dev/null 2>&1
  for _ in 1 2 3 4 5 6 7 8; do '"$ATH_BIN"' ls 2>/dev/null | grep -q "^rq .*idle" && break; sleep 1; done
  node -e "
    const a=require(\"'"$RP"'/packages/core/dist/index.js\");
    (async()=>{ const r=await a.requestHuman(\"rq\",\"sudo -v is waiting\",\"agent\",\"abc123abc123\",true);
                await a.clearRequest(r.id); })();
  " 2>/dev/null
  '"$ATH_BIN"' requests 2>&1
  '"$ATH_BIN"' kill rq --force >/dev/null 2>&1
')"
chk "an answered prompt is not called unanswered" "yes" \
    "$(printf '%s' "$RENDER" | grep -q 'NOT answered' && echo no || echo yes)"
chk "and is reported as answered, in words"        "yes" \
    "$(printf '%s' "$RENDER" | grep -q 'answered' && echo yes || echo no)"

# ---- warnings must not fire where they do not apply ------------------------
#
# Two false positives in twelve commands taught an agent to skim them, and it
# then under-weighted the one that was correct. A warning's value is entirely
# its credibility.
WARN="$(ATH_HOME="$(mktemp -d)" ATH_SOCKET="athw$$" node -e '
const a=require("'"$RP"'/packages/core/dist/index.js");
(async()=>{
  await a.create({name:"w",cwd:"/tmp"});
  for(let i=0;i<12;i++){const s=await a.get("w").catch(()=>null);if(s&&s.state==="idle")break;await new Promise(r=>setTimeout(r,700));}
  const hazard = await a.run("w","du -xh -d1 /etc 2>/dev/null",{timeoutMs:20000});
  // the REMEDY: stderr to a file, with an unrelated /dev/null later in the line
  const remedy = await a.run("w","du -xh -d1 /etc 2>/tmp/du.err; wc -l < /tmp/du.err 2>/dev/null",{timeoutMs:20000});
  // a privileged non-interactive check that SUCCEEDS hides nothing
  const ok = await a.run("w","sudo -n true 2>/dev/null || true",{timeoutMs:20000});
  process.stdout.write(`${hazard.warning?"h":"H"}${remedy.warning?"R":"r"}${ok.warning?"O":"o"}`);
  await a.kill("w").catch(()=>{});
})();
' 2>/dev/null)"
chk "the real hazard still warns"                  "yes" "$(printf '%s' "$WARN" | grep -q '^h' && echo yes || echo no)"
chk "following the advice does not re-warn"        "yes" "$(printf '%s' "$WARN" | grep -q 'r'  && echo yes || echo no)"
chk "a successful privileged check does not warn"  "yes" "$(printf '%s' "$WARN" | grep -q 'o$' && echo yes || echo no)"

# ---- an MCP-only agent must be able to clean up after itself --------------
#
# Two agents in a row were told to leave nothing behind and could not: `purge`,
# `doctor` and `unpin` existed only on the CLI, so a session that began in MCP
# could not finish there. One of them pinned its own session, was then refused
# a kill on the grounds that "a human marked this terminal as theirs", and had
# to shell out. Withholding purge was deliberate — discarding a record is a
# human's decision — but an agent CARRYING OUT that instruction is executing
# the human's decision, not substituting its own.
for t in purge doctor unpin; do
  chk "MCP exposes $t" "yes" \
      "$(grep -q "name: '$t'" "$RP/packages/mcp/src/tools.ts" && echo yes || echo no)"
done

# ---- one serializer, so the two surfaces cannot drift again ---------------
#
# The CLI dumped internal objects verbatim (exit_code) while MCP hand-mapped
# them (exit_code): the same field with two names one call apart, papered over
# by a table in the docs. An agent noted a table "means the doc knows this is a
# cost and passes it to me anyway".
CLIKEYS="$($ATH_BIN run "$C" --json -- 'true' 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(Object.keys(JSON.parse(d)).join(" "))}catch(e){process.stdout.write("x")}})')"
for f in exit_code needs_input timed_out log_offset; do
  chk "CLI --json emits $f" "yes" "$(printf '%s' "$CLIKEYS" | grep -q "$f" && echo yes || echo no)"
done
chk "and no camelCase survives" "yes" \
    "$(printf '%s' "$CLIKEYS" | grep -qE 'exitCode|needsInput|timedOut|logOffset' && echo no || echo yes)"

# ---- the truncation hazard has a lever ------------------------------------
#
# The docs describe tmux truncating output to the pane width, and offered no
# way to change it: an agent watched `MOUNTPOINT` render as `MOUNTPOIN` and
# said "the docs describe the hazard carefully and then offer no lever".
WIDE="$(ATH_HOME="$(mktemp -d)" ATH_SOCKET="athx$$" node -e '
const a=require("'"$RP"'/packages/core/dist/index.js");
(async()=>{
  await a.create({name:"wx",cwd:"/tmp",width:500});
  for(let i=0;i<12;i++){const s=await a.get("wx").catch(()=>null);if(s&&s.state==="idle")break;await new Promise(r=>setTimeout(r,700));}
  const r=await a.run("wx","tput cols",{timeoutMs:20000});
  process.stdout.write(r.output.trim());
  await a.kill("wx").catch(()=>{});
})();
' 2>/dev/null)"
chk "a program inside the session sees the width it was given" "500" "$WIDE"

# ---- a parked session must not show the PREVIOUS command's outcome --------
#
# `run` recorded a command only when it completed, so one that parked at a
# prompt was never recorded — and `ls` kept showing the command before it,
# beside that command's exit code. An agent watching a session parked on
# `sudo -v` was shown `last_command: "sudo -n true", last_exit_code: 1`, which
# read as "sudo failed" while sudo was in fact waiting for a password. It
# called that "quietly wrong data, which is worse than an error".
#
# An empty exit code already means "still running" everywhere else; `run` just
# never took part.
PARK="$(ATH_HOME="$(mktemp -d)" ATH_SOCKET="athp$$" node -e '
const a=require("'"$RP"'/packages/core/dist/index.js");
(async()=>{
  await a.create({name:"pk",cwd:"/tmp"});
  for(let i=0;i<12;i++){const s=await a.get("pk").catch(()=>null);if(s&&s.state==="idle")break;await new Promise(r=>setTimeout(r,700));}
  await a.run("pk","false",{timeoutMs:15000}).catch(()=>{});          // finishes, exit 1
  await a.run("pk","printf \"[sudo] password for dev: \"; read -rs p",{timeoutMs:8000}).catch(()=>{});
  await new Promise(r=>setTimeout(r,1500));
  const s=await a.get("pk");
  const stale = /^false$/.test((s.lastCommand||"").trim()) || s.lastExitCode !== undefined;
  process.stdout.write(stale?"STALE":"fresh");
  await a.sendKeys("pk",["C-c"]).catch(()=>{});
  await a.kill("pk").catch(()=>{});
})();
' 2>/dev/null)"
chk "a parked session does not report the previous command" "fresh" "$PARK"

# ---- a settled request must not read as a live instruction ----------------
#
# The reason text is stored verbatim when a request is filed, in the present
# tense. Printed unchanged beneath a "DONE" status it contradicts it, and the
# imperative is the half a skimming reader acts on: an agent said it "would
# plausibly re-ping you about something answered three minutes ago".
SETTLED="$(ATH_HOME="$(mktemp -d)" ATH_SOCKET="aths$$" sh -c '
  '"$ATH_BIN"' new sq --cwd /tmp >/dev/null 2>&1
  for _ in 1 2 3 4 5 6 7 8; do '"$ATH_BIN"' ls 2>/dev/null | grep -q "^sq .*idle" && break; sleep 1; done
  node -e "
    const a=require(\"'"$RP"'/packages/core/dist/index.js\");
    (async()=>{const r=await a.requestHuman(\"sq\",\"x is waiting at a prompt. Attach and answer it.\",\"agent\",\"abc123abc123\",true);
    await a.clearRequest(r.id);})();" 2>/dev/null
  '"$ATH_BIN"' requests 2>&1
  '"$ATH_BIN"' kill sq --force >/dev/null 2>&1
')"
chk "a settled request marks its reason as history" "yes" \
    "$(printf '%s' "$SETTLED" | grep -q '(asked)' && echo yes || echo no)"

# ---- MCP must have a bounded wait, and must not wait out a human ----------
chk "MCP exposes wait" "yes" \
    "$(grep -q "name: 'wait'" "$RP/packages/mcp/src/tools.ts" && echo yes || echo no)"
chk "wait reports a prompt instead of blocking on it" "yes" \
    "$(grep -q "outcome: 'needs_human'" "$RP/packages/mcp/src/index.ts" && echo yes || echo no)"

# ---- width must be re-assertable on a LIVE session -------------------------
#
# It was settable only at creation, so an agent finding its output truncated
# had one remedy: destroy the session and rebuild it wider — discarding the
# sudo timestamp and costing the human another password. Tested end to end,
# including that session state SURVIVES the resize, since surviving is the
# entire reason this exists.
WID="$(ATH_HOME="$(mktemp -d)" ATH_SOCKET="athW$$" node -e '
const a=require("'"$RP"'/packages/core/dist/index.js");
(async()=>{
  await a.create({name:"wz",cwd:"/tmp"});
  for(let i=0;i<12;i++){const s=await a.get("wz").catch(()=>null);if(s&&s.state==="idle")break;await new Promise(r=>setTimeout(r,700));}
  await a.run("wz","export MARK=kept",{timeoutMs:15000});
  const before=(await a.run("wz","tput cols",{timeoutMs:15000})).output.trim();
  await a.setWidth("wz",500);
  const after=(await a.run("wz","tput cols",{timeoutMs:15000})).output.trim();
  const mark=(await a.run("wz","echo $MARK",{timeoutMs:15000})).output.trim();
  process.stdout.write(`${before} ${after} ${mark}`);
  await a.kill("wz").catch(()=>{});
})();
' 2>/dev/null)"
chk "a live pane can be widened"            "yes" "$(printf '%s' "$WID" | grep -q ' 500 ' && echo yes || echo no)"
chk "and the session survives the resize"   "yes" "$(printf '%s' "$WID" | grep -q 'kept$' && echo yes || echo no)"
chk "exposed on both surfaces"              "yes" \
    "$(grep -q "name: 'width'" "$RP/packages/mcp/src/tools.ts" && grep -q "case 'width'" "$RP/packages/cli/src/index.ts" && echo yes || echo no)"

# The instability belongs with the PARSING hazards, not as a footnote on a flag.
# An agent reported a truncation defect, re-measured, and found the width had
# moved underneath it because someone attached between two calls.
chk "width instability is stated as a hazard" "yes" \
    "$(grep -q 'CHANGE BETWEEN TWO CALLS' "$SK" && echo yes || echo no)"

# ---- the env tracker must not harvest text from inside quotes -------------
#
# `envAssignments` split on `;` with no quote awareness, so
# `awk '{a=$4; p=""; print}'` produced the fragment `p=""` — a valid assignment
# in isolation. The hub stored `p` as a session variable and would have
# replayed it on reconnect. An agent found exactly that and said it makes the
# restore guarantee weaker than the docs claim.
#
# This is the SAME bug already fixed on the shell side, left standing in the
# TypeScript. Both directions are checked: no garbage, and real exports still
# captured — a filter that catches everything by capturing nothing is not a fix.
ENVA="$(node -e '
const a=require("'"$RP"'/packages/core/dist/index.js");
const junk = a.envAssignments(`ss -tlnp | awk \x27{a=$4; p=""; print}\x27`).length === 0;
const real = a.envAssignments("cd /tmp; export FOO=bar; ls").join("") === "export FOO=bar";
const str  = a.envAssignments(`echo "a=1; b=2"`).length === 0;
process.stdout.write(`${junk?"noJunk":"JUNK"} ${real?"keepsReal":"LOSTREAL"} ${str?"noStr":"STR"}`);
' 2>/dev/null)"
chk "quoted text is not harvested as env"   "yes" "$(printf '%s' "$ENVA" | grep -q noJunk    && echo yes || echo no)"
chk "real exports are still captured"       "yes" "$(printf '%s' "$ENVA" | grep -q keepsReal && echo yes || echo no)"
chk "assignments inside a string are not"   "yes" "$(printf '%s' "$ENVA" | grep -q noStr     && echo yes || echo no)"

# ---- the doc must not name a field in the spelling the tool does not emit --
#
# The file states in bold that both surfaces share field names, then went on
# naming `remoteCwd` and `remoteEnv` in prose. An agent typed those, got a
# silent `None`, and concluded the feature was unimplemented — "a mistyped key
# should not look identical to an absent value". Seventeen sites survived the
# rename because I fixed the mapping table and not the paragraphs around it.
chk "no camelCase field names remain in the skill" "0" \
    "$(grep -oE '`(remoteCwd|remoteEnv|paneTail|lastCommand|lastExitCode|creatorPids|paneWidth|needsInput|exitCode|timedOut|nextOffset|logOffset|shellExited)`' "$SK" 2>/dev/null | wc -l | tr -d ' ')"

# ---- the only silent-corruption path must announce itself -----------------
#
# A human attaching resizes the pane — usually to answer the very prompt the
# command raised — so output shape changes mid-session. Two agents hit it. The
# second put it exactly: "this is the one condition in the whole tool that can
# silently corrupt output, and it's the one condition with no runtime signal…
# the errors are excellent; the silent state changes are the gap."
#
# Three states are checked, because a signal that fires always is as useless as
# one that never fires: quiet on the first command, loud on the one after a
# resize, quiet again when nothing more changes.
WCH="$(ATH_HOME="$(mktemp -d)" ATH_SOCKET="athC$$" node -e '
const a=require("'"$RP"'/packages/core/dist/index.js");
const {execSync}=require("child_process");
(async()=>{
  await a.create({name:"cw",cwd:"/tmp",width:200});
  for(let i=0;i<12;i++){const s=await a.get("cw").catch(()=>null);if(s&&s.state==="idle")break;await new Promise(r=>setTimeout(r,700));}
  const one=await a.run("cw","echo 1",{timeoutMs:15000});
  try{execSync(`tmux -L athC'"$$"' resize-window -t ath-cw -x 156 -y 40`)}catch(e){}
  const two=await a.run("cw","echo 2",{timeoutMs:15000});
  const three=await a.run("cw","echo 3",{timeoutMs:15000});
  process.stdout.write(
    `${one.paneWidthChanged?"BASELOUD":"baseQuiet"} ` +
    `${two.paneWidthChanged && two.paneWidthChanged.from===200 && two.paneWidthChanged.to===156 ? "announced":"MISSED"} ` +
    `${three.paneWidthChanged?"REPEATS":"settles"}`);
  await a.kill("cw").catch(()=>{});
})();
' 2>/dev/null)"
chk "no signal before anything changes" "yes" "$(printf '%s' "$WCH" | grep -q baseQuiet && echo yes || echo no)"
chk "a resize is announced with both widths" "yes" "$(printf '%s' "$WCH" | grep -q announced && echo yes || echo no)"
chk "and it does not repeat afterwards" "yes" "$(printf '%s' "$WCH" | grep -q settles   && echo yes || echo no)"

# The doc named log_offset as shared while MCP never emitted it — an agent
# looked for what it had been promised and did not find it.
chk "MCP run emits log_offset" "yes" \
    "$(grep -q 'log_offset: result.logOffset' "$RP/packages/mcp/src/index.ts" && echo yes || echo no)"

# ---- output must not be able to impersonate a marker ----------------------
#
# A cold agent asked what happens if a command's own output contains something
# resembling a marker. The defence is real — every marker is wrapped in a
# control byte — but it was documented nowhere, so the agent had to take it on
# faith. It is now stated in the skill file, which means it is a CLAIM, and an
# unverified claim in that file is the exact failure a previous agent caught:
# a doc promising something the tool does not do.
FORGE="$(ATH_HOME="$(mktemp -d)" ATH_SOCKET="athF$$" node -e '
const a=require("'"$RP"'/packages/core/dist/index.js");
(async()=>{
  await a.create({name:"fk",cwd:"/tmp"});
  for(let i=0;i<12;i++){const s=await a.get("fk").catch(()=>null);if(s&&s.state==="idle")break;await new Promise(r=>setTimeout(r,700));}
  // A convincing fake END marker claiming exit 99, printed mid-output.
  const r = await a.run("fk",`echo before; echo "<ATHE:deadbeefcafe:99:Lw==:>"; echo after`,{timeoutMs:20000});
  const rightCode = r.exitCode === 0;                       // the REAL status, not 99
  const passedThrough = /deadbeefcafe/.test(r.output);       // shown as ordinary output
  const notTruncated = /after/.test(r.output);               // did not end the command early
  process.stdout.write(`${rightCode?"code":"CODE"} ${passedThrough?"shown":"SWALLOWED"} ${notTruncated?"whole":"TRUNCATED"}`);
  await a.kill("fk").catch(()=>{});
})();
' 2>/dev/null)"
chk "a forged marker cannot set the exit code" "yes" "$(printf '%s' "$FORGE" | grep -q 'code'  && echo yes || echo no)"
chk "and is passed through as ordinary output" "yes" "$(printf '%s' "$FORGE" | grep -q 'shown' && echo yes || echo no)"
chk "and cannot end the command early"         "yes" "$(printf '%s' "$FORGE" | grep -q 'whole' && echo yes || echo no)"
chk "the skill states this defence"            "yes" \
    "$(grep -q 'cannot impersonate a marker' "$SK" && echo yes || echo no)"

# ---- container tooling is recognised whatever the vendor calls its binary ---
#
# `docker` on a Mac is often a symlink into OrbStack, Docker Desktop or Rancher,
# so the pane reports `docker-tools` rather than `docker`. The exact-name Set
# matched nothing, the hub never saw a nested shell, and a session stayed BUSY
# forever after `docker exec` — `run` against it returned nothing at all.
#
# The second half matters as much: `classify` did its own Set lookup instead of
# calling `isNesting`, so teaching `isNesting` about the prefixes fixed one
# reader while the one that decides busy-vs-idle carried on being wrong.
NEST="$(node -e '
const s=require("'"$RP"'/packages/core/dist/state.js");
const yes=["docker","docker-tools","docker-compose","podman-remote","kubectl","nerdctl","ssh"];
const no=["zsh","bash","node","npm"];
const okYes=yes.every(c=>s.isNesting(c));
const okNo=no.every(c=>!s.isNesting(c));
// classify must agree with isNesting, not with a private copy of the list
const idle=s.classify({paneDead:false,currentCommand:"docker-tools",paneTail:"/ # ",paneWidth:80})==="idle";
const busy=s.classify({paneDead:false,currentCommand:"node",paneTail:"working",paneWidth:80})==="busy";
process.stdout.write(`${okYes?"yes":"NO"} ${okNo?"noFalse":"FALSEPOS"} ${idle?"idle":"STUCKBUSY"} ${busy?"busy":"BUSYBROKE"}`);
' 2>/dev/null)"
chk "vendor-wrapped container binaries are nesting" "yes"     "$(printf '%s' "$NEST" | awk '{print $1}')"
chk "ordinary commands are not"                     "noFalse" "$(printf '%s' "$NEST" | awk '{print $2}')"
chk "a container shell at its prompt reads idle"    "idle"    "$(printf '%s' "$NEST" | awk '{print $3}')"
chk "a real working command still reads busy"       "busy"    "$(printf '%s' "$NEST" | awk '{print $4}')"

# The skill must carry the same disclosure the CLI does.
chk "skill documents what survives purge" "yes" \
    "$(grep -q 'What this leaves on disk' "$SK" && echo yes || echo no)"
chk "skill points at doctor --artifacts"  "yes" \
    "$(grep -q 'doctor --artifacts' "$SK" && echo yes || echo no)"
# The description is what decides whether the skill LOADS. It triggered on
# state, sudo and remote, so a hang-prone command reached an agent that had
# never read any of this.
chk "skill triggers on long/hanging work" "yes" \
    "$(awk '/^description:/{print}' "$SK" | grep -qE 'hang|run long' && echo yes || echo no)"

$ATH_BIN kill "${C}d" --force >/dev/null 2>&1 || true
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
const local={name:"x",tmuxName:"ath-x",state:"idle",cwd:"/local/repo",current_command:"zsh",
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
code=$(printf '%s' "$json" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(JSON.parse(b).exit_code))')
exited=$(printf '%s' "$json" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(!!JSON.parse(b).shell_exited))')
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
cmd=$($ATH ls --json | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{const s=JSON.parse(b).find(x=>x.name===process.argv[1]);console.log(s?s.current_command:"missing")})' "$S")
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
agentout=$($ATH poll "$S" --handle "$handle" --json 2>/dev/null | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{try{const r=JSON.parse(b);console.log((r.output||"").replace(/\n/g," ")+"|"+r.exit_code)}catch(e){console.log("parse-error|")}})')
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
ni=$(printf '%s' "$json" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(!!JSON.parse(b).needs_input))')
rc=$(printf '%s' "$json" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(JSON.parse(b).exit_code))')
check "prompt-shaped output while busy is not needs-input" "false" "$ni"
check "and the command ran to completion" "0" "$rc"

echo
echo "-- a REAL prompt is still caught, and caught fast"
$ATH run "$S" -- 'sudo -k' >/dev/null 2>&1
start=$(date +%s)
json=$($ATH run "$S" --json -- 'sudo -p "Password:" true' 2>/dev/null); rcode=$?
elapsed=$(( $(date +%s) - start ))
ni=$(printf '%s' "$json" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(!!JSON.parse(b).needs_input))')
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
ec=$(printf '%s' "$pj" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(JSON.parse(b).exit_code))')
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
# `current_command` is the pane's foreground PROCESS, which on a remote session
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
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log(j.warning?"warned":(j.needs_human?"detected":"neither"))}catch(e){console.log("x")}})')
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
e=$(printf '%s' "$j" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const hi=j.elapsed_upper_seconds!==undefined?j.elapsed_upper_seconds:j.elapsed_seconds;console.log(hi===undefined?"missing":(hi<=4?"fast":"slow"))}catch(e){console.log("x")}})')
check "a job that finished instantly is reported as fast" "fast" "$e"
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
echo "-- timing reports what is known, and never claims nobody looked"
# Four attempts at this field. The third withheld a number when the bracket was
# wide AND told an agent "nobody looked while this was running" — to an agent
# that HAD polled mid-run and been answered. False about the caller's own
# session, and it discarded the bracket, which is the actual answer.
$ATH kill tm --force >/dev/null 2>&1
$ATH new tm >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10; do $ATH ls 2>/dev/null | grep -q '^tm ' && break; sleep 1; done
h=$($ATH start tm -- 'sleep 8; echo x' 2>&1 | grep -oE '[0-9a-f]{12}' | head -1)
sleep 3
ex=$($ATH poll tm --handle "$h" --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log(j.done?"already-done":(j.elapsed_exact===true?"exact":"other"))}catch(e){console.log("x")}})')
check "while running, the figure is exact" "exact" "${ex:-x}"
sleep 9
br=$($ATH poll tm --handle "$h" --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const bracket=j.elapsed_lower_seconds!==undefined||j.elapsed_seconds!==undefined;console.log(j.done&&bracket&&j.elapsed_observed===true?"reported":"withheld")}catch(e){console.log("x")}})')
check "after a mid-run poll, a bracket is reported not withheld" "reported" "${br:-x}"
ob=$($ATH poll tm --handle "$h" --json 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).elapsed_observed===true?"observed":"claims-unobserved")}catch(e){console.log("x")}})')
check "and it does not claim nobody looked" "observed" "${ob:-x}"
$ATH kill tm --force >/dev/null 2>&1

echo "-- a non-interactive refusal informs the agent without summoning a human"
# `sudo -n` exits immediately; nothing is parked. Filing a request there sends
# someone to an idle shell with nothing to answer, and an agent probing its own
# environment had a request raised against its user for no reason.
rm -f "${ATH_HOME:-$HOME/.ath}"/requests/*.json 2>/dev/null || true
$ATH new nr >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10; do $ATH ls 2>/dev/null | grep -q '^nr ' && break; sleep 1; done
g=$($ATH run nr --json -- 'sudo -n true 2>&1' 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).needs_human?"told":"silent")}catch(e){console.log("x")}})')
check "the agent is told elevation is needed" "told" "${g:-x}"
n=$(node -e 'require("./packages/core/dist/index.js").listAllRequests().then(r=>console.log(r.filter(x=>x.session==="nr").length))' 2>/dev/null)
check "but no request is filed, because nothing is waiting" "0" "${n:-x}"
$ATH kill nr --force >/dev/null 2>&1

echo
echo "-- exit_code says when it is only part of the story"
# The shell reports the LAST segment's status. `sudo -n true 2>&1; echo "exit=$?"`
# came back exit_code 0 while its own output read exit=1, and a line ending in
# `grep -c` returned 1 for finding nothing though the real work succeeded. The
# one machine-readable field was the one most likely to mislead, twice in one
# session.
$ATH kill xc --force >/dev/null 2>&1
$ATH new xc >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10; do $ATH ls 2>/dev/null | grep -q '^xc ' && break; sleep 1; done
# The caveat is emitted once per SESSION, so each of these needs a fresh one —
# otherwise every assertion after the first is measuring the fatigue guard
# rather than the rule it is meant to test.
cav() {
  n="xc$RANDOM"
  $ATH new "$n" >/dev/null 2>&1
  for _ in 1 2 3 4 5 6 7 8; do $ATH ls 2>/dev/null | grep -q "^$n " && break; sleep 1; done
  r=$($ATH run "$n" --json -- "$1" 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).exit_caveat?"flagged":"silent")}catch(e){console.log("x")}})')
  $ATH kill "$n" --force >/dev/null 2>&1
  printf '%s' "$r"
}
# The MARKER rides every affected command — an agent said a caveat shown once
# "is simply gone while the hazard remains" for anyone joining mid-session or
# after a context summary. It is three words, so always showing it costs
# nothing; the paragraph is what gets shown once (checked separately below).
check "a trailing echo hiding a failure is marked" "flagged" "$(cav 'false; echo done')"
check "a pipeline that exits 0 while a stage failed is marked" "flagged" "$(cav 'false | cat')"
check "a non-zero pipeline is marked too — the code is still partial" "flagged" "$(cav 'echo hi | grep -c nope')"
check "a simple command is not marked" "silent" "$(cav 'echo plain')"
check "a separator inside quotes is not a compound command" "silent" "$(cav 'echo "a;b"')"
check "an && chain is not marked — there the status is the answer" "silent" "$(cav 'true && echo ok')"
$ATH kill xc --force >/dev/null 2>&1

echo
echo "-- killing a session someone is attached to is not silent"
# A session was destroyed while the human was still attached, having just typed
# a password into it, and the only output was "destroyed". The client count is
# in `list`; staying quiet about it is the tool withholding what the caller
# needed. Tested as a predicate because an attached tmux CLIENT cannot be
# created in a non-interactive environment, and this guard must not be the
# untested branch.
g=$(node -e '
const f=require("./packages/core/dist/index.js").attachedClientsNote;
const r=[f(0)?1:0, f(1)?1:0, f(3)?1:0].join("");
console.log(r === "011" ? "correct" : "wrong:"+r);' 2>/dev/null)
check "says so when clients were attached, silent when none" "correct" "${g:-x}"
# Reporting, not refusing: the VS Code panel attaches a client to every session
# it displays, so refusing would block ordinary cleanup whenever the panel is
# open. The case that must never be lost — an unanswered human request — is
# guarded separately and outranks --force.
m=$(node -e '
const f=require("./packages/core/dist/index.js").attachedClientsNote;
console.log(/editor panel/.test(f(1)||"") ? "hedged" : "overclaims");' 2>/dev/null)
check "and does not claim a person was definitely there" "hedged" "${m:-x}"

echo
echo "-- an unknown parameter is refused, not ignored"
# `new` accepted a `session` parameter it does not have, ignored it, and
# returned success — "how an agent convinces itself a flag works when it
# doesn't". Every schema already said additionalProperties:false; nothing
# enforced it.
mcpcall() { printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"v","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  "$1" | node packages/mcp/dist/index.js 2>/dev/null \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const r=JSON.parse(d.trim().split("\n").filter(Boolean).pop()).result;console.log(r.isError?"refused":"accepted")}catch(e){console.log("x")}})'; }
r=$(mcpcall '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list","arguments":{"bogus_param":1}}}')
check "a parameter the tool does not have is refused" "refused" "${r:-x}"
r=$(mcpcall '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list","arguments":{}}}')
check "and a valid call still works" "accepted" "${r:-x}"

echo
echo "-- the wait primitive returns, and tells the truth about who was asked"
# The skill instructs agents to arm this watch. It blocked for up to five
# minutes, which from an agent's side is indistinguishable from a hang — the
# user had to interrupt with "the wait tool use is bugged and let you stucked".
# A synchronous call must come back.
rm -f "${ATH_HOME:-$HOME/.ath}"/requests/*.json 2>/dev/null || true
$ATH kill wt --force >/dev/null 2>&1
$ATH new wt >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10; do $ATH ls 2>/dev/null | grep -q '^wt ' && break; sleep 1; done
$ATH start wt -- 'printf "Password: "; read -rs p' >/dev/null 2>&1
sleep 3
t0=$(date +%s)
o=$(printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"v","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"await_human","arguments":{"session":"wt","timeout_seconds":6}}}' \
  | node packages/mcp/dist/index.js 2>/dev/null \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const r=JSON.parse(d.trim().split("\n").filter(Boolean).pop()).result;console.log(JSON.parse(r.content[r.content.length-1].text).outcome)}catch(e){console.log("x")}})')
el=$(( $(date +%s) - t0 ))
check "an unanswered wait returns rather than hanging" "still_waiting" "${o:-x}"
check "and returns promptly, not minutes later" "yes" "$([ "$el" -lt 25 ] && echo yes || echo "took ${el}s")"
$ATH send wt -- C-c >/dev/null 2>&1; sleep 1
$ATH kill wt --force >/dev/null 2>&1
rm -f "${ATH_HOME:-$HOME/.ath}"/requests/*.json 2>/dev/null || true

# A refused (non-parked) command must not claim a request was filed: the flag an
# agent branches on contradicted the prose right beside it.
$ATH kill hf --force >/dev/null 2>&1
$ATH new hf >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10; do $ATH ls 2>/dev/null | grep -q '^hf ' && break; sleep 1; done
hr=$(printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"v","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"run","arguments":{"session":"hf","command":"sudo -n true 2>&1"}}}' \
  | node packages/mcp/dist/index.js 2>/dev/null \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const r=JSON.parse(d.trim().split("\n").filter(Boolean).pop()).result;const m=JSON.parse(r.content[r.content.length-1].text.replace("--- ath ---\n",""));console.log(m.human_requested===false?"honest":"claims-filed")}catch(e){console.log("x")}})')
check "a refused command does not claim a request was filed" "honest" "${hr:-x}"
n=$(node -e 'require("./packages/core/dist/index.js").listAllRequests().then(r=>console.log(r.filter(x=>x.session==="hf").length))' 2>/dev/null)
check "and none was" "0" "${n:-x}"
$ATH kill hf --force >/dev/null 2>&1

echo
echo "-- a request never claims someone answered when nobody did"
# An agent interrupted its own `sudo id` with Ctrl-C and the queue reported
# "answered — exit 1". sudo traps SIGINT and exits 1, so an interrupt never
# looks like 130/143 — the exit code simply cannot tell an answer from an
# interrupt. Acting on that string means believing you have root.
rm -f "${ATH_HOME:-$HOME/.ath}"/requests/*.json 2>/dev/null || true
$ATH kill ia --force >/dev/null 2>&1
$ATH new ia >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10; do $ATH ls 2>/dev/null | grep -q '^ia ' && break; sleep 1; done
$ATH start ia -- 'printf "Password: "; read -rs p; exit 1' >/dev/null 2>&1
sleep 3
$ATH ls >/dev/null 2>&1
# "answer" it in a way that ends non-zero — indistinguishable from an interrupt
TMX send-keys -t ath-ia 'x' Enter 2>/dev/null; sleep 3
out=$($ATH requests 2>&1)
case "$out" in
  *"ANSWERED"*) v="claimed answered" ;;
  *"not proof anyone answered"*) v=ok ;;
  *) v="$(printf '%s' "$out" | head -1)" ;;
esac
check "a non-zero outcome is not reported as answered" "ok" "$v"
$ATH kill ia --force >/dev/null 2>&1
rm -f "${ATH_HOME:-$HOME/.ath}"/requests/*.json 2>/dev/null || true

echo
echo "-- the stderr warning fires only where stderr is really the only signal"
# It warned about every privileged command that discarded stderr. But sudo
# writes its prompt to /dev/tty, so `sudo id 2>/dev/null` still parks and still
# files a request — verified. Crying wolf on the common case teaches the reader
# to skip it on the case that matters.
$ATH kill sw --force >/dev/null 2>&1
$ATH new sw >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10; do $ATH ls 2>/dev/null | grep -q '^sw ' && break; sleep 1; done
wn() { $ATH run sw --json -- "$1" 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).warning?"warned":"quiet")}catch(e){console.log("x")}})'; }
check "non-interactive + discarded stderr is warned about" "warned" "$(wn 'sudo -n true 2>/dev/null')"
check "an interactive one is not — it parks on the tty" "quiet" "$(wn 'sudo --version >/dev/null 2>/dev/null')"
$ATH kill sw --force >/dev/null 2>&1

echo
echo "-- new accepts the parameter name every other tool uses"
# `new` takes `name`; every other tool takes `session`. An agent that used any
# of them reached for `session`, was refused, and spent a retry on an
# inconsistency that was the tool's.
a=$(printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"v","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"new","arguments":{"session":"aliaschk","cwd":"/tmp"}}}' \
  | node packages/mcp/dist/index.js 2>/dev/null \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const r=JSON.parse(d.trim().split("\n").filter(Boolean).pop()).result;console.log(r.isError?"refused":JSON.parse(r.content[0].text).name)}catch(e){console.log("x")}})')
check "session= is accepted as an alias for name=" "aliaschk" "${a:-x}"
$ATH kill aliaschk --force >/dev/null 2>&1

echo
echo "-- a caveat that appears every time teaches the reader to skip it"
# Narrowing the compound-exit caveat to exit 0 was not enough: an agent that
# pipes constantly still met it on nearly every call and said "I stopped
# reading it". Said once it teaches the rule; repeated forever it trains the
# reader to ignore it, which costs the occasion it was written for.
$ATH kill cv --force >/dev/null 2>&1
$ATH new cv >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10; do $ATH ls 2>/dev/null | grep -q '^cv ' && break; sleep 1; done
# Marker every time, EXPLANATION once. Two agents complained in opposite
# directions one round apart — "I stopped reading it" and "it fired once then
# went quiet while the hazard remained" — and both were right about a different
# failure. Neither always nor once is correct for the same text.
cvm() { $ATH run cv --json -- "$1" 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).exit_caveat?"marked":"none")}catch(e){console.log("x")}})'; }
cvn() { $ATH run cv --json -- "$1" 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).exit_caveat_note?"explained":"quiet")}catch(e){console.log("x")}})'; }
check "the first compound command is explained" "explained" "$(cvn 'true; echo a')"
check "the second is not explained again" "quiet" "$(cvn 'true; echo b')"
check "but it is still marked" "marked" "$(cvm 'true; echo c')"
check "and so is a later pipeline" "marked" "$(cvm 'echo d | cat')"
$ATH kill cv --force >/dev/null 2>&1

echo
echo "-- a silent tree walk is flagged even without sudo"
# An agent ran `du -xh -d2 / 2>/dev/null`, got 20G against df's 70G, and nearly
# filed it: the walk could not read /var/lib/docker, its own redirect ate the
# errors, and the exit code was 0. A 50 GB understatement that looked entirely
# plausible. The credential warning did not cover it and should not — the
# command was unprivileged — but the shape is the same: stderr discarded,
# success reported, answer silently incomplete.
$ATH kill tw --force >/dev/null 2>&1
$ATH new tw >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10; do $ATH ls 2>/dev/null | grep -q '^tw ' && break; sleep 1; done
tw() { $ATH run tw --timeout 20 --json -- "$1" 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).warning?"warned":"quiet")}catch(e){console.log("x")}})'; }
check "a system-path walk discarding stderr is warned about" "warned" "$(tw 'find /etc -maxdepth 0 2>/dev/null')"
check "the same walk keeping stderr is not" "quiet" "$(tw 'find /etc -maxdepth 0 2>&1')"
check "a walk of the current directory is not" "quiet" "$(tw 'find . -maxdepth 0 2>/dev/null')"
# RECURSION is the hazard, not the command name. Matching on the name alone
# warned about `ls /var/lib/apt/periodic/`, which descends into nothing. An
# agent met that three times in one session, twice spuriously, and named it as
# the same fatigue dynamic this project has already been bitten by twice.
check "a plain ls of one directory is not warned about" "quiet" "$(tw 'ls /var/lib 2>/dev/null')"
check "but ls -R is" "warned" "$(tw 'ls -R /etc/hostname 2>/dev/null')"
check "grep without -r is not" "quiet" "$(tw 'grep x /etc/hostname 2>/dev/null')"
check "but grep -r is" "warned" "$(tw 'grep -r x /etc/hostname 2>/dev/null')"
# Redirecting stderr to a FILE is keeping it, not discarding it. An agent did
# exactly that, read the file (0 lines, which is how it knew the walk was
# clean), and was told it had "thrown away" the evidence. That false positive
# and one other arrived BEFORE the single true positive, so by the time the
# real warning came the reader had already learned to discount it — the exact
# dynamic the skill warns about.
check "stderr appended to a file is NOT discarding" "quiet" "$(tw 'find /etc -maxdepth 0 2>>/tmp/ath-errs.txt')"
check "stderr written to a file is NOT discarding" "quiet" "$(tw 'find /etc -maxdepth 0 2>/tmp/ath-errs.txt')"
rm -f /tmp/ath-errs.txt
$ATH kill tw --force >/dev/null 2>&1

echo
echo "-- warnings reach a READER, not just the result object"
# `warning` was computed in core for several rounds and displayed by NEITHER
# surface, so both blind-spot guards were invisible and an agent walked into the
# 50 GB `du` trap the second one exists to prevent. The earlier tests passed
# because they read `--json`, which dumps every field: they proved the data was
# produced, never that anyone could see it. Assert the SURFACES.
$ATH kill wr --force >/dev/null 2>&1
$ATH new wr >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10; do $ATH ls 2>/dev/null | grep -q '^wr ' && break; sleep 1; done
cliout=$($ATH run wr --timeout 20 -- 'find /etc -maxdepth 0 2>/dev/null' 2>&1)
# Match a stable phrase, not the exact prose — this assertion broke once when
# the wording was tightened, which tests the copywriter rather than the code.
# The phrase changed when the warning stopped ASSERTING a cause it had not
# observed: it blamed permission errors on a `du -x` whose stderr was EMPTY,
# and the real culprit was -x declining to cross a mount. "discards stderr" is
# the part that is true by construction, so it is the stable anchor.
case "$cliout" in *"discards stderr"*) v=ok ;; *) v="not shown" ;; esac
check "the CLI shows the warning to a human" "ok" "$v"
mcpw=$(printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"v","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"run","arguments":{"session":"wr","command":"find /etc -maxdepth 0 2>/dev/null"}}}' \
  | node packages/mcp/dist/index.js 2>/dev/null \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const r=JSON.parse(d.trim().split("\n").filter(Boolean).pop()).result;const m=JSON.parse(r.content[r.content.length-1].text.replace("--- ath ---\n",""));console.log(m.warning?"shown":"missing")}catch(e){console.log("x")}})')
check "and the MCP surface carries it too" "shown" "${mcpw:-x}"
$ATH kill wr --force >/dev/null 2>&1

echo
echo "-- a finished command is never also reported busy"
# `exit_code: 0` arrived alongside `state: "busy"` because the pane can still be
# mid-redraw when a command ends. An agent could not explain it and reasonably
# expected the next dispatch to be refused with session_busy.
$ATH kill bs --force >/dev/null 2>&1
$ATH new bs >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10; do $ATH ls 2>/dev/null | grep -q '^bs ' && break; sleep 1; done
contradictions=0
for i in 1 2 3 4 5 6 7 8; do
  r=$($ATH run bs --json -- "ls -la /etc | head -20; echo n=$i" 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log(j.exit_code!==null&&j.state==="busy"?"bad":"ok")}catch(e){console.log("x")}})')
  [ "$r" = "ok" ] || contradictions=$((contradictions+1))
done
check "done and busy never co-occur across repeated runs" "0" "$contradictions"
$ATH kill bs --force >/dev/null 2>&1

echo
echo "-- a shortened command echo says that it was shortened"
# A bare slice cut an agent's command inside its own quoted string, so the
# advisory ended `... || echo "-> no, as` — a fragment that reads like it
# describes some other command.
long=$(node -e '
const m=require("./packages/core/dist/index.js");
console.log(typeof m.quoteForMessage==="function"?"exported":"internal");' 2>/dev/null)
$ATH kill tq --force >/dev/null 2>&1
$ATH new tq >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10; do $ATH ls 2>/dev/null | grep -q '^tq ' && break; sleep 1; done
msg=$($ATH run tq --json -- 'echo "a fairly long preamble here to push past the limit"; sudo -n true 2>&1 || echo "-> no, as expected"' 2>/dev/null | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).needs_human||"")}catch(e){console.log("")}})')
case "$msg" in *"(truncated)"*) v=ok ;; "") v="no advisory" ;; *) v="silently cut" ;; esac
check "a truncated command echo is labelled truncated" "ok" "$v"
$ATH kill tq --force >/dev/null 2>&1

echo
echo "-- the framing hooks cannot be impersonated, not even by their own source"
# A cold agent watched a remote bash session hand back the helper's OWN SOURCE
# as command output, then go permanently mute on stdout while still reporting
# exit_code 0. The pane showed markers with the nonce `"*)`.
#
# Root cause: a nonce is extracted by stripping up to "AGENT INPUT ID: " and
# taking the next word. The bash side must read from `history 1`, which carries
# a leading line number, so its pattern is UNANCHORED — and the hook's own
# source contains that phrase inside a `case` pattern. Re-installing the hook
# mid-session made it match itself and extract `"*)` as the nonce. Every later
# command then framed under a bogus nonce, so the real one found no markers:
# empty output, exit code intact. Silent, and wrong in the trusting direction.
#
# A nonce is 12 lowercase hex characters. Anything else is not one.
ext() {
  bash -c '
    __ath_last="$1"
    __ath_pending="${__ath_last#*AGENT INPUT ID: }"; __ath_pending="${__ath_pending%% *}"
    case "$__ath_pending" in ""|*[!0-9a-f]*) __ath_pending="" ;; esac
    printf %s "$__ath_pending"' _ "$1"
}
check "the hook's own case-pattern source is rejected" "" \
      "$(ext '__ath_pre() { case "$1" in "AGENT INPUT ID: "*) __ath_pending=x')"
check "a non-hex word is rejected" "" "$(ext '  512  AGENT INPUT ID: HELLO')"
check "an empty extraction is rejected" "" "$(ext '  513  AGENT INPUT ID: ')"
check "a real nonce is still accepted" "49f540ddf7dd" \
      "$(ext '  514  AGENT INPUT ID: 49f540ddf7dd ')"
# And end to end: a command whose own TEXT carries the phrase must not corrupt
# the session that runs it.
$ATH kill imp --force >/dev/null 2>&1
$ATH new imp >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10; do $ATH ls 2>/dev/null | grep -q '^imp ' && break; sleep 1; done
$ATH run imp -- 'echo "AGENT INPUT ID: bogus"' >/dev/null 2>&1
check "a later command still returns its own output" "still-working" \
      "$($ATH run imp -- 'echo still-working' 2>/dev/null | tr -d "\n")"
check "and its exit code" "7" "$($ATH run imp -- '(exit 7)' >/dev/null 2>&1; echo $?)"
$ATH kill imp --force >/dev/null 2>&1

echo
echo "-- the helper is never typed into a live credential prompt"
# Installing types ~1.8 KB of shell into the pane. At a password prompt every
# character of it becomes a login attempt, the prompt is consumed before the
# human reaches it, and the helper's source lands in the log where an agent
# reads it back as command output. The self-heal reaches the installer from
# inside `run`, after that function's own check has already passed.
$ATH kill ci --force >/dev/null 2>&1
$ATH new ci >/dev/null 2>&1
for _ in 1 2 3 4 5 6 7 8 9 10; do $ATH ls 2>/dev/null | grep -q '^ci ' && break; sleep 1; done
$ATH start ci -- 'printf "Password: "; read -rs p' >/dev/null 2>&1
sleep 3
out=$(node -e '
require("./packages/core/dist/index.js").installHelper("ci")
  .then(()=>console.log("TYPED"))
  .catch(e=>console.log(e.code||"refused"));' 2>/dev/null)
check "installHelper refuses while a prompt is waiting" "credential_prompt" "${out:-x}"
$ATH send ci -- C-c >/dev/null 2>&1; sleep 1
$ATH kill ci --force >/dev/null 2>&1
rm -f "${ATH_HOME:-$HOME/.ath}"/requests/*.json 2>/dev/null || true

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
