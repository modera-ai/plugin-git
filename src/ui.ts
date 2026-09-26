import type { PluginUiContribution, PluginUiNode } from "@modera/plugin-sdk";
import { inspect } from "./index";

export function gitUi(): PluginUiContribution[] {
  const selected = new Map<string, string>();
  return [
    {
      id: "modera.git.panel",
      slot: "panel",
      launcher: {
        title: "Git",
        description: "查看工作区、暂存区和文件差异",
        icon: "file",
      },
      requiredPermissions: ["workspace.read", "process.spawn"],
      actions: ["refresh", "select", "clear"],
      async act(action, context) {
        if (action.id === "select" && action.value)
          selected.set(context.sessionId, action.value);
        if (action.id === "clear") selected.delete(context.sessionId);
      },
      async render(request, context) {
        const zh = request.locale.startsWith("zh");
        const children: PluginUiNode[] = [
          { type: "button", label: zh ? "刷新" : "Refresh", action: "refresh" },
        ];
        try {
          const result = await inspect({ action: "status" }, context);
          const files = result.files ?? [];
          children.push({
            type: "text",
            text: zh
              ? `共 ${files.length} 个变更文件 · 点击文件查看差异`
              : `${files.length} changed files · Select to review`,
          });
          for (const file of files.slice(0, 40))
            children.push({
              type: "button",
              label: `${file.index}${file.worktree} ${file.path}`.slice(0, 190),
              action: "select",
              value: file.path,
            });
          if (files.length > 40)
            children.push({
              type: "text",
              text: zh
                ? "仅显示前 40 项，完整列表可在对话中查询。"
                : "Showing 40 files; ask in chat for the full list.",
            });
          const path = selected.get(context.sessionId);
          if (path) {
            children.push({ type: "text", text: path.slice(0, 190) });
            for (const staged of [false, true]) {
              const diff =
                (
                  await inspect(
                    { action: "diff", paths: [path], staged },
                    context,
                  )
                ).diff ?? "";
              children.push({
                type: "document",
                label: staged
                  ? zh
                    ? "暂存区"
                    : "Staged"
                  : zh
                    ? "工作区"
                    : "Working tree",
                text:
                  diff.slice(0, 16000) ||
                  (zh
                    ? "无差异（未跟踪文件尚未纳入 Git diff）"
                    : "No diff (untracked files are not in Git diff)"),
                ...(diff.length > 16000
                  ? { meta: zh ? "已截断" : "Truncated" }
                  : {}),
              });
            }
          }
        } catch (error) {
          children.push({ type: "text", text: String(error).slice(0, 190) });
        }
        return { title: "Git", scroll: true, children };
      },
    },
  ];
}
