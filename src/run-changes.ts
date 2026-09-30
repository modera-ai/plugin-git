import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { diffLines } from "diff";
import type {
  RunChangedFile,
  RunChangesContext,
  RunChangesSummary,
  ToolContext,
} from "@modera/plugin-sdk";
import { git, repository, selectedPaths } from "./index";

const FILE_LIMIT = 1024 * 1024;
const TOTAL_LIMIT = 32 * 1024 * 1024;
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
type Content = { hash: string; text?: string; unavailable?: string };
export type ChangedFile = RunChangedFile & { before?: string; after?: string };
export interface ChangeReview {
  baseHead?: string;
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
  if (stat.size > FILE_LIMIT)
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
  const object = await git(root, ["ls-tree", "-z", head, "--", path], signal);
  if (!object) return null;
  const id = object.split("\t")[0]!.split(" ").at(-1)!;
  const size = Number((await git(root, ["cat-file", "-s", id], signal)).trim());
  if (size > FILE_LIMIT) return { hash: id, unavailable: "large" };
  // cat-file returns text through execFile. Binary objects are reported, not rendered.
  const text = await git(root, ["cat-file", "blob", id], signal);
  return content(Buffer.from(text));
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
  };
}

/** HEAD plus pre-existing dirty contents is the baseline; commits during a turn
 * do not erase it. No stash, index update, commit or Git object is created. */
export class GitRunChanges {
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
    const root = await repository(context).catch(() => undefined);
    if (!root) return undefined;
    const head = await headOf(root, context.signal);
    const baseline = new Map<string, Content | null>();
    let bytes = 0,
      incomplete = false;
    const paths = await dirtyPaths(root, head, context.signal);
    for (const path of paths.slice(0, 2000)) {
      context.signal.throwIfAborted();
      const file = await workingFile(root, path);
      bytes += Buffer.byteLength(file?.text ?? "");
      if (bytes > TOTAL_LIMIT) {
        incomplete = true;
        break;
      }
      baseline.set(path, file);
    }
    if (baseline.size < paths.length) incomplete = true;
    return {
      finish: async (signal: AbortSignal) => {
        const candidates = new Set([
          ...baseline.keys(),
          ...(await dirtyPaths(root, head, signal)),
        ]);
        const files: ChangedFile[] = [];
        let storedBytes = 0;
        for (const path of [...candidates].sort().slice(0, 2000)) {
          signal.throwIfAborted();
          // A missing baseline entry from the budget must not be mistaken for a new file.
          if (paths.includes(path) && !baseline.has(path)) continue;
          const before = baseline.has(path)
            ? baseline.get(path)!
            : await headFile(root, head, path, signal);
          const after = await workingFile(root, path);
          const file = changed(path, before, after);
          if (!file) continue;
          storedBytes +=
            Buffer.byteLength(file.before ?? "") +
            Buffer.byteLength(file.after ?? "");
          if (storedBytes > TOTAL_LIMIT) {
            delete file.before;
            delete file.after;
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
        ({ before: _before, after: _after, ...file }) => ({
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
  async current(context: ToolContext): Promise<ChangeReview> {
    const root = await repository(context),
      head = await headOf(root, context.signal);
    const paths = await dirtyPaths(root, head, context.signal),
      files: ChangedFile[] = [];
    const numbers = head
      ? await git(
          root,
          ["diff", "--numstat", "-z", "--no-renames", head, "--"],
          context.signal,
        )
      : "";
    const stats = new Map(
      numbers
        .split("\0")
        .filter(Boolean)
        .map((record) => {
          const [added, removed, ...path] = record.split("\t");
          return [path.join("\t"), { added, removed }] as const;
        }),
    );
    const statuses = head
      ? (
          await git(
            root,
            ["diff", "--name-status", "-z", "--no-renames", head, "--"],
            context.signal,
          )
        ).split("\0")
      : [];
    const kinds = new Map<string, string>();
    for (let i = 0; i < statuses.length - 1; i += 2)
      kinds.set(statuses[i + 1]!, statuses[i]!);
    for (const path of paths.slice(0, 2000)) {
      const stat = stats.get(path);
      if (stat)
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
      added: files.reduce((sum, file) => sum + file.added, 0),
      removed: files.reduce((sum, file) => sum + file.removed, 0),
      ...(paths.length > 2000 ? { incomplete: true } : {}),
    };
  }
  async currentFile(context: ToolContext, review: ChangeReview, path: string) {
    if (!review.files.some((file) => file.path === path))
      throw new Error("File is not in this review");
    const root = await repository(context);
    return changed(
      path,
      await headFile(root, review.baseHead, path, context.signal),
      await workingFile(root, path),
    );
  }
}
