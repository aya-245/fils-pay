#!/usr/bin/env node
/**
 * Tiny same-origin static server + API proxy used by ui-screenshots.mjs.
 *
 * Serves a built Vite `dist/` directory (SPA fallback to index.html) and
 * forwards every `/v1/*` and `/health*` request to the API, so the apps can
 * be built with an empty VITE_API_BASE_URL and talk to the API same-origin —
 * no CORS, cookies behave exactly as they do behind the production proxy.
 *
 *   node scripts/ui-screenshots.serve.mjs --dir <dist> --port 5310 --api http://localhost:3310
 *
 * Dev tooling only. Not used by the apps themselves.
 */
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dir = path.resolve(arg("dir", "dist"));
const port = Number(arg("port", "5310"));
const api = new URL(arg("api", "http://localhost:3310"));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

function proxy(req, res) {
  const upstream = http.request(
    {
      hostname: api.hostname,
      port: api.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `${api.hostname}:${api.port}` },
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "proxy_error", message: err.message }));
  });
  req.pipe(upstream);
}

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = path.join(dir, urlPath);
  if (!file.startsWith(dir)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const s = await stat(file);
    if (s.isDirectory()) file = path.join(file, "index.html");
  } catch {
    file = path.join(dir, "index.html");
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

http
  .createServer((req, res) => {
    if (req.url?.startsWith("/v1/") || req.url?.startsWith("/health")) proxy(req, res);
    else void serveStatic(req, res);
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`ui-serve: ${dir} on http://localhost:${port} -> ${api.origin}`);
  });
