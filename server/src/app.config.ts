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

        // Colyseus has no global "app"+"io"+"rooms" the way a plain
        // socket.io server does — matchMaker.stats is the built-in
        // equivalent (ccu = concurrent connected users, roomCount across
        // all room types).
        app.get("/status", (req, res) => {
            // Public, read-only status check polled cross-origin from the
            // admin dashboard — no sensitive data, so a wildcard is fine.
            res.set("Access-Control-Allow-Origin", "*");
            res.json({
                game: "Pong",
                activePlayers: matchMaker.stats.local.ccu,
                activeRooms: matchMaker.stats.local.roomCount,
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