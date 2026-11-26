// Benchmark: 2000 players, full sync once (untimed), then every player moves
// x: 10 -> 15. Two accepted strategies are measured against the budgets:
//
//   A. one small delta packet per person (2000 packets, sequential decodes)
//   B. all 2000 changes coalesced into a single delta packet (1 packet)
//
// A "full snapshot per change" mode is also run to document the failure
// profile (the reported ~39,750-byte packets / 79.5 MB total).
//
// Budgets (only the post-sync phase is timed):
//   encode + decode <= 400 ms
//   bytes actually sent (subarray length; unused buffer capacity excluded) < 200_000
//
// Run: node src/benchmark.mjs [--runs 3] [--no-preview]
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Encoder, Decoder } from "@colyseus/schema";
import {
  GameState, createState, playerKey,
  PLAYER_COUNT, INITIAL_X, INITIAL_Y, TARGET_X,
} from "./state.mjs";

// Match the harness described in the task: 256 KB backing buffer.
Encoder.BUFFER_SIZE = 256 * 1024;

const TIME_BUDGET_MS = 400;
const BYTE_BUDGET = 200_000;
const here = dirname(fileURLToPath(import.meta.url));

const args = new Set(process.argv.slice(2));
const RUNS = Number(args.has("--runs") ? process.argv[process.argv.indexOf("--runs") + 1] : 3);
const WRITE_PREVIEW = !args.has("--no-preview");

function assert(cond, message) {
  if (!cond) { throw new Error(`assertion failed: ${message}`); }
}

/** Full snapshot sync — per the task, its cost is measured but never budgeted. */
function fullSync(state) {
  const encoder = new Encoder(state);
  const decoder = new Decoder(new GameState());
  const t0 = performance.now();
  const snapshot = encoder.encodeAll();
  encoder.discardChanges();
  decoder.decode(snapshot);
  const t1 = performance.now();
  return { encoder, decoder, bytes: snapshot.length, ms: t1 - t0 };
}

function checkRoster(decoder, expectedX) {
  const players = decoder.state.players;
  assert(players.size === PLAYER_COUNT, `roster size ${players.size} != ${PLAYER_COUNT}`);
  for (let i = 0; i < PLAYER_COUNT; i++) {
    const p = players.get(playerKey(i));
    assert(p.x === expectedX(i), `player ${i} x=${p.x}, expected ${expectedX(i)}`);
    assert(p.y === INITIAL_Y, `player ${i} y=${p.y}, expected ${INITIAL_Y} (y must never move)`);
  }
}

// ---------------------------------------------------------------- strategy A

/** One small delta packet per changed person; the other side decodes in order. */
function runPerPersonDelta() {
  const state = createState();
  const sync = fullSync(state);
  checkRoster(sync.decoder, () => INITIAL_X);

  const sizeHist = {};
  const packetSizes = [];
  let totalBytes = 0;
  let encodeMs = 0;
  let decodeMs = 0;

  for (let i = 0; i < PLAYER_COUNT; i++) {
    state.players.get(playerKey(i)).x = TARGET_X;

    let t = performance.now();
    // encoder.encode() returns a subarray view — its `.length` is the real
    // wire length; the unused tail of the 256 KB backing buffer is not sent.
    const packet = sync.encoder.encode();
    encodeMs += performance.now() - t;

    t = performance.now();
    sync.decoder.decode(packet);
    decodeMs += performance.now() - t;

    sync.encoder.discardChanges();

    packetSizes.push(packet.length);
    sizeHist[packet.length] = (sizeHist[packet.length] ?? 0) + 1;
    totalBytes += packet.length;

    if (i === 0) {
      // First packet: player 0 already at 15, everyone not yet touched still at 10.
      const players = sync.decoder.state.players;
      assert(players.get("0").x === TARGET_X, "after packet #0 player0.x should be 15");
      assert(players.get("0").y === INITIAL_Y, "after packet #0 player0.y should remain 20");
      assert(players.get("1").x === INITIAL_X, "after packet #0 player1.x should still be 10");
      assert(players.get(String(PLAYER_COUNT - 1)).x === INITIAL_X,
        "after packet #0 last player's x should still be 10");
    }
  }

  checkRoster(sync.decoder, () => TARGET_X);

  return {
    name: "A. one delta packet per person (2000 packets)",
    packets: PLAYER_COUNT,
    totalBytes,
    encodeMs,
    decodeMs,
    totalMs: encodeMs + decodeMs,
    sizeHist,
    minPacket: Math.min(...packetSizes),
    maxPacket: Math.max(...packetSizes),
    syncBytes: sync.bytes,
    syncMs: sync.ms,
  };
}

// ---------------------------------------------------------------- strategy B

