import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, mkdir, copyFile, chmod, writeFile, readFile, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {spawnSync} from "node:child_process";

const repo = resolve("..");
const runners = ["e2e.sh", "phase2.sh", "phase4.sh", "phase5.sh"];
async function workspace(action: (root: string, env: NodeJS.ProcessEnv) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "poc kept stack "));
  try {
    await mkdir(join(root, "scripts")); await mkdir(join(root, "bin"));
    for (const name of [...runners, "phase5-suite.sh", "e2e-checks.sh", "stack-lifecycle.sh", "reporting-metadata.sh"]) await copyFile(join(repo, "scripts", name), join(root, "scripts", name));
    await copyFile("test/fixtures/docker-lifecycle.sh", join(root, "bin/docker"));
    await chmod(join(root, "bin/docker"), 0o755);
    await writeFile(join(root, "bin/sleep"), "#!/usr/bin/env bash\nexec /bin/sleep 0.01\n");
    await chmod(join(root, "bin/sleep"), 0o755);
    const env = {...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, FAKE_DOCKER_LOG: join(root, "docker.log"),
      KEEP_STACK: "0", KEEP_ON_FAILURE: "0", FAKE_HARNESS_EXIT: "0", FAKE_STARTUP_EXIT: "0",
      COMPOSE_FILE: "", REPORT_SUITE_ID: "", REPORT_GATE_ID: "", VERIFY_NEGATIVE: "0", E2E_MAX_SECONDS: "300"};
    await action(root, env);
  } finally { await rm(root, {recursive: true, force: true}); }
}
function run(root: string, env: NodeJS.ProcessEnv, command: string, args: string[]) {
  const result = spawnSync(command, args, {cwd: root, env, encoding: "utf8", timeout: 30000});
  assert.ifError(result.error); assert.equal(result.signal, null);
  return result;
}
async function records(root: string) {
  const paths = await readdir(join(root, "artifacts"));
  return Promise.all(paths.filter(name => !name.includes("-suite-")).map(async name => {
    const dir = join(root, "artifacts", name);
    const files = await readdir(dir);
    return {name, dir, files, result: JSON.parse(await readFile(join(dir, files.includes("host-result.json") ? "host-result.json" : "result.json"), "utf8"))};
  }));
}

for (const runner of runners) {
  for (const [label, keep, legacy, exit, retained] of [
    ["default success", "0", "0", 0, false], ["default failure", "0", "0", 7, false],
    ["keep success", "1", "0", 0, true], ["keep failure", "1", "0", 7, true],
    ["legacy success", "0", "1", 0, false], ["legacy failure", "0", "1", 7, true]
  ] as const) {
    test(`${runner}: ${label} preserves the verdict and cleanup policy`, () => workspace(async (root, env) => {
      Object.assign(env, {KEEP_STACK: keep, KEEP_ON_FAILURE: legacy, FAKE_HARNESS_EXIT: String(exit)});
      const outcome = run(root, env, "bash", [`scripts/${runner}`]);
      assert.equal(outcome.status, exit, outcome.stdout + outcome.stderr);
      const [record] = await records(root);
      assert.equal(record.result.exitCode, exit);
      assert.equal(JSON.parse(await readFile(join(record.dir, "run-metadata.json"), "utf8")).state, "finished");
      const calls = await readFile(env.FAKE_DOCKER_LOG!, "utf8");
      assert.equal(calls.includes("compose down --volumes --remove-orphans"), !retained);
      assert.equal(record.files.includes("retained-stack.txt"), retained);
      if (retained) {
        const instructions = await readFile(join(record.dir, "retained-stack.txt"), "utf8");
        assert(outcome.stdout.includes(instructions));
        assert(instructions.includes(`Run: ${record.name}`));
        assert(instructions.includes(`Compose project: ${record.name}`));
        assert(instructions.includes("Source port:")); assert(instructions.includes("Target port:"));
        assert(instructions.includes("http://localhost:4173/"));
        if (runner === "phase4.sh") assert(instructions.includes("compose.phase4.yaml"));
        // Execute the printed cleanup command against our fake, from elsewhere.
        // This checks escaping (the workspace has spaces) and exact project scope.
        const cleanup = instructions.split("\n").find(line => line.startsWith("Cleanup ("))!.split(": ").slice(1).join(": ");
        const cleaned = run(tmpdir(), env, "bash", ["-c", cleanup]);
        assert.equal(cleaned.status, 0, cleaned.stderr);
        const cleanupCall = (await readFile(env.FAKE_DOCKER_LOG!, "utf8")).trim().split("\n").at(-1)!;
        assert(cleanupCall.includes(`-p ${record.name} `));
        assert(cleanupCall.includes(`${root}/compose.yaml`));
        assert(cleanupCall.endsWith("down --volumes --remove-orphans"));
      }
      if (exit === 0 && runner === "phase4.sh") {
        assert(calls.includes("compose kill -s SIGKILL consumer"));
        assert(calls.includes("compose restart pubsub"));
      }
      if (exit === 0 && runner === "phase5.sh") assert(calls.includes("compose stop consumer"));
    }));
  }
  test(`${runner}: retain partial startup without changing its exit code`, () => workspace(async (root, env) => {
    Object.assign(env, {KEEP_STACK: "1", FAKE_STARTUP_EXIT: "9"});
    const outcome = run(root, env, "bash", [`scripts/${runner}`]);
    assert.equal(outcome.status, 9, outcome.stdout + outcome.stderr);
    assert.equal((await records(root))[0].result.exitCode, 9);
    assert(!(await readFile(env.FAKE_DOCKER_LOG!, "utf8")).includes("compose down"));
  }));
}

test("invalid KEEP_STACK is rejected before Docker or artifacts", () => workspace(async (root, env) => {
  env.KEEP_STACK = "yes";
  for (const runner of [...runners, "phase5-suite.sh", "e2e-checks.sh"]) {
    const outcome = run(root, env, "bash", [`scripts/${runner}`]);
    assert.equal(outcome.status, 2); assert(outcome.stderr.includes("KEEP_STACK must be 0 or 1"));
  }
  assert(!(await readdir(root)).includes("artifacts"));
  assert(!(await readdir(root)).includes("docker.log"));
}));

test("retention reaches every suite child, including expected-failure self-tests", () => workspace(async (root, env) => {
  env.KEEP_STACK = "1";
  const outcome = run(root, env, "bash", ["scripts/phase5-suite.sh"]);
  assert.equal(outcome.status, 0, outcome.stdout + outcome.stderr);
  const children = await records(root);
  assert.equal(children.length, 8);
  for (const child of children) { assert.equal(child.result.exitCode, 0); assert(child.files.includes("retained-stack.txt")); }
  const calls = await readFile(env.FAKE_DOCKER_LOG!, "utf8");
  assert(!calls.includes("compose down"));
  assert(calls.includes("compose stop consumer"));
}));
