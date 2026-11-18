import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Pool, PoolConnection } from "mysql2/promise";
import { isProductionRuntimeEnv } from "./payments.ts";

export interface RecoveryAuthUser {
  id: string;
  user_id: string;
  name: string;
  role: string;
}

export interface RecoveryMediaDirs {
  videos: string[];
  images: string[];
}

export interface RecoveryHandlerOptions {
  pool: Pool | null;
  env?: Record<string, string | undefined> | undefined;
  fetchImpl?: typeof fetch | undefined;
  mediaDirs?: RecoveryMediaDirs | undefined;
  getAuthUser: (request: Request) => Promise<RecoveryAuthUser | null>;
  apiBaseUrl?: string | undefined;
}

export interface NormalizedRecoveryItem {
  userId: string;
  userUuid: string;
  paymentId: string;
  orderId: string;
  videoId: string;
  contentType: "long" | "short";
  title: string;
  category: string;
  description: string;
  duration: string;
  videoFilename: string;
  thumbnailFilename: string;
  amount: number;
  amountPaise: number;
}

export interface VerifiedRecoveryItem extends NormalizedRecoveryItem {
  canonicalUserId: string;
  creatorName: string;
  userUuidVerified: string;
  referralCode: string;
  videoUrl: string;
  thumbnailUrl: string;
  videoFileBytes: number;
  thumbnailFileBytes: number;
  razorpayPaymentCreatedAt: number;
  razorpayOrderCreatedAt: number;
}

export interface CreatorPayoutItem {
  userId: string;
  videoId: string;
  amount: number;
  amountPaise: number;
  weight: number;
  adEarnings: number;
}

export interface ItemAccountingResult {
  txNumber: number;
  isSpecial: boolean;
  specialTag: "SPECIAL_GLOBAL_RULE" | "NORMAL_PREMIUM";
  referrerId: string | null;
  adminUserId: string;
  referralCommission: number;
  adminAllocation: number;
  globalPoolAllocation: number;
  eligibleVideosCount: number;
  creatorPayouts: CreatorPayoutItem[];
}

const PREMIUM_RECOVERY_LOCK_NAME = "facetube_premium_tx_seq";

function jsonRecoveryResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Authorization",
    },
  });
}

function readEnvString(key: string, env?: Record<string, string | undefined>): string {
  const fromProvided = env ? env[key] : undefined;
  if (typeof fromProvided === "string" && fromProvided.trim() !== "") {
    return fromProvided.trim();
  }
  const fromProcess = process.env[key];
  if (typeof fromProcess === "string" && fromProcess.trim() !== "") {
    return fromProcess.trim();
  }
  return "";
}

export function parseRecoveryDryRunFlag(rawValue: unknown): boolean {
  if (rawValue === false || rawValue === 0 || rawValue === "0") {
    return false;
  }
  if (typeof rawValue === "string" && rawValue.trim().toLowerCase() === "false") {
    return false;
  }
  return true;
}

function validateSafeMediaFilename(
  rawName: unknown,
  label: string,
): { ok: true; filename: string } | { ok: false; error: string } {
  if (typeof rawName !== "string") {
    return { ok: false, error: `${label} must be a string.` };
  }
  const name = rawName.trim();
  if (!name) {
    return { ok: false, error: `${label} is required.` };
  }
  if (
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..") ||
    name.includes("\0") ||
    !/^[A-Za-z0-9._-]+$/.test(name)
  ) {
    return {
      ok: false,
      error: `${label} must be a safe basename without path separators or traversal sequences.`,
    };
  }
  return { ok: true, filename: name };
}

function getDefaultMediaDirs(): RecoveryMediaDirs {
  const cwd = process.cwd();
  return {
    videos: [path.resolve(cwd, "api/uploads/videos"), path.resolve(cwd, "uploads/videos")],
    images: [path.resolve(cwd, "api/uploads/images"), path.resolve(cwd, "uploads/images")],
  };
}

function resolveMediaFileOnDisk(
  dirs: string[],
  filename: string,
): { exists: boolean; path: string | null; size: number } {
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      const realDir = fs.realpathSync(dir);
      const statDir = fs.statSync(realDir);
      if (!statDir.isDirectory()) continue;

      const candidate = path.join(realDir, filename);
      if (!fs.existsSync(candidate)) continue;
      const realCandidate = fs.realpathSync(candidate);
      if (!realCandidate.startsWith(realDir + path.sep)) continue;

      const statFile = fs.statSync(realCandidate);
      if (statFile.isFile() && statFile.size > 0) {
        return { exists: true, path: realCandidate, size: statFile.size };
      }
    } catch {
      // Try next configured storage directory
    }
  }
  return { exists: false, path: null, size: 0 };
}

function resolveBaseUrl(
  request: Request,
  env?: Record<string, string | undefined>,
  explicitBaseUrl?: string,
): string {
  if (explicitBaseUrl && explicitBaseUrl.trim() !== "") {
    return explicitBaseUrl.trim().replace(/\/+$/, "");
  }
  const envBase = readEnvString("FACETUBE_API_BASE_URL", env) || readEnvString("API_BASE_URL", env);
  if (envBase) {
    return envBase.replace(/\/+$/, "");
  }
  try {
    const parsed = new URL(request.url);
    if (parsed.origin && parsed.origin !== "null") {
      return parsed.origin.replace(/\/+$/, "");
    }
  } catch {
    // Fallback below
  }
  return "https://api.facetube.online";
}

