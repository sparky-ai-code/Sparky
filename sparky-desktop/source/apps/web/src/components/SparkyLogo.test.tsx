import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SparkyLogo } from "./SparkyLogo";

describe("SparkyLogo", () => {
  it("renders the approved artwork as a currentColor alpha mask", () => {
    const markup = renderToStaticMarkup(<SparkyLogo aria-label="Sparky" role="img" />);

    expect(markup).toContain('fill="currentColor"');
    expect(markup).toContain('mask="url(#sparky-logo-');
    expect(markup).toMatch(/mask-type:alpha/);
    expect(markup).toContain('<image href="data:image/png;base64,');
  });
});
