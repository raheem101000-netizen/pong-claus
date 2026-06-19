import { Schema, type } from '@colyseus/schema';

// Vertical Pong, matching the original 400x660 board.
export class Paddle extends Schema {
  @type("number") public x: number = 0;
  @type("number") public y: number = 0;
  @type("number") public score: number = 0;
  @type("string") public sessionId: string = "";
}

export class Ball extends Schema {
  @type("number") public x: number = 200;
  @type("number") public y: number = 330;
  @type("number") public vx: number = 0;
  @type("number") public vy: number = 0;
}

export class MyRoomState extends Schema {
  @type(Paddle) public p1 = new Paddle();
  @type(Paddle) public p2 = new Paddle();
  @type(Ball)   public ball = new Ball();
  @type("number") public delay: number = 180;
  @type("number") public numPlayers: number = 0;
  @type("boolean") public playing: boolean = false;
}
