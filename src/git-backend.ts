import { execFile } from "@modera/plugin-sdk/workspace-process";
import { isAbsolute, relative, resolve } from "@modera/plugin-sdk/workspace-path";
import { realpath } from "@modera/plugin-sdk/workspace-fs";
import type { ToolContext } from "@modera/plugin-sdk";

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

export function gitBytes(cwd: string, args: string[], signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  return new Promise((accept, reject) => {
    execFile("git", ["--no-pager", "--literal-pathspecs", "-c", "core.hooksPath=", ...args],
      { cwd, signal, windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024, encoding: "buffer", env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } },
      (error, stdout, stderr) => error ? reject(new Error(stderr.toString().trim() || error.message)) : accept(stdout));
  });
}

export async function repository(context: ToolContext): Promise<string> {
  if (!context.workspacePath)
    throw new Error("A project workspace is required");
  const workspace = await realpath(context.workspacePath);
  const root = await realpath(
    resolve(workspace, (
      await git(workspace, ["rev-parse", "--show-toplevel"], context.signal)
    ).trim()),
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
