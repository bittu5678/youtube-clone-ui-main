import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getPersistentDataDir, isTestStorageIsolationActive } from "./payments.ts";

export type VideoVisibility = "public" | "unlisted" | "private";

export const VALID_VIDEO_VISIBILITIES: readonly VideoVisibility[] = [
  "public",
  "unlisted",
  "private",
] as const;

export const PRIVATE_MEDIA_PREFIX = "private_media://";

export const MEDIA_MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "video/ogg",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export function normalizeVideoVisibility(
  raw: unknown,
  defaultValue: VideoVisibility = "public",
): VideoVisibility | null {
  if (raw === undefined || raw === null) {
    return defaultValue;
  }
  const str = String(raw).trim().toLowerCase();
  if (str === "") {
    return defaultValue;
  }
  if (str === "public" || str === "unlisted" || str === "private") {
    return str;
  }
  return null;
}

export function validateVisibilityRules(params: {
  visibility: VideoVisibility;
  videoType: string;
  paymentStatus: string;
  isPromoted?: boolean;
  isSponsored?: boolean;
  globalPoolEligible?: boolean;
}): { valid: true } | { valid: false; error: string } {
  const { visibility, videoType, paymentStatus, isPromoted, isSponsored, globalPoolEligible } =
    params;

  if (isPromoted || isSponsored || globalPoolEligible) {
    if (visibility !== "public") {
      return {
        valid: false,
        error: "Sponsored and Global Pool eligible videos must use 'public' visibility.",
      };
    }
    return { valid: true };
  }

  if (videoType === "premium" || paymentStatus === "paid") {
    if (visibility === "private") {
      return {
        valid: false,
        error: "Paid Premium videos can only use 'public' or 'unlisted' visibility.",
      };
    }
    return { valid: true };
  }

  return { valid: true };
}

export function getPrivateStorageRoot(env?: Record<string, string | undefined>): string {
  if (isTestStorageIsolationActive(env)) {
    return path.join(getPersistentDataDir(env), "private_storage");
  }
  return path.resolve(process.cwd(), "storage");
}

export function getPrivateMediaDir(
  subfolder: "videos" | "images",
  env?: Record<string, string | undefined>,
): string {
  return path.join(getPrivateStorageRoot(env), `private_${subfolder}`);
}

export function getPublicUploadsDir(subfolder: "videos" | "images"): string {
  return path.resolve(process.cwd(), "uploads", subfolder);
}

