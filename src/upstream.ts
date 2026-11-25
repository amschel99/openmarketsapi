import { SnapshotSchema, type Snapshot } from "./schema.js";

const env = (k: string): string | undefined => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[k];

export const UPSTREAM_URL = env("OPENMARKETS_URL") ?? "https://openmarkets.live/api/markets";

/** Upstream sends `s-maxage=10`; we cache a little longer to be polite. */
const TTL_MS = Number(env("CACHE_TTL_MS") ?? 15_000);

let cache: { at: number; data: Snapshot } | null = null;
let inflight: Promise<Snapshot> | null = null;

export class UpstreamError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

export async function getSnapshot(): Promise<{ data: Snapshot; fetchedAt: Date; stale: boolean }> {
  if (cache && Date.now() - cache.at < TTL_MS) {
    return { data: cache.data, fetchedAt: new Date(cache.at), stale: false };
  }
  try {
    inflight ??= fetchSnapshot().finally(() => (inflight = null));
    const data = await inflight;
    cache = { at: Date.now(), data };
    return { data, fetchedAt: new Date(cache.at), stale: false };
  } catch (err) {
    // Serve last good copy rather than failing if upstream blips.
    if (cache) return { data: cache.data, fetchedAt: new Date(cache.at), stale: true };
    throw err;
  }
}

async function fetchSnapshot(): Promise<Snapshot> {
  const res = await fetch(UPSTREAM_URL, {
    headers: { accept: "application/json", "user-agent": "openmarkets-api/0.1 (+typed wrapper)" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new UpstreamError(`upstream HTTP ${res.status}`);
  const json: unknown = await res.json();
  const parsed = SnapshotSchema.safeParse(json);
  if (!parsed.success) {
    throw new UpstreamError(`upstream schema changed: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}
