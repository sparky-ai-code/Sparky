import type { DesktopMicroboxesSetupState } from "@sparky/contracts";

type Host = DesktopMicroboxesSetupState["platform"];
type InstallPlan = { executable: string; args: readonly string[] };

/** The package manager is invoked with fixed arguments, never user input or a shell string. */
export async function selectMicroboxesInstallPlan(
  platform: Host,
  available: (executable: string) => Promise<boolean>,
  isRoot = false,
): Promise<InstallPlan | null> {
  if (platform === "windows") {
    return (await available("winget"))
      ? {
          executable: "winget",
          args: [
            "install", "--exact", "--id", "SoftwareFreedomConservancy.QEMU",
            "--source", "winget", "--silent",
            "--accept-package-agreements", "--accept-source-agreements",
            "--disable-interactivity",
          ],
        }
      : null;
  }
  if (platform === "macos") {
    return (await available("brew"))
      ? { executable: "brew", args: ["install", "qemu"] }
      : null;
  }
  if (platform !== "linux") return null;
  const managerOptions: readonly InstallPlan[] = [
    { executable: "apt-get", args: ["install", "-y", "qemu-system"] },
    { executable: "dnf", args: ["install", "-y", "qemu-system-x86"] },
    { executable: "pacman", args: ["-S", "--noconfirm", "qemu-system-x86", "qemu-system-aarch64"] },
    { executable: "zypper", args: ["--non-interactive", "install", "qemu"] },
  ];
  for (const plan of managerOptions) {
    if (!(await available(plan.executable))) continue;
    if (isRoot) return plan;
    if (await available("pkexec")) {
      return { executable: "pkexec", args: [plan.executable, ...plan.args] };
    }
    return null;
  }
  return null;
}

