import { afterEach, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, inspect, change } from "../src/index";
import { GitChanges } from "../src/changes";

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "modera-git-test-"));
  directories.push(root);
  const context = {
    workspacePath: root,
    projectId: "project",
    sessionId: "session",
    runId: "run",
    signal: new AbortController().signal,
  };
  await git(root, ["init"], context.signal);
  await git(
    root,
    ["config", "user.email", "test@example.invalid"],
    context.signal,
  );
  await git(root, ["config", "user.name", "Test"], context.signal);
  return { root, context };
}
test("reviews, stages explicit literal paths, commits and creates a branch", async () => {
  const { root, context } = await setup();
  await writeFile(join(root, "selected.txt"), "first\n");
  await writeFile(join(root, "other.txt"), "unrelated\n");
  expect((await inspect({ action: "status" }, context)).files).toHaveLength(2);
  await change({ action: "stage", paths: ["selected.txt"] }, context);
  expect(
    (await inspect({ action: "diff", staged: true }, context)).diff,
  ).toContain("+first");
  await change({ action: "commit", message: "Initial" }, context);
  expect((await inspect({ action: "status" }, context)).files).toEqual([
    { index: "?", worktree: "?", path: "other.txt", originalPath: undefined },
  ]);
  await change({ action: "create_branch", branch: "feature/test" }, context);
  expect((await inspect({ action: "branches" }, context)).branches).toContain(
    "feature/test",
  );
  await writeFile(join(root, "selected.txt"), "second\n");
  await change({ action: "stage", paths: ["selected.txt"] }, context);
  await change({ action: "unstage", paths: ["selected.txt"] }, context);
  expect((await inspect({ action: "diff", staged: true }, context)).diff).toBe(
    "",
  );
  expect((await inspect({ action: "diff" }, context)).diff).toContain(
    "+second",
  );
});
test("rejects traversal, metadata, option injection and unrecognized actions", async () => {
  const { context } = await setup();
  for (const path of ["../outside", ".git/config", "C:/outside"])
    await expect(
      change({ action: "stage", paths: [path] }, context),
    ).rejects.toThrow();
  await expect(
    change({ action: "create_branch", branch: "--force" }, context),
  ).rejects.toThrow();
  await expect(change({ action: "reset" }, context)).rejects.toThrow();
  await expect(change({ action: "stage" }, context)).rejects.toThrow();
  await expect(
    inspect({ action: "log", limit: 1000 }, context),
  ).rejects.toThrow();
});
test("honors cancellation before invoking Git", async () => {
  const { root } = await setup();
  const controller = new AbortController();
  controller.abort();
  expect(() => git(root, ["status"], controller.signal)).toThrow();
});
test("approval detects untracked file changes and index changes; tokens are single-use and scope-bound", async () => {
  const { root, context } = await setup();
  const changes = new GitChanges();
  await writeFile(join(root, "selected.txt"), "first");
  const first = await changes.prepare(
    { action: "stage", paths: ["selected.txt"] },
    context,
  );
  await writeFile(join(root, "selected.txt"), "changed");
  await expect(changes.execute(first.input, context)).rejects.toThrow(
    "changed since approval",
  );
  const next = await changes.prepare(
    { action: "stage", paths: ["selected.txt"] },
    context,
  );
  await expect(
    changes.execute(next.input, { ...context, sessionId: "another" }),
  ).rejects.toThrow("unavailable");
  await changes.execute(next.input, context);
  await expect(changes.execute(next.input, context)).rejects.toThrow(
    "unavailable",
  );
  const commit = await changes.prepare(
    { action: "commit", message: "Reviewed commit" },
    context,
  );
  await writeFile(join(root, "other.txt"), "another agent");
  await change({ action: "stage", paths: ["other.txt"] }, context);
  await expect(changes.execute(commit.input, context)).rejects.toThrow(
    "changed since approval",
  );
});
test("unstages in an unborn repository without deleting the working file", async () => {
  const { root, context } = await setup();
  await writeFile(join(root, "a.txt"), "keep");
  await change({ action: "stage", paths: ["a.txt"] }, context);
  await change({ action: "unstage", paths: ["a.txt"] }, context);
  expect((await inspect({ action: "status" }, context)).files).toMatchObject([
    { path: "a.txt", index: "?" },
  ]);
});
test("linked worktrees are isolated and valid plugin workspaces", async () => {
  const { root, context } = await setup();
  await writeFile(join(root, "a.txt"), "base");
  await change({ action: "stage", paths: ["a.txt"] }, context);
  await change({ action: "commit", message: "base" }, context);
  const parent = await mkdtemp(join(tmpdir(), "modera-linked-"));
  directories.push(parent);
  const worktree = join(parent, "checkout");
  await git(
    root,
    ["worktree", "add", "-b", "isolated", worktree],
    context.signal,
  );
  await writeFile(join(worktree, "a.txt"), "isolated edit");
  expect(
    (
      await inspect(
        { action: "status" },
        { ...context, workspacePath: worktree },
      )
    ).files,
  ).toHaveLength(1);
  expect((await inspect({ action: "status" }, context)).files).toHaveLength(0);
});
