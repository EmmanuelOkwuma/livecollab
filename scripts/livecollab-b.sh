#!/usr/bin/env bash
# Layer B (TEST_HARNESS_TRIAGE.md): start a local LiveCollab server as its own Node 24 process,
# run the LiveCollab unit tests against it in the Electron test renderer, then stop the server.
#   scripts/livecollab-b.sh                 runs every LiveCollab suite, the B ones included
#   scripts/livecollab-b.sh "LiveCollab B"  runs only the B suites
# Environment: LC_SERVER (the server folder, default ~/Desktop/livecollab/server).
# The tests find the server through LIVECOLLAB_B_SERVER; without it the B suites skip.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export LC_SERVER="${LC_SERVER:-$HOME/Desktop/livecollab/server}"
GREP="${1:-LiveCollab|livecollab}"

if [ -s "$HOME/.nvm/nvm.sh" ]; then
	# shellcheck disable=SC1091
	source "$HOME/.nvm/nvm.sh" >/dev/null
	nvm use 24 >/dev/null
fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" != "24" ]; then
	echo "livecollab-b: needs Node 24 (the server's better-sqlite3 is built for it); found $(node -v)" >&2
	exit 1
fi

# The tests run from out/: transpile first (a few seconds), so a run never tests stale output.
(cd "$ROOT" && npm run transpile-client >/dev/null 2>&1) || { echo "livecollab-b: transpile failed; run npm run transpile-client to see why" >&2; exit 1; }

LC_DB="$(mktemp -d "${TMPDIR:-/tmp}/lc-b.XXXXXX")"
export LC_DB
LC_PORT="$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();})")"
export LC_PORT
SERVER_LOG="$LC_DB/server.log"

node "$ROOT/livecollab-rig/server.cjs" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

cleanup() {
	kill "$SERVER_PID" 2>/dev/null || true
	wait "$SERVER_PID" 2>/dev/null || true
	rm -rf "${LC_DB:?}"
}
trap cleanup EXIT

for _ in $(seq 1 100); do
	if curl -sf "http://127.0.0.1:$LC_PORT/health" >/dev/null 2>&1; then break; fi
	if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
	sleep 0.1
done
if ! curl -sf "http://127.0.0.1:$LC_PORT/health" >/dev/null 2>&1; then
	echo "livecollab-b: the local server did not start. Its log:" >&2
	cat "$SERVER_LOG" >&2
	exit 1
fi
echo "livecollab-b: local server on port $LC_PORT (pid $SERVER_PID, database $LC_DB)"

# The server's cursor filter (branch cursor-filter; ships with 0.3.6, after testers update) is
# tested only against a server that has it: the tests for it skip otherwise, and this says which.
LIVECOLLAB_B_CURSOR_FILTER=""
if grep -q "idMap.hasId(payload.fileId)" "$LC_SERVER/index.js"; then
	LIVECOLLAB_B_CURSOR_FILTER=1
	echo "livecollab-b: this server filters cursors; the cursor filter tests run"
else
	echo "livecollab-b: this server has no cursor filter; the cursor filter tests skip"
fi
export LIVECOLLAB_B_CURSOR_FILTER

status=0
LIVECOLLAB_B_SERVER="http://127.0.0.1:$LC_PORT" "$ROOT/scripts/test.sh" --grep "$GREP" || status=$?
if [ "$status" -ne 0 ]; then
	echo "livecollab-b: tests failed ($status). The server log's last lines:" >&2
	tail -n 40 "$SERVER_LOG" >&2
fi
exit "$status"
