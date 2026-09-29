import { createServer } from "node:http";
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve, relative, sep, extname } from "node:path";
import { pathToFileURL } from "node:url";
import type { Report } from "../reporting/model.ts";
import { services } from "../reporting/presentation.ts";

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

export function viewer(options: { artifacts: string; report: string; site: string; repository?: string; watchStatus?: string }) {
  return createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
    try {
      const url = new URL(req.url!, "http://localhost");
      // Retired presentation route, including any stale output from an older build.
      if (["/evidence", "/evidence.html", "/evidence/"].includes(decodeURIComponent(url.pathname))) { res.writeHead(404).end("Page removed"); return; }
      let data: Buffer | string, type: string;
      if (url.pathname === "/api/status") {
        let status: Record<string, unknown> = {mode:"manual"};
        if (options.watchStatus) {
          try {
            const saved = JSON.parse(await readFile(options.watchStatus, "utf8"));
            const fresh = Number.isFinite(Date.parse(saved.heartbeat)) && Date.now() - Date.parse(saved.heartbeat) < 15_000;
            status = {mode:saved.watching && fresh ? "watching" : "paused", lastSuccess:saved.lastSuccess, error:saved.error ? "Reporting refresh failed. Showing the last published results." : null};
          } catch { /* manual mode until the first watcher publication */ }
        }
        data = JSON.stringify(status); type = "application/json";
      } else if (url.pathname === "/api/report" || url.pathname === "/api/evidence" || url.pathname === "/api/service-log") {
        const report: Report = JSON.parse(await readFile(options.report, "utf8"));
        if (report.schemaVersion !== 1) throw new Error("Unsupported report");
        if (url.pathname === "/api/report") {
          data = JSON.stringify(report); type = "application/json";
        } else {
          const service = url.searchParams.get("service") ?? "";
          const run = report.runs.find(r => r.id === url.searchParams.get("run"));
          const name = url.pathname === "/api/service-log" ? run?.evidence.find(ref => ref.path.endsWith("/compose.log"))?.path ?? "" : url.searchParams.get("path") ?? "";
          if (url.pathname === "/api/service-log" && !(services as readonly string[]).includes(service)) { res.writeHead(404).end(); return; }
          if (!report.runs.some(run => run.evidence.some(ref => ref.path === name))) { res.writeHead(404).end("Evidence not available"); return; }
          data = await readFile(await safeFile(options.artifacts, name)); type = "text/plain";
          if (url.pathname === "/api/service-log") data = data.toString("utf8").split("\n").filter(line => new RegExp(`^${service}-\\d+\\s+\\|`).test(line)).join("\n") || "No lines for this service were recorded in the combined log.";
          // Evidence is always inert text, including HTML-looking logs and JSON values.
          res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
        }
      } else if (url.pathname === "/api/source") {
        const name = url.searchParams.get("path") ?? "";
        const allowed = ["Makefile", "compose.yaml", "compose.phase4.yaml", "scripts/e2e-checks.sh", "scripts/e2e.sh", "scripts/phase4.sh", "scripts/phase5.sh", "scripts/phase5-suite.sh", "Sources/E2EHarness/ScenarioHarness.swift", "Sources/E2EHarness/Scenario.swift", "Sources/E2EHarness/PhaseFour.swift", "Sources/E2EHarness/PhaseFive.swift"];
        if (!options.repository || !allowed.includes(name)) { res.writeHead(404).end(); return; }
        data = await readFile(await safeFile(options.repository, name)); type = "text/plain";
        res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      } else {
        const route = url.pathname === "/" ? "/index.html" : extname(url.pathname) ? url.pathname : `${url.pathname}.html`;
        const name = decodeURIComponent(route.slice(1));
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
    site: resolve(".generated/site"), repository: resolve(".."), watchStatus: process.env.WATCH_STATUS_PATH
  });
  const port = Number(process.env.PORT ?? 4173);
  server.listen(port, process.env.BIND_HOST ?? "127.0.0.1", () => console.log(`Dashboard: http://localhost:${port} (manual refresh)`));
}