/** All 2000 mutations coalesced; one encode, one decode, final state only. */
function runCoalescedDelta() {
  const state = createState();
  const sync = fullSync(state);
  checkRoster(sync.decoder, () => INITIAL_X);

  for (let i = 0; i < PLAYER_COUNT; i++) {
    state.players.get(playerKey(i)).x = TARGET_X;
  }

  const t0 = performance.now();
  const packet = sync.encoder.encode();
  const t1 = performance.now();
  sync.encoder.discardChanges();

  const t2 = performance.now();
  sync.decoder.decode(packet);
  const t3 = performance.now();

  checkRoster(sync.decoder, () => TARGET_X);

  return {
    name: "B. all changes coalesced into one packet (1 packet)",
    packets: 1,
    totalBytes: packet.length,
    encodeMs: t1 - t0,
    decodeMs: t3 - t2,
    totalMs: (t1 - t0) + (t3 - t2),
    sizeHist: { [packet.length]: 1 },
    minPacket: packet.length,
    maxPacket: packet.length,
    syncBytes: sync.bytes,
    syncMs: sync.ms,
  };
}

// ------------------------------------------------- reference (failing) mode

/** Full snapshot re-encoded after every change — reproduces the 79.5 MB report. */
function runFullSnapshotPerChange() {
  const state = createState();
  const sync = fullSync(state);

  let totalBytes = 0;
  let encodeMs = 0;
  let decodeMs = 0;
  for (let i = 0; i < PLAYER_COUNT; i++) {
    state.players.get(playerKey(i)).x = TARGET_X;

    let t = performance.now();
    const packet = sync.encoder.encodeAll();
    encodeMs += performance.now() - t;

    t = performance.now();
    sync.decoder.decode(packet);
    decodeMs += performance.now() - t;

    sync.encoder.discardChanges();
    totalBytes += packet.length;
  }
  checkRoster(sync.decoder, () => TARGET_X);

  return {
    name: "REF. full snapshot re-encoded per change (the reported failure)",
    packets: PLAYER_COUNT,
    totalBytes,
    encodeMs,
    decodeMs,
    totalMs: encodeMs + decodeMs,
    minPacket: totalBytes / PLAYER_COUNT,
    maxPacket: totalBytes / PLAYER_COUNT,
    syncBytes: sync.bytes,
    syncMs: sync.ms,
    reference: true,
  };
}

function bestOf(fn, runs) {
  let best = null;
  for (let r = 0; r < runs; r++) {
    const result = fn();
    if (best === null || result.totalMs < best.totalMs) { best = result; }
  }
  return best;
}

function passLabel(r) {
  const timeOk = r.totalMs <= TIME_BUDGET_MS;
  const bytesOk = r.totalBytes < BYTE_BUDGET;
  return (timeOk && bytesOk) ? "PASS" : "FAIL";
}

function printResult(r) {
  const tag = r.reference ? "(reference, not a candidate)" : passLabel(r);
  console.log(`\n${r.name}  [${tag}]`);
  console.log(`  full sync (untimed) : ${r.syncBytes} bytes, ${r.syncMs.toFixed(1)} ms`);
  console.log(`  packets sent        : ${r.packets}`);
  if (r.sizeHist) {
    const hist = Object.entries(r.sizeHist)
      .map(([size, count]) => `${size}B x${count}`).join(", ");
    console.log(`  packet sizes        : ${hist}`);
  } else {
    console.log(`  packet size         : ${r.minPacket} bytes (constant)`);
  }
  console.log(`  bytes sent (wire)   : ${r.totalBytes.toLocaleString()}` +
    `   (budget < ${BYTE_BUDGET.toLocaleString()})`);
  console.log(`  encode only         : ${r.encodeMs.toFixed(1)} ms`);
  console.log(`  decode only         : ${r.decodeMs.toFixed(1)} ms`);
  console.log(`  encode + decode     : ${r.totalMs.toFixed(1)} ms` +
    `   (budget <= ${TIME_BUDGET_MS} ms)`);
}

