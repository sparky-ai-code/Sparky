"use node";

import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const ADMIN_EMAIL = "soliamanmagbari@gmail.com";
const platformValidator = v.union(
  v.literal("windows-x64"),
  v.literal("macos-arm64"),
  v.literal("macos-x64"),
  v.literal("linux-x64"),
);

type Platform = "windows-x64" | "macos-arm64" | "macos-x64" | "linux-x64";
type UploadDraftFile = {
  tag: string;
  channel: "release" | "beta";
  name: string;
  size: number;
  contentType: string;
  platform: Platform;
  sha256: string | null;
};
type PublishDraft = {
  id: Id<"releases">;
  tag: string;
  name: string;
  channel: "release" | "beta";
  changelog: string;
  files: Array<{
    name: string;
    size: number;
    contentType: string;
    platform: Platform;
    sha256: string | null;
  }>;
};
type UploadUrlResult = {
  uploadUrl: string | null;
  key: string;
  expiresAt: number | null;
  alreadyUploaded: boolean;
  sha256: string | null;
};
type PublishResult = { version: string; publishedAt: number; fileCount: number };

async function requireAdmin(ctx: { auth: { getUserIdentity(): Promise<{ email?: string } | null> } }) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity || identity.email?.toLowerCase() !== ADMIN_EMAIL) {
    throw new Error("Administrator access is required.");
  }
}

function awsConfig() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY?.trim();
  const region = process.env.AWS_REGION?.trim() || "us-east-1";
  const bucket = process.env.AWS_RELEASE_BUCKET?.trim();
  const publicBaseUrl = process.env.AWS_RELEASE_PUBLIC_BASE_URL?.trim().replace(/\/+$/u, "");
  if (!accessKeyId || !secretAccessKey || !bucket || !publicBaseUrl?.startsWith("https://")) {
    throw new Error("AWS release publishing is not configured.");
  }
  return {
    bucket,
    publicBaseUrl,
    client: new S3Client({
      region,
      // The browser supplies the object body after this action returns. Newer
      // AWS SDK versions otherwise presign the CRC32 of an empty body, which
      // makes S3 reject every non-empty browser upload.
      requestChecksumCalculation: "WHEN_REQUIRED",
      credentials: { accessKeyId, secretAccessKey },
    }),
  };
}

function releaseVersion(tag: string) {
  return tag.replace(/^v/u, "");
}

function platformDirectory(platform: Platform) {
  if (platform === "windows-x64") return "windows";
  if (platform === "macos-arm64") return "macos/arm64";
  if (platform === "macos-x64") return "macos/x64";
  return "linux";
}

function releaseKey(tag: string, platform: Platform, name: string) {
  return `releases/${releaseVersion(tag)}/${platformDirectory(platform)}/${name}`;
}

