import { defineServer, defineRoom, monitor } from "colyseus";
import { matchMaker } from "@colyseus/core";
import express from "express";
import path from "path";
import { LobbyRoom } from "./rooms/LobbyRoom";
import { GameRoom } from "./rooms/GameRoom";

export const server = defineServer({
    rooms: {
        lobby_room: defineRoom(LobbyRoom),
        game_room:  defineRoom(GameRoom),
    },

    express: (app) => {
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