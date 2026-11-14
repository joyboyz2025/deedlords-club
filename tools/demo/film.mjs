// The demo film, scene by scene. Every picture is the live site, clicked through by `rec.mjs`: nothing is staged.
//
//   node tools/demo/film.mjs <out dir> [scene ...]      scenes: open board proof poker mainnet close (all, in this order)
//
// DEMO_MAIN: the mainnet site (read only here: the landing, the receipts). DEMO_PLAY: the site the games are played
// on, the testnet one unless told otherwise (a guest's free table costs the sponsor of that site its gas).
// Waiting for the chain is cut where a caption says so; a move's own two seconds are left in.

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { join_ as joinClips, open, sleep } from "./rec.mjs";

const MAIN = (process.env.DEMO_MAIN ?? "https://deedlords-club.vercel.app").replace(/\/$/, "");
const PLAY = (process.env.DEMO_PLAY ?? "https://deedlords-club-testnet.vercel.app").replace(/\/$/, "");
const NET = PLAY === MAIN ? "mainnet" : "testnet";
const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");
/** Under a full-screen board: a strip kept free for the caption, so that it does not lie over the squares. */
const BOARD_ROOM = `html, body { background: #170a06 !important; } .tp[data-view="3d"] { height: calc(100dvh - 104px) !important; min-height: 0 !important; }`;
/** A page taller than the picture (the poker table and the buttons under it): drawn a little smaller, with the same strip kept free. */
const TABLE_ROOM = `html { background: #4a0c09 !important; } body { transform: scale(0.84); transform-origin: 50% 0; }`;
/** A plain terminal for the output of a command that was really run. */
const TERMINAL = `<!doctype html><meta charset="utf-8"><style>
  html { background: #140806; } body { margin: 0; padding: 34px 56px 190px; color: #f3e6cf; font: 500 17px/1.5 ui-monospace, "SF Mono", Menlo, monospace; }
  p { margin: 0 0 14px; color: #f8c93f; } pre { margin: 0; font: inherit; white-space: pre-wrap; } i { color: #7fd69a; font-style: normal; } b { color: #fff7e6; }
</style><p>$ npm run check:live</p><pre></pre>`;

const [dir, ...asked] = process.argv.slice(2);
if (!dir) throw new Error("node tools/demo/film.mjs <out dir> [scene ...]");
mkdirSync(dir, { recursive: true });

const has = (page, spec) => page.evaluate(`Boolean(window.__demo.find(${JSON.stringify(spec)}))`).catch(() => false);
const text = (page, selector) => page.evaluate(`(document.querySelector(${JSON.stringify(selector)})?.innerText ?? "").replace(/\\s+/g, " ").trim()`).catch(() => "");

