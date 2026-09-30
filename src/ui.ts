import type {
  PluginUiContribution,
  PluginUiNode,
  PluginUiRequest,
} from "@modera/plugin-sdk";
import type { ChangeReview, GitRunChanges } from "./run-changes";

export function gitUi(changes: GitRunChanges): PluginUiContribution[] {
  const selected = new Map<string, string>();
  const current = new Map<string, ChangeReview>();
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
        title: "Git Changes",
        description: "查看本轮和工作区文件变更",
        icon: "file",
        locales: { "zh-CN": { title: "文件变更" } },
      },
      requiredPermissions: ["workspace.read", "process.spawn"],
      actions: ["refresh", "file"],
      async act(action, _context, request) {
        if (action.id === "refresh") current.delete(key(request));
        if (action.id === "file" && action.value)
          selected.set(key(request), action.value);
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
          let review = resource.runId
            ? await changes.load(context, resource.runId)
            : current.get(key(request));
          if (!review) {
            review = await changes.current(context);
            current.set(key(request), review);
          }
          const path =
            selected.get(key(request)) ??
            resource.path ??
            review.files[0]?.path;
          const file =
            path && !resource.runId
              ? await changes.currentFile(context, review, path)
              : review.files.find((item) => item.path === path);
          return {
            title,
            children: [],
            data: {
              mode: resource.runId ? "turn" : "workspace",
              runId: review.runId,
              files: review.files.map(
                ({ before: _before, after: _after, ...item }) => item,
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
