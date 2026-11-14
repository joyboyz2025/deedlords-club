// The demo film, scene by scene. Every picture is the live site, clicked through by `rec.mjs`: nothing is staged.
//
//   node tools/demo/film.mjs <out dir> [scene ...]      scenes: open room play proof poker mainnet close (all, in this order)
//   node tools/demo/film.mjs <out dir> join             joins the clips that are in <out dir> and writes captions.json
//
// room, play and proof are one table and go together: a free room of four seats, the filmed guest as its host, two
// more guests who join by its link from browsers of their own, and one AI agent on a NEAR AI model.
//
// DEMO_MAIN: the mainnet site (read only here: the landing, the receipts). DEMO_PLAY: the site the games are played
// on, the testnet one unless told otherwise (a guest's free table costs the sponsor of that site its gas).
// Waiting for the chain is cut where a caption says so; a move's own two seconds are left in.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const BUY = { text: "^Buy", tag: "button" };
const ROLL = { text: "^(ROLL|AGAIN)", tag: "button" };
const END = { text: "^END", tag: "button" };
const BUILD = { text: "^Build a (house|hotel)", tag: "button" };
const PLAY_TICKET = { text: "^Play a ticket", tag: "button" };
/** The table that room opens and play and proof go on with: its id, its host, the other players' browsers. */
const table = { id: "", host: "", seat: 0, ticket: null, friends: [], playing: false };

/** The match as the contract has it, read from a public node (the testnet one: the film plays its games there). */
async function chainMatch(id) {
  if (NET !== "testnet") throw new Error("the film reads the table's state from testnet only");
  for (let tries = 0; ; tries++) {
    try {
      const response = await fetch("https://test.rpc.fastnear.com", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "optimistic", account_id: "game.deedlords.testnet", method_name: "get_match", args_base64: Buffer.from(JSON.stringify({ id })).toString("base64") } }),
      });
      return JSON.parse(Buffer.from((await response.json()).result.result).toString());
    } catch (error) {
      if (tries >= 4) throw error;
      await sleep(1500);
    }
  }
}

