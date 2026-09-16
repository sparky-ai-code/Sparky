import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const ADMIN_EMAIL = "soliamanmagbari@gmail.com";
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CHANGELOG_LENGTH = 50_000;
const VERSION = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
const ALLOWED_FILE = /\.(?:exe|dmg|AppImage|asc|zip|blockmap|ya?ml)$/u;
const channelValidator = v.union(v.literal("release"), v.literal("beta"));
const statusValidator = v.union(v.literal("draft"), v.literal("published"));
export const platformValidator = v.union(
  v.literal("windows-x64"),
  v.literal("macos-arm64"),
  v.literal("macos-x64"),
  v.literal("linux-x64"),
);
const fileInputValidator = v.object({
  name: v.string(),
  size: v.number(),
  contentType: v.string(),
  platform: v.optional(platformValidator),
  publicUrl: v.optional(v.string()),
  sha256: v.optional(v.string()),
});
const chunkInputValidator = v.object({ storageId: v.id("_storage"), size: v.number() });
const completedFileValidator = v.object({ name: v.string(), chunks: v.array(chunkInputValidator) });
const publicFileValidator = v.object({
  name: v.string(),
  size: v.number(),
  contentType: v.string(),
  platform: v.union(platformValidator, v.null()),
  sha256: v.union(v.string(), v.null()),
});
const publicReleaseValidator = v.object({
  id: v.id("releases"),
  version: v.string(),
  name: v.string(),
  channel: channelValidator,
  status: statusValidator,
  changelog: v.string(),
  createdAt: v.number(),
  publishedAt: v.union(v.number(), v.null()),
  files: v.array(publicFileValidator),
});
const updateMetadataValidator = v.object({
  version: v.string(),
  name: v.string(),
  channel: channelValidator,
  changelog: v.string(),
  publishedAt: v.union(v.number(), v.null()),
  platform: platformValidator,
  feedUrl: v.string(),
  installer: v.object({
    name: v.string(),
    size: v.number(),
    contentType: v.string(),
    url: v.string(),
    sha256: v.union(v.string(), v.null()),
  }),
});

async function requireAdmin(ctx: Pick<QueryCtx, "auth"> | Pick<MutationCtx, "auth">) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || identity.email?.toLowerCase() !== ADMIN_EMAIL) {
    throw new Error("Administrator access is required.");
  }
}

function normalizeTag(tag: string) {
  const trimmed = tag.trim();
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function validateMetadata(
  files: Array<{
    name: string;
    size: number;
    contentType: string;
    platform?: "windows-x64" | "macos-arm64" | "macos-x64" | "linux-x64";
    sha256?: string;
  }>,
  channel: "release" | "beta",
) {
  if (files.length < 1 || files.length > 20) throw new Error("Select between 1 and 20 release files.");
  const names = new Set<string>();
  for (const file of files) {
    if (!file.name || file.name.includes("/") || file.name.includes("\\") || !ALLOWED_FILE.test(file.name)) {
      throw new Error(`Unsupported release filename: ${file.name || "unnamed"}.`);
    }
    const uniqueName = `${file.platform ?? "legacy"}:${file.name}`;
    if (names.has(uniqueName)) throw new Error(`Duplicate release filename: ${file.name}.`);
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_FILE_BYTES) {
      throw new Error(`Invalid file size for ${file.name}.`);
    }
    if (file.sha256 && !/^[a-f0-9]{64}$/iu.test(file.sha256)) {
      throw new Error(`Invalid SHA-256 checksum for ${file.name}.`);
    }
    names.add(uniqueName);
  }
  if (![...names].some((name) => /\.(?:exe|dmg|AppImage|zip)$/u.test(name))) throw new Error("Include at least one installer build.");

  if (channel === "release" && files.some((file) => file.platform)) {
    const grouped = new Map<string, Set<string>>();
    for (const file of files) {
      if (!file.platform) throw new Error(`Choose a platform for ${file.name}.`);
      const group = grouped.get(file.platform) ?? new Set<string>();
      group.add(file.name);
      grouped.set(file.platform, group);
    }
    const windows = grouped.get("windows-x64") ?? new Set<string>();
    const arm64 = grouped.get("macos-arm64") ?? new Set<string>();
    const x64 = grouped.get("macos-x64") ?? new Set<string>();
    const linux = grouped.get("linux-x64") ?? new Set<string>();
    for (const [label, group] of [["Windows x64", windows], ["Mac Apple Silicon", arm64], ["Mac Intel", x64], ["Linux x64", linux]] as const) {
      if (group.size === 0) throw new Error(`${label} files are required for a stable release.`);
    }
    if (![...windows].some((name) => name.endsWith(".exe")) || !windows.has("latest.yml")) {
      throw new Error("Windows x64 requires its .exe installer and latest.yml.");
    }
    for (const [label, group] of [["Mac Apple Silicon", arm64], ["Mac Intel", x64]] as const) {
      if (![...group].some((name) => name.endsWith(".dmg")) || !group.has("latest-mac.yml")) {
        throw new Error(`${label} requires its .dmg installer and latest-mac.yml.`);
      }
    }
    if (![...linux].some((name) => name.endsWith(".AppImage")) || !linux.has("Sparky-x64.AppImage.asc")) {
      throw new Error("Linux x64 needs its .AppImage installer and detached signature.");
    }
  } else if (channel === "release" && !files.some((file) => file.name === "latest.yml")) {
    throw new Error("Stable releases require latest.yml for desktop updates.");
  }
}

