# Provenance

## Where this code comes from

The web app and the property-trading board game ("Cờ tỷ phú", Monopoly-style) were written before the hackathon, by the same author, as part of an earlier multi-game party-game platform called `lo-to` (Next.js 16 + React 19 + Three.js, realtime rooms on a Cloudflare Worker or an equivalent Node server). That platform also had Lô tô, Ma Sói, Cờ vua, Phiếu kín, Bom số, Xúc xắc, Kẻ giả mạo and a 3D "town" with Supabase sign-in. Only the property game and the shared code it needs were copied here.

- Source: a local working copy, `scratch-2026-11-02-148df9` (project folder created 2026-11-02).
- Version control: the source has **no git history**. `git -C <source> log -1 --format='%H %ci'` prints `fatal: not a git repository`, so there is no commit hash to cite. The dates below come from file-system timestamps (UTC).
- `games/co-ty-phu/` was created 2026-11-03T08:16Z; `games/co-ty-phu/board.ts` 2026-11-03T08:18Z; the lobby and room pages and the bot script 2026-11-03T08:32Z to 08:34Z. The source README records the platform deployed from 2026-11-03 on.
- **Caveat:** 17 of the copied files were last modified in the source on 2026-11-09 (UTC), before this extraction. A timestamp does not show what changed on that day, and there is no history to compare against:
  - 00:11Z to 00:14Z: `games/ma-soi/scene/hair.ts`, `tests/ma-soi-hair.test.ts`
  - 04:56Z to 05:24Z: `games/co-ty-phu/scene/city.ts`, `scene/textures.ts`, `scene/layout.ts`, `scene/tycoon.ts`, `components/Board3D.tsx`, `tests/co-ty-phu-scene.test.ts`
  - 07:04Z: `games/ma-soi/scene/state.ts`
  - 08:44Z to 08:47Z: `games/co-ty-phu/engine.ts`, `protocol.ts`, `view.ts`, `components/TycoonScreen.tsx`, `worker/co-ty-phu-room.ts`, `app/co-ty-phu/co-ty-phu.css`, `tests/co-ty-phu.test.ts`, `tests/co-ty-phu-room.test.ts`

The rules files were copied byte for byte. SHA-256 at extraction time, identical in the source and here:

| File | SHA-256 |
| --- | --- |
| `games/co-ty-phu/engine.ts` | `5d5811f9e12b96c5de9abb6b8d13c605df82af9f8fac76d253a129cafcfed962` |
| `games/co-ty-phu/board.ts` | `8b175258f62a2e5fb37ebe62ccd155da6a8446197d22fa025e52b508c12f836a` |
| `games/co-ty-phu/protocol.ts` | `4b8798436ca2ddb088dd1bb762b95f1b900ff4b8a8b3d8383c26c0804b44893f` |
| `games/co-ty-phu/view.ts` | `8239165750b9a57c538174ff9181b1f97b54456c6c09047564985f363423dfda` |

## What was copied

Copied unchanged unless they are listed under "Changed during extraction":

- Root: `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts`, `wrangler.jsonc`
- `app/`: `layout.tsx`, `globals.css`, `co-ty-phu/` (`page.tsx`, `layout.tsx`, `co-ty-phu.css`, `[code]/page.tsx`)
- `components/`: `PinForm.tsx`, `RoomAccessPanel.tsx`, `ServerPicker.tsx`, `SoundToggle.tsx`
- `games/co-ty-phu/`: the whole game (`board.ts`, `engine.ts`, `protocol.ts`, `view.ts`, `sound.ts`, `useRoom.ts`, `components/`, `scene/`)
- `games/ma-soi/` (the chibi characters only, no Ma Sói gameplay): `look.ts`, `sound.ts`, `wardrobe-tabs.ts`, `components/Wardrobe.tsx`, `scene/` (`chibi.ts`, `hair.ts`, `look-scene.ts`, `parts.ts`, `pets.ts`, `preview.ts`, `rides.ts`, `state.ts`, `textures.ts`)
- `games/town/` (only what the game and the chibi build need): `me.ts`, `bag.ts`, `items.ts`, `profile.ts`, `age.ts`, `chibi-draw.ts`, `chibi-entry.ts`, `chibi-catalog.ts`, `rooms.ts`
- `lib/`: `closeCodes.ts`, `config.ts`, `fonts.ts`, `random.ts`, `roomAccess.ts`, `roomCode.ts`, `roomTimers.ts`, `sound.ts`, `storage.ts`, `townAuth.ts`, `useCountdown.ts`, `usePin.ts`, `useSocket.ts`, `useWakeLock.ts`
- `worker/`: `index.ts`, `co-ty-phu-room.ts`, `tsconfig.json`
- `server/`: `index.ts`, `room-host.ts`, `register.mjs`, `resolve-cloudflare.mjs`, `cloudflare-shim.ts`, `tsconfig.json`, `package.json`, `Dockerfile`
- `scripts/`: `build-chibi.ts`, `co-ty-phu-bots.ts`
- `tests/`: `co-ty-phu.test.ts`, `co-ty-phu-room.test.ts`, `co-ty-phu-scene.test.ts`, `room-harness.ts`, `room-access.test.ts`, `room-code.test.ts`, `room-lobby.test.ts`, `server-http.test.ts`, `ma-soi-look.test.ts`, `ma-soi-hair.test.ts`, `town-chibi.test.ts`
- `public/town/chibi-v1.js` is not copied; `npm run build:chibi` generates it (it runs before `dev:web` and `build`).

## Changed during extraction

- `package.json`, `package-lock.json`: renamed to `deedlords`; only this game's scripts; dropped `@supabase/supabase-js` and `chess.js`.
- `wrangler.jsonc`: one Durable Object (`TycoonRoom`), a fresh `v1` migration, worker name `deedlords-room`, no Supabase vars.
- `worker/index.ts`, `server/index.ts`: only the property-game room and routes. Opening a room accepts local `dev:<name>` identities when `TOWN_DEV_AUTH=1` (`npm run dev:server`, `npm run dev:room`); Supabase verification stays optional and is not configured.
- `server/package.json`, `server/Dockerfile`: only `ws`, only this game's files.
- `games/town/rooms.ts`: no Supabase sign-in and no other games. Each device gets a local `dev:<hex>` identity to open rooms.
- `games/ma-soi/scene/state.ts`: kept only the types and helpers the chibi characters use; removed the Ma Sói-only `sceneFromView`.
- `next.config.ts`: the old links `/thi-tran`, `/choi-nhanh` and `/dang-nhap` redirect to `/co-ty-phu`.
- `app/page.tsx` (new): `/` redirects to `/co-ty-phu`.
- `tests/room-lobby.test.ts`, `tests/server-http.test.ts`: trimmed to this game.

## In-window work (NEAR HACKATHON, from 2026-11-09)

- Extraction of the property game into this standalone repo
- Rules engine aligned with `docs/ENGINE-RULES.md` for the Rust port: board and English card texts loaded from `shared/board.json`; integer `cityRents`; every random value through an injectable `Rng` (documented Fisher–Yates, dice drawn only after a roll is legal); cards drawn with replacement (`decks` removed); `round` and `maxRounds`; Blitz rules (deal, build once per city per turn, `builtThisTurn`, 75% house value); English log texts. New `tools/diff/` (snapshot, seeded recording Rng, trace generator with coverage table; `npm run diff:gen`, `npm run diff:check`) and tests for all of the above.
