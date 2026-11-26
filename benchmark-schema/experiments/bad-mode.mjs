// Reproduce the reported symptom: full-state re-encode on every one-field change.
import { Schema, defineTypes, MapSchema, Encoder, Decoder } from "@colyseus/schema";

Encoder.BUFFER_SIZE = 256 * 1024;

class Position extends Schema {
  constructor() { super(); this.x = 0; this.y = 0; }
}
defineTypes(Position, { x: "number", y: "number" });

class State extends Schema {
  constructor() { super(); this.players = new MapSchema(); }
}
defineTypes(State, { players: { map: Position } });

const N = 2000;
const state = new State();
for (let i = 0; i < N; i++) {
  state.players.set(String(i), new Position().assign({ x: 10, y: 20 }));
}
const encoder = new Encoder(state);
const decoder = new Decoder(new State());

// full sync once
decoder.decode(encoder.encodeAll());
encoder.discardChanges();

// BAD: re-encode the ENTIRE state after every single change.
let totalBytes = 0;
let encodeMs = 0;
let decodeMs = 0;
for (let i = 0; i < N; i++) {
  state.players.get(String(i)).x = 15;

  let t = performance.now();
  const packet = encoder.encodeAll();          // <-- full snapshot every time
  encodeMs += performance.now() - t;

  t = performance.now();
  decoder.decode(packet);
  decodeMs += performance.now() - t;

  totalBytes += packet.length;
  encoder.discardChanges();
}

console.log(`bad mode (full encode per change):`);
console.log(`  packet size: ${totalBytes / N} bytes, total: ${totalBytes} bytes`);
console.log(`  encode only: ${encodeMs.toFixed(0)} ms`);
console.log(`  decode only: ${decodeMs.toFixed(0)} ms`);
console.log(`  encode+decode: ${(encodeMs + decodeMs).toFixed(0)} ms`);
