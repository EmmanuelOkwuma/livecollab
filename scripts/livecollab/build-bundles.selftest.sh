#!/usr/bin/env bash
# Self-test for build-bundles.sh: twenty-three known-answer cases that prove each build
# check can FAIL when it should and PASS when it should. Run it (about 1 min, no
# build) after changing build-bundles.sh, from the arm64 dev environment:
#
#   scripts/livecollab/build-bundles.selftest.sh
#
# Each case runs in a fresh bash that loads build-bundles.sh's functions
# (LIVECOLLAB_BUILD_LIB_ONLY=1), so it tests the exact code the build runs.
# A "fail" case only counts if it fails with the script's own "FAIL:" line;
# a missing function/command (exit 127) is a HARNESS ERROR, never a result.
# Exits non-zero unless all of them are OK.
set -uo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
BUILD="$HERE/build-bundles.sh"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/livecollab-selftest.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
PVR="$REPO/node_modules/@github/copilot/pvrecorder/node_modules/@picovoice/pvrecorder-node/lib/mac"
PW="$REPO/node_modules/@vscode/policy-watcher/build/Release/vscode-policy-watcher.node"
[ "$(lipo -archs "$PW" 2>/dev/null)" = arm64 ] || { echo "HARNESS: $PW must be arm64-only (run from the arm64 dev environment)"; exit 99; }
[ "$(lipo -archs "$PVR/x86_64/pv_recorder.node" 2>/dev/null)" = x86_64 ] && [ "$(lipo -archs "$PVR/arm64/pv_recorder.node" 2>/dev/null)" = arm64 ] || { echo "HARNESS: pv_recorder fixtures not as expected"; exit 99; }

