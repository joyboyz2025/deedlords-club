// The recorder behind the demo video: a headless Chrome driven over the DevTools protocol, filmed with the browser's own
// screencast. A scene is a function that moves a drawn pointer, clicks with real mouse events, sets a caption and
// waits; what the page shows meanwhile is saved frame by frame with the time of each, and ffmpeg makes a clip of it.
//
// Nothing here fakes the product: the pointer and the caption are two elements laid over whatever page is open, and
// time taken out of a take (a wait for the chain, a page loading) is taken out with `cut`, which the scenes say in
// their captions when it matters.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Laid over every page: the caption and the pointer. Kept out of the page's own layout and events. */
const OVERLAY = `(() => {
  if (window.__demo) return;
  const make = () => {
    if (document.getElementById("__demo")) return;
    const root = document.createElement("div");
    root.id = "__demo";
    root.innerHTML = \`<style>
      #__demo { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; font-family: "Be Vietnam Pro", ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", sans-serif; }
      #__demo .cap { position: absolute; left: 50%; bottom: 30px; translate: -50% 0; width: max-content; max-width: min(1040px, 86vw); padding: 13px 24px 14px; border: 1.5px solid rgb(248 201 63 / 60%); border-radius: 16px;
        background: rgb(26 10 6 / 90%); color: #fff7e6; font-size: 23px; font-weight: 600; line-height: 1.32; text-align: center; text-wrap: balance; box-shadow: 0 10px 30px rgb(0 0 0 / 40%);
        opacity: 0; transition: opacity 0.25s; }
      #__demo .cap[data-on] { opacity: 1; }
      #__demo .cap b { color: #f8c93f; font-weight: 700; }
      #__demo .ptr { position: absolute; left: 0; top: 0; width: 30px; height: 30px; translate: var(--x, -80px) var(--y, -80px); transition: translate var(--ms, 600ms) cubic-bezier(0.3, 0.1, 0.2, 1); }
      #__demo .ptr svg { position: absolute; left: -3px; top: -2px; filter: drop-shadow(0 2px 3px rgb(0 0 0 / 55%)); }
      #__demo .ptr i { position: absolute; left: -22px; top: -22px; width: 44px; height: 44px; border-radius: 50%; border: 3px solid #f8c93f; opacity: 0; scale: 0.3; }
      #__demo .ptr[data-tap] i { animation: __tap 0.45s ease-out; }
      @keyframes __tap { 0% { opacity: 0.95; scale: 0.3; } 100% { opacity: 0; scale: 1.25; } }
    </style><div class="cap"></div><div class="ptr"><i></i><svg width="26" height="30" viewBox="0 0 26 30"><path d="M3 2v22l6-5.200 4 9 4.200-1.900-4-8.900h8.300L3 2Z" fill="#fff" stroke="#1d0d07" stroke-width="2" stroke-linejoin="round"/></svg></div>\`;
    document.documentElement.appendChild(root);
  };
  window.__demo = {
    make,
    caption(html) { make(); const cap = document.querySelector("#__demo .cap"); if (html) { cap.innerHTML = html; cap.setAttribute("data-on", ""); } else cap.removeAttribute("data-on"); },
    point(x, y, ms) { make(); const ptr = document.querySelector("#__demo .ptr"); ptr.style.setProperty("--ms", ms + "ms"); ptr.style.setProperty("--x", x + "px"); ptr.style.setProperty("--y", y + "px"); },
    tap() { const ptr = document.querySelector("#__demo .ptr"); ptr.removeAttribute("data-tap"); void ptr.offsetWidth; ptr.setAttribute("data-tap", ""); },
    /** The element a scene names: a CSS selector, or { text, within } for the first visible button, link or tab whose words match. */
    find(spec) {
      // What a hand could press: on the page, and not switched off (a button waiting for its transaction is not one).
      const seen = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden" && !el.disabled; };
      if (typeof spec === "string") return [...document.querySelectorAll(spec)].find(seen) ?? null;
      const scope = spec.within ? document.querySelector(spec.within) : document;
      if (!scope) return null;
      const test = new RegExp(spec.text, spec.flags ?? "");
      return [...scope.querySelectorAll(spec.tag ?? "button, a, summary, [role=tab], select, label")].filter(seen).find((el) => test.test((el.innerText || el.textContent || "").trim())) ?? null;
    },
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", make); else make();
})()`;

