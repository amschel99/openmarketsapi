import { z } from "zod";

/**
 * Upstream shape of GET https://openmarkets.live/api/markets
 * (undocumented; reverse-engineered 2026-11-24). Validated at runtime so
 * that if Paycrest changes the feed we fail loudly instead of serving junk.
 */

const Windowed = <T extends z.ZodTypeAny>(t: T) =>
  z.object({ "24h": t, "7d": t, "30d": t, all: t });

export const OfferSchema = z.object({
  provider_id: z.string(),
  /** sell = stablecoin in, fiat paid out (off-ramp). buy = fiat in, stablecoin delivered (on-ramp). */
  side: z.enum(["sell", "buy"]),
  token: z.string(), // USDT | USDC | CNGN ...
  fiat: z.string(), // ISO-4217: KES, NGN, GHS, UGX, TZS, RWF, ZMW ...
  network: z.string(), // base | arbitrum-one | bnb-smart-chain | celo | polygon | ethereum | starknet ...
  /** Fiat per 1 token. */
  rate: z.number(),
  rate_type: z.enum(["floating", "fixed"]).or(z.string()),
  /** Order size limits, in token units. */
  min: z.number(),
  max: z.number(),
  /** Provider balance backing this offer, in balance_ccy (fiat for sell, token for buy). */
  balance: z.number(),
  balance_ccy: z.string(),
  balance_usd: z.number(),
  /** Settled orders on this offer. */
  settled: z.number().int(),
  /** Success %, 0–100. null when there is no history. */
  success_pct: z.number().nullable(),
});
export type Offer = z.infer<typeof OfferSchema>;

export const AggregatesSchema = z.object({
  settledVolumeUsd: Windowed(z.number()),
  settledTxns: Windowed(z.number()),
  networkSuccessPct: Windowed(z.number().nullable()),
  medianDeliverySecs: Windowed(z.number().nullable()),
  activeProviders: Windowed(z.number()),
  activeSenders: Windowed(z.number()),
  liveLiquidityUsd: z.number(),
  corridors: z.number(),
  tokens: z.number(),
  networks: z.number(),
}).passthrough();
export type Aggregates = z.infer<typeof AggregatesSchema>;

export const SnapshotSchema = z.object({
  asOf: z.string(),
  aggregates: AggregatesSchema,
  book: z.array(OfferSchema),
}).passthrough();
export type Snapshot = z.infer<typeof SnapshotSchema>;

export type Side = Offer["side"];

/* ------------------------------ API output ------------------------------ */

export interface Corridor {
  /** e.g. "KES:sell" */
  id: string;
  fiat: string;
  country: string | null;
  side: Side;
  /** Deduplicated provider balance available in this corridor, USD. */
  liquidityUsd: number;
  /** Same liquidity in the balance currency(ies), keyed by currency. */
  liquidityByCcy: Record<string, number>;
  providers: number;
  /** Distinct provider × token markets. */
  markets: number;
  /** Raw book rows (one per network × order-size tier). */
  offers: number;
  tokens: string[];
  networks: string[];
  /** Best rate per token for the user: highest fiat/token for sell, lowest for buy. */
  bestRateByToken: Record<string, number>;
  /** Smallest min and largest max order across offers, in token units. */
  minOrder: number;
  maxOrder: number;
  /** Settled orders, counted once per market. */
  settled: number;
  /**
   * Attempt-weighted success rate, 0–100: Σsettled / Σ(settled / success_pct).
   * null when no offer in the corridor has history.
   */
  successPct: number | null;
  /** Simple settled-weighted mean of offer success_pct, for comparison. */
  successPctSettledWeighted: number | null;
}

export interface CorridorsResponse {
  asOf: string;
  fetchedAt: string;
  totals: { liquidityUsd: number; corridors: number; offers: number };
  corridors: Corridor[];
}

export const CountryByFiat: Record<string, string> = {
  KES: "Kenya",
  NGN: "Nigeria",
  GHS: "Ghana",
  UGX: "Uganda",
  TZS: "Tanzania",
  RWF: "Rwanda",
  ZMW: "Zambia",
  MWK: "Malawi",
  XOF: "West Africa (CFA)",
  BRL: "Brazil",
};
