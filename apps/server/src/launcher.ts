// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off - Standalone npm launcher runs outside the Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFileSystemSync from "node:fs";
import * as NodeFileSystem from "node:fs/promises";
import { createRequire } from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { rcedit } from "rcedit";

const PACKAGE_ROOT = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const PACKAGE_JSON = NodePath.join(PACKAGE_ROOT, "..", "package.json");
const SERVER_ENTRY = NodePath.join(PACKAGE_ROOT, "bin.mjs");
const DESKTOP_ENTRY = NodePath.join(PACKAGE_ROOT, "desktop", "dist-electron", "main.cjs");
const SPARKY_BINARY_NAME = process.platform === "win32" ? "sparky.exe" : "sparky";
const STAGED_SPARKY_BINARY = NodePath.join(
  PACKAGE_ROOT,
  "desktop",
  "resources",
  "sparky",
  SPARKY_BINARY_NAME,
);
const SPARKY_RUNTIME_NAME = process.platform === "win32" ? "Sparky.exe" : "Sparky";
const DEFAULT_HOME_NAME = ".Sparky";
const LEGACY_DESKTOP_HOME_NAME = ".sparky-desktop";
const LEGACY_HOME_NAME = ".t3";
const LAUNCHER_VERSION = 1;

export const SPARKY_HOME_ENV = "SPARKY_HOME";
export const LEGACY_HOME_ENV = "T3CODE_HOME";

export const SPARKY_DIRECTORIES = [
  "userdata",
  "userdata/logs",
  "userdata/logs/provider",
  "userdata/logs/terminals",
  "userdata/attachments",
  "userdata/secrets",
  "caches",
  "worktrees",
  "memory",
  "launcher",
] as const;

export interface LauncherLayout {
  readonly homeDir: string;
  readonly stateDir: string;
  readonly databasePath: string;
  readonly logsDir: string;
  readonly attachmentsDir: string;
  readonly worktreesDir: string;
  readonly secretsDir: string;
  readonly launcherDir: string;
  readonly manifestPath: string;
  readonly windowsScriptPath: string;
  readonly iconPath: string;
}

export function resolveSparkyHome(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = NodeOS.homedir(),
): string {
  const configured = environment[SPARKY_HOME_ENV]?.trim() || environment[LEGACY_HOME_ENV]?.trim();
  if (configured) {
    return NodePath.resolve(configured);
  }

  const sparkyHome = NodePath.join(homeDirectory, DEFAULT_HOME_NAME);
  const legacyDesktopHome = NodePath.join(homeDirectory, LEGACY_DESKTOP_HOME_NAME);
  const legacyHome = NodePath.join(homeDirectory, LEGACY_HOME_NAME);
  const hasState = (home: string): boolean =>
    [NodePath.join(home, "userdata", "state.sqlite"), NodePath.join(home, "dev", "state.sqlite")].some(
      (statePath) => NodeFileSystemSync.existsSync(statePath),
    );
  const sparkyHasState = hasState(sparkyHome);
  const legacyDesktopHasState = hasState(legacyDesktopHome);
  const legacyHasState = hasState(legacyHome);

  // Keep existing T3/Sparky installations usable without copying or deleting
  // their databases. The old packaged desktop used .sparky-desktop, which is
  // preferred over the older .t3 compatibility home when both are present.
  if (!sparkyHasState && legacyDesktopHasState) return legacyDesktopHome;
  if (!sparkyHasState && legacyHasState) return legacyHome;
  return sparkyHome;
}

export function resolveLauncherLayout(homeDir: string): LauncherLayout {
  const resolvedHome = NodePath.resolve(homeDir);
  return {
    homeDir: resolvedHome,
    stateDir: NodePath.join(resolvedHome, "userdata"),
    databasePath: NodePath.join(resolvedHome, "userdata", "state.sqlite"),
    logsDir: NodePath.join(resolvedHome, "userdata", "logs"),
    attachmentsDir: NodePath.join(resolvedHome, "userdata", "attachments"),
    worktreesDir: NodePath.join(resolvedHome, "worktrees"),
    secretsDir: NodePath.join(resolvedHome, "userdata", "secrets"),
    launcherDir: NodePath.join(resolvedHome, "launcher"),
    manifestPath: NodePath.join(resolvedHome, "launcher", "manifest.json"),
    windowsScriptPath: NodePath.join(resolvedHome, "launcher", "start-sparky.vbs"),
    iconPath: NodePath.join(PACKAGE_ROOT, "sparky.ico"),
  };
}