# The 37 known upstream compile errors from a clean compile-build of 80caa20
# (ANSI stripped, machine path replaced by /repo/). Case 6 must accept these.
cat > "$WORK/known-errors.log" <<'FIXTURE'
Error: /repo/src/vs/workbench/contrib/terminalContrib/chatAgentTools/test/electron-browser/runInTerminalTool.test.ts(3031,10): '$ZUc' is declared but its value is never read.
Error: /repo/src/vs/workbench/contrib/terminalContrib/chatAgentTools/test/electron-browser/runInTerminalTool.test.ts(3031,12): Property 'ConfirmTerminalCommandTool' does not exist on type 'typeof import("/repo/src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/runInTerminalConfirmationTool", { with: { "resolution-mode": "import" } })'.
Error: /repo/src/vs/workbench/contrib/terminalContrib/chatAgentTools/test/electron-browser/runInTerminalTool.test.ts(3032,70): Cannot find name 'ConfirmTerminalCommandTool'.
Error: /repo/src/vs/workbench/contrib/terminalContrib/chatAgentTools/test/electron-browser/runInTerminalTool.test.ts(3052,10): '$ZUc' is declared but its value is never read.
Error: /repo/src/vs/workbench/contrib/terminalContrib/chatAgentTools/test/electron-browser/runInTerminalTool.test.ts(3052,12): Property 'ConfirmTerminalCommandTool' does not exist on type 'typeof import("/repo/src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/tools/runInTerminalConfirmationTool", { with: { "resolution-mode": "import" } })'.
Error: /repo/src/vs/workbench/contrib/terminalContrib/chatAgentTools/test/electron-browser/runInTerminalTool.test.ts(3053,70): Cannot find name 'ConfirmTerminalCommandTool'.
Error: /repo/src/vs/workbench/contrib/terminal/test/browser/terminalInstance.test.ts(226,30): Element implicitly has an 'any' type because expression of type '"_keybindingService"' can't be used to index type '$oUc'.
Error: /repo/src/vs/workbench/contrib/terminal/test/browser/terminalInstance.test.ts(251,30): Element implicitly has an 'any' type because expression of type '"_keybindingService"' can't be used to index type '$oUc'.
Error: /repo/src/vs/platform/agentHost/test/node/claudeAgent.test.ts(3688,19): Element implicitly has an 'any' type because expression of type '"_sessions"' can't be used to index type '$lgd'.
Error: /repo/src/vs/platform/windows/electron-main/windowImpl.ts(825,11): 'userId' is declared but its value is never read.
Error: /repo/src/vs/platform/windows/electron-main/windowImpl.ts(826,11): 'verifiedProvider' is declared but its value is never read.
Error: /repo/src/vs/platform/windows/electron-main/windowImpl.ts(827,11): 'verifiedSessionId' is declared but its value is never read.
Error: /repo/src/vs/platform/agentHost/node/agentHostServerMain.ts(275,47): Property 'ScriptedMockAgent' does not exist on type 'typeof import("/repo/src/vs/platform/agentHost/test/node/mockAgent", { with: { "resolution-mode": "import" } })'.
Error: /repo/src/vs/platform/agentHost/node/agentHostServerMain.ts(276,42): Cannot find name 'ScriptedMockAgent'.
Error: /repo/src/vs/workbench/api/common/extHostXaaAuthProvider.ts(92,11): Property 'c' in type 'XaaAuthenticationProvider' is not assignable to the same property in base type '$Vwd'.
Error: /repo/src/vs/workbench/api/common/extHostXaaAuthProvider.ts(92,11): This member must have an 'override' modifier because it overrides a member in the base class '$Vwd'.
Error: /repo/src/vs/workbench/api/common/extHostXaaAuthProvider.ts(104,11): Property 'trace' does not exist on type '(idToken: string, audience: string, resource: string, scopes: string[]) => Promise<string>'.
Error: /repo/src/vs/workbench/api/common/extHostXaaAuthProvider.ts(141,12): Property 'warn' does not exist on type '(idToken: string, audience: string, resource: string, scopes: string[]) => Promise<string>'.
Error: /repo/src/vs/workbench/api/common/extHostXaaAuthProvider.ts(149,11): Property 'trace' does not exist on type '(idToken: string, audience: string, resource: string, scopes: string[]) => Promise<string>'.
Error: /repo/src/vs/workbench/api/common/extHostXaaAuthProvider.ts(189,17): Property 'd' in type 'XaaAuthenticationProvider' is not assignable to the same property in base type '$Vwd'.
Error: /repo/src/vs/workbench/api/common/extHostXaaAuthProvider.ts(189,17): This member must have an 'override' modifier because it overrides a member in the base class '$Vwd'.
Error: /repo/src/vs/workbench/api/common/extHostXaaAuthProvider.ts(224,13): Property 'warn' does not exist on type '(idToken: string, audience: string, resource: string, scopes: string[]) => Promise<string>'.
Error: /repo/src/vs/workbench/api/common/extHostXaaAuthProvider.ts(249,13): Property 'info' does not exist on type '(idToken: string, audience: string, resource: string, scopes: string[]) => Promise<string>'.
Error: /repo/src/vs/workbench/api/common/extHostXaaAuthProvider.ts(252,13): Property 'info' does not exist on type '(idToken: string, audience: string, resource: string, scopes: string[]) => Promise<string>'.
Error: /repo/src/vs/workbench/api/common/extHostXaaAuthProvider.ts(283,17): Property 'f' in type 'XaaAuthenticationProvider' is not assignable to the same property in base type '$Vwd'.
Error: /repo/src/vs/workbench/api/common/extHostXaaAuthProvider.ts(283,17): This member must have an 'override' modifier because it overrides a member in the base class '$Vwd'.
Error: /repo/src/vs/workbench/api/common/extHostXaaAuthProvider.ts(289,17): Property 'g' in type 'XaaAuthenticationProvider' is not assignable to the same property in base type '$Vwd'.
Error: /repo/src/vs/workbench/api/common/extHostXaaAuthProvider.ts(289,17): This member must have an 'override' modifier because it overrides a member in the base class '$Vwd'.
Error: /repo/src/vs/workbench/api/common/extHostXaaAuthProvider.ts(290,11): Property 'trace' does not exist on type '(idToken: string, audience: string, resource: string, scopes: string[]) => Promise<string>'.
Error: /repo/src/vs/workbench/api/common/extHostXaaAuthProvider.ts(293,12): Property 'trace' does not exist on type '(idToken: string, audience: string, resource: string, scopes: string[]) => Promise<string>'.
Error: /repo/src/vs/workbench/api/common/extHostXaaAuthProvider.ts(296,11): Property 'trace' does not exist on type '(idToken: string, audience: string, resource: string, scopes: string[]) => Promise<string>'.
Error: /repo/src/vs/workbench/api/common/extHostXaaAuthProvider.ts(300,17): Property 'h' in type 'XaaAuthenticationProvider' is not assignable to the same property in base type '$Vwd'.
Error: /repo/src/vs/workbench/api/common/extHostXaaAuthProvider.ts(300,17): This member must have an 'override' modifier because it overrides a member in the base class '$Vwd'.
Error: /repo/src/vs/workbench/api/common/extHostXaaAuthProvider.ts(306,11): Property 'trace' does not exist on type '(idToken: string, audience: string, resource: string, scopes: string[]) => Promise<string>'.
Error: /repo/src/vs/workbench/api/common/extHostXaaAuthProvider.ts(336,17): Property 'j' in type 'XaaAuthenticationProvider' is not assignable to the same property in base type '$Vwd'.
Error: /repo/src/vs/workbench/api/common/extHostXaaAuthProvider.ts(336,17): This member must have an 'override' modifier because it overrides a member in the base class '$Vwd'.
Error: /repo/src/vs/workbench/api/common/extHostXaaAuthProvider.ts(338,11): Property 'trace' does not exist on type '(idToken: string, audience: string, resource: string, scopes: string[]) => Promise<string>'.
FIXTURE
[ "$(grep -c 'Error:' "$WORK/known-errors.log")" -eq 37 ] || { echo "HARNESS: fixture does not hold 37 errors"; exit 99; }

