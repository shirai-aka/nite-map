#!/bin/sh
# design/og.html を 1200×630 の PNG に書き出す(Google Chrome のヘッドレスモードを使う)
cd "$(dirname "$0")/.."
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1200,630 --virtual-time-budget=5000 \
  --screenshot="$PWD/prototype/og.png" "file://$PWD/design/og.html"
