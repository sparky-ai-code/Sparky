(() => {
  const endpoint = document.querySelector('meta[name="sparky-analytics-endpoint"]')?.content;
  if (!endpoint) return;

  const uuid = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const readOrCreate = (storage, key) => {
    try {
      const current = storage.getItem(key);
      if (current) return current;
      const value = uuid();
      storage.setItem(key, value);
      return value;
    } catch {
      return uuid();
    }
  };
  const visitorId = readOrCreate(localStorage, "sparky:visitor-id");
  const sessionId = readOrCreate(sessionStorage, "sparky:session-id");
  const referrer = (() => {
    try {
      return document.referrer ? new URL(document.referrer).origin : "direct";
    } catch {
      return "unknown";
    }
  })();

  function environment() {
    const ua = navigator.userAgent || "";
    const platform = navigator.userAgentData?.platform || navigator.platform || "unknown";
    const os = /mac/i.test(platform) ? "macOS" : /win/i.test(platform) ? "Windows" : /linux/i.test(platform) ? "Linux" : platform;
    const browser = /edg\//i.test(ua) ? "Edge" : /firefox\//i.test(ua) ? "Firefox" : /chrome\//i.test(ua) ? "Chrome" : /safari\//i.test(ua) ? "Safari" : "Other";
    const device = /tablet|ipad/i.test(ua) ? "Tablet" : /mobile|iphone|android/i.test(ua) ? "Mobile" : "Desktop";
    return {
      browser,
      os,
      device,
      language: navigator.language || "unknown",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown",
      viewport: `${Math.round(window.innerWidth)}x${Math.round(window.innerHeight)}`,
    };
  }

  const context = environment();
  const basePayload = () => ({
    source: "site",
    visitorId,
    sessionId,
    path: `${location.pathname}${location.hash}`.slice(0, 300),
    referrer,
    ...context,
  });

  const send = (kind, extra = {}, options = {}) => {
    const payload = { kind, ...basePayload(), at: Date.now(), ...extra };
    const body = JSON.stringify(payload);
    if (options.beacon && navigator.sendBeacon) {
      try {
        const queued = navigator.sendBeacon(endpoint, new Blob([body], { type: "application/json" }));
        if (queued) return;
      } catch {
        // Fall through to keepalive fetch when Beacon is unavailable or rejected.
      }
    }
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
      credentials: "omit",
    }).catch(() => {});
  };

  const platformFromUrl = (url) => {
    const requested = url.searchParams.get("platform");
    if (requested === "mac" || requested === "macos") return "macos-arm64";
    if (requested === "macosintel" || requested === "macx64") return "macos-x64";
    if (requested === "linux" || requested === "linux-x64") return "linux-x64";
    return /mac/i.test(context.os) ? "macos-arm64" : /linux/i.test(context.os) ? "linux-x64" : "windows-x64";
  };

  const isInstallerRoute = (url) => url.pathname.replace(/\/+$/u, "") === "/get";
  const isDownloadPage = (url) => /(?:^|\/)download(?:\.html)?$/iu.test(url.pathname.replace(/\/+$/u, ""));
  const addRouterContext = (url, downloadId) => {
    url.searchParams.set("visitor", visitorId);
    url.searchParams.set("session", sessionId);
    url.searchParams.set("downloadId", downloadId);
    url.searchParams.set("from", `${location.pathname}${location.hash}`.slice(0, 300));
    return url;
  };

  let activeSince = document.visibilityState === "visible" ? Date.now() : null;
  send("page_view", { label: document.title.slice(0, 200) });
  if (isDownloadPage(new URL(location.href))) {
    send("download_page_open", { label: "Download page", outcome: "page-view" });
  }
  setInterval(() => {
    if (activeSince === null) return;
    const engagedMs = Math.min(Date.now() - activeSince, 30_000);
    activeSince = document.visibilityState === "visible" ? Date.now() : null;
    if (engagedMs > 500) send("heartbeat", { engagedMs });
  }, 15_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (activeSince !== null) send("heartbeat", { engagedMs: Math.min(Date.now() - activeSince, 30_000) });
      activeSince = null;
    } else activeSince = Date.now();
  });

  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[href]");
    if (link) {
      let url;
      try {
        url = new URL(link.href, location.href);
      } catch {
        url = null;
      }
      if (url && isInstallerRoute(url)) {
        const downloadId = uuid();
        const platform = platformFromUrl(url);
        send("download_click", {
          downloadId,
          platform,
          label: (link.textContent || "Installer").trim().slice(0, 200),
          outcome: "intent",
        }, { beacon: true });
        link.href = addRouterContext(url, downloadId).toString();
      }
    }

    const demoEmbed = event.target.closest?.(".demo-embed");
    if (demoEmbed) send("desktop_render_interaction", { label: "demo_embed" });
  }, true);

  const demoFrame = document.querySelector("#sparky-demo-frame");
  window.addEventListener("message", (event) => {
    if (!demoFrame || event.origin !== window.location.origin || event.source !== demoFrame.contentWindow) return;
    if (event.data?.type !== "sparky-demo-interaction") return;
    send("desktop_render_interaction", { label: String(event.data.label || "demo").slice(0, 160) });
  });
})();
