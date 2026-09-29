import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {extname, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {safeFile} from "./server.ts";

// A plain file server, with an optional mount path to reproduce GitHub Pages.
// No API handlers or SPA fallback: only files in the published package exist.
export function staticViewer(directory:string, basePath = "/") {
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(basePath)) throw new Error("Use a path such as /maxwell-mysql-consumer/");
  return createServer(async (req,res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
    try {
      const url = new URL(req.url!, "http://localhost");
      const path = decodeURIComponent(url.pathname);
      if (basePath !== "/" && path === basePath.slice(0, -1)) { res.writeHead(301, {Location:basePath + url.search}).end(); return; }
      if (!path.startsWith(basePath)) { res.writeHead(404).end("File unavailable"); return; }
      const name = path.slice(basePath.length) || "index.html";
      const data = await readFile(await safeFile(directory, name));
      const type = ({".html":"text/html", ".js":"text/javascript", ".css":"text/css", ".json":"application/json", ".log":"text/plain", ".woff2":"font/woff2", ".svg":"image/svg+xml"} as Record<string,string>)[extname(name)] ?? "application/octet-stream";
      if (name.startsWith("evidence/")) res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.writeHead(200, {"Content-Type":`${type}; charset=utf-8`}).end(req.method === "HEAD" ? undefined : data);
    } catch { res.writeHead(404).end("File unavailable"); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error("Usage: node viewer/static.ts SNAPSHOT_DIRECTORY [BASE_PATH]");
  const port = Number(process.env.PORT ?? 4175);
  const basePath = process.argv[3] ?? "/";
  staticViewer(resolve(process.argv[2]), basePath).listen(port, process.env.BIND_HOST ?? "127.0.0.1", () => console.log(`Snapshot: http://localhost:${port}${basePath}`));
}
