import { execFile } from "node:child_process";
import { isAbsolute, relative } from "node:path";
import { realpath } from "node:fs/promises";
import {
  declaredTools,
  type PluginModule,
  type ToolContext,
} from "@modera/plugin-sdk";
import manifest from "../plugin.json";
import { gitUi } from "./ui";
import { GitChanges } from "./changes";

export type Input = {
  action: string;
  paths?: string[];
  staged?: boolean;
  limit?: number;
  message?: string;
  branch?: string;
};

export function git(
  cwd: string,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return new Promise((accept, reject) => {
    execFile(
      "git",
      ["--no-pager", "--literal-pathspecs", "-c", "core.hooksPath=", ...args],
      {
        cwd,
        signal,
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: "utf8",
        env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(stderr.trim() || error.message))
          : accept(stdout),
    );
  });
}

export async function repository(context: ToolContext): Promise<string> {
  if (!context.workspacePath)
    throw new Error("A project workspace is required");
  const workspace = await realpath(context.workspacePath);
  const root = await realpath(
    (
      await git(workspace, ["rev-parse", "--show-toplevel"], context.signal)
    ).trim(),
  );
  if (relative(workspace, root) !== "")
    throw new Error("Open the repository root as the project workspace");
  return root;
}

export function selectedPaths(paths: unknown, required = false): string[] {
  if (paths === undefined && !required) return [];
  if (!Array.isArray(paths) || !paths.length || paths.length > 100)
    throw new Error("Select 1–100 explicit paths");
  return paths.map((path) => {
    if (
      typeof path !== "string" ||
      !path ||
      path.length > 2000 ||
      isAbsolute(path) ||
      /^[A-Za-z]:/.test(path) ||
      path.includes("\0") ||
      path
        .split(/[\\/]/)
        .some((part) => part === ".." || part.toLowerCase() === ".git")
    )
      throw new Error("Invalid repository-relative path");
    return path;
  });
}

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
        originalPath?: string;
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
  host.signal.addEventListener("abort", () => changes.clear(), { once: true });
  return {
    ui: gitUi(),
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
