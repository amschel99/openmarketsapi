import { createServer } from "node:http";
import { app } from "./app.js";

const PORT = Number(process.env.PORT ?? 8787);

createServer(async (req, res) => {
  const response = await app(new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, { method: req.method }));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(req.method === "HEAD" ? undefined : await response.text());
}).listen(PORT, () => console.log(`openmarkets-api listening on :${PORT}`));