function publicRelease(release: {
  _id: Id<"releases">;
  tag: string;
  name: string;
  channel: "release" | "beta";
  status: "draft" | "published";
  changelog: string;
  createdAt: number;
  publishedAt?: number;
  files: Array<{
    name: string;
    size: number;
    contentType: string;
    platform?: "windows-x64" | "macos-arm64" | "macos-x64" | "linux-x64";
    sha256?: string;
  }>;
}) {
  return {
    id: release._id,
    version: release.tag,
    name: release.name,
    channel: release.channel,
    status: release.status,
    changelog: release.changelog,
    createdAt: release.createdAt,
    publishedAt: release.publishedAt ?? null,
    files: release.files.map(({ name, size, contentType, platform, sha256 }) => ({
      name,
      size,
      contentType,
      platform: platform ?? null,
      sha256: sha256 ?? null,
    })),
  };
}

function publicAssetUrl(file: { publicUrl?: string; awsKey?: string }) {
  const directUrl = file.publicUrl?.trim();
  if (directUrl?.startsWith("https://")) return directUrl;
  const publicBaseUrl = process.env.AWS_RELEASE_PUBLIC_BASE_URL?.trim().replace(/\/+$/u, "");
  if (!publicBaseUrl || !publicBaseUrl.startsWith("https://") || !file.awsKey) return null;
  return `${publicBaseUrl}/${file.awsKey.split("/").map(encodeURIComponent).join("/")}`;
}

async function pointedRelease(ctx: QueryCtx, channel: "release" | "beta") {
  const pointer = await ctx.db.query("releasePointers").withIndex("by_channel", (q) => q.eq("channel", channel)).unique();
  if (!pointer) return null;
  const release = await ctx.db.get(pointer.releaseId);
  return release?.status === "published" ? release : null;
}

export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return ctx.storage.generateUploadUrl();
  },
});

export const createDraft = mutation({
  args: {
    tag: v.string(),
    name: v.string(),
    channel: channelValidator,
    changelog: v.string(),
    files: v.array(fileInputValidator),
  },
  returns: v.object({ id: v.id("releases"), tag: v.string(), channel: channelValidator }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const tag = normalizeTag(args.tag);
    const changelog = args.changelog.trim();
    if (!VERSION.test(tag)) throw new Error("Enter a valid semantic version tag.");
    if (!changelog || changelog.length > MAX_CHANGELOG_LENGTH) throw new Error("Add a changelog under 50,000 characters.");
    validateMetadata(args.files, args.channel);
    const existing = await ctx.db.query("releases").withIndex("by_tag", (q) => q.eq("tag", tag)).unique();
    const draft = {
      name: args.name.trim() || `Sparky ${tag}`,
      channel: args.channel,
      status: "draft" as const,
      changelog,
      createdAt: Date.now(),
      files: args.files.map((file) => ({ ...file, uploaded: false, chunks: [] })),
    };
    if (existing) {
      if (existing.status !== "draft") throw new Error("That version is already published.");
      await ctx.db.patch(existing._id, draft);
      return { id: existing._id, tag, channel: args.channel };
    }
    const id = await ctx.db.insert("releases", {
      tag,
      ...draft,
    });
    return { id, tag, channel: args.channel };
  },
});

