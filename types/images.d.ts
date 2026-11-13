// What an imported image is to TypeScript (`import foil from "@/assets/plates/gold-foil.webp"`). Next.js writes the
// same line into next-env.d.ts, but only once it has run (`next dev`, `next build`), and that file is not kept in the
// repository: with this one, `npm run typecheck` passes on a fresh clone before anything has been built.
/// <reference types="next/image-types/global" />
