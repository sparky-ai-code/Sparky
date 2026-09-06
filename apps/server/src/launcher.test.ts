// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFileSystem from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  buildLauncherEnvironment,
  resolveLauncherLayout,
  resolveSparkyHome,
  SPARKY_DIRECTORIES,
} from "./launcher.ts";

describe("Sparky npm launcher", () => {
  it("uses SPARKY_HOME before the legacy T3CODE_HOME variable", () => {
    expect(
      resolveSparkyHome(
        {
          SPARKY_HOME: "C:\\Users\\test\\.Sparky",
          T3CODE_HOME: "C:\\Users\\test\\.t3",
        },
        "C:\\Users\\test",
      ),
    ).toBe("C:\\Users\\test\\.Sparky");
  });

  it("defaults new launcher installs to a user .Sparky directory", () => {
    expect(resolveSparkyHome({}, "C:\\Users\\test")).toBe("C:\\Users\\test\\.Sparky");
  });

  it("reuses an existing legacy .t3 home until .Sparky has its own state", () => {
    const testRoot = NodeFileSystem.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sparky-launcher-"));
    const legacyStatePath = NodePath.join(testRoot, ".t3", "userdata", "state.sqlite");
    NodeFileSystem.mkdirSync(NodePath.dirname(legacyStatePath), { recursive: true });
    NodeFileSystem.writeFileSync(legacyStatePath, "legacy-state");

    try {
      expect(resolveSparkyHome({}, testRoot)).toBe(NodePath.join(testRoot, ".t3"));
    } finally {
      NodeFileSystem.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("matches the server's persistent state layout", () => {
    const layout = resolveLauncherLayout("C:\\Users\\test\\.Sparky");

    expect(layout.stateDir).toBe("C:\\Users\\test\\.Sparky\\userdata");
    expect(layout.databasePath).toBe("C:\\Users\\test\\.Sparky\\userdata\\state.sqlite");
    expect(layout.logsDir).toBe("C:\\Users\\test\\.Sparky\\userdata\\logs");
    expect(layout.attachmentsDir).toBe("C:\\Users\\test\\.Sparky\\userdata\\attachments");
    expect(layout.secretsDir).toBe("C:\\Users\\test\\.Sparky\\userdata\\secrets");
    expect(SPARKY_DIRECTORIES).toContain("userdata/logs/provider");
    expect(SPARKY_DIRECTORIES).toContain("userdata/logs/terminals");
  });

  it("sets both new and legacy home variables for provider compatibility", () => {
    const environment = buildLauncherEnvironment("C:\\Users\\test\\.Sparky", {
      PATH: "test-path",
    });

    expect(environment.SPARKY_HOME).toBe("C:\\Users\\test\\.Sparky");
    expect(environment.T3CODE_HOME).toBe("C:\\Users\\test\\.Sparky");
    expect(environment.T3CODE_MODE).toBe("desktop");
    expect(environment.T3CODE_NO_BROWSER).toBe("true");
    expect(environment.T3CODE_HOST).toBe("127.0.0.1");
    expect(environment.T3CODE_DESKTOP_BACKEND_ENTRY).toContain("bin.mjs");
    expect(environment.T3CODE_DESKTOP_BACKEND_CWD).toContain("server");
    expect(environment.PATH).toBe("test-path");
  });
});
