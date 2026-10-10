/**
 * The Pong 1v1 prizes (same table as FIFA's prizes.ts) — the ONE place prize and entry fee are defined.
 * The server uses it for validation, the winner's credit and (later) entry
 * charging; the lobby page loads the same table from /prizes.js, so a label,
 * a credit and a charge can never disagree.
 *
 * Amounts are DOLLARS as exact strings (like users.balance / payouts.ts).
 */
export const PRIZES = {
  5: { prize: "5.00", entryFee: "2.99" },
  10: { prize: "10.00", entryFee: "5.99" },
} as const;

export type Prize = keyof typeof PRIZES;          // 5 | 10
export type PrizeMode = "5" | "10" | "both";      // what a room was created with

export const PRIZE_VALUES: Prize[] = [5, 10];

export function asPrize(v: unknown): Prize | null {
  const n = Number(v);
  return n === 5 || n === 10 ? n : null;
}

export function asPrizeMode(v: unknown): PrizeMode | null {
  return v === "5" || v === "10" || v === "both" ? v : null;
}

// Credit amount for the agreed prize (what creditPongWin adds to the winner).
export function prizeAmount(p: Prize): string {
  return PRIZES[p].prize;
}

// Entry fee each player pays for the agreed prize. Not charged yet — this is
// the hook for when entry-fee charging (Stripe) is built.
export function entryFeeFor(p: Prize): string {
  return PRIZES[p].entryFee;
}

// Served as /prizes.js so the page reads the same table.
export function prizesClientScript(): string {
  return `window.PONG_PRIZES = ${JSON.stringify(PRIZES)};\n`;
}
