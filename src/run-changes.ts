import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  writeFile,
} from "@modera/plugin-sdk/workspace-fs";
import { dirname, join, isRemotePath } from "@modera/plugin-sdk/workspace-path";
import { diffLines } from "diff";
import type {
  RunChangedFile,
  RunChangesContext,
  RunChangesSummary,
  ToolContext,
} from "@modera/plugin-sdk";
import { git, gitBytes, repository, selectedPaths } from "./git-backend";
import { workspaceFiles } from "./workspace-snapshot";
import { reviewOptions, type ReviewScope } from "./review-scopes";

const FILE_LIMIT = 1024 * 1024;
const contentLimit = (path: string) => /\.(png|jpe?g|webp|gif)$/i.test(path) ? 8 * 1024 * 1024 : FILE_LIMIT;
const TOTAL_LIMIT = 32 * 1024 * 1024;
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
type Content = { hash: string; text?: string; unavailable?: string; image?: string };
export type ChangedFile = RunChangedFile & { before?: string; after?: string; beforeImage?: string; afterImage?: string };
export interface ChangeReview {
  baseHead?: string;
  targetRef?: string;
  projectId?: string | undefined;
  sessionId: string;
  runId: string;
  files: ChangedFile[];
  added: number;
  removed: number;
  incomplete?: boolean;
}
function content(buffer: Buffer): Content {
  const hash = digest(buffer);
  const mime = buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png"
    : buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255 ? "image/jpeg"
    : buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP" ? "image/webp"
    : /^GIF8[79]a$/.test(buffer.toString("ascii", 0, 6)) ? "image/gif" : undefined;
  if (mime) return { hash, unavailable: "binary", image: `data:${mime};base64,${buffer.toString("base64")}` };
  if (buffer.includes(0)) return { hash, unavailable: "binary" };
  try {
    return {
      hash,
      text: new TextDecoder("utf-8", { fatal: true }).decode(buffer),
    };
  } catch {
    return { hash, unavailable: "encoding" };
  }
}
async function workingFile(
  root: string,
  path: string,
): Promise<Content | null> {
  // Git filenames are data, but still reject traversal before filesystem access.
  selectedPaths([path], true);
  const target = join(root, path);
  const stat = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });
  if (!stat) return null;
  if (stat.isSymbolicLink())
    return { hash: digest(await readlink(target)), unavailable: "symlink" };
  if (!stat.isFile())
    return { hash: String(stat.mtimeMs), unavailable: "directory" };
  if (stat.size > contentLimit(path))
    return { hash: `${stat.size}:${stat.mtimeMs}`, unavailable: "large" };
  return content(await readFile(target));
}
async function headFile(
  root: string,
  head: string | undefined,
  path: string,
  signal: AbortSignal,
): Promise<Content | null> {
  if (!head) return null;
  if (head === "INDEX") {
    const entries = await git(
      root,
      ["ls-files", "--stage", "-z", "--", path],
      signal,
    );
    const item = entries
      .split("\0")
      .find((line) => line.split("\t")[0]?.endsWith(" 0"));
    if (!item) return null;
    const id = item.split("\t")[0]!.split(" ")[1]!;
    if (
      Number((await git(root, ["cat-file", "-s", id], signal)).trim()) >
      contentLimit(path)
    )
      return { hash: id, unavailable: "large" };
    return content(
      await gitBytes(root, ["cat-file", "blob", id], signal),
    );
  }
  const object = await git(root, ["ls-tree", "-z", head, "--", path], signal);
  if (!object) return null;
  const id = object.split("\t")[0]!.split(" ").at(-1)!;
  const size = Number((await git(root, ["cat-file", "-s", id], signal)).trim());
  if (size > contentLimit(path)) return { hash: id, unavailable: "large" };
  return content(await gitBytes(root, ["cat-file", "blob", id], signal));
}
async function dirtyPaths(
  root: string,
  head: string | undefined,
  signal: AbortSignal,
) {
  const [tracked, untracked] = await Promise.all([
    git(
      root,
      head
        ? ["diff", "--name-only", "-z", "--no-renames", head, "--"]
        : ["ls-files", "-z", "--cached"],
      signal,
    ),
    git(root, ["ls-files", "-z", "--others", "--exclude-standard"], signal),
  ]);
  return [
    ...new Set(
      [...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean),
    ),
  ];
}
async function headOf(root: string, signal: AbortSignal) {
  return git(root, ["rev-parse", "--verify", "HEAD"], signal).then(
    (value) => value.trim(),
    () => undefined,
  );
}
function changed(
  path: string,
  before: Content | null,
  after: Content | null,
): ChangedFile | undefined {
  if (before?.hash === after?.hash || (!before && !after)) return undefined;
  const status = !before ? "added" : !after ? "deleted" : "modified";
  const unavailable = before?.unavailable ?? after?.unavailable;
  const left = before?.text ?? "",
    right = after?.text ?? "";
  const diff = unavailable
    ? undefined
    : diffLines(left, right, { timeout: 150, maxEditLength: 20_000 });
  return {
    path,
    status,
    added:
      diff?.reduce((sum, part) => sum + (part.added ? part.count : 0), 0) ?? 0,
    removed:
      diff?.reduce((sum, part) => sum + (part.removed ? part.count : 0), 0) ??
      0,
    ...(unavailable || !diff ? { unavailable: unavailable ?? "complex" } : {}),
    ...(!unavailable ? { before: left, after: right } : {}),
    ...(before?.image ? { beforeImage: before.image } : {}),
    ...(after?.image ? { afterImage: after.image } : {}),
  };
}

