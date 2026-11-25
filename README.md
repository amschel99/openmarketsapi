# openmarkets-api

A typed GET API for corridor liquidity and success rates from the Open Markets by Paycrest dashboard (https://openmarkets.live).

## Where the data comes from

The dashboard is a Next.js app. It fetches all of its data from one **undocumented JSON endpoint**:

```
GET https://openmarkets.live/api/markets
cache-control: public, s-maxage=10, stale-while-revalidate=50
(no CORS header, so call it server-side; this service adds `access-control-allow-origin: *`)
```

The response is `{ asOf, aggregates, book[] }`. `book` is the full order book (~200 offers). Each offer has
`provider_id, side, token, fiat, network, rate, rate_type, min, max, balance, balance_ccy, balance_usd, settled, success_pct`.
The full Zod schema is in `src/schema.ts`. Every upstream response is validated against it, so if Paycrest changes the format you get a 502 that names the fields that changed, not wrong numbers.

## Endpoints

| Route | What |
|---|---|
| `GET /v1/corridors` | One row per `fiat × side`: deduplicated liquidity (USD and local currency), providers, offers, tokens, networks, best rate, min/max order, settled count, success %. |
| `GET /v1/corridors/:fiat` | Sell and buy rows for one corridor, plus its offers, e.g. `/v1/corridors/KES`. |
| `GET /v1/offers` | The raw order book, filterable. |
| `GET /v1/summary` | Network aggregates by window (24h/7d/30d/all): volume, txns, network success %, median delivery, active providers and apps. |
| `GET /v1/snapshot` | The full validated upstream payload. |

Filters on every list route: `side=sell|buy`, `fiat`, `token`, `network`, `provider`, `minLiquidityUsd`.
Filters are applied **before** aggregation, so `/v1/corridors?token=USDT&network=base` gives the USDT-on-Base liquidity per corridor.

`side=sell` means stablecoin in, fiat paid out (off-ramp). `side=buy` means fiat in, stablecoin delivered (on-ramp).

## Two calculations worth knowing

**Liquidity is deduplicated.** One provider's balance appears on every offer it backs, so summing `balance_usd` per offer overstates liquidity about 10x ($3.1M vs $293k). The rules:
- sell: one fiat balance per `provider + currency`
- buy: one token balance per `provider + token + network`

This matches the dashboard's "Live liquidity" figure to the dollar ($293,181.72 vs $293,182 shown on 24 Nov 2026). The upstream `aggregates.liveLiquidityUsd` field differs a bit ($316,746) and seems to be calculated another way. `/v1/summary` returns both.

**Rows are rate tiers, not separate markets.** One market (provider × side × token × fiat) is listed once per network and once per order-size band (e.g. 10–29.99, 30–99.99, 100–249.99 USDC, each at a slightly different rate). `settled` and `success_pct` belong to the market and are copied onto every row. So the API counts them once per market. Summing per row overstates Kenya's settled orders by about 5x. Each corridor returns `markets` (distinct provider × token markets) and `offers` (raw rows).

**Success % is attempt-weighted.** `success_pct` is settled ÷ attempted per market, so the corridor rate is Σsettled ÷ Σ(settled ÷ pct). Markets with no history are left out (`null` if none have any). `successPctSettledWeighted` is included for comparison.

**Best rate is per token** (`bestRateByToken`), because CNGN→NGN (≈1) and USDT→NGN (≈1,439) can't be compared directly.

Example, live on 24 Nov 2026: `KES:sell` has $65,479 liquidity, 3 providers, 5 markets across 20 rows, 6,911 settled, and 98.6% success.

## Run locally

```bash
npm install
npm run build && npm start        # :8787  (PORT, CACHE_TTL_MS, OPENMARKETS_URL env vars)
npm test                          # tests on real rows captured from the live feed
curl 'localhost:8787/v1/corridors?side=sell'
```

## Deploy (Cloudflare Workers, free tier is plenty)

```bash
npm run deploy                    # = npx wrangler deploy; logs you into Cloudflare the first time
# -> https://openmarkets-api.<your-subdomain>.workers.dev/v1/corridors
```

The same `app()` fetch handler (`src/app.ts`) runs in both places: `src/server.ts` is the Node adapter and `src/worker.ts` the Worker entry. It also runs unchanged on Deno, Bun or Vercel Edge.

Upstream responses are cached for 15s and requests are coalesced. If upstream fails, the last good snapshot is served (`stale: true` on `/v1/summary`).

## Caveats

- `/api/markets` is not a published or supported API. It can change or be locked down without notice. If you're building something serious, ask Paycrest for a supported feed or permission.
- Provider IDs are anonymised by Paycrest.
