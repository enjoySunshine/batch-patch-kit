// Baseline reproduction: 2000 positions, full sync once, then 2000 one-field patches.
import { Schema, defineTypes, ArraySchema, Encoder, Decoder } from "@colyseus/schema";

class Position extends Schema {
  constructor() {
    super();
    this.x = 0;
    this.y = 0;
  }
}
defineTypes(Position, { x: "number", y: "number" });

class State extends Schema {
  constructor() {
    super();
    this.players = new ArraySchema();
  }
}
defineTypes(State, { players: [Position] });

const N = 2000;

const state = new State();
for (let i = 0; i < N; i++) {
  state.players.push(new Position().assign({ x: 10, y: 20 }));
}

const encoder = new Encoder(state);
const decoder = new Decoder(new State());

// --- full sync (not timed) ---
const full = encoder.encodeAll();
encoder.discardChanges();
decoder.decode(full);
console.log(`full sync: ${full.length} bytes`);

// --- 2000 one-field patches ---
let totalBytes = 0;
const sizes = [];
const t0 = performance.now();
for (let i = 0; i < N; i++) {
  state.players[i].x = 15;
  const patch = encoder.encode();
  sizes.push(patch.length);
  decoder.decode(patch);
  encoder.discardChanges();
  totalBytes += patch.length;
}
const t1 = performance.now();

const decoded = decoder.state;
console.log(`patches: ${N}, total bytes: ${totalBytes}, per-packet: ${sizes[0]}`);
console.log(`encode+decode wall: ${(t1 - t0).toFixed(1)} ms`);
console.log(`first: x=${decoded.players[0].x} y=${decoded.players[0].y}`);
console.log(`last:  x=${decoded.players[N - 1].x} y=${decoded.players[N - 1].y}`);
console.log(`any y != 20: ${[...decoded.players].some(p => p.y !== 20)}`);
console.log(`any x != 15: ${[...decoded.players].some(p => p.x !== 15)}`);
