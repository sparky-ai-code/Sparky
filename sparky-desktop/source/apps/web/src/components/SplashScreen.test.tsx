import { isValidElement, type ReactElement, type SVGProps } from "react";
import { describe, expect, it } from "vite-plus/test";

import { SparkyLogo } from "./SparkyLogo";
import { SplashScreen } from "./SplashScreen";

describe("SplashScreen", () => {
  it("uses the colorable logo with the foreground color", () => {
    const screen = SplashScreen() as ReactElement<{
      readonly children: ReactElement<{
        readonly children: ReactElement<SVGProps<SVGSVGElement>>;
      }>;
    }>;
    expect(isValidElement(screen)).toBe(true);

    const logo = screen.props.children.props.children;
    expect(logo.type).toBe(SparkyLogo);
    expect(logo.props.className).toContain("text-foreground");
  });
});