export function buildLauncherEnvironment(
  homeDir: string,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    [SPARKY_HOME_ENV]: homeDir,
    // The server still reads the legacy variable in a number of integrations;
    // setting both keeps the npm launcher and existing provider tooling aligned.
    [LEGACY_HOME_ENV]: homeDir,
    SPARKY_BINARY_PATH: STAGED_SPARKY_BINARY,
    T3CODE_MODE: "desktop",
    T3CODE_NO_BROWSER: "true",
    T3CODE_HOST: "127.0.0.1",
    T3CODE_DESKTOP_APP_ROOT: NodePath.dirname(PACKAGE_JSON),
    T3CODE_DESKTOP_BACKEND_ENTRY: SERVER_ENTRY,
    T3CODE_DESKTOP_BACKEND_CWD: PACKAGE_ROOT,
  };
}

async function ensureSparkyRuntime(): Promise<string> {
  let electronBinary: string;
  try {
    electronBinary = createRequire(import.meta.url)("electron") as string;
  } catch (error) {
    throw new Error(
      `The Sparky desktop runtime is not installed. Reinstall the package with npm install so Electron can be downloaded. ${String(error)}`,
    );
  }
  if (process.platform !== "win32") {
    return electronBinary;
  }

  const sparkyBinary = NodePath.join(NodePath.dirname(electronBinary), SPARKY_RUNTIME_NAME);
  // Electron's native runtime is kept beside its DLLs. A same-directory
  // Sparky.exe preserves that layout while giving Windows the product's
  // executable identity instead of electron.exe. Refresh it on each launch
  // so an npm update cannot leave an older runtime behind.
  await NodeFileSystem.copyFile(electronBinary, sparkyBinary);
  await rcedit(sparkyBinary, {
    "version-string": {
      CompanyName: "Sparky LLC",
      FileDescription: "Sparky",
      InternalFilename: "Sparky.exe",
      OriginalFilename: "Sparky.exe",
      ProductName: "Sparky",
    },
  });
  return sparkyBinary;
}

async function createLayout(homeDir: string): Promise<LauncherLayout> {
  const layout = resolveLauncherLayout(homeDir);
  await Promise.all(
    SPARKY_DIRECTORIES.map((directory) =>
      NodeFileSystem.mkdir(NodePath.join(layout.homeDir, directory), { recursive: true }),
    ),
  );

  try {
    await NodeFileSystem.access(layout.manifestPath);
  } catch {
    await NodeFileSystem.writeFile(
      layout.manifestPath,
      `${JSON.stringify(
        {
          formatVersion: LAUNCHER_VERSION,
          product: "Sparky",
          homeDir: layout.homeDir,
          stateDir: layout.stateDir,
          databasePath: layout.databasePath,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  return layout;
}

async function resolveWindowsDesktopDirectory(): Promise<string> {
  const candidates = [
    process.env.DESKTOP,
    process.env.USERPROFILE ? NodePath.join(process.env.USERPROFILE, "Desktop") : undefined,
    process.env.OneDrive ? NodePath.join(process.env.OneDrive, "Desktop") : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      await NodeFileSystem.access(candidate);
      return candidate;
    } catch {
      // Try the next conventional desktop location.
    }
  }

  const fallback = NodePath.join(NodeOS.homedir(), "Desktop");
  await NodeFileSystem.mkdir(fallback, { recursive: true });
  return fallback;
}

function encodePowerShellValue(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

async function createWindowsShortcut(layout: LauncherLayout): Promise<string> {
  const desktopDir = await resolveWindowsDesktopDirectory();
  const desktopShortcutPath = NodePath.join(desktopDir, "Sparky.lnk");
  const shortcutPaths = [desktopShortcutPath];
  const startMenuDir = process.env.APPDATA
    ? NodePath.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs")
    : undefined;
  if (startMenuDir && NodePath.resolve(startMenuDir) !== NodePath.resolve(desktopDir)) {
    await NodeFileSystem.mkdir(startMenuDir, { recursive: true });
    shortcutPaths.push(NodePath.join(startMenuDir, "Sparky.lnk"));
  }
  const launcherPath = NodePath.join(PACKAGE_ROOT, "launcher.mjs");
  const wscriptPath = NodePath.join(process.env.WINDIR || "C:\\Windows", "System32", "wscript.exe");
  const quoteVbs = (value: string) => value.replaceAll('"', '""');
  const vbs = [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Environment("PROCESS")("SPARKY_HOME") = "${quoteVbs(layout.homeDir)}"`,
    `shell.Run """${quoteVbs(process.execPath)}"" ""${quoteVbs(launcherPath)}"" start", 0, False`,
    "",
  ].join("\r\n");
  await NodeFileSystem.writeFile(
    layout.windowsScriptPath,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(vbs, "utf16le")]),
  );
  const createShortcutScript = (shortcutPath: string) => {
    const values = [
      shortcutPath,
      wscriptPath,
      layout.windowsScriptPath,
      layout.iconPath,
    ].map(encodePowerShellValue);
    return `
function Decode([string] $value) {
  [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value))
}
$shortcutPath = Decode '${values[0]}'
$wscriptPath = Decode '${values[1]}'
$windowsScriptPath = Decode '${values[2]}'
$iconPath = Decode '${values[3]}'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $wscriptPath
$shortcut.Arguments = ('"' + $windowsScriptPath + '"')
$shortcut.WorkingDirectory = Decode '${encodePowerShellValue(layout.homeDir)}'
$shortcut.IconLocation = $iconPath
$shortcut.Description = 'Launch Sparky'
$shortcut.Save()
`;
  };
  const powershellPath = process.env.POWERSHELL_EXE ||
    (process.env.SystemRoot
      ? NodePath.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe");
  for (const shortcutPath of shortcutPaths) {
    const encodedScript = Buffer.from(createShortcutScript(shortcutPath), "utf16le").toString("base64");
    const result = NodeChildProcess.spawnSync(
      powershellPath,
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript],
      { encoding: "utf8", windowsHide: true },
    );
    if (result.status !== 0) {
      throw new Error(`Could not create the Windows shortcut: ${result.stderr || "PowerShell failed."}`);
    }
  }
  return desktopShortcutPath;
}

