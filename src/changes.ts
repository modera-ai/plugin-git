import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readlink } from "@modera/plugin-sdk/workspace-fs";
import { join } from "@modera/plugin-sdk/workspace-path";
import type { ToolContext } from "@modera/plugin-sdk";
import { change, git, repository, selectedPaths, type Input } from "./index";

interface Snapshot {
  input: Input;
  fingerprint: string;
  root: string;
  sessionId: string;
  runId: string;
  toolCallId?: string;
}
async function snapshot(input: Input, context: ToolContext) {
  const root = await repository(context);
  const paths = selectedPaths(
    input.paths,
    ["stage", "unstage"].includes(input.action),
  );
  const head = await git(
    root,
    ["rev-parse", "--verify", "HEAD"],
    context.signal,
  ).catch(() => "unborn");
  const branch = await git(
    root,
    ["symbolic-ref", "-q", "HEAD"],
    context.signal,
  ).catch(() => "detached");
  const index = await git(root, ["ls-files", "--stage", "-z"], context.signal);
  const hash = createHash("sha256").update(
    JSON.stringify([root, head, branch, index, input]),
  );
  if (input.action === "stage") {
    const names = (
      await git(
        root,
        [
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
          "--",
          ...paths,
        ],
        context.signal,
      )
    )
      .split("\0")
      .filter(Boolean);
    if (names.length > 2000)
      throw new Error(
        "Select fewer files for one staging approval (maximum 2000)",
      );
    let bytes = 0;
    for (const name of [...new Set(names)].sort()) {
      context.signal.throwIfAborted();
      hash.update(name + "\0");
      const path = join(root, name);
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!info) {
        hash.update("deleted");
        continue;
      }
      hash.update(String(info.mode));
      if (info.isSymbolicLink()) hash.update(await readlink(path));
      else if (info.isFile()) {
        bytes += info.size;
        if (bytes > 20 * 1024 * 1024)
          throw new Error(
            "Selected file contents exceed the 20 MiB staging approval limit",
          );
        hash.update(await readFile(path));
      } else hash.update("directory");
    }
  }
  return { root, fingerprint: hash.digest("hex") };
}
export class GitChanges {
  private pending = new Map<string, Snapshot>();
  private queue = Promise.resolve();
  clear() {
    this.pending.clear();
  }
  async prepare(raw: Input, context: ToolContext) {
    if (!["stage", "unstage", "commit", "create_branch"].includes(raw.action))
      throw new Error("Unknown Git change action");
    if (
      raw.action === "commit" &&
      (!raw.message?.trim() || raw.message.length > 10000)
    )
      throw new Error("A commit message is required");
    if (this.pending.size >= 32)
      throw new Error("Too many pending Git approvals");
    const input = structuredClone(raw);
    const before = await snapshot(input, context);
    if (input.action === "create_branch") {
      if (!input.branch || input.branch.startsWith("-"))
        throw new Error("Invalid branch name");
      await git(
        before.root,
        ["check-ref-format", "--branch", input.branch],
        context.signal,
      );
    }
    const diff =
      input.action === "create_branch"
        ? ""
        : await git(
            before.root,
            [
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              ...(input.action === "stage" ? [] : ["--cached"]),
              "--",
              ...selectedPaths(input.paths),
            ],
            context.signal,
          );
    const after = await snapshot(input, context);
    if (before.fingerprint !== after.fingerprint)
      throw new Error("Repository changed while preparing approval; retry");
    const token = randomUUID();
    this.pending.set(token, {
      input,
      ...after,
      sessionId: context.sessionId,
      runId: context.runId,
      ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
    });
    return {
      input: { token },
      preview: {
        action: input.action,
        paths: input.paths,
        message: input.message,
        branch: input.branch,
        diff: diff.slice(0, 16000),
        truncated: diff.length > 16000,
        note:
          input.action === "stage"
            ? "Untracked files are included in the snapshot but do not appear in Git diff."
            : undefined,
      },
      dispose: () => {
        this.pending.delete(token);
      },
    };
  }
  execute(raw: unknown, context: ToolContext): Promise<unknown> {
    const token = (raw as { token?: string })?.token;
    const prepared = token && this.pending.get(token);
    if (
      !prepared ||
      prepared.sessionId !== context.sessionId ||
      prepared.runId !== context.runId ||
      prepared.toolCallId !== context.toolCallId
    )
      return Promise.reject(new Error("Git approval snapshot is unavailable"));
    this.pending.delete(token!);
    const operation = this.queue.then(async () => {
      context.signal.throwIfAborted();
      const current = await snapshot(prepared.input, context);
      if (
        current.fingerprint !== prepared.fingerprint ||
        current.root !== prepared.root
      )
        throw new Error(
          "Repository changed since approval; review the new changes before retrying",
        );
      return change(prepared.input, context);
    });
    this.queue = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
}
