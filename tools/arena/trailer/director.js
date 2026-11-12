// director.js: films the trailer on the open /arena page. It takes the page's own scene, stops its clock, and steps it
// one thirtieth of a second at a time: for each frame it places the camera, lets the scene draw, writes the captions
// over the picture and sends it to the recorder (record.mjs, which also serves this file).
//
// Everything on screen is the game's scene and the game's models. The fight is the engine's (fight.ts); the close-ups
// feed the scene single attack and cast events by hand. `?stills=30,200` sends only those frames, to check the shots.
const home = new URL(import.meta.url);
const stills = home.searchParams.get("stills")?.split(",").map(Number);
const W = 1920;
const H = 1080;
const FPS = 30;
const progress = (window.__trailer = { frame: 0, frames: 0, done: false, error: null });

/** The scene the match screen keeps in a ref: found through React's own bookkeeping, as this script is not part of the app. */
function pageScene() {
  const canvas = document.querySelector("canvas");
  let fiber = canvas[Object.keys(canvas).find((key) => key.startsWith("__reactFiber"))];
  for (; fiber; fiber = fiber.return) {
    for (let hook = fiber.memoizedState; hook && typeof hook === "object" && "memoizedState" in hook; hook = hook.next) {
      const held = hook.memoizedState?.current;
      if (held && typeof held.play === "function" && typeof held.showRoster === "function") return held;
    }
  }
  throw new Error("no Arena scene on this page");
}

const ease = (k) => k * k * (3 - 2 * k);
const mix = (a, b, k) => a.map((value, index) => value + (b[index] - value) * k);
const between = (t, start, end, edge = 0.35) => Math.max(0, Math.min(1, (t - start) / edge, (end - t) / edge));

