import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {extname, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {safeFile} from "./server.ts";

// A plain file server: snapshots also work with any static HTTP host serving
// this directory at its root and /basics as /basics.html (likewise other pages).
export function staticViewer(directory:string) {
  return createServer(async (req,res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
    try {
      const path = decodeURIComponent(new URL(req.url!, "http://localhost").pathname);
      const name = path === "/" ? "index.html" : path.slice(1) + (extname(path) ? "" : ".html");
      const data = await readFile(await safeFile(directory, name));
      const type = ({".html":"text/html", ".js":"text/javascript", ".css":"text/css", ".json":"application/json", ".log":"text/plain", ".woff2":"font/woff2", ".svg":"image/svg+xml"} as Record<string,string>)[extname(name)] ?? "application/octet-stream";
      if (name.startsWith("evidence/")) res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.writeHead(200, {"Content-Type":`${type}; charset=utf-8`}).end(req.method === "HEAD" ? undefined : data);
    } catch { res.writeHead(404).end("File unavailable"); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error("Usage: node viewer/static.ts SNAPSHOT_DIRECTORY");
  const port = Number(process.env.PORT ?? 4175);
  staticViewer(resolve(process.argv[2])).listen(port, process.env.BIND_HOST ?? "127.0.0.1", () => console.log(`Snapshot: http://localhost:${port}`));
}
