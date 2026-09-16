import { httpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const updateCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Cache-Control": "no-store, max-age=0",
};

const updatePlatforms = new Set(["windows-x64", "macos-arm64", "macos-x64", "linux-x64"]);

function requestedUpdatePlatform(request: Request, fallback: string) {
  const value = new URL(request.url).searchParams.get("platform") ?? fallback;
  return updatePlatforms.has(value) ? value as "windows-x64" | "macos-arm64" | "macos-x64" | "linux-x64" : null;
}

async function updateMetadata(ctx: ActionCtx, request: Request, fallback: string) {
  const platform = requestedUpdatePlatform(request, fallback);
  if (!platform) return new Response("Not found.", { status: 404, headers: updateCors });
  const channel = new URL(request.url).searchParams.get("channel") === "beta" ? "beta" : "release";
  const metadata = await ctx.runQuery(internal.releases.updateMetadata, { channel, platform });
  if (!metadata) return new Response("Not found.", { status: 404, headers: updateCors });
  return Response.json(metadata, { headers: updateCors });
}

async function redirectToUpdateFeed(
  ctx: ActionCtx,
  request: Request,
  platform: "windows-x64" | "macos-arm64" | "macos-x64" | "linux-x64",
  fallbackChannel: "release" | "beta" = "release",
) {
  const channel = new URL(request.url).searchParams.get("channel") === "beta" ? "beta" : fallbackChannel;
  const metadata = await ctx.runQuery(internal.releases.updateMetadata, { channel, platform });
  if (!metadata) return new Response("Not found.", { status: 404, headers: updateCors });
  return new Response(null, {
    status: 302,
    headers: { ...updateCors, Location: metadata.feedUrl },
  });
}

http.route({
  path: "/updates/metadata",
  method: "GET",
  handler: httpAction((ctx, request) => updateMetadata(ctx, request, "windows-x64")),
});

http.route({
  path: "/updates/windows/latest.yml",
  method: "GET",
  handler: httpAction((ctx, request) => redirectToUpdateFeed(ctx, request, "windows-x64")),
});

http.route({
  path: "/updates/windows/nightly.yml",
  method: "GET",
  handler: httpAction((ctx, request) => redirectToUpdateFeed(ctx, request, "windows-x64", "beta")),
});

http.route({
  path: "/updates/macos/arm64/latest-mac.yml",
  method: "GET",
  handler: httpAction((ctx, request) => redirectToUpdateFeed(ctx, request, "macos-arm64")),
});

http.route({
  path: "/updates/macos/arm64/nightly-mac.yml",
  method: "GET",
  handler: httpAction((ctx, request) => redirectToUpdateFeed(ctx, request, "macos-arm64", "beta")),
});

http.route({
  path: "/updates/macos/x64/latest-mac.yml",
  method: "GET",
  handler: httpAction((ctx, request) => redirectToUpdateFeed(ctx, request, "macos-x64")),
});

http.route({
  path: "/updates/macos/x64/nightly-mac.yml",
  method: "GET",
  handler: httpAction((ctx, request) => redirectToUpdateFeed(ctx, request, "macos-x64", "beta")),
});

http.route({
  path: "/analytics/event",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: cors })),
});

http.route({
  path: "/analytics/event",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const body = await request.json();
      await ctx.runMutation(internal.analytics.recordEvent, body);
      return Response.json({ ok: true }, { headers: cors });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Invalid analytics event." },
        { status: 400, headers: cors },
      );
    }
  }),
});

export default http;
