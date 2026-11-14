"use client";

// One AI turn checked from the chain: /verify?tx=<hash>&from=<signer>. The `turn` transaction is read from a NEAR node,
// its proof taken from its own arguments, and every check of lib/teeProof.ts run here in the browser: nothing is
// taken from this site's server.

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Arrow, Chain } from "@/components/landing/icons";
import { CHAIN } from "@/lib/chain/config";
import { readTransaction } from "@/lib/chain/rpc";
import { VERIFICATION_CENTER, checkAttestation, checkProof, cleanProof, proofAnswer, type Check, type TeeProof } from "@/lib/teeProof";
import { parseAnswer } from "../agent/llm";
import { cleanPlan } from "../agent/plan";
import { Hall } from "./Desk";

type Read = { proof: TeeProof; plan: unknown; matchId: string | null; seat: number | null; ok: boolean } | { problem: string };

const HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const ACCOUNT = /^(?:[0-9a-f]{64}|(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*)$/;

async function readTurn(hash: string, from: string): Promise<Read> {
  type Tx = { transaction?: { actions?: { FunctionCall?: { method_name?: string; args?: string } }[] }; status?: { SuccessValue?: string; Failure?: unknown } };
  const tx = await readTransaction<Tx>(CHAIN, hash, from, { timeoutMs: 15_000 });
  const call = tx.transaction?.actions?.map((action) => action.FunctionCall).find((one) => one?.method_name === "turn");
  // A relayed turn is a delegate action: its inner call sits one level down.
  const inner =
    call ??
    (tx.transaction?.actions as { Delegate?: { delegate_action?: { actions?: { FunctionCall?: { method_name?: string; args?: string } }[] } } }[] | undefined)
      ?.flatMap((action) => action.Delegate?.delegate_action?.actions ?? [])
      .map((action) => action.FunctionCall)
      .find((one) => one?.method_name === "turn");
  if (!inner?.args) return { problem: "This transaction is not an AI turn." };
  let args: { id?: unknown; seat?: unknown; plan?: unknown; proof?: unknown };
  try {
    args = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(inner.args), (char) => char.charCodeAt(0))));
  } catch {
    return { problem: "The turn's arguments are not JSON." };
  }
  const proof = cleanProof(args.proof);
  if (!proof) return { problem: "This turn carries no TEE proof: its plan was made without a model NEAR AI signs for." };
  return { proof, plan: args.plan, matchId: typeof args.id === "string" ? args.id : null, seat: typeof args.seat === "number" ? args.seat : null, ok: tx.status?.Failure === undefined };
}

