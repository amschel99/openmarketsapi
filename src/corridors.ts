import { CountryByFiat, type Corridor, type Offer, type Side } from "./schema.js";

/**
 * Key that identifies one pool of money, so the same balance is not counted
 * once per offer.
 *  - sell offers pay out fiat: a provider has ONE fiat balance per currency,
 *    shared across every token/network it accepts.
 *  - buy offers deliver tokens: the token balance is held per network.
 * This rule reproduces the dashboard's "Live liquidity" figure exactly
 * (checked against the live page on 2026-11-24: $293,181.72 vs $293,182).
 * Summing balance_usd per offer instead overstates liquidity about 10x.
 */
export const balanceKey = (o: Offer): string =>
  o.side === "sell"
    ? `${o.provider_id}|${o.balance_ccy}`
    : `${o.provider_id}|${o.balance_ccy}|${o.network}`;

export function dedupedLiquidity(offers: Offer[]): { usd: number; byCcy: Record<string, number> } {
  const pools = new Map<string, Offer>();
  for (const o of offers) pools.set(balanceKey(o), o);
  let usd = 0;
  const byCcy: Record<string, number> = {};
  for (const o of pools.values()) {
    usd += o.balance_usd;
    byCcy[o.balance_ccy] = (byCcy[o.balance_ccy] ?? 0) + o.balance;
  }
  return { usd, byCcy };
}

/**
 * Book rows are rate tiers: one market (provider × side × token × fiat) is
 * listed once per network and once per order-size band. `settled` and
 * `success_pct` belong to the market and are repeated on every row, so they
 * must be counted once per market key or totals inflate several-fold.
 */
export const marketKey = (o: Offer): string => `${o.provider_id}|${o.side}|${o.token}|${o.fiat}`;

export function uniqueMarkets(offers: Offer[]): Offer[] {
  const m = new Map<string, Offer>();
  for (const o of offers) if (!m.has(marketKey(o))) m.set(marketKey(o), o);
  return [...m.values()];
}

/**
 * success_pct is settled / attempted per market, so attempted ≈ settled / pct.
 * Pooling attempts gives the corridor's true rate, so a 1-of-3 market doesn't
 * weigh as much as a 6,000-order one.
 */
export function successRates(offers: Offer[]): { attemptWeighted: number | null; settledWeighted: number | null } {
  let settled = 0, attempts = 0, wSum = 0, wPct = 0;
  for (const o of uniqueMarkets(offers)) {
    if (o.success_pct === null || o.settled <= 0 || o.success_pct <= 0) continue;
    settled += o.settled;
    attempts += o.settled / (o.success_pct / 100);
    wSum += o.settled;
    wPct += o.settled * o.success_pct;
  }
  return {
    attemptWeighted: attempts > 0 ? round((settled / attempts) * 100, 2) : null,
    settledWeighted: wSum > 0 ? round(wPct / wSum, 2) : null,
  };
}

export interface OfferFilter {
  side?: Side;
  fiat?: string;
  token?: string;
  network?: string;
  provider?: string;
}

export function filterOffers(book: Offer[], f: OfferFilter): Offer[] {
  const eq = (a: string, b?: string) => b === undefined || a.toLowerCase() === b.toLowerCase();
  return book.filter(
    (o) =>
      eq(o.side, f.side) &&
      eq(o.fiat, f.fiat) &&
      eq(o.token, f.token) &&
      eq(o.network, f.network) &&
      eq(o.provider_id, f.provider),
  );
}

export function buildCorridors(book: Offer[]): Corridor[] {
  const groups = new Map<string, Offer[]>();
  for (const o of book) {
    const id = `${o.fiat}:${o.side}`;
    const g = groups.get(id);
    if (g) g.push(o);
    else groups.set(id, [o]);
  }

  const out: Corridor[] = [];
  for (const [id, offers] of groups) {
    const first = offers[0]!;
    const side = first.side;
    const liq = dedupedLiquidity(offers);
    const sr = successRates(offers);
    const bestRateByToken: Record<string, number> = {};
    for (const o of offers) {
      const cur = bestRateByToken[o.token];
      const better = cur === undefined || (side === "sell" ? o.rate > cur : o.rate < cur);
      if (better) bestRateByToken[o.token] = o.rate;
    }
    const markets = uniqueMarkets(offers);
    out.push({
      id,
      fiat: first.fiat,
      country: CountryByFiat[first.fiat] ?? null,
      side,
      liquidityUsd: round(liq.usd, 2),
      liquidityByCcy: mapValues(liq.byCcy, (v) => round(v, 2)),
      providers: new Set(offers.map((o) => o.provider_id)).size,
      markets: markets.length,
      offers: offers.length,
      tokens: uniqSorted(offers.map((o) => o.token)),
      networks: uniqSorted(offers.map((o) => o.network)),
      bestRateByToken,
      minOrder: Math.min(...offers.map((o) => o.min)),
      maxOrder: Math.max(...offers.map((o) => o.max)),
      settled: markets.reduce((s, o) => s + o.settled, 0),
      successPct: sr.attemptWeighted,
      successPctSettledWeighted: sr.settledWeighted,
    });
  }
  return out.sort((a, b) => b.liquidityUsd - a.liquidityUsd);
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
const uniqSorted = (xs: string[]) => [...new Set(xs)].sort();
const mapValues = <V, W>(o: Record<string, V>, f: (v: V) => W): Record<string, W> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v)]));
