import assert from "node:assert/strict";
import { test } from "node:test";

import worker, { handleRequest, releaseConfig, requestedPlatform, updateRequest, validateManifest } from "./index.js";

const env = {
  AWS_RELEASE_BASE_URL: "https://downloads.example.test/releases/0.0.28/",
  AWS_WINDOWS_BASE_URL: "https://downloads.example.test/releases/0.0.28/windows/",
  AWS_MAC_ARM64_BASE_URL: "https://downloads.example.test/releases/0.0.28/macos/arm64/",
  AWS_MAC_X64_BASE_URL: "https://downloads.example.test/releases/0.0.28/macos/x64/",
  AWS_LINUX_BASE_URL: "https://downloads.example.test/releases/0.0.28/linux/",
  RELEASE_VERSION: "0.0.28",
  RELEASE_PUBLISHED_AT: "2026-07-28T10:57:02.310Z",
  RELEASE_CHANGELOG: "Launch build",
  RELEASE_WINDOWS_SIZE: "342384168",
  RELEASE_WINDOWS_SHA256: "C308C3C15654976B65E239D8820A603488193E547A653A7121DC639F516C276A",
  RELEASE_MAC_ARM64_SIZE: "211000000",
  RELEASE_MAC_ARM64_SHA256: "ARM64HASH",
  RELEASE_MAC_X64_SIZE: "214000000",
  RELEASE_MAC_X64_SHA256: "X64HASH",
  RELEASE_LINUX_SIZE: "220000000",
  RELEASE_LINUX_ASC_SIZE: "1024",
  RELEASE_LINUX_ASC_SHA256: "LINUXHASH",
};

test("the public Windows download redirects to the AWS installer", async () => {
  const response = await handleRequest(new Request("https://sparky.llc/get?platform=windows"), env);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://downloads.example.test/releases/0.0.28/windows/Sparky.exe");
});

