import { ThreadId } from "@sparky/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadStatusLabel, ThreadWorktreeIndicator } from "./ThreadStatusIndicators";
import type { ThreadStatusPill } from "./Sidebar.logic";

describe("ThreadStatusLabel", () => {
  const workingStatus: ThreadStatusPill = {
    label: "Working",
    colorClass: "text-sky-600",
    dotClass: "bg-sky-500",
    pulse: true,
  };

  it("uses a spinner instead of rendering the working label in the row", () => {
    const markup = renderToStaticMarkup(<ThreadStatusLabel status={workingStatus} />);

    expect(markup).toContain("animate-spin");
    expect(markup).toContain('aria-label="Working"');
    expect(markup).not.toContain('class="hidden md:inline">Working</span>');
  });

  it("renders completed status as a blue dot", () => {
    const markup = renderToStaticMarkup(
      <ThreadStatusLabel
        status={{
          label: "Completed",
          colorClass: "text-blue-600",
          dotClass: "bg-blue-500",
          pulse: false,
        }}
      />,
    );

    expect(markup).toContain("bg-blue-500");
    expect(markup).not.toContain("animate-spin");
    expect(markup).not.toContain('class="hidden md:inline">Completed</span>');
  });
});

describe("ThreadWorktreeIndicator", () => {
  it("renders the worktree folder and branch in an accessible label", () => {
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: "feature/sidebar-indicator",
          worktreePath: "/tmp/worktrees/sidebar-indicator",
        }}
      />,
    );

    expect(markup).toContain('role="img"');
    expect(markup).toContain(
      'aria-label="Worktree: sidebar-indicator (feature/sidebar-indicator)"',
    );
    expect(markup).toContain('data-testid="thread-worktree-thread-1"');
  });

  it.each([null, "", "   "])("renders nothing for an absent worktree path", (worktreePath) => {
    const markup = renderToStaticMarkup(
      <ThreadWorktreeIndicator
        thread={{
          id: ThreadId.make("thread-1"),
          branch: "main",
          worktreePath,
        }}
      />,
    );

    expect(markup).toBe("");
  });
});
