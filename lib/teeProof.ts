// Proof that an AI agent's move came from the model it names, run inside a Trusted Execution Environment.
//
// NEAR AI Cloud (https://docs.near.ai/cloud/verification) signs each completion: a model it runs in its own TEE signs
// `<model>:<sha256 of the request>:<sha256 of the response>` with a key that never leaves the enclave, and its public
// attestation report names that key's address, bound to the hardware quote. When an agent's plan comes from such a
// model, the plan's `turn` transaction carries the proof as one more argument (the contract reads only its own
// arguments, so the proof is simply kept on chain with the move):
//
//   * the exact response bytes, so anyone can read the plan in them and hash them again;
//   * the hash of the request, not the request: it holds the seat owner's secret instructions;
//   * the signature, its signer and its kind.
//
// Anyone can then check, from the transaction alone and NEAR AI's public report: that the response hashes to what was
// signed, that the signature recovers the signer, that the signer is the one NEAR AI attests for that model, and that
// the plan in the transaction is the plan in the response. The hardware quote itself is checked with NEAR AI's own
// Verification Center or `dcap-qvl`; this file does not parse Intel or NVIDIA evidence.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

export const NEAR_AI_URL = "https://cloud-api.near.ai/v1";
/** NEAR AI's own page that checks a model's hardware evidence in the browser: `?model=<id>`. */
export const VERIFICATION_CENTER = "https://cloud.near.ai/verify";

export type TeeProof = {
  v: 1;
  /** The canonical model id the request named. */
  model: string;
  /** The completion's id (`chatcmpl-…`). */
  chat: string;
  /** `provider_tee`: signed by the model's own enclave. `gateway`: by NEAR AI's gateway enclave, which relayed it. */
  kind: "provider_tee" | "gateway";
  algo: "ecdsa";
  /** The signer's Ethereum-style address, lower case with 0x. */
  signer: string;
  /** 65-byte r ‖ s ‖ v, hex with 0x. */
  sig: string;
  /** SHA-256 of the exact request bytes, hex. */
  req: string;
  /** The exact response bytes, base64. */
  res: string;
};

export const isNearAi = (baseUrl: string): boolean => baseUrl.replace(/\/+$/, "") === NEAR_AI_URL;

const utf8 = new TextEncoder();
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const sha256Hex = (bytes: Uint8Array) => hex(sha256(bytes));

function fromHex(text: string): Uint8Array {
  const clean = text.replace(/^0x/i, "");
  if (!/^([0-9a-fA-F]{2})*$/.test(clean)) throw new Error("not hex");
  return Uint8Array.from(clean.match(/.{2}/g) ?? [], (byte) => parseInt(byte, 16));
}

const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/** The text the enclave signed, rebuilt from the proof: the response is hashed here, not taken on trust. */
export function signedText(proof: Pick<TeeProof, "kind" | "model" | "req" | "res">): string {
  const hashes = `${proof.req}:${sha256Hex(fromBase64(proof.res))}`;
  return proof.kind === "provider_tee" ? `${proof.model}:${hashes}` : hashes;
}

/** The Ethereum address that signed `text` the EIP-191 way ("\x19Ethereum Signed Message:\n<length>"), lower case. */
export function recoverSigner(text: string, signature: string): string {
  const message = utf8.encode(text);
  const digest = keccak_256(new Uint8Array([...utf8.encode(`\x19Ethereum Signed Message:\n${message.length}`), ...message]));
  const bytes = fromHex(signature);
  if (bytes.length !== 65) throw new Error("an ECDSA signature is 65 bytes");
  const v = bytes[64] >= 27 ? bytes[64] - 27 : bytes[64];
  if (v !== 0 && v !== 1) throw new Error("bad recovery byte");
  // noble wants the recovery byte first.
  const recovered = secp256k1.recoverPublicKey(new Uint8Array([v, ...bytes.slice(0, 64)]), digest, { prehash: false });
  const full = secp256k1.Point.fromBytes(recovered).toBytes(false);
  return `0x${hex(keccak_256(full.slice(1)).slice(-20))}`;
}

type SignatureAnswer = { text?: string; signature?: string; signing_address?: string; signing_algo?: string; signature_kind?: string; error_code?: string };

/**
 * NEAR AI's signature for a completion just received, as a proof, or `null` when there is none (a model NEAR AI does
 * not sign for, or not yet recorded after a few tries). `request` and `response` are the exact bodies sent and received.
 */
