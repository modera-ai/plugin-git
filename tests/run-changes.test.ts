import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceChangeReview } from "../src/run-changes";

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
  it("compares staged, unstaged, immutable commits and branches independently", async () => {
    const changes = new WorkspaceChangeReview(storage);
    const initial = git("rev-parse", "HEAD").trim();
    git("branch", "baseline");
    await writeFile(join(workspace, "file.ts"), "const value = 2;\n");
    git("add", "file.ts");
    await writeFile(join(workspace, "file.ts"), "const value = 3;\n");
    const staged = await changes.current(context(), { kind: "staged" });
    expect(
      (await changes.currentFile(context(), staged, "file.ts"))?.after,
    ).toBe("const value = 2;\n");
    const unstaged = await changes.current(context(), { kind: "unstaged" });
    expect(
      (await changes.currentFile(context(), unstaged, "file.ts"))?.before,
    ).toBe("const value = 2;\n");
    git("commit", "-qm", "second");
    const committed = await changes.current(context(), {
      kind: "commit",
      ref: git("rev-parse", "HEAD").trim(),
    });
    expect(
      (await changes.currentFile(context(), committed, "file.ts"))?.after,
    ).toBe("const value = 2;\n");
    const branch = await changes.current(context(), {
      kind: "branch",
      ref: "refs/heads/baseline",
    });
    expect(branch.files.map((file) => file.path)).toEqual(["file.ts"]);
    const first = await changes.current(context(), {
      kind: "commit",
      ref: initial,
    });
    expect(first.files.length).toBe(2);
    await expect(
      changes.current(context(), { kind: "commit", ref: "--output=evil" }),
    ).rejects.toThrow();
  });
  it("excludes pre-existing edits and coalesces repeated edits from the actual baseline", async () => {
    await writeFile(join(workspace, "file.ts"), "const value = 7;\n");
    await writeFile(join(workspace, "existing.txt"), "user draft\n");
    const changes = new WorkspaceChangeReview(storage),
      capture = (await changes.begin(context()))!;
    await writeFile(join(workspace, "file.ts"), "const value = 8;\n");
    await writeFile(join(workspace, "file.ts"), "const value = 9;\n");
    const summary = (await capture.finish(signal()))!;
    expect(summary.files.map((file) => file.path)).toEqual(["file.ts"]);
    expect(summary.added).toBe(1);
    expect(summary.removed).toBe(1);
    const review = await new WorkspaceChangeReview(storage).load(
      context(),
      "run",
    );
    expect(review.files[0]?.before).toBe("const value = 7;\n");
    expect(review.files[0]?.after).toBe("const value = 9;\n");
  });
  it("retains historical diff after committing and after later edits", async () => {
    const changes = new WorkspaceChangeReview(storage),
      capture = (await changes.begin(context()))!;
    await writeFile(join(workspace, "file.ts"), "const value = 2;\n");
    git("add", ".");
    git("commit", "-qm", "agent change");
    const summary = (await capture.finish(signal()))!;
    expect(git("status", "--porcelain").trim()).toBe("");
    expect(summary.files).toHaveLength(1);
    await writeFile(join(workspace, "file.ts"), "const value = 3;\n");
    const review = await new WorkspaceChangeReview(storage).load(
      context(),
      "run",
    );
    expect(review.files[0]?.after).toBe("const value = 2;\n");
    await expect(
      changes.load({ ...context(), projectId: "other" }, "run"),
    ).rejects.toThrow("scope mismatch");
  });
  it("records new untracked and deleted files without touching the Git index", async () => {
    const changes = new WorkspaceChangeReview(storage),
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
    const changes = new WorkspaceChangeReview(storage);
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
  it("supports an unborn repository and an ordinary empty folder", async () => {
    const empty = join(root, "empty");
    await mkdir(empty);
    const ordinary = await new WorkspaceChangeReview(storage).begin({
      ...context(),
      workspacePath: empty,
    });
    expect(ordinary).toBeDefined();
    expect(await ordinary!.finish(signal())).toBeUndefined();
    git("checkout", "--orphan", "fresh");
    git("rm", "-rf", ".");
    const changes = new WorkspaceChangeReview(storage),
      capture = (await changes.begin(context()))!;
    await writeFile(join(workspace, "first.txt"), "first\n");
    expect((await capture.finish(signal()))?.files[0]?.status).toBe("added");
  });
});

describe("ordinary workspace review", () => {
  beforeEach(async () => {
    workspace = join(root, "ordinary");
    await mkdir(workspace);
  });
  it("captures direct filesystem changes, creation and deletion without creating a repository", async () => {
    await writeFile(join(workspace, "edit.txt"), "before\n");
    await writeFile(join(workspace, "delete.txt"), "old\n");
    await writeFile(
      join(workspace, "untouched.txt"),
      "user existing content\n",
    );
    const changes = new WorkspaceChangeReview(storage),
      capture = (await changes.begin(context()))!;
    await writeFile(join(workspace, "edit.txt"), "middle\n");
    await writeFile(join(workspace, "edit.txt"), "after\n");
    await writeFile(join(workspace, "new.txt"), "new\n");
    await rm(join(workspace, "delete.txt"));
    const result = (await capture.finish(signal()))!;
    expect(result.files.map((file) => [file.path, file.status])).toEqual([
      ["delete.txt", "deleted"],
      ["edit.txt", "modified"],
      ["new.txt", "added"],
    ]);
    await expect(readFile(join(workspace, ".git", "HEAD"))).rejects.toThrow();
    await writeFile(join(workspace, "edit.txt"), "later\n");
    const saved = await new WorkspaceChangeReview(storage).current(context());
    expect(saved.files.find((file) => file.path === "edit.txt")).toMatchObject({
      before: "before\n",
      after: "after\n",
    });
    expect(
      await changes.currentFile(context(), saved, "edit.txt"),
    ).toMatchObject({ after: "after\n" });
  });
  it("excludes dependency folders and honors workspace ignore rules", async () => {
    await mkdir(join(workspace, "node_modules"));
    await mkdir(join(workspace, "generated"));
    await writeFile(join(workspace, ".gitignore"), "generated/\n*.log\n");
    const changes = new WorkspaceChangeReview(storage),
      capture = (await changes.begin(context()))!;
    await writeFile(
      join(workspace, "node_modules", "package.js"),
      "dependency\n",
    );
    await writeFile(join(workspace, "generated", "out.txt"), "generated\n");
    await writeFile(join(workspace, "debug.log"), "ignored\n");
    await writeFile(join(workspace, "file.txt"), "included\n");
    expect(
      (await capture.finish(signal()))!.files.map((file) => file.path),
    ).toEqual(["file.txt"]);
  });
  it("coalesces reverted edits into no change", async () => {
    await writeFile(join(workspace, "file.txt"), "original\n");
    const capture = (await new WorkspaceChangeReview(storage).begin(
      context(),
    ))!;
    await writeFile(join(workspace, "file.txt"), "temporary\n");
    await writeFile(join(workspace, "file.txt"), "original\n");
    expect(await capture.finish(signal())).toBeUndefined();
  });
});
