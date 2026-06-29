import { defineServer, defineRoom, monitor } from "colyseus";
import { matchMaker } from "@colyseus/core";
import express from "express";
import path from "path";
import { Pool } from "pg";
import Stripe from "stripe";
import { LobbyRoom } from "./rooms/LobbyRoom";
import { GameRoom } from "./rooms/GameRoom";

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const neonPool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
    : null;

export const server = defineServer({
    rooms: {
        lobby_room: defineRoom(LobbyRoom),
        game_room:  defineRoom(GameRoom),
    },

    express: (app) => {
        // Stripe webhook — raw body must be read before any JSON middleware
        app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
            if (!stripe) { res.status(503).json({ error: "Payments not configured" }); return; }
            const sig = req.headers["stripe-signature"] as string;
            let event: Stripe.Event;
            try {
                event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
            } catch (err: any) {
                res.status(400).send(`Webhook Error: ${err.message}`);
                return;
            }
            if (event.type === "checkout.session.completed") {
                const session = event.data.object as Stripe.Checkout.Session;
                const mode = (session.metadata?.mode as string) || "multiplayer";
                if (neonPool) {
                    await neonPool.query(
                        "INSERT INTO sessions (game, mode, amount, stripe_payment_id) VALUES ($1, $2, $3, $4)",
                        ["Pong", mode, 4.99, session.payment_intent]
                    ).catch(console.error);
                }
            }
            res.json({ received: true });
        });

        // Solo checkout — $4.99
        app.post("/create-solo-checkout", express.json(), async (req, res) => {
            if (!stripe) { res.status(503).json({ error: "Payments not configured" }); return; }
            try {
                const session = await stripe.checkout.sessions.create({
                    payment_method_types: ["card"],
                    line_items: [{ price_data: { currency: "usd", product_data: { name: "Pong Solo" }, unit_amount: 499 }, quantity: 1 }],
                    mode: "payment",
                    metadata: { mode: "solo" },
                    success_url: `${process.env.BASE_URL}/pong-multiplayer.html?paid=true&session_id={CHECKOUT_SESSION_ID}`,
                    cancel_url: `${process.env.BASE_URL}/`,
                });
                res.json({ url: session.url });
            } catch (err: any) { res.status(500).json({ error: err.message }); }
        });

        // Multiplayer checkout — $4.99 (room_id + player_id passed through for post-payment return)
        app.post("/create-multiplayer-checkout", express.json(), async (req, res) => {
            if (!stripe) { res.status(503).json({ error: "Payments not configured" }); return; }
            const { room_id, player_id } = req.body;
            try {
                const session = await stripe.checkout.sessions.create({
                    payment_method_types: ["card"],
                    line_items: [{ price_data: { currency: "usd", product_data: { name: "Pong Multiplayer — Test" }, unit_amount: 50 }, quantity: 1 }],
                    mode: "payment",
                    metadata: { mode: "multiplayer", room_id, player_id },
                    success_url: `${process.env.BASE_URL}/rooms?paid=true&room=${room_id}&player=${encodeURIComponent(player_id)}&session_id={CHECKOUT_SESSION_ID}`,
                    cancel_url: `${process.env.BASE_URL}/rooms`,
                });
                res.json({ url: session.url });
            } catch (err: any) { res.status(500).json({ error: err.message }); }
        });

        // Winner submits name + PayPal email; admin pays within 48h
        app.post("/submit-prize-claim", express.json(), async (req, res) => {
            const { winner_name, paypal_email, contact_email, notes, game, prize_amount } = req.body;
            if (neonPool) {
                await neonPool.query(
                    "INSERT INTO prize_claims (winner_name, paypal_email, contact_email, notes, game, prize_amount, claimed_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())",
                    [winner_name, paypal_email, contact_email || "", notes || "", game, prize_amount]
                ).catch(console.error);
            }
            res.json({ success: true });
        });

        // CORS preflight for admin endpoints (called cross-origin from mediaskills)
        app.options("/admin/prize-claims", (_req, res) => {
            res.set("Access-Control-Allow-Origin", "*");
            res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
            res.set("Access-Control-Allow-Headers", "Content-Type");
            res.sendStatus(204);
        });
        app.options("/admin/mark-paid", (_req, res) => {
            res.set("Access-Control-Allow-Origin", "*");
            res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
            res.set("Access-Control-Allow-Headers", "Content-Type");
            res.sendStatus(204);
        });

        // Admin: list all unpaid prize claims
        app.get("/admin/prize-claims", async (req, res) => {
            res.set("Access-Control-Allow-Origin", "*");
            if (req.query.key !== "TENTEN2025") { res.status(401).json({ error: "Unauthorized" }); return; }
            if (!neonPool) { res.json([]); return; }
            try {
                const result = await neonPool.query("SELECT * FROM prize_claims WHERE paid = false ORDER BY claimed_at DESC");
                res.json(result.rows);
            } catch (err: any) { res.status(500).json({ error: err.message }); }
        });

        // Admin: mark a prize claim as paid
        app.post("/admin/mark-paid", express.json(), async (req, res) => {
            res.set("Access-Control-Allow-Origin", "*");
            if (req.query.key !== "TENTEN2025") { res.status(401).json({ error: "Unauthorized" }); return; }
            if (!neonPool) { res.json({ success: false }); return; }
            try {
                const { id } = req.body;
                await neonPool.query("UPDATE prize_claims SET paid = true WHERE id = $1", [id]);
                res.json({ success: true });
            } catch (err: any) { res.status(500).json({ error: err.message }); }
        });

        app.get("/hello_world", (req, res) => {
            res.send("It's time to kick ass and chew bubblegum!");
        });

        // matchMaker.stats counts ALL room instances, including the
        // persistent lobby_room (which deliberately never disposes — see
        // LobbyRoom.autoDispose=false — so it survives while both players
        // are off playing a match). That made activeRooms/activePlayers
        // stick at >=1 forever, even with nobody actually in a game.
        // Scope to game_room instances specifically so the count reflects
        // real matches in progress and returns to 0 when nobody's playing.
        app.get("/status", async (req, res) => {
            // Public, read-only status check polled cross-origin from the
            // admin dashboard — no sensitive data, so a wildcard is fine.
            res.set("Access-Control-Allow-Origin", "*");
            const gameRooms = await matchMaker.query({ name: "game_room" });
            res.json({
                game: "Pong",
                activePlayers: gameRooms.reduce((sum, r) => sum + r.clients, 0),
                activeRooms: gameRooms.length,
                timestamp: new Date().toISOString()
            });
        });

        app.use("/colyseus", monitor());

        // Root → rooms lobby (must be before express.static to win over Vite's index.html)
        app.get('/', (_req, res) => {
            res.sendFile(path.join(__dirname, "../../client/dist/rooms.html"));
        });

        app.use(express.static(path.join(__dirname, "../../client/dist")));

        app.get(/^(?!\/colyseus|\/hello_world).*/, (_req, res) => {
            res.sendFile(path.join(__dirname, "../../client/dist/rooms.html"));
        });
    },

    beforeListen: async () => {
        if (neonPool) {
            await neonPool.query(`
                CREATE TABLE IF NOT EXISTS prize_claims (
                    id SERIAL PRIMARY KEY,
                    winner_name TEXT NOT NULL,
                    paypal_email TEXT NOT NULL,
                    notes TEXT,
                    game TEXT NOT NULL,
                    prize_amount TEXT NOT NULL,
                    paid BOOLEAN DEFAULT FALSE,
                    claimed_at TIMESTAMP DEFAULT NOW()
                )
            `).catch(console.error);
            await neonPool.query(
                "ALTER TABLE prize_claims ADD COLUMN IF NOT EXISTS contact_email TEXT"
            ).catch(console.error);
        }
    }
});

export default server;