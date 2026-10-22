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

// $10 TIER HIDDEN: set true to offer $5.99 → $10 (and "Open to both") again.
// Only what a room can be created / joined / changed / paid with is limited;
// asPrize and PRIZES above stay whole, so a match already played for $10
// still credits, refunds and settles at $10. The page reads this same flag
// from /prizes.js to hide the $10 buttons.
export const TEN_TIER_OFFERED = false;

export const OFFERED_PRIZES: Prize[] = TEN_TIER_OFFERED ? [5, 10] : [5];

// asPrize, limited to the prizes on offer right now.
export function asOfferedPrize(v: unknown): Prize | null {
  const p = asPrize(v);
  return p && OFFERED_PRIZES.includes(p) ? p : null;
}

// asPrizeMode, limited to the prizes on offer ("both" only with $10 on offer).
export function asOfferedPrizeMode(v: unknown): PrizeMode | null {
  const m = asPrizeMode(v);
  if (!m) return null;
  if (m === "both") return TEN_TIER_OFFERED ? m : null;
  return asOfferedPrize(m) ? m : null;
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
  return `window.PONG_PRIZES = ${JSON.stringify(PRIZES)};\nwindow.TEN_TIER_OFFERED = ${TEN_TIER_OFFERED};\n`;
}
