import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRunChanges } from "../src/run-changes";

let root: string, workspace: string, storage: string;
const signal = () => new AbortController().signal;
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: workspace,
    windowsHide: true,
    encoding: "utf8",
  });
const context = () => ({
  workspacePath: workspace,
  projectId: "project",
  sessionId: "session",
  runId: "run",
  signal: signal(),
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "modera-turn-changes-"));
  workspace = join(root, "repo");
  storage = join(root, "data");
  await mkdir(workspace);
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("config", "core.autocrlf", "false");
  await writeFile(join(workspace, "file.ts"), "const value = 1;\n");
  await writeFile(join(workspace, "keep.txt"), "keep\n");
  git("add", ".");
  git("commit", "-qm", "baseline");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
describe("per-turn Git changes", () => {
  it("excludes pre-existing edits and coalesces repeated edits from the actual baseline", async () => {
    await writeFile(join(workspace, "file.ts"), "const value = 7;\n");
    await writeFile(join(workspace, "existing.txt"), "user draft\n");
    const changes = new GitRunChanges(storage),
      capture = (await changes.begin(context()))!;
    await writeFile(join(workspace, "file.ts"), "const value = 8;\n");
    await writeFile(join(workspace, "file.ts"), "const value = 9;\n");
    const summary = (await capture.finish(signal()))!;
    expect(summary.files.map((file) => file.path)).toEqual(["file.ts"]);
    expect(summary.added).toBe(1);
    expect(summary.removed).toBe(1);
    const review = await new GitRunChanges(storage).load(context(), "run");
    expect(review.files[0]?.before).toBe("const value = 7;\n");
    expect(review.files[0]?.after).toBe("const value = 9;\n");
  });
  it("retains historical diff after committing and after later edits", async () => {
    const changes = new GitRunChanges(storage),
      capture = (await changes.begin(context()))!;
    await writeFile(join(workspace, "file.ts"), "const value = 2;\n");
    git("add", ".");
    git("commit", "-qm", "agent change");
    const summary = (await capture.finish(signal()))!;
    expect(git("status", "--porcelain").trim()).toBe("");
    expect(summary.files).toHaveLength(1);
    await writeFile(join(workspace, "file.ts"), "const value = 3;\n");
    const review = await new GitRunChanges(storage).load(context(), "run");
    expect(review.files[0]?.after).toBe("const value = 2;\n");
    await expect(
      changes.load({ ...context(), projectId: "other" }, "run"),
    ).rejects.toThrow("scope mismatch");
  });
  it("records new untracked and deleted files without touching the Git index", async () => {
    const changes = new GitRunChanges(storage),
      capture = (await changes.begin(context()))!;
    const index = await readFile(join(workspace, ".git", "index"));
    await writeFile(join(workspace, "new.txt"), "new\n");
    await rm(join(workspace, "file.ts"));
    const summary = (await capture.finish(signal()))!;
    expect(summary.files.map((file) => [file.path, file.status])).toEqual([
      ["file.ts", "deleted"],
      ["new.txt", "added"],
    ]);
    expect(await readFile(join(workspace, ".git", "index"))).toEqual(index);
  });
  it("omits unchanged turns and safely describes binary changes", async () => {
    const changes = new GitRunChanges(storage);
    expect(
      await (await changes.begin(context()))!.finish(signal()),
    ).toBeUndefined();
    const capture = (await changes.begin(context()))!;
    await writeFile(join(workspace, "image.bin"), Buffer.from([0, 1, 2]));
    const summary = (await capture.finish(signal()))!;
    expect(summary.files[0]).toMatchObject({
      path: "image.bin",
      status: "added",
      unavailable: "binary",
    });
    expect(
      (await changes.load(context(), "run")).files[0]?.after,
    ).toBeUndefined();
  });
  it("supports an unborn repository and ignores non-Git projects", async () => {
    const empty = join(root, "empty");
    await mkdir(empty);
    expect(
      await new GitRunChanges(storage).begin({
        ...context(),
        workspacePath: empty,
      }),
    ).toBeUndefined();
    git("checkout", "--orphan", "fresh");
    git("rm", "-rf", ".");
    const changes = new GitRunChanges(storage),
      capture = (await changes.begin(context()))!;
    await writeFile(join(workspace, "first.txt"), "first\n");
    expect((await capture.finish(signal()))?.files[0]?.status).toBe("added");
  });
});
