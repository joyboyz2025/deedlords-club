// The TEE proof an AI turn carries (lib/teeProof.ts), with a stand-in for NEAR AI's enclave: a secp256k1 key that
// signs `<model>:<sha256 request>:<sha256 response>` the EIP-191 way, as NEAR AI's model enclaves do.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { advise } from "../games/co-ty-phu/agent/advise.ts";
import type { ChainMatch } from "../games/co-ty-phu/chain/types.ts";
import { NEAR_AI_URL, checkProof, cleanProof, fetchTeeProof, proofAnswer, recoverSigner, signedText, type TeeProof } from "../lib/teeProof.ts";

const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const utf8 = new TextEncoder();
const enclaveKey = secp256k1.utils.randomSecretKey();
const enclaveAddress = `0x${hex(keccak_256(secp256k1.getPublicKey(enclaveKey, false).slice(1)).slice(-20))}`;

function eip191(text: string): string {
  const message = utf8.encode(text);
  const digest = keccak_256(new Uint8Array([...utf8.encode(`\x19Ethereum Signed Message:\n${message.length}`), ...message]));
  const signature = secp256k1.sign(digest, enclaveKey, { prehash: false, format: "recovered" });
  // noble puts the recovery byte first; Ethereum puts it last, as 27 or 28.
  return `0x${hex(signature.slice(1))}${(signature[0] + 27).toString(16)}`;
}

const MODEL = "Qwen/Qwen3.6-35B-A3B-FP8";
const PLAN = { buy_reserve: 150, build: [], keep_reserve: 100, bail: false, liquidate: [] };

/** NEAR AI as the agent sees it: one completion, then the enclave's signature over its exact bytes. */
function fakeNearAi(model = MODEL) {
  const seen: { request?: string; response?: string } = {};
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (at === `${NEAR_AI_URL}/chat/completions`) {
      seen.request = String(init?.body);
      assert.equal((init?.headers as Record<string, string>)["x-no-aliasing"], "true", "NEAR AI is asked not to swap the model");
      seen.response = JSON.stringify({ id: "chatcmpl-1", model, choices: [{ message: { content: JSON.stringify({ plan: PLAN, reason: "Keep 150 back." }) } }] });
      return new Response(seen.response, { status: 200 });
    }
    if (at.startsWith(`${NEAR_AI_URL}/signature/chatcmpl-1`)) {
      const text = `${model}:${hex(sha256(utf8.encode(seen.request!)))}:${hex(sha256(utf8.encode(seen.response!)))}`;
      return Response.json({ text, signature: eip191(text), signing_address: enclaveAddress, signing_algo: "ecdsa", signature_kind: "provider_tee" });
    }
    throw new Error(`unexpected ${at}`);
  }) as typeof fetch;
  return { fetcher, seen };
}

test("an Ethereum signer is recovered from an EIP-191 signature", () => {
  assert.equal(recoverSigner("hello", eip191("hello")), enclaveAddress);
  assert.notEqual(recoverSigner("hello!", eip191("hello")), enclaveAddress);
});

test("a proof is built from the exact bytes, and every check holds", async () => {
  const { fetcher, seen } = fakeNearAi();
  const request = JSON.stringify({ model: MODEL, messages: [] });
  await fetcher(`${NEAR_AI_URL}/chat/completions`, { method: "POST", body: request, headers: { "x-no-aliasing": "true" } });
  const proof = await fetchTeeProof({ apiKey: "k", model: MODEL, chatId: "chatcmpl-1", request, response: seen.response!, fetch: fetcher, tries: 1 });
  assert.ok(proof, "a proof");
  assert.equal(proof.signer, enclaveAddress);
  assert.equal(proof.req, hex(sha256(utf8.encode(request))), "only the request's hash travels");
  assert.ok(!JSON.stringify(proof).includes("messages"), "and not the request itself");
  assert.deepEqual(
    checkProof(proof).map((check) => check.ok),
    [true, true, true],
  );
  assert.deepEqual(cleanProof(JSON.parse(JSON.stringify(proof))), proof, "it survives the trip through a transaction's JSON");
});

