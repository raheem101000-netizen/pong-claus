import { k } from "../App";
import { colyseusSDK } from "../core/colyseus";

export function createMenuScene() {
  k.scene("menu", () => {
    const cx = k.width() / 2;
    let myName = localStorage.getItem("pongName") || "";

    k.add([k.text("PONG", { size: 56 }), k.pos(cx, 60), k.anchor("center"), k.color(76, 255, 108)]);
    k.add([k.text("multiplayer rooms", { size: 16 }), k.pos(cx, 100), k.anchor("center"), k.color(150, 150, 150)]);

    const status = k.add([k.text("", { size: 16 }), k.pos(cx, k.height() - 30), k.anchor("center"), k.color(255, 200, 80)]);

    const nameLabel = k.add([k.text(myName ? "You: " + myName : "Tap to set your name", { size: 16 }),
      k.pos(cx, 135), k.anchor("center"), k.color(180, 180, 255), k.area()]);
    nameLabel.onClick(() => {
      const n = prompt("Enter your name:", myName) || myName;
      myName = n.trim().slice(0, 16);
      if (myName) localStorage.setItem("pongName", myName);
      nameLabel.text = myName ? "You: " + myName : "Tap to set your name";
    });

    function button(label: string, y: number, onClick: () => void, col = [40, 40, 50], w = 280) {
      const h = 50;
      const btn = k.add([k.rect(w, h, { radius: 8 }), k.pos(cx, y), k.anchor("center"),
        k.color(col[0], col[1], col[2]), k.area()]);
      k.add([k.text(label, { size: 20 }), k.pos(cx, y), k.anchor("center"), k.color(255, 255, 255)]);
      btn.onClick(onClick);
      return btn;
    }

    function requireName(): boolean {
      if (!myName) { status.text = "Set your name first (tap the name above)"; return false; }
      return true;
    }

    button("Create Public Room", 185, async () => {
      if (!requireName()) return;
      status.text = "Creating room...";
      try {
        const room = await colyseusSDK.create("my_room", { name: myName + "'s Room", playerName: myName, isPrivate: false });
        k.go("game", { room, myName });
      } catch (e) { status.text = "Failed to create room"; }
    }, [76, 180, 100]);

    button("Create Private Room", 245, async () => {
      if (!requireName()) return;
      status.text = "Creating private room...";
      try {
        const room = await colyseusSDK.create("my_room", { name: myName + "'s Room", playerName: myName, isPrivate: true });
        k.go("game", { room, myName });
      } catch (e) { status.text = "Failed to create room"; }
    }, [120, 80, 180]);

    button("Join by Code", 305, async () => {
      if (!requireName()) return;
      const code = (prompt("Enter room code:") || "").trim();
      if (!code) return;
      status.text = "Joining " + code + "...";
      try {
        const room = await colyseusSDK.joinById(code, { playerName: myName });
        k.go("game", { room, myName });
      } catch (e) { status.text = "Room not found or full"; }
    }, [60, 100, 200]);

    k.add([k.text("— Public Rooms —", { size: 16 }), k.pos(cx, 360), k.anchor("center"), k.color(120, 120, 130)]);

    async function refreshList() {
      k.get("roomentry").forEach((o: any) => k.destroy(o));
      try {
        const resp: any = await colyseusSDK.http.get("/matchmake/my_room");
        const rooms = (resp.data || []) as any[];
        const open = rooms.filter((r: any) => !r.metadata?.isPrivate && r.clients < r.maxClients);
        if (open.length === 0) {
          k.add([k.text("No open rooms — create one!", { size: 14 }), k.pos(cx, 390), k.anchor("center"), k.color(100,100,110), "roomentry"]);
          return;
        }
        open.slice(0, 5).forEach((r: any, i: number) => {
          const y = 390 + i * 42;
          const e = k.add([k.rect(280, 36, { radius: 6 }), k.pos(cx, y), k.anchor("center"), k.color(35, 35, 45), k.area(), "roomentry"]);
          k.add([k.text((r.metadata?.name || "Room") + "  (" + r.clients + "/2)", { size: 14 }),
            k.pos(cx, y), k.anchor("center"), k.color(220, 220, 220), "roomentry"]);
          e.onClick(async () => {
            if (!requireName()) return;
            status.text = "Joining...";
            try { const room = await colyseusSDK.joinById(r.roomId, { playerName: myName }); k.go("game", { room, myName }); }
            catch (err) { status.text = "Failed to join"; }
          });
        });
      } catch (e) {
        k.add([k.text("Could not load rooms", { size: 14 }), k.pos(cx, 390), k.anchor("center"), k.color(200,100,100), "roomentry"]);
      }
    }
    refreshList();
    k.loop(3, refreshList);
  });
}