export async function fetchTeeProof(args: {
  apiKey: string;
  model: string;
  chatId: string;
  request: string;
  response: string;
  fetch?: typeof fetch;
  tries?: number;
}): Promise<TeeProof | null> {
  const get = args.fetch ?? fetch;
  for (let attempt = 0; attempt < (args.tries ?? 5); attempt++) {
    if (attempt > 0) await new Promise((done) => setTimeout(done, 600));
    const answer = await get(`${NEAR_AI_URL}/signature/${encodeURIComponent(args.chatId)}?signing_algo=ecdsa`, {
      headers: { accept: "application/json", authorization: `Bearer ${args.apiKey}` },
    });
    if (answer.status === 404) continue;
    if (!answer.ok) return null;
    const body = (await answer.json()) as SignatureAnswer;
    if (body.error_code || !body.text || !body.signature || !body.signing_address || body.signing_algo !== "ecdsa") return null;
    const kind = body.signature_kind === "provider_tee" || body.signature_kind === "gateway" ? body.signature_kind : null;
    if (!kind) return null;
    const proof: TeeProof = {
      v: 1,
      model: args.model,
      chat: args.chatId,
      kind,
      algo: "ecdsa",
      signer: body.signing_address.toLowerCase(),
      sig: body.signature.startsWith("0x") ? body.signature : `0x${body.signature}`,
      req: sha256Hex(utf8.encode(args.request)),
      res: toBase64(utf8.encode(args.response)),
    };
    // Kept only if it holds: the text signed is the one these bytes give, and the signature is the signer's.
    if (body.text !== signedText(proof) || recoverSigner(body.text, proof.sig) !== proof.signer) return null;
    return proof;
  }
  return null;
}

/** A proof as it arrives in a transaction's arguments, checked for shape only. */
export function cleanProof(raw: unknown): TeeProof | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const text = (key: string, max: number) => (typeof p[key] === "string" && (p[key] as string).length <= max ? (p[key] as string) : null);
  const [model, chat, signer, sig, req, res] = [text("model", 120), text("chat", 120), text("signer", 42), text("sig", 132), text("req", 64), text("res", 40_000)];
  if (p.v !== 1 || p.algo !== "ecdsa" || (p.kind !== "provider_tee" && p.kind !== "gateway") || !model || !chat || !signer || !sig || !req || !res) return null;
  return { v: 1, model, chat, kind: p.kind, algo: "ecdsa", signer: signer.toLowerCase(), sig, req, res };
}

/** The response's own content: the model's answer, as the agent read it. */
export function proofAnswer(proof: TeeProof): { model: string | null; content: string | null } {
  try {
    const body = JSON.parse(new TextDecoder().decode(fromBase64(proof.res))) as { model?: unknown; choices?: { message?: { content?: unknown } }[] };
    const content = body.choices?.[0]?.message?.content;
    return { model: typeof body.model === "string" ? body.model : null, content: typeof content === "string" ? content : null };
  } catch {
    return { model: null, content: null };
  }
}

export type Check = { label: string; ok: boolean; detail: string };

/** What can be checked from the proof alone: the bytes, the signature, the model named. */
export function checkProof(proof: TeeProof): Check[] {
  const checks: Check[] = [];
  let text = "";
  try {
    text = signedText(proof);
    checks.push({ label: "The response hashes to what was signed", ok: true, detail: text });
  } catch (error) {
    checks.push({ label: "The response hashes to what was signed", ok: false, detail: String(error) });
    return checks;
  }
  try {
    const signer = recoverSigner(text, proof.sig);
    checks.push({ label: "The signature is the signer's", ok: signer === proof.signer, detail: `recovered ${signer}` });
  } catch (error) {
    checks.push({ label: "The signature is the signer's", ok: false, detail: String(error) });
  }
  const { model } = proofAnswer(proof);
  checks.push({ label: "The response names the model the proof names", ok: model === proof.model, detail: `response says ${model ?? "nothing"}` });
  return checks;
}

/**
 * Whether NEAR AI's public attestation report, asked now with a fresh nonce, names the proof's signer: for the model
 * (a `provider_tee` proof) or for its gateway (a `gateway` proof).
 */
export async function checkAttestation(proof: TeeProof, get: typeof fetch = fetch): Promise<Check> {
  const label = proof.kind === "provider_tee" ? `NEAR AI attests this signer for ${proof.model}` : "NEAR AI attests this signer for its gateway";
  try {
    const nonce = hex(crypto.getRandomValues(new Uint8Array(32)));
    const query = new URLSearchParams({ model: proof.model, provider: "near", signing_algo: "ecdsa", nonce, include_tls_fingerprint: "false" });
    const answer = await get(`${NEAR_AI_URL}/attestation/report?${query}`, { headers: { accept: "application/json", "x-no-aliasing": "true" } });
    if (!answer.ok) return { label, ok: false, detail: `the report could not be read (HTTP ${answer.status})` };
    const report = (await answer.json()) as { gateway_attestation?: { signing_address?: string }; model_attestations?: { signing_address?: string; model_name?: string }[] };
    const named =
      proof.kind === "provider_tee"
        ? (report.model_attestations ?? []).filter((one) => one.signing_address?.toLowerCase() === proof.signer).length === 1
        : report.gateway_attestation?.signing_address?.toLowerCase() === proof.signer;
    return { label, ok: named, detail: named ? "the signer is in today's report, next to its Intel TDX and NVIDIA evidence" : "the signer is not in today's report" };
  } catch {
    return { label, ok: false, detail: "NEAR AI did not answer" };
  }
}
