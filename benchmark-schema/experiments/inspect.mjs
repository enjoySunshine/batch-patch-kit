// Inspect delta patch contents and sizes; compare with full-snapshot encodings.
import { Schema, defineTypes, ArraySchema, MapSchema, Encoder, Decoder, OPERATION } from "@colyseus/schema";
import { Packr } from "msgpackr";

Encoder.BUFFER_SIZE = 256 * 1024;
const packr = new Packr({ useRecords: false });

class Position extends Schema {
  constructor() { super(); this.x = 0; this.y = 0; }
}
defineTypes(Position, { x: "number", y: "number" });

class MapState extends Schema {
  constructor() { super(); this.players = new MapSchema(); }
}
defineTypes(MapState, { players: { map: Position } });

const N = 2000;
const state = new MapState();
for (let i = 0; i < N; i++) {
  state.players.set(String(i), new Position().assign({ x: 10, y: 20 }));
}
const encoder = new Encoder(state);
const decoder = new Decoder(new MapState());
const full = encoder.encodeAll();
encoder.discardChanges();
decoder.decode(full);

console.log(`full sync (schema): ${full.length} bytes`);

// JSON / msgpackr full snapshots (what an app-level full re-serialize would cost)
const plain = { players: Object.fromEntries([...state.players].map(([k, v]) => [k, { x: v.x, y: v.y }])) };
const jsonBytes = Buffer.byteLength(JSON.stringify(plain));
const msgpackBytes = packr.pack(plain).length;
console.log(`full snapshot JSON: ${jsonBytes} bytes, msgpack: ${msgpackBytes}`);

// first delta packet, byte by byte
state.players.get("0").x = 15;
const p0 = encoder.encode();
encoder.discardChanges();
console.log(`\nfirst delta packet: ${p0.length} bytes ->`, [...p0]);
decoder.decode(p0);
console.log(`after decode #0: player0.x=${decoder.state.players.get("0").x}, player1.x=${decoder.state.players.get("1").x}`);

// distribution over all 2000
const sizes = [];
let total = 0;
for (let i = 1; i < N; i++) {
  state.players.get(String(i)).x = 15;
  const patch = encoder.encode();
  sizes.push(patch.length);
  total += patch.length;
  decoder.decode(patch);
  encoder.discardChanges();
}
total += p0.length;
const hist = {};
for (const s of sizes.concat([p0.length])) hist[s] = (hist[s] ?? 0) + 1;
console.log(`\ndelta size histogram (bytes -> count):`, hist);
console.log(`total delta bytes for ${N} changes: ${total}`);
console.log(`player0:`, decoder.state.players.get("0").x, decoder.state.players.get("0").y);
console.log(`player1999:`, decoder.state.players.get("1999").x, decoder.state.players.get("1999").y);
