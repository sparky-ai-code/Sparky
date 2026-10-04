import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { ServerProvider } from "@sparky/contracts";

import { ProviderStatusBanner } from "./ProviderStatusBanner";

const status = (overrides: Record<string, unknown>) =>
  ({
    driver: "sparky",
    status: "ready",
    auth: { status: "authenticated" },
    message: null,
    ...overrides,
  }) as unknown as ServerProvider;

describe("ProviderStatusBanner", () => {
  it("renders provider warning banners", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner
        status={status({ status: "warning", message: "The provider is limited." })}
      />,
    );

    expect(markup).toContain("provider status");
    expect(markup).toContain("The provider is limited.");
  });

  it("keeps provider error banners visible", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner
        status={status({ status: "error", message: "The provider is unavailable." })}
      />,
    );

    expect(markup).toContain("provider status");
    expect(markup).toContain("The provider is unavailable.");
  });

  it("shows the provider's specific error instead of a generic auth prompt", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner
        status={status({
          status: "error",
          auth: { status: "unauthenticated" },
          message: "The Sparky runtime was not found.",
        })}
      />,
    );

    expect(markup).toContain("Sparky provider status");
    expect(markup).toContain("The Sparky runtime was not found.");
    expect(markup).not.toContain("Sign in via the CLI");
  });

  it("points unauthenticated providers to Models settings", () => {
    const markup = renderToStaticMarkup(
      <ProviderStatusBanner
        status={status({ status: "error", auth: { status: "unauthenticated" } })}
      />,
    );

    expect(markup).toContain("Sparky is unauthenticated");
    expect(markup).toContain("Settings → Models");
  });
});
