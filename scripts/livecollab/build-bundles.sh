#!/usr/bin/env bash
# Build LiveCollab for macOS: arm64 (this machine) then x64 (cross-compiled for
# the iMac), then restore the arm64 dev node_modules.
#
#   LIVECOLLAB_BUILD_FLAVOR=release scripts/livecollab/build-bundles.sh   full build (~25 min)
#   LIVECOLLAB_BUILD_FLAVOR=dev     scripts/livecollab/build-bundles.sh
#        Every build is a 'release' (testers; DevTools off) or a 'dev' build
#        (our two machines; DevTools on). Required — there is no default.
#        product.json carries it as "livecollabBuildFlavor"; the folder name
#        ends in -release / -dev and the build fails if the two disagree. A
#        bundle name with no suffix predates flavours.
#   scripts/livecollab/build-bundles.selftest.sh   re-run the checks' self-test first
#   LIVECOLLAB_REDACT_PROBE=1 LIVECOLLAB_BUILD_FLAVOR=dev scripts/livecollab/build-bundles.sh
#        arm64 only, into ../VSCode-darwin-arm64-REDACTPROBE-DELETEME — a
#        throwaway build of a probe commit; never deployed, never in a test run.
#        Delete it with cleanup-bundles.sh redact-probe.
#
# Output, next to the repo: the zip that gets downloaded (zip_name below):
#   release  ../LiveCollab-AppleSilicon-<commit>-release.zip, ../LiveCollab-Intel-<commit>-release.zip
#   dev      ../LiveCollab-arm64-<commit>-dev.zip, ../LiveCollab-x64-<commit>-dev.zip
# built from ../VSCode-darwin-<arch>-<short commit>-<flavour>/LiveCollab.app, ad-hoc
# signed as a whole. Those folders are deleted once every check has passed
# (delete_unpacked); a failed build leaves them for diagnosis.
# (The redact probe is signed but not zipped, and its folder is kept.)
# Every check below is FATAL. A step that cannot report failure is a bug — see
# HANDOFF_2026-09-16.md, "BUILD RULES (2026-09-27)", for what each check guards.
set -Eeo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PARENT=$(dirname "$REPO")
LOGDIR=${LIVECOLLAB_BUILD_LOGDIR:-$HOME/Library/Logs/livecollab-build}   # outside the repo on purpose
# Strings unique to our commits; minification keeps string literals, so their
# presence in the minified workbench proves our code is in the bundle.
MARK1='room session changed during doc load'      # 43daf31 room teardown
MARK2='not shared with the room (links and files that look like secrets)'   # def8ab26453 row 27 (was the fc4c0f1 secret-rule log line, removed by row 27)
# RULE: deliberately NOT shipped in LiveCollab builds, either architecture.
# The build fails if any is missing before removal or present after.
# 2026-10-22: with the extension host alive, everything bundled runs — so the
# GitHub sign-in / publish / clone-from-GitHub entry points (github,
# github-authentication), Microsoft dev-tunnel port forwarding
# (tunnel-forwarding), notebooks with no kernels (ipynb, notebook-renderers)
# and the in-editor browser (simple-browser) are not shipped. git and git-base
# stay (STATUS: removing Source Control would not close the divergence hole).
REMOVED_EXTENSIONS=(copilot microsoft-authentication github github-authentication tunnel-forwarding ipynb notebook-renderers simple-browser)
# RULE: built-in extensions are compiled from THIS checkout on every build.
# Packaging (the -min-ci tasks) copies them from .build/extensions, which was
# never rebuilt: from 2026-09-24 to 2026-10-23 every build shipped extensions
# compiled on 2026-09-24. Each entry is "<extension>|<file in it>|<string>": a
# string from our own extension source that must appear in .build/extensions
# right after compiling and in every packaged bundle, or the build fails.
EXTENSION_MARKS=(
	'typescript-language-features|dist/extension.js|livecollab'  # 6da36d812b9 guest semantic scheme
)
# The only files allowed to carry compile errors (known upstream noise). An
# error in ANY other file fails the build — keyed on files, not a count.
KNOWN_ERROR_FILES='src/vs/workbench/api/common/extHostXaaAuthProvider\.ts|src/vs/workbench/contrib/terminalContrib/chatAgentTools/test/electron-browser/runInTerminalTool\.test\.ts|src/vs/platform/windows/electron-main/windowImpl\.ts|src/vs/workbench/contrib/terminal/test/browser/terminalInstance\.test\.ts|src/vs/platform/agentHost/node/agentHostServerMain\.ts|src/vs/platform/agentHost/test/node/claudeAgent\.test\.ts'
# Named multi-arch files (vendored inside node_modules/@github/copilot): each
# ships one binary per mac arch in folders the generic rule cannot recognise.
# Named EXACTLY (paths relative to the checked dir; __M__ = arm64|x86_64,
# __D__ = arm64|x64), and skipped ONLY if the sibling for the target arch is
# present — otherwise it fails. Verified 2026-09-27: both siblings exist.
NAMED_MULTIARCH=(
	'@github/copilot/pvrecorder/node_modules/@picovoice/pvrecorder-node/lib/mac/__M__/pv_recorder.node'
	'@github/copilot/clipboard/node_modules/@teddyzhu/clipboard-darwin-__D__/clipboard.darwin-__D__.node'
	'@github/copilot/clipboard/node_modules/@teddyzhu/clipboard/clipboard.darwin-__D__.node'
)
STAGE="(start)"
NM_STATE="arm64"
# Capture the failing status FIRST (any command, even echo, resets $?), report,
# then exit with it. set -E makes this fire inside functions too.
trap 'rc=$?; echo; echo "!!!!! BUILD STOPPED — step failed: $STAGE (exit $rc)"; echo "!!!!! node_modules arch state: $NM_STATE"; case "$NM_STATE" in x64*) echo "!!!!! node_modules is x64 — restore with: cd $REPO && npm_config_arch=arm64 npm_config_cpu=arm64 npm ci";; esac; exit $rc' ERR

