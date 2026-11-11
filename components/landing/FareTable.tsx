"use client";

import { useState } from "react";

// What a seat in a duel returns, by the contract's own arithmetic: the pot is two stakes, the contract keeps 2.5% of
// it, first place takes 70% of the rest and second place 30%. Nothing here is a forecast: the win rate is the reader's.

const STAKES = [0.05, 0.1, 0.25, 0.5, 1];
const FEE = 0.025;
const SHARES = [0.7, 0.3];

const near = (amount: number) => `${Number(amount.toFixed(5))} NEAR`;
const signed = (ratio: number) => `${ratio >= 0 ? "+" : "−"}${Math.abs(ratio * 100).toFixed(1)}%`;

export function FareTable() {
  const [stake, setStake] = useState(STAKES[0]);
  const [wins, setWins] = useState(60);
  const pot = stake * 2 * (1 - FEE);
  const [first, second] = SHARES.map((share) => pot * share);
  const expected = (wins / 100) * first + (1 - wins / 100) * second;
  const breakEven = Math.ceil(((stake - second) / (first - second)) * 100);

  return (
    <div className="lp-fare-wrap">
    <div className="lp-fare">
      <div className="lp-fare__pick" role="group" aria-label="Stake a seat, in NEAR">
        <span>Stake a seat</span>
        {STAKES.map((amount) => (
          <button key={amount} type="button" aria-pressed={amount === stake} onClick={() => setStake(amount)}>
            {amount}
          </button>
        ))}
      </div>
      <dl className="lp-fare__rows">
        <div>
          <dt>Your seat finishes first</dt>
          <dd>
            {near(first)} <b data-up>{signed(first / stake - 1)}</b>
          </dd>
        </div>
        <div>
          <dt>Your seat finishes second</dt>
          <dd>
            {near(second)} <b>{signed(second / stake - 1)}</b>
          </dd>
        </div>
        <div>
          <dt>The contract keeps</dt>
          <dd>{near(stake * 2 * FEE)} of the pot (2.5%)</dd>
        </div>
      </dl>
      <label className="lp-fare__rate">
        <span>
          If the agent wins <output>{wins}</output> matches in 100
        </span>
        <input type="range" min={0} max={100} step={1} value={wins} onChange={(event) => setWins(Number(event.target.value))} />
      </label>
      <p className="lp-fare__result" aria-live="polite">
        <span>Average return a match</span>
        <strong data-up={expected >= stake || undefined}>{signed(expected / stake - 1)}</strong>
        <small>
          {near(expected)} back for every {near(stake)} staked. Break-even is {breakEven} wins in 100.
        </small>
      </p>
    </div>
    </div>
  );
}
