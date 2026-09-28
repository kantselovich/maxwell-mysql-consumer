import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {execFileSync} from "node:child_process";
import {importArtifacts} from "../reporting/importer.ts";

test("container fields are whitelisted, event categories are labeled, and raw inspections stay private", async () => {
  const root = await mkdtemp(join(tmpdir(), "poc-presentation-"));
  try {
    const fixtures = JSON.parse(await readFile("test/fixtures/runs.json", "utf8"));
    const f = fixtures.find((f: {directory: string}) => f.directory === "maxwell-e2e-positive");
    const dir = join(root, f.directory); await mkdir(dir);
    for (const [name, value] of Object.entries(f.files)) await writeFile(join(dir, name), JSON.stringify(value));
    await writeFile(join(dir, "observations.json"), JSON.stringify({identities: ["a", "b"], dlq: [], payloads: ['{"type":"insert"}', '{"type":"table-create"}', "{broken"]}));
    await writeFile(join(dir, "consumer-container.json"), JSON.stringify([{Name: "consumer-1", Config: {Image: "swift:test", Env: ["PASSWORD=secret-hidden"]}, State: {Status: "running"}, RestartCount: 2, Mounts: [{Source: "private-path"}]}]));
    let report = await importArtifacts(root), run = report.runs[0];
    assert.equal(run.presentation?.events?.rowChanges, 1);
    assert.equal(run.presentation?.events?.schemaChanges, 1);
    assert.equal(run.presentation?.events?.invalidPayloads, 1);
    assert.equal(run.presentation?.events?.basis, "Observed audit payloads");
    assert.equal(run.presentation?.containers[0].dockerRestarts, 2);
    assert(!JSON.stringify(report).includes("secret-hidden")); assert(!JSON.stringify(report).includes("private-path"));
    assert(!run.evidence.some(ref => ref.path.endsWith("-container.json")));
    await symlink(join(dir, "consumer-container.json"), join(dir, "maxwell-container.json"));
    report = await importArtifacts(root); run = report.runs[0];
    assert.equal(run.presentation?.containers.length, 1);
    assert(run.presentation?.issues.some(x => x.includes("maxwell")));
  } finally { await rm(root, {recursive: true, force: true}); }
});

test("all browser modules are syntactically valid", async () => {
  for (const name of await readdir("src/components")) if (name.endsWith(".js")) execFileSync(process.execPath, ["--check", `src/components/${name}`]);
});
