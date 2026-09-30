import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { RenderedPreview, supportsPreview } from "../ui/RenderedPreview";

describe("review rendered preview", () => {
  it("renders Markdown formatting and GFM without executable HTML or remote resources", () => {
    const result = renderToStaticMarkup(createElement(RenderedPreview,{file:{path:"test.md",status:"added",after:"# Title\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n![remote](https://example.invalid/a.png)\n\n[unsafe](javascript:alert(1))"},split:false,zh:true}));
    expect(result).toContain("<h1>Title</h1>");
    expect(result).toContain("<table>");
    expect(result).not.toContain("<script>");
    expect(result).not.toContain("<img");
    expect(result).not.toContain("href=");
  });
  it("previews deleted Markdown from its before version", () => {
    const result = renderToStaticMarkup(createElement(RenderedPreview,{file:{path:"test.markdown",status:"deleted",before:"# Deleted"},split:false,zh:true}));
    expect(result).toContain("<h1>Deleted</h1>");
    expect(result).toContain("修改前预览");
  });
  it("isolates HTML before/after frames and only supports known preview types", () => {
    const result = renderToStaticMarkup(createElement(RenderedPreview,{file:{path:"test.html",status:"modified",before:"old",after:"new"},split:true,zh:false}));
    expect(result.match(/<iframe/g)).toHaveLength(2);
    expect(result).toContain('sandbox=""');
    expect(result).toContain("default-src &#x27;none&#x27;");
    expect(supportsPreview("README.MD")).toBe(true);
    expect(supportsPreview("test.js")).toBe(false);
  });
});
