import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SnapshotSchema } from "../src/schema.js";
import { buildCorridors, dedupedLiquidity } from "../src/corridors.js";
import { app } from "../src/app.js";

// Real rows from https://openmarkets.live/api/markets, 2026-11-24T18:32Z.
// The KES:sell corridor is complete; the others are slices.
const raw = readFileSync(new URL("./fixture.json", import.meta.url), "utf8");
const snap = SnapshotSchema.parse(JSON.parse(raw));
const byId = Object.fromEntries(buildCorridors(snap.book).map((c) => [c.id, c]));
const r2 = (n: number) => Math.round(n * 100) / 100;

test("KES: balances counted once per provider, despite 20 rows", () => {
  const kes = byId["KES:sell"]!;
  assert.equal(kes.offers, 20);
  assert.equal(kes.markets, 5);
  assert.equal(kes.providers, 3);
  assert.equal(kes.liquidityUsd, r2(65250.22988482801 + 227.97627457002457 + 0.9133138820638821));
});

test("KES: settled counted once per market, not per network row", () => {
  assert.equal(byId["KES:sell"]!.settled, 6321 + 497 + 1 + 83 + 9);
});

test("KES: success rate pools attempts across markets", () => {
  const attempts = 6321 / 0.9904 + 497 / 0.9632 + 1 / 0.3333 + 83 / 0.8384 + 9 / 1;
  assert.equal(byId["KES:sell"]!.successPct, r2((6911 / attempts) * 100));
});

test("NGN: size tiers don't multiply settled; best rate is per token", () => {
  const ngn = byId["NGN:sell"]!;
  assert.equal(ngn.settled, 1145 + 1727 + 3012);
  assert.deepEqual(ngn.bestRateByToken, { USDC: 1440.21, CNGN: 0.9998, USDT: 1439.19 });
  assert.equal(ngn.liquidityUsd, r2(1930.6965684278805 + 18871.035771706953));
});

test("buy side: token balances are per network", () => {
  const buy = byId["NGN:buy"]!;
  assert.equal(buy.liquidityUsd, r2(1377.146085 + 6417.819395 + 521.2720263792606));
  assert.equal(buy.settled, 644 + 129);
  assert.equal(buy.bestRateByToken.USDC, 1457.56);
});

test("no-history corridor has null success", () => {
  assert.equal(byId["GHS:sell"]!.successPct, null);
  assert.equal(byId["GHS:sell"]!.settled, 0);
});

test("book-wide total equals sum of corridors", () => {
  const sum = Object.values(byId).reduce((s, c) => s + c.liquidityUsd, 0);
  assert.ok(Math.abs(dedupedLiquidity(snap.book).usd - sum) < 0.05);
});

test("HTTP: routes, filters and validation", async () => {
  globalThis.fetch = (async () => new Response(raw, { headers: { "content-type": "application/json" } })) as typeof fetch;
  const get = async (p: string) => { const r = await app(new Request(`http://x${p}`)); return { status: r.status, body: await r.json() as any }; };

  const all = await get("/v1/corridors");
  assert.equal(all.status, 200);
  assert.equal(all.body.corridors[0].id, "KES:sell"); // sorted by liquidity

  const usdc = await get("/v1/corridors/KES?token=usdc");
  assert.equal(usdc.body.corridors[0].settled, 6321 + 83 + 9);

  assert.equal((await get("/v1/corridors?side=nope")).status, 400);
  assert.equal((await get("/v1/corridors/XAF")).status, 404);
  assert.equal((await get("/v1/offers?fiat=KES&provider=YyPrHKaI")).body.count, 1);
  assert.equal((await get("/v1/summary")).body.networkSuccessPct["30d"], 94.9);
});
