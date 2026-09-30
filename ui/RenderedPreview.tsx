import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export const supportsPreview = (path: string) =>
  /\.(html?|md|markdown)$/i.test(path);

function Content({
  path,
  text,
  label,
}: {
  path: string;
  text: string;
  label: string;
}) {
  if (/\.html?$/i.test(path))
    return (
      <iframe
        className="review-preview"
        sandbox=""
        title={label}
        srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><meta name="color-scheme" content="light dark">${text}`}
      />
    );
  return (
    <article className="review-markdown" aria-label={label}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ children }) => (
            <span className="review-preview-link">{children}</span>
          ),
          img: ({ alt }) => (
            <span className="review-preview-image">{alt || "Image"}</span>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </article>
  );
}

export function RenderedPreview({
  file,
  split,
  zh,
}: {
  file: { path: string; before?: string; after?: string; status: string };
  split: boolean;
  zh: boolean;
}) {
  const before = zh ? "修改前预览" : "Before preview",
    after = zh ? "修改后预览" : "After preview";
  return (
    <div className={`review-rendered${split ? " split" : ""}`}>
      {split && (
        <Content path={file.path} text={file.before ?? ""} label={before} />
      )}
      <Content
        path={file.path}
        text={
          !split && file.status === "deleted"
            ? (file.before ?? "")
            : (file.after ?? "")
        }
        label={!split && file.status === "deleted" ? before : after}
      />
    </div>
  );
}