function isValidUtf8Text(value: string): boolean {
  // Reject lone UTF-16 surrogates that cannot encode valid UTF-8
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function readStrictStringField(
  item: Record<string, unknown>,
  keys: string[],
  fieldLabel: string,
  idx: number,
  required: boolean,
  defaultValue = "",
): { ok: true; value: string } | { ok: false; error: string } {
  for (const key of keys) {
    if (key in item) {
      const val = item[key];
      if (typeof val !== "string") {
        return {
          ok: false,
          error: `Item ${idx}: ${fieldLabel} must be a string.`,
        };
      }
      const trimmed = val.trim();
      if (required && trimmed === "") {
        return {
          ok: false,
          error: `Item ${idx}: ${fieldLabel} must be a non-empty string.`,
        };
      }
      return { ok: true, value: trimmed };
    }
  }

  if (required) {
    return {
      ok: false,
      error: `Item ${idx}: ${fieldLabel} is required and must be a string.`,
    };
  }

  return { ok: true, value: defaultValue };
}

function normalizeAndValidateItems(
  input: Record<string, unknown>,
): { ok: true; items: NormalizedRecoveryItem[] } | { ok: false; error: string } {
  let rawItems: unknown[];
  if ("items" in input) {
    if (!Array.isArray(input["items"]) || input["items"].length === 0) {
      return {
        ok: false,
        error: "items must be a non-empty array of payment recovery objects.",
      };
    }
    rawItems = input["items"];
  } else {
    rawItems = [input];
  }

  const normalized: NormalizedRecoveryItem[] = [];
  const seenPaymentIds = new Set<string>();
  const seenOrderIds = new Set<string>();
  const seenVideoIds = new Set<string>();
  const seenVideoFiles = new Set<string>();
  const seenThumbFiles = new Set<string>();

  for (let idx = 0; idx < rawItems.length; idx += 1) {
    const raw = rawItems[idx];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        ok: false,
        error: `Recovery item at index ${idx} must be an object.`,
      };
    }
    const item = raw as Record<string, unknown>;

    const userIdRes = readStrictStringField(item, ["userId", "user_id"], "userId", idx, true);
    if (!userIdRes.ok) return userIdRes;
    const userId = userIdRes.value;

    const userUuidRes = readStrictStringField(
      item,
      ["userUuid", "user_uuid"],
      "userUuid",
      idx,
      false,
      "",
    );
    if (!userUuidRes.ok) return userUuidRes;
    const userUuid = userUuidRes.value;

    const paymentIdRes = readStrictStringField(
      item,
      ["paymentId", "payment_id"],
      "paymentId",
      idx,
      true,
    );
    if (!paymentIdRes.ok) return paymentIdRes;
    const paymentId = paymentIdRes.value;

    const orderIdRes = readStrictStringField(item, ["orderId", "order_id"], "orderId", idx, true);
    if (!orderIdRes.ok) return orderIdRes;
    const orderId = orderIdRes.value;

    const videoIdRes = readStrictStringField(item, ["videoId", "video_id"], "videoId", idx, true);
    if (!videoIdRes.ok) return videoIdRes;
    const videoId = videoIdRes.value;

    const contentTypeRes = readStrictStringField(
      item,
      ["contentType", "content_type"],
      "contentType",
      idx,
      true,
    );
    if (!contentTypeRes.ok) return contentTypeRes;
    const contentTypeRaw = contentTypeRes.value.toLowerCase();

    const titleRes = readStrictStringField(item, ["title"], "title", idx, true);
    if (!titleRes.ok) return titleRes;
    const title = titleRes.value;

    const categoryRes = readStrictStringField(item, ["category"], "category", idx, true);
    if (!categoryRes.ok) return categoryRes;
    const category = categoryRes.value;

    const descriptionRes = readStrictStringField(
      item,
      ["description"],
      "description",
      idx,
      false,
      "",
    );
    if (!descriptionRes.ok) return descriptionRes;
    const description = descriptionRes.value;

    const durationRes = readStrictStringField(item, ["duration"], "duration", idx, false, "0:00");
    if (!durationRes.ok) return durationRes;
    const duration = durationRes.value === "" ? "0:00" : durationRes.value;

    const rawVideoRes = readStrictStringField(
      item,
      ["videoFilename", "video_filename", "videoFile", "video_file"],
      "videoFilename",
      idx,
      true,
    );
    if (!rawVideoRes.ok) return rawVideoRes;

    const rawThumbRes = readStrictStringField(
      item,
      ["thumbnailFilename", "thumbnail_filename", "thumbnailFile", "thumbnail_file"],
      "thumbnailFilename",
      idx,
      true,
    );
    if (!rawThumbRes.ok) return rawThumbRes;

    if (contentTypeRaw !== "long" && contentTypeRaw !== "short") {
      return {
        ok: false,
        error: `Item ${idx}: contentType must be strictly 'long' or 'short'.`,
      };
    }

    if (title.length > 500 || category.length > 100 || duration.length > 50) {
      return {
        ok: false,
        error: `Item ${idx}: title, category, or duration exceeds database column limits.`,
      };
    }

    if (
      !isValidUtf8Text(title) ||
      !isValidUtf8Text(category) ||
      !isValidUtf8Text(description) ||
      !isValidUtf8Text(duration)
    ) {
      return {
        ok: false,
        error: `Item ${idx}: title, category, description, and duration must be valid UTF-8 strings.`,
      };
    }

    const vCheck = validateSafeMediaFilename(rawVideoRes.value, `Item ${idx} videoFilename`);
    if (!vCheck.ok) {
      return { ok: false, error: vCheck.error };
    }

    const tCheck = validateSafeMediaFilename(rawThumbRes.value, `Item ${idx} thumbnailFilename`);
    if (!tCheck.ok) {
      return { ok: false, error: tCheck.error };
    }

    if ("expectedAmountPaise" in item) {
      const rawExpected = item["expectedAmountPaise"];
      const isValidExpected =
        (typeof rawExpected === "number" && rawExpected === 600) ||
        (typeof rawExpected === "string" &&
          /^\d+$/.test(rawExpected.trim()) &&
          Number(rawExpected.trim()) === 600);
      if (!isValidExpected) {
        return {
          ok: false,
          error: `Item ${idx}: premium_video_upload amount must be strictly 600 paise (₹6.00).`,
        };
      }
    }

    const pKey = paymentId.toLowerCase();
    const oKey = orderId.toLowerCase();
    const vKey = videoId.toLowerCase();
    if (
      seenPaymentIds.has(pKey) ||
      seenOrderIds.has(oKey) ||
      seenVideoIds.has(vKey) ||
      seenVideoFiles.has(vCheck.filename) ||
      seenThumbFiles.has(tCheck.filename)
    ) {
      return {
        ok: false,
        error: `Duplicate recovery target detected in request batch (paymentId=${paymentId}, orderId=${orderId}, videoId=${videoId}).`,
      };
    }

    seenPaymentIds.add(pKey);
    seenOrderIds.add(oKey);
    seenVideoIds.add(vKey);
    seenVideoFiles.add(vCheck.filename);
    seenThumbFiles.add(tCheck.filename);

    normalized.push({
      userId,
      userUuid,
      paymentId,
      orderId,
      videoId,
      contentType: contentTypeRaw,
      title,
      category,
      description,
      duration,
      videoFilename: vCheck.filename,
      thumbnailFilename: tCheck.filename,
      amount: 6.0,
      amountPaise: 600,
    });
  }

  return { ok: true, items: normalized };
}

async function fetchRazorpayJson(
  fetchImpl: typeof fetch,
  apiPath: string,
  keyId: string,
  keySecret: string,
): Promise<
  | { ok: true; httpCode: number; data: Record<string, unknown> }
  | { ok: false; httpCode: number; error: string }
> {
  const url = `https://api.razorpay.com/v1${apiPath}`;
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      httpCode: 502,
      error: `Razorpay gateway request failed for ${apiPath}: ${msg}`,
    };
  }

  let decoded: unknown;
  try {
    decoded = await response.json();
  } catch {
    return {
      ok: false,
      httpCode: 502,
      error: `Invalid JSON payload returned by Razorpay for ${apiPath}.`,
    };
  }

  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    return {
      ok: false,
      httpCode: 502,
      error: `Invalid JSON payload returned by Razorpay for ${apiPath}.`,
    };
  }

  const record = decoded as Record<string, unknown>;
  if (!response.ok) {
    const errObj =
      record["error"] && typeof record["error"] === "object"
        ? (record["error"] as Record<string, unknown>)
        : {};
    const msg = String(errObj["description"] ?? errObj["code"] ?? `HTTP ${response.status}`);
    return {
      ok: false,
      httpCode: response.status >= 400 && response.status < 500 ? 400 : 502,
      error: `Razorpay verification failed for ${apiPath}: ${msg}`,
    };
  }

  return { ok: true, httpCode: response.status, data: record };
}

type SqlExecutor = Pick<Pool, "query"> | Pick<PoolConnection, "query">;

