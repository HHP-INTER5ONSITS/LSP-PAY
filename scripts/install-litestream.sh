#!/usr/bin/env sh
# Downloads the Litestream binary into ./bin during `npm install` (Render's
# normal build step), so the database can be backed up to R2 without changing
# Render's build command. Skips quietly on macOS/Windows and if it's already
# there. Never fails the install: without it, the app still runs, just without
# persistence, and scripts/start.sh says so in the logs.

VERSION="v0.3.13"

cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)" || exit 0

if [ -x ./bin/litestream ]; then
  echo "[litestream] already installed: $(./bin/litestream version 2>/dev/null)"
  exit 0
fi

if [ "$(uname -s)" != "Linux" ]; then
  echo "[litestream] not Linux, skipping download (only needed on Render)."
  exit 0
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "[litestream] unsupported CPU $(uname -m), skipping."; exit 0 ;;
esac

URL="https://github.com/benbjohnson/litestream/releases/download/${VERSION}/litestream-${VERSION}-linux-${ARCH}.tar.gz"
echo "[litestream] downloading ${VERSION} for linux-${ARCH}…"
mkdir -p bin
TMP="bin/.litestream.tar.gz"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$URL" -o "$TMP"
elif command -v wget >/dev/null 2>&1; then
  wget -q "$URL" -O "$TMP"
else
  node -e "
    const https=require('https'),fs=require('fs');
    const get=(u,n)=>https.get(u,r=>{
      if(r.statusCode>=300&&r.statusCode<400&&r.headers.location&&n>0)return get(r.headers.location,n-1);
      if(r.statusCode!==200){console.error('HTTP '+r.statusCode);process.exit(1)}
      r.pipe(fs.createWriteStream('$TMP')).on('finish',()=>process.exit(0));
    }).on('error',e=>{console.error(e.message);process.exit(1)});
    get('$URL',5);"
fi

if [ ! -s "$TMP" ] || ! tar -xzf "$TMP" -C bin litestream 2>/dev/null; then
  echo "[litestream] download failed. The app will run without saving the database to R2."
  rm -f "$TMP"
  exit 0
fi
rm -f "$TMP"
chmod +x bin/litestream
echo "[litestream] installed: $(./bin/litestream version 2>/dev/null)"
exit 0
