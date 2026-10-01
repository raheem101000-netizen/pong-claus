import { pool } from "./db";

/**
 * Pong multiplayer win credit — same pattern as FIFA / Puz Royale / Kurver:
 * ONE database transaction, credited exactly once per match.
 *
 * A Pong game_room hosts exactly one 1v1 match (no rematch: a new match is a
 * new room from the lobby), so the dedupe key is the room:
 * game_wins.stripe_payment_id = 'pongmp:<roomId>' (plain UNIQUE index).
 * A retry, a reconnect, or two end-of-match paths racing all hit the same key.
 *
 * The prize is fixed and set here on the server — $5.00 (dollars), the same as
 * FIFA and Pong solo, and what the tenten.run homepage card shows ("PER WIN
 * $5.00"). Nothing a client sends feeds into it.
 */
export const PONGMP_GAME = "pongmp";
export const PONGMP_PRIZE = "5.00";
const PONGMP_TIER = "1V1";
const PONGMP_MATCH_NUMBER = 0; // NOT NULL in the shared tables; no Pong-solo-style cycle position

/**
 * Payout kill-switch. ON by default (unset = on). PONGMP_PAYOUTS_ENABLED=false
 * (exactly "false") turns payouts OFF: matches play normally, creditPongWin
 * credits nothing and touches no tables. Read on every call — switching is
 * just setting the variable in Render.
 */
export function payoutsEnabled(): boolean {
  return process.env.PONGMP_PAYOUTS_ENABLED !== "false";
}

export function pongCreditKey(roomId: string) {
  return `pongmp:${roomId}`;
}

export type CreditOutcome =
  | { status: "credited"; amount: string; balanceBefore: string; balanceAfter: string }
  | { status: "already_credited" }
  | { status: "disabled" };

export async function creditPongWin(opts: { roomId: string; winnerUserId: number; loserUserId: number | null }): Promise<CreditOutcome> {
  if (!payoutsEnabled()) return { status: "disabled" };
  const key = pongCreditKey(opts.roomId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claim = await client.query(
      `INSERT INTO game_wins (player_id, game, match_number, stripe_payment_id)
       VALUES ($1, $2, $3, $4) ON CONFLICT (stripe_payment_id) DO NOTHING RETURNING id`,
      [opts.winnerUserId, PONGMP_GAME, PONGMP_MATCH_NUMBER, key]
    );
    if (!claim.rowCount) { await client.query("ROLLBACK"); return { status: "already_credited" }; }

    const before = await client.query(`SELECT COALESCE(balance, 0) AS balance FROM users WHERE id = $1 FOR UPDATE`, [opts.winnerUserId]);
    if (!before.rowCount) throw new Error(`winner user ${opts.winnerUserId} not found`);
    const after = await client.query(
      `UPDATE users SET balance = COALESCE(balance, 0) + $2::numeric WHERE id = $1 RETURNING balance`,
      [opts.winnerUserId, PONGMP_PRIZE]
    );
    await client.query(
      `INSERT INTO balance_ledger (player_id, game, match_number, reason, delta, balance_before, balance_after, stripe_payment_id)
       VALUES ($1, $2, $3, 'win_credit', $4::numeric, $5, $6, $7)`,
      [opts.winnerUserId, PONGMP_GAME, PONGMP_MATCH_NUMBER, PONGMP_PRIZE, before.rows[0].balance, after.rows[0].balance, key]
    );
    await client.query(
      `INSERT INTO match_results (player_id, game, stripe_payment_id, outcome, tier, match_number, credited)
       VALUES ($1, $2, $3, 'win', $4, $5, true) ON CONFLICT (stripe_payment_id) DO NOTHING`,
      [opts.winnerUserId, PONGMP_GAME, key, PONGMP_TIER, PONGMP_MATCH_NUMBER]
    );
    if (opts.loserUserId) {
      await client.query(
        `INSERT INTO match_results (player_id, game, stripe_payment_id, outcome, tier, match_number, credited)
         VALUES ($1, $2, $3, 'loss', $4, $5, false) ON CONFLICT (stripe_payment_id) DO NOTHING`,
        [opts.loserUserId, PONGMP_GAME, `${key}:loss`, PONGMP_TIER, PONGMP_MATCH_NUMBER]
      );
    }
    await client.query("COMMIT");
    return { status: "credited", amount: PONGMP_PRIZE, balanceBefore: Number(before.rows[0].balance).toFixed(2), balanceAfter: Number(after.rows[0].balance).toFixed(2) };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