export const completeDraft = mutation({
  args: { id: v.id("releases"), files: v.array(completedFileValidator) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const release = await ctx.db.get(args.id);
    if (!release) throw new Error("Release not found.");
    if (release.status !== "draft") throw new Error("Published release files cannot be replaced.");
    if (args.files.length !== release.files.length) throw new Error("Every selected file must finish uploading.");
    const completedByName = new Map(args.files.map((file) => [file.name, file]));
    const files = release.files.map((file) => {
      const completed = completedByName.get(file.name);
      if (!completed || completed.chunks.length === 0) throw new Error(`Upload ${file.name} before completing the draft.`);
      const size = completed.chunks.reduce((total, chunk) => total + chunk.size, 0);
      if (size !== file.size || completed.chunks.some((chunk) => !Number.isSafeInteger(chunk.size) || chunk.size <= 0)) {
        throw new Error(`Uploaded chunks do not match ${file.name}.`);
      }
      return { ...file, uploaded: true, chunks: completed.chunks };
    });
    await ctx.db.patch(release._id, { files });
    return null;
  },
});

export const listAdmin = query({
  args: {},
  returns: v.array(publicReleaseValidator),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const releases = await ctx.db.query("releases").order("desc").take(100);
    return releases.map(publicRelease);
  },
});

export const updateChangelog = mutation({
  args: { id: v.id("releases"), changelog: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const changelog = args.changelog.trim();
    if (!changelog || changelog.length > MAX_CHANGELOG_LENGTH) throw new Error("Add a changelog under 50,000 characters.");
    const release = await ctx.db.get(args.id);
    if (!release) throw new Error("Release not found.");
    await ctx.db.patch(release._id, { changelog });
    return null;
  },
});

export const publish = mutation({
  args: { id: v.id("releases") },
  returns: publicReleaseValidator,
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const release = await ctx.db.get(args.id);
    if (!release) throw new Error("Release not found.");
    if (release.status !== "draft") throw new Error("This release is already published.");
    if (release.files.some((file) => !file.uploaded || file.chunks.length === 0)) throw new Error("Every release file must finish uploading before publish.");
    const publishedAt = Date.now();
    await ctx.db.patch(release._id, { status: "published", publishedAt });
    const pointer = await ctx.db.query("releasePointers").withIndex("by_channel", (q) => q.eq("channel", release.channel)).unique();
    if (pointer) await ctx.db.patch(pointer._id, { releaseId: release._id, updatedAt: publishedAt });
    else await ctx.db.insert("releasePointers", { channel: release.channel, releaseId: release._id, updatedAt: publishedAt });
    return publicRelease({ ...release, status: "published", publishedAt });
  },
});

