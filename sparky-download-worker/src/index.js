// Sparky's public download and desktop-update router. Release assets are public
// immutable files; Convex remains the app's update metadata source.

const PUBLIC_CACHE_CONTROL = "no-store, max-age=0";
const PLATFORM_ALIASES = new Map([
  ["win", "windows-x64"],
  ["windows", "windows-x64"],
  ["windows-x64", "windows-x64"],
  ["mac", "macos-arm64"],
  ["macos", "macos-arm64"],
  ["macos-arm64", "macos-arm64"],
  ["macx64", "macos-x64"],
  ["macosintel", "macos-x64"],
  ["macos-x64", "macos-x64"],
  ["linux", "linux-x64"],
  ["linux-x64", "linux-x64"],
]);

function publicHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Cache-Control": PUBLIC_CACHE_CONTROL,
  };
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: publicHeaders() });
}

function errorResponse(message, status) {
  return json({ error: message }, status);
}

function requiredHttpsUrl(value, label) {
  const url = value?.trim().replace(/\/+$/u, "");
  if (!url?.startsWith("https://")) throw new Error(`${label} must be configured with HTTPS.`);
  return url;
}

function releaseConfig(env) {
  const publicBaseUrl = env.RELEASE_PUBLIC_BASE_URL?.trim();
  if (publicBaseUrl) return githubReleaseConfig(env, requiredHttpsUrl(publicBaseUrl, "RELEASE_PUBLIC_BASE_URL"));
  const baseUrl = requiredHttpsUrl(env.AWS_RELEASE_BASE_URL, "AWS_RELEASE_BASE_URL");
  const version = env.RELEASE_VERSION?.trim();
  if (!version) throw new Error("RELEASE_VERSION is not configured.");
  const windowsSize = Number(env.RELEASE_WINDOWS_SIZE);
  if (!Number.isSafeInteger(windowsSize) || windowsSize <= 0) throw new Error("RELEASE_WINDOWS_SIZE is invalid.");
  const windowsBaseUrl = requiredHttpsUrl(env.AWS_WINDOWS_BASE_URL || `${baseUrl}/windows`, "AWS_WINDOWS_BASE_URL");
  const macArm64BaseUrl = env.AWS_MAC_ARM64_BASE_URL ? requiredHttpsUrl(env.AWS_MAC_ARM64_BASE_URL, "AWS_MAC_ARM64_BASE_URL") : null;
  const macX64BaseUrl = env.AWS_MAC_X64_BASE_URL ? requiredHttpsUrl(env.AWS_MAC_X64_BASE_URL, "AWS_MAC_X64_BASE_URL") : null;
  const linuxSize = env.RELEASE_LINUX_SIZE?.trim();
  const linuxBaseUrl = linuxSize ? requiredHttpsUrl(env.AWS_LINUX_BASE_URL, "AWS_LINUX_BASE_URL") : null;
  const files = [
    { name: "Sparky-x64.exe", platform: "windows-x64", size: windowsSize, contentType: "application/x-msdownload", sha256: env.RELEASE_WINDOWS_SHA256?.trim() || null, url: `${windowsBaseUrl}/Sparky.exe` },
    { name: "Sparky-x64.exe.blockmap", platform: "windows-x64", size: null, contentType: "application/octet-stream", sha256: null, url: `${baseUrl}/Sparky-x64.exe.blockmap` },
    { name: "latest.yml", platform: "windows-x64", size: null, contentType: "text/yaml", sha256: null, url: `${baseUrl}/latest.yml` },
  ];
  if (macArm64BaseUrl) files.push({ name: "Sparky-arm64.dmg", platform: "macos-arm64", size: Number(env.RELEASE_MAC_ARM64_SIZE) || null, contentType: "application/x-apple-diskimage", sha256: env.RELEASE_MAC_ARM64_SHA256?.trim() || null, url: `${macArm64BaseUrl}/Sparky.dmg` });
  if (macX64BaseUrl) files.push({ name: "Sparky-x64.dmg", platform: "macos-x64", size: Number(env.RELEASE_MAC_X64_SIZE) || null, contentType: "application/x-apple-diskimage", sha256: env.RELEASE_MAC_X64_SHA256?.trim() || null, url: `${macX64BaseUrl}/Sparky.dmg` });
  if (env.RELEASE_LINUX_SIZE?.trim()) {
    files.push({ name: "Sparky-x64.AppImage", platform: "linux-x64", size: Number(env.RELEASE_LINUX_SIZE) || null, contentType: "application/octet-stream", sha256: env.RELEASE_LINUX_SHA256?.trim() || null, url: `${linuxBaseUrl}/Sparky-x64.AppImage` });
    if (env.RELEASE_LINUX_ASC_SIZE?.trim() && env.RELEASE_LINUX_ASC_SHA256?.trim()) {
      files.push({ name: "Sparky-x64.AppImage.asc", platform: "linux-x64", size: Number(env.RELEASE_LINUX_ASC_SIZE) || null, contentType: "application/pgp-signature", sha256: env.RELEASE_LINUX_ASC_SHA256?.trim() || null, url: `${linuxBaseUrl}/Sparky-x64.AppImage.asc` });
    }
  }
  return { schemaVersion: 0, id: version, version, name: `Sparky ${version}`, channel: "release", changelog: env.RELEASE_CHANGELOG?.trim() || "", publishedAt: env.RELEASE_PUBLISHED_AT?.trim() || null, files };
}

