// A check of the ticket rules in the browser, on the LOCAL sandbox only (contracts/sandbox/dev.js): a headless Chrome
// opens the site as a guest, sits at a free table against the house agent, and plays. Stills go to --out.
//
//   node tools/demo/tickets-check.mjs --expect tickets --out tmp/shots/desktop
//   node tools/demo/tickets-check.mjs --expect tickets --phone --out tmp/shots/phone
//   node tools/demo/tickets-check.mjs --expect plain --out tmp/shots/old-contract     (the helper runs a wasm from before tickets)
//
// `tickets`: the contract lists the rules, so the table opened has them. The guest's tickets are in the turn's corner;
// the check opens them, plays one, and plays on until the house agent has played one too and the table has said so.
// `plain`: the contract does not list them. The table opened is the one of before, and nothing of tickets is on it.
// Exit code 1 when what was expected did not show. --site (default http://localhost:3300), --minutes (default 6).
// --want "Pick your steps": tables are opened until the guest is dealt that ticket (at most six), to see it played.
// --gate <match id>: only a still of that match's gate (a lobby the helper opened), with what it says of the rules.
// --agents 3: the table is opened against that many house agents (1 to 3), so a table of up to four seats.

import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { open, sleep } from "./rec.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const SITE = option("site", "http://localhost:3300");
const OUT = option("out", "tmp/shots");
const EXPECT = option("expect", "tickets");
const PHONE = args.includes("--phone");
const MINUTES = Number(option("minutes", "6"));
const WANT = option("want", "");
const GATE = option("gate", "");
const AGENTS = Number(option("agents", "1"));
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(SITE)) throw new Error("this check only runs against a site on this machine");

const has = (page, spec) => page.evaluate(`Boolean(window.__demo.find(${JSON.stringify(spec)}))`).catch(() => false);
const text = (page, selector) => page.evaluate(`(document.querySelector(${JSON.stringify(selector)})?.innerText ?? "").replace(/\\s+/g, " ").trim()`).catch(() => "");
/**
 * Presses a button where it is at that instant, not where a pointer on its way saw it: the table's side columns are
 * laid out again when the turn passes, and a pointer then lands beside what it aimed at. `false`: no such button.
 */
async function press(page, spec, after = 1200) {
  const pressed = await page.evaluate(`(() => { const el = window.__demo.find(${JSON.stringify(spec)}); if (!el) return false; el.click(); return true; })()`);
  await sleep(after);
  return pressed;
}
const openHand = (page) => press(page, ".tp-hand");
/** A pointer's click on a button of the turn (the dice, a purchase). The room may have moved first and taken the button away: then nothing is clicked. */
const tap = (page, spec) => page.click(spec, { ms: 200, after: 200 }).catch(() => undefined);
let shots = 0;
async function shot(page, name) {
  const { result } = await page.send("Page.captureScreenshot", { format: "png" });
  const file = join(OUT, `${String(++shots).padStart(2, "0")}-${name}.png`);
  await writeFile(file, Buffer.from(result.data, "base64"));
  console.log(`  still: ${file}`);
}

