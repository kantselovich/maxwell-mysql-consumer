import { resolve } from "node:path";
import { publish } from "./publish.ts";

const args = process.argv.slice(2);
if (args.length !== 2) throw new Error("Usage: node reporting/cli.ts ARTIFACT_ROOT OUTPUT_JSON");
const root = resolve(args[0]), output = resolve(args[1]);
const report = await publish(root, output);
console.log(JSON.stringify(report.summary));
console.log(`Reporting data: ${output}`);
