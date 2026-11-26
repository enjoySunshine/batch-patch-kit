// Probe what produces ~39,750-byte packets.
import { Schema, defineTypes, ArraySchema, MapSchema, Encoder, Decoder } from "@colyseus/schema";

Encoder.BUFFER_SIZE = 256 * 1024;

class Position extends Schema {
  constructor() { super(); this.x = 0; this.y = 0; }
}
defineTypes(Position, { x: "number", y: "number" });

class MapState extends Schema {
  constructor() { super(); this.players = new MapSchema(); }
}
defineTypes(MapState, { players: { map: Position } });

class ArrayState extends Schema {
  constructor() { super(); this.players = new ArraySchema(); }
}
defineTypes(ArrayState, { players: [Position] });

const N = 2000;

function run(label, makeState, keyOf) {
  const state = makeState();
  for (let i = 0; i < N; i++) {
    state.players.set ? state.players.set(keyOf(i), new Position().assign({ x: 10, y: 20 }))
                      : state.players.push(new Position().assign({ x: 10, y: 20 }));
  }
  const encoder = new Encoder(state);
  const full = encoder.encodeAll();
  encoder.discardChanges();

  // variant A: delta encode one change
  const target = state.players.get ? state.players.get(keyOf(0)) : state.players[0];
  target.x = 15;
  const delta = encoder.encode();
  encoder.discardChanges();

  // variant B: full encode after one change
  target.x = 20; // reset then change again
  target.x = 15;
  const full2 = encoder.encodeAll();
  encoder.discardChanges();

  console.log(`${label}: fullSync=${full.length}  deltaPacket=${delta.length}  fullEncodePerChange=${full2.length}`);
}

run("ArraySchema", () => new ArrayState(), (i) => i);
run("MapSchema(numeric keys)", () => new MapState(), (i) => String(i));
run("MapSchema(nanoid-ish 9-char keys)", () => new MapState(), (i) => `p${String(i).padStart(8, "0")}`);