async function resolveAccountingForItem(
  executor: SqlExecutor,
  item: VerifiedRecoveryItem,
  txNumber: number,
  hasAdEarningsCol: boolean,
  hasIsBlockedCol: boolean,
  simulatedExtraVideos: Array<{
    video_id: string;
    user_id: string;
    ad_earnings: number;
  }> = [],
): Promise<ItemAccountingResult> {
  const userId = item.canonicalUserId;
  const isSpecial = txNumber >= 11 && (txNumber - 11) % 10 === 0;
  const specialTag: "SPECIAL_GLOBAL_RULE" | "NORMAL_PREMIUM" = isSpecial
    ? "SPECIAL_GLOBAL_RULE"
    : "NORMAL_PREMIUM";

  // Direct sponsor resolution (mirrors verify.php)
  let verifiedReferrerId: string | null = null;
  if (item.referralCode !== "") {
    const [refRows] = (await executor.query(
      `SELECT user_id FROM users
       WHERE (UPPER(user_id) = UPPER(?) OR UPPER(referral_code) = UPPER(?))
         AND UPPER(user_id) != UPPER(?)
       LIMIT 1`,
      [item.referralCode, item.referralCode, userId],
    )) as [Array<Record<string, unknown>>, unknown];
    const firstRef = refRows[0];
    if (firstRef && typeof firstRef["user_id"] === "string") {
      verifiedReferrerId = firstRef["user_id"];
    }
  }

  // Admin user resolution (mirrors verify.php)
  const [adminRows] = (await executor.query(
    "SELECT user_id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1",
  )) as [Array<Record<string, unknown>>, unknown];
  const firstAdmin = adminRows[0];
  const adminUserId =
    firstAdmin && typeof firstAdmin["user_id"] === "string" && firstAdmin["user_id"] !== ""
      ? firstAdmin["user_id"]
      : "FT102857";

  const hasReferrer = Boolean(verifiedReferrerId);
  const referralCommission = hasReferrer ? 1.0 : 0.0;
  const unallocatedReferrerPaise = hasReferrer ? 0 : 100;
  const creatorPayouts: CreatorPayoutItem[] = [];
  let adminAllocation = 0.0;
  let globalPoolAllocation = 0.0;
  let eligibleVideosCount = 0;

  if (isSpecial) {
    adminAllocation = hasReferrer ? 4.0 : 5.0;
    globalPoolAllocation = 0.0;
    eligibleVideosCount = 0;
  } else {
    const baseAdminPaise = 100 + unallocatedReferrerPaise;
    const adEarningsExpr = hasAdEarningsCol
      ? "COALESCE(ad_earnings, 0.00) AS ad_earnings"
      : "0.00 AS ad_earnings";
    const blockedFilter = hasIsBlockedCol
      ? "\n                  AND (is_blocked = 0 OR is_blocked IS NULL)"
      : "";

    const [evRows] = (await executor.query(
      `SELECT id AS video_id, user_id, ${adEarningsExpr}
       FROM uploaded_videos
       WHERE (video_type = 'premium' OR payment_status = 'paid')
         AND UPPER(user_id) != UPPER(?)${blockedFilter}
       ORDER BY created_at ASC, id ASC`,
      [userId],
    )) as [Array<Record<string, unknown>>, unknown];

    const eligibleVideos: Array<{
      video_id: string;
      user_id: string;
      ad_earnings: number;
    }> = evRows.map((r) => ({
      video_id: String(r["video_id"] ?? ""),
      user_id: String(r["user_id"] ?? ""),
      ad_earnings: Math.max(0, Number(r["ad_earnings"] ?? 0) || 0),
    }));

    for (const simVid of simulatedExtraVideos) {
      if (simVid.user_id.toUpperCase() !== userId.toUpperCase()) {
        eligibleVideos.push(simVid);
      }
    }

    eligibleVideosCount = eligibleVideos.length;
    if (eligibleVideosCount === 0) {
      const adminPaise = baseAdminPaise + 300;
      adminAllocation = adminPaise / 100;
      globalPoolAllocation = 0.0;
    } else {
      const poolPaise = 300;
      let totalAdEarnings = 0.0;
      for (const ev of eligibleVideos) {
        totalAdEarnings += Math.max(0, ev.ad_earnings);
      }

      if (totalAdEarnings > 0) {
        let allocatedPaise = 0;
        for (const ev of eligibleVideos) {
          const vEarnings = Math.max(0, ev.ad_earnings);
          const weight = vEarnings / totalAdEarnings;
          const amountPaise = Math.floor(weight * poolPaise);
          allocatedPaise += amountPaise;
          creatorPayouts.push({
            userId: ev.user_id,
            videoId: ev.video_id,
            amount: amountPaise / 100,
            amountPaise,
            weight,
            adEarnings: vEarnings,
          });
        }
        const residualPaise = Math.max(0, poolPaise - allocatedPaise);
        adminAllocation = (baseAdminPaise + residualPaise) / 100;
        globalPoolAllocation = allocatedPaise / 100;
      } else {
        const perVideoPaise = Math.floor(poolPaise / eligibleVideosCount);
        const distributedPaise = perVideoPaise * eligibleVideosCount;
        const residualPaise = poolPaise - distributedPaise;
        adminAllocation = (baseAdminPaise + residualPaise) / 100;
        globalPoolAllocation = distributedPaise / 100;

        for (const ev of eligibleVideos) {
          creatorPayouts.push({
            userId: ev.user_id,
            videoId: ev.video_id,
            amount: perVideoPaise / 100,
            amountPaise: perVideoPaise,
            weight: 1 / eligibleVideosCount,
            adEarnings: 0.0,
          });
        }
      }
    }
  }

  return {
    txNumber,
    isSpecial,
    specialTag,
    referrerId: verifiedReferrerId,
    adminUserId,
    referralCommission,
    adminAllocation,
    globalPoolAllocation,
    eligibleVideosCount,
    creatorPayouts,
  };
}

async function inspectItemConflicts(
  executor: SqlExecutor,
  item: VerifiedRecoveryItem,
  forUpdate: boolean,
): Promise<{
  conflicts: string[];
  existingOrderRow: Record<string, unknown> | null;
}> {
  const lockSuffix = forUpdate ? " FOR UPDATE" : "";
  const conflicts: string[] = [];

  const [poRows] = (await executor.query(
    `SELECT order_id, user_id, video_id, purpose, status, payment_id FROM payment_orders WHERE order_id = ?${lockSuffix}`,
    [item.orderId],
  )) as [Array<Record<string, unknown>>, unknown];
  const poRow = poRows[0] ?? null;

  if (poRow) {
    const poStatus = String(poRow["status"] ?? "").toLowerCase();
    const poPaymentId = String(poRow["payment_id"] ?? "").trim();
    if (poStatus === "paid" || (poPaymentId !== "" && poPaymentId !== item.paymentId)) {
      conflicts.push(
        `payment_orders already has order ${item.orderId} (status=${poStatus}, payment_id=${poPaymentId})`,
      );
    } else if (poStatus !== "created") {
      conflicts.push(
        `payment_orders has non-recoverable status '${poStatus}' for order ${item.orderId}`,
      );
    } else if (
      String(poRow["user_id"] ?? "").toUpperCase() !== item.canonicalUserId.toUpperCase() ||
      (poRow["video_id"] && String(poRow["video_id"]) !== item.videoId) ||
      String(poRow["purpose"] ?? "") !== "premium_video_upload"
    ) {
      conflicts.push(
        `payment_orders row for ${item.orderId} does not match customer/video/purpose`,
      );
    }
  }

  const [ptRows] = (await executor.query(
    `SELECT payment_id, order_id FROM payment_transactions WHERE payment_id = ? OR order_id = ?${lockSuffix}`,
    [item.paymentId, item.orderId],
  )) as [Array<Record<string, unknown>>, unknown];
  const ptRow = ptRows[0];
  if (ptRow) {
    conflicts.push(
      `payment_transactions already contains payment_id=${String(ptRow["payment_id"] ?? "")} / order_id=${String(ptRow["order_id"] ?? "")}`,
    );
  }

  const [premRows] = (await executor.query(
    `SELECT id, tx_number, payment_id, order_id FROM premium_transactions WHERE payment_id = ? OR order_id = ?${lockSuffix}`,
    [item.paymentId, item.orderId],
  )) as [Array<Record<string, unknown>>, unknown];
  const premRow = premRows[0];
  if (premRow) {
    conflicts.push(
      `premium_transactions already contains payment_id=${String(premRow["payment_id"] ?? "")} / order_id=${String(premRow["order_id"] ?? "")} (tx_number=${String(premRow["tx_number"] ?? "")})`,
    );
  }

  const [vidRows] = (await executor.query(
    `SELECT id, payment_id, payment_status FROM uploaded_videos WHERE id = ? OR payment_id = ?${lockSuffix}`,
    [item.videoId, item.paymentId],
  )) as [Array<Record<string, unknown>>, unknown];
  const vidRow = vidRows[0];
  if (vidRow) {
    conflicts.push(
      `uploaded_videos already contains id=${String(vidRow["id"] ?? "")} / payment_id=${String(vidRow["payment_id"] ?? "")}`,
    );
  }

  const [ledRows] = (await executor.query(
    `SELECT transaction_id FROM income_ledger WHERE transaction_id IN (?, ?) OR transaction_id LIKE ?${lockSuffix}`,
    [`TX_REF_${item.paymentId}`, `TX_ADM_${item.paymentId}`, `TX_GLB_${item.paymentId}_%`],
  )) as [Array<Record<string, unknown>>, unknown];
  const ledRow = ledRows[0];
  if (ledRow) {
    conflicts.push(
      `income_ledger already contains transaction_id=${String(ledRow["transaction_id"] ?? "")}`,
    );
  }

  return { conflicts, existingOrderRow: poRow };
}

