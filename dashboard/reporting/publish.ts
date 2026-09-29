import {mkdir, realpath, rename, writeFile, rm} from "node:fs/promises";
import {dirname, relative, resolve, sep} from "node:path";
import {randomUUID} from "node:crypto";
import {importArtifacts} from "./importer.ts";

export async function outputOutsideArtifacts(root: string, output: string) {
  const base = await realpath(root);
  let ancestor = dirname(resolve(output));
  while (true) {
    try { await realpath(ancestor); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; ancestor = dirname(ancestor); }
  }
  const resolved = resolve(await realpath(ancestor), relative(ancestor, resolve(output)));
  if (resolved === base || resolved.startsWith(base + sep)) throw new Error("Generated output must be outside the raw artifact root");
}
export async function atomicJSON(output: string, value: unknown) {
  await mkdir(dirname(output), {recursive:true});
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {flag:"wx"});
    await rename(temporary, output);
  } finally { await rm(temporary, {force:true}); }
}
export async function publish(root: string, output: string, revisions?: Record<string, string>) {
  await outputOutsideArtifacts(root, output);
  const report = await importArtifacts(root);
  if (revisions) for (const run of report.runs) run.evidenceRevision = revisions[run.artifactDirectory];
  await atomicJSON(output, report);
  return report;
}
