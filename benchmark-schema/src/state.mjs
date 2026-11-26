// Shared state shape used by every scenario:
// a map of 2000 players, each with x / y coordinates.
import { Schema, defineTypes, MapSchema } from "@colyseus/schema";

export const PLAYER_COUNT = 2000;
export const INITIAL_X = 10;
export const INITIAL_Y = 20;
export const TARGET_X = 15;

export class Position extends Schema {
  constructor() {
    super();
    this.x = INITIAL_X;
    this.y = INITIAL_Y;
  }
}
defineTypes(Position, { x: "number", y: "number" });

export class GameState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
  }
}
defineTypes(GameState, { players: { map: Position } });

/** Build a fresh state with PLAYER_COUNT players at (10, 20). */
export function createState() {
  const state = new GameState();
  for (let i = 0; i < PLAYER_COUNT; i++) {
    state.players.set(String(i), new Position().assign({ x: INITIAL_X, y: INITIAL_Y }));
  }
  return state;
}

export function playerKey(i) {
  return String(i);
}
