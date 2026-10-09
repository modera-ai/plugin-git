import type {
  PluginUiContribution,
  PluginUiNode,
  PluginUiRequest,
} from "@modera/plugin-sdk";
import type { ChangeReview, WorkspaceChangeReview } from "./run-changes";
import { parseScope, reviewOptions, type ReviewScope } from "./review-scopes";
import { createTwoFilesPatch } from "diff";

export function reviewUi(
  changes: WorkspaceChangeReview,
): PluginUiContribution[] {
  const selected = new Map<string, string>();
  const current = new Map<string, ChangeReview>();
  const scopes = new Map<string, ReviewScope>();
  const patchRequests = new Set<string>();
  const key = (request: PluginUiRequest) =>
    JSON.stringify([request.sessionId, request.resource ?? ""]);
  return [
    {
      id: "modera.git.approval",
      slot: "tool.approval",
      toolNames: ["git_change"],
      requiredPermissions: ["workspace.read"],
      async render(request) {
        const preview = request.tool?.result
          ? JSON.parse(request.tool.result)
          : {};
        const children: PluginUiNode[] = [
          {
            type: "code",
            text: JSON.stringify(
              {
                action: preview.action,
                paths: preview.paths,
                message: preview.message,
                branch: preview.branch,
              },
              null,
              2,
            ).slice(0, 16000),
          },
        ];
        if (preview.diff)
          children.push({
            type: "document",
            label: "Git diff",
            text: preview.diff,
            ...(preview.truncated ? { meta: "已截断 / Truncated" } : {}),
          });
        if (preview.note) children.push({ type: "text", text: preview.note });
        return {
          title: request.locale.startsWith("zh")
            ? "确认 Git 变更"
            : "Review Git change",
          scroll: true,
          children,
        };
      },
    },
    {
      id: "modera.git.panel",
      slot: "panel",
      frontend: "review",
      launcher: {
        title: "Change Review",
        description: "查看本轮和工作区文件变更",
        icon: "file",
        locales: { "zh-CN": { title: "变更审查" } },
      },
      requiredPermissions: ["workspace.read", "process.spawn"],
      actions: ["refresh", "file", "scope", "patch"],
      async act(action, _context, request) {
        if (action.id === "refresh") current.delete(key(request));
        if (action.id === "file" && action.value)
          selected.set(key(request), action.value);
        if (action.id === "scope") {
          scopes.set(key(request), parseScope(action.value));
          current.delete(key(request));
          selected.delete(key(request));
        }
        if (action.id === "patch") patchRequests.add(key(request));
      },
      async render(request, context) {
        const zh = request.locale.startsWith("zh");
        const resource = request.resource
          ? (JSON.parse(request.resource) as { runId?: string; path?: string })
          : {};
        const title = resource.runId
          ? zh
            ? "本轮变更"
            : "Turn changes"
          : zh
            ? "工作区变更"
            : "Working tree changes";
        try {
          const options = await reviewOptions(context);
          const scope: ReviewScope = scopes.get(key(request)) ?? {
            kind: resource.runId || !options ? "turn" : "uncommitted",
          };
          let review =
            scope.kind === "turn"
              ? resource.runId
                ? await changes.load(context, resource.runId)
                : await changes.latest(context)
              : current.get(key(request));
          if (!review) {
            review =
              scope.kind === "turn"
                ? {
                    projectId: context.projectId,
                    sessionId: context.sessionId,
                    runId: "",
                    files: [],
                    added: 0,
                    removed: 0,
                  }
                : await changes.current(context, scope);
            current.set(key(request), review);
          }
          const requestedPath =
            selected.get(key(request)) ??
            resource.path ??
            review.files[0]?.path;
          const path = review.files.some((item) => item.path === requestedPath)
            ? requestedPath
            : review.files[0]?.path;
          const file =
            path && !review.runId
              ? await changes.currentFile(context, review, path)
              : review.files.find((item) => item.path === path);
          let overview: ChangeReview["files"] | undefined;
          if (review.files.length <= 8) {
            const contents = review.runId
              ? review.files
              : (
                  await Promise.all(
                    review.files.map((item) =>
                      changes.currentFile(context, review!, item.path),
                    ),
                  )
                ).filter((item): item is NonNullable<typeof item> => !!item);
            if (
              contents.reduce(
                (sum, item) =>
                  sum +
                  Buffer.byteLength(item.before ?? "") +
                  Buffer.byteLength(item.after ?? "") + Buffer.byteLength(item.beforeImage ?? "") + Buffer.byteLength(item.afterImage ?? ""),
                0,
              ) <=
              2 * 1024 * 1024
            )
              overview = contents;
          }
          let patch: string | undefined;
          if (patchRequests.delete(key(request)) && file && !file.unavailable) {
            patch = createTwoFilesPatch(
              file.status === "added" ? "/dev/null" : `a/${file.path}`,
              file.status === "deleted" ? "/dev/null" : `b/${file.path}`,
              file.before ?? "",
              file.after ?? "",
            );
            if (Buffer.byteLength(patch) > 1024 * 1024)
              throw Error("Patch is too large to copy");
          }
          return {
            title: review.runId ? (zh ? "本轮变更" : "Turn changes") : title,
            children: [],
            data: {
              mode: review.runId ? "turn" : "workspace",
              runId: review.runId,
              scope,
              ...(options ? { git: options } : {}),
              ...(overview ? { overview } : {}),
              ...(patch ? { patch } : {}),
              files: review.files.map(
                ({ before: _before, after: _after, beforeImage: _bi, afterImage: _ai, ...item }) => item,
              ),
              added: review.added,
              removed: review.removed,
              incomplete: review.incomplete,
              ...(file ? { selected: file } : {}),
            },
          };
        } catch (error) {
          return { title, children: [], data: { error: String(error) } };
        }
      },
    },
  ];
}
