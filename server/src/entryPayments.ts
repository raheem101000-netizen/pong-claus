import Stripe from "stripe";
import type { Request, Response } from "express";
import { pool } from "./db";

/**
 * Entry fees — real card charges through Stripe Checkout, one per player per
 * match, taken in a short payment window after the host presses Start.
 *
 *   match_payments: one row per player per payment ATTEMPT (attempt_id,
 *   user_id unique): who, which game/attempt, the server-computed amount, the
 *   Stripe Checkout session + PaymentIntent, and status
 *     pending → paid → (refunded)      or      pending → expired
 *   match_key ('pongmp:<roomId>') is filled in when the match starts.
 *
 * Rules (the money ones):
 *  - The amount is always computed on the server from the match's agreed
 *    prize (prizes.ts). Nothing the page sends is used for it.
 *  - A payment counts ONLY when Stripe's webhook confirms it (signed event);
 *    the browser coming back from Checkout proves nothing.
 *  - One row per player per attempt + Stripe idempotency keys: pressing Pay
 *    twice reuses the same Checkout, never a second charge.
 *  - Refunds happen ONLY when the match can't happen for a reason that isn't
 *    the payer's: the other player didn't pay in time / left before paying,
 *    or a system error (the match room couldn't be created, a payment landed
 *    for an attempt that no longer exists, a server restart). A player who
 *    paid and then quits / drops / loses is not refunded.
 *
 * Off unless ENTRY_FEES_ENABLED=true (then STRIPE_SECRET_KEY and
 * STRIPE_WEBHOOK_SECRET are required, or paid matches refuse to start).
 * STRIPE_API_HOST/PORT/PROTOCOL point the client at a local stand-in: tests only.
 */
export type Game = "pong" | "fifa" | "kurver";

const MIGRATION_LOCK = 727274;   // the shared-table migration lock
export const PAY_WINDOW_MS = Number(process.env.ENTRY_PAY_WINDOW_MS) || 3 * 60_000;

export interface PaymentRow {
  id: number;
  game: Game;
  attempt_id: string;
  user_id: number;
  amount_cents: number;
  status: "pending" | "paid" | "refunded" | "expired";
  match_key: string | null;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  checkout_url: string | null;
}

// ── Configuration ────────────────────────────────────────────────────────────

let client: Stripe | null | undefined;
function stripe(): Stripe | null {
  if (client !== undefined) return client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return (client = null);
  const opts: any = {};
  if (process.env.STRIPE_API_HOST) {
    opts.host = process.env.STRIPE_API_HOST;
    opts.port = Number(process.env.STRIPE_API_PORT) || 443;
    opts.protocol = process.env.STRIPE_API_PROTOCOL || "https";
  }
  client = new Stripe(key, opts);
  console.log(`[entry-fees] Stripe ${key.startsWith("sk_live_") ? "LIVE" : "TEST"} mode`);
  return client;
}

/** Entry fees switched on for this service. */
export function entryFeesRequested(): boolean {
  return process.env.ENTRY_FEES_ENABLED === "true";
}

/** Switched on AND able to charge (keys present). */
export function entryFeesReady(): boolean {
  return entryFeesRequested() && !!stripe() && !!process.env.STRIPE_WEBHOOK_SECRET;
}

/** "2.99" → 299. */
export function toCents(dollars: string): number {
  return Math.round(parseFloat(dollars) * 100);
}

// ── Table ────────────────────────────────────────────────────────────────────

