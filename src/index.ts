import {
  declaredTools,
  type PluginModule,
  type ToolContext,
} from "@modera/plugin-sdk";
import manifest from "../plugin.json";
import { reviewUi } from "./ui";
import { GitChanges } from "./changes";
import { WorkspaceChangeReview } from "./run-changes";

export type Input = {
  action: string;
  paths?: string[];
  staged?: boolean;
  limit?: number;
  message?: string;
  branch?: string;
};

export { git, repository, selectedPaths } from "./git-backend";
import { git, repository, selectedPaths } from "./git-backend";

export async function inspect(input: Input, context: ToolContext) {
  const root = await repository(context);
  const paths = selectedPaths(input.paths);
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Invalid history limit");
  switch (input.action) {
    case "status": {
      const output = await git(
        root,
        [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=normal",
          "--",
          ...paths,
        ],
        context.signal,
      );
      const records = output.split("\0");
      const files: {
        index: string;
        worktree: string;
        path: string;
        originalPath?: string | undefined;
      }[] = [];
      for (let i = 0; i < records.length; i++) {
        const record = records[i];
        if (!record) continue;
        const entry = {
          index: record[0]!,
          worktree: record[1]!,
          path: record.slice(3),
          originalPath: undefined as string | undefined,
        };
        if (/[RC]/.test(record.slice(0, 2))) entry.originalPath = records[++i];
        files.push(entry);
      }
      return { root, files };
    }
    case "diff":
      return {
        root,
        diff: await git(
          root,
          [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            ...(input.staged ? ["--cached"] : []),
            "--",
            ...paths,
          ],
          context.signal,
        ),
      };
    case "log":
      return {
        root,
        log: await git(
          root,
          [
            "log",
            `-${limit}`,
            "--format=%h %ad %s",
            "--date=iso-strict",
            "--",
            ...paths,
          ],
          context.signal,
        ),
      };
    case "branches":
      return {
        root,
        branches: (
          await git(
            root,
            ["branch", "--format=%(refname:short)"],
            context.signal,
          )
        )
          .trim()
          .split("\n")
          .filter(Boolean),
      };
    default:
      throw new Error("Unknown Git inspection action");
  }
}

export async function change(input: Input, context: ToolContext) {
  const root = await repository(context);
  let args: string[];
  switch (input.action) {
    case "stage":
      args = ["add", "--", ...selectedPaths(input.paths, true)];
      break;
    case "unstage":
      const paths = selectedPaths(input.paths, true);
      const hasHead = await git(
        root,
        ["rev-parse", "--verify", "HEAD"],
        context.signal,
      ).then(
        () => true,
        () => false,
      );
      args = hasHead
        ? ["restore", "--staged", "--", ...paths]
        : ["rm", "--cached", "-r", "--", ...paths];
      break;
    case "commit":
      if (!input.message?.trim() || input.message.length > 10000)
        throw new Error("A commit message is required");
      args = ["-c", "commit.gpgsign=false", "commit", "-m", input.message];
      break;
    case "create_branch":
      if (
        !input.branch ||
        input.branch.startsWith("-") ||
        input.branch.length > 200
      )
        throw new Error("Invalid branch name");
      await git(
        root,
        ["check-ref-format", "--branch", input.branch],
        context.signal,
      );
      args = ["branch", "--", input.branch];
      break;
    default:
      throw new Error("Unknown Git change action");
  }
  return {
    root,
    action: input.action,
    output: await git(root, args, context.signal),
  };
}

export const activate: PluginModule["activate"] = async (host) => {
  const changes = new GitChanges();
  const runChanges = new WorkspaceChangeReview(host.storagePath);
  host.signal.addEventListener("abort", () => changes.clear(), { once: true });
  return {
    runChanges,
    ui: reviewUi(runChanges),
    tools: declaredTools(manifest).map((definition) => ({
      definition,
      isAvailable: (context) => !!context.workspacePath,
      ...(definition.id === "git_change"
        ? {
            prepare: (input: unknown, context: ToolContext) =>
              changes.prepare(input as Input, context),
          }
        : {}),
      execute: (input, context) =>
        definition.id === "git_inspect"
          ? inspect(input as Input, context)
          : changes.execute(input, context),
    })),
  };
};