/**
 * Opens the browser. `size`: the page as the site sees it; `scale`: device pixels for each of its pixels (1.5 of
 * 1280 by 720 is a 1080p picture). `gl`: "soft" draws WebGL without the graphics card, slower and the same anywhere.
 */
export async function open({ width = 1280, height = 720, scale = 1.5, gl = process.env.DEMO_GL ?? "" } = {}) {
  const port = 9400 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(join(tmpdir(), "demo-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      ...(gl === "soft" ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : gl === "metal" ? ["--use-angle=metal", "--enable-gpu"] : []),
      "--hide-scrollbars",
      "--no-first-run",
      "--mute-audio",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      // A headless window keeps 87 points for a frame it does not draw: the page gets `height` with them added.
      `--window-size=${width},${height + 87}`,
      // A real scale factor, not an emulated one: the screencast films device pixels only then (1.5 of 1280 by 720 is 1080p).
      `--force-device-scale-factor=${scale}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let target;
  for (let tries = 0; tries < 60 && !target; tries++) {
    await sleep(200);
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((one) => one.type === "page");
    } catch {}
  }
  if (!target) throw new Error("the browser did not start");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((done) => (ws.onopen = done));
  let seq = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method) for (const listener of listeners.get(message.method) ?? []) listener(message.params);
  };
  const send = (method, params = {}) =>
    new Promise((done) => {
      const id = ++seq;
      pending.set(id, done);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const on = (method, listener) => listeners.set(method, [...(listeners.get(method) ?? []), listener]);

  if (process.env.DEMO_EMULATE) await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: OVERLAY });
  await send("Page.bringToFront");

  const state = { caption: "", style: "", x: width / 2, y: height / 2, frames: [], writing: [], held: undefined, filming: false, taken: 0, dir: "", lastAt: 0, lastWall: 0 };
  const evaluate = async (expression) => {
    const answer = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (answer.result?.exceptionDetails) throw new Error(answer.result.exceptionDetails.exception?.description ?? answer.result.exceptionDetails.text);
    return answer.result?.result?.value;
  };
  // A page that has just loaded gets the caption and the pointer back where they were.
  const dress = () =>
    evaluate(
      `${OVERLAY}; window.__demo.caption(${JSON.stringify(state.caption)}); window.__demo.point(${state.x}, ${state.y}, 0);
       (() => { let sheet = document.getElementById("__demo_style"); if (!sheet) { sheet = document.createElement("style"); sheet.id = "__demo_style"; document.documentElement.appendChild(sheet); } sheet.textContent = ${JSON.stringify(state.style)}; })()`,
    ).catch(() => undefined);
  on("Page.domContentEventFired", dress);
  on("Page.loadEventFired", dress);
  const keep = (data, at) => {
    const file = `f${String(state.frames.length).padStart(6, "0")}.jpg`;
    state.writing.push(writeFile(join(state.dir, file), Buffer.from(data, "base64")));
    state.lastAt = at;
    state.lastWall = Date.now();
    state.frames.push({ file, at: at - state.taken });
  };
  on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    void send("Page.screencastFrameAck", { sessionId });
    if (!state.filming) return;
    // Thirty pictures a second are kept, written without holding up the commands that drive the page: a board in
    // motion sends sixty big ones, and saving each in turn put the scene seconds behind what was being filmed.
    // A picture passed over is not thrown away: if nothing newer follows it at once, it is the page as it now stands
    // (a caption that changed, the last step of a move) and is kept after all.
    clearTimeout(state.held);
    if (metadata.timestamp - state.lastAt < 1 / 31) {
      state.held = setTimeout(() => state.filming && keep(data, metadata.timestamp), 45);
      return;
    }
    keep(data, metadata.timestamp);
  });

  const page = {
    width,
    height,
    send,
    evaluate,
    sleep,
    async goto(url, settle = 1500) {
      const loaded = new Promise((done) => on("Page.loadEventFired", done));
      await send("Page.navigate", { url });
      await Promise.race([loaded, sleep(25_000)]);
      await sleep(settle);
      await dress();
    },
    /** Extra CSS for the pages filmed from now on (room for the caption under a full-screen board, say). Empty: none. */
    async style(css = "") {
      state.style = css;
      await dress();
    },
    /**
     * The words under the picture; `<b>` marks what matters. Empty: none. `id` names the caption for the narration:
     * a take writes `<name>.captions.json`, the film time at which each named caption came up.
     */
    async caption(html = "", id = "") {
      state.caption = html;
      await evaluate(`window.__demo?.caption(${JSON.stringify(html)})`).catch(() => undefined);
      // The picture that shows it is the next one kept.
      if (id && state.captions) state.captions.push({ id, text: html.replace(/<[^>]+>/g, ""), frame: state.frames.length });
    },
    /** Waits until `test` (an expression, in the page) is true, asking every 250 ms. Throws after `timeout`. */
    async until(test, timeout = 60_000, what = test) {
      const started = Date.now();
      for (;;) {
        if (await evaluate(`Boolean(${test})`).catch(() => false)) return;
        if (Date.now() - started > timeout) throw new Error(`waited ${timeout / 1000} s for: ${what}`);
        await sleep(250);
      }
    },
    /** Where the element is, scrolled into view if it is not. `null`: not on the page. */
    async locate(spec) {
      const found = await evaluate(`(() => { const el = window.__demo.find(${JSON.stringify(spec)}); if (!el) return null; const r = el.getBoundingClientRect();
        if (r.top < 70 || r.bottom > innerHeight - 110) { el.scrollIntoView({ block: "center", behavior: "smooth" }); return "moving"; }
        return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 60) }; })()`);
      if (found !== "moving") return found;
      await sleep(900);
      return evaluate(
        `(() => { const r = window.__demo.find(${JSON.stringify(spec)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 60) }; })()`,
      );
    },
    /** Moves the pointer onto the element, as a hand would. */
    async hover(spec, ms = 650) {
      const at = await page.locate(spec);
      if (!at) throw new Error(`nothing to point at: ${JSON.stringify(spec)}`);
      state.x = at.x;
      state.y = at.y;
      await evaluate(`window.__demo.point(${at.x}, ${at.y}, ${ms})`);
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
      await sleep(ms + 120);
      return at;
    },
    /** Points at the element and clicks it with the browser's own mouse events. */
    async click(spec, { ms = 650, after = 350 } = {}) {
      const at = await page.hover(spec, ms);
      await evaluate("window.__demo.tap()");
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 });
      await sleep(after);
    },
    /** Scrolls so that the element named sits near the top, smoothly. */
    async scrollTo(selector, offset = 90, wait = 1100) {
      await evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) scrollTo({ top: el.getBoundingClientRect().top + scrollY - ${offset}, behavior: "smooth" }); })()`,
      );
      await sleep(wait);
    },
    /** Films what `scene` does into `<dir>/<name>.mp4`. Returns how long the clip is, in seconds. */
    async take(dir, name, scene) {
      state.dir = join(dir, `${name}.frames`);
      rmSync(state.dir, { recursive: true, force: true });
      mkdirSync(state.dir, { recursive: true });
      state.frames = [];
      state.writing = [];
      state.captions = [];
      state.lastAt = 0;
      state.taken = 0;
      state.filming = true;
      await send("Page.startScreencast", { format: "jpeg", quality: 88, everyNthFrame: 1, maxWidth: Math.round(width * scale), maxHeight: Math.round(height * scale) });
      const started = Date.now();
      let tail = 0.4;
      try {
        await scene(page);
      } finally {
        await sleep(200);
        // A page that stands still sends no picture: the last one is held for as long as the scene went on after it.
        tail = Math.max((Date.now() - (state.lastWall || Date.now())) / 1000, 0.3);
        state.filming = false;
        await send("Page.stopScreencast");
        await Promise.all(state.writing);
      }
      const frames = state.frames;
      if (frames.length < 2) throw new Error(`${name}: the page gave no pictures`);
      // The screencast sends a picture when the page changes: each one stays until the next, the last one a moment more.
      const list = ["ffconcat version 1.0"];
      frames.forEach((frame, i) => {
        const hold = i + 1 < frames.length ? Math.max(frames[i + 1].at - frame.at, 0.001) : tail;
        list.push(`file ${frame.file}`, `duration ${hold.toFixed(4)}`);
      });
      list.push(`file ${frames.at(-1).file}`);
      writeFileSync(join(state.dir, "list.txt"), list.join("\n"));
      const out = join(dir, `${name}.mp4`);
      const seconds = frames.at(-1).at - frames[0].at + tail;
      // `-t`: the list's last picture is named twice (the demuxer wants it so) and would otherwise be held again.
      const made = spawnSync(
        "ffmpeg",
        [
          "-y",
          "-loglevel",
          "error",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          join(state.dir, "list.txt"),
          "-t",
          seconds.toFixed(3),
          "-vf",
          "fps=30,scale=1920:1080:flags=lanczos,format=yuv420p",
          "-c:v",
          "libx264",
          "-preset",
          "medium",
          "-crf",
          "17",
          out,
        ],
        { encoding: "utf8" },
      );
      if (made.status !== 0) throw new Error(`ffmpeg: ${made.stderr}`);
      // When each named caption came up, in seconds of this clip.
      const said = state.captions.map(({ id, text, frame }) => ({ id, at: Number((frames[Math.min(frame, frames.length - 1)].at - frames[0].at).toFixed(2)), text }));
      state.captions = null;
      writeFileSync(join(dir, `${name}.captions.json`), JSON.stringify({ seconds: Number(seconds.toFixed(2)), captions: said }, null, 1));
      console.log(
        `${name}: ${seconds.toFixed(1)} s on film, ${((Date.now() - started) / 1000).toFixed(0)} s to take, ${frames.length} pictures (${(frames.length / seconds).toFixed(0)} a second)`,
      );
      return seconds;
    },
    /** Runs `wait` with the camera off: the time it takes is not in the clip. */
    async cut(wait) {
      if (!state.filming) return wait();
      state.filming = false;
      const started = Date.now();
      try {
        return await wait();
      } finally {
        await sleep(120);
        // What passed while the camera was off, less a tenth of a second for the cut itself.
        state.taken += Math.max((Date.now() - started) / 1000 - 0.1, 0);
        // The picture that was up when the camera went off is not held through the cut.
        state.lastWall = Date.now();
        state.filming = true;
      }
    },
    async close() {
      chrome.kill("SIGKILL");
      await sleep(200);
      rmSync(profile, { recursive: true, force: true });
    },
  };
  return page;
}

/** Joins clips, in order, into one film. */
export function join_(clips, out) {
  const list = join(tmpdir(), `demo-join-${Date.now()}.txt`);
  writeFileSync(list, clips.map((clip) => `file '${clip}'`).join("\n"));
  const made = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out], { encoding: "utf8" });
  rmSync(list, { force: true });
  if (made.status !== 0) throw new Error(`ffmpeg: ${made.stderr}`);
}