APP="Contents/Resources/app"

# check_redact_module fixtures: a working module, the same with its export
# names mangled (the @skipMangle opt-out did not fire), and one that does not
# redact. Built here, outside the per-case cleanup, so every case can use them.
R="out/vs/base/common/redactSecrets.js"
for k in good mangled noop; do mkdir -p "$WORK/redact-$k/LiveCollab.app/$APP/out/vs/base/common"; done
cat > "$WORK/redact-good/LiveCollab.app/$APP/$R" <<'JS'
export function redactSecretsInString(s) { return s.replace(/eyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]+){1,2}/g, '[redacted-jwt]').replace(/\b((?:sk|pk|rk)_(?:live|test)_)[A-Za-z0-9]+/g, '$1[redacted]'); }
export function redactSecrets(v) { if (typeof v === 'string') { return redactSecretsInString(v); } if (Array.isArray(v)) { return v.map(redactSecrets); } if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) { o[k] = redactSecrets(x); } return o; } return v; }
JS
sed -e 's/export function redactSecretsInString(/export function Ra(/' -e 's/export function redactSecrets(/export function Rb(/' \
	"$WORK/redact-good/LiveCollab.app/$APP/$R" > "$WORK/redact-mangled/LiveCollab.app/$APP/$R"
printf '%s\n' 'export function redactSecretsInString(s) { return s; }' 'export function redactSecrets(v) { return v; }' > "$WORK/redact-noop/LiveCollab.app/$APP/$R"
grep -q 'export function Ra(' "$WORK/redact-mangled/LiveCollab.app/$APP/$R" || { echo "HARNESS: mangled fixture did not land"; exit 99; }

# Signing fixtures: a minimal bundle (Info.plist, a cc-built main binary,
# product.json and one symlink). As cc leaves it, the binary carries only the
# linker's ad-hoc signature — the exact 52ce3b7 arm64 state; with that removed
# it is the 52ce3b7 x64 state. Cases copy one to $WORK/b before changing it.
FXC=0123456789abcdef0123456789abcdef01234567
echo 'int main(void) { return 0; }' > "$WORK/main.c"
cc -o "$WORK/main" "$WORK/main.c" || { echo "HARNESS: cc failed"; exit 99; }
for k in linker nosig; do
	f="$WORK/fx-$k/LiveCollab.app/Contents"
	mkdir -p "$f/MacOS" "$WORK/fx-$k/LiveCollab.app/$APP"
	cp "$WORK/main" "$f/MacOS/LiveCollab"
	printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
		'<plist version="1.0"><dict><key>CFBundleExecutable</key><string>LiveCollab</string><key>CFBundleIdentifier</key><string>dev.livecollab.selftest</string></dict></plist>' > "$f/Info.plist"
	echo "{ \"commit\": \"$FXC\" }" > "$WORK/fx-$k/LiveCollab.app/$APP/product.json"
	ln -s product.json "$WORK/fx-$k/LiveCollab.app/$APP/product-link.json"
done
codesign --remove-signature "$WORK/fx-nosig/LiveCollab.app/Contents/MacOS/LiveCollab" || { echo "HARNESS: could not strip the fixture signature"; exit 99; }
[[ "$(codesign -dv "$WORK/fx-linker/LiveCollab.app/Contents/MacOS/LiveCollab" 2>&1)" == *linker-signed* ]] || { echo "HARNESS: fixture binary is not linker-signed"; exit 99; }