export const publishExternal = mutation({
  args: {
    tag: v.string(),
    name: v.string(),
    channel: channelValidator,
    changelog: v.string(),
    files: v.array(v.object({
      name: v.string(),
      size: v.number(),
      contentType: v.string(),
      platform: platformValidator,
      publicUrl: v.string(),
      sha256: v.optional(v.string()),
    })),
  },
  returns: publicReleaseValidator,
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const tag = normalizeTag(args.tag);
    const changelog = args.changelog.trim();
    if (!VERSION.test(tag)) throw new Error("Enter a valid semantic version tag.");
    if (!changelog || changelog.length > MAX_CHANGELOG_LENGTH) throw new Error("Add a changelog under 50,000 characters.");
    if (args.files.some((file) => !file.publicUrl.trim().startsWith("https://"))) {
      throw new Error("External release assets must use HTTPS URLs.");
    }
    validateMetadata(args.files, args.channel);
    const files = args.files.map((file) => ({
      ...file,
      publicUrl: file.publicUrl.trim(),
      uploaded: true,
      chunks: [],
    }));
    const existing = await ctx.db.query("releases").withIndex("by_tag", (q) => q.eq("tag", tag)).unique();
    if (existing?.status === "published") throw new Error("That version is already published.");
    const publishedAt = Date.now();
    const release = existing
      ? { ...existing, name: args.name.trim() || `Sparky ${tag}`, channel: args.channel, status: "published" as const, changelog, files, publishedAt }
      : {
          tag,
          name: args.name.trim() || `Sparky ${tag}`,
          channel: args.channel,
          status: "published" as const,
          changelog,
          createdAt: publishedAt,
          publishedAt,
          files,
        };
    const releaseId = existing ? existing._id : await ctx.db.insert("releases", release);
    if (existing) await ctx.db.replace(existing._id, release);
    const pointer = await ctx.db.query("releasePointers").withIndex("by_channel", (q) => q.eq("channel", args.channel)).unique();
    if (pointer) await ctx.db.patch(pointer._id, { releaseId, updatedAt: publishedAt });
    else await ctx.db.insert("releasePointers", { channel: args.channel, releaseId, updatedAt: publishedAt });
    return publicRelease({ ...release, _id: releaseId });
  },
});

export const manifest = query({
  args: { channel: v.optional(channelValidator) },
  returns: v.union(publicReleaseValidator, v.null()),
  handler: async (ctx, args) => {
    const release = await pointedRelease(ctx, args.channel ?? "release");
    return release ? publicRelease(release) : null;
  },
});

export const listPublished = query({
  args: {},
  returns: v.array(publicReleaseValidator),
  handler: async (ctx) => {
    // The public changelog is intentionally a clean current-release surface.
    // Historical release rows remain available to administrators, but old
    // entries must not be presented as part of Sparky's initial public launch.
    const release = await pointedRelease(ctx, "release");
    return release ? [publicRelease(release)] : [];
  },
});

export const updateMetadata = internalQuery({
  args: { channel: channelValidator, platform: platformValidator },
  returns: v.union(updateMetadataValidator, v.null()),
  handler: async (ctx, args) => {
    const release = await pointedRelease(ctx, args.channel);
    if (!release) return null;

    const platform = args.platform;
    if (platform === "linux-x64") return null;
    const installerExtension = platform === "windows-x64" ? ".exe" : ".dmg";
    const feedName = args.channel === "beta"
      ? platform === "windows-x64" ? "nightly.yml" : "nightly-mac.yml"
      : platform === "windows-x64" ? "latest.yml" : "latest-mac.yml";
    const feed = release.files.find(
      (file) => file.platform === args.platform && file.name === feedName && file.uploaded,
    );
    const installer = release.files.find(
      (file) => file.platform === args.platform && file.name.endsWith(installerExtension) && file.uploaded,
    );
    const feedUrl = feed ? publicAssetUrl(feed) : null;
    const installerUrl = installer ? publicAssetUrl(installer) : null;
    if (!feed || !installer || !feedUrl || !installerUrl) return null;

    return {
      version: release.tag.replace(/^v/u, ""),
      name: release.name,
      channel: release.channel,
      changelog: release.changelog,
      publishedAt: release.publishedAt ?? null,
      platform: args.platform,
      feedUrl,
      installer: {
        name: installer.name,
        size: installer.size,
        contentType: installer.contentType,
        url: installerUrl,
        sha256: installer.sha256 ?? null,
      },
    };
  },
});