export async function migrateMatchPayments() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await c.query(`
      CREATE TABLE IF NOT EXISTS match_payments (
        id                          SERIAL PRIMARY KEY,
        game                        TEXT NOT NULL CHECK (game IN ('pong','fifa','kurver')),
        attempt_id                  TEXT NOT NULL,
        user_id                     INTEGER NOT NULL REFERENCES users(id),
        amount_cents                INTEGER NOT NULL CHECK (amount_cents > 0),
        currency                    TEXT NOT NULL DEFAULT 'usd',
        prize                       NUMERIC(10,2),
        match_key                   TEXT,
        status                      TEXT NOT NULL DEFAULT 'pending'
                                      CHECK (status IN ('pending','paid','refunded','expired')),
        stripe_checkout_session_id  TEXT UNIQUE,
        stripe_payment_intent_id    TEXT UNIQUE,
        checkout_url                TEXT,
        stripe_refund_id            TEXT,
        refund_reason               TEXT,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
        paid_at                     TIMESTAMPTZ,
        refunded_at                 TIMESTAMPTZ,
        UNIQUE (attempt_id, user_id)
      )
    `);
    await c.query(`CREATE INDEX IF NOT EXISTS match_payments_match_idx ON match_payments (match_key)`);
    await c.query(`CREATE INDEX IF NOT EXISTS match_payments_user_idx ON match_payments (user_id)`);
    await c.query("COMMIT");
    console.log("[entry-fees] match_payments table ready");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    console.error("[entry-fees] migration failed — paid matches can't start until this is fixed:", e);
  } finally {
    c.release();
  }
}

// ── Paying ───────────────────────────────────────────────────────────────────

/**
 * The player's Checkout for this attempt: creates the row and the Stripe
 * Checkout session the first time, returns the same one on any repeat
 * (double tap, reconnect). amountCents is computed by the caller from the
 * agreed prize — never from anything the page sent.
 */
export async function openPayment(p: {
  game: Game; attemptId: string; userId: number; amountCents: number; prize: string;
  productName: string; successUrl: string; cancelUrl: string;
}): Promise<{ url: string; row: PaymentRow }> {
  const s = stripe();
  if (!s) throw new Error("Stripe is not configured");
  await pool.query(
    `INSERT INTO match_payments (game, attempt_id, user_id, amount_cents, prize)
     VALUES ($1, $2, $3, $4, $5::numeric) ON CONFLICT (attempt_id, user_id) DO NOTHING`,
    [p.game, p.attemptId, p.userId, p.amountCents, p.prize]
  );
  const row: PaymentRow = (await pool.query(`SELECT * FROM match_payments WHERE attempt_id = $1 AND user_id = $2`, [p.attemptId, p.userId])).rows[0];
  if (row.amount_cents !== p.amountCents) throw new Error(`payment ${row.id}: amount changed mid-attempt`);
  if (row.checkout_url) return { url: row.checkout_url, row };

  const meta = { game: p.game, attempt_id: p.attemptId, user_id: String(p.userId), payment_row: String(row.id) };
  const session = await s.checkout.sessions.create({
    mode: "payment",
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: p.amountCents, product_data: { name: p.productName } } }],
    client_reference_id: `${p.attemptId}:${p.userId}`,
    metadata: meta,
    payment_intent_data: { metadata: meta },
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
  }, { idempotencyKey: `entry:${p.game}:${p.attemptId}:${p.userId}` });

  const upd = await pool.query(
    `UPDATE match_payments SET stripe_checkout_session_id = $2, checkout_url = $3
      WHERE id = $1 AND stripe_checkout_session_id IS NULL RETURNING *`,
    [row.id, session.id, session.url]
  );
  return { url: session.url!, row: upd.rows[0] || row };
}

/** Rows of an attempt. */
export async function attemptRows(attemptId: string): Promise<PaymentRow[]> {
  return (await pool.query(`SELECT * FROM match_payments WHERE attempt_id = $1 ORDER BY id`, [attemptId])).rows;
}

/**
 * The match started: its key goes on every paid row of the attempt, and each
 * entry is logged as revenue in `sessions` (what the admin sales totals and
 * the creator "entry fees paid" read). From here on the entries are final.
 */
