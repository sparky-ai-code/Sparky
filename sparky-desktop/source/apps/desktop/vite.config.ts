import { defineConfig } from "vite-plus";

const shouldLaunchElectronAfterPack = process.env.T3CODE_DESKTOP_DEV === "1";

// These values are public OAuth application configuration. Keep the checked-in
// defaults so every packaged desktop build carries the production GitHub auth
// wiring even when a local or ad-hoc build omits environment variables.
const githubClientId =
  process.env.SPARKY_GITHUB_CLIENT_ID?.trim() ||
  process.env.SPARKY_GITHUB_OAUTH_CLIENT_ID?.trim() ||
  "Ov23liBxKhYYRLs19Fs9";
const githubAuthBrokerUrl =
  process.env.SPARKY_GITHUB_AUTH_BROKER_URL?.trim() || "https://auth.sparky.llc";
const githubBuildDefine = {
  __SPARKY_GITHUB_CLIENT_ID__: JSON.stringify(githubClientId),
  __SPARKY_GITHUB_AUTH_BROKER_URL__: JSON.stringify(githubAuthBrokerUrl),
};

export default defineConfig({
  // Keep these available to Vite development builds as well as the pack
  // entries below. The packer does not inherit this field automatically.
  define: githubBuildDefine,
  run: {
    tasks: {
      build: {
        command: "node scripts/build-preview-annotation-css.mjs && vp pack",
        dependsOn: ["t3#build"],
        cache: false,
      },
      dev: {
        command:
          "node scripts/build-preview-annotation-css.mjs && cross-env T3CODE_DESKTOP_DEV=1 vp pack --watch",
        dependsOn: ["t3#build"],
        cache: false,
      },
      "dev:bundle": {
        command: "node scripts/build-preview-annotation-css.mjs && vp pack --watch",
        cache: false,
      },
      "dev:electron": {
        command: "node scripts/dev-electron.mjs",
        dependsOn: ["t3#build"],
        cache: false,
      },
    },
  },
  pack: [
    {
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/main.ts"],
      clean: true,
      define: githubBuildDefine,
      deps: {
        alwaysBundle: (id) => id.startsWith("@sparky/"),
      },
      ...(shouldLaunchElectronAfterPack ? { onSuccess: "node scripts/dev-electron.mjs" } : {}),
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/preload.ts"],
      define: githubBuildDefine,
    },
    {
      format: "cjs",
      outDir: "dist-electron",
      sourcemap: true,
      outExtensions: () => ({ js: ".cjs" }),
      entry: ["src/preview-pick-preload.ts"],
      define: githubBuildDefine,
      deps: {
        alwaysBundle: (id) => id === "react-grab" || id.startsWith("react-grab/"),
      },
    },
  ],
});
