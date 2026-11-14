// Extra shots for the pitch cut of the demo film: the ways in, an agent being written, that agent playing the house's
// agent, a price from another chain, and the Arena trailer. Every picture is the live site, as in `film.mjs`; no
// caption is drawn here (`cut.py` lays its own under the picture).
//
//   node tools/demo/extra.mjs <out dir> [wallets agents selfplay chains poker arena]
//
// agents, selfplay and chains use one guest account made here on DEMO_PLAY (the testnet site unless told otherwise).
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { open, sleep } from "./rec.mjs";

const PLAY = (process.env.DEMO_PLAY ?? "https://deedlords-club-testnet.vercel.app").replace(/\/$/, "");
const BOARD_ROOM = `html, body { background: #170a06 !important; } .tp[data-view="3d"] { height: calc(100dvh - 104px) !important; min-height: 0 !important; }`;
const PROMPT =
  "You are a patient landlord. Buy every city under 200 while cash stays above 400, and build its first house at once. Keep Lisbon and Madrid: they are cheap and often visited. Late in the game hold cash back: the leader pays double rent.";

const [dir, ...asked] = process.argv.slice(2);
if (!dir) throw new Error("node tools/demo/extra.mjs <out dir> [scene ...]");
mkdirSync(dir, { recursive: true });

const has = (page, spec) => page.evaluate(`Boolean(window.__demo.find(${JSON.stringify(spec)}))`).catch(() => false);