mkdirSync(OUT, { recursive: true });
const page = await open(PHONE ? { width: 390, height: 844, scale: 2, gl: "soft" } : { width: 1280, height: 800, scale: 1, gl: "soft" });
const failures = [];
const expect = (ok, what) => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
try {
  if (GATE) {
    await page.goto(`${SITE}/play/${GATE}`, 4000);
    if (await has(page, { text: "Play as a guest" })) await page.click({ text: "Play as a guest" });
    await page.until(`document.querySelector(".fd-terms")`, 60_000, "the gate");
    const terms = await text(page, ".fd-terms");
    await page.evaluate(`document.querySelector(".fd-terms").scrollIntoView({ block: "center" })`);
    await sleep(600);
    await shot(page, "gate");
    if (EXPECT === "tickets")
      expect(
        /Special tickets/i.test(terms) &&
          /Rent waiver\./.test(terms) &&
          /Pick your steps\./.test(terms) &&
          /Takeover\./.test(terms) &&
          /Festival\./.test(terms) &&
          /leads on net worth pays double rent/.test(terms),
        "the gate says each ticket and the leader's rent",
      );
    else expect(!/ticket|Festival|leads on net worth/i.test(terms), "the gate says nothing of tickets");
    expect(!(await page.evaluate(`document.documentElement.scrollWidth > window.innerWidth + 1`)), "the gate is no wider than the screen");
    throw null;
  }
  await page.goto(`${SITE}/play`, 3000);
  await page.click({ text: "Play as a guest" });
  await page.until(`window.__demo.find({ text: "^Play vs" })`, 60_000, "the desk");
  await sleep(800);
  if (AGENTS > 1) {
    await press(page, { text: "^Table options", tag: "summary" }, 600);
    await press(page, { text: `^${AGENTS}$`, tag: "button", within: '[aria-labelledby="fd-agents"]' }, 600);
  }
  const lede = await text(page, ".fd-stub .fd-fine, .fd-more");
  await shot(page, "desk");
  await page.click({ text: "^Play vs" });
  await page.until(`/^\\/play\\/f/.test(location.pathname) && document.querySelector("canvas") && document.querySelector(".tp-hud")`, 120_000, "the table");
  for (let tries = 1; WANT && tries < 6; tries++) {
    await sleep(2500);
    const held = await page.evaluate(`document.querySelector(".tp-hand")?.getAttribute("aria-label") ?? ""`);
    if (held.includes(WANT)) break;
    console.log(`  dealt "${held}", not ${WANT}: another table`);
    await page.goto(`${SITE}/play`, 3000);
    await page.until(`window.__demo.find({ text: "^Play vs" })`, 60_000, "the desk");
    await page.click({ text: "^Play vs" });
    await page.until(`/^\/play\/f/.test(location.pathname) && document.querySelector("canvas") && document.querySelector(".tp-hud")`, 120_000, "the table");
  }
  const id = await page.evaluate(`location.pathname.split("/").pop()`);
  console.log(`table ${id} (${PHONE ? "phone" : "desktop"} width, expecting ${EXPECT})`);
  await sleep(2500);
  await shot(page, "table");

  if (EXPECT === "plain") {
    // A contract from before tickets: today's table, and not a word of tickets on it.
    const until = Date.now() + Math.min(MINUTES, 1.5) * 60_000;
    while (Date.now() < until) {
      if (await has(page, { text: "^Buy", tag: "button" })) await tap(page, { text: "^Buy", tag: "button" });
      else if (await has(page, { text: "^(ROLL|AGAIN|END)", tag: "button" })) await tap(page, { text: "^(ROLL|AGAIN|END)", tag: "button" });
      else await sleep(250);
    }
    expect(!(await page.evaluate(`Boolean(document.querySelector(".tp-hand, .tp-pip, .tp-news, .tp-hud__x2"))`)), "nothing of tickets on the table");
    await press(page, 'button[aria-label^="More"]');
    await press(page, { text: "^Rules$", tag: "button", within: ".tp-more" });
    const rules = await text(page, ".tp-rules");
    expect(rules.length > 200 && !/ticket|Festival|Takeover|leads on net worth/i.test(rules), "the rules sheet is the one of before");
    expect(!/special tickets|leads on net worth/i.test(lede), "the desk promises no tickets");
    await shot(page, "rules");
  } else {
    expect(await has(page, ".tp-hand"), "the guest's tickets are in the turn's corner");
    expect(await page.evaluate(`document.querySelectorAll(".tp-hud__pips .tp-pip").length >= ${AGENTS + 1}`), "every seat's card shows the tickets it holds");
    // The rules sheet says each ticket and the leader's rent.
    await press(page, 'button[aria-label^="More"]');
    await press(page, { text: "^Rules$", tag: "button", within: ".tp-more" });
    const rules = await text(page, ".tp-rules");
    expect(
      /Rent waiver/.test(rules) && /Pick your steps/.test(rules) && /Takeover/.test(rules) && /Festival/.test(rules) && /leads on net worth pays double rent/.test(rules),
      "the rules sheet says each ticket and the leader's rent",
    );
    await shot(page, "rules");
    await press(page, { text: "^Close$", tag: "button" }, 600);

    const news = new Set();
    let played = null;
    let opened = false;
    let overflow = false;
    const until = Date.now() + MINUTES * 60_000;
    const mine = () =>
      page.evaluate(`[...document.querySelectorAll(".tp-hud__name")].find((el) => /\\(you\\)/.test(el.innerText))?.innerText.replace(/\\s*\\(you\\)/, "").trim() ?? ""`);
    const me = await mine();
    const agentPlayed = () => [...news].some((line) => / plays /.test(line) && !line.startsWith(`${me} `));
    while (Date.now() < until && !(played && agentPlayed() && [...news].some((line) => line.startsWith(`${me} `)))) {
      const line = await text(page, ".tp-news");
      if (line && !news.has(line)) {
        news.add(line);
        console.log(`  the table says: ${line}`);
        if (news.size <= 6 || (/ plays /.test(line) && !line.startsWith(`${me} `))) await shot(page, `news-${news.size}`);
      }
      overflow ||= await page.evaluate(`document.documentElement.scrollWidth > window.innerWidth + 1`);
      const myTurn = await has(page, { text: "^(ROLL|AGAIN)", tag: "button" });
      if (!opened && (await has(page, ".tp-hand"))) {
        // Once, whoever's turn it is: the sheet of the guest's tickets, with what each does.
        await openHand(page);
        const sheet = await text(page, ".tp-tickets");
        expect(/Your tickets/.test(sheet) && /You hold \d of 2/.test(sheet), "the sheet lists the guest's tickets with what each does");
        await shot(page, "tickets-sheet");
        await press(page, { text: "^Close$", tag: "button", within: ".tp-tickets" }, 500);
        opened = true;
      } else if (myTurn && !played && (await has(page, ".tp-hand.tp-btn--main"))) {
        // A ticket can be played now: open the sheet and play it.
        await openHand(page);
        if (await has(page, { text: "^Choose the steps", tag: "button", within: ".tp-tickets" })) {
          await page.click({ text: "^Choose the steps", tag: "button", within: ".tp-tickets" }, { ms: 200, after: 500 });
          await shot(page, "pick-steps");
          played = `Pick your steps (${await text(page, ".tp-step:nth-child(6)")})`;
          await page.click(".tp-step:nth-child(6)", { ms: 200, after: 300 });
        } else if (await has(page, { text: "^Play ", tag: "button", within: ".tp-tickets" })) {
          played = await page.evaluate(`window.__demo.find({ text: "^Play ", tag: "button", within: ".tp-tickets" }).innerText.trim()`);
          await shot(page, "play-ticket");
          await page.click({ text: "^Play ", tag: "button", within: ".tp-tickets" }, { ms: 200, after: 300 });
        } else await press(page, { text: "^Close$", tag: "button", within: ".tp-tickets" }, 400);
        if (played) {
          console.log(`  the guest played: ${played}`);
          await sleep(900);
          await shot(page, "after-playing");
        }
      } else if (await has(page, { text: "^Buy", tag: "button" })) await tap(page, { text: "^Buy", tag: "button" });
      else if (await has(page, { text: "^(ROLL|AGAIN|END)", tag: "button" })) await tap(page, { text: "^(ROLL|AGAIN|END)", tag: "button" });
      else await sleep(150);
    }
    await shot(page, "end");
    expect(Boolean(played), `the guest played a ticket (${played ?? "none"})`);
    expect(
      [...news].some((line) => line.startsWith(`${me} `)),
      "the guest's own ticket was announced",
    );
    expect(agentPlayed(), "the house agent played a ticket and the table said so");
    expect(!overflow, "the page never grew wider than the screen");
    console.log(`  everything the table said: ${JSON.stringify([...news])}`);
  }
} catch (error) {
  // `null`: the gate's still was all that was asked for.
  if (error !== null) {
    failures.push(String(error?.message ?? error));
    console.log(`  FAIL ${String(error?.message ?? error)}`);
    await shot(page, "failure").catch(() => undefined);
  }
} finally {
  await page.close();
}
console.log(failures.length ? `CHECK FAILED: ${failures.join("; ")}` : "CHECK PASSED");
process.exit(failures.length ? 1 : 0);
