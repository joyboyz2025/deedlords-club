// File vẽ nhân vật cho app HSK, đóng gói thành public/town/chibi-v1.js bằng npm run build:chibi.
// Cách gọi (phiên bản 1) ghi ở docs/superpowers/specs/2026-11-05-noi-app-hsk-dot-2-nhan-vat-design.md.

export * from "./chibi-catalog.ts";
export { drawFigure, drawPortrait, mountPreview } from "./chibi-draw.ts";