declare -a EXPECT LABEL BODY
add() { EXPECT+=("$1"); LABEL+=("$2"); BODY+=("$3"); }
add pass "dev node_modules is arm64 (preflight check accepts a good tree; 3 named multi-arch files skipped)" \
	'check_native_tree "$REPO/node_modules" arm64'
add fail "an arm64-only module in an x64 bundle is caught (the sharp bug)" \
	'm="$WORK/app/$APP/extensions/x/node_modules/@img/sharp-darwin-arm64/lib"; mkdir -p "$m"; cp "$PW" "$m/sharp.node"; check_native_tree "$WORK/app" x86_64'
add pass "remove_extension removes a present extension" \
	'mkdir -p "$WORK/b/LiveCollab.app/$APP/extensions/copilot"; remove_extension "$WORK/b" copilot'
add fail "remove_extension FAILS when the folder is missing (the renamed-folder bug)" \
	'mkdir -p "$WORK/b/LiveCollab.app/$APP/extensions"; remove_extension "$WORK/b" copilot'
add fail "a bundle still containing copilot fails the absence assertion" \
	'mkdir -p "$WORK/b/LiveCollab.app/$APP/extensions/copilot"; assert_extensions_absent "$WORK/b/LiveCollab.app"'
add pass "compile gate accepts the 37 known upstream errors" \
	'check_compile_log "$WORK/known-errors.log"'
add fail "compile gate rejects one new error in our code" \
	'{ cat "$WORK/known-errors.log"; echo "Error: /repo/src/vs/workbench/contrib/livecollab/browser/livecollabService.ts(1,1): injected"; } > "$WORK/bad.log"; [ "$(grep -c Error: "$WORK/bad.log")" -eq 38 ] || { echo "HARNESS: injection did not land"; exit 99; }; check_compile_log "$WORK/bad.log"'
add fail "a named multi-arch file with its target-arch sibling MISSING fails" \
	'p="$WORK/nm/@github/copilot/pvrecorder/node_modules/@picovoice/pvrecorder-node/lib/mac"; mkdir -p "$p/x86_64"; cp "$PVR/x86_64/pv_recorder.node" "$p/x86_64/"; check_native_tree "$WORK/nm" arm64'
add pass "a named multi-arch file with its sibling present is skipped" \
	'p="$WORK/nm/@github/copilot/pvrecorder/node_modules/@picovoice/pvrecorder-node/lib/mac"; mkdir -p "$p/x86_64" "$p/arm64"; cp "$PVR/x86_64/pv_recorder.node" "$p/x86_64/"; cp "$PVR/arm64/pv_recorder.node" "$p/arm64/"; check_native_tree "$WORK/nm" arm64'
add pass "a shipped redactSecrets.js with intact exports that redacts passes" \
	'check_redact_module "$WORK/redact-good/LiveCollab.app"'
add fail "mangled export names are caught (the @skipMangle opt-out did not fire)" \
	'check_redact_module "$WORK/redact-mangled/LiveCollab.app"'
add fail "a redactSecrets.js that does not redact is caught" \
	'check_redact_module "$WORK/redact-noop/LiveCollab.app"'
add fail "a bundle without redactSecrets.js fails (missing from the build lists)" \
	'mkdir -p "$WORK/b/LiveCollab.app/$APP/out"; check_redact_module "$WORK/b/LiveCollab.app"'
add pass "sign_bundle signs a whole bundle and it verifies --deep --strict" \
	'ditto "$WORK/fx-linker" "$WORK/b"; sign_bundle "$WORK/b/LiveCollab.app"'
add fail "a bundle whose main binary has only the linker's signature fails (52ce3b7 arm64)" \
	'check_signature "$WORK/fx-linker/LiveCollab.app"'
add fail "an unsigned bundle fails (52ce3b7 x64)" \
	'check_signature "$WORK/fx-nosig/LiveCollab.app"'
add fail "a bundle changed after signing fails" \
	'ditto "$WORK/fx-linker" "$WORK/b"; codesign --force --deep --sign - "$WORK/b/LiveCollab.app" || exit 99; echo x >> "$WORK/b/LiveCollab.app/$APP/product.json"; check_signature "$WORK/b/LiveCollab.app"'
add pass "a zip of a signed bundle survives the ditto round trip (signature, commit, symlinks)" \
	'ditto "$WORK/fx-linker" "$WORK/b"; sign_bundle "$WORK/b/LiveCollab.app" && make_zip "$WORK/b/LiveCollab.app" "$WORK/b/t.zip" && check_zip "$WORK/b/t.zip" "$WORK/b/LiveCollab.app" "$FXC"'
