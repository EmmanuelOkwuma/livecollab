#!/usr/bin/env bash
# LiveCollab bundle cleanup, MacBook side. Deletes ONLY after reading the commit
# from the bundle's own product.json; a missing bundle or a commit mismatch is a
# loud SKIP, never a delete. Dry run unless --really is given. Prints free space
# before and after; exits non-zero if anything was skipped.
#
# Retention rule (HANDOFF_2026-09-16.md, deploy section): keep the bundle that is
# deployed on both machines plus the last known-good pair, nothing else; delete a
# known-broken bundle once its replacement has been LAUNCHED. ~1.1 GB per bundle.
# Stages below are tonight's (2026-10-02); edit them for the next cleanup. After
# changing this file, run cleanup-bundles.selftest.sh.
#
#   scripts/livecollab/cleanup-bundles.sh <stage> [--really]
#     after-282fdcd-open-folder  (obsolete: its trigger cannot be met — use after-fc6b600-open-folder)
#     after-fc6b600-open-folder  MacBook 6852bb5 + 282fdcd pairs (fc6b600 launched + Open Folder confirmed)
#     imac-off-6852bb5           iCloud LiveCollab-x64-6852bb5.app + its manifest (iMac moved off it)
#     after-section-1            MacBook 6e4ae6b pair + iCloud LiveCollab-x64.app (section 1 passed)
#     macbook-6e4ae6b            MacBook 6e4ae6b pair ONLY (2026-10-11: 7823c61 launched and
#                                signed in; iCloud LiveCollab-x64.app is left for the iMac)
#     macbook-7823c61            MacBook 7823c61 pair (2026-10-11: f466a3e launched and signed in)
#     macbook-f466a3e            MacBook f466a3e pair (2026-10-11: 42d0eb7 launched and signed in)
#     macbook-2026-10-14-arm64   MacBook arm64 42d0eb7 + fc6b600 (7f98746 launched on the MacBook)
#                                + arm64-cdf0f26, which HOLDS d29b61de (mislabel: commit landed
#                                mid-build) — keyed on the commit inside, not the folder name
#     macbook-2026-10-14-x64     MacBook x64 42d0eb7 + fc6b600 — ONLY after 7f98746 has launched
#                                on the iMac (the rule: never before the replacement launches)
#     redact-probe               ../VSCode-darwin-arm64-REDACTPROBE-DELETEME (the throwaway probe
#                                build). Its commit is soft-reset away, so pass it:
#                                REDACTPROBE_COMMIT=<sha> cleanup-bundles.sh redact-probe [--really]
#
# iMac-side deletes (old LiveCollab.app, ~/Desktop/imac-manifest.txt) are not
# reachable from here — see the iMac commands printed by the 'after-section-1' stage.

set -u
STAGE=${1:-}
REALLY=0
[ "${2:-}" = "--really" ] && REALLY=1
ICD="$HOME/Library/Mobile Documents/com~apple~CloudDocs"
DESK="$HOME/Desktop"
SKIPS=0

free_space() {
	df -h "$HOME" | tail -1 | awk '{print $4 " free of " $2}'
}

# delete_bundle <path to delete> <path to LiveCollab.app inside it> <expected commit prefix>
delete_bundle() {
	target=$1
	app=$2
	want=$3
	if [ ! -e "$target" ]; then
		echo "SKIP (missing): $target"
		SKIPS=$((SKIPS + 1))
		return 1
	fi
	got=$(plutil -extract commit raw -o - "$app/Contents/Resources/app/product.json" 2>/dev/null)
	rc=$?
	if [ $rc -ne 0 ] || [ -z "$got" ]; then
		echo "SKIP (no readable commit in product.json): $target"
		SKIPS=$((SKIPS + 1))
		return 1
	fi
	case "$got" in
		"$want"*) ;;
		*)
			echo "SKIP (COMMIT MISMATCH: expected $want, bundle is $got): $target"
			SKIPS=$((SKIPS + 1))
			return 1
			;;
	esac
	if [ $REALLY -eq 1 ]; then
		rm -rf "$target"
		if [ -e "$target" ]; then
			echo "FAILED to delete: $target"
			SKIPS=$((SKIPS + 1))
			return 1
		fi
		echo "DELETED ($got): $target"
	else
		echo "would delete ($got): $target"
	fi
	return 0
}

[ $REALLY -eq 1 ] && echo "MODE: DELETING" || echo "MODE: dry run (add --really to delete)"
echo "before: $(free_space)"