test("unsupported systems default to Windows, while Linux and macOS resolve to installers", async () => {
  assert.equal(requestedPlatform(new Request("https://sparky.llc/get"), new URL("https://sparky.llc/get")), "windows-x64");
  assert.equal(requestedPlatform(new Request("https://sparky.llc/get", { headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64)" } }), new URL("https://sparky.llc/get")), "linux-x64");
  assert.equal(requestedPlatform(new Request("https://sparky.llc/get", { headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 15)" } }), new URL("https://sparky.llc/get")), "windows-x64");

  const arm = await handleRequest(new Request("https://sparky.llc/get?platform=macos"), env);
  assert.equal(arm.headers.get("location"), "https://downloads.example.test/releases/0.0.28/macos/arm64/Sparky.dmg");
  const linux = await handleRequest(new Request("https://sparky.llc/get?platform=linux"), env);
  assert.equal(linux.headers.get("location"), "https://downloads.example.test/releases/0.0.28/linux/Sparky-x64.AppImage");
});

test("the manifest describes the local launch build", async () => {
  const response = await handleRequest(new Request("https://sparky.llc/get/manifest"), env);
  const body = await response.json();
  assert.equal(body.version, "0.0.28");
  assert.equal(body.files[0].name, "Sparky-x64.exe");
  assert.equal(body.files[0].size, 342384168);
  assert.equal(body.files[0].sha256, env.RELEASE_WINDOWS_SHA256);
  assert.deepEqual(body.files.slice(1).map((file) => file.platform), ["macos-arm64", "macos-x64", "linux-x64", "linux-x64"]);
  assert.deepEqual(body.files.slice(1).map((file) => file.sha256), [env.RELEASE_MAC_ARM64_SHA256, env.RELEASE_MAC_X64_SHA256, null, env.RELEASE_LINUX_ASC_SHA256]);
});

test("the desktop updater resolves only known AWS release assets", async () => {
  const latest = await handleRequest(new Request("https://sparky.llc/get/updates/latest.yml"), env);
  assert.equal(latest.status, 302);
  assert.equal(latest.headers.get("location"), "https://downloads.example.test/releases/0.0.28/latest.yml");

  const traversal = await handleRequest(new Request("https://sparky.llc/get/updates/%2e%2e%2fsecret"), env);
  assert.equal(traversal.status, 404);
});

test("desktop updater feed checks do not record installer analytics", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return new Response("{}", { status: 200 });
  };
  try {
    const response = await handleRequest(
      new Request("https://sparky.llc/get/updates/latest.yml"),
      { ...env, ANALYTICS_ENDPOINT: "https://analytics.example.test/analytics/event" },
    );
    assert.equal(response.status, 302);
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("public installer redirects remain real installer analytics calls", async () => {
  const originalFetch = globalThis.fetch;
  let payload;
  globalThis.fetch = async (_input, init) => {
    payload = JSON.parse(init.body);
    return new Response("{}", { status: 200 });
  };
  try {
    const response = await handleRequest(
      new Request("https://sparky.llc/get?platform=windows&downloadId=click-1"),
      { ...env, ANALYTICS_ENDPOINT: "https://analytics.example.test/analytics/event" },
    );
    assert.equal(response.status, 302);
    assert.equal(payload.kind, "download_request");
    assert.equal(payload.platform, "windows-x64");
    assert.equal(payload.file, "Sparky-x64.exe");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("architecture-specific updater paths cannot cross platforms", () => {
  assert.deepEqual(updateRequest("/get/updates/windows/latest.yml"), { platform: "windows-x64", name: "latest.yml" });
  assert.deepEqual(updateRequest("/get/updates/windows/x64/latest.yml"), { platform: "windows-x64", name: "latest.yml" });
  assert.deepEqual(updateRequest("/get/updates/linux/Sparky-x64.AppImage"), { platform: "linux-x64", name: "Sparky-x64.AppImage" });
  assert.deepEqual(updateRequest("/get/updates/linux/Sparky-x64.AppImage.asc"), { platform: "linux-x64", name: "Sparky-x64.AppImage.asc" });
  assert.deepEqual(updateRequest("/get/updates/linux/latest-linux.yml"), { platform: "linux-x64", name: "latest-linux.yml" });
  assert.deepEqual(updateRequest("/get/updates/macos/arm64/latest-mac.yml"), { platform: "macos-arm64", name: "latest-mac-arm64.yml" });
  assert.deepEqual(updateRequest("/get/updates/macos/x64/latest-mac.yml"), { platform: "macos-x64", name: "latest-mac-x64.yml" });
  assert.deepEqual(updateRequest("/get/updates/macos/x64/Sparky-x64.zip"), { platform: "macos-x64", name: "Sparky-x64.zip" });
  assert.equal(updateRequest("/get/updates/macos/arm64/../secret"), null);
});

test("dynamic AWS manifests require complete HTTPS file metadata", () => {
  const manifest = validateManifest({
    version: "0.0.29",
    files: [{
      name: "latest-mac.yml",
      platform: "macos-arm64",
      size: 321,
      contentType: "text/yaml",
      url: "https://downloads.example.test/releases/0.0.29/macos/arm64/latest-mac.yml",
    }],
  });
  assert.equal(manifest.files[0].platform, "macos-arm64");
  assert.throws(() => validateManifest({ version: "0.0.29", files: [{ name: "bad", platform: "macos-arm64", size: 1, url: "http://unsafe.test/bad" }] }), /configured with HTTPS/u);
});

test("GitHub release manifests keep Intel and Apple Silicon feeds distinct", () => {
  const manifest = releaseConfig({
    RELEASE_PUBLIC_BASE_URL: "https://github.com/darkness22s/Sparky-primary-related/releases/download/v1.1.2",
    RELEASE_VERSION: "1.1.2",
    RELEASE_WINDOWS_SIZE: "10",
    RELEASE_WINDOWS_BLOCKMAP_SIZE: "11",
    RELEASE_WINDOWS_YML_SIZE: "12",
    RELEASE_MAC_ARM64_SIZE: "13",
    RELEASE_MAC_ARM64_BLOCKMAP_SIZE: "14",
    RELEASE_MAC_ARM64_YML_SIZE: "15",
    RELEASE_MAC_ARM64_YML_NAME: "latest-mac-arm64.yml",
    RELEASE_MAC_X64_SIZE: "16",
    RELEASE_MAC_X64_BLOCKMAP_SIZE: "17",
    RELEASE_MAC_X64_YML_SIZE: "18",
    RELEASE_MAC_X64_YML_NAME: "latest-mac-x64.yml",
    RELEASE_LINUX_SIZE: "19",
    RELEASE_LINUX_ASC_SIZE: "20",
    RELEASE_LINUX_YML_SIZE: "21",
  });
  assert.equal(manifest.files.find((file) => file.platform === "macos-arm64" && file.name.endsWith(".yml")).name, "latest-mac-arm64.yml");
  assert.equal(manifest.files.find((file) => file.platform === "macos-x64" && file.name.endsWith(".yml")).name, "latest-mac-x64.yml");
  assert.equal(manifest.files.find((file) => file.platform === "linux-x64" && file.name.endsWith(".yml")).name, "latest-linux.yml");
  assert.equal(manifest.files.filter((file) => file.name.endsWith(".zip")).length, 2);
});

test("a versioned public release overrides stale external manifest bindings", async () => {
  const response = await handleRequest(new Request("https://sparky.llc/get/updates/macos/x64/latest-mac-x64.yml"), {
    RELEASE_PUBLIC_BASE_URL: "https://github.com/darkness22s/Sparky-primary-related/releases/download/v1.1.2",
    RELEASE_MANIFEST_URL: "https://stale.example.test/manifest.json",
    RELEASE_VERSION: "1.1.2",
    RELEASE_MAC_X64_ZIP_SIZE: "10",
    RELEASE_MAC_X64_SIZE: "11",
    RELEASE_MAC_X64_BLOCKMAP_SIZE: "12",
    RELEASE_MAC_X64_YML_NAME: "latest-mac-x64.yml",
    RELEASE_MAC_X64_YML_SIZE: "13",
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://github.com/darkness22s/Sparky-primary-related/releases/download/v1.1.2/latest-mac-x64.yml");
});

test("beta never replaces the stable launch build", async () => {
  const response = await handleRequest(new Request("https://sparky.llc/get?channel=beta"), env);
  assert.equal(response.status, 404);
});

test("invalid AWS release configuration fails closed", async () => {
  assert.throws(() => releaseConfig({ ...env, AWS_RELEASE_BASE_URL: "http://insecure.example" }), /configured with HTTPS/u);
  assert.throws(() => releaseConfig({ ...env, AWS_LINUX_BASE_URL: undefined }), /AWS_LINUX_BASE_URL must be configured with HTTPS/u);
  const response = await worker.fetch(new Request("https://sparky.llc/get"), {});
  assert.equal(response.status, 502);
});
