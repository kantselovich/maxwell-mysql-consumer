import { mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { importArtifacts } from "./importer.ts";

const args = process.argv.slice(2);
if (args.length !== 2) throw new Error("Usage: node reporting/cli.ts ARTIFACT_ROOT OUTPUT_JSON");
const root = await realpath(resolve(args[0])), output = resolve(args[1]);
// Resolve the nearest existing ancestor before creating anything. An output
// directory symlink must not turn this reporting command into an artifact writer.
let ancestor = dirname(output);
while (true) {
  try { await realpath(ancestor); break; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; ancestor = dirname(ancestor); }
}
const resolvedOutput = resolve(await realpath(ancestor), relative(ancestor, output));
if (resolvedOutput === root || resolvedOutput.startsWith(root + sep)) throw new Error("Generated output must be outside the raw artifact root");
const report = await importArtifacts(root);
await mkdir(dirname(output), { recursive: true });
const temporary = `${output}.${process.pid}.tmp`;
await writeFile(temporary, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
await rename(temporary, output);
console.log(JSON.stringify(report.summary));
console.log(`Reporting data: ${output}`);