interface SequenceDiagnostics {
  verifyPhpExpectedNextTx: number;
  paymentTransactionsCount: number;
  paymentTransactionsMinTx: number;
  paymentTransactionsMaxTx: number;
  paymentTransactionsDistinctTx: number;
  premiumTransactionsCount: number;
  premiumTransactionsMinTx: number;
  premiumTransactionsMaxTx: number;
  premiumSeedRowsCount: number;
}

type SafeSequenceResult =
  | {
      ok: true;
      nextTxNumber: number;
      diagnostics: SequenceDiagnostics;
    }
  | {
      ok: false;
      manualReviewRequired: true;
      error: string;
      diagnostics?: SequenceDiagnostics;
    };

async function resolveSafeNextPremiumTxNumber(
  executor: SqlExecutor,
  forUpdate: boolean,
): Promise<SafeSequenceResult> {
  const lockSuffix = forUpdate ? " FOR UPDATE" : "";
  const [ptSeqRows] = (await executor.query(
    `SELECT
       COUNT(*) AS total_tx,
       COALESCE(MIN(tx_number), 0) AS min_tx,
       COALESCE(MAX(tx_number), 0) AS max_tx,
       COUNT(DISTINCT tx_number) AS distinct_tx
     FROM payment_transactions
     WHERE purpose = 'premium_video_upload'${lockSuffix}`,
  )) as [Array<Record<string, unknown>>, unknown];
  const ptSeq = ptSeqRows[0];
  if (!ptSeq) {
    return {
      ok: false,
      manualReviewRequired: true,
      error: "Unable to read payment_transactions sequence state; manual review required.",
    };
  }

  const [premSeqRows] = (await executor.query(
    `SELECT
       COUNT(*) AS total_pt_tx,
       COALESCE(MIN(tx_number), 0) AS min_pt_tx,
       COALESCE(MAX(tx_number), 0) AS max_pt_tx,
       COALESCE(SUM(CASE WHEN id LIKE 'ptx-seed-%' OR payment_id LIKE 'pay\\_seed\\_hist\\_%' THEN 1 ELSE 0 END), 0) AS seed_rows
     FROM premium_transactions${lockSuffix}`,
  )) as [Array<Record<string, unknown>>, unknown];
  const premSeq = premSeqRows[0];
  if (!premSeq) {
    return {
      ok: false,
      manualReviewRequired: true,
      error: "Unable to read premium_transactions sequence state; manual review required.",
    };
  }

  const ptTotal = Number(ptSeq["total_tx"] ?? 0) || 0;
  const ptMin = Number(ptSeq["min_tx"] ?? 0) || 0;
  const ptMax = Number(ptSeq["max_tx"] ?? 0) || 0;
  const ptDistinct = Number(ptSeq["distinct_tx"] ?? 0) || 0;

  const premTotal = Number(premSeq["total_pt_tx"] ?? 0) || 0;
  const premMin = Number(premSeq["min_pt_tx"] ?? 0) || 0;
  const premMax = Number(premSeq["max_pt_tx"] ?? 0) || 0;
  const seedRows = Number(premSeq["seed_rows"] ?? 0) || 0;

  const verifyPhpNextTx = ptTotal + 1;

  const diagnostics: SequenceDiagnostics = {
    verifyPhpExpectedNextTx: verifyPhpNextTx,
    paymentTransactionsCount: ptTotal,
    paymentTransactionsMinTx: ptMin,
    paymentTransactionsMaxTx: ptMax,
    paymentTransactionsDistinctTx: ptDistinct,
    premiumTransactionsCount: premTotal,
    premiumTransactionsMinTx: premMin,
    premiumTransactionsMaxTx: premMax,
    premiumSeedRowsCount: seedRows,
  };

  if (ptTotal > 0 && (ptMin !== 1 || ptMax !== ptTotal || ptDistinct !== ptTotal)) {
    return {
      ok: false,
      manualReviewRequired: true,
      diagnostics,
      error: `Production transaction sequence cannot be determined safely: payment_transactions has non-contiguous tx_number values (count=${ptTotal}, min=${ptMin}, max=${ptMax}, distinct=${ptDistinct}), which diverges from verify.php COUNT(*)+1=${verifyPhpNextTx}. Manual review required.`,
    };
  }

  if (premMax > ptTotal || (ptTotal === 0 && premTotal > 0)) {
    const seedHint =
      seedRows > 0
        ? ` Detected ${seedRows} seeded row(s) in premium_transactions (e.g. ptx-seed-001..010 from schema.sql).`
        : "";
    return {
      ok: false,
      manualReviewRequired: true,
      diagnostics,
      error: `Production transaction sequence conflict: verify.php expects next tx_number=${verifyPhpNextTx} (payment_transactions count=${ptTotal}), but premium_transactions already contains rows up to tx_number=${premMax} (count=${premTotal}).${seedHint} Refusing to silently jump to tx_number ${premMax + 1}; manual review required.`,
    };
  }

  return {
    ok: true,
    nextTxNumber: verifyPhpNextTx,
    diagnostics,
  };
}

function isMysqlDuplicateError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const rec = err as { code?: unknown; errno?: unknown; message?: unknown };
  const msg = typeof rec.message === "string" ? rec.message : "";
  return (
    rec.code === "ER_DUP_ENTRY" ||
    rec.code === "23000" ||
    rec.errno === 1062 ||
    msg.includes("Duplicate entry")
  );
}