const scenes = {
  /** The problem, and the claim, over the mainnet landing. */
  async open(page) {
    await page.style("");
    await page.goto(`${MAIN}/`, 2500);
    await page.take(dir, "1-open", async () => {
      await page.caption("Online games for money ask you to trust <b>somebody's server</b> with the deck, the dice and the pot.");
      await sleep(4200);
      await page.caption("At Deedlords Club the dealer, the referee and the bank are <b>NEAR contracts</b>. Fully on chain, live on mainnet.");
      await sleep(2600);
      await page.hover({ text: "^Play Deedlords" }, 900);
      await sleep(1500);
    });
  },

  /** A guest sits down against an AI and they play a few turns of the board game. Leaves the page at the table. */
  async board(page) {
    await page.style(BOARD_ROOM);
    await page.goto(`${PLAY}/play`, 3000);
    await page.take(dir, "2-board", async () => {
      await page.caption(`No wallet, no seed phrase, no NEAR: a guest gets a <b>NEAR account</b> in one tap. <span style="opacity:.7">(${NET} site)</span>`);
      await sleep(1200);
      await page.click({ text: "Play as a guest" });
      await page.cut(() => page.until(`window.__demo.find({ text: "^Play vs" })`, 30_000, "the desk"));
      await sleep(1500);
      // The opponent: a model NEAR AI runs in a TEE. A native menu does not show on film, so the choice is set and pointed at.
      await page.click({ text: "^Table options", tag: "summary" }, { after: 500 });
      const model =
        await page.evaluate(`(() => { const sel = document.querySelector(".fd-more select"); const opt = sel && [...sel.options].find((o) => /^near:Qwen\\/Qwen3\\.6/.test(o.value)) ; if (!opt) return null;
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, opt.value); sel.dispatchEvent(new Event("change", { bubbles: true })); return opt.value; })()`);
      if (!model) throw new Error("no NEAR AI model is offered on this site");
      await page.caption("The opponent is an AI model running inside a hardware enclave at <b>NEAR AI Cloud</b>.");
      await page.hover(".fd-more select", 700);
      await sleep(2500);
      await page.click({ text: "^Play vs" });
      await sleep(1200);
      await page.cut(async () => {
        await page.until(`/^\\/play\\/f-/.test(location.pathname) && document.querySelector("canvas") && document.querySelector(".tp-hud")`, 90_000, "the board");
        await sleep(2500);
      });
      await page.caption(
        'The club opens the table on chain and pays a guest\'s gas. <span style="opacity:.7">(ten seconds, cut)</span> From here the film runs at <b>real speed</b>.',
      );
      // A few turns as they come: the dice when it is the guest's turn, a city when one is offered. The contract and
      // the AI take the time they take.
      const words = [
        [5.5, "Every move is a <b>transaction</b> on the game contract. The contract rolls the dice."],
        [13, "No wallet pop-up: a key that can only call the game signs each move, and the club pays the gas."],
        [21, "The AI plays its whole turn in one transaction of its own."],
      ];
      const started = Date.now();
      const filmed = () => (Date.now() - started) / 1000;
      while (filmed() < 30) {
        if (words.length && filmed() >= words[0][0]) await page.caption(words.shift()[1]);
        if (await has(page, { text: "^Buy", tag: "button" })) await page.click({ text: "^Buy", tag: "button" }, { ms: 450, after: 300 });
        else if (await has(page, { text: "ROLL", tag: "button" })) await page.click({ text: "ROLL", tag: "button" }, { ms: 450, after: 300 });
        else await sleep(300);
      }
    });
  },

  /** The table's receipts, then the proof of the AI's move, checked in the browser. Expects the page at the table. */
  async proof(page) {
    await page.style(BOARD_ROOM);
    await page.take(dir, "3-proof", async () => {
      await page.caption("Open the receipts: each row is a real transaction on NEAR.");
      await page.click('button[title="Transactions"]', { after: 700 });
      await page.cut(() => page.until(`document.querySelector("a.dl-ledger__tee")`, 150_000, "a TEE-signed row (the indexer is a little behind the chain)"));
      await sleep(2600);
      await page.caption("This move carries a signature from the enclave the model ran in.");
      await page.hover("a.dl-ledger__tee", 800);
      await sleep(1700);
      const href = await page.evaluate(`document.querySelector("a.dl-ledger__tee").href`);
      await page.cut(async () => {
        await page.goto(href, 1000);
        await page.until(`/it holds|does not hold/.test(document.body.innerText)`, 60_000, "the verdict");
        await sleep(800);
      });
      await page.caption("<b>Anyone can audit the AI.</b> Five checks, run in your own browser: this model made this move, and nobody changed it.");
      await sleep(3200);
      await page.scrollTo(".fd-verify", 140, 1300);
      await sleep(4200);
    });
  },

  /** A free poker table against the house: the shuffles, a hand bet to its end, what the house was thinking. */
  async poker(page) {
    await page.style(TABLE_ROOM);
    await page.goto(`${PLAY}/poker/tables`, 3500);
    if (await has(page, { text: "Play as a guest" })) {
      await page.click({ text: "Play as a guest" });
      await page.until(`window.__demo.find({ text: "^Play vs the House" })`, 30_000, "the poker desk");
    }
    const say = `(document.querySelector(".pk-say")?.innerText ?? "")`;
    const myBet = { text: "^(Check|Call \\d+)$", tag: "button" };
    const handOver = `[...document.querySelectorAll(".pk-voice")].some((v) => / in hand 1/.test(v.innerText)) || /Table settled/.test(document.body.innerText)`;
    await page.take(dir, "4-poker", async () => {
      await page.caption("Poker, with <b>no dealer</b>.");
      await sleep(1300);
      await page.click({ text: "^Play vs the House" });
      await sleep(1100);
      await page.cut(async () => {
        await page.until(`/[?&]t=/.test(location.search) && /shuffl/i.test(${say})`, 90_000, "the first shuffle");
        await page.evaluate("scrollTo(0, 0)");
        await sleep(600);
      });
      await page.caption("Each seat shuffles the deck under its own key and proves the shuffle in <b>zero knowledge</b>. The contract checks every proof.");
      await sleep(4700);
      await page.cut(() => page.until(`/your turn/i.test(${say})`, 150_000, "the first bet"));
      await page.caption("Your two cards are yours alone. <b>Nobody can read them</b>, not the house, not us, until you show them.");
      await sleep(4200);
      // Call or check to the end of the hand. The waits between the streets (shares, proofs, the house's bet) are cut.
      const words = [
        "Every bet is a transaction; the contract holds the pot and pays it.",
        "A card turns only when every seat has given its share of the key, each share proved to the contract.",
      ];
      let sealedShown = false;
      for (let bets = 0; bets < 14; bets++) {
        if (await has(page, myBet)) {
          if (words.length) await page.caption(words.shift());
          await sleep(bets === 0 ? 900 : 400);
          await page.click(myBet, { ms: 500, after: bets < 2 ? 1200 : 700 });
        }
        // Once the house has bet: what it thought is there, sealed.
        if (!sealedShown && (await page.evaluate(`[...document.querySelectorAll(".pk-voice")].some((v) => /sealed until/.test(v.innerText))`).catch(() => false))) {
          sealedShown = true;
          await page.caption("The house is an AI. What it thinks while the hand is played stays <b>sealed</b>: it would give its cards away.");
          await page.evaluate(`document.querySelector(".pk-voices")?.scrollIntoView({ block: "center", behavior: "smooth" })`);
          await sleep(3900);
        }
        const over = await page.cut(async () => {
          for (let i = 0; i < 300; i++) {
            if (await page.evaluate(handOver).catch(() => false)) return true;
            if (await has(page, myBet)) return false;
            await sleep(400);
          }
          return true;
        });
        if (over) break;
        await sleep(500);
      }
      if (/Table settled/.test(await page.evaluate("document.body.innerText"))) throw new Error("the table closed before the hand was shown: take it again");
      if (!(await page.evaluate(`[...document.querySelectorAll(".pk-voice")].some((v) => / in hand 1/.test(v.innerText))`)))
        throw new Error("the hand did not end with a thought to open: take it again");
      await page.caption("The hand is over: the contract has paid the pot, and the AI's thoughts are <b>opened</b>.");
      await page.evaluate(`document.querySelector(".pk-voices")?.scrollIntoView({ block: "center", behavior: "smooth" })`);
      await sleep(5200);
    });
  },

  /** Mainnet, read only: the receipts on the landing, then the command that checks the claims against the chain. */
  async mainnet(page) {
    await page.style("");
    // The command is run now, for real; its own output is what the film shows.
    const run = spawnSync("npm", ["run", "-s", "check:live"], { cwd: REPO, encoding: "utf8" });
    const lines = run.stdout.trimEnd().split("\n");
    if (run.status !== 0 || !/Every check passed/.test(run.stdout)) throw new Error(`npm run check:live did not pass:\n${run.stdout.slice(-600)}`);
    await page.goto(`${MAIN}/`, 2500);
    await page.evaluate(`document.querySelector(".lp-ledger--receipts").scrollIntoView({ block: "center" })`);
    await sleep(700);
    await page.take(dir, "5-mainnet", async () => {
      await page.caption("All of it is <b>live on NEAR mainnet</b>. Real transactions, with what each one cost.");
      await sleep(2600);
      await page.hover(".lp-ledger--receipts li a", 900);
      await page.caption("A real shuffle: 52 encrypted cards and their proof in <b>one transaction</b>, checked by the contract for 0.021 NEAR.");
      await sleep(4600);
      await page.cut(async () => {
        await page.goto("about:blank", 300);
        await page.evaluate(`(() => { document.open(); document.write(${JSON.stringify(TERMINAL)}); document.close(); })()`);
        await page.style("");
        await sleep(400);
      });
      await page.caption("Don't trust the film: <b>one command</b> checks every claim against mainnet. No key, nothing sent.");
      // The output as it came, a line at a time.
      await page.evaluate(`(async () => { const out = document.querySelector("pre"); const lines = ${JSON.stringify(lines)};
        const paint = (line) => line.replace(/[&<]/g, (c) => (c === "&" ? "&amp;" : "&lt;")).replace(/^(\\s*)✓/, '$1<i>✓</i>').replace(/^(\\d\\. .*|Every check passed\\.)$/, "<b>$1</b>");
        for (const line of lines) { out.insertAdjacentHTML("beforeend", paint(line) + "\\n"); scrollTo(0, document.body.scrollHeight); await new Promise((done) => setTimeout(done, line.trim() ? 150 : 60)); } })()`);
      await sleep(2400);
    });
  },

  /** The ways in, and where to go. */
  async close(page) {
    await page.style("");
    await page.goto(`${MAIN}/`, 2500);
    await page.evaluate(`document.querySelector(".lp-boarding").scrollIntoView({ block: "start" }); scrollBy(0, -60)`);
    await sleep(700);
    await page.take(dir, "6-close", async () => {
      await page.caption("Play free in ten seconds, or stake real NEAR, paid from <b>any chain</b> through NEAR Intents.");
      await sleep(4600);
      await page.scrollTo("#check", 70, 1500);
      await page.caption("<b>deedlords-club.vercel.app</b> · open source · built at NEAR HACKATHON");
      await sleep(4800);
    });
  },
};

const order = ["open", "board", "proof", "poker", "mainnet", "close"];
const wanted = asked.length ? asked : order;
for (const name of wanted) if (!scenes[name]) throw new Error(`no scene ${name}: ${order.join(", ")}`);
const page = await open();
let failed = false;
try {
  for (const name of order.filter((one) => wanted.includes(one))) {
    console.log(`— ${name}`);
    await scenes[name](page);
  }
} catch (error) {
  failed = true;
  console.error(`stopped: ${error.message}`);
} finally {
  await page.close();
}
if (!failed && !asked.length) {
  joinClips(
    ["1-open", "2-board", "3-proof", "4-poker", "5-mainnet", "6-close"].map((name) => join(dir, `${name}.mp4`)),
    join(dir, "deedlords-club-demo.mp4"),
  );
  console.log("joined: deedlords-club-demo.mp4");
}
process.exit(failed ? 1 : 0);