test("a response changed after signing, or a signature from another key, fails", async () => {
  const { fetcher, seen } = fakeNearAi();
  const request = "{}";
  await fetcher(`${NEAR_AI_URL}/chat/completions`, { method: "POST", body: request, headers: { "x-no-aliasing": "true" } });
  const proof = (await fetchTeeProof({ apiKey: "k", model: MODEL, chatId: "chatcmpl-1", request, response: seen.response!, fetch: fetcher, tries: 1 }))!;
  const edited = seen.response!.replace("150", "999");
  const forged: TeeProof = { ...proof, res: btoa(edited) };
  assert.equal(checkProof(forged)[1].ok, false, "the signature no longer matches the edited response");
  assert.ok(proofAnswer(forged).content?.includes("999"));
  const otherKey = secp256k1.utils.randomSecretKey();
  const text = signedText(proof);
  const message = utf8.encode(text);
  const digest = keccak_256(new Uint8Array([...utf8.encode(`\x19Ethereum Signed Message:\n${message.length}`), ...message]));
  const signed = secp256k1.sign(digest, otherKey, { prehash: false, format: "recovered" });
  const stranger: TeeProof = { ...proof, sig: `0x${hex(signed.slice(1))}${(signed[0] + 27).toString(16)}` };
  assert.equal(checkProof(stranger)[1].ok, false, "a signature by another key does not pass for the enclave's");
  assert.equal(await fetchTeeProof({ apiKey: "k", model: "another/model", chatId: "chatcmpl-1", request, response: seen.response!, fetch: fakeNearAi("another/model").fetcher, tries: 1 }).catch(() => null), null);
});

test("advice from a NEAR AI model comes with its proof, ready for the turn transaction", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/chain-duel.json", import.meta.url), "utf8")) as { started: ChainMatch };
  const match = fixture.started;
  const seat = match.meta.current_seat!;
  const { fetcher } = fakeNearAi();
  const advice = (await advise(match, seat, { llm: { baseUrl: NEAR_AI_URL, apiKey: "k", model: MODEL, label: "qwen" }, fetch: fetcher }))!;
  assert.equal(advice.fallback, false);
  assert.ok(advice.proof, "the plan comes with its proof");
  assert.equal(advice.proof.signer, enclaveAddress);
  assert.ok(checkProof(advice.proof).every((check) => check.ok));
  assert.deepEqual(JSON.parse(proofAnswer(advice.proof).content!).plan, advice.plan, "the plan played is the plan the enclave signed");
  // Another service (not NEAR AI) gives no proof, and nobody asks it for one.
  const other = (await advise(match, seat, { llm: { baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m", label: "m" }, fetch: (async () => new Response(JSON.stringify({ id: "x", choices: [{ message: { content: JSON.stringify({ plan: PLAN, reason: "r" }) } }] }))) as typeof fetch }))!;
  assert.equal(other.proof ?? null, null);
});

test("a signer that a second report names is attested; one that no report names is not", async () => {
  const { checkAttestation } = await import("../lib/teeProof.ts");
  const proof = { v: 1, model: "Qwen/Test", chat: "chatcmpl-1", kind: "provider_tee", algo: "ecdsa", signer: "0xabc", sig: "0x", req: "", res: "" } as never;
  const reports = (...answers: unknown[]) => {
    let asked = 0;
    const get = (async () => new Response(JSON.stringify(answers[Math.min(asked++, answers.length - 1)]), { status: 200 })) as unknown as typeof fetch;
    return { get, asked: () => asked };
  };
  const without = { model_attestations: [{ signing_address: "0xdef" }] };
  const withIt = { model_attestations: [{ signing_address: "0xDEF" }, { signing_address: "0xABC" }] };
  // A report made on the spot may leave out the machine that signed: the next one is asked.
  const second = reports(without, withIt);
  assert.equal((await checkAttestation(proof, second.get, 3, 1)).ok, true);
  assert.equal(second.asked(), 2);
  const never = reports(without);
  const refused = await checkAttestation(proof, never.get, 3, 1);
  assert.deepEqual([refused.ok, never.asked()], [false, 3]);
  assert.match(refused.detail, /not in today's report \(asked 3 times\)/);
});