export async function attachMatch(attemptId: string, matchKey: string, sessionsGame: string) {
  await pool.query(`UPDATE match_payments SET match_key = $2 WHERE attempt_id = $1 AND status = 'paid'`, [attemptId, matchKey]);
  await pool.query(
    `INSERT INTO sessions (game, mode, amount, stripe_payment_id, user_id)
     SELECT $2, 'multiplayer', amount_cents / 100.0, stripe_payment_intent_id, user_id
       FROM match_payments WHERE attempt_id = $1 AND status = 'paid' AND stripe_payment_intent_id IS NOT NULL
     ON CONFLICT (stripe_payment_id) DO NOTHING`,
    [attemptId, sessionsGame]
  ).catch(e => console.error(`[entry-fees] couldn't log entries of ${matchKey} in sessions (payments are unaffected):`, e));
}

/** Refund one paid row (idempotent: Stripe key per row; only 'paid' rows move). */
export async function refundRow(row: PaymentRow, reason: string): Promise<boolean> {
  const s = stripe();
  if (!s || !row.stripe_payment_intent_id) return false;
  try {
    const refund = await s.refunds.create(
      { payment_intent: row.stripe_payment_intent_id, metadata: { payment_row: String(row.id), reason } },
      { idempotencyKey: `refund:${row.id}` }
    );
    const r = await pool.query(
      `UPDATE match_payments SET status = 'refunded', stripe_refund_id = $2, refund_reason = $3, refunded_at = now()
        WHERE id = $1 AND status = 'paid'`,
      [row.id, refund.id, reason]
    );
    console.log(`[entry-fees] refunded payment ${row.id} (user ${row.user_id}, ${row.amount_cents}¢, ${reason})${r.rowCount ? "" : " — already marked"}`);
    return true;
  } catch (e) {
    console.error(`[entry-fees] REFUND FAILED for payment ${row.id} (user ${row.user_id}, ${row.amount_cents}¢, ${reason}) — refund it by hand in Stripe:`, e);
    return false;
  }
}

/**
 * The attempt won't become a match: close the Checkouts still open and
 * refund whoever already paid. A Checkout that can't be closed because it
 * just completed is left alone — its webhook arrives, finds the attempt gone
 * and refunds it then.
 */
export async function cancelAttempt(attemptId: string, reason: string): Promise<{ refunded: number[] }> {
  const s = stripe();
  const refunded: number[] = [];
  for (const row of await attemptRows(attemptId)) {
    if (row.status === "pending") {
      try {
        if (s && row.stripe_checkout_session_id) await s.checkout.sessions.expire(row.stripe_checkout_session_id);
        await pool.query(`UPDATE match_payments SET status = 'expired' WHERE id = $1 AND status = 'pending'`, [row.id]);
      } catch (e: any) {
        console.log(`[entry-fees] payment ${row.id}: Checkout not closed (${e?.message || e}) — its webhook will settle it`);
      }
    } else if (row.status === "paid" && !row.match_key) {
      if (await refundRow(row, reason)) refunded.push(row.user_id);
    }
  }
  return { refunded };
}

// ── Webhook ──────────────────────────────────────────────────────────────────

/**
 * Who handles a confirmed payment: the lobby, if the attempt is still being
 * collected. Returns false when the attempt is gone (cancelled, restarted)
 * — the payment is then refunded.
 */
type PaidHandler = (row: PaymentRow) => boolean;
let paidHandler: PaidHandler = () => false;
export function onPaymentConfirmed(h: PaidHandler) { paidHandler = h; }

/**
 * POST /stripe/webhook (raw body). Signed by Stripe (STRIPE_WEBHOOK_SECRET).
 * Stripe sends every event of the account to every endpoint, so sessions that
 * aren't one of this game's match_payments rows are acknowledged and ignored.
 */
