// npm run build:chibi    Đóng gói file vẽ nhân vật cho app HSK: games/town/chibi-entry.ts cùng three thành public/town/chibi-v1.js.
// npm run build chạy bước này trước next build, nên mỗi lần deploy web game là file vẽ khớp với thị trấn. File ra không sửa tay.

import { build } from "esbuild";
import { fileURLToPath } from "node:url";

export const CHIBI_OUT = "public/town/chibi-v1.js";
const ROOT = fileURLToPath(new URL("..", import.meta.url));

export function buildChibi(outfile = CHIBI_OUT) {
  return build({
    absWorkingDir: ROOT,
    entryPoints: ["games/town/chibi-entry.ts"],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2020",
    minify: true,
    legalComments: "none",
    metafile: true,
    logLevel: "warning",
  });
}

if (import.meta.filename === process.argv[1]) {
  const result = await buildChibi();
  const [path, output] = Object.entries(result.metafile.outputs)[0];
  console.log(`Đã ghi ${path}: ${Math.round(output.bytes / 1024)} KB, ${output.exports.length} tên`);
}