async function film() {
  const s = pageScene();
  const [battle, data] = await Promise.all(["/fight.json", "/arena.json"].map((path) => fetch(home.origin + path).then((reply) => reply.json())));
  const unit = (id) => data.units.findIndex((def) => def.id === id);
  for (let waited = 0; (!s.files.size || !s.map) && waited < 100; waited++) await new Promise((resolve) => setTimeout(resolve, 200));
  await s.fetch(data.units.map((_, index) => index));

  const page = getComputedStyle(document.querySelector(".arena"));
  const display = getComputedStyle(document.querySelector(".arena-title")).fontFamily;
  const body = page.fontFamily;
  await Promise.all([document.fonts.load(`400 60px ${display}`), document.fonts.load(`700 40px ${body}`), document.fonts.load(`500 40px ${body}`)]);
  const GOLD = "#e8c15a";
  const TEXT = "#fff7e6";

  // The scene is taken over: its own frame loop and resizing stop, and it draws at the film's size.
  cancelAnimationFrame(s.frame);
  window.requestAnimationFrame = () => 0;
  s.resizeObserver.disconnect();
  s.renderer.setPixelRatio(1);
  s.renderer.setSize(W, H, false);
  s.camera.aspect = W / H;
  s.camera.updateProjectionMatrix();
  const film = Object.assign(document.createElement("canvas"), { width: W, height: H });
  const ctx = film.getContext("2d");

  const write = (text, x, y, size, { font = body, weight = 700, color = TEXT, alpha = 1, align = "left", spacing = 0 } = {}) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `${weight} ${size}px ${font}`;
    ctx.letterSpacing = `${spacing}px`;
    ctx.textAlign = align;
    ctx.textBaseline = "alphabetic";
    ctx.shadowColor = "rgba(8, 9, 16, 0.85)";
    ctx.shadowBlur = size * 0.35;
    ctx.shadowOffsetY = size * 0.05;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.restore();
  };
  const shade = (alpha) => {
    ctx.fillStyle = `rgba(8, 9, 16, ${alpha})`;
    ctx.fillRect(0, 0, W, H);
  };
  /** A dark band rising from the bottom edge, for captions to sit on. */
  const band = (alpha) => {
    const fall = ctx.createLinearGradient(0, H * 0.58, 0, H);
    fall.addColorStop(0, "rgba(8, 9, 16, 0)");
    fall.addColorStop(1, `rgba(8, 9, 16, ${0.82 * alpha})`);
    ctx.fillStyle = fall;
    ctx.fillRect(0, H * 0.58, W, H * 0.42);
  };
  const title = (alpha, sub) => {
    write("DEEDLORDS ARENA", W / 2, H / 2 + 20, 150, { font: display, weight: 400, color: GOLD, alpha, align: "center", spacing: 6 });
    write(sub, W / 2, H / 2 + 110, 44, { weight: 500, alpha, align: "center", spacing: 2 });
  };

  /** One blow or one cast of a close-up, as the engine would report it. */
  const duel = (hero, foe, heroCell) => {
    const keys = { hero: 21 + heroCell, foe: 3 };
    let hurt = 0;
    const event = (more, damage) => {
      const hp = Array(42).fill(0);
      hurt += damage;
      hp[keys.hero] = s.actors.find((actor) => actor.key === keys.hero).maxHp;
      hp[keys.foe] = Math.max(1, s.actors.find((actor) => actor.key === keys.foe).maxHp - hurt);
      s.apply({ t: 0, hp, shield: Array(42).fill(0), from: keys.hero, ...more });
    };
    const def = data.units[unit(hero)];
    return {
      start: () => s.setTeams([[{ unit: unit(foe), rank: 1, cell: 3 }], [{ unit: unit(hero), rank: 1, cell: heroCell }]]),
      cues: [
        { at: 0.45, run: () => event({ kind: "attack", to: keys.foe, dmg: def.atk }, def.atk) },
        { at: 1.4, run: () => event({ kind: "attack", to: keys.foe, dmg: def.atk }, def.atk) },
        { at: 2.3, run: () => event({ kind: "cast", op: def.ability.op, to: [keys.foe], amount: def.ability.amount }, def.ability.op === "dmg" ? def.ability.amount : 0) },
      ],
      text: (t, length) => {
        const alpha = between(t, 0.15, length - 0.1);
        band(alpha);
        write(def.name.toUpperCase(), 110, H - 170, 84, { font: display, weight: 400, color: GOLD, alpha, spacing: 2 });
        write(`${data.guilds[def.guild].name}  ·  ${data.roles[def.role].name}`, 114, H - 112, 34, { weight: 700, alpha, spacing: 1 });
        write(`${def.ability.name}: ${def.ability.text}`, 114, H - 62, 30, { weight: 500, alpha: alpha * 0.9 });
      },
    };
  };
  const near = { speed: 0.62, length: 3.3, from: [-3.0, 2.5, 5.7], to: [-2.4, 2.1, 4.9], look: [-0.7, 1.3, 0] };

  const shots = [
    {
      length: 4.2,
      start: () => s.setTeams(battle.teams),
      from: [0, 9, 17],
      to: [0, 6.6, 13.2],
      look: [0, 0.9, 0],
      text: (t, length) => {
        shade(0.3 * between(t, 0.3, length, 0.8));
        title(between(t, 0.7, length - 0.15, 0.6), "An auto-battler settled on NEAR");
      },
    },
    {
      length: 4.6,
      start: () => s.showRoster(),
      // A wave of blows runs along the ranks.
      cues: data.units.map((def, index) => ({
        at: 1.2 + def.role * 0.22 + def.guild * 0.1,
        run: () => {
          const actor = s.actors.find((each) => each.unit === index);
          actor.toward.set(0, 0, 1);
          actor.lunge = 0;
          s.show(actor, "Attack", true);
        },
      })),
      from: [-3.4, 2.0, 5.4],
      to: [3.2, 2.0, 5.4],
      look: [-3.0, 1.3, 0],
      lookTo: [2.4, 1.3, 0],
      text: (t, length) => {
        const alpha = between(t, 0.3, length - 0.1);
        band(alpha);
        write("16 UNITS  ·  4 GUILDS  ·  4 ROLES", W / 2, H - 90, 54, { font: display, weight: 400, color: GOLD, alpha, align: "center", spacing: 3 });
      },
    },
    { ...near, ...duel("hask", "tamsin", 3) },
    { ...near, ...duel("eel", "brann", 3) },
    { ...near, ...duel("ko", "jory", 17), from: [-4.6, 2.8, 3.4], to: [-3.8, 2.4, 2.8], look: [-0.6, 1.4, -1.3] },
    { ...near, ...duel("grigg", "mirela", 3) },
    {
      length: 3.4,
      start: () => s.setTeams(battle.teams),
      from: [5, 7, 11],
      to: [3.5, 6.2, 10],
      look: [0, 0.8, 0],
      text: (t, length) => {
        const alpha = between(t, 0.2, length - 0.1);
        shade(0.45 * alpha);
        write("BID IN SECRET.", W / 2, H / 2 - 40, 96, { font: display, weight: 400, color: GOLD, alpha: alpha * between(t, 0.2, length), align: "center", spacing: 3 });
        write("OPENED TOGETHER.", W / 2, H / 2 + 70, 96, { font: display, weight: 400, color: GOLD, alpha: alpha * between(t, 0.9, length), align: "center", spacing: 3 });
        write("Every round is committed, revealed and resolved by a NEAR contract", W / 2, H / 2 + 150, 36, { weight: 500, alpha: alpha * between(t, 1.5, length), align: "center" });
      },
    },
    {
      length: 0.6 + battle.result.ticks * 0.18 + 1.3,
      start: () => s.play(battle.teams, battle.events, () => {}),
      from: [-8, 7.5, 12],
      to: [5.5, 5.2, 9.2],
      look: [0, 0.9, 0],
      text: (t, length) => {
        const alpha = between(t, 0.3, 3.2);
        write("No dice in the fight: the same crews always fight the same way", W / 2, H - 70, 34, { weight: 500, alpha, align: "center" });
      },
    },
    {
      length: 4.2,
      from: [5.5, 5.2, 9.2],
      to: [2.5, 9, 14.5],
      look: [0, 0.9, 0],
      text: (t, length) => {
        shade(0.6 * between(t, 0, length + 1, 0.9));
        title(between(t, 0.5, length + 1, 0.6), "Playable on NEAR testnet");
        write("arena.deedlords.testnet", W / 2, H / 2 + 180, 34, { weight: 700, color: GOLD, alpha: between(t, 1.2, length + 1, 0.6), align: "center", spacing: 1 });
      },
    },
  ];

  progress.frames = shots.reduce((sum, shot) => sum + Math.round(shot.length * FPS), 0);
  let now = 1e6;
  s.last = now;
  let frame = 0;
  for (const [index, shot] of shots.entries()) {
    shot.start?.();
    const count = Math.round(shot.length * FPS);
    const fired = new Set();
    for (let step = 0; step < count; step++, frame++) {
      const t = step / FPS;
      const k = ease(step / (count - 1));
      (shot.cues ?? []).forEach((cue, which) => {
        if (t < cue.at || fired.has(which)) return;
        fired.add(which);
        cue.run();
      });
      s.setSpeed(shot.speed ?? 1);
      s.camera.position.set(...mix(shot.from, shot.to, k));
      s.camera.lookAt(...mix(shot.look, shot.lookTo ?? shot.look, k));
      s.tick((now += 1000 / FPS));
      progress.frame = frame;
      if (stills && !stills.includes(frame)) continue;
      ctx.drawImage(s.canvas, 0, 0, W, H);
      const dim = ctx.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, H * 1.05);
      dim.addColorStop(0, "rgba(8, 9, 16, 0)");
      dim.addColorStop(1, "rgba(8, 9, 16, 0.5)");
      ctx.fillStyle = dim;
      ctx.fillRect(0, 0, W, H);
      shot.text?.(t, shot.length);
      // Each shot comes up from black and goes back to it; the film's own first and last frames are black.
      const edge = Math.min(index === 0 ? t / 0.8 : t / 0.2, index === shots.length - 1 ? (shot.length - t) / 0.8 : (shot.length - t) / 0.2);
      if (edge < 1) shade(1 - Math.max(0, edge));
      // Not `toBlob`: a page in a background tab is made to wait for it.
      const picture = await (await fetch(film.toDataURL("image/jpeg", 0.93))).blob();
      await fetch(`${home.origin}/frame/${frame}`, { method: "POST", body: picture });
    }
  }
  progress.done = true;
}

film().catch((error) => {
  progress.error = String(error?.stack ?? error);
});