function publicUrl(baseUrl: string, key: string) {
  return `${baseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function isMissingObject(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: string;
    message?: string;
    Code?: string;
    code?: string;
    constructor?: { name?: string };
    $metadata?: { httpStatusCode?: number };
  };
  const label = [candidate.name, candidate.Code, candidate.code, candidate.message, candidate.constructor?.name]
    .filter(Boolean)
    .join(" ");
  return candidate.$metadata?.httpStatusCode === 404 || /NotFound|NoSuchKey/iu.test(label);
}

function awsErrorName(error: unknown) {
  if (!error || typeof error !== "object") return "Unknown AWS error";
  const candidate = error as { name?: string; message?: string; $metadata?: { requestId?: string } };
  return [candidate.name, candidate.message, candidate.$metadata?.requestId && `request ${candidate.$metadata.requestId}`]
    .filter(Boolean)
    .join(": ") || "Unknown AWS error";
}

export const createUploadUrl = action({
  args: { id: v.id("releases"), name: v.string(), platform: platformValidator },
  returns: v.object({
    uploadUrl: v.union(v.string(), v.null()),
    key: v.string(),
    expiresAt: v.union(v.number(), v.null()),
    alreadyUploaded: v.boolean(),
    sha256: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args): Promise<UploadUrlResult> => {
    await requireAdmin(ctx);
    const file: UploadDraftFile | null = await ctx.runQuery(internal.releases.getDraftForAwsUpload, args);
    if (!file) throw new Error("The release file is not part of an active draft.");
    const { bucket, client } = awsConfig();
    const key = releaseKey(file.tag, file.platform, file.name);
    const sha256: string | null = file.sha256?.toLowerCase() ?? null;
    try {
      const existing = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      const existingSha256 = existing.Metadata?.sha256?.toLowerCase();
      if (existing.ContentLength === file.size && (!sha256 || existingSha256 === sha256)) {
        return { uploadUrl: null, key, expiresAt: null, alreadyUploaded: true, sha256 };
      }
    } catch (error) {
      if (!isMissingObject(error)) throw error;
    }
    const expiresIn = 60 * 60;
    const uploadUrl = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: file.contentType,
        CacheControl: "public, max-age=31536000, immutable",
        Metadata: sha256 ? { sha256 } : undefined,
      }),
      { expiresIn },
    );
    return {
      uploadUrl,
      key,
      expiresAt: Date.now() + expiresIn * 1_000,
      alreadyUploaded: false,
      sha256,
    };
  },
});

export const publish = action({
  args: { id: v.id("releases") },
  returns: v.object({ version: v.string(), publishedAt: v.number(), fileCount: v.number() }),
  handler: async (ctx, args): Promise<PublishResult> => {
    await requireAdmin(ctx);
    const release: PublishDraft | null = await ctx.runQuery(internal.releases.getDraftForAwsPublish, args);
    if (!release) throw new Error("The AWS release draft is missing or already published.");
    const { bucket, client, publicBaseUrl } = awsConfig();
    const files: Array<PublishDraft["files"][number] & { awsKey: string }> = release.files.map((file) => ({
      ...file,
      awsKey: releaseKey(release.tag, file.platform, file.name),
    }));

    await Promise.all(files.map(async (file) => {
      let object: HeadObjectCommandOutput;
      try {
        object = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: file.awsKey }));
      } catch (error) {
        if (isMissingObject(error)) {
          throw new Error(`AWS upload is missing for ${file.platform}/${file.name}. Reselect all release files and run Update all platforms again.`);
        }
        throw new Error(`AWS could not verify ${file.platform}/${file.name}: ${awsErrorName(error)}.`);
      }
      if (object.ContentLength !== file.size) {
        throw new Error(`AWS upload size mismatch for ${file.platform}/${file.name}.`);
      }
      const expectedSha256 = file.sha256?.toLowerCase();
      const uploadedSha256 = object.Metadata?.sha256?.toLowerCase();
      if (expectedSha256 && uploadedSha256 !== expectedSha256) {
        throw new Error(`AWS checksum mismatch for ${file.platform}/${file.name}.`);
      }
    }));

    const publishedAt = Date.now();
    const manifest = {
      schemaVersion: 1,
      id: release.id,
      version: releaseVersion(release.tag),
      name: release.name,
      channel: release.channel,
      changelog: release.changelog,
      publishedAt: new Date(publishedAt).toISOString(),
      files: files.map((file) => ({
        name: file.name,
        platform: file.platform,
        size: file.size,
        contentType: file.contentType,
        sha256: file.sha256,
        key: file.awsKey,
        url: publicUrl(publicBaseUrl, file.awsKey),
      })),
    };
    const body = JSON.stringify(manifest, null, 2);
    const version = releaseVersion(release.tag);
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `releases/${version}/manifest.json`,
      Body: body,
      ContentType: "application/json; charset=utf-8",
      CacheControl: "public, max-age=31536000, immutable",
    }));
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: "releases/latest.json",
      Body: body,
      ContentType: "application/json; charset=utf-8",
      CacheControl: "no-store, max-age=0",
    }));

    await ctx.runMutation(internal.releases.publishAwsInternal, {
      id: release.id,
      files: files.map((file) => ({ name: file.name, platform: file.platform, awsKey: file.awsKey })),
    });
    return { version, publishedAt, fileCount: files.length };
  },
});
