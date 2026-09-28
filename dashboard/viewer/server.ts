import { createServer } from "node:http";
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve, relative, sep, extname } from "node:path";
import { pathToFileURL } from "node:url";
import type { Report } from "../reporting/model.ts";

/** Both the allowlist and a component-by-component boundary check are required. */
export async function safeFile(root: string, name: string): Promise<string> {
  if (!name || name.includes("\\") || name.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Unsafe path");
  const base = await realpath(root);
  let path = base;
  for (const part of name.split("/")) {
    path = resolve(path, part);
    if ((await lstat(path)).isSymbolicLink()) throw new Error("Symlink");
  }
  const rel = relative(base, await realpath(path));
  const info = await lstat(path);
  if (rel.startsWith(`..${sep}`) || rel === ".." || !info.isFile() || info.size > 64 * 1024 * 1024) throw new Error("Unsafe file");
  return path;
}

export function viewer(options: { artifacts: string; report: string; site: string }) {
  return createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
    try {
      const url = new URL(req.url!, "http://localhost");
      let data: Buffer | string, type: string;
      if (url.pathname === "/api/report" || url.pathname === "/api/evidence") {
        const report: Report = JSON.parse(await readFile(options.report, "utf8"));
        if (report.schemaVersion !== 1) throw new Error("Unsupported report");
        if (url.pathname === "/api/report") {
          data = JSON.stringify(report); type = "application/json";
        } else {
          const name = url.searchParams.get("path") ?? "";
          if (!report.runs.some(run => run.evidence.some(ref => ref.path === name))) { res.writeHead(404).end("Evidence not available"); return; }
          data = await readFile(await safeFile(options.artifacts, name)); type = "text/plain";
          // Evidence is always inert text, including HTML-looking logs and JSON values.
          res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
        }
      } else {
        const name = decodeURIComponent(url.pathname === "/" ? "index.html" : url.pathname.slice(1));
        data = await readFile(await safeFile(options.site, name));
        type = ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml" } as Record<string, string>)[extname(name)] ?? "application/octet-stream";
      }
      res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Report or evidence unavailable. Run make dashboard-data, then reload.");
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = viewer({
    artifacts: resolve(process.env.ARTIFACT_ROOT ?? "../artifacts"),
    report: resolve(process.env.REPORT_PATH ?? ".generated/report.json"),
    site: resolve(".generated/site")
  });
  const port = Number(process.env.PORT ?? 4173);
  server.listen(port, process.env.BIND_HOST ?? "127.0.0.1", () => console.log(`Dashboard: http://localhost:${port} (manual refresh)`));
}