export const getDraftForAwsUpload = internalQuery({
  args: { id: v.id("releases"), name: v.string(), platform: platformValidator },
  returns: v.union(v.object({
    tag: v.string(),
    channel: channelValidator,
    name: v.string(),
    size: v.number(),
    contentType: v.string(),
    platform: platformValidator,
    sha256: v.union(v.string(), v.null()),
  }), v.null()),
  handler: async (ctx, args) => {
    const release = await ctx.db.get(args.id);
    if (!release || release.status !== "draft") return null;
    const file = release.files.find((candidate) => candidate.name === args.name && candidate.platform === args.platform);
    if (!file) return null;
    return {
      tag: release.tag,
      channel: release.channel,
      name: file.name,
      size: file.size,
      contentType: file.contentType,
      platform: args.platform,
      sha256: file.sha256 ?? null,
    };
  },
});

export const getDraftForAwsPublish = internalQuery({
  args: { id: v.id("releases") },
  returns: v.union(v.object({
    id: v.id("releases"),
    tag: v.string(),
    name: v.string(),
    channel: channelValidator,
    changelog: v.string(),
    files: v.array(v.object({
      name: v.string(),
      size: v.number(),
      contentType: v.string(),
      platform: platformValidator,
      sha256: v.union(v.string(), v.null()),
    })),
  }), v.null()),
  handler: async (ctx, args) => {
    const release = await ctx.db.get(args.id);
    if (!release || release.status !== "draft") return null;
    if (release.files.some((file) => !file.platform)) return null;
    return {
      id: release._id,
      tag: release.tag,
      name: release.name,
      channel: release.channel,
      changelog: release.changelog,
      files: release.files.map((file) => ({
        name: file.name,
        size: file.size,
        contentType: file.contentType,
        platform: file.platform!,
        sha256: file.sha256 ?? null,
      })),
    };
  },
});

export const publishAwsInternal = internalMutation({
  args: {
    id: v.id("releases"),
    files: v.array(v.object({ name: v.string(), platform: platformValidator, awsKey: v.string() })),
  },
  returns: publicReleaseValidator,
  handler: async (ctx, args) => {
    const release = await ctx.db.get(args.id);
    if (!release) throw new Error("Release not found.");
    if (release.status !== "draft") throw new Error("This release is already published.");
    const keys = new Map(args.files.map((file) => [`${file.platform}:${file.name}`, file.awsKey]));
    const files = release.files.map((file) => {
      if (!file.platform) throw new Error(`Missing platform for ${file.name}.`);
      const awsKey = keys.get(`${file.platform}:${file.name}`);
      if (!awsKey) throw new Error(`AWS upload is missing for ${file.name}.`);
      return { ...file, uploaded: true, awsKey, chunks: [] };
    });
    const publishedAt = Date.now();
    await ctx.db.patch(release._id, { status: "published", publishedAt, files });
    const pointer = await ctx.db.query("releasePointers").withIndex("by_channel", (q) => q.eq("channel", release.channel)).unique();
    if (pointer) await ctx.db.patch(pointer._id, { releaseId: release._id, updatedAt: publishedAt });
    else await ctx.db.insert("releasePointers", { channel: release.channel, releaseId: release._id, updatedAt: publishedAt });
    return publicRelease({ ...release, status: "published", publishedAt, files });
  },
});

export const asset = query({
  args: { channel: channelValidator, name: v.optional(v.string()) },
  returns: v.union(v.object({
    release: publicReleaseValidator,
    name: v.string(),
    size: v.number(),
    contentType: v.string(),
    chunks: v.array(v.object({ size: v.number(), url: v.string() })),
  }), v.null()),
  handler: async (ctx, args) => {
    const release = await pointedRelease(ctx, args.channel);
    if (!release) return null;
    const file = args.name ? release.files.find((candidate) => candidate.name === args.name) : null;
    if (!file) return null;
    const urls = await Promise.all(file.chunks.map((chunk) => ctx.storage.getUrl(chunk.storageId)));
    if (urls.some((url) => !url)) return null;
    return {
      release: publicRelease(release),
      name: file.name,
      size: file.size,
      contentType: file.contentType,
      chunks: file.chunks.map((chunk, index) => ({ size: chunk.size, url: urls[index]! })),
    };
  },
});
