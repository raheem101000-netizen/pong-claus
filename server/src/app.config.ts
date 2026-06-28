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

        // Create Stripe Express account + onboarding link for winner payout
        app.post("/create-payout", express.json(), async (req, res) => {
            if (!stripe) { res.status(503).json({ error: "Payments not configured" }); return; }
            try {
                const { prize_amount_cents } = req.body;

                const account = await stripe.accounts.create({
                    type: "express",
                    capabilities: { transfers: { requested: true } },
                });

                const accountLink = await stripe.accountLinks.create({
                    account: account.id,
                    refresh_url: "https://mediaskills.vercel.app/reauth",
                    return_url: `https://mediaskills.vercel.app/payout-success?account=${account.id}&amount=${prize_amount_cents}`,
                    type: "account_onboarding",
                });

                res.json({ onboarding_url: accountLink.url, account_id: account.id });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
        });

        // Transfer prize to winner's connected account after onboarding
        app.post("/complete-payout", express.json(), async (req, res) => {
            if (!stripe) { res.status(503).json({ error: "Payments not configured" }); return; }
            try {
                const { account_id, prize_amount_cents } = req.body;

                const transfer = await stripe.transfers.create({
                    amount: prize_amount_cents,
                    currency: "nok",
                    destination: account_id,
                });

                res.json({ success: true, transfer_id: transfer.id });
            } catch (err: any) {
                res.status(500).json({ error: err.message });
            }
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

    beforeListen: () => {}
});

export default server;