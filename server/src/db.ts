import { Pool } from "pg";

// Shared mediaskills Neon database (users, game_tokens, game_wins,
// balance_ledger, match_results). Pong multiplayer's Render DATABASE_URL must point at it
// for login and win credits to work.
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set — login and win credits will fail.");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 8,
});