export function extractLocalUploadReference(
  rawUrl: string | undefined | null,
): { subfolder: "videos" | "images"; fileName: string } | null {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  let pathname = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const host = parsed.hostname.toLowerCase();
      const isLocalOrFacetubeHost =
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "facetube.online" ||
        host === "www.facetube.online" ||
        host === "api.facetube.online" ||
        host.endsWith(".facetube.online");
      if (!isLocalOrFacetubeHost) {
        return null;
      }
      pathname = parsed.pathname;
    } catch {
      return null;
    }
  }

  const normalized = pathname.replace(/\\/g, "/");
  const match = normalized.match(/^\/?uploads\/(videos|images)\/([^/?#]+)$/i);
  if (!match) return null;

  const subfolder = match[1]!.toLowerCase() as "videos" | "images";
  const fileName = path.basename(decodeURIComponent(match[2]!));
  if (!fileName || fileName === "." || fileName === ".." || fileName.includes("..")) {
    return null;
  }
  return { subfolder, fileName };
}

export function extractPrivateMediaReference(
  rawUrl: string | undefined | null,
): { subfolder: "videos" | "images"; fileName: string } | null {
  if (!rawUrl || typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed.startsWith(PRIVATE_MEDIA_PREFIX)) return null;

  const rel = trimmed.slice(PRIVATE_MEDIA_PREFIX.length);
  const match = rel.match(/^(videos|images)\/([^/?#]+)$/i);
  if (!match) return null;

  const subfolder = match[1]!.toLowerCase() as "videos" | "images";
  const fileName = path.basename(match[2]!);
  if (!fileName || fileName === "." || fileName === ".." || fileName.includes("..")) {
    return null;
  }
  return { subfolder, fileName };
}

export async function moveLocalMediaToPrivate(
  rawUrl: string,
  expectedSubfolder: "videos" | "images",
  env?: Record<string, string | undefined>,
): Promise<string> {
  if (extractPrivateMediaReference(rawUrl)) {
    return rawUrl.trim();
  }

  const localRef = extractLocalUploadReference(rawUrl);
  if (!localRef) {
    return rawUrl;
  }

  const subfolder = localRef.subfolder || expectedSubfolder;
  const fileName = localRef.fileName;
  const publicDir = getPublicUploadsDir(subfolder);
  const publicPath = path.join(publicDir, fileName);
  const privateDir = getPrivateMediaDir(subfolder, env);
  const privatePath = path.join(privateDir, fileName);

  await fs.promises.mkdir(privateDir, { recursive: true });

  try {
    await fs.promises.stat(publicPath);
    try {
      await fs.promises.rename(publicPath, privatePath);
    } catch {
      await fs.promises.copyFile(publicPath, privatePath);
      await fs.promises.unlink(publicPath).catch(() => {});
    }
  } catch {
    // Even if file wasn't physically created on disk (e.g. unit test metadata),
    // convert local /uploads/... reference to private_media:// so public URL is never exposed.
  }

  // Ensure any duplicate copy in api/uploads/{subfolder} is also removed
  const apiPublicPath = path.resolve(process.cwd(), "api", "uploads", subfolder, fileName);
  try {
    const stat = await fs.promises.stat(apiPublicPath);
    if (stat.isFile()) {
      try {
        await fs.promises.stat(privatePath);
      } catch {
        await fs.promises.copyFile(apiPublicPath, privatePath);
      }
      await fs.promises.unlink(apiPublicPath).catch(() => {});
    }
  } catch {
    // Ignore if absent
  }

  return `${PRIVATE_MEDIA_PREFIX}${subfolder}/${fileName}`;
}

export async function restorePrivateMediaToPublic(
  rawUrl: string,
  env?: Record<string, string | undefined>,
): Promise<string> {
  const privRef = extractPrivateMediaReference(rawUrl);
  if (!privRef) {
    return rawUrl;
  }

  const privatePath = path.join(getPrivateMediaDir(privRef.subfolder, env), privRef.fileName);
  const publicDir = getPublicUploadsDir(privRef.subfolder);
  const publicPath = path.join(publicDir, privRef.fileName);

  await fs.promises.mkdir(publicDir, { recursive: true });
  try {
    await fs.promises.stat(privatePath);
    try {
      await fs.promises.rename(privatePath, publicPath);
    } catch {
      await fs.promises.copyFile(privatePath, publicPath);
      await fs.promises.unlink(privatePath).catch(() => {});
    }
  } catch {
    // Ignore if missing
  }

  return `/uploads/${privRef.subfolder}/${privRef.fileName}`;
}

export function isFileInPrivateMediaStorage(
  subfolder: "videos" | "images",
  fileName: string,
  env?: Record<string, string | undefined>,
): boolean {
  const safeName = path.basename(fileName);
  if (!safeName || safeName === "." || safeName === "..") return false;
  const candidatePaths = [
    path.join(getPrivateMediaDir(subfolder, env), safeName),
    path.resolve(process.cwd(), "storage", `private_${subfolder}`, safeName),
    path.resolve(process.cwd(), "api", "storage", `private_${subfolder}`, safeName),
  ];
  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

export function getMediaSigningSecret(env?: Record<string, string | undefined>): string {
  const sourceEnv = env || process.env;
  const explicit =
    sourceEnv["FACETUBE_MEDIA_SECRET"] ||
    sourceEnv["ADMOB_ENCRYPTION_KEY"] ||
    sourceEnv["RAZORPAY_KEY_SECRET"] ||
    "";
  if (explicit.trim().length >= 16) {
    return explicit.trim();
  }

  const root = getPrivateStorageRoot(env);
  const keyFile = path.join(root, ".media_signing_key");
  try {
    if (fs.existsSync(keyFile)) {
      const existing = fs.readFileSync(keyFile, "utf8").trim();
      if (existing.length >= 32) {
        return existing;
      }
    }
    fs.mkdirSync(root, { recursive: true });
    const generated = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(keyFile, generated, { mode: 0o600 });
    return generated;
  } catch {
    return crypto.createHash("sha256").update(process.cwd()).digest("hex");
  }
}

export function signPrivateMediaUrl(
  videoId: string,
  kind: "video" | "thumbnail",
  env?: Record<string, string | undefined>,
  ttlSeconds = 600,
): string {
  const exp = Math.floor(Date.now() / 1000) + Math.max(60, ttlSeconds);
  const secret = getMediaSigningSecret(env);
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`media:${videoId}:${kind}:${exp}`)
    .digest("hex");
  return `/api/videos/media?id=${encodeURIComponent(videoId)}&kind=${kind}&exp=${exp}&sig=${sig}`;
}

export function verifyPrivateMediaSignature(
  videoId: string,
  kind: "video" | "thumbnail",
  expRaw: string | null,
  sigRaw: string | null,
  env?: Record<string, string | undefined>,
): boolean {
  if (!expRaw || !sigRaw) return false;
  const exp = Number.parseInt(expRaw, 10);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) {
    return false;
  }
  const secret = getMediaSigningSecret(env);
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`media:${videoId}:${kind}:${exp}`)
    .digest("hex");
  const sigBuf = Buffer.from(sigRaw.trim(), "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

export function resolvePrivateMediaOutputUrl(params: {
  storedUrl: string | undefined | null;
  videoId: string;
  visibility: VideoVisibility;
  kind: "video" | "thumbnail";
  canAccessPrivate: boolean;
  env?: Record<string, string | undefined> | undefined;
}): string {
  const raw = (params.storedUrl || "").trim();
  if (!raw) return "";

  const privRef = extractPrivateMediaReference(raw);
  if (privRef) {
    if (!params.canAccessPrivate) {
      return "";
    }
    return signPrivateMediaUrl(params.videoId, params.kind, params.env);
  }

  if (params.visibility === "private" && !params.canAccessPrivate) {
    return "";
  }

  return raw;
}

export async function resolvePrivateMediaDiskPath(
  storedUrl: string,
  env?: Record<string, string | undefined>,
): Promise<string | null> {
  const privRef = extractPrivateMediaReference(storedUrl);
  const localRef = privRef || extractLocalUploadReference(storedUrl);
  if (!localRef) return null;

  const candidates = [
    path.join(getPrivateMediaDir(localRef.subfolder, env), localRef.fileName),
    path.resolve(process.cwd(), "storage", `private_${localRef.subfolder}`, localRef.fileName),
    path.resolve(
      process.cwd(),
      "api",
      "storage",
      `private_${localRef.subfolder}`,
      localRef.fileName,
    ),
    path.join(getPublicUploadsDir(localRef.subfolder), localRef.fileName),
  ];

  for (const candidate of candidates) {
    try {
      const stat = await fs.promises.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // continue
    }
  }
  return null;
}

export async function streamPrivateFileWithRange(
  request: Request,
  fullPath: string,
): Promise<Response> {
  const stats = await fs.promises.stat(fullPath);
  const ext = path.extname(fullPath).toLowerCase();
  const contentType = MEDIA_MIME_TYPES[ext] || "application/octet-stream";
  const fileSize = stats.size;
  const rangeHeader = request.headers.get("Range") || request.headers.get("range");

  const baseHeaders: Record<string, string> = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store, no-cache, must-revalidate",
    "X-Content-Type-Options": "nosniff",
  };

  if (rangeHeader && rangeHeader.startsWith("bytes=")) {
    const parts = rangeHeader.replace(/bytes=/, "").split("-");
    const startStr = parts[0];
    const endStr = parts[1];

    let start = startStr ? parseInt(startStr, 10) : 0;
    let end = endStr ? parseInt(endStr, 10) : fileSize - 1;

    if (Number.isNaN(start)) start = 0;
    if (Number.isNaN(end) || end >= fileSize) end = fileSize - 1;

    if (start > end || start >= fileSize) {
      return new Response(null, {
        status: 416,
        headers: {
          ...baseHeaders,
          "Content-Range": `bytes */${fileSize}`,
        },
      });
    }

    const chunkSize = end - start + 1;
    const nodeStream = fs.createReadStream(fullPath, { start, end });
    const webStream = new ReadableStream({
      start(controller) {
        nodeStream.on("data", (chunk) => controller.enqueue(chunk));
        nodeStream.on("end", () => controller.close());
        nodeStream.on("error", (err) => controller.error(err));
      },
      cancel() {
        nodeStream.destroy();
      },
    });

    return new Response(webStream, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Content-Length": chunkSize.toString(),
        "Content-Type": contentType,
      },
    });
  }

  const nodeStream = fs.createReadStream(fullPath);
  const webStream = new ReadableStream({
    start(controller) {
      nodeStream.on("data", (chunk) => controller.enqueue(chunk));
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
    cancel() {
      nodeStream.destroy();
    },
  });

  return new Response(webStream, {
    status: 200,
    headers: {
      ...baseHeaders,
      "Content-Length": fileSize.toString(),
      "Content-Type": contentType,
    },
  });
}
