import { ServerError } from "@colyseus/core";
import { pool } from "./db";

/**
 * Login handoff, mirroring Pong solo: tenten.run's /api/token?action=generate
 * reads the logged-in session cookie and inserts a game_tokens row; the
 * homepage's Pong MULTIPLAYER button then carries {token, player_id} to the lobby.
 *
 * Like Pong's later calls (match-config, record-win, checkout), the token is
 * checked as `token AND user_id` and NOT consumed — Pong reuses it for the
 * lobby join, the match-room join and any rejoin. Unlike Pong, it's bounded:
 * game_tokens.expires_at is only the 60s window for the one-time verify step,
 * so age is checked against created_at instead (both are `timestamp without
 * time zone` written with the DB session's now(), hence LOCALTIMESTAMP).
 */
export const TOKEN_MAX_AGE_HOURS = 12;

export interface PongAuth {
  userId: number;
  displayName: string;
}

export async function authenticateGameToken(token: unknown, playerId: unknown): Promise<PongAuth> {
  const userId = Number(playerId);
  if (typeof token !== "string" || !token || !Number.isInteger(userId) || userId <= 0) {
    throw new ServerError(401, "Log in on tenten.run to play");
  }
  const result = await pool.query(
    `SELECT u.id, u.display_name
       FROM game_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token = $1 AND t.user_id = $2
        AND t.created_at > LOCALTIMESTAMP - make_interval(hours => $3)`,
    [token, userId, TOKEN_MAX_AGE_HOURS]
  );
  if (!result.rows.length) {
    throw new ServerError(401, "Your login has expired — go back to tenten.run and press PLAY on Pong Multiplayer again");
  }
  return { userId: result.rows[0].id, displayName: result.rows[0].display_name };
}
