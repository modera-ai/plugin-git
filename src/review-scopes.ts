import type { ToolContext } from "@modera/plugin-sdk";
import { git, repository } from "./git-backend";
export type ReviewScope = {
  kind: "turn" | "uncommitted" | "unstaged" | "staged" | "commit" | "branch";
  ref?: string;
};
export interface GitReviewOptions {
  commits: { ref: string; label: string }[];
  branches: { ref: string; label: string }[];
}
export async function reviewOptions(
  context: ToolContext,
): Promise<GitReviewOptions | undefined> {
  const root = await repository(context).catch(() => undefined);
  if (!root) return undefined;
  const [log, refs] = await Promise.all([
    git(root, ["log", "-20", "--format=%H%x09%h %s"], context.signal).catch(
      () => "",
    ),
    git(
      root,
      [
        "for-each-ref",
        "--count=100",
        "--format=%(refname)%09%(refname:short)",
        "refs/heads/",
      ],
      context.signal,
    ),
  ]);
  const parse = (value: string) =>
    value
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [ref, ...label] = line.split("\t");
        return { ref: ref!, label: label.join("\t") };
      });
  return { commits: parse(log), branches: parse(refs) };
}
export function parseScope(value: string | undefined): ReviewScope {
  const input = JSON.parse(value ?? "{}") as ReviewScope;
  if (
    !["turn", "uncommitted", "unstaged", "staged", "commit", "branch"].includes(
      input.kind,
    ) ||
    (input.ref !== undefined &&
      (typeof input.ref !== "string" || input.ref.length > 500))
  )
    throw Error("Invalid review scope");
  return input;
}
