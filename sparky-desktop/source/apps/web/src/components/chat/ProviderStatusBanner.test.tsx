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
});
