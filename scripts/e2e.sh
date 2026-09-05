#!/usr/bin/env bash
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
const real="Enter passphrase for key \x27/Users/someone/Desktop/CodePlayground/20260201_vm/example_rsa\x27:";
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
printf 'passed %d, failed %d\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