function githubReleaseConfig(env, baseUrl) {
  const version = env.RELEASE_VERSION?.trim();
  if (!version) throw new Error("RELEASE_VERSION is not configured.");
  const asset = (name) => `${baseUrl}/${encodeURIComponent(name)}`;
  const file = (name, platform, size, contentType, sha256) => ({
    name,
    platform,
    size: Number.isSafeInteger(size) && size > 0 ? size : null,
    contentType,
    sha256: sha256?.trim() || null,
    url: asset(name),
  });
  const files = [
    file("Sparky-x64.exe", "windows-x64", Number(env.RELEASE_WINDOWS_SIZE), "application/x-msdownload", env.RELEASE_WINDOWS_SHA256),
    file("Sparky-x64.exe.blockmap", "windows-x64", Number(env.RELEASE_WINDOWS_BLOCKMAP_SIZE), "application/octet-stream", env.RELEASE_WINDOWS_BLOCKMAP_SHA256),
    file("latest.yml", "windows-x64", Number(env.RELEASE_WINDOWS_YML_SIZE), "text/yaml", env.RELEASE_WINDOWS_YML_SHA256),
  ];
  if (env.RELEASE_LINUX_SIZE?.trim()) {
    files.push(file("Sparky-x64.AppImage", "linux-x64", Number(env.RELEASE_LINUX_SIZE), "application/octet-stream", env.RELEASE_LINUX_SHA256));
    if (env.RELEASE_LINUX_ASC_SIZE?.trim() && env.RELEASE_LINUX_ASC_SHA256?.trim()) {
      files.push(file("Sparky-x64.AppImage.asc", "linux-x64", Number(env.RELEASE_LINUX_ASC_SIZE), "application/pgp-signature", env.RELEASE_LINUX_ASC_SHA256));
    }
    files.push(file("latest-linux.yml", "linux-x64", Number(env.RELEASE_LINUX_YML_SIZE), "text/yaml", env.RELEASE_LINUX_YML_SHA256));
  }
  if (env.RELEASE_MAC_ARM64_SIZE?.trim()) {
    const manifestName = env.RELEASE_MAC_ARM64_YML_NAME?.trim() || "latest-mac.yml";
    files.push(
      file("Sparky-arm64.zip", "macos-arm64", Number(env.RELEASE_MAC_ARM64_ZIP_SIZE), "application/zip", env.RELEASE_MAC_ARM64_ZIP_SHA256),
      file("Sparky-arm64.dmg", "macos-arm64", Number(env.RELEASE_MAC_ARM64_SIZE), "application/x-apple-diskimage", env.RELEASE_MAC_ARM64_SHA256),
      file("Sparky-arm64.dmg.blockmap", "macos-arm64", Number(env.RELEASE_MAC_ARM64_BLOCKMAP_SIZE), "application/octet-stream", env.RELEASE_MAC_ARM64_BLOCKMAP_SHA256),
      file(manifestName, "macos-arm64", Number(env.RELEASE_MAC_ARM64_YML_SIZE), "text/yaml", env.RELEASE_MAC_ARM64_YML_SHA256),
    );
  }
  if (env.RELEASE_MAC_X64_SIZE?.trim()) {
    const manifestName = env.RELEASE_MAC_X64_YML_NAME?.trim() || "latest-mac.yml";
    files.push(
      file("Sparky-x64.zip", "macos-x64", Number(env.RELEASE_MAC_X64_ZIP_SIZE), "application/zip", env.RELEASE_MAC_X64_ZIP_SHA256),
      file("Sparky-x64.dmg", "macos-x64", Number(env.RELEASE_MAC_X64_SIZE), "application/x-apple-diskimage", env.RELEASE_MAC_X64_SHA256),
      file("Sparky-x64.dmg.blockmap", "macos-x64", Number(env.RELEASE_MAC_X64_BLOCKMAP_SIZE), "application/octet-stream", env.RELEASE_MAC_X64_BLOCKMAP_SHA256),
      file(manifestName, "macos-x64", Number(env.RELEASE_MAC_X64_YML_SIZE), "text/yaml", env.RELEASE_MAC_X64_YML_SHA256),
    );
  }
  return { schemaVersion: 0, id: version, version, name: `Sparky ${version}`, channel: "release", changelog: env.RELEASE_CHANGELOG?.trim() || "", publishedAt: env.RELEASE_PUBLISHED_AT?.trim() || null, files };
}

