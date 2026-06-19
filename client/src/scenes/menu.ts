import { k } from "../App";
import { colyseusSDK } from "../core/colyseus";

export function createMenuScene() {
  k.scene("menu", () => {
    const cx = k.width() / 2;
    k.add([k.text("PONG", { size: 64 }), k.pos(cx, k.height() * 0.18), k.anchor("center"), k.color(76, 255, 108)]);
    k.add([k.text("multiplayer", { size: 20 }), k.pos(cx, k.height() * 0.18 + 50), k.anchor("center"), k.color(150, 150, 150)]);
    const status = k.add([k.text("", { size: 18 }), k.pos(cx, k.height() * 0.78), k.anchor("center"), k.color(255, 200, 80)]);

    function button(label: string, y: number, onClick: () => void, col = [40, 40, 50]) {
      const w = 260, h = 56;
      const btn = k.add([
        k.rect(w, h, { radius: 8 }), k.pos(cx, y), k.anchor("center"),
        k.color(col[0], col[1], col[2]), k.area(),
      ]);
      k.add([k.text(label, { size: 22 }), k.pos(cx, y), k.anchor("center"), k.color(255, 255, 255)]);
      btn.onClick(onClick);
      return btn;
    }

    button("Create Room", k.height() * 0.40, async () => {
      status.text = "Creating room...";
      try { const room = await colyseusSDK.create("my_room", { name: "Public Room" }); k.go("game", room); }
      catch (e) { status.text = "Failed to create room"; }
    }, [76, 180, 100]);

    button("Join Public Game", k.height() * 0.40 + 72, async () => {
      status.text = "Finding a game...";
      try {
        // join() joins any open public room of this type
        const room = await colyseusSDK.join("my_room", { name: "Public Room" });
        k.go("game", room);
      } catch (e) {
        // no open room to join — make one and wait
        status.text = "No open rooms — created one, waiting...";
        try { const room = await colyseusSDK.create("my_room", { name: "Public Room" }); k.go("game", room); }
        catch (e2) { status.text = "Failed to join"; }
      }
    }, [60, 100, 200]);

    button("Quick Match", k.height() * 0.40 + 144, async () => {
      status.text = "Matchmaking...";
      try { const room = await colyseusSDK.joinOrCreate("my_room", { name: "Public Room" }); k.go("game", room); }
      catch (e) { status.text = "Failed to matchmake"; }
    }, [120, 80, 180]);
  });
}
