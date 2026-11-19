import { ApprovalRequestId } from "@sparky/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

describe("ComposerPendingApprovalPanel", () => {
  it("renders an external tool permission as a tool, not a file change", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("external-approval-1"),
          requestKind: "tool",
          createdAt: "2026-11-11T00:00:00.000Z",
          detail: "Allow preview_click to run?",
        }}
        pendingCount={1}
      />,
    );
    expect(markup).toContain("Tool approval requested");
    expect(markup).toContain('aria-label="Tool"');
    expect(markup).not.toContain("File-change approval requested");
  });

  it("renders complete multiline command details without hover or truncation", () => {
    const detail = `bun run release -- ${"long-argument ".repeat(20)}\nsecond line`;
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.make("approval-1"),
          requestKind: "command",
          createdAt: "2026-07-18T00:00:00.000Z",
          detail,
        }}
        pendingCount={1}
      />,
    );

    expect(markup).toContain('data-approval-detail="complete"');
    expect(markup).toContain('aria-label="Command"');
    expect(markup).toContain(detail);
    expect(markup).not.toContain("truncate");
    expect(markup).not.toContain("line-clamp");
  });
});
