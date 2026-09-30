import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers, Decoration } from "@codemirror/view";
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
import { MergeView, unifiedMergeView, diff } from "@codemirror/merge";
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
  ChevronDown,
  MoreHorizontal,
  FileText,
  WholeWord,
  EyeOff,
  Copy,
  Image,
  Check,
  ListCollapse,
  GitBranch,
} from "lucide-react";
import { FileNavigationTree, FileTypeIcon } from "@modera/ui/files";
import { frontend, usePluginSnapshot } from "@modera/plugin-sdk/react";
import type { RunChangedFile } from "@modera/plugin-sdk";
import { RenderedPreview, supportsPreview } from "./RenderedPreview";

type FileChange = RunChangedFile & { before?: string; after?: string };
type Data = {
  scope?: { kind: string; ref?: string };
  git?: {
    commits: { ref: string; label: string; date?: string }[];
    branches: { ref: string; label: string }[];
    currentBranch: string;
  };
  overview?: FileChange[];
  patch?: string;
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
  words,
  full,
  whitespace,
}: {
  file: FileChange;
  split: boolean;
  dark: boolean;
  words: boolean;
  full: boolean;
  whitespace: boolean;
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
      highlightChanges:
        words && file.status !== "added" && file.status !== "deleted",
      gutter: true,
      ...(full ? {} : { collapseUnchanged: { margin: 3, minSize: 6 } }),
      diffConfig: {
        scanLimit: 2000,
        timeout: 1000,
        ...(whitespace
          ? {
              override: (a: string, b: string) =>
                diff(a, b, { scanLimit: 2000, timeout: 1000 }).filter(
                  (c) =>
                    a.slice(c.fromA, c.toA).replace(/\s/g, "") !==
                    b.slice(c.fromB, c.toB).replace(/\s/g, ""),
                ),
            }
          : {}),
      },
    };
    const changes = diff(file.before ?? "", file.after ?? "", {
      scanLimit: 2000,
      timeout: 1000,
    });
    const wholeLines = (before: boolean): Extension =>
      EditorView.decorations.of((view) => {
        const ranges = [];
        for (const change of changes) {
          const start = before ? change.fromA : change.fromB,
            end = before ? change.toA : change.toB;
          for (let pos = start; pos < end;) {
            const line = view.state.doc.lineAt(pos);
            if (line.from >= start && line.to <= end && line.length)
              ranges.push(
                Decoration.line({ class: "review-whole-line" }).range(
                  line.from,
                ),
              );
            const next = line.to + 1;
            if (next <= pos) break;
            pos = next;
          }
        }
        return Decoration.set(ranges, true);
      });
    const view = split
      ? new MergeView({
          parent: host.current,
          a: {
            doc: file.before ?? "",
            extensions: [...extensions, wholeLines(true)],
          },
          b: {
            doc: file.after ?? "",
            extensions: [...extensions, wholeLines(false)],
          },
          ...common,
        })
      : new EditorView({
          parent: host.current,
          doc: file.after ?? "",
          extensions: [
            ...extensions,
            wholeLines(false),
            unifiedMergeView({
              original: file.before ?? "",
              mergeControls: false,
              ...common,
            }),
          ],
        });
    return () => view.destroy();
  }, [
    file.path,
    file.before,
    file.after,
    file.unavailable,
    split,
    dark,
    words,
    full,
    whitespace,
  ]);
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
  const [words, setWords] = useState(true),
    [full, setFull] = useState(false),
    [whitespace, setWhitespace] = useState(false),
    [preview, setPreview] = useState(false);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const menu = useRef<HTMLDetailsElement>(null);
  const scopeMenu = useRef<HTMLDetailsElement>(null);
  const [branchQuery, setBranchQuery] = useState("");
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
  const scopeLabel = (
    {
      turn: t("上一轮", "Last turn"),
      uncommitted: t("未提交", "Uncommitted"),
      unstaged: t("未暂存", "Unstaged"),
      staged: t("已暂存", "Staged"),
      commit: t("已提交", "Commit"),
      branch: t("分支比较", "Branch comparison"),
    } as Record<string, string>
  )[data?.scope?.kind ?? "turn"];
  const scope = (kind: string, ref?: string) => {
    scopeMenu.current?.removeAttribute("open");
    setClosed({});
    void act("scope", JSON.stringify({ kind, ref }));
  };
  const displayed = data?.overview ?? (file ? [file] : []);
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
          {data?.git ? (
            <details ref={scopeMenu} className="review-menu">
              <summary>
                {scopeLabel}
                <ChevronDown />
              </summary>
              <div className="review-menu-panel">
                {["turn", "uncommitted", "unstaged", "staged"].map((kind) => (
                  <button
                    key={kind}
                    onClick={(event) => {
                      event.currentTarget
                        .closest("details")
                        ?.removeAttribute("open");
                      scope(kind);
                    }}
                  >
                    {
                      (
                        {
                          turn: t("上一轮", "Last turn"),
                          uncommitted: t("未提交", "Uncommitted"),
                          unstaged: t("未暂存", "Unstaged"),
                          staged: t("已暂存", "Staged"),
                        } as Record<string, string>
                      )[kind]
                    }
                    {data.scope?.kind === kind && (
                      <Check className="review-check" />
                    )}
                  </button>
                ))}
                <details className="review-submenu">
                  <summary>
                    {t("已提交", "Commits")}
                    <ChevronRight />
                  </summary>
                  <div className="review-commits">
                    {data.git.commits.map((item) => (
                      <button
                        key={item.ref}
                        onClick={() => scope("commit", item.ref)}
                        title={item.ref}
                      >
                        {item.label}
                        <small>
                          {item.date
                            ? new Intl.DateTimeFormat(zh ? "zh-CN" : "en", {
                                month: "short",
                                day: "numeric",
                              }).format(new Date(item.date))
                            : ""}
                        </small>
                        {data.scope?.ref === item.ref && (
                          <Check className="review-check" />
                        )}
                      </button>
                    ))}
                  </div>
                </details>
                <button
                  onClick={() =>
                    scope(
                      "branch",
                      data.git!.branches.find(
                        (item) => item.label !== data.git!.currentBranch,
                      )?.ref ?? data.git!.branches[0]?.ref,
                    )
                  }
                >
                  {t("分支", "Branches")}
                  {data.scope?.kind === "branch" && (
                    <Check className="review-check" />
                  )}
                </button>
              </div>
            </details>
          ) : (
            <strong>
              {data?.mode === "turn"
                ? t("本轮变更", "Turn changes")
                : t("工作区变更", "Working tree changes")}
            </strong>
          )}
          <span className="review-total">
            <span className="added">+{data?.added ?? 0}</span>
            <span className="removed">−{data?.removed ?? 0}</span>
          </span>
          <small>
            {files.length} {t("个文件", "files")}
          </small>
        </div>
        <div className="review-tools">
          <details ref={menu} className="review-menu">
            <summary title={t("查看选项", "View options")}>
              <MoreHorizontal />
            </summary>
            <div className="review-menu-panel">
              <button onClick={() => setFull(!full)}>
                <FileText />
                {t("加载完整文件", "Full file context")}
                {full && <Check className="review-check" />}
              </button>
              <button onClick={() => setWords(!words)}>
                <WholeWord />
                {t("词级差异", "Word-level differences")}
                {words && <Check className="review-check" />}
              </button>
              <button onClick={() => setWhitespace(!whitespace)}>
                <EyeOff />
                {t("忽略空白差异", "Ignore whitespace changes")}
                {whitespace && <Check className="review-check" />}
              </button>
              <button
                disabled={
                  !displayed.some(
                    (item) =>
                      supportsPreview(item.path) &&
                      (!item.unavailable || item.unavailable === "complex"),
                  )
                }
                onClick={() => {
                  setPreview(!preview);
                  menu.current?.removeAttribute("open");
                }}
              >
                <Image />
                {t("渲染预览", "Rendered preview")}
                {preview && <Check className="review-check" />}
              </button>
              {data?.git && (
                <button
                  disabled={!file || !!file.unavailable || busy}
                  onClick={async () => {
                    try {
                      const result = await frontend().action("patch");
                      const patch = (result.view.data as Data).patch;
                      if (!patch) throw Error("No patch available");
                      let marker = "MODERA_PATCH";
                      while (patch.includes(marker)) marker += "_";
                      await frontend().copyText(
                        `git apply <<'${marker}'\n${patch}\n${marker}`,
                      );
                      setNotice(
                        t(
                          "已复制当前文件的 git apply 命令",
                          "Copied git apply command for the current file",
                        ),
                      );
                    } catch (cause) {
                      setNotice(String(cause));
                    }
                  }}
                >
                  <Copy />
                  {t("复制 git apply 命令", "Copy git apply command")}
                </button>
              )}
            </div>
          </details>
          <button
            title={
              split
                ? t("切换为单列差异", "Switch to unified diff")
                : t("左右对照", "Side by side")
            }
            aria-pressed={split}
            onClick={() => setMode(split ? "unified" : "split")}
          >
            {split ? <Columns2 /> : <List />}
          </button>
          {data?.overview && (
            <button
              title={
                displayed.every((item) => closed[item.path])
                  ? t("展开全部差异", "Expand all diffs")
                  : t("收起全部差异", "Collapse all diffs")
              }
              onClick={() => {
                const collapse = !displayed.every((item) => closed[item.path]);
                setClosed(
                  Object.fromEntries(
                    displayed.map((item) => [item.path, collapse]),
                  ),
                );
              }}
            >
              <ListCollapse />
            </button>
          )}
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
      {data?.git && data.scope?.kind === "branch" && (
        <div className="review-branch-row">
          <span>{data.git.currentBranch}</span>
          <span>→</span>
          <details className="review-menu">
            <summary>
              {data.git.branches.find((item) => item.ref === data.scope?.ref)
                ?.label ?? t("选择分支", "Choose branch")}
              <ChevronDown />
            </summary>
            <div className="review-menu-panel">
              <label className="review-search">
                <Search />
                <input
                  placeholder={t("搜索分支", "Search branches")}
                  value={branchQuery}
                  onChange={(event) => setBranchQuery(event.target.value)}
                />
              </label>
              {data.git.branches
                .filter((item) =>
                  item.label.toLowerCase().includes(branchQuery.toLowerCase()),
                )
                .map((item) => (
                  <button
                    key={item.ref}
                    onClick={(event) => {
                      event.currentTarget
                        .closest("details")
                        ?.removeAttribute("open");
                      scope("branch", item.ref);
                    }}
                  >
                    <GitBranch />
                    {item.label}
                    {item.ref === data.scope?.ref && (
                      <Check className="review-check" />
                    )}
                  </button>
                ))}
            </div>
          </details>
        </div>
      )}
      {!!files.length && !data?.overview && (
        <p className="review-notice">
          {t(
            "此差异较大，每次仅显示一个文件",
            "This diff is large; showing one file at a time",
          )}
        </p>
      )}
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
            displayed.map((file) => (
              <section
                key={file.path}
                className="review-section"
                data-file={file.path}
              >
                <header className="review-file-heading">
                  {data?.overview && (
                    <button
                      title={t("展开 / 收起", "Expand / collapse")}
                      aria-expanded={!closed[file.path]}
                      onClick={() =>
                        setClosed({
                          ...closed,
                          [file.path]: !closed[file.path],
                        })
                      }
                    >
                      <ChevronDown
                        style={{
                          transform: closed[file.path]
                            ? "rotate(-90deg)"
                            : undefined,
                        }}
                      />
                    </button>
                  )}
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
                {!closed[file.path] && (
                  <>
                    <div className="review-columns">
                      {split ? (
                        <>
                          <span>{t("修改前", "Before")}</span>
                          <span>{t("修改后", "After")}</span>
                        </>
                      ) : (
                        <span>
                          {preview && supportsPreview(file.path)
                            ? file.status === "deleted"
                              ? t("修改前预览", "Before preview")
                              : t("修改后预览", "After preview")
                            : t("修改前后差异", "Changes")}
                        </span>
                      )}
                    </div>
                    {file.unavailable && file.unavailable !== "complex" ? (
                      <p className="review-empty">
                        {unavailable(file.unavailable)}
                      </p>
                    ) : preview && supportsPreview(file.path) ? (
                      <RenderedPreview file={file} split={split} zh={zh} />
                    ) : (
                      <Diff
                        file={file}
                        split={split}
                        dark={snapshot.theme?.mode === "dark"}
                        words={words}
                        full={full}
                        whitespace={whitespace}
                      />
                    )}
                  </>
                )}
              </section>
            ))
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
                setClosed((previous) => ({ ...previous, [path]: false }));
                requestAnimationFrame(() =>
                  Array.from(
                    root.current?.querySelectorAll<HTMLElement>(
                      ".review-section",
                    ) ?? [],
                  )
                    .find((element) => element.dataset.file === path)
                    ?.scrollIntoView({ block: "start" }),
                );
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