add fail "a zip of a bundle changed after signing is caught on the extracted copy" \
	'ditto "$WORK/fx-linker" "$WORK/b"; sign_bundle "$WORK/b/LiveCollab.app" || exit 99; echo x >> "$WORK/b/LiveCollab.app/$APP/product.json"; ditto -c -k --sequesterRsrc --keepParent "$WORK/b/LiveCollab.app" "$WORK/b/t.zip"; check_zip "$WORK/b/t.zip" "$WORK/b/LiveCollab.app" "$FXC"'
add pass "zip names: friendly for release, <arch> for dev, flavour in all four" \
	'got="$(zip_name arm64 abc1234 release) $(zip_name x64 abc1234 release) $(zip_name arm64 abc1234 dev) $(zip_name x64 abc1234 dev)"; want="LiveCollab-AppleSilicon-abc1234-release.zip LiveCollab-Intel-abc1234-release.zip LiveCollab-arm64-abc1234-dev.zip LiveCollab-x64-abc1234-dev.zip"; echo "$got"; [ "$got" = "$want" ]'

add pass "a verified build's unpacked folder is deleted, its zip kept, and the space counted" \
	'd="$WORK/b/VSCode-darwin-arm64-abc1234-release"; mkdir -p "$WORK/b"; ditto "$WORK/fx-linker" "$d"; echo z > "$WORK/b/t.zip"; delete_unpacked "$d" "$WORK/b/t.zip" "$FXC" && [ ! -e "$d" ] && [ -s "$WORK/b/t.zip" ] && [ "$FREED_KB" -gt 0 ]'
add fail "an unpacked folder whose product.json holds another commit is kept" \
	'd="$WORK/b/VSCode-darwin-arm64-abc1234-release"; mkdir -p "$WORK/b"; ditto "$WORK/fx-linker" "$d"; echo z > "$WORK/b/t.zip"; delete_unpacked "$d" "$WORK/b/t.zip" "${FXC%?}0"; rc=$?; [ -d "$d" ] || { echo "HARNESS: folder deleted on a mismatch"; exit 99; }; exit $rc'
add fail "an unpacked folder whose zip is missing is kept" \
	'd="$WORK/b/VSCode-darwin-arm64-abc1234-release"; mkdir -p "$WORK/b"; ditto "$WORK/fx-linker" "$d"; delete_unpacked "$d" "$WORK/b/t.zip" "$FXC"; rc=$?; [ -d "$d" ] || { echo "HARNESS: folder deleted with no zip"; exit 99; }; exit $rc'

bad=0
for i in "${!BODY[@]}"; do
	n=$((i+1)); rm -rf "$WORK/app" "$WORK/b" "$WORK/nm"
	out=$(REPO="$REPO" WORK="$WORK" APP="$APP" PW="$PW" PVR="$PVR" FXC="$FXC" bash -c "
		export LIVECOLLAB_BUILD_LIB_ONLY=1; source '$BUILD'
		for fn in die named_path check_native_tree check_compile_log remove_extension assert_extensions_absent check_redact_module verify_bundle sign_bundle check_signature zip_name make_zip check_zip delete_unpacked; do type \"\$fn\" >/dev/null 2>&1 || { echo \"HARNESS: \$fn not defined\"; exit 99; }; done
		${BODY[$i]}" 2>&1); rc=$?
	if [ $rc -eq 99 ] || [ $rc -eq 127 ]; then r="HARNESS ERROR"
	elif [ "${EXPECT[$i]}" = pass ] && [ $rc -eq 0 ]; then r=OK
	elif [ "${EXPECT[$i]}" = fail ] && [ $rc -ne 0 ] && printf '%s\n' "$out" | grep -q '^ *FAIL'; then r=OK
	else r="WRONG"; fi
	[ "$r" = OK ] || bad=1
	echo "[$r] $n. ${LABEL[$i]} (expected ${EXPECT[$i]}, exit $rc)"
	printf '%s\n' "$out" | grep -E 'FAIL|HARNESS|skipped|checked|removed|absent|compile errors|round trip|deleted|refusing|LiveCollab-|valid on disk|no resources|not signed|sealed resource' | sed 's/^/      /' | cut -c1-200 | head -6
done
[ $bad -eq 0 ] && echo "SELFTEST: all ${#BODY[@]} OK" || { echo "SELFTEST: FAILED — do not build"; exit 1; }
