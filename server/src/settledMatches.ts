import type { PoolClient } from "pg";
import { pool } from "./db";

/**
 * Settled-match record (creator program data layer): one structured row per
 * paid match, written inside the existing win-credit transaction right after
 * the game_wins claim — so it's exactly-once on the same match key as the
 * credit. Raw facts only (no fees, attribution or reimbursement here).
 *
 * The same two tables are written by FIFA, Pong and Kurver (shared database);
 * each service creates them if missing (identical, idempotent DDL).
 *
 * entries_charged is false until entry-fee charging exists: until then
 * entry_price / paying_players / entry_total / margin are the listed price ×
 * the players in the match, and nothing was actually collected. Readers must
 * count only entries_charged = true for money that was really paid in.
 */
// The three services may start at the same moment: the DDL runs in one
// transaction behind a shared advisory lock, so they take turns.
const MIGRATION_LOCK = 727274;

export async function migrateSettledMatches() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS settled_matches (
        match_key        TEXT PRIMARY KEY,
        game             TEXT NOT NULL CHECK (game IN ('fifa','pong','kurver')),
        settled_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        winner_user_id   INTEGER NOT NULL REFERENCES users(id),
        prize            NUMERIC(10,2) NOT NULL,
        entry_price      NUMERIC(10,2) NOT NULL,
        paying_players   INTEGER NOT NULL,
        entry_total      NUMERIC(10,2) NOT NULL,
        margin           NUMERIC(10,2) NOT NULL,
        entries_charged  BOOLEAN NOT NULL DEFAULT false
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS settled_match_players (
        match_key  TEXT NOT NULL REFERENCES settled_matches(match_key),
        user_id    INTEGER NOT NULL REFERENCES users(id),
        outcome    TEXT NOT NULL CHECK (outcome IN ('won','lost')),
        PRIMARY KEY (match_key, user_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS settled_match_players_user_idx ON settled_match_players (user_id)`);
    await client.query("COMMIT");
    console.log("[settled-matches] tables ready");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[settled-matches] migration failed — matches won't be recorded until this is fixed:", e);
  } finally {
    client.release();
  }
}

export interface SettledMatch {
  matchKey: string;                 // the credit's key (fifa:… / pongmp:… / kurver:…)
  game: "fifa" | "pong" | "kurver";
  winnerUserId: number;
  loserUserIds: number[];
  prize: string;                    // dollars paid to the winner, e.g. "5.00"
  entryPrice: string;               // listed entry per player, e.g. "2.99"
  payingPlayers: number;
  entriesCharged?: boolean;         // the entries were really paid (Stripe, entryPayments.ts)
}

/**
 * Write the record inside the credit transaction `client` is in. In its own
 * savepoint: if it fails (table missing, bad value) only the record is skipped
 * and logged — the credit itself always commits.
 */
export async function recordSettledMatch(client: PoolClient, m: SettledMatch) {
  await client.query("SAVEPOINT settled_match");
  try {
    await client.query(
      `INSERT INTO settled_matches (match_key, game, winner_user_id, prize, entry_price, paying_players, entry_total, margin, entries_charged)
       VALUES ($1, $2, $3, $4::numeric, $5::numeric, $6::int, $5::numeric * $6::int, $5::numeric * $6::int - $4::numeric, $7)
       ON CONFLICT (match_key) DO NOTHING`,
      [m.matchKey, m.game, m.winnerUserId, m.prize, m.entryPrice, m.payingPlayers, !!m.entriesCharged]
    );
    await client.query(
      `INSERT INTO settled_match_players (match_key, user_id, outcome) VALUES ($1, $2, 'won') ON CONFLICT DO NOTHING`,
      [m.matchKey, m.winnerUserId]
    );
    for (const id of m.loserUserIds) {
      await client.query(
        `INSERT INTO settled_match_players (match_key, user_id, outcome) VALUES ($1, $2, 'lost') ON CONFLICT DO NOTHING`,
        [m.matchKey, id]
      );
    }
    await client.query("RELEASE SAVEPOINT settled_match");
  } catch (e) {
    await client.query("ROLLBACK TO SAVEPOINT settled_match").catch(() => {});
    console.error(`[settled-matches] couldn't record ${m.matchKey} (the credit is unaffected):`, e);
  }
}
