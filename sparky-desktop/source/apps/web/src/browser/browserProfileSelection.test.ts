import { describe, expect, it } from "vite-plus/test";

import { browserProfilePartition } from "./browserProfileSelection";

const partitions = {
  partition: "persist:t3code-preview-a4d26868017c0ccffe2e",
  temporaryPartition: "t3code-preview-temporary",
};

describe("browserProfilePartition", () => {
  it("selects the disk-backed profile when enabled", () => {
    expect(browserProfilePartition(partitions, true)).toBe(partitions.partition);
    expect(browserProfilePartition(partitions, true).startsWith("persist:")).toBe(true);
  });

  it("selects an in-memory profile when disabled", () => {
    expect(browserProfilePartition(partitions, false)).toBe(partitions.temporaryPartition);
    expect(browserProfilePartition(partitions, false).startsWith("persist:")).toBe(false);
  });

  it("restores the original persistent profile after being re-enabled", () => {
    const disabled = browserProfilePartition(partitions, false);
    const enabled = browserProfilePartition(partitions, true);
    expect(disabled).not.toBe(enabled);
    expect(enabled).toBe(partitions.partition);
  });
});
