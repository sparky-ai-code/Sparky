#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  DEVELOPMENT_ICON_OVERRIDES,
  PUBLISH_ICON_OVERRIDES,
} from "../../../scripts/lib/brand-assets.ts";
import { resolveCatalogDependencies } from "../../../scripts/lib/resolve-catalog.ts";
import { fromJsonStringPretty } from "@sparky/shared/schemaJson";
import { fromYaml } from "@sparky/shared/schemaYaml";
import { resolveSpawnCommand } from "@sparky/shared/shell";
import serverPackageJson from "../package.json" with { type: "json" };
import {
  ServerCliBuildAssetMissingError,
  ServerCliCommandExitError,
  ServerCliDevelopmentIconSourceMissingError,
  ServerCliDevelopmentIconTargetMissingError,
  ServerCliPublishIconSourceMissingError,
  ServerCliPublishIconTargetMissingError,
} from "./cliErrors.ts";

interface PackageJson {
  name: string;
  repository?: {
    type: string;
    url: string;
    directory: string;
  };
  bin: Record<string, string>;
  type: string;
  version: string;
  engines: Record<string, string>;
  files: string[];
  scripts?: Record<string, string>;
  dependencies: Record<string, string>;
  overrides: Record<string, string>;
}

const PUBLISHED_PACKAGE_NAME = "sparky-desktop";

const PackageJsonPrettyJson = fromJsonStringPretty(Schema.Unknown);
const encodePackageJson = Schema.encodeEffect(PackageJsonPrettyJson);

const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
type WorkspaceConfig = typeof WorkspaceConfig.Type;
const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("../../..", import.meta.url))),
);

const readWorkspaceConfig = Effect.fn("readWorkspaceConfig")(function* () {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const repoRoot = yield* RepoRoot;
  const workspaceYaml = yield* fs.readFileString(path.join(repoRoot, "pnpm-workspace.yaml"));
  return yield* decodeWorkspaceConfig(workspaceYaml);
});

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.StandardCommand) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new ServerCliCommandExitError({
      command: command.command,
      args: command.args,
      cwd: command.options.cwd,
      exitCode,
    });
  }
});

interface PublishIconBackup {
  readonly targetPath: string;
  readonly backupPath: string;
}

const applyPublishIconOverrides = Effect.fn("applyPublishIconOverrides")(function* (
  repoRoot: string,
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const backups: PublishIconBackup[] = [];

  for (const override of PUBLISH_ICON_OVERRIDES) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(serverDir, override.targetRelativePath);
    const backupPath = `${targetPath}.publish-bak`;

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new ServerCliPublishIconSourceMissingError({ sourcePath });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new ServerCliPublishIconTargetMissingError({ targetPath });
    }

    yield* fs.copyFile(targetPath, backupPath);
    yield* fs.copyFile(sourcePath, targetPath);
    backups.push({ targetPath, backupPath });
  }

  yield* Effect.log("[cli] Applied publish icon overrides to dist/client");
  return backups as ReadonlyArray<PublishIconBackup>;
});

const restorePublishIconOverrides = Effect.fn("restorePublishIconOverrides")(function* (
  backups: ReadonlyArray<PublishIconBackup>,
) {
  const fs = yield* FileSystem.FileSystem;
  for (const backup of backups) {
    if (!(yield* fs.exists(backup.backupPath))) {
      continue;
    }
    yield* fs.rename(backup.backupPath, backup.targetPath);
  }
});

const applyDevelopmentIconOverrides = Effect.fn("applyDevelopmentIconOverrides")(function* (
  repoRoot: string,
  serverDir: string,
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  for (const override of DEVELOPMENT_ICON_OVERRIDES) {
    const sourcePath = path.join(repoRoot, override.sourceRelativePath);
    const targetPath = path.join(serverDir, override.targetRelativePath);

    if (!(yield* fs.exists(sourcePath))) {
      return yield* new ServerCliDevelopmentIconSourceMissingError({ sourcePath });
    }
    if (!(yield* fs.exists(targetPath))) {
      return yield* new ServerCliDevelopmentIconTargetMissingError({ targetPath });
    }

    yield* fs.copyFile(sourcePath, targetPath);
  }

  yield* Effect.log("[cli] Applied development icon overrides to dist/client");
});

// ---------------------------------------------------------------------------
// build subcommand
// ---------------------------------------------------------------------------