step() { STAGE="$1"; echo; echo "===== [$(date +%H:%M:%S)] $1 ====="; }
die() { echo "FAIL: $*"; return 1; }
named_path() { local t=$1 m=$2 d; [ "$m" = x86_64 ] && d=x64 || d=arm64; t=${t//__M__/$m}; echo "${t//__D__/$d}"; }

# Every darwin Mach-O .node under $1 must contain arch $2 (arm64|x86_64).
# Allowed exceptions, each listed as "skipped", never silent:
#  - a binary in a folder explicitly named for the OTHER mac arch
#    (x64-darwin/, prebuilds/darwin-arm64/ ...): a per-platform prebuild;
#  - one of NAMED_MULTIARCH, only when its target-arch sibling exists.
# Anything else lacking the arch is fatal. Checking zero modules is fatal too.
check_native_tree() {
	local dir=$1 arch=$2 other otherarch rel t bad=0 n=0
	[ "$arch" = "x86_64" ] && other='(^|/)(arm64-darwin|darwin-arm64)/' || other='(^|/)(x64-darwin|darwin-x64|x86_64-darwin|darwin-x86_64)/'
	[ "$arch" = "x86_64" ] && otherarch=arm64 || otherarch=x86_64
	echo "--- native .node modules under ${dir##*/} not containing $arch:"
	while read -r f; do
		file "$f" | grep -q 'Mach-O' || continue
		n=$((n+1))
		if lipo -archs "$f" 2>/dev/null | grep -qw "$arch"; then continue; fi
		rel=${f#$dir/}
		for t in "${NAMED_MULTIARCH[@]}"; do
			if [ "$rel" = "$(named_path "$t" "$otherarch")" ]; then
				if [ -f "$dir/$(named_path "$t" "$arch")" ]; then echo "  skipped (named multi-arch file, $arch sibling present): $rel"; continue 2; fi
				echo "  FAIL: $rel: named multi-arch file but its $arch sibling is MISSING"; bad=1; continue 2
			fi
		done
		if echo "$f" | grep -Eq "$other"; then echo "  skipped (per-platform folder for the other arch): $rel"; continue; fi
		echo "  FAIL: $rel: $(lipo -archs "$f" 2>&1)"; bad=1
	done < <(find "$dir" -name '*.node' -type f)
	echo "(checked $n Mach-O modules, bad=$bad)"
	[ $n -gt 0 ] || die "no Mach-O .node modules found under $dir — check is not looking at anything"
	[ $bad -eq 0 ] || die "wrong-arch native modules under $dir"
}

# Compile gate: compile-build exits 0 even with type errors, so the log is the
# only signal. Strip ANSI colour (raw, 'Error:' is split by colour codes and
# counts 0), require a non-empty log, and fail on ANY error outside the known
# upstream files.
check_compile_log() {
	local log=$1 clean total unknown
	clean=$(sed 's/\x1b\[[0-9;]*m//g' "$log")
	[ -n "$clean" ] || die "compile log $log is empty — gate is not looking at anything"
	total=$(printf '%s\n' "$clean" | grep -c 'Error:' || true)
	unknown=$(printf '%s\n' "$clean" | grep 'Error:' | grep -Ev "$KNOWN_ERROR_FILES" || true)
	if [ -n "$unknown" ]; then echo "$unknown"; die "compile errors outside the known upstream files (above)"; fi
	echo "compile errors: $total, all in the known upstream files"
}

# Remove a bundled extension. Fails if it is not there to remove (a renamed
# folder must never be silently skipped again) and if it is still there after.
remove_extension() {
	local bundle=$1 name=$2 ext
	ext="$bundle/LiveCollab.app/Contents/Resources/app/extensions/$name"
	[ -d "$ext" ] || die "extension '$name' not found at $ext — renamed or moved? refusing to skip removal"
	rm -rf "$ext"
	[ ! -e "$ext" ] || die "extension '$name' still present after removal: $ext"
	echo "removed extension: $name"
}

assert_extension_marks() {  # $1 = extensions dir (.build/extensions or the bundle's)
	local entry ext file mark
	for entry in "${EXTENSION_MARKS[@]}"; do
		IFS='|' read -r ext file mark <<< "$entry"
		[ -f "$1/$ext/$file" ] || die "extension file missing: $1/$ext/$file"
		grep -q -F "$mark" "$1/$ext/$file" || die "'$mark' missing from $1/$ext/$file — stale built-in extension?"
		echo "present: '$mark' in $ext/$file"
	done
}

assert_extensions_absent() {  # $1 = LiveCollab.app
	local name
	for name in "${REMOVED_EXTENSIONS[@]}"; do
		[ ! -e "$1/Contents/Resources/app/extensions/$name" ] || die "extension '$name' present in bundle"
		echo "absent: $name"
	done
}

# The dashboard pages import vs/base/common/redactSecrets.js by name — the
# only first-party module imported from HTML (it scrubs everything Sentry
# sends). Prove it shipped as its own file, that the mangler left both export
# names alone (@skipMangle), and that it actually redacts known answers.
# This does NOT prove Sentry calls it — that needs a breadcrumb read back
# from sentry.io (HANDOFF, credentials-in-logs).
check_redact_module() {  # $1 = LiveCollab.app
	local f="$1/Contents/Resources/app/out/vs/base/common/redactSecrets.js" out
	[ -f "$f" ] || die "missing $f (not shipped as its own file — check the build lists)" || return 1
	out=$(node --input-type=module -e '
const m = await import(process.argv[1]);
if (typeof m.redactSecrets !== "function" || typeof m.redactSecretsInString !== "function") { console.log("export names missing (mangled?): " + Object.keys(m).join(",")); process.exit(1); }
const jwt = "eyJ" + "aaaaaaaa.bbbbbbbb.cccc";
const got = m.redactSecretsInString("a " + jwt + " b");
if (got !== "a [redacted-jwt] b") { console.log("known-answer redaction wrong: " + got); process.exit(1); }
const deep = m.redactSecrets({ x: ["k=" + "sk" + "_test_" + "ABCDEFGH123"] });
if (deep.x[0] !== "k=sk_test_[redacted]") { console.log("known-answer deep redaction wrong: " + JSON.stringify(deep)); process.exit(1); }
console.log("ok");
' "file://$f" 2>&1) || die "redactSecrets.js: $out" || return 1
	echo "redactSecrets.js: shipped, exports intact, known answers redacted ($out)"
}

verify_bundle() {  # $1 = arm64|x64, $2 = bundle dir, $3 = expected full commit, $4 = release|dev
	local want=$1 dir=$2 commit=$3 flavor=$4 lipoarch app c f wb
	[ "$want" = "x64" ] && lipoarch=x86_64 || lipoarch=arm64
	app="$dir/LiveCollab.app"
	[ -d "$app" ] || die "no $app"
	echo "--- main binary(s):"
	for b in "$app"/Contents/MacOS/*; do lipo -info "$b"; lipo -archs "$b" | grep -qx "$lipoarch" || die "wrong arch: $b"; done
	echo "--- product.json \"commit\" field:"
	c=$(grep -o '"commit": *"[0-9a-f]*"' "$app/Contents/Resources/app/product.json" | grep -o '[0-9a-f]\{40\}')
	echo "$c"; [ "$c" = "$commit" ] || die "commit mismatch (want $commit)"
	echo "--- product.json \"livecollabBuildFlavor\" field, and the folder name:"
	f=$(grep -o '"livecollabBuildFlavor": *"[a-z]*"' "$app/Contents/Resources/app/product.json" | grep -o '"[a-z]*"$' | tr -d '"')
	echo "$f ($(basename "$dir"))"; [ "$f" = "$flavor" ] || die "flavour mismatch: product.json says '$f', want '$flavor'"
	case "$(basename "$dir")" in *-REDACTPROBE-DELETEME|*-"$flavor") ;; *) die "folder $(basename "$dir") does not end in -$flavor" ;; esac
	echo "--- our code in the minified workbench:"
	wb="$app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js"
	[ -f "$wb" ] || die "missing $wb"
	echo "'$MARK1': $(grep -c -F "$MARK1" "$wb" || true)"; grep -q -F "$MARK1" "$wb" || die "MARK1 missing"
	echo "'$MARK2': $(grep -c -F "$MARK2" "$wb" || true)"; grep -q -F "$MARK2" "$wb" || die "MARK2 missing"
	echo "--- Sentry redaction module (imported by the dashboard HTML):"
	check_redact_module "$app"
	echo "--- deliberately removed extensions must be absent:"
	assert_extensions_absent "$app"
	echo "--- built-in extensions compiled from this checkout:"
	assert_extension_marks "$app/Contents/Resources/app/extensions"
	echo "--- no OS URL scheme registered (2026-10-24: livecollab:// links never open the app):"
	! plutil -extract CFBundleURLTypes raw -o - "$app/Contents/Info.plist" >/dev/null 2>&1 || die "Info.plist registers a URL scheme (CFBundleURLTypes)"
	echo "absent: CFBundleURLTypes"
	check_native_tree "$app" "$lipoarch"
	echo "--- whole-bundle signature:"
	check_signature "$app"
}

# A downloaded copy is quarantined, and Gatekeeper rejects a bundle whose
# signature does not cover its contents: 52ce3b7 arm64 carried only the
# linker's ad-hoc signature on the main binary ("code has no resources but
# signature indicates they must be present"), x64 no signature at all. Ad-hoc
# sign the WHOLE bundle (free, no Apple account) and prove it with the check
# that caught it. Ad-hoc is not Developer ID: macOS still can't verify the
# developer, so a tester needs Privacy & Security → Open Anyway — but the app
# can be opened at all. Sign LAST: any change to the bundle afterwards breaks it.
sign_bundle() {  # $1 = LiveCollab.app
	xattr -cr "$1"   # Finder info / resource forks make codesign refuse the bundle
	codesign --force --deep --sign - "$1" 2>&1 || die "codesign failed on $1" || return 1
	check_signature "$1"
}

check_signature() {  # $1 = LiveCollab.app
	local out
	out=$(codesign --verify --deep --strict --verbose=2 "$1" 2>&1) || { echo "$out"; die "signature does not verify: $1"; return 1; }
	printf '%s\n' "$out" | tail -2   # the rest lists every nested item it validated
	out=$(codesign -dv "$1" 2>&1)
	printf '%s\n' "$out" | grep -E '^(Signature|Sealed Resources)' || true
	printf '%s\n' "$out" | grep -q '^Sealed Resources version=' || die "bundle signature seals no resources: $1" || return 1
}

# Release zips carry friendly names for testers (they pick by chip name); dev
# zips never leave our two Macs and keep the older <arch> pattern. The flavour
# stays in both, so a release and a dev zip of one commit never collide.
zip_name() {  # $1 = arm64|x64, $2 = short commit, $3 = release|dev
	local a=$1
	if [ "$3" = release ]; then
		if [ "$1" = arm64 ]; then a=AppleSilicon; else a=Intel; fi
	fi
	echo "LiveCollab-$a-$2-$3.zip"
}

make_zip() {  # $1 = LiveCollab.app, $2 = zip path
	[ ! -e "$2" ] || die "$2 already exists" || return 1
	ditto -c -k --sequesterRsrc --keepParent "$1" "$2" || die "ditto could not create $2" || return 1
	shasum -a 256 "$2"
}

# The zip is what a tester downloads, so prove the zip, not the folder: extract
# it with ditto and re-check the signature, the commit and the symlinks (a
# copy that loses symlinks breaks the app) on the extracted copy.
check_zip() {  # $1 = zip, $2 = source LiveCollab.app, $3 = expected full commit
	local zip=$1 src=$2 commit=$3 tmp msg='' c n1 n2
	[ -s "$zip" ] || die "zip missing or empty: $zip" || return 1
	tmp=$(mktemp -d "${TMPDIR:-/tmp}/zipcheck.XXXXXX")
	if ! ditto -x -k "$zip" "$tmp"; then msg="ditto could not extract $zip"
	elif [ ! -d "$tmp/LiveCollab.app" ]; then msg="$zip does not hold LiveCollab.app at its top level"
	elif ! check_signature "$tmp/LiveCollab.app"; then msg="the copy extracted from $zip does not verify"
	else
		c=$(grep -o '"commit": *"[0-9a-f]*"' "$tmp/LiveCollab.app/Contents/Resources/app/product.json" | grep -o '[0-9a-f]\{40\}' || true)
		n1=$(find "$src" -type l | wc -l | tr -d ' ')
		n2=$(find "$tmp/LiveCollab.app" -type l | wc -l | tr -d ' ')
		if [ "$c" != "$commit" ]; then msg="extracted commit '$c' != $commit"
		elif [ "$n1" -eq 0 ]; then msg="no symlinks in $src — check is not looking at anything"
		elif [ "$n1" != "$n2" ]; then msg="symlinks: $n1 in the bundle, $n2 in the extracted copy"
		else echo "zip round trip: signature verifies, commit $c, $n2 symlinks"
		fi
	fi
	rm -rf "${tmp:?}"
	[ -z "$msg" ] || die "$msg" || return 1
}

# RULE (2026-10-24): a finished build keeps only its two zips. The unpacked
# VSCode-darwin-<arch>-<commit>-<flavour> folders are ~1.1 GB each and piled
# up (20 of them, 22 GB) — and the zip, already proven by check_zip, is the
# copy that gets installed. Called only after every check has passed; a failed
# build stops before this, so its folders stay for diagnosis. Re-reads the
# commit from the folder's own product.json first: a mismatch keeps the folder.
FREED_KB=0
delete_unpacked() {  # $1 = bundle dir, $2 = its verified zip, $3 = expected full commit
	local dir=$1 zip=$2 commit=$3 c kb
	case "$(basename "$dir")" in VSCode-darwin-*-*) ;; *) die "refusing to delete $dir: not a VSCode-darwin-<arch>-<tag> folder" || return 1 ;; esac
	[ -s "$zip" ] || die "refusing to delete $dir: its zip $zip is missing or empty" || return 1
	c=$(grep -o '"commit": *"[0-9a-f]*"' "$dir/LiveCollab.app/Contents/Resources/app/product.json" 2>/dev/null | grep -o '[0-9a-f]\{40\}' || true)
	[ "$c" = "$commit" ] || die "refusing to delete $dir: product.json commit '$c' != $commit" || return 1
	kb=$(du -sk "$dir" | cut -f1)
	rm -rf "${dir:?}"
	[ ! -e "$dir" ] || die "$dir still present after delete" || return 1
	FREED_KB=$((FREED_KB + kb))
	echo "deleted $dir ($((kb / 1024)) MB, commit $c) — kept $(basename "$zip")"
}

# Build TOOLS run on this machine and must be host-arch (arm64); only what SHIPS
# must be target-arch. npm_config_cpu=x64 swaps both, and tsgo's launcher
# resolves @typescript/native-preview-<platform>-<process.arch> — arm64 here —
# so after the x64 install it cannot find itself ("Unable to resolve ...").
# (esbuild's launcher tolerates the x64 binary via Rosetta; tsgo's does not.)
# Put the host package back beside the x64 one: the lockfile's exact version,
# verified against the lockfile's integrity hash, unpacked in place. Not
# `npm install`, which re-resolves the whole tree and could undo the x64 swap.
add_host_tsgo() {
	local pkg=@typescript/native-preview-darwin-arm64 dest lockver lockint parentver tmp tgz got
	dest="$REPO/node_modules/$pkg"
	lockver=$(node -p "require('$REPO/package-lock.json').packages['node_modules/$pkg'].version")
	lockint=$(node -p "require('$REPO/package-lock.json').packages['node_modules/$pkg'].integrity")
	parentver=$(node -p "require('$REPO/node_modules/@typescript/native-preview/package.json').version")
	[ -n "$lockver" ] && [ "$lockver" != undefined ] && [ -n "$lockint" ] && [ "$lockint" != undefined ] || die "no lockfile pin for $pkg"
	[ "$lockver" = "$parentver" ] || die "$pkg lockfile version $lockver != installed native-preview $parentver"
	[ ! -e "$dest" ] || die "$dest already present — unexpected after an x64 install"
	tmp=$(mktemp -d "${TMPDIR:-/tmp}/host-tsgo.XXXXXX")
	tgz=$(cd "$tmp" && npm pack "$pkg@$lockver" --silent)
	got="sha512-$(openssl dgst -sha512 -binary "$tmp/$tgz" | base64 | tr -d '\n')"
	[ "$got" = "$lockint" ] || { rm -rf "$tmp"; die "$pkg@$lockver integrity mismatch: got $got, lockfile $lockint"; }
	mkdir -p "$dest"; tar -xzf "$tmp/$tgz" -C "$dest" --strip-components=1; rm -rf "$tmp"
	[ "$(lipo -archs "$dest/lib/tsgo")" = arm64 ] || die "$dest/lib/tsgo is not arm64"
	got=$("$REPO/node_modules/.bin/tsgo" --version) || die "tsgo still cannot start through its launcher"
	[ "$got" = "Version $lockver" ] || die "tsgo reports '$got', expected 'Version $lockver'"
	echo "host toolchain: $pkg@$lockver added (integrity matches lockfile), tsgo runs: $got"
}

# The self-test loads the functions above without running the build.
if [ -n "${LIVECOLLAB_BUILD_LIB_ONLY:-}" ]; then trap - ERR; return 0 2>/dev/null || exit 0; fi

EXPECT_COMMIT_FULL=$(git -C "$REPO" rev-parse HEAD)
SHORT=$(git -C "$REPO" rev-parse --short=7 HEAD)
PROBE=${LIVECOLLAB_REDACT_PROBE:-}
FLAVOR=${LIVECOLLAB_BUILD_FLAVOR:-}
case "$FLAVOR" in release|dev) ;; *) die "set LIVECOLLAB_BUILD_FLAVOR=release or =dev (got '$FLAVOR')" ;; esac
export LIVECOLLAB_BUILD_FLAVOR="$FLAVOR"  # read by the packaging step (build/gulpfile.vscode.ts)
TAG="$SHORT-$FLAVOR"
if [ -n "$PROBE" ]; then TAG=REDACTPROBE-DELETEME; fi
mkdir -p "$LOGDIR"
# Keep the Mac awake for the whole build: an idle sleep pauses the compile, and
# on 2026-09-30 turned a 25-minute build into 6.5 hours. caffeinate is tied to
# this script's PID (-w $$) and exits by itself when the build ends, pass or
# fail. NOT fully solved: closing the lid on battery still sleeps the machine
# no matter what — keep the lid open, or plug in, until the build finishes.
caffeinate -dims -w $$ &
sleep 1; kill -0 $! 2>/dev/null || die "caffeinate did not start — the Mac may sleep mid-build"
echo "caffeinate (pid $!) keeping the Mac awake until this build exits — lid-close on battery still sleeps it"
cd "$REPO"

step "preflight"
source "$HOME/.nvm/nvm.sh"; nvm use 24
node -v | grep -q '^v24\.' || die "node is $(node -v), need v24"
echo "node $(node -v)"
[ -z "$(git status --short)" ] || die "working tree not clean"
echo "HEAD $EXPECT_COMMIT_FULL  flavour $FLAVOR"
for a in arm64 x64; do
	[ ! -e "$PARENT/VSCode-darwin-$a" ] || die "unexpected existing $PARENT/VSCode-darwin-$a — packaging would delete it; move it aside first"
	[ ! -e "$PARENT/VSCode-darwin-$a-$TAG" ] || die "target folder $PARENT/VSCode-darwin-$a-$TAG already exists"
	[ -n "$PROBE" ] || [ ! -e "$PARENT/$(zip_name "$a" "$SHORT" "$FLAVOR")" ] || die "target zip $PARENT/$(zip_name "$a" "$SHORT" "$FLAVOR") already exists"
done
if [ -n "$PROBE" ]; then echo "REDACT PROBE BUILD: arm64 only, into $PARENT/VSCode-darwin-arm64-$TAG"; fi
check_native_tree "$REPO/node_modules" arm64

step "1/9 clean out-build out-vscode out-vscode-min"
rm -rf out-build out-vscode out-vscode-min
[ ! -e out-build ] && [ ! -e out-vscode ] && [ ! -e out-vscode-min ] || die "clean did not take"

step "2/9 compile-build (with mangling) + built-in extensions"
npm run compile-build 2>&1 | tee "$LOGDIR/compile-build.log"
check_compile_log "$LOGDIR/compile-build.log"
# Rebuild .build/extensions from this checkout (it cleans first) — packaging
# copies built-in extensions from there.
npm run compile-extensions-build 2>&1 | tee "$LOGDIR/compile-extensions-build.log"
# copilot is built by its own task (upstream's excludedExtensions keeps it out
# of the one above), and packaging needs it present (gulpfile.vscode.ts →
# prepareBuiltInCopilotRipgrepShim); it is removed after packaging like the
# others in REMOVED_EXTENSIONS. ~50 s.
npm run gulp -- compile-copilot-extension-build 2>&1 | tee "$LOGDIR/compile-copilot-extension-build.log"
assert_extension_marks "$REPO/.build/extensions"

step "3/9 verify out-build contains our code"
ls -la out-build/vs/workbench/contrib/livecollab/browser/
grep -q -F "$MARK1" out-build/vs/workbench/contrib/livecollab/browser/livecollabService.js || die "MARK1 missing from out-build livecollabService.js"
echo "MARK1 present in out-build livecollabService.js"
grep -q -F "$MARK2" out-build/vs/workbench/contrib/livecollab/browser/livecollabFolderContribution.js || die "MARK2 missing from out-build livecollabFolderContribution.js"
echo "MARK2 present in out-build livecollabFolderContribution.js"

step "4/9 arm64: minify + package + remove extensions + sign"
rm -rf out-vscode out-vscode-min
npm run gulp -- minify-vscode
npm run gulp -- vscode-darwin-arm64-min-ci
for name in "${REMOVED_EXTENSIONS[@]}"; do remove_extension "$PARENT/VSCode-darwin-arm64" "$name"; done
mv "$PARENT/VSCode-darwin-arm64" "$PARENT/VSCode-darwin-arm64-$TAG"
sign_bundle "$PARENT/VSCode-darwin-arm64-$TAG/LiveCollab.app"

step "5/9 arm64: verify bundle, then zip it and verify the zip"
verify_bundle arm64 "$PARENT/VSCode-darwin-arm64-$TAG" "$EXPECT_COMMIT_FULL" "$FLAVOR"

if [ -n "$PROBE" ]; then
	# node_modules was never switched to x64, so there is nothing to restore.
	[ -z "$(git status --short)" ] || { git status --short; die "working tree dirty after build"; }
	echo; echo "===== [$(date +%H:%M:%S)] REDACT PROBE BUILD COMPLETE (arm64 only) ====="
	echo "arm64: $PARENT/VSCode-darwin-arm64-$TAG  (commit $EXPECT_COMMIT_FULL)"
	exit 0
fi
make_zip "$PARENT/VSCode-darwin-arm64-$TAG/LiveCollab.app" "$PARENT/$(zip_name arm64 "$SHORT" "$FLAVOR")"
check_zip "$PARENT/$(zip_name arm64 "$SHORT" "$FLAVOR")" "$PARENT/VSCode-darwin-arm64-$TAG/LiveCollab.app" "$EXPECT_COMMIT_FULL"

step "6/9 npm_config_arch=x64 npm_config_cpu=x64 npm ci"
# npm_config_cpu matters: optional platform packages (e.g. sharp) are chosen by
# cpu, not arch — without it a cross-compile installs this Mac's arm64 ones.
NM_STATE="x64 (in progress)"
npm_config_arch=x64 npm_config_cpu=x64 npm ci
NM_STATE="x64"
check_native_tree "$REPO/node_modules" x86_64
add_host_tsgo

step "7/9 x64: minify + package + remove extensions + sign (out-build is arch-independent JS, reused)"
rm -rf out-vscode out-vscode-min
npm run gulp -- minify-vscode
npm run gulp -- vscode-darwin-x64-min-ci
for name in "${REMOVED_EXTENSIONS[@]}"; do remove_extension "$PARENT/VSCode-darwin-x64" "$name"; done
mv "$PARENT/VSCode-darwin-x64" "$PARENT/VSCode-darwin-x64-$TAG"
sign_bundle "$PARENT/VSCode-darwin-x64-$TAG/LiveCollab.app"

step "8/9 x64: verify bundle, then zip it and verify the zip"
verify_bundle x64 "$PARENT/VSCode-darwin-x64-$TAG" "$EXPECT_COMMIT_FULL" "$FLAVOR"
make_zip "$PARENT/VSCode-darwin-x64-$TAG/LiveCollab.app" "$PARENT/$(zip_name x64 "$SHORT" "$FLAVOR")"
check_zip "$PARENT/$(zip_name x64 "$SHORT" "$FLAVOR")" "$PARENT/VSCode-darwin-x64-$TAG/LiveCollab.app" "$EXPECT_COMMIT_FULL"

step "9/9 npm_config_arch=arm64 npm_config_cpu=arm64 npm ci (restore dev environment)"
NM_STATE="arm64 (restore in progress)"
npm_config_arch=arm64 npm_config_cpu=arm64 npm ci
NM_STATE="arm64"
check_native_tree "$REPO/node_modules" arm64
[ -z "$(git status --short)" ] || { git status --short; die "working tree dirty after build"; }

step "cleanup: delete the unpacked bundle folders (both zips verified)"
for a in arm64 x64; do delete_unpacked "${PARENT:?}/VSCode-darwin-$a-${TAG:?}" "$PARENT/$(zip_name "$a" "$SHORT" "$FLAVOR")" "$EXPECT_COMMIT_FULL"; done
echo "freed $(awk "BEGIN { printf \"%.1f\", $FREED_KB / 1048576 }") GB; $(df -h "$PARENT" | tail -1 | awk '{print $4}') free"

echo; echo "===== [$(date +%H:%M:%S)] ALL STEPS COMPLETE ====="
for a in arm64 x64; do shasum -a 256 "$PARENT/$(zip_name "$a" "$SHORT" "$FLAVOR")"; done
# Zip retention: keep this build's pair and the last published pair, nothing
# else. The build cannot know which was published, so it names this one and
# lists the rest; record the published one in STATUS.
echo "--- zips in $PARENT:"
for z in "$PARENT"/LiveCollab-*.zip; do
	[ -e "$z" ] || continue
	case "$(basename "$z")" in *-"$SHORT"-"$FLAVOR".zip) echo "  CURRENT (this build)   $(basename "$z")";; *) echo "  older                  $(basename "$z")";; esac
done
echo "Retention: keep CURRENT and the last published pair (see STATUS); delete the other older zips."
