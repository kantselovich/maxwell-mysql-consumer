import {build} from "esbuild";
import {execFileSync} from "node:child_process";

// Bundle Mermaid from the lockfile before Framework handles local imports.
// This keeps its lazy diagram modules offline and avoids Framework's Node
// resolver rewriting Mermaid's generated chunk names.
await build({entryPoints: ["mermaid"], bundle: true, format: "esm", platform: "browser", minify: true, outfile: "src/generated/mermaid.js"});
execFileSync("node_modules/.bin/observable", ["build", ...process.argv.slice(2)], {stdio: "inherit", env: {...process.env, OBSERVABLE_TELEMETRY_DISABLE: "true"}});
