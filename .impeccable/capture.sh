#!/bin/sh
# capture.sh: desktop.png (1440 wide, full page) and mobile.png (390 wide, full page) of the local landing page into
# .impeccable/review/, with entrance motion off so nothing is caught mid-flight.
cd "$(dirname "$0")/.." || exit 1
C="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
F="--headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --force-prefers-reduced-motion --virtual-time-budget=9000"
"$C" $F --user-data-dir="${TMPDIR:-/tmp}/deedlords-shot-profile" --window-size=1440,6000 --screenshot="$PWD/.impeccable/review/desktop.png" http://localhost:3000/ >/dev/null 2>&1
# The phone frame is served by the app itself for the length of the capture, so that the framed page shares its origin
# (and its clock) with the frame: a 390px iframe, because headless Chrome will not open a window narrower than 500px.
printf '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#3f0806}iframe{display:block;width:390px;height:12000px;border:0}</style><iframe src="/"></iframe>' > public/__phone-frame.html
sleep 1
"$C" $F --user-data-dir="${TMPDIR:-/tmp}/deedlords-shot-profile-m" --window-size=600,12000 --screenshot="$PWD/.impeccable/review/mobile.png" "http://localhost:3000/__phone-frame.html" >/dev/null 2>&1
rm -f public/__phone-frame.html
python3 - <<'PY'
from PIL import Image
for n, crop in (("desktop", None), ("mobile", 390)):
    im = Image.open(f".impeccable/review/{n}.png").convert("RGB")
    if crop: im = im.crop((0, 0, crop, im.height))
    w, h = im.size; px = im.load(); base = px[w - 5, h - 5]; last = h
    for y in range(h - 1, 0, -4):
        if any(abs(px[x, y][0] - base[0]) + abs(px[x, y][1] - base[1]) + abs(px[x, y][2] - base[2]) > 40 for x in range(90, w, 6)):
            last = y; break
    out = im.crop((0, 0, w, min(h, last + 44))); out.save(f".impeccable/review/{n}.png"); print(n, out.size)
PY