export async function handleAdminRecoverPremiumPayment(
  request: Request,
  options: RecoveryHandlerOptions,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonRecoveryResponse({ success: false, error: "Method Not Allowed" }, 405);
  }

  const isProd = isProductionRuntimeEnv(options.env);
  if (isProd && !options.pool) {
    return jsonRecoveryResponse(
      {
        success: false,
        error: "MySQL connection pool is unavailable. Premium payment recovery requires MySQL.",
      },
      503,
    );
  }

  let authUser: RecoveryAuthUser | null = null;
  try {
    authUser = await options.getAuthUser(request);
  } catch {
    return jsonRecoveryResponse(
      {
        success: false,
        error: "Database error while verifying administrator session.",
      },
      isProd ? 503 : 500,
    );
  }
  if (!authUser) {
    return jsonRecoveryResponse(
      {
        success: false,
        error: "Authentication required. Please provide a valid Bearer session token.",
      },
      401,
    );
  }

  if (String(authUser.role ?? "").toLowerCase() !== "admin") {
    return jsonRecoveryResponse(
      {
        success: false,
        error:
          "Admin authorization required. Only verified administrators can run premium payment recovery.",
      },
      403,
    );
  }

  const payloadRaw = await request.json().catch(() => null);
  if (!payloadRaw || typeof payloadRaw !== "object" || Array.isArray(payloadRaw)) {
    return jsonRecoveryResponse({ success: false, error: "Invalid JSON request payload." }, 400);
  }
  const input = payloadRaw as Record<string, unknown>;

  const dryRun =
    "dryRun" in input
      ? parseRecoveryDryRunFlag(input["dryRun"])
      : "dry_run" in input
        ? parseRecoveryDryRunFlag(input["dry_run"])
        : true;

  if (!dryRun) {
    const liveWritesFlag = readEnvString(
      "FACETUBE_ENABLE_PREMIUM_RECOVERY_LIVE_WRITES",
      options.env,
    ).toLowerCase();
    if (liveWritesFlag !== "true") {
      return jsonRecoveryResponse(
        {
          success: false,
          dryRun: false,
          deploymentBlocker: true,
          error:
            'Deployment Blocker: Live premium payment recovery writes are disabled by default. Ensure the shared GET_LOCK("facetube_premium_tx_seq") updates in verify.php/api-handler.ts are deployed and any sequence conflict is reconciled before enabling FACETUBE_ENABLE_PREMIUM_RECOVERY_LIVE_WRITES=true.',
        },
        423,
      );
    }
  }

  const validation = normalizeAndValidateItems(input);
  if (!validation.ok) {
    return jsonRecoveryResponse({ success: false, error: validation.error }, 400);
  }
  const items = validation.items;

  if (!options.pool) {
    return jsonRecoveryResponse(
      {
        success: false,
        error: "MySQL connection pool is unavailable. Premium payment recovery requires MySQL.",
      },
      503,
    );
  }
  const pool = options.pool;

  const keyId = readEnvString("RAZORPAY_KEY_ID", options.env);
  const keySecret = readEnvString("RAZORPAY_KEY_SECRET", options.env);
  if (!keyId || !keySecret) {
    return jsonRecoveryResponse(
      {
        success: false,
        error:
          "Razorpay credentials (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET) are not configured on the server.",
      },
      503,
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const mediaDirs = options.mediaDirs ?? getDefaultMediaDirs();
  const baseUrl = resolveBaseUrl(request, options.env, options.apiBaseUrl);

  const verifiedItems: VerifiedRecoveryItem[] = [];

  for (const item of items) {
    // 1. Customer verification in users table
    let userRow: Record<string, unknown> | undefined;
    try {
      const [uRows] = (await pool.query(
        "SELECT id, user_id, name, referral_code FROM users WHERE UPPER(user_id) = UPPER(?) LIMIT 1",
        [item.userId],
      )) as [Array<Record<string, unknown>>, unknown];
      userRow = uRows[0];
    } catch {
      return jsonRecoveryResponse(
        {
          success: false,
          dryRun,
          error: "Database error while verifying customer record.",
        },
        500,
      );
    }
    if (!userRow) {
      return jsonRecoveryResponse(
        {
          success: false,
          error: `Customer '${item.userId}' not found in users table.`,
        },
        404,
      );
    }

    const dbUserUuid = String(userRow["id"] ?? "");
    if (item.userUuid !== "" && dbUserUuid.toLowerCase() !== item.userUuid.toLowerCase()) {
      return jsonRecoveryResponse(
        {
          success: false,
          error: `Customer UUID mismatch for ${item.userId}: expected ${dbUserUuid}, got ${item.userUuid}.`,
        },
        400,
      );
    }

    const canonicalUserId = String(userRow["user_id"] ?? item.userId);
    const rawName = String(userRow["name"] ?? "").trim();
    const creatorName = rawName !== "" ? rawName : "Creator";
    const referralCode = String(userRow["referral_code"] ?? "").trim();

    // 2. Media files check
    const videoFileCheck = resolveMediaFileOnDisk(mediaDirs.videos, item.videoFilename);
    if (!videoFileCheck.exists) {
      return jsonRecoveryResponse(
        {
          success: false,
          error: `Missing or empty video file '${item.videoFilename}' in uploads/videos storage.`,
        },
        404,
      );
    }

    const thumbFileCheck = resolveMediaFileOnDisk(mediaDirs.images, item.thumbnailFilename);
    if (!thumbFileCheck.exists) {
      return jsonRecoveryResponse(
        {
          success: false,
          error: `Missing or empty thumbnail file '${item.thumbnailFilename}' in uploads/images storage.`,
        },
        404,
      );
    }

    // 3. Independent Razorpay verification
    const orderRes = await fetchRazorpayJson(
      fetchImpl,
      `/orders/${encodeURIComponent(item.orderId)}`,
      keyId,
      keySecret,
    );
    if (!orderRes.ok) {
      return jsonRecoveryResponse({ success: false, error: orderRes.error }, orderRes.httpCode);
    }
    const rzpOrder = orderRes.data;

    const paymentRes = await fetchRazorpayJson(
      fetchImpl,
      `/payments/${encodeURIComponent(item.paymentId)}`,
      keyId,
      keySecret,
    );
    if (!paymentRes.ok) {
      return jsonRecoveryResponse({ success: false, error: paymentRes.error }, paymentRes.httpCode);
    }
    const rzpPayment = paymentRes.data;

    const orderPaymentsRes = await fetchRazorpayJson(
      fetchImpl,
      `/orders/${encodeURIComponent(item.orderId)}/payments`,
      keyId,
      keySecret,
    );
    if (!orderPaymentsRes.ok) {
      return jsonRecoveryResponse(
        { success: false, error: orderPaymentsRes.error },
        orderPaymentsRes.httpCode,
      );
    }
    const rzpOrderPayments = orderPaymentsRes.data;

    if (String(rzpOrder["id"] ?? "") !== item.orderId) {
      return jsonRecoveryResponse(
        {
          success: false,
          error: `Razorpay order ID mismatch for ${item.orderId}.`,
        },
        400,
      );
    }
    if (
      Number(rzpOrder["amount"] ?? 0) !== 600 ||
      String(rzpOrder["currency"] ?? "").toUpperCase() !== "INR"
    ) {
      return jsonRecoveryResponse(
        {
          success: false,
          error: `Razorpay order ${item.orderId} amount/currency mismatch (expected 600 INR).`,
        },
        400,
      );
    }

    const orderNotesRaw = rzpOrder["notes"];
    const orderNotes =
      orderNotesRaw && typeof orderNotesRaw === "object" && !Array.isArray(orderNotesRaw)
        ? (orderNotesRaw as Record<string, unknown>)
        : {};
    const notePurpose = String(orderNotes["purpose"] ?? "").trim();
    const noteUserId = String(orderNotes["userId"] ?? orderNotes["user_id"] ?? "").trim();
    const noteVideoId = String(orderNotes["videoId"] ?? orderNotes["video_id"] ?? "").trim();
    const noteContentType = String(orderNotes["contentType"] ?? orderNotes["content_type"] ?? "")
      .trim()
      .toLowerCase();

    if (notePurpose !== "premium_video_upload") {
      return jsonRecoveryResponse(
        {
          success: false,
          error: `Razorpay order ${item.orderId} notes.purpose mismatch (expected 'premium_video_upload', got '${notePurpose}').`,
        },
        400,
      );
    }
    if (!noteUserId || noteUserId.toUpperCase() !== canonicalUserId.toUpperCase()) {
      return jsonRecoveryResponse(
        {
          success: false,
          error: `Razorpay order ${item.orderId} notes.userId mismatch (expected '${canonicalUserId}', got '${noteUserId}').`,
        },
        400,
      );
    }
    if (!noteVideoId || noteVideoId !== item.videoId) {
      return jsonRecoveryResponse(
        {
          success: false,
          error: `Razorpay order ${item.orderId} notes.videoId mismatch (expected '${item.videoId}', got '${noteVideoId}').`,
        },
        400,
      );
    }
    if (noteContentType !== "" && noteContentType !== item.contentType) {
      return jsonRecoveryResponse(
        {
          success: false,
          error: `Razorpay order ${item.orderId} notes.contentType mismatch (expected '${item.contentType}', got '${noteContentType}').`,
        },
        400,
      );
    }

    if (String(rzpPayment["id"] ?? "") !== item.paymentId) {
      return jsonRecoveryResponse(
        {
          success: false,
          error: `Razorpay payment ID mismatch for ${item.paymentId}.`,
        },
        400,
      );
    }
    if (String(rzpPayment["order_id"] ?? "") !== item.orderId) {
      return jsonRecoveryResponse(
        {
          success: false,
          error: `Razorpay payment ${item.paymentId} does not belong to order ${item.orderId}.`,
        },
        400,
      );
    }
    const paymentStatus = String(rzpPayment["status"] ?? "");
    if (paymentStatus !== "captured") {
      return jsonRecoveryResponse(
        {
          success: false,
          error: `Razorpay payment ${item.paymentId} is not captured (status: ${paymentStatus || "unknown"}).`,
        },
        400,
      );
    }
    if (
      Number(rzpPayment["amount"] ?? 0) !== 600 ||
      String(rzpPayment["currency"] ?? "").toUpperCase() !== "INR"
    ) {
      return jsonRecoveryResponse(
        {
          success: false,
          error: `Razorpay payment ${item.paymentId} amount/currency mismatch (expected 600 INR).`,
        },
        400,
      );
    }
    if (
      Number(rzpPayment["amount_refunded"] ?? 0) > 0 ||
      (rzpPayment["refund_status"] !== null &&
        rzpPayment["refund_status"] !== undefined &&
        String(rzpPayment["refund_status"]).trim() !== "")
    ) {
      return jsonRecoveryResponse(
        {
          success: false,
          error: `Razorpay payment ${item.paymentId} has refund activity (refund_status=${String(rzpPayment["refund_status"] ?? "")}).`,
        },
        409,
      );
    }

    const paymentNotesRaw = rzpPayment["notes"];
    const paymentNotes =
      paymentNotesRaw && typeof paymentNotesRaw === "object" && !Array.isArray(paymentNotesRaw)
        ? (paymentNotesRaw as Record<string, unknown>)
        : {};
    const pNoteUser = String(paymentNotes["userId"] ?? paymentNotes["user_id"] ?? "").trim();
    const pNoteVideo = String(paymentNotes["videoId"] ?? paymentNotes["video_id"] ?? "").trim();
    const pNotePurpose = String(paymentNotes["purpose"] ?? "").trim();
    const pNoteContentType = String(
      paymentNotes["contentType"] ?? paymentNotes["content_type"] ?? "",
    )
      .trim()
      .toLowerCase();
    if (
      (pNoteUser !== "" && pNoteUser.toUpperCase() !== canonicalUserId.toUpperCase()) ||
      (pNoteVideo !== "" && pNoteVideo !== item.videoId) ||
      (pNotePurpose !== "" && pNotePurpose !== "premium_video_upload") ||
      (pNoteContentType !== "" && pNoteContentType !== item.contentType)
    ) {
      return jsonRecoveryResponse(
        {
          success: false,
          error: `Razorpay payment ${item.paymentId} notes conflict with order/recovery item metadata.`,
        },
        400,
      );
    }

    const orderPaymentItems = Array.isArray(rzpOrderPayments["items"])
      ? rzpOrderPayments["items"]
      : [];
    const capturedIds: string[] = [];
    for (const op of orderPaymentItems) {
      if (op && typeof op === "object") {
        const opRec = op as Record<string, unknown>;
        if (
          String(opRec["status"] ?? "") === "captured" &&
          typeof opRec["id"] === "string" &&
          opRec["id"] !== ""
        ) {
          capturedIds.push(opRec["id"]);
        }
      }
    }
    if (!capturedIds.includes(item.paymentId)) {
      return jsonRecoveryResponse(
        {
          success: false,
          error: `Razorpay order ${item.orderId} payments list does not show ${item.paymentId} as captured.`,
        },
        400,
      );
    }
    const uniqueCaptured = Array.from(new Set(capturedIds));
    if (uniqueCaptured.length > 1) {
      return jsonRecoveryResponse(
        {
          success: false,
          error: `Razorpay order ${item.orderId} has multiple captured payments (${uniqueCaptured.join(", ")}); manual review required.`,
        },
        409,
      );
    }

    verifiedItems.push({
      ...item,
      canonicalUserId,
      creatorName,
      userUuidVerified: dbUserUuid,
      referralCode,
      videoUrl: `${baseUrl}/uploads/videos/${item.videoFilename}`,
      thumbnailUrl: `${baseUrl}/uploads/images/${item.thumbnailFilename}`,
      videoFileBytes: videoFileCheck.size,
      thumbnailFileBytes: thumbFileCheck.size,
      razorpayPaymentCreatedAt: Number(rzpPayment["created_at"] ?? 0) || 0,
      razorpayOrderCreatedAt: Number(rzpOrder["created_at"] ?? 0) || 0,
    });
  }

  // Chronological & Long-first enforcement
  let maxLongTs: number | null = null;
  let minShortTs: number | null = null;
  for (const vi of verifiedItems) {
    const ts = vi.razorpayPaymentCreatedAt;
    if (ts > 0) {
      if (vi.contentType === "long") {
        maxLongTs = maxLongTs === null ? ts : Math.max(maxLongTs, ts);
      } else {
        minShortTs = minShortTs === null ? ts : Math.min(minShortTs, ts);
      }
    }
  }
  if (maxLongTs !== null && minShortTs !== null && minShortTs < maxLongTs) {
    return jsonRecoveryResponse(
      {
        success: false,
        error: `Chronological conflict: Short payment timestamp (${minShortTs}) is earlier than Long payment timestamp (${maxLongTs}).`,
      },
      409,
    );
  }

  verifiedItems.sort((a, b) => {
    const rankA = a.contentType === "long" ? 0 : 1;
    const rankB = b.contentType === "long" ? 0 : 1;
    if (rankA !== rankB) return rankA - rankB;
    return a.razorpayPaymentCreatedAt - b.razorpayPaymentCreatedAt;
  });

  // Detect optional uploaded_videos columns via INFORMATION_SCHEMA
  let hasAdEarningsCol = false;
  let hasIsBlockedCol = false;
  try {
    const [colRows] = (await pool.query(
      `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'uploaded_videos'
         AND COLUMN_NAME IN ('ad_earnings', 'is_blocked')`,
    )) as [Array<Record<string, unknown>>, unknown];
    for (const row of colRows) {
      const colName = String(row["COLUMN_NAME"] ?? "").toLowerCase();
      if (colName === "ad_earnings") hasAdEarningsCol = true;
      if (colName === "is_blocked") hasIsBlockedCol = true;
    }
  } catch {
    // Keep safe false defaults
  }

  // DRY-RUN MODE (default = true): zero writes
  if (dryRun) {
    try {
      const seqCheck = await resolveSafeNextPremiumTxNumber(pool, false);
      const simulatedExtraVideos: Array<{
        video_id: string;
        user_id: string;
        ad_earnings: number;
      }> = [];
      const results: Array<Record<string, unknown>> = [];
      const allConflicts: string[] = [];
      let manualReviewRequired = !seqCheck.ok;
      const sequenceDiagnostics = seqCheck.diagnostics ?? null;

      if (!seqCheck.ok) {
        allConflicts.push(seqCheck.error);
      }

      const baseNextTx = seqCheck.ok ? seqCheck.nextTxNumber : null;

      for (let idx = 0; idx < verifiedItems.length; idx += 1) {
        const item = verifiedItems[idx]!;
        const check = await inspectItemConflicts(pool, item, false);
        let accounting: ItemAccountingResult | null = null;

        if (baseNextTx !== null) {
          const simTxNumber = baseNextTx + idx;

          const [dupTxPt] = (await pool.query(
            "SELECT id FROM payment_transactions WHERE tx_number = ? AND purpose = 'premium_video_upload' LIMIT 1",
            [simTxNumber],
          )) as [Array<Record<string, unknown>>, unknown];
          const [dupTxPrem] = (await pool.query(
            "SELECT id FROM premium_transactions WHERE tx_number = ? LIMIT 1",
            [simTxNumber],
          )) as [Array<Record<string, unknown>>, unknown];
          if (dupTxPt.length > 0 || dupTxPrem.length > 0) {
            manualReviewRequired = true;
            check.conflicts.push(
              `Transaction sequence conflict: tx_number ${simTxNumber} already exists; manual review required.`,
            );
          } else {
            accounting = await resolveAccountingForItem(
              pool,
              item,
              simTxNumber,
              hasAdEarningsCol,
              hasIsBlockedCol,
              simulatedExtraVideos,
            );
            simulatedExtraVideos.push({
              video_id: item.videoId,
              user_id: item.canonicalUserId,
              ad_earnings: 0.0,
            });
          }
        } else if (!seqCheck.ok) {
          check.conflicts.push(seqCheck.error);
        }

        for (const c of check.conflicts) {
          allConflicts.push(`${item.paymentId}: ${c}`);
        }

        results.push({
          status: check.conflicts.length === 0 ? "dry_run_ready" : "conflict",
          orderSequence: idx + 1,
          paymentId: item.paymentId,
          orderId: item.orderId,
          videoId: item.videoId,
          contentType: item.contentType,
          userId: item.canonicalUserId,
          userUuid: item.userUuidVerified,
          creatorName: item.creatorName,
          title: item.title,
          category: item.category,
          description: item.description,
          duration: item.duration,
          videoUrl: item.videoUrl,
          thumbnailUrl: item.thumbnailUrl,
          videoFileBytes: item.videoFileBytes,
          thumbnailFileBytes: item.thumbnailFileBytes,
          razorpayPaymentCreatedAt: item.razorpayPaymentCreatedAt,
          accounting,
          conflicts: check.conflicts,
        });
      }

      if (allConflicts.length > 0) {
        const conflictBody: Record<string, unknown> = {
          success: false,
          dryRun: true,
          deploymentBlockerNotice:
            'Live writes remain disabled by default unless FACETUBE_ENABLE_PREMIUM_RECOVERY_LIVE_WRITES=true is enabled with shared GET_LOCK("facetube_premium_tx_seq") protection deployed.',
          error: seqCheck.ok
            ? `Duplicate or partial recovery conflicts detected: ${allConflicts.join("; ")}`
            : seqCheck.error,
          results,
        };
        if (manualReviewRequired) {
          conflictBody["manualReviewRequired"] = true;
          conflictBody["sequenceConflict"] = true;
        }
        if (sequenceDiagnostics !== null) {
          conflictBody["sequenceDiagnostics"] = sequenceDiagnostics;
        }
        return jsonRecoveryResponse(conflictBody, 409);
      }

      return jsonRecoveryResponse(
        {
          success: true,
          dryRun: true,
          deploymentBlockerNotice:
            'Live writes remain disabled by default unless FACETUBE_ENABLE_PREMIUM_RECOVERY_LIVE_WRITES=true is enabled with shared GET_LOCK("facetube_premium_tx_seq") protection deployed.',
          message:
            "Dry-run verification and accounting simulation succeeded. Zero database writes were executed.",
          processedCount: results.length,
          sequenceDiagnostics,
          results,
        },
        200,
      );
    } catch {
      return jsonRecoveryResponse(
        {
          success: false,
          dryRun: true,
          error: "Database error during dry-run verification. Zero database writes were executed.",
        },
        500,
      );
    }
  }

  // LIVE RECOVERY MODE (only when dryRun=false AND deployment blocker gate enabled)
  let conn: PoolConnection;
  try {
    conn = await pool.getConnection();
  } catch {
    return jsonRecoveryResponse(
      {
        success: false,
        dryRun: false,
        error: "Database error while acquiring connection for premium recovery.",
      },
      500,
    );
  }
  let lockAcquired = false;
  const results: Array<Record<string, unknown>> = [];
  let finalPayload: Record<string, unknown> | null = null;
  let finalStatus = 200;

  try {
    let acquired = 0;
    try {
      const [lockRows] = (await conn.query("SELECT GET_LOCK(?, 15) AS acquired", [
        PREMIUM_RECOVERY_LOCK_NAME,
      ])) as [Array<Record<string, unknown>>, unknown];
      acquired = Number(lockRows[0]?.["acquired"] ?? 0);
    } catch {
      return jsonRecoveryResponse(
        {
          success: false,
          dryRun: false,
          error: "Database error while acquiring premium transaction recovery lock.",
        },
        500,
      );
    }
    if (acquired !== 1) {
      return jsonRecoveryResponse(
        {
          success: false,
          dryRun: false,
          error:
            "Could not acquire premium transaction recovery lock. Another recovery or sequence operation is currently running.",
        },
        409,
      );
    }
    lockAcquired = true;

    for (let idx = 0; idx < verifiedItems.length; idx += 1) {
      const item = verifiedItems[idx]!;
      let inTx = false;
      try {
        await conn.beginTransaction();
        inTx = true;

        const check = await inspectItemConflicts(conn, item, true);
        if (check.conflicts.length > 0) {
          await conn.rollback();
          inTx = false;
          finalStatus = 409;
          finalPayload = {
            success: false,
            dryRun: false,
            error: `Idempotency / duplicate conflict for ${item.paymentId}: ${check.conflicts.join("; ")}`,
            committedSoFar: results,
          };
          break;
        }

        const seqCheck = await resolveSafeNextPremiumTxNumber(conn, true);
        if (!seqCheck.ok) {
          await conn.rollback();
          inTx = false;
          finalStatus = 409;
          finalPayload = {
            success: false,
            dryRun: false,
            manualReviewRequired: true,
            sequenceConflict: true,
            sequenceDiagnostics: seqCheck.diagnostics ?? null,
            error: seqCheck.error,
            committedSoFar: results,
          };
          break;
        }
        const txNumber = seqCheck.nextTxNumber;

        const [txCheckPt] = (await conn.query(
          "SELECT id FROM payment_transactions WHERE tx_number = ? AND purpose = 'premium_video_upload' FOR UPDATE",
          [txNumber],
        )) as [Array<Record<string, unknown>>, unknown];
        const [txCheckPrem] = (await conn.query(
          "SELECT id FROM premium_transactions WHERE tx_number = ? FOR UPDATE",
          [txNumber],
        )) as [Array<Record<string, unknown>>, unknown];
        if (txCheckPt.length > 0 || txCheckPrem.length > 0) {
          await conn.rollback();
          inTx = false;
          finalStatus = 409;
          finalPayload = {
            success: false,
            dryRun: false,
            manualReviewRequired: true,
            sequenceConflict: true,
            error: `Transaction sequence conflict: tx_number ${txNumber} already exists; manual review required.`,
            committedSoFar: results,
          };
          break;
        }

        const accounting = await resolveAccountingForItem(
          conn,
          item,
          txNumber,
          hasAdEarningsCol,
          hasIsBlockedCol,
        );

        const userId = item.canonicalUserId;
        const userName = item.creatorName;
        const videoId = item.videoId;
        const paymentId = item.paymentId;
        const orderId = item.orderId;
        const amount = item.amount;

        // 1. Insert payment_transactions
        await conn.query(
          `INSERT INTO payment_transactions (
            order_id, payment_id, user_id, user_name, video_id, purpose, amount,
            tx_number, is_special, special_tag, referral_commission, admin_allocation, global_pool_allocation,
            created_at
          ) VALUES (?, ?, ?, ?, ?, 'premium_video_upload', ?, ?, ?, ?, ?, ?, ?, NOW())`,
          [
            orderId,
            paymentId,
            userId,
            userName,
            videoId,
            amount,
            txNumber,
            accounting.isSpecial ? 1 : 0,
            accounting.specialTag,
            accounting.referralCommission,
            accounting.adminAllocation,
            accounting.globalPoolAllocation,
          ],
        );

        // 2. Insert premium_transactions — DO NOT silently ignore errors
        const ptId = crypto.randomUUID();
        await conn.query(
          `INSERT INTO premium_transactions (
            id, tx_number, payment_id, order_id, video_id, user_id, referrer_id,
            amount, transaction_type, is_special, special_tag, referral_commission,
            admin_allocation, global_pool_allocation, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'premium_upload', ?, ?, ?, ?, ?, NOW())`,
          [
            ptId,
            txNumber,
            paymentId,
            orderId,
            videoId,
            userId,
            accounting.referrerId,
            amount,
            accounting.isSpecial ? 1 : 0,
            accounting.specialTag,
            accounting.referralCommission,
            accounting.adminAllocation,
            accounting.globalPoolAllocation,
          ],
        );

        // 3. Direct referral commission
        if (accounting.referrerId && accounting.referralCommission > 0) {
          const txRefId = `TX_REF_${paymentId}`;
          await conn.query(
            `INSERT INTO income_ledger (
              id, transaction_id, user_id, source_user_id, source_user_name, video_id,
              income_type, amount, status, special_tag, description, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'referral_income', 1.0000, 'settled', ?, ?, NOW())`,
            [
              crypto.randomUUID(),
              txRefId,
              accounting.referrerId,
              userId,
              userName,
              videoId,
              accounting.specialTag,
              `Direct referral commission (₹1.00) for eligible Premium Video upload by ${userName} (${userId})`,
            ],
          );

          await conn.query(
            `INSERT INTO wallet_balances (user_id, balance, total_earned, total_withdrawn, referral_income, global_income, adsense_income, affiliate_income, updated_at)
             VALUES (?, 1.00, 1.00, 0.00, 1.00, 0.00, 0.00, 0.00, NOW())
             ON DUPLICATE KEY UPDATE
               balance = balance + 1.00,
               total_earned = total_earned + 1.00,
               referral_income = referral_income + 1.00,
               updated_at = NOW()`,
            [accounting.referrerId],
          );
        }

        // 4. Admin allocation
        if (accounting.adminAllocation > 0) {
          const txAdmId = `TX_ADM_${paymentId}`;
          const admDesc = accounting.isSpecial
            ? `Admin Allocation (₹${accounting.adminAllocation}) for Special Premium Video #${txNumber} upload by ${userName} (${userId})`
            : `Admin Allocation (₹${accounting.adminAllocation}) for Premium Video #${txNumber} upload by ${userName} (${userId})`;

          await conn.query(
            `INSERT INTO income_ledger (
              id, transaction_id, user_id, source_user_id, source_user_name, video_id,
              income_type, amount, status, special_tag, description, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'admin_allocation', ?, 'settled', ?, ?, NOW())`,
            [
              crypto.randomUUID(),
              txAdmId,
              accounting.adminUserId,
              userId,
              userName,
              videoId,
              accounting.adminAllocation,
              accounting.specialTag,
              admDesc,
            ],
          );

          await conn.query(
            `INSERT INTO wallet_balances (user_id, balance, total_earned, total_withdrawn, referral_income, global_income, adsense_income, affiliate_income, updated_at)
             VALUES (?, ?, ?, 0.00, 0.00, 0.00, 0.00, 0.00, NOW())
             ON DUPLICATE KEY UPDATE
               balance = balance + VALUES(balance),
               total_earned = total_earned + VALUES(total_earned),
               updated_at = NOW()`,
            [accounting.adminUserId, accounting.adminAllocation, accounting.adminAllocation],
          );
        }

        // 5. Global pool creator payouts
        for (const payout of accounting.creatorPayouts) {
          if (payout.amount <= 0) continue;
          const txGlbId = `TX_GLB_${paymentId}_${payout.videoId}`;
          const glbDesc = `Per-Video Ads Earnings Share for video #${payout.videoId} (₹${payout.amount} share of ₹3 pool for Premium Video #${txNumber})`;

          await conn.query(
            `INSERT INTO income_ledger (
              id, transaction_id, user_id, source_user_id, source_user_name, video_id,
              income_type, amount, status, special_tag, description, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'global_income', ?, 'settled', ?, ?, NOW())`,
            [
              crypto.randomUUID(),
              txGlbId,
              payout.userId,
              userId,
              userName,
              payout.videoId,
              payout.amount,
              accounting.specialTag,
              glbDesc,
            ],
          );

          await conn.query(
            `INSERT INTO wallet_balances (user_id, balance, total_earned, total_withdrawn, referral_income, global_income, adsense_income, affiliate_income, updated_at)
             VALUES (?, ?, ?, 0.00, 0.00, ?, 0.00, 0.00, NOW())
             ON DUPLICATE KEY UPDATE
               balance = balance + VALUES(balance),
               total_earned = total_earned + VALUES(total_earned),
               global_income = global_income + VALUES(global_income),
               updated_at = NOW()`,
            [payout.userId, payout.amount, payout.amount, payout.amount],
          );
        }

        // 6. Insert recovered video into uploaded_videos
        await conn.query(
          `INSERT INTO uploaded_videos (
            id, user_id, creator_name, title, description, video_url, thumbnail_url,
            video_type, content_type, category, duration, views, likes,
            payment_status, payment_id, payment_amount, is_promoted,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'premium', ?, ?, ?, 0, 0, 'paid', ?, ?, 0, NOW(), NOW())`,
          [
            videoId,
            userId,
            userName,
            item.title,
            item.description,
            item.videoUrl,
            item.thumbnailUrl,
            item.contentType,
            item.category,
            item.duration,
            paymentId,
            amount,
          ],
        );

        // 7. Update or insert payment_orders as paid
        if (check.existingOrderRow) {
          await conn.query(
            "UPDATE payment_orders SET status = 'paid', payment_id = ?, updated_at = NOW() WHERE order_id = ?",
            [paymentId, orderId],
          );
        } else {
          await conn.query(
            `INSERT INTO payment_orders (
              order_id, user_id, user_name, video_id, purpose, plan_id,
              content_type, amount, currency, status, payment_id,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'premium_video_upload', NULL, ?, ?, 'INR', 'paid', ?, NOW(), NOW())`,
            [orderId, userId, userName, videoId, item.contentType, amount, paymentId],
          );
        }

        await conn.commit();
        inTx = false;

        results.push({
          status: "recovered",
          orderSequence: idx + 1,
          paymentId,
          orderId,
          videoId,
          contentType: item.contentType,
          userId,
          title: item.title,
          category: item.category,
          accounting,
        });
      } catch (err: unknown) {
        if (inTx) {
          try {
            await conn.rollback();
          } catch {
            // Ignore secondary rollback failure
          }
        }
        const isDup = isMysqlDuplicateError(err);
        finalStatus = isDup ? 409 : 500;
        finalPayload = {
          success: false,
          dryRun: false,
          error: isDup
            ? `Duplicate key conflict during recovery for ${item.paymentId}. Transaction rolled back cleanly.`
            : `Database error during recovery for ${item.paymentId}. Transaction rolled back cleanly.`,
          committedSoFar: results,
        };
        break;
      }
    }

    if (!finalPayload) {
      finalStatus = 200;
      finalPayload = {
        success: true,
        dryRun: false,
        message: "Premium video payments recovered sequentially and atomically.",
        processedCount: results.length,
        results,
      };
    }

    return jsonRecoveryResponse(finalPayload, finalStatus);
  } finally {
    if (lockAcquired) {
      try {
        await conn.query("DO RELEASE_LOCK(?)", [PREMIUM_RECOVERY_LOCK_NAME]);
      } catch {
        // Ignore lock release failure
      }
    }
    conn.release();
  }
}
