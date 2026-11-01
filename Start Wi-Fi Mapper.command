#!/bin/bash
set -u

cd "$(dirname "$0")" || exit 1

fail() {
  echo ""
  echo "Fieldnote could not start: $1"
  if [ -t 0 ]; then read -r -p "Press Return to close this window. " _reply; fi
  exit 1
}

# Finder does not inherit the interactive shell's PATH.
if ! command -v node >/dev/null 2>&1; then
  export PATH="$HOME/.vite-plus/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
fi
command -v node >/dev/null 2>&1 || fail "Install Node.js 22.18 or newer, then try again."
command -v npm >/dev/null 2>&1 || fail "npm is missing. Install a complete Node.js distribution."
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || major === 22 && minor >= 18 ? 0 : 1)' || fail "Node.js 22.18 or newer is required."
[ "$(uname -s)" = "Darwin" ] || fail "Real Wi-Fi measurements currently require macOS."
command -v swift >/dev/null 2>&1 || fail "Install Xcode Command Line Tools with: xcode-select --install"
xcode-select -p >/dev/null 2>&1 || fail "Install Xcode Command Line Tools with: xcode-select --install"

export PORT="${PORT:-4318}"
node -e 'const p = Number(process.env.PORT); process.exit(Number.isInteger(p) && p >= 1024 && p <= 65535 ? 0 : 1)' || fail "PORT must be an integer from 1024 to 65535."
app_url="http://127.0.0.1:$PORT"

# Exit 0 identifies Fieldnote; 2 means another HTTP service; 1 means no response.
health() {
  node --input-type=module -e '
    let response;
    try { response = await fetch(`http://127.0.0.1:${process.env.PORT}/api/health`, { signal: AbortSignal.timeout(700) }); }
    catch { process.exit(1); }
    try { const data = await response.json(); process.exit(response.ok && data.app === "fieldnote-wifi-mapper" ? 0 : 2); }
    catch { process.exit(2); }
  '
}

health
health_code=$?
if [ "$health_code" -eq 0 ]; then
  echo "Fieldnote is already running at $app_url"
  open "$app_url"
  exit 0
elif [ "$health_code" -eq 2 ]; then
  fail "Another service is using port $PORT. Close it or choose a different PORT."
fi

node scripts/ensure-dependencies.mjs || fail "Dependency setup failed. The error is printed above."

echo "Building Fieldnote and its native Wi-Fi reader…"
npm run build || fail "The build failed. The error is printed above."

node server/index.mjs &
server_pid=$!
cleanup() {
  if kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

ready=0
for ((attempt = 0; attempt < 40; attempt++)); do
  kill -0 "$server_pid" 2>/dev/null || fail "The local service exited. The error is printed above."
  if health; then ready=1; break; fi
  sleep 0.2
done
[ "$ready" -eq 1 ] || fail "The local service did not become ready. The error is printed above."

echo ""
echo "Opening $app_url"
echo "Keep this window open while surveying. Press Control-C to stop."
open "$app_url" || echo "Open $app_url in your browser."
wait "$server_pid"
server_code=$?
[ "$server_code" -eq 0 ] || fail "The local service stopped with exit code $server_code."
