const SHIM = new URL("./cloudflare-shim.ts", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") return { url: SHIM, shortCircuit: true };
  return nextResolve(specifier, context);
}
