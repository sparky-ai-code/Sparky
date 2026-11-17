import { describe, expect, it } from "vite-plus/test";
import {
  buildSandboxedPresentationHtml,
  isAuthoredDocumentFile,
  isAuthoredPresentationFile,
  makeArtifactDraft,
} from "./artifactFiles";

describe("document and presentation artifacts", () => {
  it("recognizes authored files, not generic project files", () => {
    expect(isAuthoredDocumentFile("sparky-artifacts/documents/notes.md")).toBe(true);
    expect(isAuthoredDocumentFile("draft.document.md")).toBe(true);
    expect(isAuthoredDocumentFile("README.md")).toBe(false);
    expect(isAuthoredPresentationFile("sparky-artifacts/presentations/intro.slides.html")).toBe(true);
    expect(isAuthoredPresentationFile("deck.slides.html")).toBe(true);
    expect(isAuthoredPresentationFile("site.html")).toBe(false);
  });

  it("creates uniquely named, editable workspace sources", () => {
    const document = makeArtifactDraft("document", "Hello../World");
    expect(document.relativePath).toBe("sparky-artifacts/documents/helloworld.md");
    expect(document.contents).toContain("# Untitled document");
    const slides = makeArtifactDraft("presentation", "Kickoff-123");
    expect(slides.relativePath).toBe("sparky-artifacts/presentations/kickoff-123.slides.html");
    expect(slides.contents).toContain('<section class="slide"');
    expect(slides.contents).toContain("<style>");
    expect(slides.contents).not.toContain("<script");
  });

  it("applies restrictive CSP before untrusted slide markup", () => {
    const preview = buildSandboxedPresentationHtml(
      '<script>alert("x")</script><img src="https://example.com/pixel">',
    );
    expect(preview.indexOf("Content-Security-Policy")).toBeLessThan(preview.indexOf("<script>"));
    expect(preview).toContain("default-src 'none'");
    expect(preview).toContain("connect-src 'none'");
    expect(preview).toContain("img-src data:");
    expect(preview).toContain("style-src 'unsafe-inline'");
  });
});
