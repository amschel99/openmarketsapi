import { z } from "zod";
import { buildCorridors, dedupedLiquidity, filterOffers } from "./corridors.js";
import { getSnapshot, UpstreamError } from "./upstream.js";
import type { CorridorsResponse } from "./schema.js";

const FilterQuery = z.object({
  side: z.enum(["sell", "buy"]).optional(),
  fiat: z.string().min(3).max(4).optional(),
  token: z.string().optional(),
  network: z.string().optional(),
  provider: z.string().optional(),
  minLiquidityUsd: z.coerce.number().nonnegative().optional(),
});

type Handler = (q: URLSearchParams, params: Record<string, string>) => Promise<unknown>;

const routes: Array<[RegExp, Handler]> = [
  [/^\/health$/, async () => ({ ok: true })],

  // Upstream aggregates (network success %, volume, median delivery, by window).
  [/^\/v1\/summary$/, async () => {
    const { data, fetchedAt, stale } = await getSnapshot();
    const live = dedupedLiquidity(data.book).usd;
    return { asOf: data.asOf, fetchedAt, stale, ...data.aggregates, liveLiquidityUsdFromBook: round2(live) };
  }],

  // One row per fiat × side, with deduped liquidity and success rate.
  // Filters (token/network/provider) apply before aggregation.
  [/^\/v1\/corridors$/, async (q) => {
    const f = parse(q);
    const { data, fetchedAt } = await getSnapshot();
    const offers = filterOffers(data.book, f);
    let corridors = buildCorridors(offers);
    if (f.minLiquidityUsd !== undefined) corridors = corridors.filter((c) => c.liquidityUsd >= f.minLiquidityUsd!);
    const body: CorridorsResponse = {
      asOf: data.asOf,
      fetchedAt: fetchedAt.toISOString(),
      totals: { liquidityUsd: round2(dedupedLiquidity(offers).usd), corridors: corridors.length, offers: offers.length },
      corridors,
    };
    return body;
  }],

  // e.g. /v1/corridors/KES  -> sell and buy rows for Kenya
  [/^\/v1\/corridors\/(?<fiat>[A-Za-z]{3,4})$/, async (q, p) => {
    const f = parse(q);
    const { data, fetchedAt } = await getSnapshot();
    const offers = filterOffers(data.book, { ...f, fiat: p.fiat });
    if (!offers.length) throw new HttpError(404, `no offers for corridor ${p.fiat!.toUpperCase()}`);
    return { asOf: data.asOf, fetchedAt, corridors: buildCorridors(offers), offers };
  }],

  // Raw order book, filterable.
  [/^\/v1\/offers$/, async (q) => {
    const f = parse(q);
    const { data, fetchedAt } = await getSnapshot();
    const offers = filterOffers(data.book, f);
    return { asOf: data.asOf, fetchedAt, count: offers.length, offers };
  }],

  // Full validated upstream snapshot.
  [/^\/v1\/snapshot$/, async () => (await getSnapshot()).data],
];

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function parse(q: URLSearchParams) {
  const r = FilterQuery.safeParse(Object.fromEntries(q));
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const ROUTES = ["/v1/summary", "/v1/corridors", "/v1/corridors/:fiat", "/v1/offers", "/v1/snapshot"];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? "public, max-age=10" : "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

/** Standard fetch handler: used by the Node server and the Cloudflare Worker. */
export async function app(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET" } });
  if (req.method !== "GET" && req.method !== "HEAD") return json(405, { error: "GET only" });
  const url = new URL(req.url);
  if (url.pathname === "/") return json(200, { name: "openmarkets-api", source: "https://openmarkets.live/api/markets", routes: ROUTES });
  for (const [re, h] of routes) {
    const m = re.exec(url.pathname);
    if (!m) continue;
    try {
      return json(200, await h(url.searchParams, m.groups ?? {}));
    } catch (e) {
      if (e instanceof HttpError || e instanceof UpstreamError) return json(e.status, { error: e.message });
      console.error(e);
      return json(500, { error: "internal error" });
    }
  }
  return json(404, { error: "not found", routes: ROUTES });
}
