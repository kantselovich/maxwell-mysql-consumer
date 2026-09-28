import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeFile } from "../viewer/server.ts";

test("evidence boundary rejects traversal, absolute paths, files and directory symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "dashboard-path-"));
  try {
    await mkdir(join(root, "run")); await writeFile(join(root, "run", "rows.json"), "[]");
    await symlink(join(root, "run"), join(root, "alias"));
    await symlink(join(root, "run", "rows.json"), join(root, "file.json"));
    assert.equal(await safeFile(root, "run/rows.json"), await realpath(join(root, "run", "rows.json")));
    for (const path of ["../package.json", "/etc/passwd", "run/../../package.json", "alias/rows.json", "file.json", "run\\rows.json"]) await assert.rejects(safeFile(root, path));
  } finally { await rm(root, {recursive: true, force: true}); }
});