/** Workspace snapshots are the baseline. Git optionally accelerates discovery
 * and clean-file reads; it is never required or initialized by this plugin. */
export class WorkspaceChangeReview {
  constructor(private readonly storage: string) {}
  private path(session: string, run: string) {
    return join(
      this.storage,
      "turn-changes",
      digest(session),
      digest(run) + ".json",
    );
  }
  async begin(context: RunChangesContext) {
    if (!context.workspacePath) return undefined;
    const gitRoot = await repository(context).catch(() => undefined);
    const root = gitRoot ?? (await realpath(context.workspacePath));
    const head = gitRoot ? await headOf(root, context.signal) : undefined;
    const baseline = new Map<string, Content | null>();
    let bytes = 0,
      incomplete = false;
    const discovered = gitRoot
      ? {
          paths: await dirtyPaths(root, head, context.signal),
          incomplete: false,
        }
      : await workspaceFiles(root, context.signal);
    const paths = discovered.paths;
    incomplete = discovered.incomplete;
    const selected = paths.slice(0, 2000);
    const concurrency = isRemotePath(root) ? 8 : 1;
    capture: for (let offset = 0; offset < selected.length; offset += concurrency) {
      context.signal.throwIfAborted();
      const batch = selected.slice(offset, offset + concurrency);
      const contents = await Promise.all(batch.map(path => workingFile(root, path)));
      context.signal.throwIfAborted();
      for (let index = 0; index < batch.length; index++) {
        const file = contents[index]!;
        bytes += Buffer.byteLength(file?.text ?? "") + Buffer.byteLength(file?.image ?? "");
        if (bytes > TOTAL_LIMIT) { incomplete = true; break capture; }
        baseline.set(batch[index]!, file);
      }
    }
    if (baseline.size < paths.length) incomplete = true;
    return {
      finish: async (signal: AbortSignal) => {
        const ended = gitRoot
          ? { paths: await dirtyPaths(root, head, signal), incomplete: false }
          : await workspaceFiles(root, signal);
        const candidates = new Set([...baseline.keys(), ...ended.paths]);
        incomplete ||= ended.incomplete;
        const files: ChangedFile[] = [];
        let storedBytes = 0;
        for (const path of [...candidates].sort().slice(0, 2000)) {
          signal.throwIfAborted();
          // A missing baseline entry from the budget must not be mistaken for a new file.
          if (paths.includes(path) && !baseline.has(path)) continue;
          if (!gitRoot && discovered.incomplete && !baseline.has(path))
            continue;
          const before = baseline.has(path)
            ? baseline.get(path)!
            : await headFile(root, head, path, signal);
          const after = await workingFile(root, path);
          const file = changed(path, before, after);
          if (!file) continue;
          storedBytes +=
            Buffer.byteLength(file.before ?? "") +
            Buffer.byteLength(file.after ?? "") + Buffer.byteLength(file.beforeImage ?? "") + Buffer.byteLength(file.afterImage ?? "");
          if (storedBytes > TOTAL_LIMIT) {
            delete file.before;
            delete file.after;
            delete file.beforeImage;
            delete file.afterImage;
            files.push({ ...file, unavailable: "budget" });
            incomplete = true;
          } else files.push(file);
        }
        if (candidates.size > 2000) incomplete = true;
        if (!files.length) return undefined;
        const review: ChangeReview = {
          projectId: context.projectId,
          sessionId: context.sessionId,
          runId: context.runId,
          files,
          added: files.reduce((sum, file) => sum + file.added, 0),
          removed: files.reduce((sum, file) => sum + file.removed, 0),
          ...(incomplete ? { incomplete: true } : {}),
        };
        const target = this.path(context.sessionId, context.runId);
        await mkdir(dirname(target), { recursive: true });
        const temporary = `${target}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(review));
        await rename(temporary, target);
        await writeFile(
          join(dirname(target), "latest.json"),
          JSON.stringify({ runId: context.runId }),
        );
        return this.summary(review);
      },
      dispose: () => baseline.clear(),
    };
  }
  summary(review: ChangeReview): Omit<RunChangesSummary, "owner" | "runId"> {
    return {
      panelId: "modera.git.panel",
      resource: JSON.stringify({ runId: review.runId }),
      files: review.files.map(
        ({ before: _before, after: _after, beforeImage: _bi, afterImage: _ai, ...file }) => ({
          ...file,
          resource: JSON.stringify({ runId: review.runId, path: file.path }),
        }),
      ),
      added: review.added,
      removed: review.removed,
      ...(review.incomplete ? { incomplete: true } : {}),
    };
  }
  async load(context: ToolContext, runId: string): Promise<ChangeReview> {
    const review = JSON.parse(
      await readFile(this.path(context.sessionId, runId), "utf8"),
    ) as ChangeReview;
    if (
      review.projectId !== context.projectId ||
      review.sessionId !== context.sessionId ||
      review.runId !== runId
    )
      throw new Error("Change review scope mismatch");
    return review;
  }
  async current(
    context: ToolContext,
    scope: ReviewScope = { kind: "uncommitted" },
  ): Promise<ChangeReview> {
    const root = await repository(context).catch(() => undefined);
    if (!root) {
      if (!["turn", "uncommitted"].includes(scope.kind))
        throw Error("Git comparison is unavailable in this workspace");
      const latest = await readFile(
        join(dirname(this.path(context.sessionId, "")), "latest.json"),
        "utf8",
      ).then(
        (value) => JSON.parse(value) as { runId: string },
        () => undefined,
      );
      if (latest) return this.load(context, latest.runId);
      return {
        projectId: context.projectId,
        sessionId: context.sessionId,
        runId: "",
        files: [],
        added: 0,
        removed: 0,
      };
    }
    let head = await headOf(root, context.signal),
      targetRef: string | undefined;
    let comparison: string[] = ["diff"];
    if (!head && scope.kind === "uncommitted") comparison.push("--cached");
    if (scope.kind === "staged") {
      targetRef = "INDEX";
      comparison.push("--cached");
    }
    if (scope.kind === "unstaged") head = "INDEX";
    if (scope.kind === "commit" || scope.kind === "branch") {
      const options = await reviewOptions(context);
      const list =
        scope.kind === "commit" ? options?.commits : options?.branches;
      if (!scope.ref || !list?.some((item) => item.ref === scope.ref))
        throw Error("Selected revision is unavailable");
      if (scope.kind === "commit") {
        targetRef = scope.ref;
        head = (
          await git(
            root,
            ["rev-list", "--parents", "-n", "1", scope.ref],
            context.signal,
          )
        )
          .trim()
          .split(" ")[1];
        if (!head) comparison = ["diff-tree", "--root", "--no-commit-id", "-r"];
      } else {
        if (!head) throw Error("Create a commit before comparing branches");
        targetRef = head;
        head = (
          await git(root, ["merge-base", "HEAD", scope.ref], context.signal)
        ).trim();
      }
    }
    const revisions =
      comparison[0] === "diff-tree"
        ? [targetRef!]
        : [
            ...(head && head !== "INDEX" ? [head] : []),
            ...(targetRef && targetRef !== "INDEX" ? [targetRef] : []),
          ];
    const command = (format: string) => [
      ...comparison,
      format,
      "-z",
      "--no-renames",
      ...revisions,
      "--",
    ];
    const [names, numbers, statusOutput] = await Promise.all([
      git(root, command("--name-only"), context.signal),
      git(root, command("--numstat"), context.signal),
      git(root, command("--name-status"), context.signal),
    ]);
    const untracked = !targetRef
      ? await git(
          root,
          ["ls-files", "-z", "--others", "--exclude-standard"],
          context.signal,
        )
      : "";
    const paths = [
        ...new Set(
          [...names.split("\0"), ...untracked.split("\0")].filter(Boolean),
        ),
      ],
      files: ChangedFile[] = [];
    const stats = new Map(
      numbers
        .split("\0")
        .filter(Boolean)
        .map((record) => {
          const [added, removed, ...path] = record.split("\t");
          return [path.join("\t"), { added, removed }] as const;
        }),
    );
    const statuses = statusOutput.split("\0");
    const kinds = new Map<string, string>();
    for (let i = 0; i < statuses.length - 1; i += 2)
      kinds.set(statuses[i + 1]!, statuses[i]!);
    for (const path of paths.slice(0, 2000)) {
      const stat = stats.get(path);
      if (stat && (head || targetRef))
        files.push({
          path,
          status:
            kinds.get(path) === "D"
              ? "deleted"
              : kinds.get(path) === "A"
                ? "added"
                : "modified",
          added: Number(stat.added) || 0,
          removed: Number(stat.removed) || 0,
          ...(stat.added === "-" ? { unavailable: "binary" } : {}),
        });
      else {
        const file = changed(path, null, await workingFile(root, path));
        if (file) {
          delete file.before;
          delete file.after;
            delete file.beforeImage;
            delete file.afterImage;
          files.push(file);
        }
      }
    }
    return {
      projectId: context.projectId,
      sessionId: context.sessionId,
      runId: "",
      files,
      ...(head ? { baseHead: head } : {}),
      ...(targetRef ? { targetRef } : {}),
      added: files.reduce((sum, file) => sum + file.added, 0),
      removed: files.reduce((sum, file) => sum + file.removed, 0),
      ...(paths.length > 2000 ? { incomplete: true } : {}),
    };
  }
  async currentFile(context: ToolContext, review: ChangeReview, path: string) {
    if (!review.files.some((file) => file.path === path))
      throw new Error("File is not in this review");
    if (review.runId) return review.files.find((file) => file.path === path);
    const root = await repository(context);
    return changed(
      path,
      await headFile(root, review.baseHead, path, context.signal),
      review.targetRef
        ? await headFile(root, review.targetRef, path, context.signal)
        : await workingFile(root, path),
    );
  }
  async latest(context: ToolContext): Promise<ChangeReview | undefined> {
    const index = await readFile(
      join(dirname(this.path(context.sessionId, "")), "latest.json"),
      "utf8",
    ).then(
      (value) => JSON.parse(value) as { runId: string },
      () => undefined,
    );
    return index ? this.load(context, index.runId) : undefined;
  }
}
