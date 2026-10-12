import * as fs from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { it, expect } from "vitest";
import { installRemoteWorkspaceTransport } from "@modera/plugin-sdk/workspace-transport";
import {
  isRemotePath,
  remotePath,
  workspaceUri,
} from "@modera/plugin-sdk/workspace-path";
import { WorkspaceChangeReview } from "../src/run-changes";
it("captures remote files with bounded parallel reads and preserves the before/after baseline", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "modera-remote-baseline-"));
  const workspace = join(root, "workspace");
  await fs.mkdir(workspace);
  for (let index = 0; index < 20; index++)
    await fs.writeFile(join(workspace, `a${index}.txt`), "before\n");
  let active = 0,
    peak = 0;
  const uninstall = installRemoteWorkspaceTransport({
    async file(operation, args) {
      const mapped = args.map((arg) =>
        isRemotePath(arg)
          ? join(
              workspace,
              remotePath(arg as string).path.replace(/^\/workspace\/?/, ""),
            )
          : arg,
      );
      if (operation === "readFile") {
        active++;
        peak = Math.max(peak, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return await (fs as any)[operation](...mapped);
        } finally {
          active--;
        }
      }
      const result = await (fs as any)[operation](...mapped);
      return operation === "realpath"
        ? workspaceUri(
            "test",
            "/workspace/" + relative(workspace, result).replaceAll("\\", "/"),
          )
        : result;
    },
    spawn() {
      throw new Error("No Git in this remote workspace");
    },
    async pty() {
      throw new Error("unused");
    },
  });
  try {
    const capture = await new WorkspaceChangeReview(
      join(root, "storage"),
    ).begin({
      workspacePath: workspaceUri("test", "/workspace"),
      projectId: "p",
      sessionId: "s",
      runId: "r",
      signal: new AbortController().signal,
    });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    await fs.writeFile(join(workspace, "a0.txt"), "after\n");
    const summary = await capture!.finish(new AbortController().signal);
    expect(summary.files.map((file) => file.path)).toEqual(["a0.txt"]);
    capture!.dispose();
  } finally {
    uninstall();
    await fs.rm(root, { recursive: true, force: true });
  }
});