const buildCmd = Command.make(
  "build",
  {
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");

      yield* Effect.log("[cli] Running tsdown...");
      yield* runCommand(
        ChildProcess.make(process.execPath, ["--run", "build:bundle"], {
          cwd: serverDir,
          stdout: config.verbose ? "inherit" : "ignore",
          stderr: "inherit",
          shell: false,
        }),
      );

      const webDist = path.join(repoRoot, "apps/web/dist");
      const clientTarget = path.join(serverDir, "dist/client");

      if (yield* fs.exists(webDist)) {
        yield* fs.copy(webDist, clientTarget);
        yield* applyDevelopmentIconOverrides(repoRoot, serverDir);
        yield* Effect.log("[cli] Bundled web app into dist/client");
      } else {
        yield* Effect.logWarning("[cli] Web dist not found — skipping client bundle.");
      }

      for (const [sourceRelativePath, targetRelativePath] of [
        ["apps/desktop/resources/icon.ico", "apps/server/dist/sparky.ico"],
        ["apps/desktop/resources/icon.png", "apps/server/dist/sparky.png"],
      ] as const) {
        const sourcePath = path.join(repoRoot, sourceRelativePath);
        const targetPath = path.join(repoRoot, targetRelativePath);
        if (yield* fs.exists(sourcePath)) {
          yield* fs.copyFile(sourcePath, targetPath);
          yield* Effect.log(`[cli] Copied launcher icon to ${targetRelativePath}`);
        }
      }
    }),
).pipe(Command.withDescription("Build the server package (tsdown + bundle web client)."));

// ---------------------------------------------------------------------------
// stage desktop runtime subcommand
// ---------------------------------------------------------------------------

const stageDesktopRuntimeCmd = Command.make("stage-desktop-runtime", {}, () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const repoRoot = yield* RepoRoot;
    const desktopDir = path.join(repoRoot, "apps/desktop");
    const serverDir = path.join(repoRoot, "apps/server");
    const desktopDist = path.join(desktopDir, "dist-electron");
    const desktopResources = path.join(desktopDir, "resources");
    const stagedDesktopDir = path.join(serverDir, "dist/desktop");
    const sparkyExecutable = process.platform === "win32" ? "sparky.exe" : "sparky";
    const sparkyBinaryCandidates = [
      path.join(repoRoot, "target", "release", sparkyExecutable),
      path.resolve(repoRoot, "..", "..", "target", "release", sparkyExecutable),
    ];
    let sparkyBinary = sparkyBinaryCandidates[0]!;
    for (const candidate of sparkyBinaryCandidates) {
      if (yield* fs.exists(candidate)) {
        sparkyBinary = candidate;
        break;
      }
    }

    for (const sourcePath of [desktopDist, desktopResources]) {
      if (!(yield* fs.exists(sourcePath))) {
        return yield* new ServerCliBuildAssetMissingError({ assetPath: sourcePath });
      }
    }

    yield* fs.remove(stagedDesktopDir, { recursive: true, force: true });
    yield* fs.makeDirectory(stagedDesktopDir, { recursive: true });
    yield* fs.copy(desktopDist, path.join(stagedDesktopDir, "dist-electron"));
    yield* fs.copy(desktopResources, path.join(stagedDesktopDir, "resources"));
    if (!(yield* fs.exists(sparkyBinary))) {
      return yield* new ServerCliBuildAssetMissingError({
        assetPath: sparkyBinaryCandidates.join(" or "),
      });
    }
    const stagedSparkyDir = path.join(stagedDesktopDir, "resources", "sparky");
    yield* fs.makeDirectory(stagedSparkyDir, { recursive: true });
    yield* fs.copyFile(sparkyBinary, path.join(stagedSparkyDir, sparkyExecutable));
    yield* Effect.log("[cli] Staged native Electron runtime into the npm package.");
  }),
).pipe(Command.withDescription("Stage the native Electron desktop runtime into the npm package."));

// ---------------------------------------------------------------------------
// publish subcommand
// ---------------------------------------------------------------------------

interface PublishCommandConfig {
  readonly access: string;
  readonly tag: string;
  readonly provenance: boolean;
  readonly dryRun: boolean;
}

const createVpPmPublishArgs = (config: PublishCommandConfig): ReadonlyArray<string> => {
  const args = [
    "publish",
    "--filter",
    "./apps/server",
    "--access",
    config.access,
    "--tag",
    config.tag,
    "--no-git-checks",
  ];

  if (config.provenance) args.push("--provenance");
  if (config.dryRun) args.push("--dry-run");

  return args;
};