function githubLatestReleaseConfig(env, release) {
  const tag = typeof release?.tag_name === "string" ? release.tag_name.trim() : "";
  const version = /^v(\d+\.\d+\.\d+)$/u.exec(tag)?.[1];
  if (!version || release.draft || release.prerelease) {
    throw new Error("GitHub latest release is not a published stable version.");
  }

  const assets = new Map(
    (Array.isArray(release.assets) ? release.assets : [])
      .filter((asset) => typeof asset?.name === "string")
      .map((asset) => [asset.name, asset]),
  );
  const latestEnv = {
    ...env,
    RELEASE_VERSION: version,
    RELEASE_PUBLIC_BASE_URL: `https://github.com/sparky-ai-code/Sparky/releases/download/${tag}`,
    RELEASE_PUBLISHED_AT: typeof release.published_at === "string" ? release.published_at : env.RELEASE_PUBLISHED_AT,
    RELEASE_CHANGELOG: typeof release.body === "string" ? release.body : env.RELEASE_CHANGELOG,
  };
  delete latestEnv.RELEASE_LINUX_ASC_SIZE;
  delete latestEnv.RELEASE_LINUX_ASC_SHA256;

  const requiredAssets = [
    ["Sparky-x64.exe", "RELEASE_WINDOWS_SIZE", "RELEASE_WINDOWS_SHA256"],
    ["Sparky-x64.exe.blockmap", "RELEASE_WINDOWS_BLOCKMAP_SIZE", "RELEASE_WINDOWS_BLOCKMAP_SHA256"],
    ["latest.yml", "RELEASE_WINDOWS_YML_SIZE", "RELEASE_WINDOWS_YML_SHA256"],
    ["Sparky-x64.AppImage", "RELEASE_LINUX_SIZE", "RELEASE_LINUX_SHA256"],
    ["latest-linux.yml", "RELEASE_LINUX_YML_SIZE", "RELEASE_LINUX_YML_SHA256"],
    ["Sparky-arm64.zip", "RELEASE_MAC_ARM64_ZIP_SIZE", "RELEASE_MAC_ARM64_ZIP_SHA256"],
    ["Sparky-arm64.dmg", "RELEASE_MAC_ARM64_SIZE", "RELEASE_MAC_ARM64_SHA256"],
    ["Sparky-arm64.dmg.blockmap", "RELEASE_MAC_ARM64_BLOCKMAP_SIZE", "RELEASE_MAC_ARM64_BLOCKMAP_SHA256"],
    ["latest-mac-arm64.yml", "RELEASE_MAC_ARM64_YML_SIZE", "RELEASE_MAC_ARM64_YML_SHA256"],
    ["Sparky-x64.zip", "RELEASE_MAC_X64_ZIP_SIZE", "RELEASE_MAC_X64_ZIP_SHA256"],
    ["Sparky-x64.dmg", "RELEASE_MAC_X64_SIZE", "RELEASE_MAC_X64_SHA256"],
    ["Sparky-x64.dmg.blockmap", "RELEASE_MAC_X64_BLOCKMAP_SIZE", "RELEASE_MAC_X64_BLOCKMAP_SHA256"],
    ["latest-mac-x64.yml", "RELEASE_MAC_X64_YML_SIZE", "RELEASE_MAC_X64_YML_SHA256"],
  ];

  for (const [name, sizeKey, sha256Key] of requiredAssets) {
    const asset = assets.get(name);
    const sha256 = typeof asset?.digest === "string" ? /^sha256:([0-9a-f]{64})$/iu.exec(asset.digest)?.[1] : null;
    if (!Number.isSafeInteger(asset?.size) || asset.size <= 0 || !sha256) {
      throw new Error(`Latest GitHub release is missing valid metadata for ${name}.`);
    }
    latestEnv[sizeKey] = String(asset.size);
    latestEnv[sha256Key] = sha256;
  }

  const signature = assets.get("Sparky-x64.AppImage.asc");
  if (signature) {
    const sha256 = typeof signature.digest === "string" ? /^sha256:([0-9a-f]{64})$/iu.exec(signature.digest)?.[1] : null;
    if (!Number.isSafeInteger(signature.size) || signature.size <= 0 || !sha256) {
      throw new Error("Latest GitHub release has invalid metadata for Sparky-x64.AppImage.asc.");
    }
    latestEnv.RELEASE_LINUX_ASC_SIZE = String(signature.size);
    latestEnv.RELEASE_LINUX_ASC_SHA256 = sha256;
  }

  return githubReleaseConfig(latestEnv, latestEnv.RELEASE_PUBLIC_BASE_URL);
}