/** Types into a field a letter at a time, the way React hears it. Returns once the last letter is in. */
async function type(page, selector, words, ms = 30) {
  await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return; el.focus();
    const set = Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value").set;
    const words = ${JSON.stringify(words)}; let i = 0;
    const next = () => { i++; set.call(el, words.slice(0, i)); el.dispatchEvent(new Event("input", { bubbles: true })); el.scrollTop = el.scrollHeight; if (i < words.length) setTimeout(next, ${ms}); };
    next(); })()`);
  await sleep(words.length * (ms + 6) + 300);
}

/** Sets a menu's choice (a native menu does not show on film) and tells React. */
const choose = (page, selector, value) =>
  page.evaluate(`(() => { const sel = document.querySelector(${JSON.stringify(selector)}); if (!sel) return null;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, ${JSON.stringify(value)}); sel.dispatchEvent(new Event("change", { bubbles: true })); return sel.value; })()`);

async function guest(page) {
  await page.goto(`${PLAY}/play`, 3000);
  await page.until(`window.__demo.find({ text: "Play as a guest" }) || window.__demo.find({ text: "^Play vs" })`, 60_000, "the front desk");
  if (await has(page, { text: "Play as a guest" })) await page.click({ text: "Play as a guest" }, { ms: 150 });
  await page.until(`window.__demo.find({ text: "^Play vs" })`, 60_000, "the desk of a guest");
}

const scenes = {
  /** The ways in, on the gate of /play: a guest, an EVM wallet, a NEAR wallet (NEAR Connect's own list). */
  async wallets(page) {
    await page.style("");
    await page.goto(`${PLAY}/play`, 3500);
    await page.until(`window.__demo.find({ text: "Play as a guest" })`, 60_000, "the gate");
    await page.take(dir, "n1-wallets", async () => {
      await sleep(900);
      await page.hover({ text: "Play as a guest" }, 700);
      await sleep(1700);
      await page.hover({ text: "^EVM wallet" }, 700);
      await sleep(2000);
      await page.hover({ text: "^NEAR wallet" }, 700);
      await sleep(1000);
      await page.click({ text: "^NEAR wallet" });
      await sleep(6000);
    });
  },

  /** An agent of one's own: its name, its model, what it is told, a rule. */
  async agents(page) {
    await page.style("");
    await guest(page);
    await page.goto(`${PLAY}/agents`, 3000);
    await page.until(`document.querySelector(".fd-prompt textarea")`, 60_000, "the agent's page");
    const models = await page.evaluate(`[...document.querySelectorAll(".fd-field select option")].map((o) => o.value)`);
    // A model other than the house's. Not a `near:` one: the editor takes that prefix for a model on the player's own NEAR AI key.
    const model = models.find((m) => m === (process.env.DEMO_AGENT_MODEL ?? "gemini-2.5-flash-lite")) ?? models.find((m) => !/^near:/.test(m) && m !== "rules") ?? models[0];
    console.log(`models offered: ${JSON.stringify(models)}; the agent takes ${model}`);
    await page.take(dir, "n2-agents", async () => {
      await sleep(1000);
      await page.click(".fd-field input[type=text]", { ms: 600, after: 200 });
      await type(page, ".fd-field input[type=text]", "The Landlord", 55);
      await sleep(500);
      await page.hover(".fd-field select", 700);
      await choose(page, ".fd-field select", model);
      await sleep(1900);
      await page.click(".fd-prompt textarea", { ms: 700, after: 200 });
      await type(page, ".fd-prompt textarea", PROMPT, 16);
      await sleep(1500);
      await page.click({ text: "^\\+ Add a rule", tag: "button" }, { ms: 700, after: 300 });
      await type(page, '.fd-rulelist input[aria-label="Rule 1"]', "Never let cash drop below 300", 32);
      await sleep(2200);
    });
  },

  /** That agent takes the guest's seat against the house's agent: two models at one table. */
  async selfplay(page) {
    await page.style(BOARD_ROOM);
    await guest(page);
    await page.click({ text: "^Play vs AI" }, { ms: 200 });
    await page.until(`document.querySelector("canvas") && document.querySelector(".tp-hud")`, 180_000, "the board");
    await page.evaluate("window.confirm = () => false");
    await page.until(`window.__demo.find({ text: "^Let AI play", tag: "button" })`, 120_000, "the co-pilot's button");
    await sleep(1500);
    // What the agent's model answers, kept to tell afterwards whether it played or the fallback numbers did.
    await page.evaluate(`(() => { window.__advice = []; const real = window.fetch; window.fetch = async (...args) => { const res = await real(...args);
      try { const url = String(args[0]?.url ?? args[0]); if (/\\/api\\/agent(\\?|$)/.test(url)) res.clone().json().then((j) => { if ("plan" in j) window.__advice.push({ driver: j.driver ?? null, fallback: Boolean(j.fallback), problem: j.problem ?? null, ms: j.ms ?? null, reason: String(j.reason ?? "").slice(0, 90) }); }).catch(() => undefined); } catch {}
      return res; }; })()`);
    await page.take(dir, "n3-selfplay", async () => {
      await sleep(900);
      await page.click({ text: "^Let AI play", tag: "button" });
      await sleep(26_000);
    });
    console.log(`selfplay: the model answered ${await page.evaluate("JSON.stringify(window.__advice)")}`);
    console.log(`selfplay: ${(await page.evaluate(`document.body.innerText.replace(/\\s+/g, " ").slice(0, 300)`)) ?? ""}`);
  },

  /** A price from another chain: what five NEAR cost in USDC on Base, asked of 1Click (NEAR Intents). Nothing is sent. */
  async chains(page) {
    await page.style("");
    await guest(page);
    await page.goto(`${PLAY}/account`, 3000);
    await page.until(`window.__demo.find({ text: "^Other chains", tag: "button" })`, 60_000, "the account");
    const address = `0x${randomBytes(20).toString("hex")}`;
    await page.take(dir, "n4-chains", async () => {
      await sleep(900);
      await page.click({ text: "^Other chains", tag: "button" }, { after: 900 });
      await page.hover(".fd-xchain__form select", 700);
      await sleep(1500);
      await page.click(".fd-xchain__form input[inputmode=decimal]", { ms: 500, after: 150 });
      await type(page, ".fd-xchain__form input[inputmode=decimal]", "5", 60);
      await page.click('.fd-xchain__form input[placeholder^="0x"]', { ms: 500, after: 150 });
      await type(page, '.fd-xchain__form input[placeholder^="0x"]', address, 8);
      await sleep(400);
      await page.click({ text: "^Get a quote", tag: "button" });
      await page.cut(() => page.until(`!window.__demo.find({ text: "^(Get a quote|Asking)", tag: "button" })`, 45_000, "the quote"));
      await page.evaluate(`document.querySelector(".fd-xchain")?.scrollIntoView({ block: "center", behavior: "smooth" })`);
      await sleep(5200);
    });
    console.log(`chains: ${(await page.evaluate(`(document.querySelector(".fd-xchain")?.innerText ?? "").replace(/\\s+/g, " ").slice(0, 500)`)) ?? ""}`);
  },

  /**
   * A free poker hand against the house on the round table: the shuffles, the two cards, bets to the end, who took the
   * pot. The waits between steps are cut. The clip's captions file says when the shuffle (S), the cards (H) and the
   * end (E) come.
   */
  async poker(page) {
    await page.style(`html { background: #4a0c09 !important; } body { transform: scale(0.82); transform-origin: 50% 0; }`);
    await page.goto(`${PLAY}/poker/tables`, 3500);
    if (await has(page, { text: "Play as a guest" })) await page.click({ text: "Play as a guest" }, { ms: 150 });
    await page.until(`window.__demo.find({ text: "^Play vs the House" })`, 60_000, "the poker desk");
    const say = `(document.querySelector(".pk-say")?.innerText ?? "")`;
    const bet = { text: "^(Check|Call \\d+)$", tag: "button" };
    const over = `/took the pot|shared the pot/.test(${say}) || /Hand 2/.test(document.querySelector(".pt-head")?.innerText ?? "")`;
    await page.take(dir, "n6-poker", async () => {
      await sleep(1500);
      await page.click({ text: "^Play vs the House" });
      await sleep(900);
      await page.cut(async () => {
        await page.until(`/[?&]t=/.test(location.search) && /shuffl/i.test(${say})`, 120_000, "the first shuffle");
        await page.evaluate("scrollTo(0, 0)");
        await sleep(500);
      });
      await page.caption("", "S");
      await sleep(5200);
      await page.cut(() => page.until(`window.__demo.find(${JSON.stringify(bet)})`, 180_000, "the first bet"));
      await page.caption("", "H");
      await sleep(4200);
      for (let bets = 0; bets < 14; bets++) {
        if (await has(page, bet)) await page.click(bet, { ms: 500, after: 900 });
        const ended = await page.cut(async () => {
          // The button stays while the bet is on its way: it has to go before the next one counts.
          for (let i = 0; i < 40 && (await has(page, bet)); i++) await sleep(400);
          for (let i = 0; i < 300; i++) {
            if (await page.evaluate(over).catch(() => false)) return true;
            if (await has(page, bet)) return false;
            await sleep(400);
          }
          return true;
        });
        if (ended) break;
        await sleep(700);
      }
      await page.caption("", "E");
      await sleep(5000);
    });
    console.log(`poker: ${await page.evaluate(say)}`);
  },

  /** The Arena trailer page: the next game. */
  async arena(page) {
    await page.style("");
    await page.goto(`${PLAY}/arena`, 3500);
    await page.take(dir, "n5-arena", async () => {
      await sleep(2600);
      await page.evaluate(`scrollBy({ top: 420, behavior: "smooth" })`);
      await sleep(3000);
      await page.evaluate(`scrollBy({ top: 420, behavior: "smooth" })`);
      await sleep(3000);
    });
  },
};

const order = ["wallets", "agents", "selfplay", "chains", "poker", "arena"];
const wanted = asked.length ? asked : order;
for (const name of wanted) if (!scenes[name]) throw new Error(`no scene ${name}: ${order.join(", ")}`);
const page = await open();
let failed = 0;
for (const name of order.filter((one) => wanted.includes(one))) {
  console.log(`— ${name}`);
  try {
    await scenes[name](page);
  } catch (error) {
    failed++;
    console.error(`${name} stopped: ${error.message}`);
  }
}
await page.close();
process.exit(failed ? 1 : 0);
