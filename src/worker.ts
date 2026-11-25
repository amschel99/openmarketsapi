import { app } from "./app.js";

/** Cloudflare Workers entry: `npx wrangler deploy`. */
export default { fetch: (req: Request) => app(req) };
