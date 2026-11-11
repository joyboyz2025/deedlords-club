#!/bin/zsh
# capture-play.sh <out.png> <path> <width> <height> <profile> [actions]: one headless capture of a page of the running
# app at an exact size and native resolution, after the listed actions (comma-separated: guest, model, adjust, wish)
# have run inside it. The page is framed by a file the app itself serves for the length of the capture, so the frame
# shares the page's origin and can press its buttons; a profile keeps what a page stores (a guest's key) between shots.
cd "$(dirname "$0")/.." || exit 1
cat > public/__cap.html <<'HTML'
<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#3f0806;overflow:hidden}iframe{display:block;border:0}</style>
<iframe id="f"></iframe>
<script>
const q = new URLSearchParams(location.search);
const f = document.getElementById("f");
f.style.width = q.get("w") + "px"; f.style.height = q.get("h") + "px";
const acts = (q.get("do") || "").split(",").filter(Boolean);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const setValue = (el, value) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, value); el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })); };
f.onload = async () => {
  const d = () => f.contentDocument;
  await wait(2500);
  for (const act of acts) {
    if (act === "guest") [...d().querySelectorAll(".fd-go")].find((b) => /guest/i.test(b.textContent))?.click();
    if (act === "model") { const s = [...d().querySelectorAll(".fd-stub select")].find((x) => [...x.options].some((o) => o.value === "rules")); const m = s && [...s.options].find((o) => o.value !== "rules"); if (m) setValue(s, m.value); }
    if (act === "adjust") [...d().querySelectorAll(".fd-pill")].find((b) => /Adjust/.test(b.textContent))?.click();
    if (act === "wish") { const i = d().querySelector(".fd-wish input"); if (i) { setValue(i, "Grab cheap cities early, keep 200 back"); await wait(300); d().querySelector(".fd-wish button")?.click(); } }
    await wait(1800);
  }
  // The dev server's own error badge is not part of the page (headless Chrome has no WebGL for the seat portraits).
  d().querySelectorAll("nextjs-portal").forEach((node) => node.remove());
};
f.src = q.get("src");
</script>
HTML
sleep 1
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --force-prefers-reduced-motion --virtual-time-budget=16000 \
  --user-data-dir="${TMPDIR:-/tmp}/deedlords-cap-$5" --window-size="$(( $3 < 500 ? 600 : $3 )),$4" --screenshot="$PWD/$1" \
  "http://localhost:3000/__cap.html?w=$3&h=$4&do=$6&src=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1], safe=""))' "$2")" >/dev/null 2>&1
rm -f public/__cap.html
python3 - "$1" "$3" <<'PY'
import sys
from PIL import Image
path, width = sys.argv[1], int(sys.argv[2])
im = Image.open(path).convert("RGB")
if im.width > width: im = im.crop((0, 0, width, im.height))
# A full-page shot is taken taller than the page: cut the empty ground below the last thing drawn.
px = im.load(); w, h = im.size; base = px[w - 4, h - 4]; last = h
if h > 1200:
    for y in range(h - 1, 0, -4):
        if any(sum(abs(px[x, y][c] - base[c]) for c in range(3)) > 40 for x in range(12, w, 6)):
            last = y; break
    im = im.crop((0, 0, w, min(h, last + 40)))
im.save(path); print(path, im.size)
PY