const publishCmd = Command.make(
  "publish",
  {
    tag: Flag.string("tag").pipe(Flag.withDefault("latest")),
    access: Flag.string("access").pipe(Flag.withDefault("public")),
    appVersion: Flag.string("app-version").pipe(Flag.optional),
    provenance: Flag.boolean("provenance").pipe(Flag.withDefault(false)),
    dryRun: Flag.boolean("dry-run").pipe(Flag.withDefault(false)),
    verbose: Flag.boolean("verbose").pipe(Flag.withDefault(false)),
  },
  (config) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const repoRoot = yield* RepoRoot;
      const serverDir = path.join(repoRoot, "apps/server");
      const packageJsonPath = path.join(serverDir, "package.json");
      const backupPath = `${packageJsonPath}.bak`;

      // Assert build assets exist
      for (const relPath of [
        "dist/bin.mjs",
        "dist/launcher.mjs",
        "dist/client/index.html",
        "dist/sparky.ico",
        "dist/desktop/dist-electron/main.cjs",
        "dist/desktop/dist-electron/preload.cjs",
        "dist/desktop/resources/icon.ico",
        `dist/desktop/resources/sparky/${process.platform === "win32" ? "sparky.exe" : "sparky"}`,
      ]) {
        const abs = path.join(serverDir, relPath);
        if (!(yield* fs.exists(abs))) {
          return yield* new ServerCliBuildAssetMissingError({ assetPath: abs });
        }
      }

      yield* Effect.acquireUseRelease(
        // Acquire: backup package.json, resolve catalog dependencies, and strip devDependencies/scripts
        Effect.gen(function* () {
          const version = Option.getOrElse(config.appVersion, () => serverPackageJson.version);
          const workspaceConfig = yield* readWorkspaceConfig();
          const workspaceCatalog = workspaceConfig.catalog ?? {};
          const workspaceOverrides = workspaceConfig.overrides ?? {};
          const pkg: PackageJson = {
            name: PUBLISHED_PACKAGE_NAME,
            bin: serverPackageJson.bin,
            type: serverPackageJson.type,
            version,
            engines: serverPackageJson.engines,
            files: serverPackageJson.files,
            scripts: {
              // A global npm install is the product's installation flow. The
              // package creates the same shortcut as `sparky install` so the
              // user never has to manage a second setup step.
              postinstall: "node dist/launcher.mjs install",
            },
            dependencies: resolveCatalogDependencies(
              serverPackageJson.dependencies,
              workspaceCatalog,
              "apps/server",
            ),
            overrides: resolveCatalogDependencies(
              workspaceOverrides,
              workspaceCatalog,
              "apps/server",
            ),
          };

          const original = yield* fs.readFileString(packageJsonPath);
          const packageJsonString = yield* encodePackageJson(pkg);
          yield* fs.writeFileString(backupPath, original);
          yield* fs.writeFileString(packageJsonPath, `${packageJsonString}\n`);
          yield* Effect.log("[cli] Prepared package.json for publish");

          const iconBackups = yield* applyPublishIconOverrides(repoRoot, serverDir);
          return { iconBackups };
        }),
        // Use: pnpm publish from the workspace root so pnpm-only workspace
        // config, including override selectors, is interpreted correctly.
        () =>
          Effect.gen(function* () {
            const args = createVpPmPublishArgs(config);
            const vpBinary = path.join(
              repoRoot,
              "node_modules",
              ".bin",
              process.platform === "win32" ? "vp.cmd" : "vp",
            );
            const spawnCommand = yield* resolveSpawnCommand(vpBinary, ["pm", ...args]);

            yield* Effect.log(`[cli] Running: ${vpBinary} pm ${args.join(" ")}`);
            yield* runCommand(
              ChildProcess.make(spawnCommand.command, spawnCommand.args, {
                cwd: repoRoot,
                stdout: config.verbose ? "inherit" : "ignore",
                stderr: "inherit",
                shell: spawnCommand.shell,
              }),
            );
          }),
        // Release: restore
        (resource: { readonly iconBackups: ReadonlyArray<PublishIconBackup> }) =>
          Effect.gen(function* () {
            yield* restorePublishIconOverrides(resource.iconBackups).pipe(
              Effect.catch((error) =>
                Effect.logError(`[cli] Failed to restore publish icon overrides: ${String(error)}`),
              ),
            );
            yield* fs.rename(backupPath, packageJsonPath);
            if (config.verbose) yield* Effect.log("[cli] Restored original package.json");
          }),
      );
    }),
).pipe(Command.withDescription("Publish the server package to npm."));

// ---------------------------------------------------------------------------
// root command
// ---------------------------------------------------------------------------

const cli = Command.make("cli").pipe(
  Command.withDescription("T3 server build & publish CLI."),
  Command.withSubcommands([buildCmd, stageDesktopRuntimeCmd, publishCmd]),
);

Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.scoped,
  Effect.provide([Logger.layer([Logger.consolePretty()]), NodeServices.layer]),
  NodeRuntime.runMain,
);
