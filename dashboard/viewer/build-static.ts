import {cp, lstat, realpath} from "node:fs/promises";
import {join, resolve, sep} from "node:path";
import {execFileSync} from "node:child_process";
import {importArtifacts} from "../reporting/importer.ts";
import {exportSnapshot} from "../reporting/export.ts";
import {outputOutsideArtifacts} from "../reporting/publish.ts";

// Only the allowlisted export enters dist. The live report and raw artifacts
// are build-time inputs, never files published by Observable.
const artifacts = await realpath(resolve(process.env.ARTIFACT_ROOT ?? "../artifacts"));
const output = resolve("dist");
await outputOutsideArtifacts(artifacts, join(output, "index.html"));
if (artifacts === output || artifacts.startsWith(output + sep)) throw new Error("Artifacts must be outside dist");
const existing = await lstat(output).catch((error:NodeJS.ErrnoException) => {
  if (error.code !== "ENOENT") throw error;
  return null;
});
if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error("dist must be a regular generated directory");
const report = await importArtifacts(artifacts);
const snapshot = await exportSnapshot({report, artifacts, output:resolve(".generated/static-data"), runIds:(process.env.RUN_IDS ?? "").split(",").map(id => id.trim()).filter(Boolean)});
execFileSync(process.execPath, ["viewer/build.ts", "--config", "observablehq.static.config.js"], {
  stdio:"inherit", env:{...process.env, STATIC_SNAPSHOT:join(snapshot, "snapshot.json")}
});
for (const name of ["data", "evidence", "snapshot.json", ".nojekyll"]) {
  await cp(join(snapshot, name), join(output, name), {recursive:true, errorOnExist:true, force:false});
}
console.log(`Static dashboard: ${output}\nPreview: npm run preview\nPublish the contents of dist, including .nojekyll.`);
