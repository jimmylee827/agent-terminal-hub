#!/usr/bin/env bash
# Edge-case harness. Runs the same battery against any session, local or remote.
S="$1"; LABEL="$2"
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
