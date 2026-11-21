#!/usr/bin/env bash
# Self-test for cleanup-bundles.sh: fifteen known-answer cases, each in its own
# fake HOME, that prove the script REFUSES what it must (mislabeled bundle, no
# product.json, missing bundle, manifest whose app did not verify) and DELETES
# what it should — including under --really, and on the iCloud path, which has
# spaces. Run it after changing cleanup-bundles.sh (seconds, touches nothing real):
#
#   scripts/livecollab/cleanup-bundles.selftest.sh
#
# A case is OK only if the exit code, the script's own SKIP/DELETED line AND
# what is left on disk all match. CLEANUP=<path> tests another copy instead.
# Exits non-zero unless all fifteen are OK.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLEANUP=${CLEANUP:-$HERE/cleanup-bundles.sh}
[ -f "$CLEANUP" ] || { echo "HARNESS: $CLEANUP not found"; exit 99; }
WORK=$(mktemp -d "${TMPDIR:-/tmp}/livecollab-cleanup-selftest.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
bad=0
n=0

# bundle <dir> <commit or ''>: a fake LiveCollab.app inside <dir>; '' = no product.json
bundle() {
	mkdir -p "$1/LiveCollab.app/Contents/Resources/app"
	[ -n "$2" ] && printf '{"commit":"%s"}' "$2" > "$1/LiveCollab.app/Contents/Resources/app/product.json"
	return 0
}
# icloud_app <home> <name> <commit>: a fake .app directly in the fake iCloud Drive
icloud_app() {
	mkdir -p "$1/Library/Mobile Documents/com~apple~CloudDocs/$2/Contents/Resources/app"
	printf '{"commit":"%s"}' "$3" > "$1/Library/Mobile Documents/com~apple~CloudDocs/$2/Contents/Resources/app/product.json"
}

# check <label> <expected exit> <expected output pattern> <expected survivors> <args...>
# survivors: everything left under the fake HOME's Desktop and iCloud Drive, joined by '|',
# in byte order (LC_ALL=C: uppercase before lowercase) — a locale sort folds case
# and reorders LiveCollab-*.app / livecollab-*-manifest.txt, failing a correct script.
check() {
	label=$1; want_rc=$2; want_out=$3; want_left=$4; shift 4
	n=$((n + 1))
	out=$(HOME="$H" bash "$CLEANUP" "$@" 2>&1); rc=$?
	left=$( (cd "$H" && ls -1 Desktop "Library/Mobile Documents/com~apple~CloudDocs" 2>/dev/null) | grep -v -e '^$' -e ':$' | LC_ALL=C sort | tr '\n' '|' | sed 's/|$//')
	if [ $rc -eq 127 ]; then r="HARNESS ERROR"
	elif [ $rc -eq "$want_rc" ] && printf '%s\n' "$out" | grep -q -E "$want_out" && [ "$left" = "$want_left" ]; then r=OK
	else r=WRONG; fi
	[ "$r" = OK ] || bad=1
	echo "[$r] $n. $label (expected exit $want_rc, got $rc)"
	[ "$r" = OK ] || { echo "      expected left: $want_left"; echo "      actual left:   $left"; printf '%s\n' "$out" | sed 's/^/      /' | head -8; }
}

fresh() { H="$WORK/home$n"; mkdir -p "$H/Desktop" "$H/Library/Mobile Documents/com~apple~CloudDocs"; }
A=VSCode-darwin-arm64-6852bb5
X=VSCode-darwin-x64-6852bb5

fresh; bundle "$H/Desktop/$A" 6e4ae6bf9c2395bd; bundle "$H/Desktop/$X" 6852bb5549b66f81
check "mislabeled bundle (named 6852bb5, really 6e4ae6b) is refused under --really" 1 "SKIP \(COMMIT MISMATCH" "$A" after-282fdcd-open-folder --really

fresh; bundle "$H/Desktop/$A" ''; bundle "$H/Desktop/$X" 6852bb5549b66f81
check "bundle with no product.json is refused under --really" 1 "SKIP \(no readable commit" "$A" after-282fdcd-open-folder --really

fresh; bundle "$H/Desktop/$X" 6852bb5549b66f81
check "missing bundle is a loud skip, not a silent pass" 1 "SKIP \(missing\)" "" after-282fdcd-open-folder --really

fresh; bundle "$H/Desktop/$A" 6852bb5549b66f81; bundle "$H/Desktop/$X" 6852bb5549b66f81
check "matching pair is deleted under --really" 0 "DELETED \(6852bb5" "" after-282fdcd-open-folder --really

fresh; bundle "$H/Desktop/$A" 6852bb5549b66f81; bundle "$H/Desktop/$X" 6852bb5549b66f81
check "dry run (no --really) deletes nothing" 0 "would delete \(6852bb5" "$A|$X" after-282fdcd-open-folder

fresh; icloud_app "$H" LiveCollab-x64-6852bb5.app 6e4ae6bf9c2395bd; touch "$H/Library/Mobile Documents/com~apple~CloudDocs/livecollab-x64-6852bb5-manifest.txt"
check "manifest is kept when its iCloud app does not verify" 1 "SKIP manifest too" "LiveCollab-x64-6852bb5.app|livecollab-x64-6852bb5-manifest.txt" imac-off-6852bb5 --really

fresh; icloud_app "$H" LiveCollab-x64-6852bb5.app 6852bb5549b66f81; touch "$H/Library/Mobile Documents/com~apple~CloudDocs/livecollab-x64-6852bb5-manifest.txt"
check "verified iCloud app and its manifest are deleted (path with spaces)" 0 "DELETED: .*manifest" "" imac-off-6852bb5 --really

fresh; bundle "$H/Desktop/$A" 6852bb5549b66f81
check "unknown stage deletes nothing" 2 "unknown stage" "$A" no-such-stage --really

fresh; bundle "$H/Desktop/VSCode-darwin-arm64-6e4ae6b" 6e4ae6bf9c2395bd; bundle "$H/Desktop/VSCode-darwin-x64-6e4ae6b" 6e4ae6bf9c2395bd; icloud_app "$H" LiveCollab-x64.app 6e4ae6bf9c2395bd
check "macbook-6e4ae6b deletes the Desktop pair and leaves the iCloud app" 0 "DELETED \(6e4ae6b" "LiveCollab-x64.app" macbook-6e4ae6b --really

fresh; bundle "$H/Desktop/VSCode-darwin-arm64-7823c61" 7823c61c4fc1096f; bundle "$H/Desktop/VSCode-darwin-x64-7823c61" f466a3e589d0d2ea
check "macbook-7823c61 refuses a mislabeled x64 (really f466a3e) and keeps it" 1 "SKIP \(COMMIT MISMATCH" "VSCode-darwin-x64-7823c61" macbook-7823c61 --really

fresh; bundle "$H/Desktop/VSCode-darwin-arm64-f466a3e" f466a3e589d0d2ea; bundle "$H/Desktop/VSCode-darwin-x64-f466a3e" f466a3e589d0d2ea; bundle "$H/Desktop/VSCode-darwin-arm64-42d0eb7" 42d0eb7a4dcc4536
check "macbook-f466a3e deletes its pair and leaves the newer 42d0eb7 bundle" 0 "DELETED \(f466a3e" "VSCode-darwin-arm64-42d0eb7" macbook-f466a3e --really

# redact-probe finds its bundle beside the repo the script lives in, not under
# HOME: run a copy inside a fake tree; what is left is listed from that tree.
P=VSCode-darwin-arm64-REDACTPROBE-DELETEME
probe() {  # probe <label> <expected exit> <pattern> <expected left> <commit in env> <bundle commit or -> <args...>
	n=$((n + 1)); label=$1; want_rc=$2; want_out=$3; want_left=$4; envc=$5; bc=$6; shift 6
	T="$WORK/tree$n"; mkdir -p "$T/repo/scripts/livecollab"; cp "$CLEANUP" "$T/repo/scripts/livecollab/cleanup-bundles.sh"
	[ "$bc" = - ] || bundle "$T/$P" "$bc"
	out=$(HOME="$T" REDACTPROBE_COMMIT="$envc" bash "$T/repo/scripts/livecollab/cleanup-bundles.sh" "$@" 2>&1); rc=$?
	left=$(ls -1 "$T" | grep -v -x repo | LC_ALL=C sort | tr '\n' '|' | sed 's/|$//')
	if [ $rc -eq 127 ]; then r="HARNESS ERROR"
	elif [ $rc -eq "$want_rc" ] && printf '%s\n' "$out" | grep -q -E "$want_out" && [ "$left" = "$want_left" ]; then r=OK
	else r=WRONG; fi
	[ "$r" = OK ] || bad=1
	echo "[$r] $n. $label (expected exit $want_rc, got $rc)"
	[ "$r" = OK ] || { echo "      expected left: $want_left"; echo "      actual left:   $left"; printf '%s\n' "$out" | sed 's/^/      /' | head -8; }
}
probe "redact-probe without REDACTPROBE_COMMIT deletes nothing" 2 "needs REDACTPROBE_COMMIT" "$P" "" 0123abcd4567ef89 redact-probe --really
probe "redact-probe refuses a commit shorter than 7 chars" 2 "needs REDACTPROBE_COMMIT" "$P" 0123ab 0123abcd4567ef89 redact-probe --really
probe "redact-probe refuses a bundle from another commit" 1 "SKIP \(COMMIT MISMATCH" "$P" 0123abc 9999abcd4567ef89 redact-probe --really
probe "redact-probe deletes the matching probe bundle under --really" 0 "DELETED \(0123abc" "" 0123abc 0123abcd4567ef89 redact-probe --really

[ $bad -eq 0 ] && echo "SELFTEST: all $n OK" || { echo "SELFTEST: FAILED — do not run cleanup-bundles.sh"; exit 1; }
