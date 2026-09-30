import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import {
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import {
  ChevronLeft,
  ChevronRight,
  Columns2,
  FileDiff,
  FolderTree,
  List,
  RefreshCw,
  Search,
  SquareArrowOutUpRight,
} from "lucide-react";
import { FileNavigationTree, FileTypeIcon } from "@modera/ui/files";
import { frontend, usePluginSnapshot } from "@modera/plugin-sdk/react";
import type { RunChangedFile } from "@modera/plugin-sdk";

type FileChange = RunChangedFile & { before?: string; after?: string };
type Data = {
  mode: "turn" | "workspace";
  files: RunChangedFile[];
  selected?: FileChange;
  added: number;
  removed: number;
  incomplete?: boolean;
  error?: string;
};
const language = (path: string): Extension => {
  const ext = path.split(".").at(-1)?.toLowerCase();
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext ?? ""))
    return javascript({
      typescript: ext === "ts" || ext === "tsx",
      jsx: ext === "jsx" || ext === "tsx",
    });
  if (["json", "jsonc"].includes(ext ?? "")) return json();
  if (["css", "scss", "less"].includes(ext ?? "")) return css();
  if (["html", "htm", "vue"].includes(ext ?? "")) return html();
  if (["md", "markdown"].includes(ext ?? "")) return markdown();
  if (ext === "py") return python();
  return [];
};
function Diff({
  file,
  split,
  dark,
}: {
  file: FileChange;
  split: boolean;
  dark: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current || (file.unavailable && file.unavailable !== "complex"))
      return;
    const extensions: Extension[] = [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      lineNumbers(),
      language(file.path),
      syntaxHighlighting(dark ? oneDarkHighlightStyle : defaultHighlightStyle, {
        fallback: true,
      }),
      EditorView.theme(
        {
          "&": {
            backgroundColor: "var(--review-page)",
            color: "var(--review-ink)",
            fontSize: "12px",
          },
          ".cm-content": {
            fontFamily: "ui-monospace, Consolas, monospace",
            padding: "8px 0",
          },
          ".cm-gutters": {
            backgroundColor: "var(--review-page)",
            color: "var(--review-muted)",
            border: "none",
          },
          ".cm-scroller": {
            overflow: "auto",
            fontFamily: "ui-monospace, Consolas, monospace",
          },
        },
        { dark },
      ),
    ];
    const common = {
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 3, minSize: 6 },
      diffConfig: { scanLimit: 2000, timeout: 1000 },
    };
    const view = split
      ? new MergeView({
          parent: host.current,
          a: { doc: file.before ?? "", extensions },
          b: { doc: file.after ?? "", extensions },
          ...common,
        })
      : new EditorView({
          parent: host.current,
          doc: file.after ?? "",
          extensions: [
            ...extensions,
            unifiedMergeView({
              original: file.before ?? "",
              mergeControls: false,
              ...common,
            }),
          ],
        });
    return () => view.destroy();
  }, [file.path, file.before, file.after, file.unavailable, split, dark]);
  return <div ref={host} className="review-diff" aria-label="File diff" />;
}
function App() {
  const { snapshot, error } = usePluginSnapshot();
  const [local, setLocal] = useState<typeof snapshot>();
  const data = (local ?? snapshot)?.view.data as Data | undefined;
  const zh = snapshot?.locale.startsWith("zh") ?? true;
  const t = (cn: string, en: string) => (zh ? cn : en);
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [query, setQuery] = useState("");
  const [narrow, setNarrow] = useState(false),
    [tree, setTree] = useState<boolean>(),
    [mode, setMode] = useState<"split" | "unified">();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setLocal(undefined);
  }, [snapshot?.view]);
  useEffect(() => {
    void frontend().ready();
    if (!root.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setNarrow((entry?.contentRect.width ?? 0) < 720),
    );
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  const act = async (id: string, value?: string) => {
    setBusy(true);
    setNotice("");
    try {
      setLocal(await frontend().action(id, value));
    } catch (cause) {
      setNotice(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const files = data?.files ?? [],
    file = data?.selected,
    index = files.findIndex((item) => item.path === file?.path);
  const split = mode ? mode === "split" : !narrow,
    showTree = tree ?? !narrow;
  const unavailable = (reason: string) =>
    ({
      binary: t(
        "二进制文件已变更，无法显示文本差异。",
        "Binary file changed; text diff is unavailable.",
      ),
      large: t(
        "文件较大，未保存文本差异。",
        "Large file; text diff was not stored.",
      ),
      symlink: t("符号链接已变更。", "Symbolic link changed."),
      encoding: t("此文件不是 UTF-8 文本。", "This file is not UTF-8 text."),
      budget: t(
        "文件内容超出本轮预览预算。",
        "File exceeds the turn preview budget.",
      ),
      complex: t(
        "差异较复杂，未计算精确行数。",
        "Complex diff; exact line counts unavailable.",
      ),
    })[reason] ?? t("此文件无法显示文本差异。", "Text diff unavailable.");
  return (
    <div
      ref={root}
      className={`review-app${showTree ? " with-tree" : ""}`}
      data-theme={snapshot?.theme?.mode ?? "light"}
    >
      <header className="review-toolbar">
        <div className="review-heading">
          <FileDiff />
          <strong>
            {data?.mode === "turn"
              ? t("本轮变更", "Turn changes")
              : t("工作区变更", "Working tree changes")}
          </strong>
          <span className="review-total">
            <span className="added">+{data?.added ?? 0}</span>
            <span className="removed">−{data?.removed ?? 0}</span>
          </span>
          <small>
            {files.length} {t("个文件", "files")}
          </small>
        </div>
        <div className="review-tools">
          <button
            title={t("单列差异", "Unified diff")}
            aria-pressed={!split}
            onClick={() => setMode("unified")}
          >
            <List />
          </button>
          <button
            title={t("左右对照", "Side by side")}
            aria-pressed={split}
            onClick={() => setMode("split")}
          >
            <Columns2 />
          </button>
          <button
            title={t("文件导航", "File navigation")}
            aria-pressed={showTree}
            onClick={() => setTree(!showTree)}
          >
            <FolderTree />
          </button>
          {data?.mode === "workspace" && (
            <button
              disabled={busy}
              title={t("刷新", "Refresh")}
              onClick={() => void act("refresh")}
            >
              <RefreshCw className={busy ? "spin" : ""} />
            </button>
          )}
        </div>
      </header>
      {(notice || error || data?.error) && (
        <p role="alert" className="review-notice">
          {notice || error || data?.error}
        </p>
      )}
      {data?.incomplete && (
        <p className="review-notice">
          {t(
            "本轮文件较多，部分内容未保存；统计仅包含已记录的文件。",
            "Some changes were not recorded; totals cover recorded files only.",
          )}
        </p>
      )}
      <div className="review-layout">
        <main className="review-main" aria-busy={busy}>
          {!snapshot ? (
            <p className="review-empty">
              {t("正在加载变更…", "Loading changes…")}
            </p>
          ) : !files.length ? (
            <div className="review-empty">
              <FileDiff />
              <p>{t("没有文件变更", "No changed files")}</p>
            </div>
          ) : (
            file && (
              <>
                <header className="review-file-heading">
                  <FileTypeIcon path={file.path} />
                  <span title={file.path}>{file.path}</span>
                  <span className="review-status">
                    {file.status === "added"
                      ? t("新增", "Added")
                      : file.status === "deleted"
                        ? t("删除", "Deleted")
                        : t("修改", "Modified")}
                  </span>
                  <span className="review-total">
                    <span className="added">+{file.added}</span>
                    <span className="removed">−{file.removed}</span>
                  </span>
                  {file.status !== "deleted" && (
                    <button
                      title={t("在文件浏览器中打开", "Open in file browser")}
                      onClick={() => {
                        void frontend()
                          .openFile(file.path)
                          .catch((cause) => setNotice(String(cause)));
                      }}
                    >
                      <SquareArrowOutUpRight />
                    </button>
                  )}
                </header>
                <div className="review-columns">
                  {split ? (
                    <>
                      <span>{t("修改前", "Before")}</span>
                      <span>{t("修改后", "After")}</span>
                    </>
                  ) : (
                    <span>{t("修改前后差异", "Changes")}</span>
                  )}
                </div>
                {file.unavailable && file.unavailable !== "complex" ? (
                  <p className="review-empty">
                    {unavailable(file.unavailable)}
                  </p>
                ) : (
                  <Diff
                    file={file}
                    split={split}
                    dark={snapshot.theme?.mode === "dark"}
                  />
                )}
              </>
            )
          )}
          {!!files.length && (
            <footer className="review-pagination">
              <button
                disabled={busy || index <= 0}
                onClick={() => void act("file", files[index - 1]!.path)}
              >
                <ChevronLeft />
                {t("上一个文件", "Previous file")}
              </button>
              <span>
                {index + 1} / {files.length}
              </span>
              <button
                disabled={busy || index >= files.length - 1}
                onClick={() => void act("file", files[index + 1]!.path)}
              >
                {t("下一个文件", "Next file")}
                <ChevronRight />
              </button>
            </footer>
          )}
        </main>
        {showTree && (
          <aside className="review-files">
            <label className="review-search">
              <Search />
              <input
                aria-label={t("筛选变更文件", "Filter changed files")}
                placeholder={t("筛选文件…", "Filter files…")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <FileNavigationTree
              items={files.filter((item) =>
                item.path.toLowerCase().includes(query.toLowerCase()),
              )}
              selected={file?.path}
              label={t("变更文件", "Changed files")}
              onSelect={(path) => {
                if (!busy) void act("file", path);
              }}
            />
          </aside>
        )}
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
