import { describe, expect, it } from "vite-plus/test";
import { customizationCss, DEFAULT_CUSTOMIZATION, parseCustomization } from "./customization";

describe("Sparky customization schema", () => {
  it("accepts a theme with CSS, actions and panels", () => {
    const mod = parseCustomization({
      version: 1, name: "Night Shift",
      tokens: { "--background": "#111827", "--primary": "#60a5fa", "--radius": "0.5rem" },
      css: '[data-slot="sidebar-inner"] { background: linear-gradient(#111827, #1f2937); }',
      panels: [{ id: "quick-links", title: "Work", description: "Frequent destinations",
        actions: [{ id: "prs", label: "Pull requests", kind: "url", value: "/pull-requests" },
          { id: "copy", label: "Copy note", kind: "copy", value: "hello" }] }],
    });
    expect(mod.panels[0]?.actions).toHaveLength(2);
    expect(customizationCss(mod)).toContain("--primary: #60a5fa !important;");
  });

  it("rejects network fetches, CSS escapes, and dangerous links", () => {
    for (const css of [
      '@import "https://bad.example/x.css";',
      'body{background:url(https://bad.example/track)}',
      "@font-face { font-family: spying; }",
      "body{background:u\\72l(https://bad.example)}",
      "/* hidden */ body {color: red}",
      "body { background: image-set(https://bad.example/x.png); }",
    ]) {
      expect(() => parseCustomization({ ...DEFAULT_CUSTOMIZATION, css })).toThrow();
    }
    for (const href of ["javascript:alert(1)", "file:///etc/passwd", "//evil.example",
      "/../admin", "http://example.com"]) {
      expect(() => parseCustomization({
        ...DEFAULT_CUSTOMIZATION,
        panels: [{ id: "tools", title: "Tools", description: "",
          actions: [{ id: "unsafe", label: "Unsafe", kind: "url", value: href }] }],
      })).toThrow();
    }
  });

  it("rejects invalid tokens, duplicate IDs and unsupported versions", () => {
    expect(() => parseCustomization({ ...DEFAULT_CUSTOMIZATION, version: 2 })).toThrow();
    expect(() => parseCustomization({ ...DEFAULT_CUSTOMIZATION, tokens: { "--unexpected": "red" } })).toThrow();
    expect(() => parseCustomization({ ...DEFAULT_CUSTOMIZATION, tokens: { "--primary": "red;display:none" } })).toThrow();
    expect(() => parseCustomization({
      ...DEFAULT_CUSTOMIZATION, panels: [
        { id: "same", title: "One", description: "", actions: [] },
        { id: "same", title: "Two", description: "", actions: [] },
      ],
    })).toThrow();
  });

  it("drops unrecognized fields rather than persisting arbitrary objects", () => {
    const value = parseCustomization({ ...DEFAULT_CUSTOMIZATION, injected: { admin: true } });
    expect(value).toEqual(DEFAULT_CUSTOMIZATION);
    expect("injected" in value).toBe(false);
  });

  it("enforces payload and CSS limits", () => {
    expect(() => parseCustomization({ ...DEFAULT_CUSTOMIZATION, css: "a".repeat(24_001) })).toThrow();
    expect(() => parseCustomization({ ...DEFAULT_CUSTOMIZATION, panels: new Array(9).fill({}) })).toThrow();
  });
});
