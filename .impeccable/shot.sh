#!/bin/sh
# shot.sh <url> <out.png> <width> <height>: one headless capture of a local page at an exact size.
exec "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --user-data-dir="${TMPDIR:-/tmp}/deedlords-shot-profile" --virtual-time-budget=6000 --window-size="$3,$4" --screenshot="$2" "$1" >/dev/null 2>&1
