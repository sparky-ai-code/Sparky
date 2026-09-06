import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vite-plus/test";

import { AuthLoadingScreen } from "./AuthSurfaceShell";

describe("AuthLoadingScreen", () => {
  it("uses the Sparky logo without exposing a visible account-loading label", () => {
    const screen = AuthLoadingScreen() as ReactElement<{
      readonly children: ReactElement<{
        readonly children: readonly [ReactElement<{ readonly alt: string; readonly src: string }>, ReactElement];
        readonly "aria-label": string;
      }>;
    }>;
    expect(isValidElement(screen)).toBe(true);

    expect(screen.props.children.props["aria-label"]).toBe("Loading Sparky");
    const image = screen.props.children.props.children[0];
    expect(image.props.alt).toBe("Sparky");
    expect(image.props.src).toContain("/sparky-logo-small.svg");
  });
});
