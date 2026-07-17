#!/usr/bin/env bash
#
# One-shot deploy for the CSIR Note Sheet app on the VPS.
#   - pulls the latest branch
#   - rebuilds + publishes the web app to nginx's webroot
#   - updates the note-api backend ONLY if server.js changed, with auto-revert
#
# Run on the VPS (or over SSH from your PC):
#   ssh root@YOUR_VPS 'bash /root/csir-web/redeploy.sh'
#
# Override any path/branch inline, e.g.:
#   BRANCH=some-branch bash /root/csir-web/redeploy.sh
set -euo pipefail

BRANCH="${BRANCH:-claude/note-sheet-generator-app-tbVN7}"
REPO="${REPO:-/root/csir-web}"
WEBROOT="${WEBROOT:-/var/www/notesheet}"
APIDIR="${APIDIR:-/root/note-api}"

say() { printf "\n\033[1;34m==> %s\033[0m\n" "$*"; }

cd "$REPO"
say "Fetching origin/$BRANCH"
git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

say "Building web app"
( cd android-app && npm run build:web )

say "Publishing to $WEBROOT"
rm -rf "${WEBROOT:?}/"*
cp -r "$REPO/android-app/www/"* "$WEBROOT/"
nginx -s reload 2>/dev/null || true
echo "    web asset: $(grep -o 'app.css?v=[a-z0-9]*' "$WEBROOT/index.html" | head -1)"

# --- backend: only touch it if server.js actually changed ---
if [ -f "$APIDIR/server.js" ] && ! diff -q "$REPO/note-api/server.js" "$APIDIR/server.js" >/dev/null 2>&1; then
  say "Backend server.js changed — updating with auto-revert"
  cp "$APIDIR/server.js" "$APIDIR/server.js.bak"
  cp "$REPO/note-api/server.js" "$APIDIR/server.js"
  pm2 restart note-api >/dev/null 2>&1 || true
  sleep 3
  # Smoke-test the unauthenticated /health (does NOT spend the Gemini subscription,
  # and /generate now requires auth so it must not be used here).
  HC=$(curl -sS http://127.0.0.1:8787/health || true)
  if echo "$HC" | grep -q '"ok":true'; then
    echo "    backend OK — kept ($HC)"
  else
    echo "    backend FAILED to start — reverting. Response: $HC"
    cp "$APIDIR/server.js.bak" "$APIDIR/server.js"
    pm2 restart note-api >/dev/null 2>&1 || true
  fi
else
  say "Backend unchanged — skipped"
fi

say "Deploy complete."