export function VerifyTurn() {
  const params = useSearchParams();
  const hash = params.get("tx") ?? "";
  const from = params.get("from") ?? "";
  const [read, setRead] = useState<Read | null>(null);
  const [attested, setAttested] = useState<Check | null>(null);

  useEffect(() => {
    if (!HASH.test(hash) || !ACCOUNT.test(from)) return setRead({ problem: "Open this page from an AI turn in a match's transaction list." });
    let stopped = false;
    readTurn(hash, from).then(
      (answer) => {
        if (stopped) return;
        setRead(answer);
        if ("proof" in answer) void checkAttestation(answer.proof).then((check) => !stopped && setAttested(check));
      },
      () => !stopped && setRead({ problem: `Cannot read this transaction from NEAR ${CHAIN.network} right now.` }),
    );
    return () => {
      stopped = true;
    };
  }, [hash, from]);

  const proof = read && "proof" in read ? read.proof : null;
  const { content } = proof ? proofAnswer(proof) : { content: null };
  const answer = content ? parseAnswer(content) : null;
  const sent = read && "proof" in read ? cleanPlan(read.plan) : null;
  const checks: Check[] = proof
    ? [
        ...checkProof(proof),
        {
          label: "The plan played is the plan the model answered",
          ok: Boolean(answer && sent && JSON.stringify(answer.plan) === JSON.stringify(sent)),
          detail: answer ? JSON.stringify(answer.plan) : "no plan in the response",
        },
      ]
    : [];
  const all = attested ? [...checks, attested] : checks;
  const passed = all.length > 0 && all.every((check) => check.ok);
  // Every check on the proof holds and NEAR AI's report of today does not list the signer: not confirmed, not refuted.
  const unlisted = Boolean(attested?.unlisted) && checks.every((check) => check.ok);

  return (
    <Hall page="play">
      <div className="fd-hall">
        <section className="fd-wall">
          <h1 className="fd-line">{proof ? (attested ? (passed ? "Signed in a TEE, and it holds." : unlisted ? "Signed, but its enclave cannot be confirmed today." : "This proof does not hold.") : "Checking…") : "Verify an AI move."}</h1>
          <p className="fd-lede">
            An AI agent at a Deedlords table writes a plan for its turn. When the plan comes from a model NEAR AI runs in a Trusted Execution Environment, the model&rsquo;s enclave
            signs its answer, and the turn&rsquo;s transaction carries that signature. Everything below is checked in your browser, from the transaction and NEAR AI&rsquo;s public
            report.
          </p>
          {read && "problem" in read && <p className="fd-problem">{read.problem}</p>}
          {proof && (
            <section className="fd-board" aria-label="Checks">
              <h2 className="fd-board__title">
                <Chain size={22} /> Checks
              </h2>
              <ul className="fd-verify">
                {all.map((check) => (
                  <li key={check.label} data-ok={check.ok || undefined}>
                    <b aria-hidden="true">{check.ok ? "✓" : check.unlisted ? "!" : "✗"}</b>
                    <span>
                      {check.label}
                      <small>{check.detail}</small>
                    </span>
                  </li>
                ))}
                {!attested && (
                  <li>
                    <b aria-hidden="true">…</b>
                    <span>Asking NEAR AI for today&rsquo;s attestation report</span>
                  </li>
                )}
              </ul>
              <p className="fd-fine fd-verify__more">
                The Intel TDX and NVIDIA evidence behind that report is checked by{" "}
                <a href={`${VERIFICATION_CENTER}?model=${encodeURIComponent(proof.model)}`} target="_blank" rel="noreferrer noopener">
                  NEAR AI&rsquo;s Verification Center
                </a>{" "}
                for {proof.model}.
              </p>
            </section>
          )}
          <Link className="fd-back" href={read && "proof" in read && read.matchId ? `/play/${encodeURIComponent(read.matchId)}` : "/play"}>
            <Arrow size={18} /> Back to the match
          </Link>
        </section>

        {proof && (
          <aside className="fd-ticket" aria-label="The proof">
            <section className="fd-stub">
              <h2 className="fd-stub__title">The proof</h2>
              <dl className="fd-proof">
                <div>
                  <dt>Model</dt>
                  <dd>{proof.model}</dd>
                </div>
                <div>
                  <dt>Signed by</dt>
                  <dd>{proof.kind === "provider_tee" ? "the model's own enclave" : "NEAR AI's gateway enclave"}</dd>
                </div>
                <div>
                  <dt>Signer</dt>
                  <dd>
                    <code>{proof.signer}</code>
                  </dd>
                </div>
                <div>
                  <dt>Request</dt>
                  <dd>
                    only its hash: <code>{proof.req.slice(0, 16)}…</code>. It holds the seat owner&rsquo;s secret instructions.
                  </dd>
                </div>
                <div>
                  <dt>Transaction</dt>
                  <dd>
                    {CHAIN.explorerUrl ? (
                      <a href={`${CHAIN.explorerUrl}/txns/${hash}`} target="_blank" rel="noreferrer noopener">
                        <code>{hash.slice(0, 12)}…</code>
                      </a>
                    ) : (
                      <code>{hash.slice(0, 12)}…</code>
                    )}
                    {read && "proof" in read && read.seat !== null ? `, seat ${read.seat + 1}` : ""}
                  </dd>
                </div>
              </dl>
              {answer && (
                <>
                  <h3 className="fd-proof__title">What the model answered</h3>
                  <p className="fd-small">&ldquo;{answer.reason}&rdquo;</p>
                  <pre className="fd-proof__plan">{JSON.stringify(answer.plan, null, 1)}</pre>
                </>
              )}
            </section>
          </aside>
        )}
      </div>
    </Hall>
  );
}