async function createPosixShortcut(layout: LauncherLayout): Promise<string> {
  const launcherPath = NodePath.join(PACKAGE_ROOT, "launcher.mjs");
  if (process.platform === "linux") {
    const applicationsDir = NodePath.join(NodeOS.homedir(), ".local", "share", "applications");
    await NodeFileSystem.mkdir(applicationsDir, { recursive: true });
    const desktopEntryPath = NodePath.join(applicationsDir, "sparky.desktop");
    const desktopEntry = [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Sparky",
      `Exec=${process.execPath} ${launcherPath} start`,
      `Path=${layout.homeDir}`,
      `Icon=${layout.iconPath.replace(/\.ico$/iu, ".png")}`,
      "Terminal=false",
      "Categories=Development;Utility;",
      "",
    ].join("\n");
    await NodeFileSystem.writeFile(desktopEntryPath, desktopEntry, { mode: 0o755 });
    return desktopEntryPath;
  }

  const shortcutPath = NodePath.join(NodeOS.homedir(), "Desktop", "Sparky.command");
  await NodeFileSystem.mkdir(NodePath.dirname(shortcutPath), { recursive: true });
  await NodeFileSystem.writeFile(
    shortcutPath,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(launcherPath)} start\n`,
    { mode: 0o755 },
  );
  await NodeFileSystem.chmod(shortcutPath, 0o755);
  return shortcutPath;
}

async function createShortcut(layout: LauncherLayout): Promise<string> {
  if (process.platform === "win32") return createWindowsShortcut(layout);
  return createPosixShortcut(layout);
}

async function startDesktop(args: readonly string[], homeDir: string): Promise<never> {
  await NodeFileSystem.access(DESKTOP_ENTRY);
  const child = NodeChildProcess.spawn(await ensureSparkyRuntime(), [DESKTOP_ENTRY, ...args], {
    cwd: PACKAGE_ROOT,
    env: buildLauncherEnvironment(homeDir),
    stdio: "inherit",
    // The VBS desktop shortcut intentionally hides the Node launcher process.
    // Do not propagate that hidden startup state to Electron, or Windows will
    // create a real Sparky window that is itself invisible.
    windowsHide: false,
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Sparky desktop stopped with signal ${signal}.`));
      else process.exitCode = code ?? 1;
      resolve();
    });
  });
  process.exit(process.exitCode ?? 0);
}

async function main(): Promise<void> {
  const [command = "start", ...args] = process.argv.slice(2);
  const homeDir = resolveSparkyHome();
  const layout = await createLayout(homeDir);

  if (command === "setup" || command === "install") {
    const shortcutPath = await createShortcut(layout);
    console.log(`Sparky home: ${layout.homeDir}`);
    console.log(`Desktop shortcut: ${shortcutPath}`);
    return;
  }

  if (command === "doctor") {
    console.log(
      JSON.stringify(
        {
          node: process.version,
          platform: process.platform,
          homeDir: layout.homeDir,
          databasePath: layout.databasePath,
          serverEntry: SERVER_ENTRY,
          serverEntryExists: await NodeFileSystem
            .access(SERVER_ENTRY)
            .then(() => true)
            .catch(() => false),
          desktopEntry: DESKTOP_ENTRY,
          desktopEntryExists: await NodeFileSystem
            .access(DESKTOP_ENTRY)
            .then(() => true)
            .catch(() => false),
        },
        null,
        2,
      ),
    );
    return;
  }

  await startDesktop(args, homeDir);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
