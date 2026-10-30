#!/usr/bin/env sh
# Start script for Render.
#
# If Litestream is installed and R2 is configured, the database is first
# restored from R2 (so a fresh deploy picks up yesterday's data), then the app
# runs *under* Litestream so every change is replicated back to R2 live.
#
# If Litestream or the R2 settings are missing, the app still starts normally —
# just without persistence. That keeps local development and first-boot simple.
set -e

# Move to the repo root (this script lives in ./scripts).
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

# The app (src/db.js) builds its DB path from DATA_DIR. We compute the exact
# same file here and hand it to Litestream so both point at one file.
export DATA_DIR="${DATA_DIR:-$PWD/data}"
mkdir -p "$DATA_DIR"
export DB_PATH="$DATA_DIR/lsp-pay.db"

LITESTREAM="./bin/litestream"

MISSING=""
[ -x "$LITESTREAM" ] || MISSING="$MISSING the Litestream program (bin/litestream, installed by npm install),"
for v in R2_BUCKET R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || MISSING="$MISSING $v,"
done

if [ -z "$MISSING" ]; then
  echo "[start] Litestream on. Restoring database from R2 if a backup exists…"
  "$LITESTREAM" restore -if-replica-exists -config ./litestream.yml -o "$DB_PATH" "$DB_PATH" || true
  echo "[start] Launching app under Litestream replication…"
  exec "$LITESTREAM" replicate -config ./litestream.yml -exec "node src/server.js"
else
  echo "[start] Litestream not configured — running without persistence. Missing:${MISSING%,}"
  exec node src/server.js
fi
