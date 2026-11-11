import { describe, expect, it } from "vite-plus/test";
import { selectMicroboxesInstallPlan } from "./MicroboxesInstallPlan.ts";

const available = (...names: string[]) => async (name: string) => names.includes(name);

describe("Sparky Microboxes host setup", () => {
  it("uses a fixed Windows package identifier without invoking a shell", async () => {
    const plan = await selectMicroboxesInstallPlan("windows", available("winget"));
    expect(plan?.executable).toBe("winget");
    expect(plan?.args).toContain("SoftwareFreedomConservancy.QEMU");
    expect(plan?.args).toContain("--silent");
  });

  it("supports macOS when a supported package manager is available", async () => {
    expect((await selectMicroboxesInstallPlan("macos", available("brew")))?.executable).toBe(
      "brew",
    );
  });

  it("requires an elevation mechanism for Linux installation", async () => {
    expect(await selectMicroboxesInstallPlan("linux", available("apt-get"))).toBeNull();
    expect(
      (await selectMicroboxesInstallPlan("linux", available("apt-get", "pkexec")))?.executable,
    ).toBe("pkexec");
    expect(
      (await selectMicroboxesInstallPlan("linux", available("apt-get"), true))?.executable,
    ).toBe("apt-get");
  });

  it("never tries to install components without a supported manager", async () => {
    expect(await selectMicroboxesInstallPlan("unsupported", available("winget"))).toBeNull();
    expect(await selectMicroboxesInstallPlan("windows", available())).toBeNull();
  });
});