const scenes = {
  /** The problem, and the claim, over the mainnet landing. */
  async open(page) {
    await page.style("");
    await page.goto(`${MAIN}/`, 2500);
    await page.take(dir, "1-open", async () => {
      await page.caption("Online games for money ask you to trust <b>somebody's server</b> with the deck, the dice and the pot.", "C1");
      await sleep(4600);
      await page.caption("At Deedlords Club the dealer, the referee and the bank are <b>NEAR contracts</b>. Fully on chain, live on mainnet.", "C2");
      await sleep(3200);
      await page.hover({ text: "^Play Deedlords" }, 900);
      await sleep(2000);
    });
  },

  /**
   * A free room of four: the filmed guest opens it, two more guests join by its link from their own browsers, an AI
   * agent on a NEAR AI model takes the last seat, and the host starts. Leaves the page at the board, the game begun.
   * Taken again (up to three times) when the host is dealt only a Takeover, which can almost never be played.
   */
  async room(page) {
    await page.style(BOARD_ROOM);
    // The two other players: guests in browsers of their own, not filmed. Made ready before the camera runs.
    for (let k = table.friends.length; k < 2; k++) {
      const friend = await open({ width: 900, height: 640, scale: 1 });
      await friend.goto(`${PLAY}/play`, 3000);
      await friend.until(`window.__demo.find({ text: "Play as a guest" })`, 60_000, "a friend's sign-in");
      await friend.click({ text: "Play as a guest" }, { ms: 150 });
      await friend.until(`window.__demo.find({ text: "^Play vs" })`, 60_000, "a friend's desk");
      table.friends.push(friend);
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      await page.goto(`${PLAY}/play`, 3000);
      await page.take(dir, "2-room", async () => {
        await page.caption(`No wallet, no seed phrase, no NEAR: a guest gets a <b>NEAR account</b> in one tap. <span style="opacity:.7">(${NET} site)</span>`, "C3");
        await sleep(1200);
        if (await has(page, { text: "Play as a guest" })) await page.click({ text: "Play as a guest" });
        await page.cut(() => page.until(`window.__demo.find({ text: "^Play vs" })`, 30_000, "the desk"));
        await sleep(1700);
        await page.click({ text: "^Friends" }, { after: 500 });
        await page.caption("Open a free room for four. <b>Players join by a link</b>, and an AI agent takes the last seat.", "C4");
        await page.click({ text: "^Table options", tag: "summary" }, { after: 500 });
        await page.click({ text: "^4$", within: '[aria-labelledby="fd-seats"]', tag: "button" }, { ms: 500, after: 500 });
        await page.click({ text: "^1$", within: '[aria-labelledby="fd-bots"]', tag: "button" }, { ms: 500, after: 600 });
        // The agent's model: one NEAR AI runs in a TEE. A native menu does not show on film, so the choice is set and pointed at.
        const model =
          await page.evaluate(`(() => { const sel = document.querySelector(".fd-more select"); const opt = sel && [...sel.options].find((o) => /^near:Qwen\\/Qwen3\\.6/.test(o.value)); if (!opt) return null;
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, opt.value); sel.dispatchEvent(new Event("change", { bubbles: true })); return opt.value; })()`);
        if (!model) throw new Error("no NEAR AI model is offered on this site");
        await sleep(1800);
        await page.caption("The agent is a model running inside a hardware enclave at <b>NEAR AI Cloud</b>.", "C5");
        await page.hover(".fd-more select", 700);
        await sleep(3400);
        await page.click({ text: "^Open a room of 4" });
        await sleep(1000);
        await page.cut(async () => {
          await page.until(`/^\\/play\\/f-/.test(location.pathname) && window.__demo.find({ text: "^Invite" })`, 120_000, "the room");
          await page.evaluate("scrollTo(0, 0)");
          await sleep(1500);
        });
        table.id = (await page.evaluate("location.pathname")).split("/").pop();
        table.host = (await chainMatch(table.id)).meta.host;
        await page.caption('The room is open and the AI has its seat. <span style="opacity:.7">(opening it on chain: ten seconds, cut)</span> Now the link goes to two more players.', "C6a");
        await sleep(3600);
        // The others come in by the link, one after the other; the wait for their seats is cut.
        await page.cut(async () => {
          for (const friend of table.friends) {
            await friend.goto(`${PLAY}/play/${table.id}`, 3000);
            await friend.until(`window.__demo.find({ text: "^Take seat" })`, 90_000, "a friend's seat");
            await friend.click({ text: "^Take seat" }, { ms: 150 });
            for (let i = 0; i < 60; i++) {
              const seats = (await chainMatch(table.id)).meta.seats;
              if (seats.filter((seat) => seat.backer).length >= 2 + table.friends.indexOf(friend) + 1) break;
              await sleep(1000);
            }
          }
          await page.until(`window.__demo.find({ text: "^Start the game" })`, 90_000, "the host's start button");
          await sleep(1200);
        });
        await page.caption("Three players and one AI. Every seat is a NEAR account, and <b>the club pays the gas</b>.", "C6");
        await sleep(4200);
        await page.click({ text: "^Start the game" });
        await sleep(900);
        await page.cut(async () => {
          await page.until(`document.querySelector("canvas") && document.querySelector(".tp-hud")`, 120_000, "the board");
          await sleep(2500);
        });
      });
      await page.evaluate("window.confirm = () => false");
      const match = await chainMatch(table.id);
      table.seat = match.meta.seats.findIndex((seat) => seat.backer === table.host);
      const held = match.game.tickets?.held[match.meta.seats[table.seat].player] ?? [];
      table.ticket = ["steps", "festival", "waiver"].find((ticket) => held.includes(ticket)) ?? null;
      console.log(`room ${table.id}: the host sits in seat ${table.seat + 1} and holds ${JSON.stringify(held)}`);
      if (table.ticket || attempt === 3) break;
      console.log("only a Takeover in hand: the room is taken again");
    }
  },

  /** The game of that room at real speed: turns of four seats, the world in the middle, a ticket, the leader, an AI turn. */
  async play(page) {
    if (!table.id) throw new Error("play follows room: no table is open");
    await page.style(BOARD_ROOM);
    // The other two players play their own turns from their own pages while the camera runs.
    table.playing = true;
    for (const friend of table.friends) {
      void (async () => {
        await friend.evaluate("window.confirm = () => false").catch(() => undefined);
        while (table.playing) {
          for (const spec of [BUY, ROLL, END]) {
            if (await has(friend, spec)) {
              await friend.click(spec, { ms: 120, after: 200 }).catch(() => undefined);
              break;
            }
          }
          await sleep(500);
        }
      })();
    }
    const press = (spec, options) => page.click(spec, options).then(() => true, () => false);
    const TICKET_WORDS = {
      steps: "Special tickets bend the rules. <b>Pick your steps</b>: land exactly where you want.",
      waiver: "Special tickets bend the rules. <b>Rent waiver</b>: the next rent is not charged.",
      festival: "Special tickets bend the rules. <b>Festival</b>: double rent in your cities until your next turn.",
    };
    await page.take(dir, "3-play", async () => {
      const started = Date.now();
      const filmed = () => (Date.now() - started) / 1000;
      const beats = {
        C9: "The middle of the board is the world: every roll is a <b>flight</b>, every pin a city somebody owns.",
        C11: "Whoever leads on net worth <b>pays double rent</b>, so the table stays open to the last round.",
        C12: "The AI agent plays its whole turn in <b>one transaction</b> of its own.",
      };
      const shown = new Set();
      await page.caption("From here the film runs at <b>real speed</b>. The contract rolls the dice, moves the money and keeps the clock.", "C7");
      let holdUntil = 7;
      let saidC8 = false;
      let ticketDone = !table.ticket;
      for (;;) {
        const now = filmed();
        if (now > 100) break;
        if (now >= holdUntil) {
          if (!saidC8) {
            saidC8 = true;
            await page.caption("Every move is a <b>transaction</b>. No wallet pop-up: a key that can only call the game signs it.", "C8");
            holdUntil = now + 7.5;
          } else {
            const next = ["C9", "C11", "C12"].find((id) => !shown.has(id) && (id !== "C12" || ticketDone || now > 75));
            if (next) {
              shown.add(next);
              await page.caption(beats[next], next);
              holdUntil = filmed() + 8;
            } else if (shown.has("C12")) break;
          }
        }
        // The host's own turn. A ticket that can be played now is played once the first two captions have been read.
        if (!ticketDone && saidC8 && filmed() >= holdUntil - 1 && (await has(page, PLAY_TICKET))) {
          await page.caption(TICKET_WORDS[table.ticket], "C10");
          await press(PLAY_TICKET, { ms: 500, after: 900 });
          if (table.ticket === "steps") {
            await press({ text: "^Choose the steps", tag: "button" }, { ms: 500, after: 900 });
            // An own city if one is in reach (a house can then go up there), else a city for sale, else seven steps.
            await page.evaluate(`(() => { const tiles = [...document.querySelectorAll(".tp-step")]; const pick = tiles.find((t) => /yours/.test(t.innerText)) ?? tiles.find((t) => /for sale/.test(t.innerText)) ?? tiles[5]; pick?.setAttribute("data-pick", "1"); })()`);
            await sleep(1500);
            await press(".tp-step[data-pick]", { ms: 700, after: 600 });
          } else await press({ text: "^Play (Rent waiver|Festival)", tag: "button" }, { ms: 700, after: 600 });
          ticketDone = true;
          holdUntil = filmed() + 9;
          continue;
        }
        if (await has(page, BUY)) await press(BUY, { ms: 400, after: 300 });
        else if (await has(page, BUILD)) await press(BUILD, { ms: 400, after: 500 });
        else if (await has(page, ROLL)) await press(ROLL, { ms: 400, after: 300 });
        else if (await has(page, END)) await press(END, { ms: 400, after: 300 });
        else await sleep(250);
      }
    });
  },

  /** The table's receipts, then the proof of the AI's move, checked in the browser. Expects the page at the table. */
  async proof(page) {
    await page.style(BOARD_ROOM);
    await page.take(dir, "4-proof", async () => {
      await page.caption("Open the receipts: each row is a real transaction on NEAR.", "C13");
      await page.click('button[title="Transactions"]', { after: 700 });
      await page.cut(() => page.until(`document.querySelector("a.dl-ledger__tee")`, 150_000, "a TEE-signed row (the indexer is a little behind the chain)"));
      await sleep(2600);
      await page.caption("This move carries a signature from the enclave the model ran in.", "C14");
      await page.hover("a.dl-ledger__tee", 800);
      await sleep(1700);
      const href = await page.evaluate(`document.querySelector("a.dl-ledger__tee").href`);
      await page.cut(async () => {
        await page.goto(href, 1000);
        await page.until(`/it holds|does not hold/.test(document.body.innerText)`, 60_000, "the verdict");
        await sleep(800);
      });
      await page.caption("<b>Anyone can audit the AI.</b> Five checks, run in your own browser: this model made this move, and nobody changed it.", "C15");
      await sleep(3200);
      await page.scrollTo(".fd-verify", 140, 1300);
      await sleep(4600);
    });
    // The other players' browsers have done their part.
    table.playing = false;
    await sleep(700);
    for (const friend of table.friends.splice(0)) await friend.close();
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
    await page.take(dir, "5-poker", async () => {
      await page.caption("Poker, with <b>no dealer</b>.", "P1");
      await sleep(1300);
      await page.click({ text: "^Play vs the House" });
      await sleep(1100);
      await page.cut(async () => {
        await page.until(`/[?&]t=/.test(location.search) && /shuffl/i.test(${say})`, 90_000, "the first shuffle");
        await page.evaluate("scrollTo(0, 0)");
        await sleep(600);
      });
      await page.caption("Each seat shuffles the deck under its own key and proves the shuffle in <b>zero knowledge</b>. The contract checks every proof.", "P2");
      await sleep(4700);
      await page.cut(() => page.until(`/your turn/i.test(${say})`, 150_000, "the first bet"));
      await page.caption("Your two cards are yours alone. <b>Nobody can read them</b>, not the house, not us, until you show them.", "P3");
      await sleep(4200);
      // Call or check to the end of the hand. The waits between the streets (shares, proofs, the house's bet) are cut.
      const words = [
        "Every bet is a transaction; the contract holds the pot and pays it.",
        "A card turns only when every seat has given its share of the key, each share proved to the contract.",
      ];
      let sealedShown = false;
      for (let bets = 0; bets < 14; bets++) {
        if (await has(page, myBet)) {
          if (words.length) await page.caption(words.shift(), words.length === 1 ? "P4" : "P6");
          await sleep(bets === 0 ? 900 : 400);
          await page.click(myBet, { ms: 500, after: bets < 2 ? 1200 : 700 });
        }
        // Once the house has bet: what it thought is there, sealed.
        if (!sealedShown && (await page.evaluate(`[...document.querySelectorAll(".pk-voice")].some((v) => /sealed until/.test(v.innerText))`).catch(() => false))) {
          sealedShown = true;
          await page.caption("The house is an AI. What it thinks while the hand is played stays <b>sealed</b>: it would give its cards away.", "P5");
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
      await page.caption("The hand is over: the contract has paid the pot, and the AI's thoughts are <b>opened</b>.", "P7");
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
    await page.take(dir, "6-mainnet", async () => {
      await page.caption("All of it is <b>live on NEAR mainnet</b>. Real transactions, with what each one cost.", "M1");
      await sleep(2600);
      await page.hover(".lp-ledger--receipts li a", 900);
      await page.caption("A real shuffle: 52 encrypted cards and their proof in <b>one transaction</b>, checked by the contract for 0.021 NEAR.", "M2");
      await sleep(4600);
      await page.cut(async () => {
        await page.goto("about:blank", 300);
        await page.evaluate(`(() => { document.open(); document.write(${JSON.stringify(TERMINAL)}); document.close(); })()`);
        await page.style("");
        await sleep(400);
      });
      await page.caption("Don't trust the film: <b>one command</b> checks every claim against mainnet. No key, nothing sent.", "M3");
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
    await page.take(dir, "7-close", async () => {
      await page.caption("Play free in ten seconds, or stake real NEAR. A missing stake is quoted from <b>other chains</b> through NEAR Intents.", "Z1");
      await sleep(5600);
      await page.scrollTo("#check", 70, 1500);
      await page.caption("<b>deedlords-club.vercel.app</b> · open source · built at NEAR HACKATHON", "Z2");
      await sleep(6400);
    });
  },
};

const order = ["open", "room", "play", "proof", "poker", "mainnet", "close"];
const CLIPS = ["1-open", "2-room", "3-play", "4-proof", "5-poker", "6-mainnet", "7-close"];

/** Joins the clips in `dir` and writes captions.json: every named caption with its time in the joined film. */
function joinFilm() {
  const missing = CLIPS.filter((name) => !existsSync(join(dir, `${name}.mp4`)));
  if (missing.length) throw new Error(`clips missing in ${dir}: ${missing.join(", ")}`);
  joinClips(
    CLIPS.map((name) => join(dir, `${name}.mp4`)),
    join(dir, "deedlords-club-demo.mp4"),
  );
  const captions = [];
  let offset = 0;
  for (const name of CLIPS) {
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", join(dir, `${name}.mp4`)], { encoding: "utf8" });
    const seconds = Number(probe.stdout.trim());
    const file = join(dir, `${name}.captions.json`);
    const said = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).captions : [];
    for (const one of said) captions.push({ id: one.id, at: Number((offset + one.at).toFixed(2)), clip: name, text: one.text });
    offset += seconds;
  }
  captions.forEach((one, i) => (one.until = Number((i + 1 < captions.length ? captions[i + 1].at : offset).toFixed(2))));
  writeFileSync(join(dir, "captions.json"), JSON.stringify({ seconds: Number(offset.toFixed(2)), captions }, null, 1));
  console.log(`joined: deedlords-club-demo.mp4, ${offset.toFixed(1)} s, ${captions.length} captions`);
}

if (asked.length === 1 && asked[0] === "join") {
  joinFilm();
  process.exit(0);
}
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
  table.playing = false;
  for (const friend of table.friends) await friend.close().catch(() => undefined);
  await page.close();
}
if (!failed && !asked.length) joinFilm();
process.exit(failed ? 1 : 0);
