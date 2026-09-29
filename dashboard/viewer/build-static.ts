import {cp, lstat, realpath, readFile, mkdir, rm} from "node:fs/promises";
import {join, resolve, sep} from "node:path";
import {execFileSync} from "node:child_process";
import {importArtifacts} from "../reporting/importer.ts";
import {exportSnapshot} from "../reporting/export.ts";
import {outputOutsideArtifacts} from "../reporting/publish.ts";

// Local builds import raw runs; fresh clones and CI can rebuild the committed
// public snapshot. Both inputs pass through the same export allowlist.
const save = process.argv.includes("--save-snapshot");
if (process.env.SNAPSHOT_ROOT && (process.env.ARTIFACT_ROOT || save)) throw new Error("Choose raw artifacts or a saved snapshot, not both");
const raw = resolve(process.env.ARTIFACT_ROOT ?? "../artifacts");
const rawExists = await lstat(raw).then(() => true).catch((error:NodeJS.ErrnoException) => {
  if (error.code !== "ENOENT") throw error;
  return false;
});
const saved = process.env.SNAPSHOT_ROOT ?? (!rawExists && !process.env.ARTIFACT_ROOT && !save ? "published" : null);
const artifacts = await realpath(saved ? resolve(saved) : raw);
const output = resolve("dist");
await outputOutsideArtifacts(artifacts, join(output, "index.html"));
if (artifacts === output || artifacts.startsWith(output + sep)) throw new Error("Artifacts must be outside dist");
const existing = await lstat(output).catch((error:NodeJS.ErrnoException) => {
  if (error.code !== "ENOENT") throw error;
  return null;
});
if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error("dist must be a regular generated directory");
const report = saved ? JSON.parse(await readFile(join(artifacts,"data/report.json"),"utf8")) : await importArtifacts(artifacts);
const manifest = saved ? JSON.parse(await readFile(join(artifacts,"snapshot.json"),"utf8")) : null;
if (saved && (report.schemaVersion !== 1 || manifest.schemaVersion !== 1 || !Array.isArray(manifest.runIds) ||
  !Array.isArray(report.runs) || JSON.stringify(report.runs.map((run:{id:string}) => run.id)) !== JSON.stringify(manifest.runIds) ||
  !Number.isFinite(Date.parse(manifest.generatedAt)))) throw new Error("Saved snapshot manifest does not match its report");
const runIds = (process.env.RUN_IDS ?? "").split(",").map(id => id.trim()).filter(Boolean);
const snapshot = await exportSnapshot({report, artifacts, output:resolve(".generated/static-data"), runIds:runIds.length ? runIds : manifest?.runIds, generatedAt:manifest?.generatedAt});
execFileSync(process.execPath, ["viewer/build.ts", "--config", "observablehq.static.config.js"], {
  stdio:"inherit", env:{...process.env, STATIC_SNAPSHOT:join(snapshot, "snapshot.json")}
});
for (const name of ["data", "evidence", "snapshot.json", ".nojekyll"]) {
  await cp(join(snapshot, name), join(output, name), {recursive:true, errorOnExist:true, force:false});
}
if (save) {
  const published = resolve("published");
  await outputOutsideArtifacts(artifacts, join(published,"snapshot.json"));
  if (artifacts === published || artifacts.startsWith(published + sep)) throw new Error("Raw artifacts must be outside published");
  const existing = await lstat(published).catch((error:NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error("published must be a regular directory");
  await mkdir(published,{recursive:true});
  // These three generated entries are replaced together in the next Git commit.
  // Other files, such as the snapshot README, are preserved.
  for (const name of ["data","evidence","snapshot.json"]) {
    await rm(join(published,name),{recursive:true,force:true});
    await cp(join(snapshot,name),join(published,name),{recursive:true});
  }
  console.log("Updated published/{data,evidence,snapshot.json}. Review and commit the new results before pushing.");
}
console.log(`Static dashboard: ${output}\nPreview: npm run preview\nPublish the contents of dist, including .nojekyll.`);
