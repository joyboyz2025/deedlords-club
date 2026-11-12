// record.mjs <work dir> [port]: the trailer's recorder. It hands the Arena page the director script, the fight written
// by fight.ts (<work dir>/fight.json) and the unit data, and saves the frames the page sends back to <work dir>/frames/.
// Only this machine can reach it.
//
// How a trailer is made, from the repo root, with the dev server running:
//   1. node --experimental-strip-types --import ./server/register.mjs tools/arena/trailer/fight.ts <work dir>/fight.json
//   2. node tools/arena/trailer/record.mjs <work dir>
//   3. on the open /arena page, in the browser's console:  import("http://localhost:4599/director.js")
//   4. ffmpeg -framerate 30 -i <work dir>/frames/f_%05d.jpg -c:v libx264 -pix_fmt yuv420p -crf 17 -movflags +faststart trailer.mp4
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const work = process.argv[2];
const port = Number(process.argv[3] ?? 4599);
mkdirSync(join(work, "frames"), { recursive: true });
const served = {
  "/director.js": [join(here, "director.js"), "text/javascript"],
  "/fight.json": [join(work, "fight.json"), "application/json"],
  "/arena.json": [join(here, "../../../shared/arena.json"), "application/json"],
};

createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
  if (request.method === "OPTIONS") return response.end();
  if (request.method === "GET" && served[url.pathname]) {
    const [file, type] = served[url.pathname];
    response.setHeader("Content-Type", type);
    response.setHeader("Cache-Control", "no-store");
    return response.end(readFileSync(file));
  }
  const frame = /^\/frame\/(\d+)$/.exec(url.pathname);
  if (request.method === "POST" && frame) {
    const parts = [];
    request.on("data", (part) => parts.push(part));
    request.on("end", () => {
      writeFileSync(join(work, "frames", `f_${frame[1].padStart(5, "0")}.jpg`), Buffer.concat(parts));
      response.end("ok");
    });
    return;
  }
  response.statusCode = 404;
  response.end();
}).listen(port, "127.0.0.1", () => console.log(`recorder on http://localhost:${port}, frames to ${join(work, "frames")}`));
