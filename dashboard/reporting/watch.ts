import {readdir, lstat} from "node:fs/promises";
import {join, resolve, relative, sep} from "node:path";
import {pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
import {atomicJSON, outputOutsideArtifacts, publish} from "./publish.ts";

// Polling works across Docker Desktop bind mounts. Inspect file metadata only;
// follow no directory/file symlinks and serialize imports to prevent stale writes.
async function fingerprint(root: string) {
  const entries: string[] = [];
  const groups: Record<string, string[]> = Object.create(null);
  async function walk(directory: string) {
    for (const entry of await readdir(directory, {withFileTypes:true})) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const stat = await lstat(path, {bigint:true});
        const item = `${path}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`, parts = relative(root, path).split(sep);
        entries.push(item); (groups[parts.length > 1 ? parts[0] : "."] ??= []).push(item);
      }
    }
  }
  await walk(root);
  const hash = (items: string[]) => createHash("sha256").update(items.sort().join("\n")).digest("hex");
  return {hash:hash(entries), revisions:Object.fromEntries(Object.entries(groups).map(([key, values]) => [key, hash(values)]))};
}
export async function watchArtifacts(options: {root:string; output:string; status:string; intervalMs?:number; debounceMs?:number; maxWaitMs?:number}) {
  const {root, output, status} = options;
  await outputOutsideArtifacts(root, output); await outputOutsideArtifacts(root, status);
  const interval = options.intervalMs ?? 1000, debounce = options.debounceMs ?? 750, maxWait = options.maxWaitMs ?? 5000;
  if (Math.min(interval, debounce, maxWait) < 10) throw new Error("Invalid watcher timing");
  let stopped = false, previous = "", pendingSince = 0, changedAt = 0, lastSuccess: string | null = null, error: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined, active: Promise<void> = Promise.resolve();
  async function tick() {
    try {
      const current = await fingerprint(root), now = Date.now();
      if (current.hash !== previous) { previous = current.hash; pendingSince ||= now; changedAt = now; }
      if (!lastSuccess || pendingSince && (now - changedAt >= debounce || now - pendingSince >= maxWait)) {
        const report = await publish(root, output, current.revisions);
        lastSuccess = report.generatedAt; pendingSince = 0; error = null;
      }
    } catch (cause) {
      // Do not publish raw exception paths or overwrite the last readable report.
      if (!error) console.error("Dashboard watcher:", cause instanceof Error ? cause.message : "refresh failed");
      error = "Reporting refresh failed. Showing the last published results.";
      pendingSince ||= Date.now(); previous = "";
    }
    try { await atomicJSON(status, {heartbeat:new Date().toISOString(), lastSuccess, error, watching:!stopped}); }
    catch (cause) { console.error("Dashboard watcher status unavailable:", cause); }
    if (!stopped) timer = setTimeout(() => { active = tick(); }, interval);
  }
  active = tick(); await active;
  return {close: async () => {
    stopped = true; clearTimeout(timer); await active;
    await atomicJSON(status, {heartbeat:new Date().toISOString(), lastSuccess, error, watching:false});
  }};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, output, status] = process.argv.slice(2);
  if (!root || !output || !status) throw new Error("Usage: node reporting/watch.ts ARTIFACT_ROOT REPORT_JSON STATUS_JSON");
  const watcher = await watchArtifacts({root:resolve(root), output:resolve(output), status:resolve(status)});
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void watcher.close().then(() => process.exit()); });
}