export function webhookHandler(game: Game) {
  return async (req: Request, res: Response) => {
    const s = stripe();
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!s || !secret) { res.status(503).json({ error: "Payments not configured" }); return; }
    let event: Stripe.Event;
    try {
      event = s.webhooks.constructEvent(req.body, req.headers["stripe-signature"] as string, secret);
    } catch (e: any) {
      res.status(400).send(`Webhook Error: ${e.message}`);
      return;
    }
    try {
      if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
        await settlePaid(game, event.data.object as Stripe.Checkout.Session);
      } else if (event.type === "checkout.session.expired") {
        const cs = event.data.object as Stripe.Checkout.Session;
        await pool.query(`UPDATE match_payments SET status = 'expired' WHERE stripe_checkout_session_id = $1 AND game = $2 AND status = 'pending'`, [cs.id, game]);
      }
      res.json({ received: true });
    } catch (e) {
      console.error("[entry-fees] webhook handling failed (Stripe will retry):", e);
      res.status(500).json({ error: "retry" });
    }
  };
}

async function settlePaid(game: Game, cs: Stripe.Checkout.Session) {
  if (cs.metadata?.game !== game) return;                // another game's / the site's checkout
  if (cs.payment_status !== "paid") return;              // async methods: wait for async_payment_succeeded
  const row: PaymentRow | undefined = (await pool.query(`SELECT * FROM match_payments WHERE stripe_checkout_session_id = $1`, [cs.id])).rows[0];
  if (!row) { console.error(`[entry-fees] paid Checkout ${cs.id} has no payment row`); return; }
  if (cs.amount_total !== row.amount_cents || (cs.currency || "usd") !== "usd") {
    console.error(`[entry-fees] payment ${row.id}: Stripe amount ${cs.amount_total} ${cs.currency} ≠ expected ${row.amount_cents} usd — not counted`);
    return;
  }
  const pi = typeof cs.payment_intent === "string" ? cs.payment_intent : cs.payment_intent?.id || null;
  const upd = await pool.query(
    `UPDATE match_payments SET status = 'paid', stripe_payment_intent_id = $2, paid_at = now()
      WHERE id = $1 AND status IN ('pending', 'expired') RETURNING *`,
    [row.id, pi]
  );
  if (!upd.rowCount) return;                             // already handled (Stripe retries are normal)
  const paid: PaymentRow = upd.rows[0];
  console.log(`[entry-fees] payment ${paid.id} confirmed: user ${paid.user_id}, ${paid.amount_cents}¢, attempt ${paid.attempt_id}`);
  if (!paidHandler(paid)) {
    // Paid for an attempt that no longer exists (window closed, server
    // restarted): no match will come of it — a system case, refunded.
    await refundRow(paid, "attempt_gone");
  }
}

// ── Recovery ─────────────────────────────────────────────────────────────────

/**
 * Money taken with no match: paid rows of this game that never got a match
 * key, older than the payment window (+ grace), whose attempt isn't live —
 * refunded. Old pending rows are closed. Runs at boot and every minute.
 */
export async function recoverStranded(game: Game, isLive: (attemptId: string) => boolean) {
  const cutoff = `${Math.ceil((PAY_WINDOW_MS + 120_000) / 1000)} seconds`;
  const paid: PaymentRow[] = (await pool.query(
    `SELECT * FROM match_payments WHERE game = $1 AND status = 'paid' AND match_key IS NULL
        AND paid_at < now() - $2::interval`, [game, cutoff])).rows;
  for (const row of paid) if (!isLive(row.attempt_id)) await refundRow(row, "no_match_recovery");
  const stale: PaymentRow[] = (await pool.query(
    `SELECT * FROM match_payments WHERE game = $1 AND status = 'pending' AND created_at < now() - $2::interval`, [game, cutoff])).rows;
  const s = stripe();
  for (const row of stale) {
    if (isLive(row.attempt_id)) continue;
    try {
      if (s && row.stripe_checkout_session_id) await s.checkout.sessions.expire(row.stripe_checkout_session_id);
      await pool.query(`UPDATE match_payments SET status = 'expired' WHERE id = $1 AND status = 'pending'`, [row.id]);
    } catch (e: any) { /* completed meanwhile: its webhook settles it */ }
  }
}