function validateManifest(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.version !== "string" || !Array.isArray(raw.files)) {
    throw new Error("Release manifest has an invalid shape.");
  }
  const files = raw.files.map((file) => {
    if (!file || typeof file.name !== "string" || !PLATFORM_ALIASES.has(file.platform) || !Number.isSafeInteger(file.size) || file.size <= 0) {
      throw new Error("Release manifest contains an invalid file.");
    }
    return { ...file, platform: PLATFORM_ALIASES.get(file.platform), url: requiredHttpsUrl(file.url, `URL for ${file.name}`) };
  });
  return { ...raw, files };
}

async function loadManifest(env) {
  const latestReleaseUrl = env.RELEASE_GITHUB_LATEST_API_URL?.trim();
  if (latestReleaseUrl) {
    try {
      const response = await fetch(requiredHttpsUrl(latestReleaseUrl, "RELEASE_GITHUB_LATEST_API_URL"), {
        headers: { accept: "application/vnd.github+json" },
        cf: { cacheTtl: 300, cacheEverything: true },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return githubLatestReleaseConfig(env, await response.json());
    } catch (error) {
      console.error(JSON.stringify({ event: "github_latest_release_fetch_failed", message: error instanceof Error ? error.message : String(error) }));
      if (env.RELEASE_PUBLIC_BASE_URL?.trim()) return releaseConfig(env);
    }
  }

  // Keep the pinned release as a known-good fallback if GitHub's latest-release
  // API is unavailable or its newest release is missing required platform assets.
  if (env.RELEASE_PUBLIC_BASE_URL?.trim()) return releaseConfig(env);
  const manifestUrl = (env.RELEASE_MANIFEST_URL || env.AWS_RELEASE_MANIFEST_URL)?.trim();
  if (!manifestUrl) return releaseConfig(env);
  try {
    const response = await fetch(requiredHttpsUrl(manifestUrl, "AWS_RELEASE_MANIFEST_URL"), {
      headers: { accept: "application/json" },
      cf: { cacheTtl: 10, cacheEverything: true },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return validateManifest(await response.json());
  } catch (error) {
    console.error(JSON.stringify({ event: "release_manifest_fetch_failed", message: error instanceof Error ? error.message : String(error) }));
    return releaseConfig(env);
  }
}

function publicManifest(release) {
  return {
    id: release.id ?? release.version,
    version: release.version,
    name: release.name ?? `Sparky ${release.version}`,
    channel: release.channel ?? "release",
    changelog: release.changelog ?? "",
    publishedAt: release.publishedAt ?? null,
    files: release.files.filter((file) => /\.(?:exe|dmg|AppImage|asc)$/iu.test(file.name)).map(({ name, platform, size, contentType, sha256 }) => ({ name, platform, size, contentType, sha256: sha256 ?? null })),
  };
}

function requestedPlatform(request, url) {
  const explicit = url.searchParams.get("platform");
  if (explicit) return PLATFORM_ALIASES.get(explicit) ?? explicit;
  const userAgent = (request.headers.get("User-Agent") || "").toLowerCase();
  if (userAgent.includes("mac") || userAgent.includes("darwin")) return "macos-arm64";
  if (userAgent.includes("linux") && !userAgent.includes("android")) return "linux-x64";
  return "windows-x64";
}

function findInstaller(release, platform) {
  return release.files.find((file) => file.platform === platform && (file.name.endsWith(".exe") || file.name.endsWith(".dmg") || file.name.endsWith(".AppImage")));
}

function updateRequest(path) {
  const suffix = path.slice("/get/updates/".length);
  const decoded = suffix.split("/").map(decodeURIComponent);
  if (decoded.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) return null;
  if (decoded.length === 1) {
    if (decoded[0] === "latest-mac.yml") return { platform: "macos-arm64", name: decoded[0] };
    if (decoded[0] === "latest-linux.yml") return { platform: "linux-x64", name: decoded[0] };
    return { platform: "windows-x64", name: decoded[0] };
  }
  if (decoded[0] === "windows" && decoded.length === 2) return { platform: "windows-x64", name: decoded[1] };
  // Keep the legacy architecture-qualified Windows feed working. Some
  // already-published installers baked /get/updates/windows/x64 into their
  // app-update.yml; changing the release repository must not strand them.
  if (decoded[0] === "windows" && decoded[1] === "x64" && decoded.length === 3) {
    return { platform: "windows-x64", name: decoded[2] };
  }
  if (decoded[0] === "linux" && decoded.length === 2 && (decoded[1] === "latest-linux.yml" || decoded[1].endsWith(".AppImage") || decoded[1].endsWith(".asc"))) return { platform: "linux-x64", name: decoded[1] };
  if (decoded[0] === "macos" && decoded.length === 3 && (decoded[1] === "arm64" || decoded[1] === "x64")) {
    const name = decoded[2] === "latest-mac.yml" ? `latest-mac-${decoded[1]}.yml` : decoded[2];
    return { platform: `macos-${decoded[1]}`, name };
  }
  return null;
}

function redirect(url) {
  return new Response(null, { status: 302, headers: { ...publicHeaders(), Location: url } });
}

function classifyUserAgent(userAgent) {
  const browser = /edg\//iu.test(userAgent) ? "Edge" : /firefox\//iu.test(userAgent) ? "Firefox" : /chrome\//iu.test(userAgent) ? "Chrome" : /safari\//iu.test(userAgent) ? "Safari" : "Other";
  const os = /mac|darwin/iu.test(userAgent) ? "macOS" : /windows/iu.test(userAgent) ? "Windows" : /linux/iu.test(userAgent) ? "Linux" : "Other";
  const device = /tablet|ipad/iu.test(userAgent) ? "Tablet" : /mobile|iphone|android/iu.test(userAgent) ? "Mobile" : "Desktop";
  return { browser, os, device };
}

function referrerOrigin(value) {
  if (!value) return "direct";
  try {
    return new URL(value).origin;
  } catch {
    return "unknown";
  }
}

function trackDownloadRequest(env, request, executionContext, release, details) {
  const endpoint = env.ANALYTICS_ENDPOINT?.trim();
  if (!endpoint) return;
  const url = new URL(request.url);
  const requestId = crypto.randomUUID();
  const downloadId = url.searchParams.get("downloadId") || undefined;
  const visitorId = url.searchParams.get("visitor") || `edge:${requestId}`;
  const sessionId = url.searchParams.get("session") || `edge:${requestId}`;
  const environment = classifyUserAgent(request.headers.get("User-Agent") || "");
  const payload = {
    visitorId,
    sessionId,
    source: "edge",
    kind: details.outcome === "redirect" ? "download_request" : "download_error",
    path: (url.searchParams.get("from") || url.pathname).slice(0, 300),
    label: details.file || "Installer request",
    at: Date.now(),
    downloadId,
    requestId,
    platform: details.platform,
    release: release?.version,
    file: details.file,
    outcome: details.outcome,
    referrer: referrerOrigin(request.headers.get("Referer")),
    ...environment,
    country: request.cf?.country || undefined,
    colo: request.cf?.colo || undefined,
    status: details.status,
  };
  const promise = fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
  if (executionContext?.waitUntil) executionContext.waitUntil(promise);
}

async function handleRequest(request, env, executionContext) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/u, "") || "/";
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: publicHeaders() });
  if (request.method !== "GET" && request.method !== "HEAD") return errorResponse("Method not allowed.", 405);
  if (url.searchParams.get("channel") === "beta") return errorResponse("No published beta release.", 404);
  if (env.DOWNLOADS_DISABLED === "true") return errorResponse("Downloads are temporarily unavailable.", 503);

  const release = await loadManifest(env);
  if (path === "/get/manifest") return json(publicManifest(release));
  if (path === "/get/releases") return json([publicManifest(release)]);
  if (path.startsWith("/get/updates/")) {
    // Desktop auto-updaters poll these feeds in the background. They are not
    // user-initiated installer calls, so keep them out of download analytics.
    const requested = updateRequest(path);
    if (!requested) return errorResponse("Update asset not found.", 404);
    const file = release.files.find((candidate) => candidate.platform === requested.platform && candidate.name === requested.name);
    if (!file) return errorResponse("Update asset not found.", 404);
    return redirect(file.url);
  }
  if (path !== "/get" && path !== "/") return errorResponse("Not found.", 404);
  const platform = requestedPlatform(request, url);
  const installer = findInstaller(release, platform);
  if (!installer) {
    trackDownloadRequest(env, request, executionContext, release, { platform, file: "unknown", outcome: "missing-installer", status: 404 });
    return errorResponse(`The published release does not contain a ${platform} installer.`, 404);
  }
  trackDownloadRequest(env, request, executionContext, release, { platform: installer.platform, file: installer.name, outcome: "redirect", status: 302 });
  return redirect(installer.url);
}

export { handleRequest, loadManifest, publicManifest, releaseConfig, requestedPlatform, updateRequest, validateManifest };

export default {
  async fetch(request, env, executionContext) {
    try {
      return await handleRequest(request, env, executionContext);
    } catch (error) {
      console.error(JSON.stringify({ event: "release_request_failed", message: error instanceof Error ? error.message : String(error) }));
      return errorResponse(error instanceof Error ? error.message : "Release request failed.", 502);
    }
  },
};