function writePreview(results) {
  const a = results.find((r) => r.name.startsWith("A."));
  const b = results.find((r) => r.name.startsWith("B."));
  const ref = results.find((r) => r.reference);
  const rows = results.map((r) => `
      <tr class="${r.reference ? "ref" : passLabel(r).toLowerCase()}">
        <td>${r.name}</td>
        <td class="num">${r.packets}</td>
        <td class="num">${r.totalBytes.toLocaleString()}</td>
        <td class="num">${r.encodeMs.toFixed(1)}</td>
        <td class="num">${r.decodeMs.toFixed(1)}</td>
        <td class="num">${r.totalMs.toFixed(1)}</td>
        <td class="tag">${r.reference ? "reference" : passLabel(r)}</td>
      </tr>`).join("");

  const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<title>2000 人横坐标迁移 — 序列化基准</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.25rem; }
  .canvas-wrap { border: 1px solid #ccc; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  svg { display: block; }
  .dot-first { fill: #2563eb; }
  .dot-last  { fill: #dc2626; }
  .label { font-size: 13px; fill: #1a1a1a; }
  .axis { stroke: #999; stroke-width: 1; }
  table { border-collapse: collapse; margin-top: 1rem; font-size: 0.9rem; }
  th, td { border: 1px solid #ccc; padding: 0.4rem 0.7rem; text-align: left; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.pass .tag { color: #15803d; font-weight: 700; }
  tr.fail .tag { color: #b91c1c; font-weight: 700; }
  tr.ref { color: #777; }
  code { background: #f3f4f6; padding: 0.1rem 0.35rem; border-radius: 4px; }
</style>
</head>
<body>
  <h1>地图预览（只画第一个和最后一个点；共 ${PLAYER_COUNT} 人，纵坐标全程 ${INITIAL_Y}）</h1>
  <div class="canvas-wrap">
    <svg width="640" height="300" viewBox="0 0 640 300" role="img" aria-label="first and last player coordinates">
      <line class="axis" x1="60" y1="250" x2="600" y2="250" />
      <line class="axis" x1="60" y1="250" x2="60"  y2="30" />
      <text class="label" x="590" y="270">x</text>
      <text class="label" x="30"  y="40">y</text>
      <!-- x grid 0..20, y grid 0..30 -->
      ${[0, 5, 10, 15, 20].map((gx) => {
        const cx = 60 + (gx / 20) * 540;
        return `<line class="axis" x1="${cx}" y1="250" x2="${cx}" y2="255" />
        <text class="label" x="${cx - 6}" y="270">${gx}</text>`;
      }).join("")}
      ${[0, 10, 20, 30].map((gy) => {
        const cy = 250 - (gy / 30) * 220;
        return `<line class="axis" x1="55" y1="${cy}" x2="60" y2="${cy}" />
        <text class="label" x="28" y="${cy + 4}">${gy}</text>`;
      }).join("")}
      <!-- both players end at (15, 20); offset slightly so both labels are visible -->
      <circle class="dot-first" cx="${60 + (TARGET_X / 20) * 540 - 6}" cy="${250 - (INITIAL_Y / 30) * 220}" r="6" />
      <text class="label" x="${60 + (TARGET_X / 20) * 540 - 150}" y="${250 - (INITIAL_Y / 30) * 220 - 12}">
        第 1 人 player[0] = (${TARGET_X}, ${INITIAL_Y})
      </text>
      <circle class="dot-last" cx="${60 + (TARGET_X / 20) * 540 + 6}" cy="${250 - (INITIAL_Y / 30) * 220}" r="6" />
      <text class="label" x="${60 + (TARGET_X / 20) * 540 + 16}" y="${250 - (INITIAL_Y / 30) * 220 + 4}">
        最后一人 player[${PLAYER_COUNT - 1}] = (${TARGET_X}, ${INITIAL_Y})
      </text>
      <!-- faint ghost of the starting position (10, 20) -->
      <circle cx="${60 + (INITIAL_X / 20) * 540}" cy="${250 - (INITIAL_Y / 30) * 220}" r="4"
              fill="none" stroke="#9ca3af" stroke-dasharray="3 3" />
      <text class="label" x="${60 + (INITIAL_X / 20) * 540 - 70}" y="${250 - (INITIAL_Y / 30) * 220 + 22}" fill="#6b7280">
        起点 (${INITIAL_X}, ${INITIAL_Y})
      </text>
    </svg>
  </div>

  <h1>终端指标（仅计整包同步之后的 ${PLAYER_COUNT} 次横坐标修改；字节按实际发出长度统计，256KB 缓冲未用部分不计）</h1>
  <table>
    <thead>
      <tr><th>方案</th><th>包数</th><th>发出字节</th><th>编码 ms</th><th>解码 ms</th><th>合计 ms</th><th>结果</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <p>预算：编码+解码 ≤ <code>${TIME_BUDGET_MS} ms</code>，总字节 &lt; <code>${BYTE_BUDGET.toLocaleString()}</code>。
     方案 A 首包解完：<code>player[0].x = ${TARGET_X}</code>，其余仍为 <code>${INITIAL_X}</code>；
     全部解完：所有人 x = <code>${TARGET_X}</code>，y = <code>${INITIAL_Y}</code>。
     参考模式每人发整包快照（${ref.minPacket} B/包 × ${ref.packets} =
     ${ref.totalBytes.toLocaleString()} B）即题目描述的失败形态。</p>
</body>
</html>`;

  const out = join(here, "..", "preview.html");
  writeFileSync(out, html);
  return out;
}

// --------------------------------------------------------------------- main

console.log(`players=${PLAYER_COUNT}, initial=(${INITIAL_X},${INITIAL_Y}), target x=${TARGET_X},` +
  ` runs=${RUNS} (best run reported), backing buffer=${Encoder.BUFFER_SIZE / 1024} KB`);

const a = bestOf(runPerPersonDelta, RUNS);
const b = bestOf(runCoalescedDelta, RUNS);
const ref = bestOf(runFullSnapshotPerChange, RUNS);
const results = [a, b, ref];

for (const r of results) { printResult(r); }

if (WRITE_PREVIEW) {
  const out = writePreview(results);
  console.log(`\npreview written: ${out}`);
}

const failures = results.filter((r) => !r.reference && passLabel(r) === "FAIL");
console.log(`\nbudgets: <= ${TIME_BUDGET_MS} ms, < ${BYTE_BUDGET.toLocaleString()} bytes ->` +
  ` ${failures.length === 0 ? "BOTH STRATEGIES PASS" : `${failures.length} STRATEGY FAILED`}`);
process.exit(failures.length === 0 ? 0 : 1);