case "$STAGE" in
	after-282fdcd-open-folder)
		delete_bundle "$DESK/VSCode-darwin-arm64-6852bb5" "$DESK/VSCode-darwin-arm64-6852bb5/LiveCollab.app" 6852bb5
		delete_bundle "$DESK/VSCode-darwin-x64-6852bb5" "$DESK/VSCode-darwin-x64-6852bb5/LiveCollab.app" 6852bb5
		;;
	after-fc6b600-open-folder)
		# fc6b600 launched and Open Folder confirmed on the MacBook (2026-10-02):
		# 6852bb5 and 282fdcd are both known-broken for Open Folder.
		delete_bundle "$DESK/VSCode-darwin-arm64-6852bb5" "$DESK/VSCode-darwin-arm64-6852bb5/LiveCollab.app" 6852bb5
		delete_bundle "$DESK/VSCode-darwin-x64-6852bb5" "$DESK/VSCode-darwin-x64-6852bb5/LiveCollab.app" 6852bb5
		delete_bundle "$DESK/VSCode-darwin-arm64-282fdcd" "$DESK/VSCode-darwin-arm64-282fdcd/LiveCollab.app" 282fdcd
		delete_bundle "$DESK/VSCode-darwin-x64-282fdcd" "$DESK/VSCode-darwin-x64-282fdcd/LiveCollab.app" 282fdcd
		;;
	imac-off-6852bb5)
		# The manifest has no commit of its own: it goes only if its app verified.
		if delete_bundle "$ICD/LiveCollab-x64-6852bb5.app" "$ICD/LiveCollab-x64-6852bb5.app" 6852bb5; then
			if [ $REALLY -eq 1 ]; then
				rm -f "$ICD/livecollab-x64-6852bb5-manifest.txt" && echo "DELETED: $ICD/livecollab-x64-6852bb5-manifest.txt"
			else
				echo "would delete: $ICD/livecollab-x64-6852bb5-manifest.txt"
			fi
		else
			echo "SKIP manifest too: its app did not verify"
		fi
		;;
	after-section-1)
		delete_bundle "$DESK/VSCode-darwin-arm64-6e4ae6b" "$DESK/VSCode-darwin-arm64-6e4ae6b/LiveCollab.app" 6e4ae6b
		delete_bundle "$DESK/VSCode-darwin-x64-6e4ae6b" "$DESK/VSCode-darwin-x64-6e4ae6b/LiveCollab.app" 6e4ae6b
		delete_bundle "$ICD/LiveCollab-x64.app" "$ICD/LiveCollab-x64.app" 6e4ae6b
		echo
		echo "iMac (run there, in the guest account; set APP to wherever the OLD app lives):"
		echo '  APP=/path/to/LiveCollab.app; c=$(plutil -extract commit raw -o - "$APP/Contents/Resources/app/product.json"); echo "$c"'
		echo '  # only if it printed 6e4ae6b...:  rm -rf "$APP"; rm -f ~/Desktop/imac-manifest.txt; df -h ~ | tail -1'
		;;
	macbook-6e4ae6b)
		delete_bundle "$DESK/VSCode-darwin-arm64-6e4ae6b" "$DESK/VSCode-darwin-arm64-6e4ae6b/LiveCollab.app" 6e4ae6b
		delete_bundle "$DESK/VSCode-darwin-x64-6e4ae6b" "$DESK/VSCode-darwin-x64-6e4ae6b/LiveCollab.app" 6e4ae6b
		;;
	macbook-7823c61)
		delete_bundle "$DESK/VSCode-darwin-arm64-7823c61" "$DESK/VSCode-darwin-arm64-7823c61/LiveCollab.app" 7823c61
		delete_bundle "$DESK/VSCode-darwin-x64-7823c61" "$DESK/VSCode-darwin-x64-7823c61/LiveCollab.app" 7823c61
		;;
	macbook-f466a3e)
		delete_bundle "$DESK/VSCode-darwin-arm64-f466a3e" "$DESK/VSCode-darwin-arm64-f466a3e/LiveCollab.app" f466a3e
		delete_bundle "$DESK/VSCode-darwin-x64-f466a3e" "$DESK/VSCode-darwin-x64-f466a3e/LiveCollab.app" f466a3e
		;;
	macbook-2026-10-14-arm64)
		delete_bundle "$DESK/VSCode-darwin-arm64-42d0eb7" "$DESK/VSCode-darwin-arm64-42d0eb7/LiveCollab.app" 42d0eb7
		delete_bundle "$DESK/VSCode-darwin-arm64-fc6b600" "$DESK/VSCode-darwin-arm64-fc6b600/LiveCollab.app" fc6b600
		delete_bundle "$DESK/VSCode-darwin-arm64-cdf0f26" "$DESK/VSCode-darwin-arm64-cdf0f26/LiveCollab.app" d29b61de
		;;
	macbook-2026-10-14-x64)
		delete_bundle "$DESK/VSCode-darwin-x64-42d0eb7" "$DESK/VSCode-darwin-x64-42d0eb7/LiveCollab.app" 42d0eb7
		delete_bundle "$DESK/VSCode-darwin-x64-fc6b600" "$DESK/VSCode-darwin-x64-fc6b600/LiveCollab.app" fc6b600
		;;
	redact-probe)
		# Built next to the repo (build-bundles.sh's $PARENT), not on the Desktop.
		# No default commit: without the probe commit there is nothing to key on.
		if ! printf '%s' "${REDACTPROBE_COMMIT:-}" | grep -Eq '^[0-9a-f]{7,40}$'; then
			echo "redact-probe needs REDACTPROBE_COMMIT=<the probe commit, 7+ hex chars> — nothing deleted"
			exit 2
		fi
		PROBEDIR="$(cd "$(dirname "$0")/../../.." && pwd)/VSCode-darwin-arm64-REDACTPROBE-DELETEME"
		delete_bundle "$PROBEDIR" "$PROBEDIR/LiveCollab.app" "$REDACTPROBE_COMMIT"
		;;
	*)
		echo "unknown stage '$STAGE' — use after-fc6b600-open-folder | imac-off-6852bb5 | after-section-1 | macbook-6e4ae6b | macbook-7823c61 | macbook-f466a3e | macbook-2026-10-14-arm64 | macbook-2026-10-14-x64 | redact-probe"
		exit 2
		;;
esac

echo "after: $(free_space)"
if [ $SKIPS -ne 0 ]; then
	echo "$SKIPS SKIP(S) — read them above before assuming anything was cleaned up"
	exit 1
fi
exit 0
