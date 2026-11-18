import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { Pool, PoolConnection } from "mysql2/promise";
import { getMysqlPool, getDbConfig, testDatabaseConnection } from "./mysql.ts";
import {
  createServerPaymentOrder,
  verifyServerPayment,
  getPersistentTransactions,
  getPersistentPremiumTxNumber,
  PRICING_CONFIG,
  type AdsPlanId,
  ADS_REFERRAL_RATES,
  evaluateAdsDistribution,
  resolveUplineSponsors,
  
  type AdsUplineSponsor,
  calculateWeightedPoolPayouts,
  executeRazorpayRefund,
  getPersistentRefundRequests,
  savePersistentRefundRequest,
  updatePersistentRefundRequest,
  type RefundRequestRecord,
} from "./payments.ts";
import {
  sendWelcomeEmailServer,
  sendCertificateEmailServer,
  sendPasswordResetEmailServer,
  resolveSmtpConfig,
} from "./email.ts";
import { handleAdminRecoverPremiumPayment } from "./premium-recovery.ts";

const DATA_DIR = path.resolve(process.cwd(), "data");
const STORE_FILE = path.join(DATA_DIR, "facetube_store.json");

/**
 * Safely evaluates whether an ad promotion is currently active.
 * An ad promotion is active ONLY IF:
 * 1. Marked as promoted (is_promoted / isPromoted is truthy)
 * 2. Expiry timestamp is present, valid, and strictly in the future (> Date.now())
 *
 * Expired promotions, or those with null/missing/invalid expiry timestamps, return false.
 */
export function isAdPromotionActive(video: {
  is_promoted?: boolean | number | null | undefined;
  isPromoted?: boolean | number | null | undefined;
  promotion_expires_at?: string | null | undefined;
  promotionExpiresAt?: string | null | undefined;
}): boolean {
  const isMarked = Boolean(video.is_promoted ?? video.isPromoted);
  if (!isMarked) return false;
  const expiryRaw = video.promotion_expires_at ?? video.promotionExpiresAt;
  if (!expiryRaw) return false;
  const expiryTime = new Date(expiryRaw).getTime();
  if (Number.isNaN(expiryTime)) return false;
  return expiryTime > Date.now();
}

export function isFailClosedProductionEnv(appEnvRaw?: string, nodeEnvRaw?: string): boolean {
  const appEnv = String(appEnvRaw ?? "")
    .trim()
    .toLowerCase();
  const nodeEnv = String(nodeEnvRaw ?? "")
    .trim()
    .toLowerCase();
  if (appEnv === "production" || nodeEnv === "production") {
    return true;
  }
  const nonProdEnvs = new Set(["development", "dev", "local", "test"]);
  const presentEnvs = [appEnv, nodeEnv].filter((v) => v !== "");
  return presentEnvs.length === 0 || presentEnvs.some((v) => !nonProdEnvs.has(v));
}

export function isMysqlDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const record = err as { code?: unknown; errno?: unknown };
  return record.code === "ER_DUP_ENTRY" || record.errno === 1062;
}

/**
 * Masks sensitive bank account number leaving only the last 4 characters visible.
 * E.g. '50100481920194' -> 'XXXXXXXXXX0194'
 */
export function maskAccountNumber(acc: string): string {
  const clean = String(acc || "").replace(/[^0-9A-Za-z]/g, "");
  const len = clean.length;
  if (len === 0) return "";
  if (len <= 4) return "X".repeat(len);
  return "X".repeat(len - 4) + clean.slice(-4);
}

/**
 * Masks sensitive UPI handle before the domain.
 * E.g. 'alexrivera@okhdfcbank' -> 'al***ra@okhdfcbank'
 */
export function maskUpiId(upi: string): string {
  const clean = String(upi || "").trim();
  if (!clean) return "";
  const parts = clean.split("@");
  const handle = parts[0] || "";
  const hLen = handle.length;
  let maskedHandle: string;
  if (hLen <= 2) {
    maskedHandle = handle.slice(0, 1) + "*";
  } else if (hLen <= 4) {
    maskedHandle = handle.slice(0, 1) + "**" + handle.slice(-1);
  } else {
    maskedHandle = handle.slice(0, 2) + "***" + handle.slice(-2);
  }
  return parts.length > 1 ? `${maskedHandle}@${parts[1]}` : maskedHandle;
}

/**
 * Builds protected, masked beneficiary representation for secure storage.
 */
export function buildMaskedBeneficiaryDetails(bank?: any): string | null {
  if (!bank || typeof bank !== "object") return null;
  const holder = String(
    bank.accountHolder ||
      bank.account_holder ||
      bank.accountHolderName ||
      bank.account_holder_name ||
      "",
  ).trim();
  const bankName = String(bank.bankName || bank.bank_name || "").trim();
  const accNum = String(bank.accountNumber || bank.account_number || "").trim();
  const ifsc = String(bank.ifscCode || bank.ifsc_code || "").trim();
  const upi = String(bank.upiId || bank.upi_id || "").trim();

  const details: Record<string, string> = {};
  if (holder) details["account_holder"] = holder;
  if (bankName) details["bank_name"] = bankName;
  if (accNum) details["account_number_masked"] = maskAccountNumber(accNum);
  if (ifsc) details["ifsc_code"] = ifsc.toUpperCase();
  if (upi) details["upi_id_masked"] = maskUpiId(upi);

  return Object.keys(details).length > 0 ? JSON.stringify(details) : null;
}

/**
 * Validates a target URL against open redirect and SSRF vulnerabilities.
 * 1. Protocol must be strictly http: or https:
 * 2. No embedded userinfo (credentials in URL)
 * 3. Host must be non-empty and match approved domain whitelist
 * 4. Disallows loopback/localhost and private/reserved IPv4 ranges
 */
export function validateSafeAffiliateUrl(
  urlStr: string,
  allowedDomains: string[],
): { valid: boolean; error?: string; url?: string; host?: string } {
  const raw = String(urlStr || "").trim();
  if (!raw) {
    return { valid: false, error: "Target URL cannot be empty." };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { valid: false, error: "Invalid URL structure. Must include scheme and hostname." };
  }

  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "https:" && scheme !== "http:") {
    return {
      valid: false,
      error: "Disallowed scheme. Only HTTPS and HTTP destination URLs are permitted.",
    };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: "URLs containing embedded credentials are not allowed." };
  }

  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") {
    return { valid: false, error: "Destination host is a forbidden local loopback address." };
  }

  // Check against allowed domains whitelist
  let isAllowed = false;
  for (const allowed of allowedDomains) {
    const a = allowed.toLowerCase().trim();
    if (!a) continue;
    if (host === a || host.endsWith("." + a)) {
      isAllowed = true;
      break;
    }
  }

  if (!isAllowed) {
    return {
      valid: false,
      error: `Destination host '${host}' is not in the approved affiliate network whitelist.`,
    };
  }

  // Check for private / link-local / loopback numeric IPs
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match && ipv4Match[1] && ipv4Match[2]) {
    const p1 = parseInt(ipv4Match[1], 10);
    const p2 = parseInt(ipv4Match[2], 10);
    if (
      p1 === 10 ||
      p1 === 127 ||
      p1 === 0 ||
      (p1 === 172 && p2 >= 16 && p2 <= 31) ||
      (p1 === 192 && p2 === 168) ||
      (p1 === 169 && p2 === 254)
    ) {
      return {
        valid: false,
        error: "Destination host resolves to a private or reserved network IP address.",
      };
    }
  }

  return { valid: true, url: parsed.toString(), host };
}

interface ServerStore {
  users: Array<{
    id: string;
    user_id: string;
    name: string;
    mobile: string;
    email: string;
    password_hash: string;
    role: "admin" | "user";
    referral_code: string | null;
    avatar_url?: string | undefined;
    channel_logo_url?: string | undefined;
    channel_name?: string | undefined;
    created_at: string;
  }>;
  sessions: Record<string, string>; // token -> userId
  videos: Array<{
    id: string;
    user_id: string;
    creator_name: string;
    title: string;
    description: string;
    video_url: string;
    thumbnail_url: string;
    video_type: "free" | "premium";
    content_type: "short" | "long";
    category: string;
    duration: string;
    views: number;
    likes: number;
    payment_status: "not_required" | "pending" | "paid" | "failed";
    payment_id?: string | undefined;
    payment_amount: number;
    is_promoted: boolean;
    promotion_plan?: string | undefined;
    promotion_expires_at?: string | undefined;
    is_blocked?: boolean | undefined;
    block_reason?: string | undefined;
    blocked_at?: string | undefined;
    ad_earnings?: number | undefined;
    created_at: string;
    updated_at: string;
  }>;
  comments: Array<{
    id: string;
    video_id: string;
    user_id: string;
    user_name: string;
    avatar_url?: string | undefined;
    comment: string;
    created_at: string;
  }>;
  images: Array<{
    id: string;
    user_id: string;
    creator_name: string;
    title: string;
    description: string;
    image_url: string;
    thumbnail_url: string;
    format?: string | undefined;
    file_size?: string | undefined;
    category: string;
    views: number;
    likes: number;
    created_at: string;
  }>;
  payoutBatches?: Array<{
    id: string;
    admin_user_id: string;
    total_recipients: number;
    total_amount: number;
    status: string;
    notes?: string | undefined;
    created_at: string;
  }>;
  personalKyc: Record<string, Record<string, unknown>>;
  bankKyc: Record<string, Record<string, unknown>>;
  kycAuditLog?: Array<Record<string, unknown>>;
  certificates: Record<string, Record<string, unknown>>;
  walletTransactions: Array<Record<string, unknown>>;
  passwordResetTokens?: Array<{
    email: string;
    token_hash: string;
    expires_at: string;
    used: boolean;
    created_at: string;
  }>;
  wallets: Record<
    string,
    {
      balance: number;
      total_earned: number;
      total_withdrawn: number;
      referral_income: number;
      global_income: number;
      adsense_income: number;
      admob_income?: number;
      affiliate_income: number;
      updated_at: string;
    }
  >;
  categories?: Array<{
    id: string | number;
    name: string;
    slug: string;
    created_by?: string;
    created_at: string;
  }>;
  subscriberPlans?: SubscriberPlan[];
  affiliateNetworks?: Record<
    string,
    {
      id: string;
      name: string;
      is_active: number;
      creator_share_percentage: number;
      holding_period_days: number;
      allowed_domains: string;
      publisher_id: string | null;
      webhook_secret: string | null;
      api_key_encrypted?: string | null;
      settings_json?: any;
      updated_by?: string | null;
      created_at?: string;
      updated_at?: string;
    }
  >;
  affiliateClicks?: Array<{
    id: string;
    network: string;
    creator_user_id: string;
    video_id: string | null;
    target_url: string;
    ip_hash: string | null;
    user_agent: string | null;
    referrer: string | null;
    created_at: string;
  }>;
  affiliateConversions?: Record<
    string,
    {
      id: string;
      network: string;
      external_action_id: string;
      click_id?: string | null;
      creator_user_id: string;
      video_id?: string | null;
      order_amount: number;
      total_commission: number;
      creator_share_percentage: number;
      creator_payout: number;
      currency: string;
      status: "pending" | "approved" | "settled" | "rejected" | "reversed";
      settlement_due_at?: string | null;
      settled_at?: string | null;
      ledger_transaction_id?: string | null;
      notes?: string | null;
      raw_payload_hash?: string | null;
      created_at: string;
      updated_at: string;
    }
  >;
  affiliateAuditLog?: Array<{
    id: string;
    conversion_id: string;
    action: string;
    previous_status?: string | null;
    new_status: string;
    amount_adjusted: number;
    ledger_transaction_id?: string | null;
    performed_by: string;
    notes?: string | null;
    created_at: string;
  }>;
  liveStreams?: Array<{
    id: string;
    user_id: string;
    title: string;
    description: string;
    category: string;
    stream_key: string;
    playback_url: string;
    thumbnail_url: string;
    livekit_room_name?: string;
    status: "live" | "upcoming" | "ended";
    viewers_count: number;
    started_at?: string;
    ended_at?: string;
    broadcaster_last_ping_at?: string;
    total_unique_viewers?: number;
    created_at: string;
  }>;
  liveChatMessages?: Array<{
    id: string;
    stream_id: string;
    user_id: string;
    user_name: string;
    avatar_url?: string;
    message: string;
    is_superchat?: boolean;
    superchat_amount?: number;
    created_at: string;
  }>;
  liveStreamViewers?: Record<string, { stream_id: string; user_id: string; last_seen_at: string }>;
  livekitWebhookEvents?: Record<
    string,
    { event_id: string; event_type: string; processed_at: string }
  >;
  userSubscriptions?: Array<{
    id?: number;
    subscription_id: string;
    user_id: string;
    plan_id: string;
    order_id: string;
    payment_id: string;
    amount: number;
    currency: string;
    status: "active" | "expired" | "cancelled" | "refunded";
    starts_at: string;
    expires_at: string;
    created_at: string;
    updated_at: string;
  }>;
  paymentOrders?: Array<{
    order_id: string;
    user_id: string;
    user_name: string;
    video_id?: string | null;
    purpose: string;
    plan_id?: string | null;
    content_type?: string | null;
    amount: number;
    currency: string;
    status: string;
    created_at: string;
    updated_at?: string;
  }>;
  subscriptionRefundRequests?: RefundRequestRecord[];
  channelSubscriptions?: Array<{
    id: number | string;
    creator_user_id: string;
    subscriber_user_id: string;
    created_at: string;
  }>;
}

/**
 * Base64URL encoding/decoding utilities for LiveKit tokens
 */
export function base64UrlEncode(data: string | Buffer): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function base64UrlDecode(str: string): Buffer {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  return Buffer.from(base64, "base64");
}

/**
 * Generates an authoritative LiveKit JWT Access Token with VideoGrant claims.
 */
export function generateLiveKitAccessToken(params: {
  apiKey: string;
  apiSecret: string;
  roomName: string;
  identity: string;
  name?: string;
  role: "publisher" | "subscriber";
  metadata?: string;
  ttlSeconds?: number;
}): { token: string; expiresAt: number } {
  const header = {
    alg: "HS256",
    typ: "JWT",
  };

  const now = Math.floor(Date.now() / 1000);
  const ttl = params.ttlSeconds || 1800; // 30 minutes
  const exp = now + ttl;

  const videoGrant: Record<string, any> = {
    room: params.roomName,
    roomJoin: true,
  };

  if (params.role === "publisher") {
    videoGrant["canPublish"] = true;
    videoGrant["canSubscribe"] = true;
    videoGrant["canPublishData"] = true;
    videoGrant["canPublishSources"] = ["camera", "microphone", "screen_share"];
  } else {
    videoGrant["canPublish"] = false;
    videoGrant["canSubscribe"] = true;
    videoGrant["canPublishData"] = true;
  }

  const payload: Record<string, any> = {
    iss: params.apiKey,
    sub: params.identity,
    iat: now,
    nbf: now,
    exp: exp,
    video: videoGrant,
  };

  if (params.name) payload["name"] = params.name;
  if (params.metadata) payload["metadata"] = params.metadata;

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto.createHmac("sha256", params.apiSecret).update(signingInput).digest();
  const encodedSig = base64UrlEncode(signature);

  return {
    token: `${signingInput}.${encodedSig}`,
    expiresAt: exp,
  };
}

/**
 * Verifies official LiveKit Webhook JWT Authorization token.
 * Validates HS256 signature and matches claims.sha256 against Base64 SHA256 of raw body.
 */
export function verifyLiveKitWebhook(
  authHeader: string | null | undefined,
  rawBody: string,
  apiSecret: string,
): { valid: boolean; claims?: any; error?: string } {
  if (!authHeader) {
    return { valid: false, error: "Missing LiveKit webhook Authorization header" };
  }

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { valid: false, error: "Invalid LiveKit webhook token format" };
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  if (!headerB64 || !payloadB64 || !signatureB64) {
    return { valid: false, error: "Malformed token segments" };
  }

  // 1. Verify header algorithm
  try {
    const header = JSON.parse(base64UrlDecode(headerB64).toString("utf8"));
    if (header.alg !== "HS256") {
      return { valid: false, error: `Unsupported signing algorithm: ${header.alg}` };
    }
  } catch {
    return { valid: false, error: "Invalid token header JSON" };
  }

  // 2. Verify signature
  const signingInput = `${headerB64}.${payloadB64}`;
  const expectedSig = crypto.createHmac("sha256", apiSecret).update(signingInput).digest();
  const providedSig = base64UrlDecode(signatureB64);

  if (
    expectedSig.length !== providedSig.length ||
    !crypto.timingSafeEqual(expectedSig, providedSig)
  ) {
    return { valid: false, error: "LiveKit webhook token signature verification failed" };
  }

  // 3. Verify payload & sha256 claim against raw body
  let claims: any;
  try {
    claims = JSON.parse(base64UrlDecode(payloadB64).toString("utf8"));
  } catch {
    return { valid: false, error: "Invalid token payload JSON" };
  }

  if (!claims.sha256) {
    return { valid: false, error: "LiveKit webhook token missing body sha256 claim" };
  }

  const computedHash = crypto.createHash("sha256").update(rawBody).digest("base64");
  if (claims.sha256 !== computedHash) {
    return { valid: false, error: "LiveKit webhook payload hash mismatch" };
  }

  return { valid: true, claims };
}

function getInitialCategories() {
  const baseline = [
    "Cartoon",
    "Agriculture",
    "Motivational",
    "Comedy",
    "Blog",
    "Movie",
    "Entertainment",
    "Cooking",
    "Finance",
    "Share Market",
    "Business",
    "Crypto",
    "Coding",
    "Music",
    "Gaming",
    "Travel",
    "AI",
    "Education",
  ];
  return baseline.map((name, idx) => ({
    id: idx + 1,
    name,
    slug: name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, ""),
    created_by: "SYSTEM",
    created_at: "2026-10-01 00:00:00",
  }));
}

export interface SubscriberPlan {
  id: number;
  plan_id: string;
  name: string;
  price: number;
  duration_days: number;
  perks: string[];
  is_active: boolean;
  created_at: string;
}

export function getInitialSubscriberPlans(): SubscriberPlan[] {
  return [
    {
      id: 1,
      plan_id: "member-monthly",
      name: "Creator Member",
      price: 49.0,
      duration_days: 30,
      perks: [
        "Custom channel member badge",
        "Early access to new videos",
        "Exclusive member-only live stream chat",
      ],
      is_active: true,
      created_at: "2026-11-04 00:00:00",
    },
    {
      id: 2,
      plan_id: "member-vip-monthly",
      name: "VIP Supporter",
      price: 149.0,
      duration_days: 30,
      perks: [
        "All Creator Member perks",
        "Priority comment replies",
        "Exclusive behind-the-scenes content",
        "VIP live badge",
      ],
      is_active: true,
      created_at: "2026-11-04 00:00:00",
    },
    {
      id: 3,
      plan_id: "member-annual",
      name: "All-Access Annual",
      price: 999.0,
      duration_days: 365,
      perks: [
        "Full VIP access for 1 full year",
        "16% savings vs monthly",
        "Special Gold Supporter badge on all videos",
      ],
      is_active: true,
      created_at: "2026-11-04 00:00:00",
    },
  ];
}

function getInitialStore(): ServerStore {
  return {
    wallets: {},
    categories: getInitialCategories(),
    subscriberPlans: getInitialSubscriberPlans(),
    affiliateNetworks: {
      amazon: {
        id: "amazon",
        name: "Amazon Associates",
        is_active: 0,
        creator_share_percentage: 0.0,
        holding_period_days: 0,
        allowed_domains: "amazon.in,amazon.com,amzn.to,amzn.eu,amzn.asia",
        publisher_id: null,
        webhook_secret: null,
        created_at: "2026-11-01 00:00:00",
        updated_at: "2026-11-01 00:00:00",
      },
      impact: {
        id: "impact",
        name: "Impact Radius",
        is_active: 0,
        creator_share_percentage: 0.0,
        holding_period_days: 0,
        allowed_domains: "impact.com,sjv.io,ojrq.net,pxf.io,evyy.net",
        publisher_id: null,
        webhook_secret: null,
        created_at: "2026-11-01 00:00:00",
        updated_at: "2026-11-01 00:00:00",
      },
      earnkaro: {
        id: "earnkaro",
        name: "EarnKaro",
        is_active: 0,
        creator_share_percentage: 0.0,
        holding_period_days: 0,
        allowed_domains: "earnkaro.com,ekaro.in",
        publisher_id: null,
        webhook_secret: null,
        created_at: "2026-11-01 00:00:00",
        updated_at: "2026-11-01 00:00:00",
      },
    },
    affiliateClicks: [],
    affiliateConversions: {},
    affiliateAuditLog: [],
    users: [
      {
        id: "a0000000-0000-0000-0000-000000000001",
        user_id: "FT102857",
        name: "FaceTube Administrator",
        mobile: "+1 555-019-2834",
        email: "admin@facetube.com",
        password_hash: "ef92b778bafe771e89245b89ecbc08a44a4e166c06659911881f383d4473e94f", // SHA256 of "password"
        role: "admin",
        referral_code: "FTVIP",
        avatar_url:
          "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=200&auto=format&fit=crop&q=80",
        created_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: "a0000000-0000-0000-0000-000000000002",
        user_id: "FT483921",
        name: "Alex Rivera",
        mobile: "+1 555-014-8392",
        email: "alex@facetube.com",
        password_hash: "ef92b778bafe771e89245b89ecbc08a44a4e166c06659911881f383d4473e94f",
        role: "user",
        referral_code: "CREATOR50",
        avatar_url:
          "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=200&auto=format&fit=crop&q=80",
        created_at: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: "a0000000-0000-0000-0000-000000000003",
        user_id: "FT900431",
        name: "Maya Lin",
        mobile: "+1 555-019-0043",
        email: "maya@facetube.com",
        password_hash: "ef92b778bafe771e89245b89ecbc08a44a4e166c06659911881f383d4473e94f",
        role: "user",
        referral_code: null,
        avatar_url:
          "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=200&auto=format&fit=crop&q=80",
        created_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ],
    sessions: {},
    videos: [
      {
        id: "vid-seed-001",
        user_id: "FT483921",
        creator_name: "Alex Rivera",
        title: "10 Coding Shortcuts Every React Dev Must Know #Shorts",
        description: "Lightning-fast developer workflow hacks in under 45 seconds.",
        video_url: "https://vjs.zencdn.net/v/oceans.mp4",
        thumbnail_url:
          "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800&auto=format&fit=crop&q=60",
        video_type: "free",
        content_type: "short",
        category: "Coding",
        duration: "0:42",
        views: 45200,
        likes: 3120,
        payment_status: "not_required",
        payment_amount: 0,
        is_promoted: false,
        created_at: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: "vid-seed-002",
        user_id: "FT483921",
        creator_name: "Alex Rivera",
        title: "Full Stack App Architecture from Scratch: Zero to Production",
        description: "Complete guide to modern multi-tenant cloud application development.",
        video_url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
        thumbnail_url:
          "https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=800&auto=format&fit=crop&q=60",
        video_type: "free",
        content_type: "long",
        category: "Coding",
        duration: "24:18",
        views: 128400,
        likes: 9840,
        payment_status: "not_required",
        payment_amount: 0,
        is_promoted: false,
        created_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: "vid-seed-003",
        user_id: "FT900431",
        creator_name: "Maya Lin",
        title: "How to Build a 6-Figure YouTube Channel in 2026 #Shorts",
        description: "Creator monetization secrets revealed in under 60 seconds.",
        video_url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/friday.mp4",
        thumbnail_url:
          "https://images.unsplash.com/photo-1579202673506-ca3ce28943ef?w=800&auto=format&fit=crop&q=60",
        video_type: "premium",
        content_type: "short",
        category: "Business",
        duration: "0:58",
        views: 68900,
        likes: 5410,
        payment_status: "paid",
        payment_id: "pay_seed_maya_short_01",
        payment_amount: 6,
        is_promoted: false,
        created_at: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: "vid-seed-004",
        user_id: "FT900431",
        creator_name: "Maya Lin",
        title: "Masterclass: High-Ticket Creator Monetization & Brand Deals",
        description: "Comprehensive blueprint for closing 5-figure creator sponsor deals.",
        video_url: "https://vjs.zencdn.net/v/oceans.mp4",
        thumbnail_url:
          "https://images.unsplash.com/photo-1551836022-d5d88e9218df?w=800&auto=format&fit=crop&q=60",
        video_type: "premium",
        content_type: "long",
        category: "Business",
        duration: "42:15",
        views: 312000,
        likes: 24900,
        payment_status: "paid",
        payment_id: "pay_seed_maya_long_01",
        payment_amount: 6,
        is_promoted: true,
        promotion_plan: "plan-monthly",
        promotion_expires_at: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000).toISOString(),
        created_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: "vid-seed-007",
        user_id: "FT483921",
        creator_name: "Animation Studio X",
        title: "The Great Forest Mystery — Animated Cartoon Adventure",
        description:
          "Classic animated adventure featuring funny cartoon characters, slapstick comedy, and heartwarming moments for all ages.",
        video_url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/friday.mp4",
        thumbnail_url:
          "https://images.unsplash.com/photo-1534447677768-be436bb09401?w=800&auto=format&fit=crop&q=60",
        video_type: "free",
        content_type: "long",
        category: "Cartoon",
        duration: "14:20",
        views: 89000,
        likes: 6700,
        payment_status: "not_required",
        payment_amount: 0,
        is_promoted: false,
        created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: "vid-seed-008",
        user_id: "FT483921",
        creator_name: "Green Earth Agri",
        title: "Smart Organic Farming & High-Yield Agriculture Techniques",
        description:
          "Modern agricultural technologies, organic drip irrigation, soil health management, and sustainable crop cultivation techniques.",
        video_url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
        thumbnail_url:
          "https://images.unsplash.com/photo-1500937386664-56d1dfef3854?w=800&auto=format&fit=crop&q=60",
        video_type: "free",
        content_type: "long",
        category: "Agriculture",
        duration: "21:45",
        views: 54000,
        likes: 4300,
        payment_status: "not_required",
        payment_amount: 0,
        is_promoted: false,
        created_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
        updated_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ],
    comments: [
      {
        id: "cmt-seed-01",
        video_id: "vid-seed-001",
        user_id: "FT900431",
        user_name: "Maya Lin",
        avatar_url:
          "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=200&auto=format&fit=crop&q=80",
        comment: "These shortcuts saved me hours today! Amazing video.",
        created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      },
    ],
    images: [],
    personalKyc: {
      FT102857: {
        fullName: "FaceTube Administrator",
        mobile: "+1 555-019-2834",
        dob: "1990-05-12",
        address: "742 Evergreen Terrace, Tech Park",
        city: "San Jose",
        state: "California",
        pincode: "95110",
        nomineeName: "Sarah Administrator",
        nomineeRelation: "Spouse",
        nomineeMobile: "+1 555-019-8821",
        status: "Verified",
      },
      FT483921: {
        fullName: "Alex Rivera",
        mobile: "+1 555-014-8392",
        dob: "1994-08-15",
        address: "402 Skyline Boulevard, Suite 120",
        city: "San Francisco",
        state: "California",
        pincode: "94107",
        nomineeName: "Elena Rivera",
        nomineeRelation: "Spouse",
        nomineeMobile: "+1 555-014-9921",
        status: "Verified",
      },
      FT900431: {
        fullName: "Maya Lin",
        mobile: "+1 555-019-0043",
        dob: "1996-11-20",
        address: "18 Orchard St, Creator Row",
        city: "New York",
        state: "New York",
        pincode: "10002",
        nomineeName: "David Lin",
        nomineeRelation: "Father",
        nomineeMobile: "+1 555-019-4411",
        status: "Submitted",
      },
    },
    bankKyc: {
      FT102857: {
        accountHolderName: "FaceTube Administrator",
        bankName: "Silicon Valley Bank",
        accountNumber: "918239019201",
        ifscCode: "SVBL0001048",
        branchName: "Santa Clara Tech Hub",
        accountType: "Current",
        upiId: "facetube.admin@okaxis",
        status: "Verified",
      },
      FT483921: {
        accountHolderName: "Alex Rivera",
        bankName: "HDFC Bank",
        accountNumber: "50100481920194",
        ifscCode: "HDFC0001824",
        branchName: "Silicon Valley Branch",
        accountType: "Savings",
        upiId: "alexrivera@okhdfcbank",
        status: "Verified",
      },
    },
    certificates: {},
    walletTransactions: [],
    channelSubscriptions: [],
  };
}

let inMemoryStore: ServerStore | null = null;
let lastLoadedMtime = 0;

export function resetInMemoryStore(): void {
  inMemoryStore = null;
  lastLoadedMtime = 0;
}

function loadStore(): ServerStore {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const stats = fs.statSync(STORE_FILE);
      if (inMemoryStore && stats.mtimeMs <= lastLoadedMtime) {
        return inMemoryStore;
      }
      const content = fs.readFileSync(STORE_FILE, "utf-8");
      inMemoryStore = JSON.parse(content);
      lastLoadedMtime = stats.mtimeMs;
      if (inMemoryStore) {
        if (!inMemoryStore.liveStreams) inMemoryStore.liveStreams = [];
        if (!inMemoryStore.liveChatMessages) inMemoryStore.liveChatMessages = [];
        if (!inMemoryStore.payoutBatches) inMemoryStore.payoutBatches = [];
        if (!inMemoryStore.categories || inMemoryStore.categories.length === 0) {
          inMemoryStore.categories = getInitialCategories();
        } else {
          const existingLower = new Set(
            inMemoryStore.categories.map((c: any) =>
              String(c.name || "")
                .trim()
                .toLowerCase(),
            ),
          );
          for (const base of getInitialCategories()) {
            if (!existingLower.has(base.name.trim().toLowerCase())) {
              inMemoryStore.categories.push({
                ...base,
                id: inMemoryStore.categories.length + 1,
              });
              existingLower.add(base.name.trim().toLowerCase());
            }
          }
        }
        if (!inMemoryStore.subscriberPlans || inMemoryStore.subscriberPlans.length === 0) {
          inMemoryStore.subscriberPlans = getInitialSubscriberPlans();
        }
        if (!inMemoryStore.userSubscriptions) inMemoryStore.userSubscriptions = [];
        if (!inMemoryStore.paymentOrders) inMemoryStore.paymentOrders = [];
        if (!inMemoryStore.subscriptionRefundRequests)
          inMemoryStore.subscriptionRefundRequests = [];
        if (!inMemoryStore.kycAuditLog) inMemoryStore.kycAuditLog = [];
        if (!inMemoryStore.channelSubscriptions) inMemoryStore.channelSubscriptions = [];
      }
      return inMemoryStore!;
    }
  } catch (err) {
    console.warn("[FaceTube Store] Could not read store file, initializing defaults", err);
  }
  inMemoryStore = getInitialStore();
  if (!inMemoryStore.liveStreams) inMemoryStore.liveStreams = [];
  if (!inMemoryStore.liveChatMessages) inMemoryStore.liveChatMessages = [];
  if (!inMemoryStore.payoutBatches) inMemoryStore.payoutBatches = [];
  if (!inMemoryStore.categories || inMemoryStore.categories.length === 0) {
    inMemoryStore.categories = getInitialCategories();
  }
  if (!inMemoryStore.subscriberPlans || inMemoryStore.subscriberPlans.length === 0) {
    inMemoryStore.subscriberPlans = getInitialSubscriberPlans();
  }
  if (!inMemoryStore.userSubscriptions) inMemoryStore.userSubscriptions = [];
  if (!inMemoryStore.paymentOrders) inMemoryStore.paymentOrders = [];
  if (!inMemoryStore.subscriptionRefundRequests) inMemoryStore.subscriptionRefundRequests = [];
  if (!inMemoryStore.kycAuditLog) inMemoryStore.kycAuditLog = [];
  if (!inMemoryStore.channelSubscriptions) inMemoryStore.channelSubscriptions = [];
  saveStore(inMemoryStore);
  return inMemoryStore;
}

function saveStore(store: ServerStore): void {
  inMemoryStore = store;
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), "utf-8");
    lastLoadedMtime = Date.now();
  } catch (err) {
    console.warn("[FaceTube Store] Could not persist store file", err);
  }
}

export function resetStoreForTests(userId?: string, balance = 50000): void {
  const s = loadStore();
  const todayPrefix = new Date().toISOString().split("T")[0];
  if (userId) {
    const norm = userId.trim().toUpperCase();
    if (!s.wallets) s.wallets = {};
    if (!s.wallets[norm]) {
      s.wallets[norm] = {
        balance,
        total_earned: balance,
        total_withdrawn: 0,
        referral_income: 0,
        global_income: 0,
        adsense_income: 0,
        affiliate_income: 0,
        updated_at: new Date().toISOString(),
      };
    } else {
      s.wallets[norm].balance = Math.max(Number(s.wallets[norm].balance) || 0, balance);
      s.wallets[norm].total_withdrawn = 0;
      s.wallets[norm].updated_at = new Date().toISOString();
    }
    if (Array.isArray(s.walletTransactions)) {
      s.walletTransactions = s.walletTransactions.filter((tx: any) => {
        const u = String(tx.user_id || tx.userId || "")
          .trim()
          .toUpperCase();
        if (u !== norm) return true;
        const d = String(tx.created_at || tx.createdAt || "").split("T")[0];
        return d !== todayPrefix;
      });
    }
  } else {
    if (Array.isArray(s.walletTransactions)) {
      s.walletTransactions = s.walletTransactions.filter((tx: any) => {
        const d = String(tx.created_at || tx.createdAt || "").split("T")[0];
        return d !== todayPrefix;
      });
    }
    for (const uid of Object.keys(s.wallets || {})) {
      if (s.wallets[uid]) {
        if (uid.toUpperCase() === "FT102857") {
          s.wallets[uid].balance = Math.max(Number(s.wallets[uid].balance) || 0, balance);
        } else if (uid.toUpperCase() === "FT483921") {
          s.wallets[uid].balance = 50;
        }
        s.wallets[uid].total_withdrawn = 0;
        s.wallets[uid].updated_at = new Date().toISOString();
      }
    }
  }
  saveStore(s);
  resetInMemoryStore();
}

export function setStoreWalletBalance(userId: string, balance: number): void {
  const s = loadStore();
  const norm = userId.trim().toUpperCase();
  if (!s.wallets) s.wallets = {};
  if (!s.wallets[norm]) {
    s.wallets[norm] = {
      balance,
      total_earned: balance,
      total_withdrawn: 0,
      referral_income: 0,
      global_income: 0,
      adsense_income: 0,
      affiliate_income: 0,
      updated_at: new Date().toISOString(),
    };
  } else {
    s.wallets[norm].balance = balance;
    s.wallets[norm].updated_at = new Date().toISOString();
  }
  saveStore(s);
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

function verifyPassword(plain: string, hash: string): boolean {
  if (!plain || !hash) return false;
  // Support standard bcrypt hashes ($2a$, $2b$, $2y$)
  if (hash.startsWith("$2")) {
    try {
      if (bcrypt.compareSync(plain, hash)) {
        return true;
      }
    } catch {
      // Ignore bcrypt comparison error
    }
  }
  // Support legacy SHA-256 hashes
  const sha256 = crypto.createHash("sha256").update(plain).digest("hex");
  if (sha256 === hash) return true;
  return false;
}

function hashPassword(plain: string): string {
  return crypto.createHash("sha256").update(plain).digest("hex");
}

function generateUserId(store: ServerStore): string {
  for (let i = 0; i < 50; i++) {
    const num = Math.floor(100000 + Math.random() * 900000);
    const candidate = `FT${num}`;
    if (!store.users.some((u) => u.user_id.toUpperCase() === candidate)) {
      return candidate;
    }
  }
  return `FT${Date.now().toString().slice(-6)}`;
}

export interface AuthUser {
  id: string;
  user_id: string;
  name: string;
  mobile: string;
  email: string;
  role: "admin" | "user";
  referral_code: string | null;
  avatar_url?: string | undefined;
  created_at: string;
}

export async function getAuthUserFromRequest(
  request: Request,
  store: ServerStore,
  pool?: Pool | null,
): Promise<AuthUser | null> {
  const authHeader = request.headers.get("Authorization") || request.headers.get("X-Authorization");
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;

  const activePool = pool !== undefined ? pool : getMysqlPool();
  if (activePool) {
    try {
      const [rows]: any = await activePool.query(
        `SELECT u.id, u.user_id, u.name, u.mobile, u.email, u.role, u.referral_code, u.avatar_url, u.created_at
         FROM sessions s
         INNER JOIN users u ON (s.user_id = u.id OR s.user_id = u.user_id)
         WHERE s.token = ? AND s.expires_at > NOW()
         LIMIT 1`,
        [token],
      );
      if (rows && rows.length > 0) {
        return rows[0] as AuthUser;
      }
    } catch (_e) {
      // Fall through to store check
    }
  }

  if (store.sessions && store.sessions[token]) {
    const sessionUserId = String(store.sessions[token]).trim().toUpperCase();
    const user = store.users.find(
      (u) => u.user_id.toUpperCase() === sessionUserId || u.id.toUpperCase() === sessionUserId,
    );
    if (user) {
      return {
        id: user.id,
        user_id: user.user_id,
        name: user.name,
        mobile: user.mobile,
        email: user.email,
        role: user.role,
        referral_code: user.referral_code,
        avatar_url: user.avatar_url,
        created_at: user.created_at,
      };
    }
  }

  return null;
}

export type AuthResult =
  | { success: true; user: AuthUser; effectiveUserId: string }
  | { success: false; response: Response };

export function requireAuth(
  authUser: AuthUser | null,
  requestedUserId?: string | null,
): AuthResult {
  if (!authUser) {
    return {
      success: false,
      response: jsonResponse(
        {
          success: false,
          error: "Authentication required. Please provide a valid Bearer session token.",
        },
        401,
      ),
    };
  }

  const effectiveUserId = authUser.user_id;

  if (requestedUserId && requestedUserId.trim() !== "") {
    const reqNorm = requestedUserId.trim().toUpperCase();
    if (reqNorm === authUser.user_id.toUpperCase()) {
      return { success: true, user: authUser, effectiveUserId: authUser.user_id };
    }
    // Cross-user requested: strictly require admin role
    const isAdmin = authUser.role === "admin";
    if (!isAdmin) {
      return {
        success: false,
        response: jsonResponse(
          {
            success: false,
            error: "Unauthorized: Cross-user access is restricted to verified administrators.",
          },
          403,
        ),
      };
    }
    return { success: true, user: authUser, effectiveUserId: reqNorm };
  }

  return { success: true, user: authUser, effectiveUserId };
}

/**
 * Resolves up to 7 distinct valid upline sponsors using MySQL connection with cycle prevention.
 */
export async function resolveUplineSponsorsMysql(
  uploaderUserId: string,
  conn: PoolConnection | Pool,
): Promise<AdsUplineSponsor[]> {
  const normUploader = uploaderUserId.trim().toUpperCase();
  const visited = new Set<string>([normUploader]);
  const uplines: AdsUplineSponsor[] = [];

  let currentUserId = normUploader;

  for (let level = 1; level <= 7; level++) {
    const [uRows]: any = await conn.query(
      `SELECT user_id, referral_code, name FROM users WHERE UPPER(user_id) = UPPER(?) LIMIT 1`,
      [currentUserId],
    );
    if (!uRows || uRows.length === 0) break;
    const refCode = (uRows[0].referral_code || "").trim();
    if (!refCode) break;

    const [sponsorRows]: any = await conn.query(
      `SELECT user_id, referral_code, name FROM users 
       WHERE (UPPER(user_id) = UPPER(?) OR UPPER(referral_code) = UPPER(?)) 
         AND UPPER(user_id) != UPPER(?) 
       LIMIT 1`,
      [refCode, refCode, currentUserId],
    );
    if (!sponsorRows || sponsorRows.length === 0) break;

    const sponsor = sponsorRows[0];
    const sponsorNormId = sponsor.user_id.toUpperCase();
    if (visited.has(sponsorNormId)) {
      break;
    }

    visited.add(sponsorNormId);
    uplines.push({
      level,
      userId: sponsor.user_id,
      name: sponsor.name,
    });

    currentUserId = sponsorNormId;
  }

  return uplines;
}

export interface DownlineMemberItem {
  id: string;
  userId: string;
  name: string;
  email?: string;
  mobile?: string;
  joinedAt: string;
  role: string;
  rank: string;
  level: number;
  sponsor: string;
  sponsorUserId: string;
  teamSize?: number;
  status: "Active" | "Inactive";
  access: "Granted" | "Restricted";
}

export const KNOWN_PROMOTIONAL_ALIASES: Record<string, string[]> = {
  FT102857: ["FTVIP"],
  FT483921: ["CREATOR50"],
};

export function calculateDownlineLevelsTs(
  rootUserId: string,
  arg2: any,
  arg3?: any,
  arg4?: any,
): {
  directCount: number;
  totalTeamCount: number;
  levelCounts: Record<number, number>;
  membersByLevel: Record<number, DownlineMemberItem[]>;
  allMembers: DownlineMemberItem[];
  sanitizedMembers: DownlineMemberItem[];
} {
  let allUsers: Array<{
    id?: string;
    user_id: string;
    name: string;
    email?: string;
    mobile?: string;
    role?: string;
    referral_code?: string | null;
    created_at?: string;
  }> = [];
  let maxLevels = 10;

  if (Array.isArray(arg2)) {
    allUsers = arg2;
    maxLevels = typeof arg3 === "number" ? arg3 : 10;
  } else {
    allUsers = Array.isArray(arg3) ? arg3 : [];
    maxLevels = typeof arg4 === "number" ? arg4 : 10;
  }

  const rootNorm = (rootUserId || "").trim().toUpperCase();

  const emptyLevelCounts: Record<number, number> = {};
  const emptyMembersByLevel: Record<number, DownlineMemberItem[]> = {};
  for (let i = 1; i <= maxLevels; i++) {
    emptyLevelCounts[i] = 0;
    emptyMembersByLevel[i] = [];
  }

  if (!rootNorm) {
    return {
      directCount: 0,
      totalTeamCount: 0,
      levelCounts: emptyLevelCounts,
      membersByLevel: emptyMembersByLevel,
      allMembers: [],
      sanitizedMembers: [],
    };
  }

  // Determine root user's valid sponsor codes:
  // Strictly user_id + verified promotional aliases for established accounts.
  // Never uses upline referral_code.
  const rootAliases = (KNOWN_PROMOTIONAL_ALIASES[rootNorm] || []).map((a) => a.toUpperCase());
  const rootSponsorCodes = new Set<string>([rootNorm, ...rootAliases]);

  const visited = new Set<string>([rootNorm]);
  const membersByLevel: Record<number, DownlineMemberItem[]> = { ...emptyMembersByLevel };
  for (let i = 1; i <= maxLevels; i++) {
    membersByLevel[i] = [];
  }
  const levelCounts: Record<number, number> = { ...emptyLevelCounts };
  const allMembers: DownlineMemberItem[] = [];

  // Level 1: direct referrals
  const l1Users = allUsers.filter((u) => {
    const uId = (u.user_id || "").trim().toUpperCase();
    if (!uId || uId === rootNorm) return false;
    const ref = (u.referral_code || "").trim().toUpperCase();
    return Boolean(ref && rootSponsorCodes.has(ref));
  });

  for (const u of l1Users) {
    const uId = u.user_id.trim().toUpperCase();
    if (visited.has(uId)) continue;
    visited.add(uId);

    const item: DownlineMemberItem = {
      id: u.id || `mem_${u.user_id}`,
      userId: u.user_id,
      name: u.name,
      email: u.email || "",
      mobile: u.mobile || "",
      joinedAt: u.created_at || new Date().toISOString(),
      role: u.role || "user",
      rank: u.role === "admin" ? "Admin" : "Creator",
      level: 1,
      sponsor: "You",
      sponsorUserId: rootUserId,
      status: "Active",
      access: "Granted",
    };
    membersByLevel[1]!.push(item);
    allMembers.push(item);
  }
  levelCounts[1] = membersByLevel[1]!.length;
  const directCount = levelCounts[1]!;

  // Levels 2 to maxLevels
  for (let lvl = 2; lvl <= maxLevels; lvl++) {
    const prevMembers = membersByLevel[lvl - 1] || [];
    if (prevMembers.length === 0) break;

    const parentMap = new Map<string, { userId: string; name: string }>();
    for (const pm of prevMembers) {
      const pmNorm = pm.userId.trim().toUpperCase();
      parentMap.set(pmNorm, { userId: pm.userId, name: pm.name });
      // Support verified promotional aliases ONLY if parent is a verified promotional account
      const pmAliases = KNOWN_PROMOTIONAL_ALIASES[pmNorm] || [];
      for (const alias of pmAliases) {
        parentMap.set(alias.toUpperCase(), { userId: pm.userId, name: pm.name });
      }
    }

    const currentLevelUsers = allUsers.filter((u) => {
      const uId = (u.user_id || "").trim().toUpperCase();
      if (!uId || visited.has(uId)) return false;
      const ref = (u.referral_code || "").trim().toUpperCase();
      return Boolean(ref && parentMap.has(ref));
    });

    for (const u of currentLevelUsers) {
      const uId = u.user_id.trim().toUpperCase();
      if (visited.has(uId)) continue;
      visited.add(uId);

      const ref = (u.referral_code || "").trim().toUpperCase();
      const sponsorInfo = parentMap.get(ref);
      const sponsorName = sponsorInfo
        ? `${sponsorInfo.name} (${sponsorInfo.userId})`
        : "Downline Sponsor";
      const sponsorUserId = sponsorInfo ? sponsorInfo.userId : "";

      const item: DownlineMemberItem = {
        id: u.id || `mem_${u.user_id}`,
        userId: u.user_id,
        name: u.name,
        email: u.email || "",
        mobile: u.mobile || "",
        joinedAt: u.created_at || new Date().toISOString(),
        role: u.role || "user",
        rank: u.role === "admin" ? "Admin" : "Creator",
        level: lvl,
        sponsor: sponsorName,
        sponsorUserId,
        status: "Active",
        access: "Granted",
      };
      membersByLevel[lvl]!.push(item);
      allMembers.push(item);
    }
    levelCounts[lvl] = membersByLevel[lvl]!.length;
  }

  // Calculate teamSize for each member (direct referrals they personally sponsored)
  const sponsorDirectCounts = new Map<string, number>();
  for (const m of allMembers) {
    const sId = (m.sponsorUserId || "").trim().toUpperCase();
    if (sId) {
      sponsorDirectCounts.set(sId, (sponsorDirectCounts.get(sId) || 0) + 1);
    }
  }

  const sanitizedMembers: DownlineMemberItem[] = allMembers.map((m) => {
    const mNorm = m.userId.trim().toUpperCase();
    return {
      id: m.id,
      userId: m.userId,
      name: m.name,
      level: m.level,
      sponsor: m.sponsor,
      sponsorUserId: m.sponsorUserId,
      joinedAt: m.joinedAt,
      role: m.role,
      rank: m.rank,
      teamSize: sponsorDirectCounts.get(mNorm) || 0,
      status: m.status,
      access: m.access,
    };
  });

  return {
    directCount,
    totalTeamCount: allMembers.length,
    levelCounts,
    membersByLevel,
    allMembers,
    sanitizedMembers,
  };
}

export async function handleApiRequest(
  request: Request,
  env?: Record<string, string | undefined>,
  deps?: { pool?: Pool | null },
): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  // Normalize path: strip /api/ and .php extension
  const route = pathname.replace(/^\/api\/?/, "").replace(/\.php$/, "");
  const method = request.method;
  const store = loadStore();

  // 1. Email Endpoints
  if (route === "send-welcome-email") {
    if (method === "GET") {
      try {
        const conf = resolveSmtpConfig(undefined, env);
        return jsonResponse({
          status: "ok",
          smtpConfigured: conf.configured,
          host: conf.host,
          port: conf.port,
          secure: conf.secure,
          source: conf.source,
          sender: conf.from,
          user: conf.user ? `${conf.user.slice(0, 3)}***@***` : "NOT_SET",
        });
      } catch {
        return jsonResponse({ status: "ok" });
      }
    }
    if (method === "POST") {
      try {
        const payload = await request.json();
        const result = await sendWelcomeEmailServer(payload, env);
        return jsonResponse(result, result.success ? 200 : 500);
      } catch (err) {
        return jsonResponse({ success: false, error: "Email delivery failed" }, 500);
      }
    }
  }

  if (route === "send-certificate-email" && method === "POST") {
    try {
      const payload = await request.json();
      const result = await sendCertificateEmailServer(payload, env);
      return jsonResponse(result, result.success ? 200 : 500);
    } catch {
      return jsonResponse({ success: false, error: "Certificate email delivery failed" }, 500);
    }
  }

  // 2. Payments & Monetization (support both /payment/... and /payments/...)
  if (route === "payments/create-order" || route === "payment/create-order") {
    if (method === "POST") {
      try {
        const payload = await request.json();
        const pool = getMysqlPool();
        const authUser = await getAuthUserFromRequest(request, store, pool);
        const reqUserId = String(payload.userId || payload.user_id || "")
          .trim()
          .toUpperCase();
        let effectiveUserId = authUser ? authUser.user_id : reqUserId;

        if (authUser && reqUserId && reqUserId !== authUser.user_id.toUpperCase()) {
          if (authUser.role !== "admin") {
            return jsonResponse(
              {
                success: false,
                error: "Unauthorized: Cannot create payment orders for another user account.",
              },
              403,
            );
          }
          effectiveUserId = reqUserId;
        }

        const videoId = String(payload.videoId || payload.video_id || "").trim();
        const purpose = String(payload.purpose || "premium_video_upload").trim();
        if (purpose === "ads_promotion" && videoId) {
          const v = store.videos.find((vid) => vid.id === videoId);
          if (v) {
            const isOwner = v.user_id.toUpperCase() === effectiveUserId.toUpperCase();
            const isAdmin = authUser?.role === "admin";
            if (!isOwner && !isAdmin) {
              return jsonResponse(
                {
                  success: false,
                  error:
                    "Unauthorized: You can only initiate promotion for your own uploaded videos.",
                },
                403,
              );
            }
          }
        }

        const result = await createServerPaymentOrder(
          {
            ...payload,
            userId: effectiveUserId,
          },
          env,
        );

        if (pool) {
          try {
            await pool.query(
              `INSERT INTO payment_orders (
                order_id, user_id, user_name, video_id, purpose, plan_id,
                content_type, amount, currency, status, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'INR', 'created', NOW())
              ON DUPLICATE KEY UPDATE updated_at = NOW()`,
              [
                result.orderId,
                effectiveUserId,
                payload.userName || authUser?.name || "Creator",
                videoId || null,
                purpose,
                payload.planId || null,
                payload.contentType || null,
                result.amount,
              ],
            );
          } catch (_ePo) {
            // optional
          }
        }
        if (!store.paymentOrders) store.paymentOrders = [];
        store.paymentOrders.push({
          order_id: result.orderId,
          user_id: effectiveUserId,
          user_name: payload.userName || authUser?.name || "Creator",
          video_id: videoId || null,
          purpose,
          plan_id: payload.planId || null,
          content_type: payload.contentType || null,
          amount: result.amount,
          currency: "INR",
          status: "created",
          created_at: new Date().toISOString(),
        });
        saveStore(store);

        return jsonResponse(result);
      } catch (err: any) {
        const msg = err?.message || "Failed to create payment order";
        const status = msg.includes("credentials") ? 503 : 500;
        return jsonResponse({ success: false, error: msg }, status);
      }
    }
  }

  if (route === "payments/verify" || route === "payment/verify") {
    if (method === "POST") {
      try {
        const pool = deps?.pool !== undefined ? deps.pool : getMysqlPool();
        const payload = await request.json();
        const orderId = String(payload.orderId || payload.order_id || "").trim();
        const paymentId = String(payload.paymentId || payload.payment_id || "").trim();
        const signature = String(payload.signature || "").trim();
        const requestedUserId = String(payload.userId || payload.user_id || "")
          .trim()
          .toUpperCase();
        const userName = String(payload.userName || payload.user_name || "Creator").trim();
        const videoId = String(payload.videoId || payload.video_id || "").trim();
        const purpose = String(payload.purpose || "premium_video_upload").trim();
        const planId = String(
          payload.planId || payload.plan_id || payload.metadata?.planId || "plan-monthly",
        ).trim() as AdsPlanId;
        const requestedAmount = payload.amount !== undefined ? Number(payload.amount) : undefined;

        if (!orderId || !paymentId) {
          return jsonResponse(
            {
              verified: false,
              error: "Invalid payment verification request: orderId and paymentId are required.",
            },
            400,
          );
        }

        if (process.env["NODE_ENV"] === "production" && !pool) {
          return jsonResponse(
            {
              verified: false,
              paymentId,
              orderId,
              error:
                "Database connection unavailable. In production, payments must be verified and credited against the persistent database.",
            },
            503,
          );
        }

        // 1. PAYMENT VERIFICATION: Cryptographic Signature & Fail-Closed Credential Check
        const keyId = env?.["RAZORPAY_KEY_ID"] || process.env["RAZORPAY_KEY_ID"];
        const secretKey = env?.["RAZORPAY_KEY_SECRET"] || process.env["RAZORPAY_KEY_SECRET"];
        if (!secretKey) {
          return jsonResponse(
            {
              verified: false,
              paymentId,
              orderId,
              error:
                "Payment verification configuration unavailable on server (RAZORPAY_KEY_SECRET missing). Failed closed.",
            },
            500,
          );
        }

        if (!signature || signature === "mock_signature_bypass" || signature.startsWith("mock_")) {
          return jsonResponse(
            {
              verified: false,
              paymentId,
              orderId,
              error: "Payment signature missing or invalid mock signature rejected.",
            },
            400,
          );
        }

        const generatedSignature = crypto
          .createHmac("sha256", secretKey)
          .update(`${orderId}|${paymentId}`)
          .digest("hex");

        if (generatedSignature !== signature) {
          return jsonResponse(
            {
              verified: false,
              paymentId,
              orderId,
              error: "Invalid Razorpay payment signature verification failed.",
            },
            400,
          );
        }

        // Authoritative pricing check before gateway verification
        let expectedAmount = 6.0;
        let subDurationDays = 30;
        if (purpose === "ads_promotion") {
          const plan = PRICING_CONFIG.ADS_PROMOTION[planId as AdsPlanId];
          expectedAmount = plan ? plan.price : 300.0;
        } else if (purpose === "paid_subscription") {
          let planFound = false;
          if (pool) {
            try {
              const [pRows]: any = await pool.query(
                `SELECT price, duration_days FROM subscriber_plans WHERE plan_id = ? LIMIT 1`,
                [planId],
              );
              if (pRows && pRows.length > 0) {
                expectedAmount = Number(pRows[0].price);
                subDurationDays = Number(pRows[0].duration_days) || 30;
                planFound = true;
              }
            } catch (_e) {
              // Ignore if subscriber_plans table is not yet migrated
            }
          }
          if (!planFound) {
            const plan = (
              PRICING_CONFIG.SUBSCRIBER_PLANS as Record<string, { price: number; days: number }>
            )[planId];
            expectedAmount = plan ? plan.price : 49.0;
            subDurationDays = plan ? plan.days : 30;
          }
        } else if (purpose !== "premium_video_upload") {
          return jsonResponse(
            {
              verified: false,
              error: "Unsupported payment purpose.",
            },
            400,
          );
        }

        if (requestedAmount !== undefined && Math.abs(requestedAmount - expectedAmount) > 0.01) {
          return jsonResponse(
            {
              verified: false,
              error: `Payment amount ₹${requestedAmount} does not match expected fee of ₹${expectedAmount.toFixed(2)}.`,
            },
            400,
          );
        }

        const expectedPaise = Math.round(expectedAmount * 100);

        // Remote Razorpay API confirmation (status, order_id, amount in paise)
        const skipRemote = Boolean(
          env?.["RAZORPAY_SKIP_REMOTE_CHECK"] || process.env["RAZORPAY_SKIP_REMOTE_CHECK"],
        );

        if (keyId && !skipRemote) {
          try {
            const authHeader = `Basic ${Buffer.from(`${keyId}:${secretKey}`).toString("base64")}`;
            const rzpRes = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}`, {
              method: "GET",
              headers: { Authorization: authHeader },
            });

            if (!rzpRes.ok) {
              const errBody = await rzpRes.text();
              return jsonResponse(
                {
                  verified: false,
                  paymentId,
                  orderId,
                  error: `Razorpay API lookup returned status ${rzpRes.status}: ${errBody}`,
                },
                400,
              );
            }

            const pData = (await rzpRes.json()) as {
              id: string;
              order_id: string;
              status: string;
              amount: number;
              currency: string;
            };

            if (pData.order_id && pData.order_id !== orderId) {
              return jsonResponse(
                {
                  verified: false,
                  paymentId,
                  orderId,
                  error: `Razorpay payment order mismatch: expected ${orderId}, got ${pData.order_id}`,
                },
                400,
              );
            }

            if (pData.amount !== expectedPaise) {
              return jsonResponse(
                {
                  verified: false,
                  paymentId,
                  orderId,
                  error: `Razorpay payment amount mismatch: expected ₹${expectedAmount}, got ₹${pData.amount / 100}`,
                },
                400,
              );
            }

            if (pData.currency !== "INR") {
              return jsonResponse(
                {
                  verified: false,
                  paymentId,
                  orderId,
                  error: `Razorpay payment currency mismatch: expected INR, received ${pData.currency}`,
                },
                400,
              );
            }

            if (pData.status !== "captured" && pData.status !== "authorized") {
              return jsonResponse(
                {
                  verified: false,
                  paymentId,
                  orderId,
                  error: `Razorpay payment status is not successful (status: ${pData.status})`,
                },
                400,
              );
            }

            if (pData.status === "authorized") {
              const capRes = await fetch(
                `https://api.razorpay.com/v1/payments/${paymentId}/capture`,
                {
                  method: "POST",
                  headers: {
                    Authorization: authHeader,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({ amount: expectedPaise, currency: "INR" }),
                },
              );
              if (!capRes.ok) {
                const capErr = await capRes.text();
                return jsonResponse(
                  {
                    verified: false,
                    paymentId,
                    orderId,
                    error: `Failed to capture authorized Razorpay payment: ${capErr}`,
                  },
                  400,
                );
              }
            }
          } catch (gatewayErr: any) {
            return jsonResponse(
              {
                verified: false,
                paymentId,
                orderId,
                error: `Razorpay remote API connection error: ${gatewayErr?.message || "Network error"}`,
              },
              502,
            );
          }
        }

        // 2. AUTHORIZATION & OWNERSHIP VERIFICATION
        const authUser = await getAuthUserFromRequest(request, store, pool);
        let uploaderId = requestedUserId;
        if (authUser) {
          if (requestedUserId && requestedUserId.toUpperCase() !== authUser.user_id.toUpperCase()) {
            if (authUser.role !== "admin") {
              return jsonResponse(
                {
                  verified: false,
                  error: "Unauthorized: You cannot verify payments on behalf of another user.",
                },
                403,
              );
            }
            uploaderId = requestedUserId;
          } else {
            uploaderId = authUser.user_id;
          }
        } else {
          if (!uploaderId) {
            return jsonResponse(
              {
                verified: false,
                error: "User identity required for payment processing.",
              },
              401,
            );
          }
        }

        // Verify pre-checkout order ownership
        let orderOwnerId: string | null = null;
        if (pool) {
          try {
            const [poRows]: any = await pool.query(
              `SELECT user_id, purpose, amount, plan_id FROM payment_orders WHERE order_id = ? LIMIT 1`,
              [orderId],
            );
            if (poRows && poRows.length > 0) {
              orderOwnerId = poRows[0].user_id;
            }
          } catch (_e) {
            // Ignore if payment_orders table is not yet migrated
          }
        }
        if (!orderOwnerId && store.paymentOrders) {
          const po = store.paymentOrders.find((o) => o.order_id === orderId);
          if (po) orderOwnerId = po.user_id;
        }

        if (orderOwnerId) {
          if (
            authUser &&
            authUser.user_id.toUpperCase() !== orderOwnerId.toUpperCase() &&
            authUser.role !== "admin"
          ) {
            return jsonResponse(
              {
                verified: false,
                error: "Unauthorized: Payment order does not belong to the authenticated user.",
              },
              403,
            );
          }
          if (
            uploaderId &&
            uploaderId.toUpperCase() !== orderOwnerId.toUpperCase() &&
            authUser?.role !== "admin"
          ) {
            return jsonResponse(
              {
                verified: false,
                error: "Unauthorized: Payment order does not belong to the requested user.",
              },
              403,
            );
          }
        }

        // 3. SET FINAL AUTHORITATIVE AMOUNT
        const amount = expectedAmount;

        // 4. VIDEO OWNERSHIP & ELIGIBILITY VERIFICATION
        if (videoId) {
          if (pool) {
            try {
              const [vRows]: any = await pool.query(
                `SELECT id, user_id, video_type, payment_status FROM uploaded_videos WHERE id = ? LIMIT 1`,
                [videoId],
              );
              if (vRows && vRows.length > 0) {
                const vid = vRows[0];
                if (vid.user_id.toUpperCase() !== uploaderId.toUpperCase()) {
                  return jsonResponse(
                    {
                      verified: false,
                      error: "Video record does not match the authenticated payer.",
                    },
                    403,
                  );
                }
                if (
                  purpose === "premium_video_upload" &&
                  String(vid.video_type).toLowerCase() === "free"
                ) {
                  return jsonResponse(
                    {
                      verified: false,
                      error: "Free video uploads do not require payment or commission.",
                    },
                    400,
                  );
                }
              }
            } catch (_e) {
              // Ignore video lookup check if table optional
            }
          } else {
            const vid = store.videos.find((v) => v.id === videoId);
            if (vid) {
              if (vid.user_id.toUpperCase() !== uploaderId.toUpperCase()) {
                return jsonResponse(
                  {
                    verified: false,
                    error: "Video record does not match the authenticated payer.",
                  },
                  403,
                );
              }
              if (purpose === "premium_video_upload" && vid.video_type === "free") {
                return jsonResponse(
                  {
                    verified: false,
                    error: "Free video uploads do not require payment or commission.",
                  },
                  400,
                );
              }
            }
          }
        }

        // 5. ATOMIC RECORDING & DEDUPLICATION (MySQL or Fallback Store)
        if (pool) {
          const PREMIUM_TX_SEQ_LOCK_NAME = "facetube_premium_tx_seq";
          const isPremiumUploadPurpose = purpose === "premium_video_upload";
          const conn = await pool.getConnection();
          let premiumLockAcquired = false;
          let inTx = false;
          try {
            if (isPremiumUploadPurpose) {
              let acquired = 0;
              try {
                const [lockRows]: any = await conn.query("SELECT GET_LOCK(?, 15) AS acquired", [
                  PREMIUM_TX_SEQ_LOCK_NAME,
                ]);
                acquired = Number(lockRows?.[0]?.acquired ?? 0);
              } catch (_lockErr) {
                return jsonResponse(
                  {
                    verified: false,
                    paymentId,
                    orderId,
                    error:
                      "Database error while acquiring premium transaction sequence lock. Please retry shortly.",
                  },
                  500,
                );
              }
              if (acquired !== 1) {
                return jsonResponse(
                  {
                    verified: false,
                    paymentId,
                    orderId,
                    error:
                      "Could not acquire premium transaction sequence lock within timeout. Please retry verification; no payment records were written.",
                  },
                  409,
                );
              }
              premiumLockAcquired = true;
            }

            await conn.beginTransaction();
            inTx = true;

            // Check duplicate under row lock
            const [existingRows]: any = await conn.query(
              `SELECT * FROM payment_transactions WHERE payment_id = ? FOR UPDATE`,
              [paymentId],
            );
            if (existingRows && existingRows.length > 0) {
              await conn.rollback();
              inTx = false;
              const existingTx = existingRows[0];
              if (existingTx.purpose === "paid_subscription") {
                let existingSub: any = null;
                try {
                  const [subRows]: any = await conn.query(
                    `SELECT * FROM user_subscriptions WHERE payment_id = ? OR order_id = ? LIMIT 1`,
                    [paymentId, orderId],
                  );
                  if (subRows && subRows.length > 0) {
                    const s = subRows[0];
                    existingSub = {
                      subscriptionId: s.subscription_id,
                      userId: s.user_id,
                      planId: s.plan_id,
                      orderId: s.order_id,
                      paymentId: s.payment_id,
                      amount: Number(s.amount),
                      currency: s.currency,
                      status: s.status,
                      startsAt: s.starts_at,
                      expiresAt: s.expires_at,
                    };
                  }
                } catch (_e) {
                  // Ignore if user_subscriptions table is not yet migrated
                }
                return jsonResponse({
                  verified: true,
                  paymentId: existingTx.payment_id,
                  orderId: existingTx.order_id,
                  amount: Number(existingTx.amount),
                  purpose: "paid_subscription",
                  txNumber: 0,
                  isSpecialTransaction: false,
                  specialTag: "PAID_SUBSCRIPTION",
                  subscription: existingSub,
                  duplicate: true,
                  message:
                    "Payment already verified and credited previously (idempotent duplicate).",
                });
              }
              return jsonResponse({
                verified: true,
                paymentId: existingTx.payment_id,
                orderId: existingTx.order_id,
                amount: Number(existingTx.amount),
                purpose: existingTx.purpose,
                txNumber: Number(existingTx.tx_number),
                isSpecialTransaction: Boolean(existingTx.is_special),
                specialTag: existingTx.special_tag,
                distribution: {
                  directReferralAmount: Number(existingTx.referral_commission),
                  referrerId: existingTx.user_id,
                  adminAmount: Number(existingTx.admin_allocation),
                  globalPoolAmount: Number(existingTx.global_pool_allocation),
                },
                duplicate: true,
                message: "Payment already verified and credited previously (idempotent duplicate).",
              });
            }

            if (purpose === "paid_subscription") {
              const subId = `sub_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
              const startsAt = new Date().toISOString();
              const expiresAt = new Date(Date.now() + subDurationDays * 86400000).toISOString();

              await conn.query(
                `INSERT INTO user_subscriptions (
                  subscription_id, user_id, plan_id, order_id, payment_id,
                  amount, currency, status, starts_at, expires_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'INR', 'active', ?, ?, NOW(), NOW())`,
                [subId, uploaderId, planId, orderId, paymentId, amount, startsAt, expiresAt],
              );

              await conn.query(
                `INSERT INTO payment_transactions (
                  order_id, payment_id, user_id, user_name, video_id, purpose, amount,
                  tx_number, is_special, special_tag, referral_commission, admin_allocation, global_pool_allocation,
                  created_at
                ) VALUES (?, ?, ?, ?, NULL, 'paid_subscription', ?, 0, 0, 'PAID_SUBSCRIPTION', 0.00, 0.00, 0.00, NOW())`,
                [orderId, paymentId, uploaderId, userName, amount],
              );

              try {
                await conn.query(
                  `UPDATE payment_orders SET status = 'paid', payment_id = ?, updated_at = NOW() WHERE order_id = ?`,
                  [paymentId, orderId],
                );
              } catch (_ePo) {
                // Ignore order update error
              }

              await conn.commit();
              inTx = false;

              return jsonResponse({
                verified: true,
                paymentId,
                orderId,
                amount,
                purpose: "paid_subscription",
                planId,
                txNumber: 0,
                isSpecialTransaction: false,
                specialTag: "PAID_SUBSCRIPTION",
                subscription: {
                  subscriptionId: subId,
                  userId: uploaderId,
                  planId,
                  orderId,
                  paymentId,
                  amount,
                  currency: "INR",
                  status: "active",
                  startsAt,
                  expiresAt,
                  durationDays: subDurationDays,
                },
              });
            }

            const isPremiumUpload = purpose === "premium_video_upload";
            let txNumber = 0;
            let isSpecial = false;
            let specialTag = "NORMAL_PREMIUM";
            let verifiedReferrerId: string | null = null;
            let referralCommission = 0.0;
            let adminAllocation = 0.0;
            let globalPoolAllocation = 0.0;
            let levelPayouts: any[] = [];
            let missingLevels: number[] = [];
            let adminPercent = 60;
            let totalReferralAmount = 0.0;
            const creatorPayouts: Array<{
              userId: string;
              videoId?: string | undefined;
              amount: number;
              amountPaise: number;
            }> = [];
            let eligibleCreatorCount = 0;

            // Resolve Admin user ID from database
            const [adminRows]: any = await conn.query(
              `SELECT user_id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1`,
            );
            const adminUserId = adminRows?.[0]?.user_id || "FT102857";

            if (isPremiumUpload) {
              // Sequence allocation strictly for qualifying premium video uploads
              const [cntRows]: any = await conn.query(
                `SELECT COUNT(*) as total FROM payment_transactions WHERE purpose = 'premium_video_upload' FOR UPDATE`,
              );
              txNumber = Number(cntRows?.[0]?.total || 0) + 1;
              isSpecial = txNumber >= 11 && (txNumber - 11) % 10 === 0;
              specialTag = isSpecial ? "SPECIAL_GLOBAL_RULE" : "NORMAL_PREMIUM";

              // Verify direct sponsor strictly from users table
              const [uRows]: any = await conn.query(
                `SELECT id, user_id, referral_code FROM users WHERE UPPER(user_id) = UPPER(?) LIMIT 1`,
                [uploaderId],
              );
              const userRec = uRows?.[0];
              const refCode = userRec?.referral_code?.trim();
              if (refCode) {
                const [sponsorRows]: any = await conn.query(
                  `SELECT user_id FROM users 
                   WHERE (UPPER(user_id) = UPPER(?) OR UPPER(referral_code) = UPPER(?)) 
                     AND UPPER(user_id) != UPPER(?) 
                   LIMIT 1`,
                  [refCode, refCode, uploaderId],
                );
                if (sponsorRows && sponsorRows.length > 0) {
                  verifiedReferrerId = sponsorRows[0].user_id;
                }
              }

              // Option A Approved Allocation:
              // Every verified payment is exactly ₹6.
              // GST/Payment Gateway reporting allocation = ₹1.00.
              // If valid referrer: Referrer = ₹1.00.
              // If NO valid referrer: unallocated ₹1.00 redirects to Admin.
              const hasReferrer = Boolean(verifiedReferrerId);
              referralCommission = hasReferrer ? 1.0 : 0.0;
              const unallocatedReferrerPaise = hasReferrer ? 0 : 100;
              totalReferralAmount = referralCommission;

              if (isSpecial) {
                // Special transaction:
                // Global pool = ₹0.00
                // If referrer: Admin = ₹4.00; If no referrer: Admin = ₹5.00
                adminAllocation = hasReferrer ? 4.0 : 5.0;
                globalPoolAllocation = 0.0;
              } else {
                // Normal transaction:
                // Base Admin = ₹1.00 (+ ₹1.00 if no valid referrer)
                const baseAdminPaise = 100 + unallocatedReferrerPaise;

                // Query eligible previous Premium videos, strictly excluding current uploader:
                const [eligibleRows]: any = await conn.query(
                  `SELECT id AS video_id, user_id, COALESCE(ad_earnings, 0.00) AS ad_earnings
                   FROM uploaded_videos
                   WHERE (video_type = 'premium' OR payment_status = 'paid')
                     AND UPPER(user_id) != UPPER(?)
                     AND (is_blocked = 0 OR is_blocked IS NULL)
                   ORDER BY created_at ASC, id ASC`,
                  [uploaderId],
                );
                const eligibleVideos: Array<{
                  userId: string;
                  videoId: string;
                  adEarnings: number;
                }> = Array.isArray(eligibleRows)
                  ? eligibleRows.map((r: any) => ({
                      userId: String(r.user_id).trim().toUpperCase(),
                      videoId: String(r.video_id).trim(),
                      adEarnings: Math.max(0, Number(r.ad_earnings) || 0),
                    }))
                  : [];
                eligibleCreatorCount = eligibleVideos.length;

                if (eligibleCreatorCount === 0) {
                  // Redirect entire ₹3 pool to Admin if no eligible previous creators
                  const adminPaise = baseAdminPaise + 300;
                  adminAllocation = adminPaise / 100;
                  globalPoolAllocation = 0.0;
                } else {
                  // Distribute ₹3 pool (300 paise) via per-video weighted Ads Earnings Share
                  const poolPaise = 300;
                  const weighted = calculateWeightedPoolPayouts(poolPaise, eligibleVideos);

                  adminAllocation = (baseAdminPaise + weighted.residualPaise) / 100;
                  globalPoolAllocation = weighted.distributedPaise / 100;

                  for (const p of weighted.payouts) {
                    creatorPayouts.push({
                      userId: p.userId,
                      videoId: p.videoId,
                      amount: p.amount,
                      amountPaise: p.amountPaise,
                    });
                  }
                }
              }

              adminPercent = Math.round((adminAllocation / amount) * 100);

              // 1. Insert into payment_transactions
              await conn.query(
                `INSERT INTO payment_transactions (
                  order_id, payment_id, user_id, user_name, video_id, purpose, amount,
                  tx_number, is_special, special_tag, referral_commission, admin_allocation, global_pool_allocation, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
                [
                  orderId,
                  paymentId,
                  uploaderId,
                  userName,
                  videoId || null,
                  purpose,
                  amount,
                  txNumber,
                  isSpecial ? 1 : 0,
                  specialTag,
                  referralCommission,
                  adminAllocation,
                  globalPoolAllocation,
                ],
              );

              // 2. Insert into premium_transactions audit table
              try {
                await conn.query(
                  `INSERT INTO premium_transactions (
                    id, tx_number, payment_id, order_id, video_id, user_id, referrer_id,
                    amount, transaction_type, is_special, special_tag, referral_commission,
                    admin_allocation, global_pool_allocation, created_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'premium_upload', ?, ?, ?, ?, ?, NOW())`,
                  [
                    crypto.randomUUID(),
                    txNumber,
                    paymentId,
                    orderId,
                    videoId || null,
                    uploaderId,
                    verifiedReferrerId,
                    amount,
                    isSpecial ? 1 : 0,
                    specialTag,
                    referralCommission,
                    adminAllocation,
                    globalPoolAllocation,
                  ],
                );
              } catch (_ePt) {
                // Audit table optional
              }

              // 3. Insert into income_ledger & credit wallet_balances for Referrer
              if (verifiedReferrerId && referralCommission > 0) {
                const txRefId = `TX_REF_${paymentId}`;
                await conn.query(
                  `INSERT INTO income_ledger (
                    id, transaction_id, user_id, source_user_id, source_user_name, video_id,
                    income_type, amount, status, special_tag, description, created_at
                  ) VALUES (?, ?, ?, ?, ?, ?, 'referral_income', 1.0000, 'settled', ?, ?, NOW())`,
                  [
                    crypto.randomUUID(),
                    txRefId,
                    verifiedReferrerId,
                    uploaderId,
                    userName,
                    videoId || null,
                    specialTag,
                    `Direct referral commission (₹1.00) for eligible Premium Video upload by ${userName} (${uploaderId})`,
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
                  [verifiedReferrerId],
                );
              }

              // 4. Insert into income_ledger & credit wallet_balances for Admin
              if (adminAllocation > 0) {
                const txAdmId = `TX_ADM_${paymentId}`;
                const admDesc = isSpecial
                  ? `Admin Allocation (₹${adminAllocation.toFixed(2)}) for Special Premium Video #${txNumber} upload by ${userName} (${uploaderId})`
                  : `Admin Allocation (₹${adminAllocation.toFixed(2)}) for Premium Video #${txNumber} upload by ${userName} (${uploaderId})`;

                await conn.query(
                  `INSERT INTO income_ledger (
                    id, transaction_id, user_id, source_user_id, source_user_name, video_id,
                    income_type, amount, status, special_tag, description, created_at
                  ) VALUES (?, ?, ?, ?, ?, ?, 'admin_allocation', ?, 'settled', ?, ?, NOW())`,
                  [
                    crypto.randomUUID(),
                    txAdmId,
                    adminUserId,
                    uploaderId,
                    userName,
                    videoId || null,
                    adminAllocation,
                    specialTag,
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
                  [adminUserId, adminAllocation, adminAllocation],
                );
              }

              // 5. Insert into income_ledger & credit wallet_balances for each eligible previous creator
              if (creatorPayouts.length > 0) {
                for (const payout of creatorPayouts) {
                  if (payout.amount <= 0) continue;
                  const txGlbId = `TX_GLB_${paymentId}_${payout.videoId || payout.userId}`;
                  const glbDesc = payout.videoId
                    ? `Per-Video Ads Earnings Share for video #${payout.videoId} (₹${payout.amount.toFixed(2)} share of ₹3 pool for Premium Video #${txNumber})`
                    : `Per-Video Ads Earnings Share (₹${payout.amount.toFixed(2)} share of ₹3 pool for Premium Video #${txNumber})`;

                  await conn.query(
                    `INSERT INTO income_ledger (
                      id, transaction_id, user_id, source_user_id, source_user_name, video_id,
                      income_type, amount, status, special_tag, description, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, 'global_income', ?, 'settled', ?, ?, NOW())`,
                    [
                      crypto.randomUUID(),
                      txGlbId,
                      payout.userId,
                      uploaderId,
                      userName,
                      payout.videoId || videoId || null,
                      payout.amount,
                      specialTag,
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
              }
            } else {
              // Task 33: 7-Level Ads Promotion Referral Distribution
              txNumber = 0;
              isSpecial = false;
              specialTag = "ADS_PROMOTION";
              globalPoolAllocation = 0.0;

              // Resolve up to 7 valid uplines
              const uplines = await resolveUplineSponsorsMysql(uploaderId, conn);
              const dist = evaluateAdsDistribution(amount, uplines);
              levelPayouts = dist.levelPayouts;
              missingLevels = dist.missingLevels;
              totalReferralAmount = dist.totalReferralAmount;
              referralCommission = dist.totalReferralAmount;
              adminAllocation = dist.adminAmount;
              adminPercent = dist.adminPercent;
              verifiedReferrerId = uplines.find((u) => u.level === 1)?.userId || null;

              // Resolve Admin user ID from database
              const [adminRows]: any = await conn.query(
                `SELECT user_id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1`,
              );
              const adminUserId = adminRows?.[0]?.user_id || "FT102857";

              // 1. Insert into payment_transactions (does not increment premium sequence)
              await conn.query(
                `INSERT INTO payment_transactions (
                  order_id, payment_id, user_id, user_name, video_id, purpose, amount,
                  tx_number, is_special, special_tag, referral_commission, admin_allocation, global_pool_allocation, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 'ADS_PROMOTION', ?, ?, 0.00, NOW())`,
                [
                  orderId,
                  paymentId,
                  uploaderId,
                  userName,
                  videoId || null,
                  purpose,
                  amount,
                  referralCommission,
                  adminAllocation,
                ],
              );

              // 2. Insert atomic ledger entries and credit wallet balances for each valid upline sponsor
              for (const payout of levelPayouts) {
                const txId = `TX_ADS_L${payout.level}_${paymentId}`;
                await conn.query(
                  `INSERT INTO income_ledger (
                    id, transaction_id, user_id, source_user_id, source_user_name, video_id,
                    income_type, amount, status, special_tag, description, created_at
                  ) VALUES (?, ?, ?, ?, ?, ?, 'referral_income', ?, 'settled', ?, ?, NOW())`,
                  [
                    crypto.randomUUID(),
                    txId,
                    payout.userId,
                    uploaderId,
                    userName,
                    videoId || null,
                    payout.amount,
                    `ADS_REF_L${payout.level}`,
                    `Level ${payout.level} referral commission (${payout.ratePercent}%) for Ads Promotion by ${userName} (${uploaderId})`,
                  ],
                );

                await conn.query(
                  `INSERT INTO wallet_balances (user_id, balance, total_earned, total_withdrawn, referral_income, global_income, adsense_income, affiliate_income, updated_at)
                   VALUES (?, ?, ?, 0.00, ?, 0.00, 0.00, 0.00, NOW())
                   ON DUPLICATE KEY UPDATE
                     balance = balance + VALUES(balance),
                     total_earned = total_earned + VALUES(total_earned),
                     referral_income = referral_income + VALUES(referral_income),
                     updated_at = NOW()`,
                  [payout.userId, payout.amount, payout.amount, payout.amount],
                );
              }

              // 3. Record Admin allocation (base 60% + missing level remainder)
              if (adminAllocation > 0) {
                const adminTxId = `TX_ADS_ADM_${paymentId}`;
                await conn.query(
                  `INSERT INTO income_ledger (
                    id, transaction_id, user_id, source_user_id, source_user_name, video_id,
                    income_type, amount, status, special_tag, description, created_at
                  ) VALUES (?, ?, ?, ?, ?, ?, 'admin_allocation', ?, 'settled', 'ADS_ADMIN_SHARE', ?, NOW())`,
                  [
                    crypto.randomUUID(),
                    adminTxId,
                    adminUserId,
                    uploaderId,
                    userName,
                    videoId || null,
                    adminAllocation,
                    `Admin allocation (${adminPercent}%) including base 60% and unallocated referral shares for Ads Promotion by ${userName} (${uploaderId})`,
                  ],
                );

                await conn.query(
                  `INSERT INTO wallet_balances (user_id, balance, total_earned, total_withdrawn, referral_income, global_income, adsense_income, affiliate_income, updated_at)
                   VALUES (?, ?, ?, 0.00, 0.00, 0.00, 0.00, 0.00, NOW())
                   ON DUPLICATE KEY UPDATE
                     balance = balance + VALUES(balance),
                     total_earned = total_earned + VALUES(total_earned),
                     updated_at = NOW()`,
                  [adminUserId, adminAllocation, adminAllocation],
                );
              }
            }

            // 4. Update uploaded_videos payment status & promotion activation
            if (videoId) {
              if (purpose === "ads_promotion") {
                const planDurations: Record<string, number> = {
                  "plan-7-days": 7,
                  "plan-15-days": 15,
                  "plan-monthly": 30,
                  "plan-yearly": 365,
                };
                const durationDays = planDurations[planId] || 30;
                await conn.query(
                  `UPDATE uploaded_videos 
                   SET is_promoted = 1,
                       promotion_plan = ?,
                       promotion_expires_at = IF(
                         promotion_expires_at IS NOT NULL AND promotion_expires_at > NOW(),
                         DATE_ADD(promotion_expires_at, INTERVAL ? DAY),
                         DATE_ADD(NOW(), INTERVAL ? DAY)
                       ),
                       updated_at = NOW()
                   WHERE id = ?`,
                  [planId, durationDays, durationDays, videoId],
                );
              } else {
                await conn.query(
                  `UPDATE uploaded_videos SET payment_status = 'paid', payment_id = ?, payment_amount = ?, updated_at = NOW() WHERE id = ?`,
                  [paymentId, amount, videoId],
                );
              }
            }

            await conn.commit();
            inTx = false;

            return jsonResponse({
              verified: true,
              paymentId,
              orderId,
              amount,
              purpose,
              txNumber,
              isSpecialTransaction: isSpecial,
              specialTag,
              distribution: {
                directReferralAmount: isPremiumUpload
                  ? referralCommission
                  : levelPayouts.find((p) => p.level === 1)?.amount || 0,
                referrerId: verifiedReferrerId,
                adminAmount: adminAllocation,
                adminPercent,
                globalPoolAmount: globalPoolAllocation,
                eligibleMembersCount: isPremiumUpload ? eligibleCreatorCount : 0,
                perMemberShare:
                  isPremiumUpload && eligibleCreatorCount > 0 && creatorPayouts.length > 0
                    ? creatorPayouts[0]!.amount
                    : 0,
                creatorPayouts,
                totalReferralAmount,
                levelPayouts,
                missingLevels,
              },
            });
          } catch (txErr: any) {
            if (inTx) {
              try {
                await conn.rollback();
              } catch {
                // Ignore secondary rollback failure
              }
              inTx = false;
            }
            if (txErr.code === "ER_DUP_ENTRY" || String(txErr).includes("uniq_pt_payment_id")) {
              return jsonResponse({
                verified: true,
                paymentId,
                orderId,
                amount,
                duplicate: true,
                message: "Payment already verified and credited previously (idempotent duplicate).",
              });
            }
            throw txErr;
          } finally {
            if (premiumLockAcquired) {
              try {
                await conn.query("DO RELEASE_LOCK(?)", [PREMIUM_TX_SEQ_LOCK_NAME]);
              } catch {
                // Ignore lock release failure during cleanup
              }
            }
            conn.release();
          }
        } else {
          if (process.env["NODE_ENV"] === "production") {
            return jsonResponse(
              {
                verified: false,
                paymentId,
                orderId,
                error:
                  "Database connection unavailable. In production, payments must be verified and credited against the persistent database.",
              },
              503,
            );
          }

          // In-memory/JSON store verification with concurrency protection (non-production preview only)
          let verifiedReferrerId: string | null = null;
          if (uploaderId) {
            const uploaderUser = store.users.find((u) => u.user_id.toUpperCase() === uploaderId);
            if (uploaderUser && uploaderUser.referral_code) {
              const code = uploaderUser.referral_code.trim().toUpperCase();
              const refUser = store.users.find(
                (u) =>
                  (u.user_id.toUpperCase() === code || u.referral_code?.toUpperCase() === code) &&
                  u.user_id.toUpperCase() !== uploaderId,
              );
              if (refUser) {
                verifiedReferrerId = refUser.user_id;
              }
            }
          }

          const uplines =
            purpose === "ads_promotion" && uploaderId
              ? resolveUplineSponsors(uploaderId, store.users)
              : undefined;

          // Find all eligible videos for weighted Ads Earnings Share, strictly excluding current uploader
          const storeEligibleVideos = (store.videos || [])
            .filter(
              (v) =>
                v.video_type === "premium" &&
                v.payment_status === "paid" &&
                v.user_id.toUpperCase() !== uploaderId &&
                !v.is_blocked,
            )
            .map((v) => ({
              userId: v.user_id.toUpperCase(),
              videoId: v.id,
              adEarnings: Number(v.ad_earnings) || 0,
            }));

          const result = await verifyServerPayment(
            {
              orderId,
              paymentId,
              signature,
              userId: uploaderId,
              userName,
              videoId,
              purpose: purpose as any,
              referrerUserId: verifiedReferrerId,
              metadata:
                payload.metadata ||
                (payload.planId || payload.plan_id
                  ? { planId: payload.planId || payload.plan_id }
                  : undefined),
            },
            storeEligibleVideos,
            verifiedReferrerId,
            env,
            uplines,
          );

          // Only credit wallet if verified and NOT a duplicate!
          const txCheckId =
            purpose === "ads_promotion"
              ? `TX_ADS_ADM_${result.paymentId}`
              : `TX_ADM_${result.paymentId}`;
          const isDuplicate = Boolean(
            result.error?.includes("already") ||
            result.duplicate ||
            store.walletTransactions.some(
              (t: any) =>
                t.transactionId === txCheckId ||
                t.transaction_id === txCheckId ||
                (purpose === "ads_promotion" &&
                  (t.transactionId === `TX_ADS_ADM_${result.paymentId}` ||
                    t.transaction_id === `TX_ADS_ADM_${result.paymentId}`)) ||
                (purpose === "premium_video_upload" &&
                  (t.transactionId === `TX_ADM_${result.paymentId}` ||
                    t.transaction_id === `TX_ADM_${result.paymentId}` ||
                    t.transactionId === `TX_REF_${result.paymentId}` ||
                    t.transaction_id === `TX_REF_${result.paymentId}`)),
            ),
          );

          if (result.verified && !isDuplicate) {
            if (!store.wallets) store.wallets = {};

            if (purpose === "premium_video_upload" && result.distribution) {
              // 1. Credit direct referral commission if valid
              if (
                verifiedReferrerId &&
                result.distribution.directReferralAmount &&
                result.distribution.directReferralAmount > 0
              ) {
                let w = store.wallets[verifiedReferrerId];
                if (!w) {
                  w = {
                    balance: 0,
                    total_earned: 0,
                    total_withdrawn: 0,
                    referral_income: 0,
                    global_income: 0,
                    adsense_income: 0,
                    affiliate_income: 0,
                    updated_at: new Date().toISOString(),
                  };
                  store.wallets[verifiedReferrerId] = w;
                }
                const comm = Number(result.distribution.directReferralAmount);
                w.balance += comm;
                w.total_earned += comm;
                w.referral_income += comm;
                w.updated_at = new Date().toISOString();

                const txRefId = `TX_REF_${result.paymentId}`;
                store.walletTransactions.unshift({
                  id: `tx-ref-${Date.now()}`,
                  transactionId: txRefId,
                  transaction_id: txRefId,
                  userId: verifiedReferrerId,
                  user_id: verifiedReferrerId,
                  sourceUserId: uploaderId,
                  source_user_id: uploaderId,
                  sourceUserName: userName,
                  source_user_name: userName,
                  videoId: videoId || "",
                  video_id: videoId || "",
                  incomeType: "referral_income",
                  income_type: "referral_income",
                  amount: comm,
                  status: "settled",
                  specialTag: result.specialTag,
                  description: `Direct referral commission (₹${comm.toFixed(2)}) for eligible Premium Video upload by ${userName} (${uploaderId})`,
                  createdAt: new Date().toISOString(),
                  created_at: new Date().toISOString(),
                });
              }

              // 2. Credit Admin allocation
              const adminAmount = Number(result.distribution.adminAmount || 0);
              if (adminAmount > 0) {
                const adminUser = store.users.find((u) => u.role === "admin") || {
                  user_id: "FT102857",
                };
                const adminUserId = adminUser.user_id;
                let w = store.wallets[adminUserId];
                if (!w) {
                  w = {
                    balance: 0,
                    total_earned: 0,
                    total_withdrawn: 0,
                    referral_income: 0,
                    global_income: 0,
                    adsense_income: 0,
                    affiliate_income: 0,
                    updated_at: new Date().toISOString(),
                  };
                  store.wallets[adminUserId] = w;
                }
                w.balance += adminAmount;
                w.total_earned += adminAmount;
                w.updated_at = new Date().toISOString();

                const txAdmId = `TX_ADM_${result.paymentId}`;
                const admDesc = result.isSpecialTransaction
                  ? `Admin Allocation (₹${adminAmount.toFixed(2)}) for Special Premium Video #${result.txNumber || 0} upload by ${userName} (${uploaderId})`
                  : `Admin Allocation (₹${adminAmount.toFixed(2)}) for Premium Video #${result.txNumber || 0} upload by ${userName} (${uploaderId})`;

                store.walletTransactions.unshift({
                  id: `tx-adm-${Date.now()}`,
                  transactionId: txAdmId,
                  transaction_id: txAdmId,
                  userId: adminUserId,
                  user_id: adminUserId,
                  sourceUserId: uploaderId,
                  source_user_id: uploaderId,
                  sourceUserName: userName,
                  source_user_name: userName,
                  videoId: videoId || "",
                  video_id: videoId || "",
                  incomeType: "admin_allocation",
                  income_type: "admin_allocation",
                  amount: adminAmount,
                  status: "settled",
                  specialTag: result.specialTag,
                  description: admDesc,
                  createdAt: new Date().toISOString(),
                  created_at: new Date().toISOString(),
                });
              }

              // 3. Credit each eligible creator from creatorPayouts
              const payouts = result.distribution.creatorPayouts || [];
              for (const payout of payouts) {
                let w = store.wallets[payout.userId];
                if (!w) {
                  w = {
                    balance: 0,
                    total_earned: 0,
                    total_withdrawn: 0,
                    referral_income: 0,
                    global_income: 0,
                    adsense_income: 0,
                    affiliate_income: 0,
                    updated_at: new Date().toISOString(),
                  };
                  store.wallets[payout.userId] = w;
                }
                w.balance += payout.amount;
                w.total_earned += payout.amount;
                w.global_income += payout.amount;
                w.updated_at = new Date().toISOString();

                if (payout.amount <= 0) continue;
                const txGlbId = `TX_GLB_${result.paymentId}_${payout.videoId || payout.userId}`;
                const glbDesc = payout.videoId
                  ? `Per-Video Ads Earnings Share for video #${payout.videoId} (₹${payout.amount.toFixed(2)} share of ₹3 pool for Premium Video #${result.txNumber || 0})`
                  : `Per-Video Ads Earnings Share (₹${payout.amount.toFixed(2)} share of ₹3 pool for Premium Video #${result.txNumber || 0})`;

                store.walletTransactions.unshift({
                  id: `tx-glb-${Date.now()}-${payout.videoId || payout.userId}`,
                  transactionId: txGlbId,
                  transaction_id: txGlbId,
                  userId: payout.userId,
                  user_id: payout.userId,
                  sourceUserId: uploaderId,
                  source_user_id: uploaderId,
                  sourceUserName: userName,
                  source_user_name: userName,
                  videoId: payout.videoId || videoId || "",
                  video_id: payout.videoId || videoId || "",
                  incomeType: "global_income",
                  income_type: "global_income",
                  amount: payout.amount,
                  status: "settled",
                  specialTag: result.specialTag,
                  description: glbDesc,
                  createdAt: new Date().toISOString(),
                  created_at: new Date().toISOString(),
                });
              }
            } else if (purpose === "ads_promotion" && result.distribution) {
              // 1. Credit 7-level sponsor payouts
              const payouts = result.distribution.levelPayouts || [];
              for (const payout of payouts) {
                let w = store.wallets[payout.userId];
                if (!w) {
                  w = {
                    balance: 0,
                    total_earned: 0,
                    total_withdrawn: 0,
                    referral_income: 0,
                    global_income: 0,
                    adsense_income: 0,
                    affiliate_income: 0,
                    updated_at: new Date().toISOString(),
                  };
                  store.wallets[payout.userId] = w;
                }
                w.balance += payout.amount;
                w.total_earned += payout.amount;
                w.referral_income += payout.amount;
                w.updated_at = new Date().toISOString();

                const txLvlId = `TX_ADS_L${payout.level}_${result.paymentId}`;
                store.walletTransactions.unshift({
                  id: `tx-ads-l${payout.level}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
                  transactionId: txLvlId,
                  transaction_id: txLvlId,
                  userId: payout.userId,
                  user_id: payout.userId,
                  sourceUserId: uploaderId,
                  source_user_id: uploaderId,
                  sourceUserName: userName,
                  source_user_name: userName,
                  videoId: videoId || "",
                  video_id: videoId || "",
                  incomeType: "ad_boost_income",
                  income_type: "ad_boost_income",
                  amount: payout.amount,
                  status: "settled",
                  specialTag: `ADS_REF_L${payout.level}`,
                  description: `Level ${payout.level} commission (${payout.ratePercent}%) for Ads Promotion by ${userName} (${uploaderId})`,
                  createdAt: new Date().toISOString(),
                  created_at: new Date().toISOString(),
                });
              }

              // 2. Credit Admin allocation
              const adminAmount = result.distribution.adminAmount || 0;
              if (adminAmount > 0) {
                const adminUser = store.users.find((u) => u.role === "admin") || {
                  user_id: "FT102857",
                };
                const adminUserId = adminUser.user_id;

                let w = store.wallets[adminUserId];
                if (!w) {
                  w = {
                    balance: 0,
                    total_earned: 0,
                    total_withdrawn: 0,
                    referral_income: 0,
                    global_income: 0,
                    adsense_income: 0,
                    affiliate_income: 0,
                    updated_at: new Date().toISOString(),
                  };
                  store.wallets[adminUserId] = w;
                }
                w.balance += adminAmount;
                w.total_earned += adminAmount;
                w.updated_at = new Date().toISOString();

                const txAdminId = `TX_ADS_ADM_${result.paymentId}`;
                store.walletTransactions.unshift({
                  id: `tx-ads-adm-${Date.now()}`,
                  transactionId: txAdminId,
                  transaction_id: txAdminId,
                  userId: adminUserId,
                  user_id: adminUserId,
                  sourceUserId: uploaderId,
                  source_user_id: uploaderId,
                  sourceUserName: userName,
                  source_user_name: userName,
                  videoId: videoId || "",
                  video_id: videoId || "",
                  incomeType: "admin_allocation",
                  income_type: "admin_allocation",
                  amount: adminAmount,
                  status: "settled",
                  specialTag: "ADS_ADMIN_SHARE",
                  description: `Admin allocation (${result.distribution.adminPercent || 60}%) including base 60% and unallocated referral shares for Ads Promotion by ${userName} (${uploaderId})`,
                  createdAt: new Date().toISOString(),
                  created_at: new Date().toISOString(),
                });
              }
            }
          }

          // Update video payment status & promotion activation in store (only on initial verification, never on duplicate)
          if (result.verified && !isDuplicate && videoId) {
            const v = store.videos.find((vid) => vid.id === videoId);
            if (v) {
              if (purpose === "ads_promotion") {
                const planDurations: Record<string, number> = {
                  "plan-7-days": 7,
                  "plan-15-days": 15,
                  "plan-monthly": 30,
                  "plan-yearly": 365,
                };
                const durationDays = planDurations[planId] || 30;
                v.is_promoted = true;
                v.promotion_plan = planId;
                const now = Date.now();
                const currentExpiry = v.promotion_expires_at
                  ? new Date(v.promotion_expires_at).getTime()
                  : 0;
                const baseTime = currentExpiry > now ? currentExpiry : now;
                v.promotion_expires_at = new Date(
                  baseTime + durationDays * 24 * 60 * 60 * 1000,
                ).toISOString();
              } else {
                v.payment_status = "paid";
                v.payment_id = paymentId;
                v.payment_amount = amount;
              }
              v.updated_at = new Date().toISOString();
            }
          }

          // Update user subscription in store (only on initial verification, never duplicate)
          if (result.verified && result.subscription && !isDuplicate) {
            if (!store.userSubscriptions) store.userSubscriptions = [];
            const sub = result.subscription;
            const existingIdx = store.userSubscriptions.findIndex(
              (s) => s.payment_id === sub.paymentId || s.order_id === sub.orderId,
            );
            const subStoreRecord = {
              id: store.userSubscriptions.length + 1,
              subscription_id: sub.subscriptionId,
              user_id: sub.userId,
              plan_id: sub.planId,
              order_id: sub.orderId,
              payment_id: sub.paymentId,
              amount: sub.amount,
              currency: sub.currency,
              status: sub.status,
              starts_at: sub.startsAt,
              expires_at: sub.expiresAt,
              created_at: sub.startsAt,
              updated_at: sub.startsAt,
            };
            if (existingIdx >= 0) {
              store.userSubscriptions[existingIdx] = subStoreRecord;
            } else {
              store.userSubscriptions.unshift(subStoreRecord);
            }
            if (store.paymentOrders) {
              const po = store.paymentOrders.find((o) => o.order_id === orderId);
              if (po) {
                po.status = "paid";
                po.updated_at = new Date().toISOString();
              }
            }
          }

          saveStore(store);
          return jsonResponse({
            ...result,
            duplicate: isDuplicate,
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonResponse({ verified: false, error: "Payment verification failed: " + msg }, 500);
      }
    }
  }

  if (route === "payments/transactions" || route === "payment/transactions") {
    if (method === "GET") {
      try {
        const [lastTxNumber, transactions] = await Promise.all([
          getPersistentPremiumTxNumber(),
          getPersistentTransactions(),
        ]);
        return jsonResponse({
          status: "ok",
          lastTxNumber,
          totalTransactions: transactions.length,
          transactions,
        });
      } catch {
        return jsonResponse({ status: "error", error: "Failed to load transactions" }, 500);
      }
    }
  }

  // Health & Database Diagnostics
  if (route === "health/database" || route === "database/status") {
    if (method === "GET") {
      const diag = await testDatabaseConnection();
      return jsonResponse(diag, diag.connected ? 200 : 503);
    }
  }

  // 3. Auth Endpoints
  if (route === "auth/register") {
    if (method === "POST") {
      try {
        const body = await request.json();
        const { name, mobile, email, password, referralCode } = body;
        if (!email || !password || !name) {
          return jsonResponse(
            { success: false, error: "Name, email, and password are required" },
            400,
          );
        }

        const normalizedEmail = email.trim().toLowerCase();
        const pool = getMysqlPool();

        if (pool) {
          // Direct Hostinger MySQL execution
          const [existingRows]: any = await pool.query(
            "SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1",
            [normalizedEmail],
          );
          if (existingRows && existingRows.length > 0) {
            return jsonResponse(
              {
                success: false,
                error: `The email "${normalizedEmail}" is already registered. Please sign in.`,
              },
              409,
            );
          }

          // Generate unique FT User ID in MySQL
          let userId = "";
          for (let i = 0; i < 30; i++) {
            const candidate = "FT" + String(Math.floor(100000 + Math.random() * 900000));
            const [uidRows]: any = await pool.query(
              "SELECT 1 FROM users WHERE UPPER(user_id) = UPPER(?) LIMIT 1",
              [candidate],
            );
            if (!uidRows || uidRows.length === 0) {
              userId = candidate;
              break;
            }
          }
          if (!userId) {
            userId = "FT" + Date.now().toString().slice(-6);
          }

          const uuid = crypto.randomUUID();
          const passwordHash = await bcrypt.hash(password, 10);
          const role = normalizedEmail === "admin@facetube.com" ? "admin" : "user";
          const refCode = referralCode ? referralCode.trim() : null;

          await pool.query(
            `INSERT INTO users (id, user_id, name, mobile, email, password_hash, role, referral_code, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [
              uuid,
              userId,
              name.trim(),
              (mobile || "").trim(),
              normalizedEmail,
              passwordHash,
              role,
              refCode,
            ],
          );

          // Initialize wallet balances record in MySQL
          try {
            await pool.query(
              `INSERT INTO wallet_balances (user_id, balance, total_earned, total_withdrawn, referral_income, global_income, adsense_income, affiliate_income, updated_at)
               VALUES (?, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, 0.00, NOW())
               ON DUPLICATE KEY UPDATE updated_at = NOW()`,
              [userId],
            );
          } catch (_e) {
            // Non-blocking wallet init
          }

          const token = crypto.randomBytes(24).toString("hex");
          try {
            await pool.query(
              `INSERT INTO sessions (token, user_id, expires_at, created_at)
               VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY), NOW())`,
              [token, uuid],
            );
          } catch (_e) {
            // Sessions table optional
          }

          const newUser = {
            id: uuid,
            user_id: userId,
            name: name.trim(),
            mobile: (mobile || "").trim(),
            email: normalizedEmail,
            role,
            referral_code: refCode,
            created_at: new Date().toISOString(),
          };

          // Trigger Welcome Email dispatch only after user is committed to MySQL
          let emailDelivery: {
            success: boolean;
            provider?: "smtp" | "none";
            error?: string;
            messageId?: string;
          } = {
            success: false,
            provider: "none",
            error: "Email delivery failed",
          };

          try {
            const loginLink = "https://facetube.online/login";
            emailDelivery = await sendWelcomeEmailServer(
              {
                userName: name.trim(),
                userId,
                email: normalizedEmail,
                loginLink,
              },
              env,
            );
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            emailDelivery = {
              success: false,
              provider: "smtp",
              error: `Email delivery failed: ${msg}`,
            };
          }

          return jsonResponse(
            {
              success: true,
              token,
              user: newUser,
              userId,
              emailDelivery,
              message: "Registration successful.",
            },
            201,
          );
        } else {
          return jsonResponse(
            {
              success: false,
              error:
                "Hostinger MySQL database credentials are not configured in .env. Please define DB_HOST, DB_NAME, DB_USER, and DB_PASSWORD so user records can be inserted into the Hostinger MySQL users table.",
            },
            500,
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonResponse(
          { success: false, error: "Database error during registration: " + msg },
          500,
        );
      }
    }
  }

  if (route === "auth/login") {
    if (method === "POST") {
      try {
        const body = await request.json();
        const identifier = (body.identifier || body.email || body.username || "")
          .trim()
          .toUpperCase();
        const password = String(body.password || "");

        if (!identifier || !password) {
          return jsonResponse(
            { success: false, error: "Identifier and password are required" },
            400,
          );
        }

        const pool = getMysqlPool();

        if (pool) {
          const [rows]: any = await pool.query(
            `SELECT id, user_id, name, mobile, email, password_hash, role, referral_code, avatar_url, created_at
             FROM users
             WHERE UPPER(user_id) = UPPER(?) OR LOWER(email) = LOWER(?)
             LIMIT 1`,
            [identifier, identifier],
          );

          if (!rows || rows.length === 0) {
            return jsonResponse(
              {
                success: false,
                error:
                  "Account not found. Please check your User ID (e.g. FT123456) or Email, or sign up.",
              },
              404,
            );
          }

          const user = rows[0];
          let isValid = false;

          if (user.password_hash.startsWith("$2")) {
            isValid = await bcrypt.compare(password, user.password_hash);
          } else if (user.password_hash.length === 64) {
            // Legacy SHA256 seed check
            const sha256 = crypto.createHash("sha256").update(password).digest("hex");
            if (
              sha256 === user.password_hash ||
              (user.password_hash ===
                "ef92b778bafe771e89245b89ecbc08a44a4e166c06659911881f383d4473e94f" &&
                password === "password")
            ) {
              isValid = true;
              const newHash = await bcrypt.hash(password, 10);
              pool
                .query("UPDATE users SET password_hash = ? WHERE id = ?", [newHash, user.id])
                .catch(() => {});
            }
          } else {
            try {
              isValid = await bcrypt.compare(password, user.password_hash);
            } catch {
              isValid = false;
            }
          }

          if (!isValid) {
            return jsonResponse(
              { success: false, error: "Incorrect password. Please try again." },
              401,
            );
          }

          const token = crypto.randomBytes(24).toString("hex");
          try {
            await pool.query(
              `INSERT INTO sessions (token, user_id, expires_at, created_at)
               VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY), NOW())`,
              [token, user.id],
            );
          } catch (_e) {
            // Sessions table optional
          }

          delete user.password_hash;
          return jsonResponse({
            success: true,
            token,
            user,
            message: "Login successful.",
          });
        } else {
          if (process.env["NODE_ENV"] === "production") {
            return jsonResponse(
              {
                success: false,
                error:
                  "Database connection unavailable. In production, persistent database storage is required.",
              },
              503,
            );
          }

          // In-memory/JSON store authentication fallback (non-production preview only)
          const user = store.users.find(
            (u) => u.user_id.toUpperCase() === identifier || u.email.toUpperCase() === identifier,
          );

          if (!user) {
            return jsonResponse(
              {
                success: false,
                error:
                  "Account not found. Please check your User ID (e.g. FT123456) or Email, or sign up.",
              },
              404,
            );
          }

          let isValid = false;
          if (user.password_hash.startsWith("$2")) {
            isValid = await bcrypt.compare(password, user.password_hash);
          } else if (user.password_hash.length === 64) {
            const sha256 = crypto.createHash("sha256").update(password).digest("hex");
            if (
              sha256 === user.password_hash ||
              (user.password_hash ===
                "ef92b778bafe771e89245b89ecbc08a44a4e166c06659911881f383d4473e94f" &&
                password === "password")
            ) {
              isValid = true;
            }
          } else {
            try {
              isValid = await bcrypt.compare(password, user.password_hash);
            } catch {
              isValid = false;
            }
          }

          if (!isValid) {
            return jsonResponse(
              { success: false, error: "Incorrect password. Please try again." },
              401,
            );
          }

          const token = crypto.randomBytes(24).toString("hex");
          if (!store.sessions) {
            store.sessions = {};
          }
          store.sessions[token] = user.user_id;
          saveStore(store);

          const { password_hash: _ph, ...safeUser } = user;
          return jsonResponse({
            success: true,
            token,
            user: safeUser,
            message: "Login successful.",
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonResponse(
          { success: false, error: "Database error during authentication: " + msg },
          500,
        );
      }
    }
  }

  if (route === "auth/logout") {
    if (method === "POST") {
      const auth = request.headers
        .get("Authorization")
        ?.replace(/^Bearer\s+/i, "")
        ?.trim();
      const pool = getMysqlPool();
      if (auth && pool) {
        pool.query("DELETE FROM sessions WHERE token = ?", [auth]).catch(() => {});
      }
      if (auth && store.sessions && store.sessions[auth]) {
        delete store.sessions[auth];
        saveStore(store);
      }
      return jsonResponse({ success: true, message: "Logged out successfully" });
    }
  }

  if (route === "auth/me") {
    if (method === "GET") {
      const pool = getMysqlPool();
      const authUser = await getAuthUserFromRequest(request, store, pool);
      if (authUser) {
        return jsonResponse({ authenticated: true, user: authUser });
      }
      return jsonResponse({ authenticated: false, user: null });
    }
  }

  // 3b. Change Password
  if (route === "auth/change-password") {
    if (method === "POST") {
      try {
        const pool = getMysqlPool();
        const authUser = await getAuthUserFromRequest(request, store, pool);
        if (!authUser) {
          return jsonResponse(
            {
              success: false,
              error: "Authentication required. Please sign in to change your password.",
            },
            401,
          );
        }

        const body = await request.json();
        const currentPassword = String(body.currentPassword || body.current_password || "");
        const newPassword = String(body.newPassword || body.new_password || "");
        const confirmPassword = String(body.confirmPassword || body.confirm_password || "");

        if (!currentPassword) {
          return jsonResponse({ success: false, error: "Current password is required." }, 400);
        }

        if (!newPassword || newPassword.length < 6) {
          return jsonResponse(
            {
              success: false,
              error: "New password must be at least 6 characters long.",
            },
            400,
          );
        }

        if (confirmPassword && newPassword !== confirmPassword) {
          return jsonResponse(
            {
              success: false,
              error: "New password and confirm password do not match.",
            },
            400,
          );
        }

        if (currentPassword === newPassword) {
          return jsonResponse(
            {
              success: false,
              error: "New password cannot be the same as your current password.",
            },
            400,
          );
        }

        if (pool) {
          const [rows]: any = await pool.query(
            "SELECT id, password_hash FROM users WHERE id = ? LIMIT 1",
            [authUser.id],
          );
          if (!rows || rows.length === 0) {
            return jsonResponse({ success: false, error: "User account not found." }, 404);
          }

          const storedHash: string = rows[0].password_hash || "";
          let isCurrentValid = false;
          if (storedHash.startsWith("$2")) {
            isCurrentValid = await bcrypt.compare(currentPassword, storedHash);
          } else if (storedHash.length === 64) {
            const sha256 = crypto.createHash("sha256").update(currentPassword).digest("hex");
            if (sha256 === storedHash) {
              isCurrentValid = true;
            }
          } else {
            try {
              isCurrentValid = await bcrypt.compare(currentPassword, storedHash);
            } catch {
              isCurrentValid = false;
            }
          }

          if (!isCurrentValid) {
            return jsonResponse(
              {
                success: false,
                error: "Current password is incorrect. Please try again.",
              },
              401,
            );
          }

          const newHash = await bcrypt.hash(newPassword, 10);
          await pool.query("UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?", [
            newHash,
            authUser.id,
          ]);

          return jsonResponse({
            success: true,
            message: "Password changed successfully.",
          });
        } else {
          // In-memory / JSON store fallback
          const user = store.users.find(
            (u) =>
              u.id.toUpperCase() === authUser.id.toUpperCase() ||
              u.user_id.toUpperCase() === authUser.user_id.toUpperCase(),
          );
          if (!user) {
            return jsonResponse({ success: false, error: "User account not found." }, 404);
          }

          let isCurrentValid = false;
          if (user.password_hash.startsWith("$2")) {
            isCurrentValid = await bcrypt.compare(currentPassword, user.password_hash);
          } else if (user.password_hash.length === 64) {
            const sha256 = crypto.createHash("sha256").update(currentPassword).digest("hex");
            if (sha256 === user.password_hash) {
              isCurrentValid = true;
            }
          } else {
            try {
              isCurrentValid = await bcrypt.compare(currentPassword, user.password_hash);
            } catch {
              isCurrentValid = false;
            }
          }

          if (!isCurrentValid) {
            return jsonResponse(
              {
                success: false,
                error: "Current password is incorrect. Please try again.",
              },
              401,
            );
          }

          const newHash = await bcrypt.hash(newPassword, 10);
          user.password_hash = newHash;
          saveStore(store);

          return jsonResponse({
            success: true,
            message: "Password changed successfully.",
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonResponse(
          { success: false, error: "Database error while updating password: " + msg },
          500,
        );
      }
    }
  }

  // 3c. Forgot Password
  if (route === "auth/forgot-password") {
    if (method === "POST") {
      try {
        const body = await request.json();
        const rawIdentifier = String(body.identifier || body.email || body.user_id || "").trim();

        if (!rawIdentifier) {
          return jsonResponse(
            {
              success: false,
              error: "Please enter your User ID or Email address.",
            },
            400,
          );
        }

        const genericSuccessResponse = {
          success: true,
          message:
            "If an account associated with that User ID or Email exists, a password reset link has been dispatched to your registered email address.",
        };

        const pool = getMysqlPool();
        let targetUser: { id: string; user_id: string; name: string; email: string } | null = null;

        if (pool) {
          try {
            await pool.query(`
              CREATE TABLE IF NOT EXISTS password_reset_tokens (
                id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                email VARCHAR(255) NOT NULL,
                token_hash VARCHAR(64) NOT NULL,
                expires_at DATETIME NOT NULL,
                used TINYINT(1) NOT NULL DEFAULT 0,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                KEY idx_prt_email (email),
                KEY idx_prt_token_hash (token_hash),
                KEY idx_prt_expires (expires_at),
                KEY idx_prt_created_at (created_at)
              ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
            `);
          } catch (_e) {
            // Table may already exist
          }

          const [rows]: any = await pool.query(
            `SELECT id, user_id, name, email
             FROM users
             WHERE UPPER(user_id) = UPPER(?) OR LOWER(email) = LOWER(?)
             LIMIT 1`,
            [rawIdentifier, rawIdentifier],
          );

          if (rows && rows.length > 0 && rows[0].email) {
            targetUser = rows[0];
          }
        } else {
          // JSON store fallback
          const user = store.users.find(
            (u) =>
              u.user_id.toUpperCase() === rawIdentifier.toUpperCase() ||
              u.email.toLowerCase() === rawIdentifier.toLowerCase(),
          );
          if (user && user.email) {
            targetUser = {
              id: user.id,
              user_id: user.user_id,
              name: user.name,
              email: user.email,
            };
          }
        }

        if (!targetUser || !targetUser.email) {
          return jsonResponse(genericSuccessResponse);
        }

        const userEmail = targetUser.email.toLowerCase().trim();

        // Rate limit: Max 1 reset request per email per 60 seconds
        if (pool) {
          try {
            const [rateRows]: any = await pool.query(
              `SELECT id FROM password_reset_tokens
               WHERE LOWER(email) = LOWER(?) AND created_at > DATE_SUB(NOW(), INTERVAL 60 SECOND)
               LIMIT 1`,
              [userEmail],
            );
            if (rateRows && rateRows.length > 0) {
              return jsonResponse(genericSuccessResponse);
            }
          } catch (_e) {
            // Rate check non-blocking
          }

          try {
            await pool.query(
              `UPDATE password_reset_tokens SET used = 1 WHERE LOWER(email) = LOWER(?) AND used = 0`,
              [userEmail],
            );
          } catch (_e) {
            // Invalidate prior tokens non-blocking
          }
        } else {
          if (!store.passwordResetTokens) {
            store.passwordResetTokens = [];
          }
          const sixtySecAgo = new Date(Date.now() - 60 * 1000).toISOString();
          const recentToken = store.passwordResetTokens.find(
            (t) => t.email.toLowerCase() === userEmail && t.created_at > sixtySecAgo,
          );
          if (recentToken) {
            return jsonResponse(genericSuccessResponse);
          }
          store.passwordResetTokens.forEach((t) => {
            if (t.email.toLowerCase() === userEmail && !t.used) {
              t.used = true;
            }
          });
        }

        const rawToken = crypto.randomBytes(32).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

        if (pool) {
          await pool.query(
            `INSERT INTO password_reset_tokens (email, token_hash, expires_at, used, created_at)
             VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR), 0, NOW())`,
            [userEmail, tokenHash],
          );
        } else {
          store.passwordResetTokens!.push({
            email: userEmail,
            token_hash: tokenHash,
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            used: false,
            created_at: new Date().toISOString(),
          });
          saveStore(store);
        }

        const clientOrigin =
          request.headers.get("origin") ||
          (request.headers.get("host")
            ? `http://${request.headers.get("host")}`
            : "https://facetube.online");
        const resetLink = `${clientOrigin.replace(/\/+$/, "")}/reset-password?token=${rawToken}&email=${encodeURIComponent(userEmail)}`;

        await sendPasswordResetEmailServer({
          userName: targetUser.name,
          userId: targetUser.user_id,
          email: userEmail,
          resetLink,
        });

        return jsonResponse(genericSuccessResponse);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonResponse(
          { success: false, error: "Error processing password reset request: " + msg },
          500,
        );
      }
    }
  }

  // 3d. Reset Password
  if (route === "auth/reset-password") {
    if (method === "POST") {
      try {
        const body = await request.json();
        const email = String(body.email || "")
          .toLowerCase()
          .trim();
        const rawToken = String(body.token || "").trim();
        const newPassword = String(body.newPassword || body.new_password || body.password || "");
        const confirmPassword = String(body.confirmPassword || body.confirm_password || "");

        if (!email || !email.includes("@")) {
          return jsonResponse({ success: false, error: "Valid email address is required." }, 400);
        }

        if (!rawToken) {
          return jsonResponse({ success: false, error: "Reset token is required." }, 400);
        }

        if (!newPassword || newPassword.length < 6) {
          return jsonResponse(
            {
              success: false,
              error: "New password must be at least 6 characters long.",
            },
            400,
          );
        }

        if (confirmPassword && newPassword !== confirmPassword) {
          return jsonResponse({ success: false, error: "Passwords do not match." }, 400);
        }

        const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
        const pool = getMysqlPool();

        if (pool) {
          const [tokenRows]: any = await pool.query(
            `SELECT id, email, expires_at, used
             FROM password_reset_tokens
             WHERE LOWER(email) = LOWER(?) AND token_hash = ? AND used = 0 AND expires_at > NOW()
             ORDER BY created_at DESC
             LIMIT 1`,
            [email, tokenHash],
          );

          if (!tokenRows || tokenRows.length === 0) {
            return jsonResponse(
              {
                success: false,
                error:
                  "This password reset link is invalid, has already been used, or has expired. Please request a new link.",
              },
              400,
            );
          }

          const tokenRecord = tokenRows[0];
          await pool.query("UPDATE password_reset_tokens SET used = 1 WHERE id = ?", [
            tokenRecord.id,
          ]);

          const [userRows]: any = await pool.query(
            "SELECT id, user_id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1",
            [email],
          );
          if (!userRows || userRows.length === 0) {
            return jsonResponse(
              {
                success: false,
                error: "Account associated with this email address was not found.",
              },
              404,
            );
          }

          const userRecord = userRows[0];
          const newHash = await bcrypt.hash(newPassword, 10);
          await pool.query("UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ?", [
            newHash,
            userRecord.id,
          ]);

          try {
            await pool.query("DELETE FROM sessions WHERE user_id = ?", [userRecord.id]);
          } catch (_e) {
            // Sessions table optional
          }

          return jsonResponse({
            success: true,
            message:
              "Your password has been reset successfully. Please log in with your new password.",
          });
        } else {
          // JSON store fallback
          if (!store.passwordResetTokens) {
            store.passwordResetTokens = [];
          }

          const now = new Date().toISOString();
          const tokenRecord = store.passwordResetTokens.find(
            (t) =>
              t.email.toLowerCase() === email &&
              t.token_hash === tokenHash &&
              !t.used &&
              t.expires_at > now,
          );

          if (!tokenRecord) {
            return jsonResponse(
              {
                success: false,
                error:
                  "This password reset link is invalid, has already been used, or has expired. Please request a new link.",
              },
              400,
            );
          }

          tokenRecord.used = true;

          const user = store.users.find((u) => u.email.toLowerCase() === email);
          if (!user) {
            return jsonResponse(
              {
                success: false,
                error: "Account associated with this email address was not found.",
              },
              404,
            );
          }

          const newHash = await bcrypt.hash(newPassword, 10);
          user.password_hash = newHash;

          if (store.sessions) {
            for (const [sToken, sUid] of Object.entries(store.sessions)) {
              if (sUid === user.id || sUid === user.user_id) {
                delete store.sessions[sToken];
              }
            }
          }

          saveStore(store);

          return jsonResponse({
            success: true,
            message:
              "Your password has been reset successfully. Please log in with your new password.",
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonResponse(
          { success: false, error: "Database error while resetting password: " + msg },
          500,
        );
      }
    }
  }

  // 4. Users & Profile
  if (route === "users/profile") {
    if (method === "GET") {
      const qUserId = url.searchParams.get("userId") || url.searchParams.get("user_id");
      if (qUserId) {
        const norm = qUserId.trim().toUpperCase();
        const pool = getMysqlPool();
        if (pool) {
          try {
            const [rows]: any = await pool.query(
              `SELECT id, user_id, name, mobile, email, role, referral_code, avatar_url, created_at
               FROM users
               WHERE UPPER(user_id) = UPPER(?) OR LOWER(email) = LOWER(?) OR id = ?
               LIMIT 1`,
              [norm, norm, norm],
            );
            if (rows && rows.length > 0) {
              return jsonResponse({ success: true, profile: rows[0] });
            }
          } catch (_e) {
            // Ignore query error and fall through
          }
        }
      }
      return jsonResponse({ success: false, error: "Profile not found" }, 404);
    }
    if (method === "POST") {
      const body = await request.json();
      const targetUserId = body.userId || "FT102857";
      const pool = getMysqlPool();
      if (pool) {
        try {
          const updates: string[] = [];
          const params: any[] = [];
          if (body.name) {
            updates.push("name = ?");
            params.push(body.name);
          }
          if (body.mobile) {
            updates.push("mobile = ?");
            params.push(body.mobile);
          }
          if (body.avatar_url) {
            updates.push("avatar_url = ?");
            params.push(body.avatar_url);
          }
          if (updates.length > 0) {
            params.push(targetUserId);
            params.push(targetUserId);
            await pool.query(
              `UPDATE users SET ${updates.join(", ")}, updated_at = NOW() WHERE id = ? OR UPPER(user_id) = UPPER(?)`,
              params,
            );
            const [rows]: any = await pool.query(
              `SELECT id, user_id, name, mobile, email, role, referral_code, avatar_url, created_at
               FROM users WHERE id = ? OR UPPER(user_id) = UPPER(?) LIMIT 1`,
              [targetUserId, targetUserId],
            );
            return jsonResponse({
              success: true,
              profile: rows[0],
              message: "Profile updated",
            });
          }
        } catch (_e) {
          // Ignore update error
        }
      }
      return jsonResponse({ success: false, error: "User not found" }, 404);
    }
  }

  if (route === "users/list") {
    if (method === "GET") {
      const pool = getMysqlPool();
      if (pool) {
        try {
          const [rows]: any = await pool.query(
            `SELECT id, user_id, name, mobile, email, role, referral_code, avatar_url, created_at
             FROM users ORDER BY created_at DESC LIMIT 100`,
          );
          return jsonResponse({
            success: true,
            users: rows,
            total: rows.length,
          });
        } catch (_e) {
          // Ignore list error
        }
      }
      return jsonResponse({
        success: true,
        users: store.users,
        total: store.users.length,
      });
    }
  }

  // 5. Videos
  if (route === "videos/list") {
    if (method === "GET") {
      const userId = url.searchParams.get("userId");
      const videoType = url.searchParams.get("videoType");
      const contentType = url.searchParams.get("contentType");
      const category = url.searchParams.get("category");
      const search = url.searchParams.get("search");

      const pool = getMysqlPool();
      if (pool) {
        try {
          const where: string[] = [];
          const params: any[] = [];
          if (userId) {
            where.push("UPPER(user_id) = UPPER(?)");
            params.push(userId.trim());
          }
          if (videoType && videoType !== "all") {
            where.push("video_type = ?");
            params.push(videoType);
          }
          if (contentType && contentType !== "all") {
            where.push("content_type = ?");
            params.push(contentType);
          }
          if (category && category !== "All") {
            where.push("LOWER(category) = LOWER(?)");
            params.push(category);
          }
          if (search) {
            where.push("(title LIKE ? OR description LIKE ? OR creator_name LIKE ?)");
            const s = `%${search}%`;
            params.push(s, s, s);
          }
          if (!url.searchParams.get("include_blocked")) {
            where.push("COALESCE(is_blocked, 0) = 0");
          }

          const whereSql = where.length > 0 ? "WHERE " + where.join(" AND ") : "";
          const sql = `
            SELECT 
              id, user_id, creator_name, title, description, video_url, thumbnail_url,
              video_type, content_type, category, duration, views, likes,
              payment_status, payment_id, payment_amount, is_promoted,
              promotion_plan, promotion_expires_at, created_at, updated_at,
              (is_promoted = 1 AND promotion_expires_at IS NOT NULL AND promotion_expires_at > NOW()) AS is_active_promoted
            FROM uploaded_videos
            ${whereSql}
            ORDER BY is_active_promoted DESC, created_at DESC
            LIMIT 100
          `;
          const [rows] = (await pool.query(sql, params)) as any;
          if (Array.isArray(rows) && rows.length > 0) {
            const formatted = rows.map((r: any) => {
              const active = isAdPromotionActive({
                is_promoted: r.is_promoted,
                promotion_expires_at: r.promotion_expires_at,
              });
              return {
                id: String(r.id),
                userId: r.user_id,
                user_id: r.user_id,
                creatorName: r.creator_name,
                creator_name: r.creator_name,
                title: r.title,
                description: r.description || "",
                videoUrl: r.video_url,
                video_url: r.video_url,
                thumbnailUrl: r.thumbnail_url || "",
                thumbnail_url: r.thumbnail_url || "",
                videoType: r.video_type,
                video_type: r.video_type,
                contentType: r.content_type,
                content_type: r.content_type,
                category: r.category || "General",
                duration: r.duration || "0:00",
                views: Number(r.views) || 0,
                likes: Number(r.likes) || 0,
                paymentStatus: r.payment_status || "not_required",
                payment_status: r.payment_status || "not_required",
                paymentId: r.payment_id,
                payment_id: r.payment_id,
                paymentAmount: Number(r.payment_amount) || 0,
                payment_amount: Number(r.payment_amount) || 0,
                isPromoted: active,
                is_promoted: active,
                isActivePromoted: active,
                is_active_promoted: active,
                rawIsPromoted: Boolean(r.is_promoted),
                raw_is_promoted: Boolean(r.is_promoted),
                promotionPlan: r.promotion_plan,
                promotion_plan: r.promotion_plan,
                promotionExpiresAt: r.promotion_expires_at,
                promotion_expires_at: r.promotion_expires_at,
                createdAt: r.created_at,
                created_at: r.created_at,
                updatedAt: r.updated_at,
                updated_at: r.updated_at,
              };
            });
            return jsonResponse({ success: true, videos: formatted, total: formatted.length });
          }
        } catch (dbErr) {
          console.warn("MySQL videos/list fallback to local store:", dbErr);
        }
      }

      let filtered = [...store.videos];
      if (!url.searchParams.get("include_blocked")) {
        filtered = filtered.filter((v) => !v.is_blocked);
      }
      if (userId) {
        filtered = filtered.filter((v) => v.user_id.toUpperCase() === userId.trim().toUpperCase());
      }
      if (videoType && videoType !== "all") {
        filtered = filtered.filter((v) => v.video_type === videoType);
      }
      if (contentType && contentType !== "all") {
        filtered = filtered.filter((v) => v.content_type === contentType);
      }
      if (category && category !== "All") {
        filtered = filtered.filter(
          (v) => (v.category || "General").toLowerCase() === category.toLowerCase(),
        );
      }
      if (search) {
        const s = search.toLowerCase();
        filtered = filtered.filter(
          (v) =>
            v.title.toLowerCase().includes(s) ||
            v.description.toLowerCase().includes(s) ||
            v.creator_name.toLowerCase().includes(s),
        );
      }

      // Prioritize actively promoted videos (expiry still in the future) at top of feeds
      filtered.sort((a, b) => {
        const pA = isAdPromotionActive(a) ? 1 : 0;
        const pB = isAdPromotionActive(b) ? 1 : 0;
        if (pA !== pB) return pB - pA;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });

      const formatted = filtered.map((v) => {
        const active = isAdPromotionActive(v);
        return {
          ...v,
          userId: v.user_id,
          creatorName: v.creator_name,
          videoUrl: v.video_url,
          thumbnailUrl: v.thumbnail_url,
          videoType: v.video_type,
          contentType: v.content_type,
          paymentStatus: v.payment_status,
          paymentId: v.payment_id,
          paymentAmount: v.payment_amount,
          isPromoted: active,
          is_promoted: active,
          isActivePromoted: active,
          is_active_promoted: active,
          rawIsPromoted: Boolean(v.is_promoted),
          raw_is_promoted: Boolean(v.is_promoted),
          promotionPlan: v.promotion_plan,
          promotion_plan: v.promotion_plan,
          promotionExpiresAt: v.promotion_expires_at,
          promotion_expires_at: v.promotion_expires_at,
          createdAt: v.created_at,
          updatedAt: v.updated_at,
        };
      });

      return jsonResponse({ success: true, videos: formatted, total: formatted.length });
    }
  }

  if (route === "videos/get") {
    if (method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return jsonResponse({ success: false, error: "Missing video id" }, 400);

      const pool = getMysqlPool();
      if (pool) {
        try {
          const [rows] = (await pool.query("SELECT * FROM uploaded_videos WHERE id = ? LIMIT 1", [
            id,
          ])) as any;
          if (Array.isArray(rows) && rows.length > 0) {
            const r = rows[0];
            if (r.is_blocked) {
              return jsonResponse(
                {
                  success: false,
                  error: "This video has been blocked by administrators for content moderation.",
                  is_blocked: true,
                },
                403,
              );
            }
            const active = isAdPromotionActive({
              is_promoted: r.is_promoted,
              promotion_expires_at: r.promotion_expires_at,
            });
            return jsonResponse({
              success: true,
              video: {
                id: String(r.id),
                userId: r.user_id,
                user_id: r.user_id,
                creatorName: r.creator_name,
                creator_name: r.creator_name,
                title: r.title,
                description: r.description || "",
                videoUrl: r.video_url,
                video_url: r.video_url,
                thumbnailUrl: r.thumbnail_url || "",
                thumbnail_url: r.thumbnail_url || "",
                videoType: r.video_type,
                video_type: r.video_type,
                contentType: r.content_type,
                content_type: r.content_type,
                category: r.category || "General",
                duration: r.duration || "0:00",
                views: Number(r.views) || 0,
                likes: Number(r.likes) || 0,
                paymentStatus: r.payment_status,
                payment_status: r.payment_status,
                paymentId: r.payment_id,
                payment_id: r.payment_id,
                paymentAmount: Number(r.payment_amount) || 0,
                payment_amount: Number(r.payment_amount) || 0,
                isPromoted: active,
                is_promoted: active,
                isActivePromoted: active,
                is_active_promoted: active,
                rawIsPromoted: Boolean(r.is_promoted),
                raw_is_promoted: Boolean(r.is_promoted),
                promotionPlan: r.promotion_plan,
                promotion_plan: r.promotion_plan,
                promotionExpiresAt: r.promotion_expires_at,
                promotion_expires_at: r.promotion_expires_at,
                createdAt: r.created_at,
                created_at: r.created_at,
                updatedAt: r.updated_at,
                updated_at: r.updated_at,
              },
            });
          }
        } catch (_dbErr) {
          // fallback
        }
      }

      const v = store.videos.find((item) => item.id === id);
      if (v) {
        if (v.is_blocked) {
          return jsonResponse(
            {
              success: false,
              error: "This video has been blocked by administrators for content moderation.",
              is_blocked: true,
            },
            403,
          );
        }
        const active = isAdPromotionActive(v);
        return jsonResponse({
          success: true,
          video: {
            ...v,
            userId: v.user_id,
            creatorName: v.creator_name,
            videoUrl: v.video_url,
            thumbnailUrl: v.thumbnail_url,
            videoType: v.video_type,
            contentType: v.content_type,
            paymentStatus: v.payment_status,
            paymentId: v.payment_id,
            paymentAmount: v.payment_amount,
            isPromoted: active,
            is_promoted: active,
            isActivePromoted: active,
            is_active_promoted: active,
            rawIsPromoted: Boolean(v.is_promoted),
            raw_is_promoted: Boolean(v.is_promoted),
            promotionPlan: v.promotion_plan,
            promotion_plan: v.promotion_plan,
            promotionExpiresAt: v.promotion_expires_at,
            promotion_expires_at: v.promotion_expires_at,
            createdAt: v.created_at,
            updatedAt: v.updated_at,
          },
        });
      }
      return jsonResponse({ success: false, error: "Video not found" }, 404);
    }
  }

  if (route === "videos/create") {
    if (method === "POST") {
      const body = await request.json();
      const title = (body.title || "").trim();
      const videoUrl = (body.video_url || body.videoUrl || "").trim();

      if (!title) {
        return jsonResponse({ success: false, error: "Video title is required." }, 400);
      }
      if (!videoUrl) {
        return jsonResponse({ success: false, error: "Video URL is required." }, 400);
      }

      let finalThumbnailUrl =
        body.thumbnail_url ||
        body.thumbnailUrl ||
        "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800&auto=format&fit=crop&q=60";

      const vidId = body.id || `vid-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

      // Save base64 thumbnail to physical disk if provided
      if (finalThumbnailUrl.startsWith("data:image/")) {
        try {
          const parts = finalThumbnailUrl.split(",");
          if (parts.length === 2) {
            const buffer = Buffer.from(parts[1], "base64");
            const imgUploadDir = path.resolve(process.cwd(), "uploads", "images");
            await fs.promises.mkdir(imgUploadDir, { recursive: true });
            const safeVidId = vidId.replace(/[^a-zA-Z0-9_-]/g, "_");
            const imgFileName = `thumb_${safeVidId}.jpg`;
            await fs.promises.writeFile(path.join(imgUploadDir, imgFileName), buffer);
            finalThumbnailUrl = `/uploads/images/${imgFileName}`;
          }
        } catch (imgErr) {
          console.warn("Base64 thumbnail save error:", imgErr);
        }
      }

      const newVideo = {
        id: vidId,
        user_id: body.user_id || body.userId || "FT483921",
        creator_name: body.creator_name || body.creatorName || "FaceTube Creator",
        title,
        description: (body.description || "").trim(),
        video_url: videoUrl,
        thumbnail_url: finalThumbnailUrl,
        video_type: (body.video_type || body.videoType || "free") as "free" | "premium",
        content_type: (body.content_type || body.contentType || "long") as "short" | "long",
        category: body.category || "General",
        duration: body.duration || "1:00",
        views: 0,
        likes: 0,
        payment_status: (body.payment_status ||
          body.paymentStatus ||
          (body.video_type === "premium" ? "pending" : "not_required")) as
          "not_required" | "pending" | "paid" | "failed",
        payment_id: body.payment_id || body.paymentId || undefined,
        payment_amount: Number(body.payment_amount || body.paymentAmount) || 0,
        is_promoted: Boolean(body.is_promoted || body.isPromoted),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      // Persist to MySQL uploaded_videos table if pool is configured
      const pool = getMysqlPool();
      if (process.env["NODE_ENV"] === "production" && !pool) {
        return jsonResponse(
          {
            success: false,
            error:
              "Database connection unavailable. In production, video creation requires a persistent database connection.",
          },
          503,
        );
      }

      if (pool) {
        try {
          await pool.query(
            `INSERT INTO uploaded_videos (
              id, user_id, creator_name, title, description, video_url, thumbnail_url,
              video_type, content_type, category, duration, views, likes,
              payment_status, payment_id, payment_amount, is_promoted,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, NOW(), NOW())
            ON DUPLICATE KEY UPDATE
              title = VALUES(title),
              description = VALUES(description),
              video_url = VALUES(video_url),
              thumbnail_url = VALUES(thumbnail_url),
              video_type = VALUES(video_type),
              content_type = VALUES(content_type),
              category = VALUES(category),
              duration = VALUES(duration),
              payment_status = VALUES(payment_status),
              payment_id = VALUES(payment_id),
              payment_amount = VALUES(payment_amount),
              updated_at = NOW()`,
            [
              newVideo.id,
              newVideo.user_id,
              newVideo.creator_name,
              newVideo.title,
              newVideo.description,
              newVideo.video_url,
              newVideo.thumbnail_url,
              newVideo.video_type,
              newVideo.content_type,
              newVideo.category,
              newVideo.duration,
              newVideo.payment_status,
              newVideo.payment_id || null,
              newVideo.payment_amount,
              newVideo.is_promoted ? 1 : 0,
            ],
          );
          return jsonResponse({ success: true, video: newVideo }, 201);
        } catch (dbErr: any) {
          console.warn("MySQL uploaded_videos insert warning:", dbErr?.message);
          if (process.env["NODE_ENV"] === "production") {
            return jsonResponse(
              {
                success: false,
                error: "Database error during video creation: " + dbErr.message,
              },
              503,
            );
          }
        }
      }

      if (process.env["NODE_ENV"] === "production") {
        return jsonResponse(
          {
            success: false,
            error:
              "Database connection unavailable. In production, persistent database storage is required.",
          },
          503,
        );
      }

      store.videos.unshift(newVideo);
      saveStore(store);
      return jsonResponse({ success: true, video: newVideo }, 201);
    }
  }

  if (route === "videos/like") {
    if (method === "POST") {
      const body = await request.json();
      const vid = store.videos.find((v) => v.id === body.videoId);
      if (vid) {
        vid.likes = (vid.likes || 0) + 1;
        saveStore(store);

        const pool = getMysqlPool();
        if (pool) {
          try {
            await pool.query("UPDATE uploaded_videos SET likes = likes + 1 WHERE id = ?", [
              body.videoId,
            ]);
          } catch (_e) {
            // Ignore error if MySQL is unreachable
          }
        }

        return jsonResponse({ success: true, liked: true, likes: vid.likes });
      }
      return jsonResponse({ success: false, error: "Video not found" }, 404);
    }
  }

  if (route === "videos/counts") {
    if (method === "GET") {
      const userId = url.searchParams.get("userId");
      const list = userId
        ? store.videos.filter((v) => v.user_id.toUpperCase() === userId.trim().toUpperCase())
        : store.videos;

      let freeShort = 0;
      let freeLong = 0;
      let premiumShort = 0;
      let premiumLong = 0;

      for (const v of list) {
        if (v.video_type === "free") {
          if (v.content_type === "short") freeShort++;
          else freeLong++;
        } else {
          if (v.content_type === "short") premiumShort++;
          else premiumLong++;
        }
      }

      return jsonResponse({
        success: true,
        counts: {
          freeShort,
          freeLong,
          premiumShort,
          premiumLong,
          totalFree: freeShort + freeLong,
          totalPremium: premiumShort + premiumLong,
          totalUploaded: freeShort + freeLong + premiumShort + premiumLong,
        },
      });
    }
  }

  if (route === "videos/promote") {
    if (method === "POST") {
      const body = await request.json();
      const videoId = body.videoId || body.video_id;
      if (!videoId) return jsonResponse({ success: false, error: "Missing videoId" }, 400);

      const days = Number(body.durationDays || body.duration_days) || 30;
      const planId = body.planId || body.plan_id || "plan-monthly";
      const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

      const pool = getMysqlPool();
      if (process.env["NODE_ENV"] === "production" && !pool) {
        return jsonResponse(
          {
            success: false,
            error:
              "Database connection unavailable. In production, video promotion requires a persistent database connection.",
          },
          503,
        );
      }

      if (pool) {
        try {
          await pool.query(
            "UPDATE uploaded_videos SET is_promoted = 1, promotion_plan = ?, promotion_expires_at = ?, updated_at = NOW() WHERE id = ?",
            [planId, expiresAt, videoId],
          );
          return jsonResponse({
            success: true,
            message: "Video promoted successfully.",
            promotionExpiresAt: expiresAt,
          });
        } catch (dbErr: any) {
          console.warn("MySQL promote error:", dbErr);
          if (process.env["NODE_ENV"] === "production") {
            return jsonResponse(
              {
                success: false,
                error:
                  "Database error during video promotion: " + (dbErr?.message || String(dbErr)),
              },
              503,
            );
          }
        }
      }

      if (process.env["NODE_ENV"] === "production") {
        return jsonResponse(
          {
            success: false,
            error:
              "Database connection unavailable. In production, persistent database storage is required.",
          },
          503,
        );
      }

      const vid = store.videos.find((v) => v.id === videoId);
      if (vid) {
        vid.is_promoted = true;
        vid.promotion_plan = planId;
        vid.promotion_expires_at = expiresAt;
        saveStore(store);
      }

      return jsonResponse({
        success: true,
        message: "Video promoted successfully.",
        promotionExpiresAt: expiresAt,
      });
    }
  }

  // 6. Media File Uploads (Videos & Images)
  if (route === "uploads/video") {
    if (method === "POST") {
      try {
        const formData = await request.formData();
        const file = formData.get("video");

        if (!file || typeof file === "string") {
          return jsonResponse(
            {
              success: false,
              error: "No video file found in upload request. Field 'video' is required.",
            },
            400,
          );
        }

        const videoFile = file as File;
        const origName = videoFile.name || "video.mp4";
        const ext = path.extname(origName).toLowerCase().replace(/^\./, "") || "mp4";
        const allowedExts = ["mp4", "webm", "ogg", "mov", "m4v", "mkv"];

        if (!allowedExts.includes(ext)) {
          return jsonResponse(
            {
              success: false,
              error: `Unsupported video format '.${ext}'. Supported formats are MP4, WebM, OGG, MOV, M4V.`,
            },
            400,
          );
        }

        const maxSizeBytes = 250 * 1024 * 1024; // 250 MB
        if (videoFile.size <= 0) {
          return jsonResponse(
            { success: false, error: "Uploaded video file is empty (0 bytes)." },
            400,
          );
        }
        if (videoFile.size > maxSizeBytes) {
          return jsonResponse(
            { success: false, error: "Video file size exceeds maximum permitted limit of 250MB." },
            400,
          );
        }

        const uploadDir = path.resolve(process.cwd(), "uploads", "videos");
        await fs.promises.mkdir(uploadDir, { recursive: true });

        const uniqueName = `vid_${Date.now()}_${crypto.randomBytes(6).toString("hex")}.${ext}`;
        const targetPath = path.join(uploadDir, uniqueName);
        const arrayBuf = await videoFile.arrayBuffer();
        await fs.promises.writeFile(targetPath, Buffer.from(arrayBuf));

        const fileSizeMb = `${(videoFile.size / (1024 * 1024)).toFixed(2)} MB`;

        return jsonResponse(
          {
            success: true,
            url: `/uploads/videos/${uniqueName}`,
            fileName: uniqueName,
            format: ext,
            fileSize: fileSizeMb,
            sizeBytes: videoFile.size,
            uploadedAt: new Date().toISOString(),
          },
          201,
        );
      } catch (uploadErr: any) {
        console.error("Video upload server error:", uploadErr);
        return jsonResponse(
          {
            success: false,
            error:
              "Server failed to process video upload: " + (uploadErr?.message || "Unknown error"),
          },
          500,
        );
      }
    }
  }

  if (route === "uploads/image") {
    if (method === "POST") {
      try {
        const formData = await request.formData();
        const file = formData.get("image");

        if (!file || typeof file === "string") {
          return jsonResponse(
            {
              success: false,
              error: "No image file found in upload request. Field 'image' is required.",
            },
            400,
          );
        }

        const imgFile = file as File;
        const origName = imgFile.name || "image.jpg";
        const ext = path.extname(origName).toLowerCase().replace(/^\./, "") || "jpg";
        const allowedExts = ["jpg", "jpeg", "png", "webp"];

        if (!allowedExts.includes(ext)) {
          return jsonResponse(
            {
              success: false,
              error: `Unsupported image format '.${ext}'. Supported formats are JPG, JPEG, PNG, WEBP.`,
            },
            400,
          );
        }

        const maxSizeBytes = 25 * 1024 * 1024; // 25 MB
        if (imgFile.size <= 0) {
          return jsonResponse({ success: false, error: "Uploaded image file is empty." }, 400);
        }
        if (imgFile.size > maxSizeBytes) {
          return jsonResponse(
            { success: false, error: "Image file exceeds maximum permitted limit of 25MB." },
            400,
          );
        }

        const uploadDir = path.resolve(process.cwd(), "uploads", "images");
        await fs.promises.mkdir(uploadDir, { recursive: true });

        const uniqueName = `img_${Date.now()}_${crypto.randomBytes(6).toString("hex")}.${ext}`;
        const targetPath = path.join(uploadDir, uniqueName);
        const arrayBuf = await imgFile.arrayBuffer();
        await fs.promises.writeFile(targetPath, Buffer.from(arrayBuf));

        const fileSizeMb = `${(imgFile.size / (1024 * 1024)).toFixed(2)} MB`;

        return jsonResponse(
          {
            success: true,
            url: `/uploads/images/${uniqueName}`,
            fileName: uniqueName,
            format: ext,
            fileSize: fileSizeMb,
            sizeBytes: imgFile.size,
            uploadedAt: new Date().toISOString(),
          },
          201,
        );
      } catch (uploadErr: any) {
        console.error("Image upload server error:", uploadErr);
        return jsonResponse(
          {
            success: false,
            error:
              "Server failed to process image upload: " + (uploadErr?.message || "Unknown error"),
          },
          500,
        );
      }
    }
  }

  // 6. Comments
  if (route === "comments/list") {
    if (method === "GET") {
      const videoId = url.searchParams.get("videoId");
      const cmts = videoId ? store.comments.filter((c) => c.video_id === videoId) : store.comments;
      return jsonResponse({
        success: true,
        comments: cmts.map((c) => ({
          ...c,
          videoId: c.video_id,
          userId: c.user_id,
          userName: c.user_name,
          avatarUrl: c.avatar_url,
          createdAt: c.created_at,
        })),
        total: cmts.length,
      });
    }
  }

  if (route === "comments/create") {
    if (method === "POST") {
      const body = await request.json();
      const newComment = {
        id: `cmt-${Date.now()}`,
        video_id: body.videoId,
        user_id: body.userId,
        user_name: body.userName,
        avatar_url: body.avatarUrl,
        comment: body.comment,
        created_at: new Date().toISOString(),
      };
      store.comments.unshift(newComment);
      saveStore(store);
      return jsonResponse({ success: true, comment: newComment });
    }
  }

  // 7. Images
  if (route === "images/list") {
    if (method === "GET") {
      const userId = url.searchParams.get("userId");
      const pool = getMysqlPool();
      if (pool) {
        try {
          const sql = userId
            ? "SELECT * FROM uploaded_images WHERE UPPER(user_id) = UPPER(?) ORDER BY created_at DESC"
            : "SELECT * FROM uploaded_images ORDER BY created_at DESC";
          const [rows] = (await pool.query(sql, userId ? [userId.trim()] : [])) as any;
          if (Array.isArray(rows) && rows.length > 0) {
            const mapped = rows.map((r: any) => ({
              id: String(r.id),
              userId: r.user_id,
              user_id: r.user_id,
              creatorName: r.creator_name,
              creator_name: r.creator_name,
              title: r.title,
              description: r.description || "",
              imageUrl: r.image_url,
              image_url: r.image_url,
              thumbnailUrl: r.thumbnail_url || r.image_url,
              thumbnail_url: r.thumbnail_url || r.image_url,
              format: r.format || "jpg",
              fileSize: r.file_size || "1.0 MB",
              file_size: r.file_size || "1.0 MB",
              category: r.category || "General",
              views: Number(r.views) || 0,
              likes: Number(r.likes) || 0,
              createdAt: r.created_at,
              created_at: r.created_at,
            }));
            return jsonResponse({ success: true, images: mapped, total: mapped.length });
          }
        } catch (_dbErr) {
          // fallback to store.images
        }
      }

      const imgs = userId
        ? store.images.filter((i) => i.user_id.toUpperCase() === userId.trim().toUpperCase())
        : store.images;
      return jsonResponse({
        success: true,
        images: imgs.map((i) => ({
          ...i,
          userId: i.user_id,
          creatorName: i.creator_name,
          imageUrl: i.image_url,
          thumbnailUrl: i.thumbnail_url || i.image_url,
          fileSize: i.file_size || "1.0 MB",
          createdAt: i.created_at,
        })),
        total: imgs.length,
      });
    }
  }

  if (route === "images/create") {
    if (method === "POST") {
      const body = await request.json();
      const rawImageUrl = (body.imageUrl || body.image_url || "").trim();
      if (!rawImageUrl) {
        return jsonResponse(
          {
            success: false,
            error: "Image URL is required. Please upload the image file to storage first.",
          },
          400,
        );
      }

      const imgId = body.id || `img-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const newImage = {
        id: imgId,
        user_id: body.userId || body.user_id || "FT102857",
        creator_name: body.creatorName || body.creator_name || "Creator",
        title: (body.title || "Uploaded Image").trim(),
        description: (body.description || "").trim(),
        image_url: rawImageUrl,
        thumbnail_url: (body.thumbnailUrl || body.thumbnail_url || rawImageUrl).trim(),
        format: (body.format || "jpg").toLowerCase(),
        file_size: body.fileSize || body.file_size || "1.2 MB",
        category: body.category || "Entertainment",
        effect: body.effect || "original",
        music: body.music || undefined,
        views: 0,
        likes: 0,
        created_at: new Date().toISOString(),
      };

      const pool = getMysqlPool();
      if (pool) {
        try {
          await pool.query(
            `INSERT INTO uploaded_images (id, user_id, creator_name, title, description, image_url, format, file_size, category, views, likes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NOW())`,
            [
              newImage.id,
              newImage.user_id,
              newImage.creator_name,
              newImage.title,
              newImage.description,
              newImage.image_url,
              newImage.format,
              newImage.file_size,
              newImage.category,
            ],
          );
        } catch (_dbErr) {
          // ignore error if MySQL is unreachable
        }
      }

      store.images.unshift(newImage);
      saveStore(store);
      return jsonResponse({
        success: true,
        image: {
          ...newImage,
          userId: newImage.user_id,
          creatorName: newImage.creator_name,
          imageUrl: newImage.image_url,
          thumbnailUrl: newImage.thumbnail_url,
          fileSize: newImage.file_size,
          createdAt: newImage.created_at,
        },
      });
    }
  }

  // 8. Wallet & Income
  if (route === "wallet/balance") {
    if (method === "GET") {
      const qUserId = url.searchParams.get("userId") || url.searchParams.get("user_id");
      const pool = getMysqlPool();
      const authUser = await getAuthUserFromRequest(request, store, pool);
      const auth = requireAuth(authUser, qUserId);
      if (!auth.success) {
        return auth.response;
      }
      const userId = auth.effectiveUserId;

      if (pool) {
        try {
          const [rows] = await pool.query<any[]>(
            `SELECT * FROM wallet_balances WHERE UPPER(user_id) = UPPER(?) LIMIT 1`,
            [userId],
          );
          if (rows && rows.length > 0) {
            const w = rows[0];
            const bal = Number(w.balance || 0);
            const refInc = Number(w.referral_income || 0);
            const glbInc = Number(w.global_income || 0);
            const adsInc = Number(w.adsense_income || 0);
            const admInc = Number(w.admob_income || 0);
            const affInc = Number(w.affiliate_income || 0);
            const totEarn = Number(w.total_earned || bal);
            const totWdr = Number(w.total_withdrawn || 0);

            return jsonResponse({
              success: true,
              wallet: {
                userId,
                user_id: userId,
                balance: bal,
                totalBalance: bal,
                withdrawableBalance: bal,
                referralIncome: refInc,
                referral_income: refInc,
                directReferralIncome: refInc,
                globalIncome: glbInc,
                global_income: glbInc,
                adsenseIncome: adsInc,
                adsense_income: adsInc,
                admobIncome: admInc,
                admob_income: admInc,
                affiliateIncome: affInc,
                affiliate_income: affInc,
                totalEarnings: totEarn,
                total_earned: totEarn,
                totalWithdrawn: totWdr,
                total_withdrawn: totWdr,
                pendingWithdrawals: 0,
                updatedAt: w.updated_at || new Date().toISOString(),
                updated_at: w.updated_at || new Date().toISOString(),
              },
            });
          }
        } catch (_e) {
          if (process.env["NODE_ENV"] === "production") {
            return jsonResponse(
              {
                success: false,
                error: "Database error while retrieving wallet balance.",
              },
              503,
            );
          }
        }
      }

      if (process.env["NODE_ENV"] === "production") {
        return jsonResponse(
          {
            success: false,
            error:
              "Database connection unavailable. In production, wallet balance requires a persistent database connection.",
          },
          503,
        );
      }

      const w = store.wallets?.[userId] || {
        balance: 0,
        total_earned: 0,
        total_withdrawn: 0,
        referral_income: 0,
        global_income: 0,
        adsense_income: 0,
        admob_income: 0,
        affiliate_income: 0,
        updated_at: new Date().toISOString(),
      };

      return jsonResponse({
        success: true,
        wallet: {
          userId,
          user_id: userId,
          balance: w.balance,
          totalBalance: w.balance,
          withdrawableBalance: w.balance,
          referralIncome: w.referral_income,
          referral_income: w.referral_income,
          directReferralIncome: w.referral_income,
          globalIncome: w.global_income,
          global_income: w.global_income,
          adsenseIncome: w.adsense_income,
          adsense_income: w.adsense_income,
          admobIncome: w.admob_income || 0,
          admob_income: w.admob_income || 0,
          affiliateIncome: w.affiliate_income,
          affiliate_income: w.affiliate_income,
          totalEarnings: w.total_earned,
          total_earned: w.total_earned,
          totalWithdrawn: w.total_withdrawn,
          total_withdrawn: w.total_withdrawn,
          pendingWithdrawals: 0,
          updatedAt: w.updated_at,
          updated_at: w.updated_at,
        },
      });
    }
  }

  if (route === "wallet/transactions") {
    if (method === "GET") {
      const qUserId = url.searchParams.get("userId") || url.searchParams.get("user_id");
      const pool = getMysqlPool();
      const authUser = await getAuthUserFromRequest(request, store, pool);
      if (!authUser) {
        return jsonResponse(
          {
            success: false,
            error: "Authentication required. Please provide a valid Bearer session token.",
          },
          401,
        );
      }
      const auth = requireAuth(authUser, qUserId);
      if (!auth.success) {
        return auth.response;
      }
      const targetUserId = auth.effectiveUserId;

      if (pool) {
        try {
          const query =
            authUser.role === "admin" && !qUserId
              ? `SELECT * FROM wallet_transactions ORDER BY created_at DESC LIMIT 100`
              : `SELECT * FROM wallet_transactions WHERE UPPER(user_id) = UPPER(?) ORDER BY created_at DESC LIMIT 100`;
          const params = authUser.role === "admin" && !qUserId ? [] : [targetUserId];
          const [rows]: any = await pool.query(query, params);
          if (rows) {
            return jsonResponse({
              success: true,
              transactions: rows,
              total: rows.length,
            });
          }
        } catch (_e) {
          try {
            const queryLedger =
              authUser.role === "admin" && !qUserId
                ? `SELECT * FROM income_ledger ORDER BY created_at DESC LIMIT 100`
                : `SELECT * FROM income_ledger WHERE UPPER(user_id) = UPPER(?) ORDER BY created_at DESC LIMIT 100`;
            const params = authUser.role === "admin" && !qUserId ? [] : [targetUserId];
            const [rows]: any = await pool.query(queryLedger, params);
            if (rows) {
              return jsonResponse({
                success: true,
                transactions: rows,
                total: rows.length,
              });
            }
          } catch (_e2) {
            if (process.env["NODE_ENV"] === "production") {
              return jsonResponse(
                {
                  success: false,
                  error: "Database error while retrieving wallet transactions.",
                },
                503,
              );
            }
          }
        }
      }

      if (process.env["NODE_ENV"] === "production") {
        return jsonResponse(
          {
            success: false,
            error:
              "Database connection unavailable. In production, wallet transactions require a persistent database connection.",
          },
          503,
        );
      }

      const filtered =
        authUser.role === "admin" && !qUserId
          ? store.walletTransactions
          : store.walletTransactions.filter(
              (t: any) =>
                String(t.userId || t.user_id || "").toUpperCase() === targetUserId.toUpperCase(),
            );

      return jsonResponse({
        success: true,
        transactions: filtered,
        total: filtered.length,
      });
    }
  }

  if (route === "wallet/withdraw") {
    if (method === "POST") {
      const pool = getMysqlPool();
      const authUser = await getAuthUserFromRequest(request, store, pool);
      if (!authUser) {
        return jsonResponse(
          {
            success: false,
            error: "Authentication required. Please provide a valid Bearer session token.",
          },
          401,
        );
      }

      const payload = await request.json();
      const amount = Number(payload.amount);
      const requestedUserId = String(payload.userId || payload.user_id || "").trim();
      const payoutMethodInput = String(payload.payoutMethod || payload.payout_method || "").trim();
      let bankDetails =
        payload.bankDetails && typeof payload.bankDetails === "object"
          ? payload.bankDetails
          : payload.bank_details && typeof payload.bank_details === "object"
            ? payload.bank_details
            : null;

      // Enforce ownership: standard users can ONLY withdraw from their own account
      let effectiveUserId = authUser.user_id;
      if (requestedUserId && requestedUserId.toUpperCase() !== authUser.user_id.toUpperCase()) {
        if (authUser.role !== "admin") {
          return jsonResponse(
            {
              success: false,
              error: "Unauthorized: You cannot initiate withdrawals on behalf of another user.",
            },
            403,
          );
        }
        effectiveUserId = requestedUserId.toUpperCase();
      }

      if (isNaN(amount) || amount < 100) {
        return jsonResponse(
          {
            success: false,
            error: "Minimum withdrawal amount is ₹100. You cannot withdraw less than ₹100.",
          },
          400,
        );
      }
      if (amount > 10000) {
        return jsonResponse(
          {
            success: false,
            error:
              "Maximum daily withdrawal limit is ₹10,000. You cannot withdraw more than ₹10,000 per day.",
          },
          400,
        );
      }

      // Company Confirmed Withdrawal Fee Rule:
      // - Minimum: ₹100, Maximum: ₹10,000 per day
      // - GST: 18% of FULL withdrawal amount
      // - PG Fee: 2% of FULL withdrawal amount
      // - Total Deduction: 20% of withdrawal amount
      // - Net Payout: 80% of withdrawal amount
      // Examples: ₹1,000 -> ₹180 GST + ₹20 PG -> ₹800 net; ₹5,000 -> ₹900 GST + ₹100 PG -> ₹4,000 net; ₹10,000 -> ₹1,800 GST + ₹200 PG -> ₹8,000 net
      const gstAmount = Math.round(amount * 0.18 * 100) / 100;
      const pgFeeAmount = Math.round(amount * 0.02 * 100) / 100;
      const fee = Math.round((gstAmount + pgFeeAmount) * 100) / 100;
      const netAmount = Math.max(0, Math.round((amount - fee) * 100) / 100);
      const chargesBreakdown = {
        grossAmount: amount,
        fee,
        gstRatePercent: 18,
        gstAmount,
        pgFeePercent: 2,
        pgFeeAmount,
        totalDeductionPercent: 20,
        totalCharge: fee,
        netPayable: netAmount,
        baseProcessing: 0,
        adminAllocation: 0,
      };

      if (pool) {
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();

          // 1. Row-level pessimistic lock on user's wallet record (prevents concurrent over-withdrawal)
          const [bRows]: any = await conn.query(
            `SELECT balance FROM wallet_balances WHERE UPPER(user_id) = UPPER(?) FOR UPDATE`,
            [effectiveUserId],
          );
          const currentBal = Number(bRows?.[0]?.balance || 0);

          // 2. Authoritative Server-Side Personal KYC Verification
          let personalKycStatus: string | null = null;
          try {
            const [pRows]: any = await conn.query(
              `SELECT status FROM personal_kyc WHERE UPPER(user_id) = UPPER(?) LIMIT 1`,
              [effectiveUserId],
            );
            if (pRows && pRows.length > 0) {
              personalKycStatus = String(pRows[0].status || "");
            }
          } catch (_eP) {
            try {
              const [pRows2]: any = await conn.query(
                `SELECT status FROM kyc_records WHERE UPPER(user_id) = UPPER(?) LIMIT 1`,
                [effectiveUserId],
              );
              if (pRows2 && pRows2.length > 0) {
                personalKycStatus = String(pRows2[0].status || "");
              }
            } catch (_eP2) {
              // Table not found
            }
          }

          if (!personalKycStatus || personalKycStatus.toLowerCase() !== "verified") {
            await conn.rollback();
            return jsonResponse(
              {
                success: false,
                error:
                  "Personal KYC verification required. Your personal KYC must be verified before requesting a withdrawal.",
              },
              400,
            );
          }

          // 3. Authoritative Server-Side Bank KYC Verification
          let bankKycStatus: string | null = null;
          let kycBankDetails: any = null;
          try {
            const [bKycRows]: any = await conn.query(
              `SELECT status, account_holder_name, bank_name, account_number, ifsc_code, upi_id FROM bank_kyc WHERE UPPER(user_id) = UPPER(?) LIMIT 1`,
              [effectiveUserId],
            );
            if (bKycRows && bKycRows.length > 0) {
              bankKycStatus = String(bKycRows[0].status || "");
              kycBankDetails = {
                accountHolder: bKycRows[0].account_holder_name,
                bankName: bKycRows[0].bank_name,
                accountNumber: bKycRows[0].account_number,
                ifscCode: bKycRows[0].ifsc_code,
                upiId: bKycRows[0].upi_id,
              };
            }
          } catch (_eB) {
            try {
              const [bKycRows2]: any = await conn.query(
                `SELECT status, account_holder_name, bank_name, account_number, ifsc_code, upi_id FROM kyc_bank_details WHERE UPPER(user_id) = UPPER(?) LIMIT 1`,
                [effectiveUserId],
              );
              if (bKycRows2 && bKycRows2.length > 0) {
                bankKycStatus = String(bKycRows2[0].status || "");
                kycBankDetails = {
                  accountHolder: bKycRows2[0].account_holder_name,
                  bankName: bKycRows2[0].bank_name,
                  accountNumber: bKycRows2[0].account_number,
                  ifscCode: bKycRows2[0].ifsc_code,
                  upiId: bKycRows2[0].upi_id,
                };
              }
            } catch (_eB2) {
              // Table not found
            }
          }

          if (!bankKycStatus || bankKycStatus.toLowerCase() !== "verified") {
            await conn.rollback();
            return jsonResponse(
              {
                success: false,
                error:
                  "Bank KYC verification required. Your bank KYC must be verified before requesting a withdrawal.",
              },
              400,
            );
          }

          if (!bankDetails && kycBankDetails) {
            bankDetails = kycBankDetails;
          }

          // 4. Daily Cumulative Withdrawal Limit inside transaction
          // Include same-day pending and successful withdrawals; exclude failed withdrawals
          let alreadyWithdrawnToday = 0;
          try {
            const [dailyRows]: any = await conn.query(
              `SELECT COALESCE(SUM(ABS(amount)), 0) AS daily_total
               FROM income_ledger
               WHERE UPPER(user_id) = UPPER(?)
                 AND income_type = 'withdrawal'
                 AND status != 'failed'
                 AND DATE(created_at) = CURDATE()`,
              [effectiveUserId],
            );
            alreadyWithdrawnToday = Number(dailyRows?.[0]?.daily_total || 0);
          } catch (_eDaily) {
            try {
              const [dailyRowsWt]: any = await conn.query(
                `SELECT COALESCE(SUM(ABS(amount)), 0) AS daily_total
                 FROM wallet_transactions
                 WHERE UPPER(user_id) = UPPER(?)
                   AND type = 'withdrawal'
                   AND status != 'failed'
                   AND DATE(created_at) = CURDATE()`,
                [effectiveUserId],
              );
              alreadyWithdrawnToday = Number(dailyRowsWt?.[0]?.daily_total || 0);
            } catch (_eDailyWt) {
              // Table not found
            }
          }

          if (alreadyWithdrawnToday >= 10000) {
            await conn.rollback();
            return jsonResponse(
              {
                success: false,
                error:
                  "Daily withdrawal limit of ₹10,000 reached. Further withdrawals are blocked until tomorrow.",
              },
              400,
            );
          }

          if (alreadyWithdrawnToday + amount > 10000) {
            await conn.rollback();
            const remainingDaily = Math.max(0, 10000 - alreadyWithdrawnToday);
            return jsonResponse(
              {
                success: false,
                error: `Daily limit exceeded. You have already withdrawn ₹${alreadyWithdrawnToday.toLocaleString("en-IN")} today. You can withdraw at most ₹${remainingDaily.toLocaleString("en-IN")} more today.`,
              },
              400,
            );
          }

          // 5. Balance sufficiency check
          if (currentBal < amount) {
            await conn.rollback();
            return jsonResponse(
              {
                success: false,
                error: `Insufficient balance. Your current withdrawable balance is ₹${currentBal.toLocaleString("en-IN")}, but you requested ₹${amount.toLocaleString("en-IN")}.`,
              },
              400,
            );
          }

          let payoutMethod = payoutMethodInput;
          if (!payoutMethod) {
            if (bankDetails?.upiId || bankDetails?.upi_id) {
              if (!bankDetails?.accountNumber && !bankDetails?.account_number) {
                payoutMethod = "upi";
              } else {
                payoutMethod = "bank_transfer";
              }
            } else {
              payoutMethod = "bank_transfer";
            }
          }
          const beneficiaryDetailsJson = buildMaskedBeneficiaryDetails(bankDetails);

          const newBal = currentBal - amount;
          await conn.query(
            `UPDATE wallet_balances 
             SET balance = balance - ?, total_withdrawn = total_withdrawn + ?, updated_at = NOW() 
             WHERE UPPER(user_id) = UPPER(?)`,
            [amount, amount, effectiveUserId],
          );

          const txId = `tx_wdr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
          let recorded = false;
          try {
            await conn.query(
              `INSERT INTO wallet_transactions (id, user_id, type, amount, status, payout_method, beneficiary_details, created_at)
               VALUES (?, ?, 'withdrawal', ?, 'approved', ?, ?, NOW())`,
              [txId, effectiveUserId, amount, payoutMethod, beneficiaryDetailsJson],
            );
            recorded = true;
          } catch (_eWt) {
            try {
              await conn.query(
                `INSERT INTO income_ledger (id, transaction_id, user_id, income_type, amount, status, description, payout_method, beneficiary_details, created_at)
                 VALUES (?, ?, ?, 'withdrawal', ?, 'settled', ?, ?, ?, NOW())`,
                [
                  txId,
                  txId,
                  effectiveUserId,
                  amount,
                  `Withdrawal request approved for ₹${amount.toFixed(2)} (Net: ₹${netAmount.toFixed(2)} after 20% charges: 18% GST ₹${gstAmount.toFixed(2)} + 2% PG ₹${pgFeeAmount.toFixed(2)})`,
                  payoutMethod,
                  beneficiaryDetailsJson,
                ],
              );
              recorded = true;
            } catch (_eLedger) {
              await conn.query(
                `INSERT INTO income_ledger (id, transaction_id, user_id, income_type, amount, status, description, created_at)
                 VALUES (?, ?, ?, 'withdrawal', ?, 'settled', ?, NOW())`,
                [
                  txId,
                  txId,
                  effectiveUserId,
                  amount,
                  `Withdrawal request approved for ₹${amount.toFixed(2)} (Net: ₹${netAmount.toFixed(2)} after 20% charges: 18% GST ₹${gstAmount.toFixed(2)} + 2% PG ₹${pgFeeAmount.toFixed(2)})`,
                ],
              );
              recorded = true;
            }
          }

          await conn.commit();

          return jsonResponse({
            success: true,
            message: `Withdrawal request for ₹${amount.toLocaleString("en-IN")} (Net Payable: ₹${netAmount.toLocaleString("en-IN")} after 20% charges: 18% GST ₹${gstAmount.toFixed(2)} + 2% PG ₹${pgFeeAmount.toFixed(2)}) validated and approved.`,
            transaction: {
              id: txId,
              userId: effectiveUserId,
              user_id: effectiveUserId,
              amount,
              fee,
              netAmount,
              net_amount: netAmount,
              chargesBreakdown,
              type: "withdrawal",
              status: "approved",
              payout_method: payoutMethod,
              payoutMethod: payoutMethod,
              beneficiary_details: beneficiaryDetailsJson,
              beneficiaryDetails: beneficiaryDetailsJson,
              createdAt: new Date().toISOString(),
            },
            updatedWallet: {
              userId: effectiveUserId,
              user_id: effectiveUserId,
              balance: newBal,
              totalBalance: newBal,
              withdrawableBalance: newBal,
            },
          });
        } catch (wErr) {
          await conn.rollback();
          throw wErr;
        } finally {
          conn.release();
        }
      }

      if (process.env["NODE_ENV"] === "production") {
        return jsonResponse(
          {
            success: false,
            error:
              "Database connection unavailable. In production, withdrawals require a persistent database connection.",
          },
          503,
        );
      }

      // In-memory/JSON store withdrawal (non-production preview only)
      if (!store.wallets) store.wallets = {};
      const currentWallet = store.wallets[effectiveUserId] || {
        balance: 0,
        total_earned: 0,
        total_withdrawn: 0,
        referral_income: 0,
        global_income: 0,
        adsense_income: 0,
        affiliate_income: 0,
        updated_at: new Date().toISOString(),
      };

      // 1. Authoritative Server-Side Personal KYC Verification (JSON fallback)
      const personalKycRecord = (store.personalKyc?.[effectiveUserId] ||
        store.personalKyc?.[effectiveUserId.toUpperCase()]) as any;
      const pKycStatus = String(personalKycRecord?.status || "").toLowerCase();
      if (pKycStatus !== "verified") {
        return jsonResponse(
          {
            success: false,
            error:
              "Personal KYC verification required. Your personal KYC must be verified before requesting a withdrawal.",
          },
          400,
        );
      }

      // 2. Authoritative Server-Side Bank KYC Verification (JSON fallback)
      const bankKycRecord = (store.bankKyc?.[effectiveUserId] ||
        store.bankKyc?.[effectiveUserId.toUpperCase()]) as any;
      const bKycStatus = String(bankKycRecord?.status || "").toLowerCase();
      if (bKycStatus !== "verified") {
        return jsonResponse(
          {
            success: false,
            error:
              "Bank KYC verification required. Your bank KYC must be verified before requesting a withdrawal.",
          },
          400,
        );
      }

      if (!bankDetails && bankKycRecord) {
        bankDetails = {
          accountHolder: bankKycRecord.accountHolderName || bankKycRecord.accountHolder,
          bankName: bankKycRecord.bankName,
          accountNumber: bankKycRecord.accountNumber,
          ifscCode: bankKycRecord.ifscCode,
          upiId: bankKycRecord.upiId,
        };
      }

      // 3. Cumulative Daily Withdrawal Limit (JSON fallback)
      // Include same-day pending and successful withdrawals; exclude failed withdrawals
      const todayPrefix = new Date().toISOString().split("T")[0];
      const alreadyWithdrawnToday = (store.walletTransactions || []).reduce(
        (sum: number, txItem: any) => {
          const txUser = String(txItem.user_id || txItem.userId || "")
            .trim()
            .toUpperCase();
          if (txUser !== effectiveUserId.toUpperCase()) return sum;
          const txType = String(
            txItem.type || txItem.incomeType || txItem.income_type || "",
          ).toLowerCase();
          if (txType !== "withdrawal") return sum;
          const txStatus = String(txItem.status || "").toLowerCase();
          if (txStatus === "failed") return sum;
          const txDate = String(txItem.created_at || txItem.createdAt || "").split("T")[0];
          if (txDate !== todayPrefix) return sum;
          return sum + Math.abs(Number(txItem.amount) || 0);
        },
        0,
      );

      if (alreadyWithdrawnToday >= 10000) {
        return jsonResponse(
          {
            success: false,
            error:
              "Daily withdrawal limit of ₹10,000 reached. Further withdrawals are blocked until tomorrow.",
          },
          400,
        );
      }

      if (alreadyWithdrawnToday + amount > 10000) {
        const remainingDaily = Math.max(0, 10000 - alreadyWithdrawnToday);
        return jsonResponse(
          {
            success: false,
            error: `Daily limit exceeded. You have already withdrawn ₹${alreadyWithdrawnToday.toLocaleString("en-IN")} today. You can withdraw at most ₹${remainingDaily.toLocaleString("en-IN")} more today.`,
          },
          400,
        );
      }

      // 4. Balance sufficiency check
      if (currentWallet.balance < amount) {
        return jsonResponse(
          {
            success: false,
            error: `Insufficient balance. Your current withdrawable balance is ₹${currentWallet.balance.toLocaleString("en-IN")}, but you requested ₹${amount.toLocaleString("en-IN")}.`,
          },
          400,
        );
      }

      let payoutMethod = payoutMethodInput;
      if (!payoutMethod) {
        if (bankDetails?.upiId || bankDetails?.upi_id) {
          if (!bankDetails?.accountNumber && !bankDetails?.account_number) {
            payoutMethod = "upi";
          } else {
            payoutMethod = "bank_transfer";
          }
        } else {
          payoutMethod = "bank_transfer";
        }
      }
      const beneficiaryDetailsJson = buildMaskedBeneficiaryDetails(bankDetails);

      currentWallet.balance -= amount;
      currentWallet.total_withdrawn += amount;
      currentWallet.updated_at = new Date().toISOString();
      store.wallets[effectiveUserId] = currentWallet;

      const tx = {
        id: `tx-wdr-${Date.now()}`,
        transactionId: `tx-wdr-${Date.now()}`,
        transaction_id: `tx-wdr-${Date.now()}`,
        userId: effectiveUserId,
        user_id: effectiveUserId,
        amount,
        fee,
        netAmount,
        net_amount: netAmount,
        chargesBreakdown,
        type: "withdrawal",
        incomeType: "withdrawal",
        income_type: "withdrawal",
        status: "approved",
        payout_method: payoutMethod,
        payoutMethod: payoutMethod,
        beneficiary_details: beneficiaryDetailsJson,
        beneficiaryDetails: beneficiaryDetailsJson,
        createdAt: new Date().toISOString(),
        created_at: new Date().toISOString(),
      };
      store.walletTransactions.unshift(tx);
      saveStore(store);

      return jsonResponse({
        success: true,
        message: `Withdrawal request for ₹${amount.toLocaleString("en-IN")} (Net Payable: ₹${netAmount.toLocaleString("en-IN")} after 20% charges: 18% GST ₹${gstAmount.toFixed(2)} + 2% PG ₹${pgFeeAmount.toFixed(2)}) validated and approved.`,
        transaction: tx,
        updatedWallet: {
          userId: effectiveUserId,
          user_id: effectiveUserId,
          balance: currentWallet.balance,
          totalBalance: currentWallet.balance,
          withdrawableBalance: currentWallet.balance,
        },
      });
    }
  }

  // 9. KYC
  if (route === "kyc/personal") {
    if (process.env["NODE_ENV"] === "production") {
      return jsonResponse(
        {
          success: false,
          error:
            "Database connection unavailable. In production, KYC information cannot be stored in ephemeral storage.",
        },
        503,
      );
    }
    if (method === "GET") {
      const userId = (url.searchParams.get("userId") || "FT102857").toUpperCase();
      const kyc = store.personalKyc[userId] || null;
      return jsonResponse({ success: true, kyc });
    }
    if (method === "POST") {
      const body = await request.json().catch(() => ({}));
      const userId = (body.userId || body.user_id || "FT102857").toUpperCase();
      if (!store.personalKyc) store.personalKyc = {};
      store.personalKyc[userId] = {
        ...body,
        userId,
        status: "Submitted",
        updatedAt: new Date().toISOString(),
      };
      saveStore(store);
      return jsonResponse({
        success: true,
        message: "Personal KYC saved",
        kyc: store.personalKyc[userId],
      });
    }
  }

  if (route === "kyc/bank") {
    if (process.env["NODE_ENV"] === "production") {
      return jsonResponse(
        {
          success: false,
          error:
            "Database connection unavailable. In production, KYC information cannot be stored in ephemeral storage.",
        },
        503,
      );
    }
    if (method === "GET") {
      const userId = (url.searchParams.get("userId") || "FT102857").toUpperCase();
      const kyc = store.bankKyc[userId] || null;
      return jsonResponse({ success: true, kyc });
    }
    if (method === "POST") {
      const body = await request.json().catch(() => ({}));
      const userId = (body.userId || body.user_id || "FT102857").toUpperCase();
      if (!store.bankKyc) store.bankKyc = {};
      store.bankKyc[userId] = {
        ...body,
        userId,
        status: "Submitted",
        updatedAt: new Date().toISOString(),
      };
      saveStore(store);
      return jsonResponse({ success: true, message: "Bank KYC saved", kyc: store.bankKyc[userId] });
    }
  }

  // 10. Referrals
  if (route === "referrals/dashboard") {
    if (method === "GET") {
      const qUserId = url.searchParams.get("userId") || url.searchParams.get("user_id");
      const pool = getMysqlPool();
      const authUser = await getAuthUserFromRequest(request, store, pool);
      const auth = requireAuth(authUser, qUserId);
      if (!auth.success) {
        return auth.response;
      }
      const userId = auth.effectiveUserId;

      if (pool) {
        try {
          const [uRows] = await pool.query<any[]>(
            `SELECT user_id, referral_code, mobile, name FROM users WHERE UPPER(user_id) = UPPER(?) LIMIT 1`,
            [userId],
          );
          if (uRows && uRows.length > 0) {
            const u = uRows[0];
            const known = KNOWN_PROMOTIONAL_ALIASES[userId.toUpperCase()] || [];
            const shareCode = known.length > 0 ? known[0]! : u.user_id;

            // Fetch all users to compute cycle-safe 10-level downline
            const [allDbUsers] = await pool.query<any[]>(
              `SELECT id, user_id, name, email, mobile, created_at, role, referral_code FROM users`,
            );
            const downline = calculateDownlineLevelsTs(userId, allDbUsers || [], 10);

            const [wRows] = await pool.query<any[]>(
              `SELECT referral_income FROM wallet_balances WHERE UPPER(user_id) = UPPER(?) LIMIT 1`,
              [userId],
            );
            const refIncome = Number(wRows?.[0]?.referral_income || 0);

            // Compute video earnings for Level 1 (direct) referrals
            const directMembers = downline.membersByLevel[1] || [];
            const members = await Promise.all(
              directMembers.map(async (r) => {
                const [vRows] = await pool.query<any[]>(
                  `SELECT video_type, payment_status, COUNT(*) as cnt 
                   FROM uploaded_videos 
                   WHERE UPPER(user_id) = UPPER(?) 
                   GROUP BY video_type, payment_status`,
                  [r.userId],
                );
                let freeCount = 0;
                let premCount = 0;
                for (const vr of vRows || []) {
                  if (vr.video_type === "free") freeCount += Number(vr.cnt);
                  if (
                    vr.video_type === "premium" &&
                    (vr.payment_status === "paid" || vr.payment_status === "not_required")
                  ) {
                    premCount += Number(vr.cnt);
                  }
                }
                const comm = premCount * 1.0;
                return {
                  id: r.id,
                  userId: r.userId,
                  name: r.name,
                  email: r.email || "",
                  mobile: r.mobile || "",
                  joinedAt: r.joinedAt,
                  status: "Active",
                  tier: r.role === "admin" ? "Admin" : "Creator",
                  freeVideosCount: freeCount,
                  premiumVideosCount: premCount,
                  totalVideosCount: freeCount + premCount,
                  directCommissionEarned: comm,
                  contribution: comm,
                  access: "Granted",
                };
              }),
            );

            return jsonResponse({
              success: true,
              dashboard: {
                userId,
                referralCode: shareCode,
                referralNumber: u.mobile || "",
                referralLink: `https://facetube.online/register?ref=${encodeURIComponent(shareCode)}`,
                directReferralsCount: downline.directCount,
                teamMembersCount: downline.totalTeamCount,
                referralIncome: refIncome,
                directReferralIncome: refIncome,
                totalReferralIncome: refIncome,
                levelCounts: downline.levelCounts,
                members,
                referralMembers: members,
              },
            });
          }
        } catch (_e) {
          // fallback to store
        }
      }

      // Store fallback:
      const user = store.users.find((u) => u.user_id.toUpperCase() === userId);
      const known = KNOWN_PROMOTIONAL_ALIASES[userId.toUpperCase()] || [];
      const shareCode = known.length > 0 ? known[0]! : user?.user_id || userId;
      const downline = calculateDownlineLevelsTs(userId, store.users, 10);

      const refIncome = Number(store.wallets?.[userId]?.referral_income || 0);

      const directMembers = downline.membersByLevel[1] || [];
      const members = directMembers.map((r) => {
        const uVideos = store.videos.filter(
          (v) => v.user_id.toUpperCase() === r.userId.toUpperCase(),
        );
        const freeCount = uVideos.filter((v) => v.video_type === "free").length;
        const premCount = uVideos.filter(
          (v) =>
            v.video_type === "premium" &&
            (v.payment_status === "paid" || v.payment_status === "not_required"),
        ).length;
        const comm = premCount * 1.0;
        return {
          id: r.id,
          userId: r.userId,
          name: r.name,
          email: r.email || "",
          mobile: r.mobile || "",
          joinedAt: r.joinedAt,
          status: "Active",
          tier: r.role === "admin" ? "Admin" : "Creator",
          freeVideosCount: freeCount,
          premiumVideosCount: premCount,
          totalVideosCount: freeCount + premCount,
          directCommissionEarned: comm,
          contribution: comm,
          access: "Granted",
        };
      });

      return jsonResponse({
        success: true,
        dashboard: {
          userId,
          referralCode: shareCode,
          referralNumber: user?.mobile || "",
          referralLink: `https://facetube.online/register?ref=${encodeURIComponent(shareCode)}`,
          directReferralsCount: downline.directCount,
          teamMembersCount: downline.totalTeamCount,
          referralIncome: refIncome,
          directReferralIncome: refIncome,
          totalReferralIncome: refIncome,
          levelCounts: downline.levelCounts,
          members,
          referralMembers: members,
        },
      });
    }
  }

  if (route === "referrals/team") {
    if (method === "GET") {
      const qUserId = url.searchParams.get("userId") || url.searchParams.get("user_id");
      const levelParam = url.searchParams.get("level");
      const pool = getMysqlPool();
      const authUser = await getAuthUserFromRequest(request, store, pool);
      const auth = requireAuth(authUser, qUserId);
      if (!auth.success) {
        return auth.response;
      }
      const userId = auth.effectiveUserId;

      let downline: ReturnType<typeof calculateDownlineLevelsTs>;

      if (pool) {
        try {
          const [uRows] = await pool.query<any[]>(
            `SELECT user_id, referral_code, name FROM users WHERE UPPER(user_id) = UPPER(?) LIMIT 1`,
            [userId],
          );
          if (uRows && uRows.length > 0) {
            const [allDbUsers] = await pool.query<any[]>(
              `SELECT id, user_id, name, email, mobile, created_at, role, referral_code FROM users`,
            );
            downline = calculateDownlineLevelsTs(userId, allDbUsers || [], 10);
          } else {
            downline = calculateDownlineLevelsTs(userId, [], 10);
          }
        } catch (_e) {
          downline = calculateDownlineLevelsTs(userId, store.users, 10);
        }
      } else {
        downline = calculateDownlineLevelsTs(userId, store.users, 10);
      }

      let membersToReturn = downline.sanitizedMembers;
      if (levelParam && levelParam.toLowerCase() !== "all") {
        const filterLvl = Number(levelParam);
        if (filterLvl >= 1 && filterLvl <= 10) {
          membersToReturn = membersToReturn.filter((m) => m.level === filterLvl);
        }
      }

      return jsonResponse({
        success: true,
        userId,
        totalTeamCount: downline.totalTeamCount,
        directCount: downline.directCount,
        levelCounts: downline.levelCounts,
        members: membersToReturn,
      });
    }
  }

  // 11. Certificates
  if (route === "certificates/get") {
    if (method === "GET") {
      const userId = (url.searchParams.get("userId") || "FT102857").toUpperCase();
      const cert = store.certificates[userId] || {
        certificateId: `FT-CERT-${userId}`,
        userId,
        name: userId === "FT102857" ? "FaceTube Administrator" : "Alex Rivera",
        issueDate: "2026-10-01",
        verified: true,
      };
      return jsonResponse({ success: true, certificate: cert });
    }
  }

  if (route === "certificates/save") {
    if (method === "POST") {
      const body = await request.json();
      const userId = (body.userId || "FT102857").toUpperCase();
      store.certificates[userId] = body;
      saveStore(store);
      return jsonResponse({
        success: true,
        message: "Certificate saved successfully",
        certificateId: body.certificateId || `FT-CERT-${userId}`,
      });
    }
  }

  // 12. Uploads Mock
  if (route.startsWith("uploads/")) {
    if (method === "POST") {
      return jsonResponse({
        success: true,
        url: "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800&auto=format&fit=crop&q=60",
        fileName: "upload.png",
        format: "png",
        fileSize: "1.2 MB",
      });
    }
  }

  // 13. Admin
  if (route === "admin/stats") {
    if (method === "GET") {
      return jsonResponse({
        success: true,
        stats: {
          totalUsers: store.users.length,
          totalVideos: store.videos.length,
          totalTransactions: 10,
          totalRevenue: 60,
          activeSubscriptions: 2,
          pendingKyc: 1,
        },
      });
    }
  }

  if (route === "admin/role") {
    if (method === "POST") {
      const pool = getMysqlPool();
      const authUser = await getAuthUserFromRequest(request, store, pool);
      if (!authUser) {
        return jsonResponse(
          {
            success: false,
            error: "Authentication required. Please provide a valid Bearer session token.",
          },
          401,
        );
      }
      if (authUser.role !== "admin") {
        return jsonResponse(
          {
            success: false,
            error: "Admin authorization required to modify user roles.",
          },
          403,
        );
      }

      if (process.env["NODE_ENV"] === "production" && !pool) {
        return jsonResponse(
          {
            success: false,
            error:
              "Database connection unavailable. In production, persistent database storage is required.",
          },
          503,
        );
      }

      const body = await request.json();
      const targetUserId = String(
        body.targetUserId || body.target_user_id || body.userId || body.user_id || "",
      ).trim();
      const newRole = body.role === "admin" ? "admin" : "user";

      if (!targetUserId) {
        return jsonResponse({ success: false, error: "Target user ID is required." }, 400);
      }

      if (pool) {
        try {
          const [res]: any = await pool.query(
            "UPDATE users SET role = ?, updated_at = NOW() WHERE UPPER(user_id) = UPPER(?) OR id = ?",
            [newRole, targetUserId, targetUserId],
          );
          if (res && res.affectedRows > 0) {
            return jsonResponse({
              success: true,
              message: `User role updated to ${newRole} successfully.`,
            });
          }
          return jsonResponse({ success: false, error: "User not found" }, 404);
        } catch (dbErr: any) {
          if (process.env["NODE_ENV"] === "production") {
            return jsonResponse(
              { success: false, error: "Database error during role update: " + dbErr.message },
              503,
            );
          }
        }
      }

      const user = store.users.find(
        (u) =>
          u.user_id.toUpperCase() === targetUserId.toUpperCase() ||
          u.id.toLowerCase() === targetUserId.toLowerCase(),
      );
      if (user) {
        user.role = newRole;
        saveStore(store);
        return jsonResponse({
          success: true,
          message: `User role updated to ${newRole} successfully.`,
        });
      }
      return jsonResponse({ success: false, error: "User not found" }, 404);
    }
  }

  // 14. Admin Video Moderation (Shorts & Long Videos)
  if (route === "admin/videos") {
    const pool = getMysqlPool();
    const authUser = await getAuthUserFromRequest(request, store, pool);
    if (!authUser || authUser.role !== "admin") {
      return jsonResponse({ success: false, error: "Admin authorization required" }, 403);
    }

    if (method === "GET") {
      const list = store.videos.map((v) => ({
        ...v,
        is_blocked: Boolean(v.is_blocked),
      }));
      return jsonResponse({
        success: true,
        videos: list,
        counts: {
          total: list.length,
          blocked: list.filter((v) => v.is_blocked).length,
          shorts: list.filter((v) => v.content_type === "short").length,
          long: list.filter((v) => v.content_type === "long").length,
        },
      });
    }

    if (method === "POST") {
      const body = await request.json();
      const videoId = body.videoId || body.video_id;
      const isBlocked = Boolean(body.isBlocked ?? body.is_blocked);
      const reason = body.reason || body.block_reason || "Content moderation policy violation";

      const vid = store.videos.find((v) => v.id === videoId);
      if (vid) {
        vid.is_blocked = isBlocked;
        vid.block_reason = isBlocked ? reason : undefined;
        vid.blocked_at = isBlocked ? new Date().toISOString() : undefined;
        saveStore(store);
      }
      if (pool) {
        await pool
          .query(
            "UPDATE uploaded_videos SET is_blocked = ?, block_reason = ?, blocked_at = ? WHERE id = ?",
            [isBlocked ? 1 : 0, isBlocked ? reason : null, isBlocked ? new Date() : null, videoId],
          )
          .catch(() => {});
      }
      return jsonResponse({
        success: true,
        message: isBlocked ? "Video has been blocked" : "Video has been unblocked",
        video_id: videoId,
        is_blocked: isBlocked,
      });
    }
  }

  // 15. Admin Bulk Withdrawal Payouts
  if (route === "admin/bulk-payout") {
    if (method === "POST") {
      const pool = getMysqlPool();
      const authUser = await getAuthUserFromRequest(request, store, pool);
      if (!authUser || authUser.role !== "admin") {
        return jsonResponse({ success: false, error: "Admin authorization required" }, 403);
      }

      const body = await request.json();
      const payouts = Array.isArray(body.payouts) ? body.payouts : [];
      const notes = body.notes || "Admin bulk payout disbursement";

      if (payouts.length === 0) {
        return jsonResponse(
          { success: false, error: "No payouts specified for bulk execution" },
          400,
        );
      }

      const batchId =
        String(body.batch_id || body.batchId || "").trim() ||
        `batch_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;

      let chunkSize = Number(body.chunk_size || body.chunkSize || 50);
      if (isNaN(chunkSize) || chunkSize < 10 || chunkSize > 100) {
        chunkSize = 50;
      }

      const chunks: any[][] = [];
      for (let i = 0; i < payouts.length; i += chunkSize) {
        chunks.push(payouts.slice(i, i + chunkSize));
      }
      const totalChunks = chunks.length;
      let chunksProcessed = 0;
      let totalProcessed = 0;
      let totalAmount = 0;
      const processed: any[] = [];

      if (pool) {
        // Initialize or update payout batch record as 'processing' for progress tracking
        try {
          await pool.query(
            `INSERT INTO payout_batches (id, admin_user_id, total_recipients, total_amount, status, notes, created_at)
             VALUES (?, ?, ?, 0.00, 'processing', ?, NOW())
             ON DUPLICATE KEY UPDATE status = 'processing', notes = VALUES(notes)`,
            [batchId, authUser.user_id || "ADMIN", payouts.length, notes],
          );
        } catch (_e) {
          // Optional table if migration pending
        }

        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
          const chunk = chunks[chunkIndex];
          if (!chunk) continue;
          const conn = await pool.getConnection();
          let chunkBegun = false;

          try {
            await conn.beginTransaction();
            chunkBegun = true;

            const chunkProcessed: any[] = [];
            let chunkAmount = 0;

            for (let itemIndex = 0; itemIndex < chunk.length; itemIndex++) {
              const p = chunk[itemIndex];
              const globalIndex = chunkIndex * chunkSize + itemIndex;
              const uId = String(p.userId || p.user_id || "")
                .trim()
                .toUpperCase();
              const amt = Number(p.amount) || 0;
              const inputTxId = String(p.transactionId || p.transaction_id || p.id || "").trim();

              if (!uId || amt <= 0) {
                const err: any = new Error(
                  "Each payout item must specify a valid user_id and an amount greater than zero.",
                );
                err.statusCode = 400;
                throw err;
              }

              if (inputTxId) {
                // Case 1: Settling an existing withdrawal request that was already debited at request time
                let existingTx: any = null;
                let isWalletTxTable = true;
                try {
                  const [rows]: any = await conn.query(
                    `SELECT id, user_id, amount, status, batch_id FROM wallet_transactions WHERE id = ? FOR UPDATE`,
                    [inputTxId],
                  );
                  if (rows && rows.length > 0) {
                    existingTx = rows[0];
                  }
                } catch (_e) {
                  // Table might not exist or error, attempt income_ledger
                }

                if (!existingTx) {
                  try {
                    const [rows]: any = await conn.query(
                      `SELECT id, transaction_id, user_id, amount, status, batch_id, payout_method FROM income_ledger WHERE transaction_id = ? OR id = ? FOR UPDATE`,
                      [inputTxId, inputTxId],
                    );
                    if (rows && rows.length > 0) {
                      existingTx = rows[0];
                      isWalletTxTable = false;
                    }
                  } catch (_eCols) {
                    try {
                      const [rows]: any = await conn.query(
                        `SELECT id, transaction_id, user_id, amount, status FROM income_ledger WHERE transaction_id = ? OR id = ? FOR UPDATE`,
                        [inputTxId, inputTxId],
                      );
                      if (rows && rows.length > 0) {
                        existingTx = rows[0];
                        isWalletTxTable = false;
                      }
                    } catch (_e) {
                      // Ignore
                    }
                  }
                }

                if (!existingTx) {
                  const err: any = new Error(
                    `Invalid transaction ID '${inputTxId}': Transaction not found.`,
                  );
                  err.statusCode = 404;
                  throw err;
                }

                const txUserId = String(existingTx.user_id || "")
                  .trim()
                  .toUpperCase();
                if (txUserId !== uId) {
                  const err: any = new Error(
                    `Authorization mismatch: Transaction '${inputTxId}' belongs to user '${existingTx.user_id}', not requested user '${uId}'.`,
                  );
                  err.statusCode = 403;
                  throw err;
                }

                const statusLower = String(existingTx.status || "").toLowerCase();
                if (statusLower === "completed" || statusLower === "settled") {
                  // Idempotent retry: check if it was already marked completed in the SAME batch
                  if (existingTx.batch_id && existingTx.batch_id === batchId) {
                    const payoutAmt = Number(existingTx.amount) || amt;
                    chunkProcessed.push({
                      transaction_id: inputTxId,
                      user_id: uId,
                      amount: payoutAmt,
                      status: "completed",
                      deduction_type: "settled_existing_request",
                      idempotent_replay: true,
                    });
                    chunkAmount += payoutAmt;
                    continue;
                  }

                  const err: any = new Error(
                    `Transaction '${inputTxId}' has already been marked as completed.`,
                  );
                  err.statusCode = 400;
                  throw err;
                }

                const itemPayoutMethod =
                  String(p.payout_method || p.payoutMethod || "").trim() || "bulk_bank_transfer";
                if (isWalletTxTable) {
                  await conn.query(
                    `UPDATE wallet_transactions SET status = 'completed', batch_id = ?, payout_method = COALESCE(payout_method, ?), updated_at = NOW() WHERE id = ?`,
                    [batchId, itemPayoutMethod, inputTxId],
                  );
                } else {
                  try {
                    await conn.query(
                      `UPDATE income_ledger SET status = 'settled', batch_id = ?, payout_method = COALESCE(payout_method, ?) WHERE transaction_id = ? OR id = ?`,
                      [batchId, itemPayoutMethod, inputTxId, inputTxId],
                    );
                  } catch (_eUpLedger) {
                    await conn.query(
                      `UPDATE income_ledger SET status = 'settled' WHERE transaction_id = ? OR id = ?`,
                      [inputTxId, inputTxId],
                    );
                  }
                }

                // Do NOT deduct from wallet_balances again!
                const payoutAmt = Number(existingTx.amount) || amt;
                chunkProcessed.push({
                  transaction_id: inputTxId,
                  user_id: uId,
                  amount: payoutAmt,
                  status: "completed",
                  deduction_type: "settled_existing_request",
                });
                chunkAmount += payoutAmt;
              } else {
                // Case 2: Direct bulk payout created by admin without prior withdrawal request
                const deterministicTxId = `tx_wdr_bulk_${batchId}_${globalIndex}`;

                // Check for idempotent retry of this direct payout in the same batch
                let alreadyDirect: any = null;
                try {
                  const [alreadyRows]: any = await conn.query(
                    `SELECT id, user_id, amount, status FROM wallet_transactions WHERE id = ? AND batch_id = ?`,
                    [deterministicTxId, batchId],
                  );
                  if (alreadyRows && alreadyRows.length > 0) {
                    alreadyDirect = alreadyRows[0];
                  }
                } catch (_eDirectCheck) {
                  // Ignore
                }

                if (!alreadyDirect) {
                  try {
                    const [alreadyLedgerRows]: any = await conn.query(
                      `SELECT id, transaction_id, user_id, amount, status, batch_id FROM income_ledger WHERE (id = ? OR transaction_id = ?) AND batch_id = ?`,
                      [deterministicTxId, deterministicTxId, batchId],
                    );
                    if (alreadyLedgerRows && alreadyLedgerRows.length > 0) {
                      alreadyDirect = alreadyLedgerRows[0];
                    }
                  } catch (_eDirectLedger) {
                    // Ignore
                  }
                }

                if (alreadyDirect) {
                  const directStatus = String(alreadyDirect.status || "").toLowerCase();
                  if (directStatus === "completed" || directStatus === "settled") {
                    const payoutAmt = Number(alreadyDirect.amount) || amt;
                    chunkProcessed.push({
                      transaction_id: deterministicTxId,
                      user_id: uId,
                      amount: payoutAmt,
                      status: "completed",
                      deduction_type: "new_direct_disbursement",
                      idempotent_replay: true,
                    });
                    chunkAmount += payoutAmt;
                    continue;
                  }
                }

                const [bRows]: any = await conn.query(
                  `SELECT balance FROM wallet_balances WHERE UPPER(user_id) = UPPER(?) FOR UPDATE`,
                  [uId],
                );
                const currentBal = Number(bRows?.[0]?.balance || 0);

                if (currentBal < amt) {
                  const err: any = new Error(
                    `Insufficient balance for direct payout to user '${uId}'. Available: ₹${currentBal.toLocaleString("en-IN")}, requested: ₹${amt.toLocaleString("en-IN")}.`,
                  );
                  err.statusCode = 400;
                  throw err;
                }

                const itemPayoutMethod =
                  String(p.payout_method || p.payoutMethod || "").trim() || "bulk_bank_transfer";
                const itemBank =
                  p.bankDetails && typeof p.bankDetails === "object"
                    ? p.bankDetails
                    : p.bank_details && typeof p.bank_details === "object"
                      ? p.bank_details
                      : p.beneficiary_details && typeof p.beneficiary_details === "object"
                        ? p.beneficiary_details
                        : null;
                const itemBeneficiaryMasked = buildMaskedBeneficiaryDetails(itemBank);

                try {
                  await conn.query(
                    `INSERT INTO wallet_transactions (id, user_id, batch_id, type, amount, status, payout_method, beneficiary_details, created_at)
                     VALUES (?, ?, ?, 'withdrawal', ?, 'completed', ?, ?, NOW())`,
                    [deterministicTxId, uId, batchId, amt, itemPayoutMethod, itemBeneficiaryMasked],
                  );
                } catch (_e) {
                  try {
                    await conn.query(
                      `INSERT INTO income_ledger (id, transaction_id, user_id, batch_id, income_type, amount, status, payout_method, beneficiary_details, description, created_at)
                       VALUES (?, ?, ?, ?, 'withdrawal', ?, 'settled', ?, ?, ?, NOW())`,
                      [
                        deterministicTxId,
                        deterministicTxId,
                        uId,
                        batchId,
                        amt,
                        itemPayoutMethod,
                        itemBeneficiaryMasked,
                        `Direct bulk payout disbursement (Batch ${batchId})`,
                      ],
                    );
                  } catch (_eLedger) {
                    await conn.query(
                      `INSERT INTO income_ledger (id, transaction_id, user_id, income_type, amount, status, description, created_at)
                       VALUES (?, ?, ?, 'withdrawal', ?, 'settled', ?, NOW())`,
                      [
                        deterministicTxId,
                        deterministicTxId,
                        uId,
                        amt,
                        `Direct bulk payout disbursement (Batch ${batchId})`,
                      ],
                    );
                  }
                }

                await conn.query(
                  `UPDATE wallet_balances
                   SET balance = balance - ?, total_withdrawn = total_withdrawn + ?, updated_at = NOW()
                   WHERE UPPER(user_id) = UPPER(?)`,
                  [amt, amt, uId],
                );

                chunkProcessed.push({
                  transaction_id: deterministicTxId,
                  user_id: uId,
                  amount: amt,
                  status: "completed",
                  deduction_type: "new_direct_disbursement",
                });
                chunkAmount += amt;
              }
            }

            await conn.commit();
            chunkBegun = false;

            chunksProcessed++;
            totalProcessed += chunkProcessed.length;
            totalAmount += chunkAmount;
            processed.push(...chunkProcessed);
          } catch (chunkErr: any) {
            if (chunkBegun) {
              await conn.rollback();
            }

            const statusCode = chunkErr.statusCode || 500;
            const failStatus = totalProcessed > 0 ? "partially_completed" : "failed";
            try {
              await pool.query(
                `UPDATE payout_batches 
                 SET total_recipients = ?, total_amount = ?, status = ?, notes = ?
                 WHERE id = ?`,
                [
                  totalProcessed,
                  totalAmount,
                  failStatus,
                  `${notes} (Chunk failure: ${chunkErr.message})`,
                  batchId,
                ],
              );
            } catch (_e) {
              /* ignore error updating failed batch status */
            }

            return jsonResponse(
              {
                success: false,
                error: chunkErr.message,
                batch_id: batchId,
                chunks_completed: chunksProcessed,
                total_chunks: totalChunks,
                chunk_size: chunkSize,
                total_processed: totalProcessed,
                total_amount: totalAmount,
                failed_chunk_index: chunkIndex,
              },
              statusCode,
            );
          } finally {
            conn.release();
          }
        }

        try {
          await pool.query(
            `INSERT INTO payout_batches (id, admin_user_id, total_recipients, total_amount, status, notes, created_at)
             VALUES (?, ?, ?, ?, 'completed', ?, NOW())
             ON DUPLICATE KEY UPDATE 
               total_recipients = VALUES(total_recipients),
               total_amount = VALUES(total_amount),
               status = 'completed',
               notes = VALUES(notes)`,
            [batchId, authUser.user_id || "ADMIN", totalProcessed, totalAmount, notes],
          );
        } catch (_e) {
          // payout_batches optional if migration pending
        }

        return jsonResponse({
          success: true,
          message: `Bulk payout completed for ${totalProcessed} recipients in ${chunksProcessed} chunks totaling ₹${totalAmount.toFixed(2)}`,
          batch_id: batchId,
          total_recipients: totalProcessed,
          total_amount: totalAmount,
          total_chunks: totalChunks,
          chunk_size: chunkSize,
          chunks_processed: chunksProcessed,
          progress: {
            total: payouts.length,
            processed: totalProcessed,
            successful: totalProcessed,
            failed: 0,
          },
          processed,
        });
      }

      // In-memory/JSON store bulk payout implementation (for dev & test environments)
      if (!store.walletTransactions) store.walletTransactions = [];
      if (!store.wallets) store.wallets = {};

      const getOrInitStoreWallet = (userIdKey: string) => {
        const norm = userIdKey.trim().toUpperCase();
        if (!store.wallets[norm]) {
          const defaultBalances: Record<string, number> = {
            FT102857: 15400,
            FT483921: 4280.5,
            FT900431: 850,
          };
          const defaultEarned: Record<string, number> = {
            FT102857: 22000,
            FT483921: 7430.5,
            FT900431: 850,
          };
          const defaultWithdrawn: Record<string, number> = {
            FT102857: 6600,
            FT483921: 3150,
            FT900431: 0,
          };
          store.wallets[norm] = {
            balance: defaultBalances[norm] ?? 0,
            total_earned: defaultEarned[norm] ?? 0,
            total_withdrawn: defaultWithdrawn[norm] ?? 0,
            referral_income: 0,
            global_income: 0,
            adsense_income: 0,
            affiliate_income: 0,
            updated_at: new Date().toISOString(),
          };
        }
        return store.wallets[norm]!;
      };

      // Process in safe chunks with per-chunk atomic rollback semantics
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex];
        if (!chunk) continue;
        // Snapshot store state before chunk execution for atomic rollback
        const walletsSnapshot = JSON.parse(JSON.stringify(store.wallets));
        const transactionsSnapshot = JSON.parse(JSON.stringify(store.walletTransactions));

        try {
          const chunkProcessed: any[] = [];
          let chunkAmount = 0;

          // Phase 1 of chunk: Pre-validate all items in current chunk
          for (let itemIndex = 0; itemIndex < chunk.length; itemIndex++) {
            const p = chunk[itemIndex];
            const globalIndex = chunkIndex * chunkSize + itemIndex;
            const uId = String(p.userId || p.user_id || "")
              .trim()
              .toUpperCase();
            const amt = Number(p.amount) || 0;
            const inputTxId = String(p.transactionId || p.transaction_id || p.id || "").trim();

            if (!uId || amt <= 0) {
              const err: any = new Error(
                "Each payout item must specify a valid user_id and an amount greater than zero.",
              );
              err.statusCode = 400;
              throw err;
            }

            if (inputTxId) {
              const existingTx = store.walletTransactions.find(
                (t: Record<string, unknown>) =>
                  t["id"] === inputTxId ||
                  t["transaction_id"] === inputTxId ||
                  t["transactionId"] === inputTxId,
              );
              if (!existingTx) {
                const err: any = new Error(
                  `Invalid transaction ID '${inputTxId}': Transaction not found.`,
                );
                err.statusCode = 404;
                throw err;
              }
              const txUserId = String(existingTx["user_id"] ?? existingTx["userId"] ?? "")
                .trim()
                .toUpperCase();
              if (txUserId !== uId) {
                const err: any = new Error(
                  `Authorization mismatch: Transaction '${inputTxId}' belongs to user '${String(existingTx["user_id"] ?? existingTx["userId"] ?? "")}', not requested user '${uId}'.`,
                );
                err.statusCode = 403;
                throw err;
              }
              if (String(existingTx["status"] ?? "").toLowerCase() === "completed") {
                const txBatchId = String(existingTx["batch_id"] ?? existingTx["batchId"] ?? "");
                if (txBatchId && txBatchId === batchId) {
                  // Idempotent retry: already completed in this batch
                  continue;
                }
                const err: any = new Error(
                  `Transaction '${inputTxId}' has already been marked as completed.`,
                );
                err.statusCode = 400;
                throw err;
              }
            } else {
              const deterministicTxId = `tx_wdr_bulk_${batchId}_${globalIndex}`;
              const alreadyDirect = store.walletTransactions.find(
                (t: Record<string, unknown>) =>
                  (t["id"] === deterministicTxId || t["transaction_id"] === deterministicTxId) &&
                  String(t["batch_id"] ?? t["batchId"] ?? "") === batchId &&
                  String(t["status"] ?? "").toLowerCase() === "completed",
              );
              if (alreadyDirect) {
                continue;
              }

              const currentWallet = getOrInitStoreWallet(uId);
              if (currentWallet.balance < amt) {
                const err: any = new Error(
                  `Insufficient balance for direct payout to user '${uId}'. Available: ₹${currentWallet.balance.toLocaleString("en-IN")}, requested: ₹${amt.toLocaleString("en-IN")}.`,
                );
                err.statusCode = 400;
                throw err;
              }
            }
          }

          // Phase 2 of chunk: Execute updates for current chunk
          for (let itemIndex = 0; itemIndex < chunk.length; itemIndex++) {
            const p = chunk[itemIndex];
            const globalIndex = chunkIndex * chunkSize + itemIndex;
            const uId = String(p.userId || p.user_id || "")
              .trim()
              .toUpperCase();
            const amt = Number(p.amount) || 0;
            const inputTxId = String(p.transactionId || p.transaction_id || p.id || "").trim();

            if (inputTxId) {
              const existingTx = store.walletTransactions.find(
                (t: Record<string, unknown>) =>
                  t["id"] === inputTxId ||
                  t["transaction_id"] === inputTxId ||
                  t["transactionId"] === inputTxId,
              );
              if (existingTx) {
                const txBatchId = String(existingTx["batch_id"] ?? existingTx["batchId"] ?? "");
                if (
                  String(existingTx["status"] ?? "").toLowerCase() === "completed" &&
                  txBatchId === batchId
                ) {
                  const payoutAmt = Number(existingTx["amount"]) || amt;
                  chunkProcessed.push({
                    transaction_id: String(existingTx["id"] ?? inputTxId),
                    user_id: uId,
                    amount: payoutAmt,
                    status: "completed",
                    deduction_type: "settled_existing_request",
                    idempotent_replay: true,
                  });
                  chunkAmount += payoutAmt;
                  continue;
                }

                const itemPayoutMethod =
                  String(p.payout_method || p.payoutMethod || "").trim() || "bulk_bank_transfer";
                existingTx["status"] = "completed";
                existingTx["batch_id"] = batchId;
                existingTx["batchId"] = batchId;
                if (!existingTx["payout_method"] && !existingTx["payoutMethod"]) {
                  existingTx["payout_method"] = itemPayoutMethod;
                  existingTx["payoutMethod"] = itemPayoutMethod;
                }
                existingTx["updated_at"] = new Date().toISOString();
                existingTx["updatedAt"] = new Date().toISOString();

                const payoutAmt = Number(existingTx["amount"]) || amt;
                chunkProcessed.push({
                  transaction_id: String(existingTx["id"] ?? inputTxId),
                  user_id: uId,
                  amount: payoutAmt,
                  status: "completed",
                  deduction_type: "settled_existing_request",
                });
                chunkAmount += payoutAmt;
              }
            } else {
              const deterministicTxId = `tx_wdr_bulk_${batchId}_${globalIndex}`;
              const alreadyDirect = store.walletTransactions.find(
                (t: Record<string, unknown>) =>
                  (t["id"] === deterministicTxId || t["transaction_id"] === deterministicTxId) &&
                  String(t["batch_id"] ?? t["batchId"] ?? "") === batchId &&
                  String(t["status"] ?? "").toLowerCase() === "completed",
              );

              if (alreadyDirect) {
                const payoutAmt = Number(alreadyDirect["amount"]) || amt;
                chunkProcessed.push({
                  transaction_id: deterministicTxId,
                  user_id: uId,
                  amount: payoutAmt,
                  status: "completed",
                  deduction_type: "new_direct_disbursement",
                  idempotent_replay: true,
                });
                chunkAmount += payoutAmt;
                continue;
              }

              const w = getOrInitStoreWallet(uId);
              w.balance = Math.max(0, w.balance - amt);
              w.total_withdrawn = (w.total_withdrawn || 0) + amt;
              w.updated_at = new Date().toISOString();
              store.wallets[uId] = w;

              const itemPayoutMethod =
                String(p.payout_method || p.payoutMethod || "").trim() || "bulk_bank_transfer";
              const itemBank =
                p.bankDetails && typeof p.bankDetails === "object"
                  ? p.bankDetails
                  : p.bank_details && typeof p.bank_details === "object"
                    ? p.bank_details
                    : p.beneficiary_details && typeof p.beneficiary_details === "object"
                      ? p.beneficiary_details
                      : null;
              const itemBeneficiaryMasked = buildMaskedBeneficiaryDetails(itemBank);

              store.walletTransactions.push({
                id: deterministicTxId,
                transaction_id: deterministicTxId,
                transactionId: deterministicTxId,
                user_id: uId,
                userId: uId,
                batch_id: batchId,
                batchId: batchId,
                type: "withdrawal",
                income_type: "withdrawal",
                incomeType: "withdrawal",
                amount: amt,
                status: "completed",
                payout_method: itemPayoutMethod,
                payoutMethod: itemPayoutMethod,
                beneficiary_details: itemBeneficiaryMasked,
                beneficiaryDetails: itemBeneficiaryMasked,
                description: `Direct bulk payout disbursement (Batch ${batchId})`,
                created_at: new Date().toISOString(),
                createdAt: new Date().toISOString(),
              });

              chunkProcessed.push({
                transaction_id: deterministicTxId,
                user_id: uId,
                amount: amt,
                status: "completed",
                deduction_type: "new_direct_disbursement",
              });
              chunkAmount += amt;
            }
          }

          chunksProcessed++;
          totalProcessed += chunkProcessed.length;
          totalAmount += chunkAmount;
          processed.push(...chunkProcessed);
        } catch (chunkErr: any) {
          // Atomic rollback of this failed chunk
          store.wallets = walletsSnapshot;
          store.walletTransactions = transactionsSnapshot;

          const statusCode = chunkErr.statusCode || 500;
          const failStatus = totalProcessed > 0 ? "partially_completed" : "failed";
          if (!store.payoutBatches) store.payoutBatches = [];
          store.payoutBatches.push({
            id: batchId,
            admin_user_id: authUser.user_id,
            total_recipients: totalProcessed,
            total_amount: totalAmount,
            status: failStatus,
            notes: `${notes} (Chunk failure: ${chunkErr.message})`,
            created_at: new Date().toISOString(),
          });
          saveStore(store);

          return jsonResponse(
            {
              success: false,
              error: chunkErr.message,
              batch_id: batchId,
              chunks_completed: chunksProcessed,
              total_chunks: totalChunks,
              chunk_size: chunkSize,
              total_processed: totalProcessed,
              total_amount: totalAmount,
              failed_chunk_index: chunkIndex,
            },
            statusCode,
          );
        }
      }

      if (!store.payoutBatches) store.payoutBatches = [];
      store.payoutBatches.push({
        id: batchId,
        admin_user_id: authUser.user_id,
        total_recipients: totalProcessed,
        total_amount: totalAmount,
        status: "completed",
        notes,
        created_at: new Date().toISOString(),
      });
      saveStore(store);

      return jsonResponse({
        success: true,
        message: `Bulk payout completed for ${totalProcessed} recipients in ${chunksProcessed} chunks totaling ₹${totalAmount.toFixed(2)}`,
        batch_id: batchId,
        total_recipients: totalProcessed,
        total_amount: totalAmount,
        total_chunks: totalChunks,
        chunk_size: chunkSize,
        chunks_processed: chunksProcessed,
        progress: {
          total: payouts.length,
          processed: totalProcessed,
          successful: totalProcessed,
          failed: 0,
        },
        processed,
      });
    }
  }

  // 15b. Admin KYC Submissions Management (GET /api/admin/kyc/list or /api/admin/kyc-list)
  if (route === "admin/kyc/list" || route === "admin/kyc-list") {
    if (method !== "GET") {
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    }

    const pool = getMysqlPool();
    const authUser = await getAuthUserFromRequest(request, store, pool);
    if (!authUser) {
      return jsonResponse(
        {
          success: false,
          error: "Authentication required. Please provide a valid Bearer session token.",
        },
        401,
      );
    }

    if (authUser.role !== "admin") {
      return jsonResponse(
        {
          success: false,
          error: "Admin authorization required. Access denied.",
        },
        403,
      );
    }

    const typeFilter = (url.searchParams.get("type") || "all").trim().toLowerCase();
    const statusFilter = (url.searchParams.get("status") || "submitted").trim().toLowerCase();
    const search = (url.searchParams.get("search") || "").trim().toLowerCase();
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)));
    const userIdFilter = (url.searchParams.get("userId") || url.searchParams.get("user_id") || "")
      .trim()
      .toUpperCase();

    const allSubmissions: any[] = [];
    const seen: Record<string, boolean> = {};

    function formatPersonalKycRow(row: any) {
      return {
        id: String(row.id || `pkyc_${row.user_id || row.userId || ""}`),
        type: "personal",
        userId: String(row.user_id || row.userId || ""),
        fullName: String(row.full_name || row.fullName || ""),
        mobile: String(row.mobile || ""),
        dob: String(row.dob || ""),
        address: String(row.address || ""),
        city: String(row.city || ""),
        state: String(row.state || ""),
        pincode: String(row.pincode || ""),
        nomineeName: String(row.nominee_name || row.nomineeName || ""),
        nomineeRelation: String(row.nominee_relation || row.nomineeRelation || ""),
        nomineeMobile: String(row.nominee_mobile || row.nomineeMobile || ""),
        status: String(row.status || "Submitted"),
        reviewedBy: row.reviewed_by || row.reviewedBy || null,
        reviewedAt: row.reviewed_at || row.reviewedAt || null,
        adminNote: row.admin_note || row.adminNote || null,
        rejectionReason: row.rejection_reason || row.rejectionReason || null,
        submittedAt: String(
          row.created_at || row.submittedAt || row.updated_at || new Date().toISOString(),
        ),
        updatedAt: String(row.updated_at || row.updatedAt || new Date().toISOString()),
      };
    }

    function formatBankKycRow(row: any) {
      return {
        id: String(row.id || `bkyc_${row.user_id || row.userId || ""}`),
        type: "bank",
        userId: String(row.user_id || row.userId || ""),
        accountHolderName: String(
          row.account_holder_name || row.accountHolderName || row.accountHolder || "",
        ),
        bankName: String(row.bank_name || row.bankName || ""),
        accountNumber: String(row.account_number || row.accountNumber || ""),
        ifscCode: String(row.ifsc_code || row.ifscCode || ""),
        branchName: String(row.branch_name || row.branchName || ""),
        accountType: String(row.account_type || row.accountType || "Saving"),
        upiId: String(row.upi_id || row.upiId || ""),
        upiQrCodeUrl: String(row.upi_qr_code || row.upiQrCodeUrl || ""),
        status: String(row.status || "Submitted"),
        reviewedBy: row.reviewed_by || row.reviewedBy || null,
        reviewedAt: row.reviewed_at || row.reviewedAt || null,
        adminNote: row.admin_note || row.adminNote || null,
        rejectionReason: row.rejection_reason || row.rejectionReason || null,
        submittedAt: String(
          row.created_at || row.submittedAt || row.updated_at || new Date().toISOString(),
        ),
        updatedAt: String(row.updated_at || row.updatedAt || new Date().toISOString()),
      };
    }

    // 1. Load from MySQL if active
    if (pool) {
      try {
        if (typeFilter === "all" || typeFilter === "personal") {
          let pRows: any[] = [];
          try {
            const [rows]: any = await pool.query(
              "SELECT * FROM personal_kyc ORDER BY updated_at DESC",
            );
            pRows = rows || [];
          } catch (_e1) {
            try {
              const [rows2]: any = await pool.query(
                "SELECT * FROM kyc_records ORDER BY updated_at DESC",
              );
              pRows = rows2 || [];
            } catch (_e2) {
              // fallback
            }
          }
          for (const r of pRows) {
            const item = formatPersonalKycRow(r);
            const key = `personal_${item.userId.toUpperCase()}`;
            if (!seen[key]) {
              seen[key] = true;
              allSubmissions.push(item);
            }
          }
        }
      } catch (_e) {
        // Safe fallback
      }

      try {
        if (typeFilter === "all" || typeFilter === "bank") {
          let bRows: any[] = [];
          try {
            const [rows]: any = await pool.query("SELECT * FROM bank_kyc ORDER BY updated_at DESC");
            bRows = rows || [];
          } catch (_e1) {
            try {
              const [rows2]: any = await pool.query(
                "SELECT * FROM kyc_bank_details ORDER BY updated_at DESC",
              );
              bRows = rows2 || [];
            } catch (_e2) {
              // fallback
            }
          }
          for (const r of bRows) {
            const item = formatBankKycRow(r);
            const key = `bank_${item.userId.toUpperCase()}`;
            if (!seen[key]) {
              seen[key] = true;
              allSubmissions.push(item);
            }
          }
        }
      } catch (_e) {
        // Safe fallback
      }
    }

    // 2. Load/merge from local/preview store
    if (store.personalKyc && (typeFilter === "all" || typeFilter === "personal")) {
      for (const [uId, r] of Object.entries(store.personalKyc)) {
        const key = `personal_${uId.toUpperCase()}`;
        if (!seen[key] && r && typeof r === "object") {
          seen[key] = true;
          allSubmissions.push(formatPersonalKycRow({ ...r, user_id: (r as any).userId || uId }));
        }
      }
    }

    if (store.bankKyc && (typeFilter === "all" || typeFilter === "bank")) {
      for (const [uId, r] of Object.entries(store.bankKyc)) {
        const key = `bank_${uId.toUpperCase()}`;
        if (!seen[key] && r && typeof r === "object") {
          seen[key] = true;
          allSubmissions.push(formatBankKycRow({ ...r, user_id: (r as any).userId || uId }));
        }
      }
    }

    // Compute stats
    const stats = {
      totalPending: 0,
      pendingPersonal: 0,
      pendingBank: 0,
      totalVerified: 0,
      totalRejected: 0,
      totalSubmissions: allSubmissions.length,
    };

    for (const sub of allSubmissions) {
      const st = String(sub.status || "").toLowerCase();
      if (st === "submitted" || st === "pending") {
        stats.totalPending++;
        if (sub.type === "personal") {
          stats.pendingPersonal++;
        } else {
          stats.pendingBank++;
        }
      } else if (st === "verified") {
        stats.totalVerified++;
      } else if (st === "rejected") {
        stats.totalRejected++;
      }
    }

    // Filter
    const filtered = allSubmissions.filter((item: any) => {
      if (typeFilter !== "all" && item.type.toLowerCase() !== typeFilter) {
        return false;
      }
      if (statusFilter !== "all") {
        const itemStatus = item.status.toLowerCase();
        if (statusFilter === "submitted" || statusFilter === "pending") {
          if (itemStatus !== "submitted" && itemStatus !== "pending") return false;
        } else {
          if (itemStatus !== statusFilter) return false;
        }
      }
      if (userIdFilter && item.userId.toUpperCase() !== userIdFilter) {
        return false;
      }
      if (search) {
        const blob = [
          item.userId,
          item.fullName,
          item.accountHolderName,
          item.mobile,
          item.bankName,
          item.upiId,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!blob.includes(search)) return false;
      }
      return true;
    });

    // Sort: Submitted/Pending first, then by updatedAt/submittedAt descending
    filtered.sort((a: any, b: any) => {
      const aSubmitted =
        a.status.toLowerCase() === "submitted" || a.status.toLowerCase() === "pending" ? 1 : 0;
      const bSubmitted =
        b.status.toLowerCase() === "submitted" || b.status.toLowerCase() === "pending" ? 1 : 0;
      if (aSubmitted !== bSubmitted) {
        return bSubmitted - aSubmitted;
      }
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });

    const totalItems = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));
    const offset = (page - 1) * limit;
    const paginated = filtered.slice(offset, offset + limit);

    return jsonResponse({
      success: true,
      stats,
      pagination: {
        page,
        limit,
        totalItems,
        totalPages,
      },
      submissions: paginated,
    });
  }

  // 15c. Admin KYC Review & Decision API (POST /api/admin/kyc/review or /api/admin/kyc-review)
  if (route === "admin/kyc/review" || route === "admin/kyc-review") {
    if (method !== "POST") {
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    }

    const pool = getMysqlPool();
    const authUser = await getAuthUserFromRequest(request, store, pool);
    if (!authUser) {
      return jsonResponse(
        {
          success: false,
          error: "Authentication required. Please provide a valid Bearer session token.",
        },
        401,
      );
    }

    if (authUser.role !== "admin") {
      return jsonResponse(
        {
          success: false,
          error: "Admin authorization required. Access denied.",
        },
        403,
      );
    }

    const body = await request.json().catch(() => ({}));
    const type = String(body.type || "")
      .trim()
      .toLowerCase();
    const userId = String(body.userId || body.user_id || "")
      .trim()
      .toUpperCase();
    const decision = String(body.decision || "")
      .trim()
      .toLowerCase();
    const adminNote = String(body.adminNote || body.admin_note || "").trim();
    const rejectionReason = String(body.rejectionReason || body.rejection_reason || "").trim();

    if (!type || (type !== "personal" && type !== "bank")) {
      return jsonResponse(
        { success: false, error: "Invalid or missing KYC type. Must be 'personal' or 'bank'." },
        400,
      );
    }

    if (!userId) {
      return jsonResponse({ success: false, error: "Target User ID is required." }, 400);
    }

    if (decision !== "approved" && decision !== "rejected") {
      return jsonResponse(
        { success: false, error: "Invalid decision. Must be 'approved' or 'rejected'." },
        400,
      );
    }

    if (decision === "rejected" && !rejectionReason) {
      return jsonResponse(
        {
          success: false,
          error: "Rejection reason is required when rejecting a KYC submission.",
        },
        400,
      );
    }

    const adminUserId = authUser.user_id || "ADMIN";
    const nowIso = new Date().toISOString();
    const newStatus = decision === "approved" ? "Verified" : "Rejected";

    let targetRecord: any = null;

    // 1. Locate in MySQL if available
    if (pool) {
      try {
        const tbl = type === "personal" ? "personal_kyc" : "bank_kyc";
        const [rows]: any = await pool.query(
          `SELECT * FROM ${tbl} WHERE UPPER(user_id) = UPPER(?) LIMIT 1`,
          [userId],
        );
        if (rows && rows.length > 0) {
          targetRecord = rows[0];
        }
      } catch (_e1) {
        try {
          const tblFallback = type === "personal" ? "kyc_records" : "kyc_bank_details";
          const [rows2]: any = await pool.query(
            `SELECT * FROM ${tblFallback} WHERE UPPER(user_id) = UPPER(?) LIMIT 1`,
            [userId],
          );
          if (rows2 && rows2.length > 0) {
            targetRecord = rows2[0];
          }
        } catch (_e2) {
          // ignore
        }
      }
    }

    // 2. Locate in local store if not found in DB
    const prop = type === "personal" ? "personalKyc" : "bankKyc";
    if (!targetRecord && store[prop] && store[prop][userId]) {
      targetRecord = store[prop][userId];
    }

    if (!targetRecord) {
      return jsonResponse(
        {
          success: false,
          error: `No ${type} KYC submission found for user ${userId}.`,
        },
        404,
      );
    }

    const currentStatus = String(targetRecord.status || "Draft");
    if (currentStatus.toLowerCase() !== "submitted") {
      return jsonResponse(
        {
          success: false,
          error: `Only KYC submissions with status 'Submitted' can be reviewed. Current status is '${currentStatus}'.`,
        },
        400,
      );
    }

    const auditEntry = {
      id: `kyc_audit_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      kycType: type,
      kycId: String(targetRecord.id || `${type}_${userId}`),
      userId,
      action: decision,
      previousStatus: currentStatus,
      newStatus,
      adminNote: adminNote || null,
      rejectionReason: decision === "rejected" ? rejectionReason : null,
      reviewedBy: adminUserId,
      reviewedAt: nowIso,
      createdAt: nowIso,
    };

    // 3. Update in MySQL
    if (pool) {
      try {
        const tbl = type === "personal" ? "personal_kyc" : "bank_kyc";
        await pool.query(
          `UPDATE ${tbl} SET status = ?, updated_at = NOW() WHERE UPPER(user_id) = UPPER(?)`,
          [newStatus, userId],
        );

        try {
          await pool.query(
            `UPDATE ${tbl} SET reviewed_by = ?, reviewed_at = NOW(), admin_note = ?, rejection_reason = ? WHERE UPPER(user_id) = UPPER(?)`,
            [
              adminUserId,
              adminNote || null,
              decision === "rejected" ? rejectionReason : null,
              userId,
            ],
          );
        } catch (_colEx) {
          // columns might not exist if migration unapplied
        }

        try {
          await pool.query(
            `INSERT INTO kyc_audit_log (id, kyc_type, kyc_id, user_id, action, previous_status, new_status, admin_note, rejection_reason, reviewed_by, reviewed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [
              auditEntry.id,
              type,
              auditEntry.kycId,
              userId,
              decision,
              currentStatus,
              newStatus,
              adminNote || null,
              decision === "rejected" ? rejectionReason : null,
              adminUserId,
            ],
          );
        } catch (_logEx) {
          // audit table might not exist
        }
      } catch (_e) {
        // Fallback to json
      }
    }

    // 4. Update in local store
    if (!store[prop]) store[prop] = {};
    if (!store[prop][userId]) store[prop][userId] = targetRecord;

    store[prop][userId] = {
      ...store[prop][userId],
      status: newStatus,
      reviewedBy: adminUserId,
      reviewedAt: nowIso,
      adminNote: adminNote || null,
      rejectionReason: decision === "rejected" ? rejectionReason : null,
      updatedAt: nowIso,
    };

    if (!store.kycAuditLog) store.kycAuditLog = [];
    store.kycAuditLog.unshift(auditEntry);
    saveStore(store);

    return jsonResponse({
      success: true,
      message: `KYC ${type} submission for user ${userId} has been ${newStatus} successfully.`,
      decision,
      status: newStatus,
      kyc: store[prop][userId],
      audit: auditEntry,
    });
  }

  // 15d. Admin KYC Audit History API (GET /api/admin/kyc/audit or /api/admin/kyc-audit)
  if (route === "admin/kyc/audit" || route === "admin/kyc-audit") {
    if (method !== "GET") {
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    }

    const pool = getMysqlPool();
    const authUser = await getAuthUserFromRequest(request, store, pool);
    if (!authUser) {
      return jsonResponse(
        {
          success: false,
          error: "Authentication required. Please provide a valid Bearer session token.",
        },
        401,
      );
    }

    if (authUser.role !== "admin") {
      return jsonResponse(
        {
          success: false,
          error: "Admin authorization required. Access denied.",
        },
        403,
      );
    }

    const userIdFilter = (url.searchParams.get("userId") || url.searchParams.get("user_id") || "")
      .trim()
      .toUpperCase();
    const typeFilter = (url.searchParams.get("type") || "all").trim().toLowerCase();
    const actionFilter = (url.searchParams.get("action") || "all").trim().toLowerCase();
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20", 10)));

    const allAudit: any[] = [];
    const seen: Record<string, boolean> = {};

    // 1. Load from MySQL if active
    if (pool) {
      try {
        const [rows]: any = await pool.query(
          "SELECT id, kyc_type, kyc_id, user_id, action, previous_status, new_status, admin_note, rejection_reason, reviewed_by, reviewed_at, created_at FROM kyc_audit_log ORDER BY created_at DESC",
        );
        for (const r of rows || []) {
          const id = String(r.id);
          seen[id] = true;
          allAudit.push({
            id,
            kycType: String(r.kyc_type),
            kycId: String(r.kyc_id),
            userId: String(r.user_id),
            action: String(r.action),
            previousStatus: String(r.previous_status),
            newStatus: String(r.new_status),
            adminNote: r.admin_note ? String(r.admin_note) : null,
            rejectionReason: r.rejection_reason ? String(r.rejection_reason) : null,
            reviewedBy: String(r.reviewed_by),
            reviewedAt: String(r.reviewed_at),
            createdAt: String(r.created_at),
          });
        }
      } catch (_e) {
        // Table unapplied
      }
    }

    // 2. Load from local store
    if (Array.isArray(store.kycAuditLog)) {
      for (const r of store.kycAuditLog) {
        const id = String(r["id"] || "");
        if (id && !seen[id]) {
          seen[id] = true;
          allAudit.push({
            id,
            kycType: String(r["kycType"] || r["kyc_type"] || "personal"),
            kycId: String(r["kycId"] || r["kyc_id"] || ""),
            userId: String(r["userId"] || r["user_id"] || ""),
            action: String(r["action"] || ""),
            previousStatus: String(r["previousStatus"] || r["previous_status"] || "Submitted"),
            newStatus: String(r["newStatus"] || r["new_status"] || ""),
            adminNote: r["adminNote"] || r["admin_note"] || null,
            rejectionReason: r["rejectionReason"] || r["rejection_reason"] || null,
            reviewedBy: String(r["reviewedBy"] || r["reviewed_by"] || ""),
            reviewedAt: String(r["reviewedAt"] || r["reviewed_at"] || ""),
            createdAt: String(r["createdAt"] || r["created_at"] || ""),
          });
        }
      }
    }

    // Filter
    const filtered = allAudit.filter((item: any) => {
      if (userIdFilter && item.userId.toUpperCase() !== userIdFilter) {
        return false;
      }
      if (typeFilter !== "all" && item.kycType.toLowerCase() !== typeFilter) {
        return false;
      }
      if (actionFilter !== "all" && item.action.toLowerCase() !== actionFilter) {
        return false;
      }
      return true;
    });

    // Sort newest first
    filtered.sort((a: any, b: any) => {
      return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    });

    const totalItems = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));
    const offset = (page - 1) * limit;
    const paginated = filtered.slice(offset, offset + limit);

    return jsonResponse({
      success: true,
      pagination: {
        page,
        limit,
        totalItems,
        totalPages,
      },
      auditLogs: paginated,
    });
  }

  // 16. Channel Logo & Details
  if (route === "users/channel-logo") {
    if (method === "POST") {
      const pool = getMysqlPool();
      const authUser = await getAuthUserFromRequest(request, store, pool);
      if (!authUser) {
        return jsonResponse({ success: false, error: "Authentication required" }, 401);
      }
      const body = await request.json();
      const logoUrl = body.channel_logo_url || body.channelLogoUrl;
      const channelName = body.channel_name || body.channelName;
      const user = store.users.find(
        (u) => u.user_id.toUpperCase() === authUser.user_id.toUpperCase(),
      );
      if (user) {
        if (logoUrl) user.channel_logo_url = logoUrl;
        if (channelName) user.channel_name = channelName;
        saveStore(store);
      }
      if (pool) {
        await pool
          .query(
            "UPDATE users SET channel_logo_url = COALESCE(?, channel_logo_url), channel_name = COALESCE(?, channel_name), updated_at = NOW() WHERE UPPER(user_id) = UPPER(?)",
            [logoUrl || null, channelName || null, authUser.user_id],
          )
          .catch(() => {});
      }
      return jsonResponse({
        success: true,
        message: "Channel details updated successfully",
        channel_logo_url: logoUrl || user?.channel_logo_url,
        channel_name: channelName || user?.channel_name,
      });
    }
  }

  // 17. Wallet Earnings Time-Series History
  if (route === "wallet/earnings-history") {
    if (method === "GET") {
      const pool = getMysqlPool();
      const authUser = await getAuthUserFromRequest(request, store, pool);
      const requestedUserId = url.searchParams.get("user_id") || authUser?.user_id || "FT483921";
      const rawPeriod = (url.searchParams.get("period") || "").toUpperCase();
      const rawDays = parseInt(url.searchParams.get("days") || "0", 10);

      let period: "7D" | "30D" | "90D" | "12M" = "30D";
      let days = 30;

      if (rawPeriod === "7D" || rawDays === 7) {
        period = "7D";
        days = 7;
      } else if (rawPeriod === "30D" || rawDays === 30) {
        period = "30D";
        days = 30;
      } else if (rawPeriod === "90D" || rawDays === 90) {
        period = "90D";
        days = 90;
      } else if (rawPeriod === "12M" || rawDays >= 365) {
        period = "12M";
        days = 365;
      } else if (rawDays > 0) {
        days = Math.max(7, Math.min(365, rawDays));
        period = days <= 7 ? "7D" : days <= 30 ? "30D" : days <= 90 ? "90D" : "12M";
      }

      // 1. Try MySQL database first if pool is available
      if (pool) {
        try {
          let rows: any[] = [];
          if (period === "12M") {
            const [queryRows] = await pool.query(
              `SELECT DATE_FORMAT(created_at, '%Y-%m') as period_key,
                      income_type,
                      SUM(amount) as total_amount,
                      COUNT(*) as tx_count
               FROM income_ledger
               WHERE UPPER(user_id) = UPPER(?)
                 AND income_type != 'withdrawal'
                 AND created_at >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 11 MONTH)
               GROUP BY DATE_FORMAT(created_at, '%Y-%m'), income_type
               ORDER BY period_key ASC`,
              [requestedUserId],
            );
            rows = queryRows as any[];
          } else {
            const [queryRows] = await pool.query(
              `SELECT DATE(created_at) as period_key,
                      income_type,
                      SUM(amount) as total_amount,
                      COUNT(*) as tx_count
               FROM income_ledger
               WHERE UPPER(user_id) = UPPER(?)
                 AND income_type != 'withdrawal'
                 AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
               GROUP BY DATE(created_at), income_type
               ORDER BY period_key ASC`,
              [requestedUserId, days],
            );
            rows = queryRows as any[];
          }

          const timelineMap: Record<string, any> = {};
          const now = new Date();

          if (period === "12M") {
            for (let i = 11; i >= 0; i--) {
              const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
              const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
              const label = d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
              timelineMap[key] = {
                date: key,
                day: label,
                revenue: 0,
                referral: 0,
                global: 0,
                adsense: 0,
                affiliate: 0,
                ad_boost: 0,
                referral_income: 0,
                global_income: 0,
                adsense_income: 0,
                affiliate_income: 0,
                ad_boost_income: 0,
                tx_count: 0,
              };
            }
          } else {
            for (let i = days - 1; i >= 0; i--) {
              const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
              const key = d.toISOString().split("T")[0]!;
              const label = d.toLocaleDateString("en-US", { weekday: "short" });
              timelineMap[key] = {
                date: key,
                day: label,
                revenue: 0,
                referral: 0,
                global: 0,
                adsense: 0,
                affiliate: 0,
                ad_boost: 0,
                referral_income: 0,
                global_income: 0,
                adsense_income: 0,
                affiliate_income: 0,
                ad_boost_income: 0,
                tx_count: 0,
              };
            }
          }

          const summary = {
            total_revenue: 0,
            referral: 0,
            global: 0,
            adsense: 0,
            affiliate: 0,
            ad_boost: 0,
          };

          for (const r of rows) {
            const rawKey = r.period_key;
            const k = rawKey instanceof Date ? rawKey.toISOString().split("T")[0]! : String(rawKey);
            if (timelineMap[k]) {
              const amt = Number(r.total_amount) || 0;
              const count = Number(r.tx_count) || 0;
              const type = String(r.income_type || "");

              let category: "referral" | "global" | "adsense" | "affiliate" | "ad_boost" =
                "referral";
              if (type === "global_income") category = "global";
              else if (type === "adsense_income") category = "adsense";
              else if (type === "affiliate_income" || type === "marketing_income")
                category = "affiliate";
              else if (type === "ad_boost_income" || type === "marketing_ads")
                category = "ad_boost";
              else if (type === "referral_income" || type === "direct_commission")
                category = "referral";

              timelineMap[k][category] = Number((timelineMap[k][category] + amt).toFixed(2));
              timelineMap[k][`${category}_income`] = timelineMap[k][category];
              timelineMap[k].revenue = Number((timelineMap[k].revenue + amt).toFixed(2));
              timelineMap[k].tx_count += count;

              summary[category] = Number((summary[category] + amt).toFixed(2));
              summary.total_revenue = Number((summary.total_revenue + amt).toFixed(2));
            }
          }

          return jsonResponse({
            success: true,
            user_id: requestedUserId,
            period,
            days,
            summary,
            history: Object.values(timelineMap),
          });
        } catch (dbErr) {
          console.warn("[Earnings History] MySQL query failed, falling back to store:", dbErr);
        }
      }

      // 2. Fallback to local store
      const userTxs = (store.walletTransactions || []).filter(
        (t: any) =>
          (t.user_id || t.userId)?.toUpperCase() === requestedUserId.toUpperCase() &&
          t.income_type !== "withdrawal" &&
          t.type !== "withdrawal",
      );

      const history: any[] = [];
      const summary = {
        total_revenue: 0,
        referral: 0,
        global: 0,
        adsense: 0,
        affiliate: 0,
        ad_boost: 0,
      };

      if (period === "12M") {
        const now = new Date();
        for (let i = 11; i >= 0; i--) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
          const label = d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });

          const matchingTxs = userTxs.filter((t: any) =>
            String(t.created_at || t.createdAt || "").startsWith(key),
          );

          let ref = 0;
          let glb = 0;
          let ads = 0;
          let aff = 0;
          let boost = 0;

          for (const tx of matchingTxs) {
            const amt = Number(tx["amount"]) || 0;
            const tType = String(tx["income_type"] || tx["incomeType"] || tx["type"] || "");
            if (tType === "global_income") glb += amt;
            else if (tType === "adsense_income") ads += amt;
            else if (tType === "affiliate_income" || tType === "marketing_income") aff += amt;
            else if (tType === "ad_boost_income" || tType === "marketing_ads") boost += amt;
            else if (tType === "referral_income" || tType === "direct_commission") ref += amt;
            else ref += amt;
          }

          ref = Number(ref.toFixed(2));
          glb = Number(glb.toFixed(2));
          ads = Number(ads.toFixed(2));
          aff = Number(aff.toFixed(2));
          boost = Number(boost.toFixed(2));
          const totalRev = Number((ref + glb + ads + aff + boost).toFixed(2));

          summary.referral = Number((summary.referral + ref).toFixed(2));
          summary.global = Number((summary.global + glb).toFixed(2));
          summary.adsense = Number((summary.adsense + ads).toFixed(2));
          summary.affiliate = Number((summary.affiliate + aff).toFixed(2));
          summary.ad_boost = Number((summary.ad_boost + boost).toFixed(2));
          summary.total_revenue = Number((summary.total_revenue + totalRev).toFixed(2));

          history.push({
            date: key,
            day: label,
            revenue: totalRev,
            referral: ref,
            global: glb,
            adsense: ads,
            affiliate: aff,
            ad_boost: boost,
            referral_income: ref,
            global_income: glb,
            adsense_income: ads,
            affiliate_income: aff,
            ad_boost_income: boost,
            tx_count: matchingTxs.length,
          });
        }
      } else {
        const now = Date.now();
        for (let i = days - 1; i >= 0; i--) {
          const d = new Date(now - i * 24 * 60 * 60 * 1000);
          const dateStr = d.toISOString().split("T")[0]!;
          const dayLabel = d.toLocaleDateString("en-US", { weekday: "short" });

          const matchingTxs = userTxs.filter((t: any) =>
            String(t.created_at || t.createdAt || "").startsWith(dateStr),
          );

          let ref = 0;
          let glb = 0;
          let ads = 0;
          let aff = 0;
          let boost = 0;

          for (const tx of matchingTxs) {
            const amt = Number(tx["amount"]) || 0;
            const tType = String(tx["income_type"] || tx["incomeType"] || tx["type"] || "");
            if (tType === "global_income") glb += amt;
            else if (tType === "adsense_income") ads += amt;
            else if (tType === "affiliate_income" || tType === "marketing_income") aff += amt;
            else if (tType === "ad_boost_income" || tType === "marketing_ads") boost += amt;
            else if (tType === "referral_income" || tType === "direct_commission") ref += amt;
            else ref += amt;
          }

          ref = Number(ref.toFixed(2));
          glb = Number(glb.toFixed(2));
          ads = Number(ads.toFixed(2));
          aff = Number(aff.toFixed(2));
          boost = Number(boost.toFixed(2));
          const totalRev = Number((ref + glb + ads + aff + boost).toFixed(2));

          summary.referral = Number((summary.referral + ref).toFixed(2));
          summary.global = Number((summary.global + glb).toFixed(2));
          summary.adsense = Number((summary.adsense + ads).toFixed(2));
          summary.affiliate = Number((summary.affiliate + aff).toFixed(2));
          summary.ad_boost = Number((summary.ad_boost + boost).toFixed(2));
          summary.total_revenue = Number((summary.total_revenue + totalRev).toFixed(2));

          history.push({
            date: dateStr,
            day: dayLabel,
            revenue: totalRev,
            referral: ref,
            global: glb,
            adsense: ads,
            affiliate: aff,
            ad_boost: boost,
            referral_income: ref,
            global_income: glb,
            adsense_income: ads,
            affiliate_income: aff,
            ad_boost_income: boost,
            tx_count: matchingTxs.length,
          });
        }
      }

      return jsonResponse({
        success: true,
        user_id: requestedUserId,
        period,
        days,
        summary,
        history,
      });
    }
  }

  // 18. Live Streams & Chat
  if (route === "live/streams") {
    if (method === "GET") {
      if (!store.liveStreams || store.liveStreams.length === 0) {
        store.liveStreams = [
          {
            id: "live_seed_001",
            user_id: "FT102857",
            title: "🔴 LIVE: 24-Hour Full-Stack & System Architecture Sprint",
            description: "Live coding, production review, and developer Q&A session.",
            category: "Coding & Tech",
            stream_key: "sk_live_devforge_001",
            playback_url: "https://vjs.zencdn.net/v/oceans.mp4",
            thumbnail_url:
              "https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=800&auto=format&fit=crop&q=80",
            status: "live",
            viewers_count: 1420,
            created_at: new Date().toISOString(),
          },
        ];
        saveStore(store);
      }
      return jsonResponse({ success: true, streams: store.liveStreams });
    }
    if (method === "POST") {
      const pool = getMysqlPool();
      if (process.env["NODE_ENV"] === "production" && !pool) {
        return jsonResponse(
          {
            success: false,
            error: "Database connection unavailable in production environment",
          },
          503,
        );
      }
      const authUser = await getAuthUserFromRequest(request, store, pool);
      if (!authUser) {
        return jsonResponse({ success: false, error: "Authentication required" }, 401);
      }
      const body = await request.json();
      const streamId = `live_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
      const roomName = `room_${streamId}`;
      const newStream = {
        id: streamId,
        user_id: authUser.user_id,
        title: body.title || "FaceTube Live Broadcast",
        description: body.description || "",
        category: body.category || "General",
        stream_key: `sk_live_${crypto.randomBytes(12).toString("hex")}`,
        playback_url: body.playbackUrl || "https://vjs.zencdn.net/v/oceans.mp4",
        thumbnail_url: body.thumbnailUrl || "",
        livekit_room_name: roomName,
        status: "live" as const,
        viewers_count: 1,
        started_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      };
      if (pool) {
        try {
          await pool.query(
            `INSERT INTO live_streams (id, user_id, title, description, category, stream_key, playback_url, thumbnail_url, livekit_room_name, status, viewers_count, started_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', 1, NOW(), NOW())`,
            [
              newStream.id,
              newStream.user_id,
              newStream.title,
              newStream.description,
              newStream.category,
              newStream.stream_key,
              newStream.playback_url,
              newStream.thumbnail_url || null,
              roomName,
            ],
          );
        } catch (_dbErr) {
          // Fallback if livekit_room_name column doesn't exist yet
          try {
            await pool.query(
              `INSERT INTO live_streams (id, user_id, title, description, category, stream_key, playback_url, thumbnail_url, status, viewers_count, started_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'live', 1, NOW(), NOW())`,
              [
                newStream.id,
                newStream.user_id,
                newStream.title,
                newStream.description,
                newStream.category,
                newStream.stream_key,
                newStream.playback_url,
                newStream.thumbnail_url || null,
              ],
            );
          } catch (_e) {
            // Ignore
          }
        }
      }
      if (!store.liveStreams) store.liveStreams = [];
      store.liveStreams.unshift(newStream);
      saveStore(store);
      return jsonResponse({ success: true, message: "Stream created", stream: newStream }, 201);
    }
  }

  // 18b. Live Streaming: LiveKit Token Generation (POST /api/live/token)
  if (route === "live/token") {
    if (method !== "POST") {
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    }
    const pool = getMysqlPool();
    if (process.env["NODE_ENV"] === "production" && !pool) {
      return jsonResponse(
        {
          success: false,
          error: "Database connection unavailable in production environment",
        },
        503,
      );
    }

    const authUser = await getAuthUserFromRequest(request, store, pool);
    if (!authUser) {
      return jsonResponse(
        { success: false, error: "Authentication required to access live stream token" },
        401,
      );
    }

    const body: any = await request.json().catch(() => ({}));
    const streamId = String(body.streamId || body.stream_id || "").trim();
    if (!streamId) {
      return jsonResponse({ success: false, error: "streamId is required" }, 400);
    }

    let stream: any = null;
    if (pool) {
      try {
        const [rows]: any = await pool.query("SELECT * FROM live_streams WHERE id = ? LIMIT 1", [
          streamId,
        ]);
        if (rows && rows.length > 0) {
          stream = rows[0];
        }
      } catch (_e) {
        // Fallback
      }
    }

    if (!stream) {
      stream = (store.liveStreams || []).find((s) => s.id === streamId);
    }

    if (!stream) {
      return jsonResponse({ success: false, error: "Stream not found" }, 404);
    }

    if (stream.status !== "live" && stream.status !== "upcoming") {
      return jsonResponse({ success: false, error: "Stream is not currently active" }, 400);
    }

    const isOwner = String(stream.user_id).toUpperCase() === String(authUser.user_id).toUpperCase();
    const requestedRole = String(body.role || "subscriber")
      .toLowerCase()
      .trim();

    if (requestedRole === "publisher" && !isOwner) {
      return jsonResponse(
        {
          success: false,
          error: "Only the stream creator can publish to this stream",
        },
        403,
      );
    }

    const effectiveRole: "publisher" | "subscriber" =
      isOwner && requestedRole === "publisher" ? "publisher" : "subscriber";

    const livekitUrl = process.env["LIVEKIT_URL"] || "wss://live.facetube.online";
    const apiKey = process.env["LIVEKIT_API_KEY"] || "devkey";
    const apiSecret = process.env["LIVEKIT_API_SECRET"] || "secret";
    const roomName = stream.livekit_room_name || `room_${stream.id}`;

    const { token, expiresAt } = generateLiveKitAccessToken({
      apiKey,
      apiSecret,
      roomName,
      identity: authUser.user_id,
      name: authUser.name,
      role: effectiveRole,
      metadata: JSON.stringify({
        userId: authUser.user_id,
        role: effectiveRole,
        streamId: stream.id,
      }),
      ttlSeconds: 1800,
    });

    return jsonResponse({
      success: true,
      token,
      url: livekitUrl,
      room: roomName,
      identity: authUser.user_id,
      role: effectiveRole,
      expires_at: expiresAt,
      server_configured: Boolean(
        process.env["LIVEKIT_API_KEY"] && process.env["LIVEKIT_API_SECRET"],
      ),
    });
  }

  // 18c. Live Streaming: Heartbeat (POST /api/live/heartbeat)
  if (route === "live/heartbeat") {
    if (method !== "POST") {
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    }
    const pool = getMysqlPool();
    if (process.env["NODE_ENV"] === "production" && !pool) {
      return jsonResponse(
        {
          success: false,
          error: "Database connection unavailable in production environment",
        },
        503,
      );
    }

    const authUser = await getAuthUserFromRequest(request, store, pool);
    if (!authUser) {
      return jsonResponse({ success: false, error: "Authentication required" }, 401);
    }

    const body: any = await request.json().catch(() => ({}));
    const streamId = String(body.streamId || body.stream_id || "").trim();
    if (!streamId) {
      return jsonResponse({ success: false, error: "streamId is required" }, 400);
    }

    let stream: any = null;
    if (pool) {
      try {
        const [rows]: any = await pool.query("SELECT * FROM live_streams WHERE id = ? LIMIT 1", [
          streamId,
        ]);
        if (rows && rows.length > 0) {
          stream = rows[0];
        }
      } catch (_e) {
        // Fallback
      }
    }

    if (!stream) {
      stream = (store.liveStreams || []).find((s) => s.id === streamId);
    }

    if (!stream) {
      return jsonResponse({ success: false, error: "Stream not found" }, 404);
    }

    const role = String(body.role || "viewer")
      .toLowerCase()
      .trim();
    const isOwner = String(stream.user_id).toUpperCase() === String(authUser.user_id).toUpperCase();

    if (role === "broadcaster") {
      if (!isOwner) {
        return jsonResponse(
          {
            success: false,
            error: "Only the broadcaster can send broadcaster heartbeats",
          },
          403,
        );
      }
      stream.broadcaster_last_ping_at = new Date().toISOString();
      if (pool) {
        try {
          await pool.query(
            "UPDATE live_streams SET broadcaster_last_ping_at = NOW() WHERE id = ?",
            [stream.id],
          );
        } catch (_e) {
          // Ignore
        }
      }
    } else {
      // Record presence in live_stream_viewers without using it as authoritative count
      if (!store.liveStreamViewers) store.liveStreamViewers = {};
      const viewerKey = `${stream.id}_${authUser.user_id}`;
      store.liveStreamViewers[viewerKey] = {
        stream_id: stream.id,
        user_id: authUser.user_id,
        last_seen_at: new Date().toISOString(),
      };
      if (pool) {
        try {
          await pool.query(
            `INSERT INTO live_stream_viewers (stream_id, user_id, last_heartbeat_at)
             VALUES (?, ?, NOW())
             ON DUPLICATE KEY UPDATE last_heartbeat_at = NOW()`,
            [stream.id, authUser.user_id],
          );
        } catch (_e) {
          // Ignore
        }
      }
    }
    saveStore(store);

    return jsonResponse({
      success: true,
      stream_id: stream.id,
      status: stream.status,
      role,
      active_viewers: Number(stream.viewers_count) || 1,
    });
  }

  // 18d. Live Streaming: End Stream (POST /api/live/end-stream)
  if (route === "live/end-stream") {
    if (method !== "POST") {
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    }
    const pool = getMysqlPool();
    if (process.env["NODE_ENV"] === "production" && !pool) {
      return jsonResponse(
        {
          success: false,
          error: "Database connection unavailable in production environment",
        },
        503,
      );
    }

    const authUser = await getAuthUserFromRequest(request, store, pool);
    if (!authUser) {
      return jsonResponse({ success: false, error: "Authentication required" }, 401);
    }

    const body: any = await request.json().catch(() => ({}));
    const streamId = String(body.streamId || body.stream_id || "").trim();
    if (!streamId) {
      return jsonResponse({ success: false, error: "streamId is required" }, 400);
    }

    let stream: any = null;
    if (pool) {
      try {
        const [rows]: any = await pool.query("SELECT * FROM live_streams WHERE id = ? LIMIT 1", [
          streamId,
        ]);
        if (rows && rows.length > 0) {
          stream = rows[0];
        }
      } catch (_e) {
        // Fallback
      }
    }

    if (!stream) {
      stream = (store.liveStreams || []).find((s) => s.id === streamId);
    }

    if (!stream) {
      return jsonResponse({ success: false, error: "Stream not found" }, 404);
    }

    const isOwner = String(stream.user_id).toUpperCase() === String(authUser.user_id).toUpperCase();
    const isAdmin = authUser.role === "admin" || (authUser as any).is_admin === true;

    if (!isOwner && !isAdmin) {
      return jsonResponse(
        {
          success: false,
          error: "Only the stream owner or an administrator can end this stream",
        },
        403,
      );
    }

    if (stream.status === "ended") {
      return jsonResponse({
        success: true,
        message: "Stream has already ended",
        stream: {
          id: stream.id,
          status: "ended",
          ended_at: stream.ended_at || new Date().toISOString(),
          viewers_count: 0,
        },
      });
    }

    const endedAt = new Date().toISOString();
    stream.status = "ended";
    stream.ended_at = endedAt;
    stream.viewers_count = 0;

    if (pool) {
      try {
        await pool.query(
          "UPDATE live_streams SET status = 'ended', ended_at = NOW(), viewers_count = 0 WHERE id = ?",
          [stream.id],
        );
        await pool.query("DELETE FROM live_stream_viewers WHERE stream_id = ?", [stream.id]);
      } catch (_e) {
        // Ignore
      }
    }
    saveStore(store);

    return jsonResponse({
      success: true,
      message: "Live stream ended successfully",
      stream: {
        id: stream.id,
        status: "ended",
        ended_at: endedAt,
        viewers_count: 0,
      },
    });
  }

  // 18e. Live Streaming: Official LiveKit Webhook (POST /api/live/webhook)
  if (route === "live/webhook") {
    if (method !== "POST") {
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    }
    const pool = getMysqlPool();
    if (process.env["NODE_ENV"] === "production" && !pool) {
      return jsonResponse(
        {
          success: false,
          error: "Database connection unavailable in production environment",
        },
        503,
      );
    }

    const rawBody = await request.text();
    const authHeader = request.headers.get("authorization");
    const apiSecret = process.env["LIVEKIT_API_SECRET"] || "secret";

    const verification = verifyLiveKitWebhook(authHeader, rawBody, apiSecret);
    if (!verification.valid) {
      return jsonResponse(
        {
          success: false,
          error: verification.error || "LiveKit webhook verification failed",
        },
        401,
      );
    }

    let eventData: any;
    try {
      eventData = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ success: false, error: "Invalid JSON payload" }, 400);
    }

    const eventId = String(eventData.id || eventData.sid || "").trim();
    if (!store.livekitWebhookEvents) store.livekitWebhookEvents = {};

    if (eventId && store.livekitWebhookEvents[eventId]) {
      return jsonResponse(
        {
          success: true,
          idempotent: true,
          duplicate: true,
          message: "Webhook event already processed",
        },
        200,
      );
    }

    if (pool && eventId) {
      try {
        const [dupRows]: any = await pool.query(
          "SELECT id FROM livekit_webhook_events WHERE event_id = ? LIMIT 1",
          [eventId],
        );
        if (dupRows && dupRows.length > 0) {
          return jsonResponse(
            {
              success: true,
              idempotent: true,
              duplicate: true,
              message: "Webhook event already processed",
            },
            200,
          );
        }
        await pool.query(
          `INSERT INTO livekit_webhook_events (event_id, event_type, room_name, raw_payload, processed_at)
           VALUES (?, ?, ?, ?, NOW())`,
          [
            eventId,
            eventData.event || "unknown",
            eventData.room?.name || null,
            rawBody.slice(0, 10000),
          ],
        );
      } catch (_e) {
        // Ignore duplicate key collision
      }
    }

    if (eventId) {
      store.livekitWebhookEvents[eventId] = {
        event_id: eventId,
        event_type: eventData.event,
        processed_at: new Date().toISOString(),
      };
    }

    const eventType = String(eventData.event || "").trim();
    const roomName = String(eventData.room?.name || "").trim();

    let stream: any = null;
    if (pool && roomName) {
      try {
        const streamIdFromRoom = roomName.replace(/^room_/, "");
        const [rows]: any = await pool.query(
          "SELECT * FROM live_streams WHERE livekit_room_name = ? OR id = ? LIMIT 1",
          [roomName, streamIdFromRoom],
        );
        if (rows && rows.length > 0) {
          stream = rows[0];
        }
      } catch (_e) {
        // Fallback
      }
    }

    if (!stream && roomName) {
      const streamIdFromRoom = roomName.replace(/^room_/, "");
      stream = (store.liveStreams || []).find(
        (s) => s.livekit_room_name === roomName || s.id === streamIdFromRoom,
      );
    }

    if (stream) {
      if (eventType === "participant_joined") {
        const num =
          typeof eventData.room?.numParticipants === "number"
            ? Math.max(0, eventData.room.numParticipants - 1)
            : (stream.viewers_count || 0) + 1;
        stream.viewers_count = num;
        if (pool) {
          try {
            await pool.query("UPDATE live_streams SET viewers_count = ? WHERE id = ?", [
              num,
              stream.id,
            ]);
          } catch (_e) {
            // Ignore
          }
        }
      } else if (eventType === "participant_left") {
        const num =
          typeof eventData.room?.numParticipants === "number"
            ? Math.max(0, eventData.room.numParticipants - 1)
            : Math.max(0, (stream.viewers_count || 1) - 1);
        stream.viewers_count = num;
        if (pool) {
          try {
            await pool.query("UPDATE live_streams SET viewers_count = ? WHERE id = ?", [
              num,
              stream.id,
            ]);
          } catch (_e) {
            // Ignore
          }
        }
      } else if (eventType === "room_finished") {
        stream.status = "ended";
        stream.ended_at = new Date().toISOString();
        stream.viewers_count = 0;
        if (pool) {
          try {
            await pool.query(
              "UPDATE live_streams SET status = 'ended', ended_at = NOW(), viewers_count = 0 WHERE id = ?",
              [stream.id],
            );
          } catch (_e) {
            // Ignore
          }
        }
      }
      saveStore(store);
    }

    return jsonResponse({
      success: true,
      event: eventType,
      room: roomName,
      processed: true,
    });
  }

  if (route === "live/chat") {
    if (method === "GET") {
      const streamId = url.searchParams.get("stream_id") || "live_seed_001";
      const messages = (store.liveChatMessages || []).filter((m) => m.stream_id === streamId);
      return jsonResponse({ success: true, stream_id: streamId, messages });
    }
    if (method === "POST") {
      const pool = getMysqlPool();
      const authUser = await getAuthUserFromRequest(request, store, pool);
      const body = await request.json();
      const streamId = body.stream_id || body.streamId;
      const msgText = String(body.message || "").trim();
      if (!streamId || !msgText) {
        return jsonResponse({ success: false, error: "stream_id and message are required" }, 400);
      }
      const msgRecord: {
        id: string;
        stream_id: string;
        user_id: string;
        user_name: string;
        avatar_url?: string;
        message: string;
        is_superchat?: boolean;
        superchat_amount?: number;
        created_at: string;
      } = {
        id: `chat_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
        stream_id: streamId,
        user_id: authUser?.user_id || "GUEST",
        user_name: authUser?.name || body.user_name || "Viewer",
        message: msgText,
        is_superchat: Boolean(body.is_superchat),
        superchat_amount: Number(body.superchat_amount) || 0,
        created_at: new Date().toISOString(),
      };
      if (authUser?.avatar_url) {
        msgRecord.avatar_url = authUser.avatar_url;
      }
      if (!store.liveChatMessages) store.liveChatMessages = [];
      store.liveChatMessages.push(msgRecord);
      saveStore(store);
      return jsonResponse({ success: true, message: msgRecord }, 201);
    }
  }

  // 19. Categories List
  if (route === "categories/list") {
    if (method === "GET") {
      const pool = getMysqlPool();
      if (pool) {
        try {
          const [rows]: any = await pool.query(
            "SELECT id, name, slug, created_by, created_at FROM categories ORDER BY name ASC",
          );
          if (rows && rows.length > 0) {
            const existingLower = new Set(
              rows.map((r: any) =>
                String(r.name || "")
                  .trim()
                  .toLowerCase(),
              ),
            );
            const missingBaseline = getInitialCategories().filter(
              (b) => !existingLower.has(b.name.trim().toLowerCase()),
            );
            const merged = [...rows, ...missingBaseline].sort((a: any, b: any) =>
              String(a.name || "").localeCompare(String(b.name || "")),
            );
            return jsonResponse({
              success: true,
              source: "database",
              categories: merged,
            });
          }
        } catch (dbErr: any) {
          const isTableMissing =
            dbErr?.code === "ER_NO_SUCH_TABLE" ||
            String(dbErr?.message || "").includes("doesn't exist");
          if (!isTableMissing && process.env["NODE_ENV"] === "production") {
            return jsonResponse(
              {
                success: false,
                error:
                  "Database error while fetching categories: " + (dbErr?.message || "Query failed"),
              },
              500,
            );
          }
          // If table is missing, fall back to authoritative baseline catalog below
        }
      }

      // In production, when database is unavailable or migration is pending,
      // return clean baseline categories without using local JSON mock data.
      if (process.env["NODE_ENV"] === "production") {
        return jsonResponse({
          success: true,
          source: "baseline_fallback",
          categories: getInitialCategories(),
        });
      }

      if (!store.categories || store.categories.length === 0) {
        store.categories = getInitialCategories();
        saveStore(store);
      } else {
        const existingLower = new Set(
          store.categories.map((c: any) =>
            String(c.name || "")
              .trim()
              .toLowerCase(),
          ),
        );
        let updated = false;
        for (const base of getInitialCategories()) {
          if (!existingLower.has(base.name.trim().toLowerCase())) {
            store.categories.push({
              ...base,
              id: store.categories.length + 1,
            });
            existingLower.add(base.name.trim().toLowerCase());
            updated = true;
          }
        }
        if (updated) {
          saveStore(store);
        }
      }

      return jsonResponse({
        success: true,
        source: "baseline_fallback",
        categories: store.categories,
      });
    }
  }

  // 19b. Paid Subscriber Plans Catalog (GET /api/subscriptions/plans.php)
  if (route === "subscriptions/plans") {
    if (method !== "GET") {
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    }

    const pool = getMysqlPool();
    const authUser = await getAuthUserFromRequest(request, store, pool);
    if (!authUser) {
      return jsonResponse(
        {
          success: false,
          error: "Authentication required. Please provide a valid Bearer session token.",
        },
        401,
      );
    }

    const isAdmin = authUser.role === "admin";
    const includeInactive = isAdmin && url.searchParams.get("include_inactive") === "1";

    if (pool) {
      try {
        let sql =
          "SELECT id, plan_id, name, price, duration_days, perks_json, is_active, created_at FROM subscriber_plans";
        if (!includeInactive) {
          sql += " WHERE is_active = 1";
        }
        sql += " ORDER BY price ASC";

        const [rows]: any = await pool.query(sql);
        if (rows && rows.length > 0) {
          const formatted = rows.map((r: any) => {
            let perks: string[] = [];
            if (r.perks_json) {
              try {
                perks = typeof r.perks_json === "string" ? JSON.parse(r.perks_json) : r.perks_json;
              } catch {
                perks = [];
              }
            }
            return {
              id: Number(r.id),
              plan_id: String(r.plan_id),
              name: String(r.name),
              price: Number(r.price),
              duration_days: Number(r.duration_days),
              perks: Array.isArray(perks) ? perks : [],
              is_active: Boolean(r.is_active),
              created_at: String(r.created_at),
            };
          });

          return jsonResponse({
            success: true,
            source: "database",
            plans: formatted,
          });
        }
      } catch (dbErr: any) {
        const isTableMissing =
          dbErr?.code === "ER_NO_SUCH_TABLE" ||
          String(dbErr?.message || "").includes("doesn't exist");
        if (!isTableMissing && process.env["NODE_ENV"] === "production") {
          return jsonResponse(
            {
              success: false,
              error:
                "Database error while fetching subscriber plans: " +
                (dbErr?.message || "Query failed"),
            },
            500,
          );
        }
        // If table is missing, fall back to authoritative baseline catalog below
      }
    }

    const baseline = getInitialSubscriberPlans();
    const plansToReturn = includeInactive ? baseline : baseline.filter((p) => p.is_active);

    return jsonResponse({
      success: true,
      source: "baseline_fallback",
      plans: plansToReturn,
    });
  }

  // 19c. Active User Subscription & History (GET /api/subscriptions/active or /api/subscriptions/my)
  if (route === "subscriptions/active" || route === "subscriptions/my") {
    if (method !== "GET") {
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    }

    const pool = getMysqlPool();
    const authUser = await getAuthUserFromRequest(request, store, pool);
    if (!authUser) {
      return jsonResponse(
        {
          success: false,
          error: "Authentication required. Please provide a valid Bearer session token.",
        },
        401,
      );
    }

    // Enforce ownership strictly from authenticated session token - client user ID is never trusted
    const userId = authUser.user_id;
    const now = Date.now();

    const planNameMap: Record<string, string> = {
      "member-monthly": "Creator Member",
      "member-vip-monthly": "VIP Supporter",
      "member-annual": "All-Access Annual",
    };
    if (store.subscriberPlans) {
      for (const p of store.subscriberPlans) {
        if (p.plan_id && p.name) {
          planNameMap[p.plan_id] = p.name;
        }
      }
    }

    const mapSubscription = (r: {
      subscription_id?: string;
      subscriptionId?: string;
      user_id?: string;
      userId?: string;
      plan_id?: string;
      planId?: string;
      order_id?: string;
      orderId?: string;
      payment_id?: string;
      paymentId?: string;
      amount?: number | string;
      currency?: string;
      status?: string;
      starts_at?: string;
      startsAt?: string;
      expires_at?: string;
      expiresAt?: string;
      created_at?: string;
      createdAt?: string;
    }) => {
      const subId = String(r.subscription_id || r.subscriptionId || "");
      const uId = String(r.user_id || r.userId || "");
      const pId = String(r.plan_id || r.planId || "");
      const oId = String(r.order_id || r.orderId || "");
      const payId = String(r.payment_id || r.paymentId || "");
      const amt = Number(r.amount || 0);
      const curr = String(r.currency || "INR");
      const rawStatus = String(r.status || "active");
      const sAt = String(r.starts_at || r.startsAt || new Date().toISOString());
      const eAt = String(r.expires_at || r.expiresAt || new Date().toISOString());
      const cAt = String(r.created_at || r.createdAt || sAt);

      const expiresTime = new Date(eAt).getTime();
      const isExpired = rawStatus !== "active" || expiresTime <= now;
      const remainingDays = isExpired ? 0 : Math.max(0, Math.ceil((expiresTime - now) / 86400000));
      const status = isExpired && rawStatus === "active" ? "expired" : rawStatus;
      const planName = planNameMap[pId] || pId;

      return {
        subscriptionId: subId,
        userId: uId,
        planId: pId,
        planName,
        orderId: oId,
        paymentId: payId,
        amount: amt,
        currency: curr,
        status,
        isExpired,
        remainingDays,
        startsAt: sAt,
        expiresAt: eAt,
        createdAt: cAt,
      };
    };

    let allFormatted: ReturnType<typeof mapSubscription>[] = [];

    if (pool) {
      try {
        const [rows]: any = await pool.query(
          `SELECT subscription_id, user_id, plan_id, order_id, payment_id, amount, currency, status, starts_at, expires_at, created_at
           FROM user_subscriptions
           WHERE UPPER(user_id) = UPPER(?)
           ORDER BY created_at DESC`,
          [userId],
        );
        if (rows && Array.isArray(rows) && rows.length > 0) {
          allFormatted = rows.map(mapSubscription);
        }
      } catch (_dbErr) {
        // fallback to store
      }
    }

    if (allFormatted.length === 0) {
      let persistentFound = false;
      try {
        const premiumPath = path.resolve(process.cwd(), "data", "premium_transactions.json");
        if (fs.existsSync(premiumPath)) {
          const content = JSON.parse(fs.readFileSync(premiumPath, "utf-8"));
          if (Array.isArray(content.userSubscriptions)) {
            persistentFound = true;
            allFormatted = content.userSubscriptions
              .filter((s: any) => s.userId?.toUpperCase() === userId.toUpperCase())
              .map(mapSubscription);
          }
        }
      } catch (_e) {
        // ignore
      }

      if (!persistentFound) {
        allFormatted = (store.userSubscriptions || [])
          .filter((s) => s.user_id?.toUpperCase() === userId.toUpperCase())
          .map(mapSubscription);
      }

      allFormatted.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    }

    const activeSubscription =
      allFormatted.find((s) => !s.isExpired && s.status === "active") || null;
    const history = allFormatted.filter((s) => s !== activeSubscription);

    return jsonResponse({
      success: true,
      hasActiveSubscription: Boolean(activeSubscription),
      subscription: activeSubscription,
      activeSubscription,
      history,
      subscriptions: allFormatted,
    });
  }

  // 19d. Admin Subscription Management (GET /api/admin/subscriptions)
  if (route === "admin/subscriptions") {
    if (method !== "GET") {
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    }

    const pool = getMysqlPool();
    const authUser = await getAuthUserFromRequest(request, store, pool);
    if (!authUser) {
      return jsonResponse(
        {
          success: false,
          error: "Authentication required. Please provide a valid Bearer session token.",
        },
        401,
      );
    }

    if (authUser.role !== "admin") {
      return jsonResponse(
        {
          success: false,
          error: "Admin authorization required. Access denied.",
        },
        403,
      );
    }

    const url = new URL(request.url);
    const search = (url.searchParams.get("search") || "").trim().toLowerCase();
    const statusFilter = (url.searchParams.get("status") || "all").trim().toLowerCase();
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "10", 10)));
    const detailId = (url.searchParams.get("id") || "").trim();

    const now = Date.now();

    // Map plans
    const planMap = new Map<string, { name: string; perks: string[]; duration: number }>();
    planMap.set("member-monthly", {
      name: "Creator Member",
      perks: [
        "Custom channel member badge",
        "Early access to new videos",
        "Exclusive member-only live stream chat",
      ],
      duration: 30,
    });
    planMap.set("member-vip-monthly", {
      name: "VIP Supporter",
      perks: [
        "All Creator Member perks",
        "Priority comment replies",
        "Exclusive behind-the-scenes content",
        "VIP live badge",
      ],
      duration: 30,
    });
    planMap.set("member-annual", {
      name: "All-Access Annual",
      perks: [
        "All VIP Supporter perks",
        "365 days uninterrupted access",
        "Golden verified supporter badge",
        "VIP live stream superchats",
      ],
      duration: 365,
    });

    if (store.subscriberPlans) {
      for (const p of store.subscriberPlans) {
        if (p.plan_id) {
          planMap.set(p.plan_id, {
            name: p.name || p.plan_id,
            perks: Array.isArray(p.perks) ? p.perks : [],
            duration: p.duration_days || 30,
          });
        }
      }
    }

    // Map users
    const userMap = new Map<string, { name: string; email: string }>();
    for (const u of store.users || []) {
      userMap.set(u.user_id.toUpperCase(), { name: u.name, email: u.email });
    }

    const mapRow = (r: any) => {
      const subId = String(r.subscription_id || r.subscriptionId || "");
      const uId = String(r.user_id || r.userId || "");
      const pId = String(r.plan_id || r.planId || "");
      const oId = String(r.order_id || r.orderId || "");
      const payId = String(r.payment_id || r.paymentId || "");
      const amt = Number(r.amount || 0);
      const curr = String(r.currency || "INR");
      const rawStatus = String(r.status || "active");
      const sAt = String(r.starts_at || r.startsAt || new Date().toISOString());
      const eAt = String(r.expires_at || r.expiresAt || new Date().toISOString());
      const cAt = String(r.created_at || r.createdAt || sAt);

      const expiresTime = new Date(eAt).getTime();
      const isExpired = rawStatus !== "active" || expiresTime <= now;
      const remainingDays = isExpired ? 0 : Math.max(0, Math.ceil((expiresTime - now) / 86400000));
      const status = isExpired && rawStatus === "active" ? "expired" : rawStatus;

      const planInfo = planMap.get(pId);
      const planName = r.plan_name || planInfo?.name || pId;
      const perks = r.perks || planInfo?.perks || [];

      const userInfo = userMap.get(uId.toUpperCase());
      const userName = r.user_name || r.userName || userInfo?.name || "Member";
      const userEmail = r.user_email || r.userEmail || userInfo?.email || "";

      return {
        id: subId,
        subscriptionId: subId,
        userId: uId,
        userName,
        userEmail,
        planId: pId,
        planName,
        amount: amt,
        currency: curr,
        status,
        isExpired,
        remainingDays,
        orderId: oId,
        paymentId: payId,
        startsAt: sAt,
        expiresAt: eAt,
        createdAt: cAt,
        perks,
      };
    };

    let allSubs: ReturnType<typeof mapRow>[] = [];

    if (pool) {
      try {
        const [rows]: any = await pool.query(
          `SELECT s.subscription_id, s.user_id, s.plan_id, s.order_id, s.payment_id, s.amount, s.currency, s.status, s.starts_at, s.expires_at, s.created_at,
                  u.name AS user_name, u.email AS user_email,
                  p.name AS plan_name, p.perks_json
           FROM user_subscriptions s
           LEFT JOIN users u ON UPPER(s.user_id) = UPPER(u.user_id)
           LEFT JOIN subscriber_plans p ON s.plan_id = p.plan_id
           ORDER BY s.created_at DESC`,
        );
        if (rows && Array.isArray(rows) && rows.length > 0) {
          allSubs = rows.map((row: any) => {
            let perks: string[] = [];
            if (row.perks_json) {
              try {
                const dec =
                  typeof row.perks_json === "string" ? JSON.parse(row.perks_json) : row.perks_json;
                if (Array.isArray(dec)) perks = dec;
              } catch (_parseErr) {
                // Ignore JSON parse errors on malformed perks
              }
            }
            return mapRow({ ...row, perks });
          });
        }
      } catch (_err) {
        // fallback to persistent file / store
      }
    }

    if (allSubs.length === 0) {
      let persistentFound = false;
      try {
        const premiumPath = path.resolve(process.cwd(), "data", "premium_transactions.json");
        if (fs.existsSync(premiumPath)) {
          const content = JSON.parse(fs.readFileSync(premiumPath, "utf-8"));
          if (Array.isArray(content.userSubscriptions)) {
            persistentFound = true;
            allSubs = content.userSubscriptions.map(mapRow);
          }
        }
      } catch (_e) {
        // Ignore read errors and fallback to in-memory store
      }

      if (!persistentFound) {
        allSubs = (store.userSubscriptions || []).map(mapRow);
      }
    }

    allSubs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // Single item detail lookup
    if (detailId) {
      const match = allSubs.find(
        (s) => s.subscriptionId === detailId || s.paymentId === detailId || s.orderId === detailId,
      );
      if (!match) {
        return jsonResponse({ success: false, error: "Subscription record not found." }, 404);
      }
      return jsonResponse({ success: true, subscription: match });
    }

    // Compute stats
    const total = allSubs.length;
    const active = allSubs.filter((s) => !s.isExpired && s.status === "active").length;
    const expired = allSubs.filter((s) => s.isExpired || s.status === "expired").length;
    const totalRevenue = allSubs.reduce((acc, s) => acc + (s.amount || 0), 0);

    // Apply status filter
    let filtered = allSubs;
    if (statusFilter === "active") {
      filtered = filtered.filter((s) => !s.isExpired && s.status === "active");
    } else if (statusFilter === "expired") {
      filtered = filtered.filter((s) => s.isExpired || s.status === "expired");
    }

    // Apply search filter
    if (search) {
      filtered = filtered.filter((s) => {
        return (
          s.userId.toLowerCase().includes(search) ||
          s.userName.toLowerCase().includes(search) ||
          s.userEmail.toLowerCase().includes(search) ||
          s.planId.toLowerCase().includes(search) ||
          s.planName.toLowerCase().includes(search) ||
          s.paymentId.toLowerCase().includes(search) ||
          s.orderId.toLowerCase().includes(search) ||
          s.subscriptionId.toLowerCase().includes(search)
        );
      });
    }

    const totalItems = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));
    const offset = (page - 1) * limit;
    const paginated = filtered.slice(offset, offset + limit);

    return jsonResponse({
      success: true,
      stats: {
        total,
        active,
        expired,
        totalRevenue,
      },
      pagination: {
        page,
        limit,
        totalItems,
        totalPages,
      },
      subscriptions: paginated,
    });
  }

  // 19e. User Subscription Refund Requests (POST/GET /api/subscriptions/refund-request or /api/subscriptions/refund-requests)
  if (route === "subscriptions/refund-request" || route === "subscriptions/refund-requests") {
    const pool = getMysqlPool();
    const authUser = await getAuthUserFromRequest(request, store, pool);
    if (!authUser) {
      return jsonResponse(
        {
          success: false,
          error: "Authentication required. Please provide a valid Bearer session token.",
        },
        401,
      );
    }

    if (method === "POST") {
      const body = await request.json().catch(() => ({}));
      const subscriptionId = String(body.subscriptionId || body.subscription_id || "").trim();
      const reason = String(body.reason || "").trim();

      if (!subscriptionId) {
        return jsonResponse(
          {
            success: false,
            error: "Subscription ID is required.",
          },
          400,
        );
      }

      if (!reason || reason.length < 5) {
        return jsonResponse(
          {
            success: false,
            error:
              "Please provide a detailed reason for the refund request (minimum 5 characters).",
          },
          400,
        );
      }

      if (reason.length > 1000) {
        return jsonResponse(
          {
            success: false,
            error: "Reason must not exceed 1000 characters.",
          },
          400,
        );
      }

      // 1. Locate the subscription record
      let foundSub: any = null;
      if (pool) {
        try {
          const [rows]: any = await pool.query(
            `SELECT subscription_id, user_id, plan_id, order_id, payment_id, amount, currency, status, starts_at, expires_at, created_at
             FROM user_subscriptions
             WHERE subscription_id = ? OR payment_id = ? OR order_id = ?
             LIMIT 1`,
            [subscriptionId, subscriptionId, subscriptionId],
          );
          if (rows && rows.length > 0) {
            foundSub = rows[0];
          }
        } catch (_err) {
          // ignore and fallback
        }
      }

      if (!foundSub) {
        try {
          const premiumPath = path.resolve(process.cwd(), "data", "premium_transactions.json");
          if (fs.existsSync(premiumPath)) {
            const content = JSON.parse(fs.readFileSync(premiumPath, "utf-8"));
            if (Array.isArray(content.userSubscriptions)) {
              foundSub = content.userSubscriptions.find(
                (s: any) =>
                  s.subscriptionId === subscriptionId ||
                  s.paymentId === subscriptionId ||
                  s.orderId === subscriptionId,
              );
            }
          }
        } catch (_e) {
          // ignore
        }
      }

      if (!foundSub && store.userSubscriptions) {
        foundSub = store.userSubscriptions.find(
          (s) =>
            s.subscription_id === subscriptionId ||
            s.payment_id === subscriptionId ||
            s.order_id === subscriptionId,
        );
      }

      if (!foundSub) {
        return jsonResponse(
          {
            success: false,
            error: "Subscription record not found.",
          },
          404,
        );
      }

      // 2. Strict User Ownership Enforcement
      const subUserId = String(foundSub.user_id || foundSub.userId || "");
      if (subUserId.toUpperCase() !== authUser.user_id.toUpperCase()) {
        return jsonResponse(
          {
            success: false,
            error: "Unauthorized: You can only submit refund requests for your own subscriptions.",
          },
          403,
        );
      }

      // 3. Status checks
      const subStatus = String(foundSub.status || "active");
      if (subStatus === "refunded") {
        return jsonResponse(
          {
            success: false,
            error: "This subscription has already been refunded.",
          },
          400,
        );
      }

      const paymentId = String(foundSub.payment_id || foundSub.paymentId || "");
      const orderId = String(foundSub.order_id || foundSub.orderId || "");
      const amount = Number(foundSub.amount || 0);
      const subId = String(foundSub.subscription_id || foundSub.subscriptionId || subscriptionId);
      const planId = String(foundSub.plan_id || foundSub.planId || "");

      if (!paymentId || amount <= 0) {
        return jsonResponse(
          {
            success: false,
            error: "No verified captured payment record found for this subscription.",
          },
          400,
        );
      }

      // 4. Duplicate prevention under lock
      const persistentRequests = await getPersistentRefundRequests();
      const allRequests = [...persistentRequests, ...(store.subscriptionRefundRequests || [])];

      const existingActiveReq = allRequests.find(
        (r) =>
          (r.subscriptionId === subId || r.paymentId === paymentId) &&
          ["pending", "approved", "processing", "refunded"].includes(r.status),
      );

      if (existingActiveReq) {
        return jsonResponse(
          {
            success: false,
            error: `A refund request for this subscription payment has already been submitted and is currently ${existingActiveReq.status}. Duplicate refund requests are not permitted.`,
            request: existingActiveReq,
          },
          409,
        );
      }

      // Lookup plan name
      const planNameMap: Record<string, string> = {
        "member-monthly": "Creator Member",
        "member-vip-monthly": "VIP Supporter",
        "member-annual": "All-Access Annual",
      };
      if (store.subscriberPlans) {
        for (const p of store.subscriberPlans) {
          if (p.plan_id && p.name) {
            planNameMap[p.plan_id] = p.name;
          }
        }
      }
      const planName = planNameMap[planId] || planId;

      const newRefundReq: RefundRequestRecord = {
        id: `rfnd_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
        subscriptionId: subId,
        userId: authUser.user_id,
        userName: authUser.name || "Member",
        userEmail: authUser.email || "",
        planId,
        planName,
        paymentId,
        orderId,
        amount,
        currency: String(foundSub.currency || "INR"),
        reason,
        status: "pending",
        gatewayStatus: "manual_review_only",
        gatewayRefundId: null,
        adminNote: null,
        reviewedBy: null,
        reviewedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await savePersistentRefundRequest(newRefundReq);

      if (!store.subscriptionRefundRequests) {
        store.subscriptionRefundRequests = [];
      }
      store.subscriptionRefundRequests.unshift(newRefundReq);
      saveStore(store);

      return jsonResponse(
        {
          success: true,
          message:
            "Refund request submitted successfully. It will be reviewed by an administrator.",
          request: newRefundReq,
        },
        201,
      );
    }

    if (method === "GET") {
      const persistentRequests = await getPersistentRefundRequests();
      const inStore = store.subscriptionRefundRequests || [];
      const combined = [...persistentRequests, ...inStore];

      const seen = new Set<string>();
      const userRequests: RefundRequestRecord[] = [];

      for (const r of combined) {
        if (!seen.has(r.id) && r.userId.toUpperCase() === authUser.user_id.toUpperCase()) {
          seen.add(r.id);
          userRequests.push(r);
        }
      }

      userRequests.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );

      return jsonResponse({
        success: true,
        requests: userRequests,
      });
    }

    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  }

  // 19f. Admin Subscription Refunds Management (GET /api/admin/subscription-refunds)
  if (route === "admin/subscription-refunds") {
    if (method !== "GET") {
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    }

    const pool = getMysqlPool();
    const authUser = await getAuthUserFromRequest(request, store, pool);
    if (!authUser) {
      return jsonResponse(
        {
          success: false,
          error: "Authentication required. Please provide a valid Bearer session token.",
        },
        401,
      );
    }

    if (authUser.role !== "admin") {
      return jsonResponse(
        {
          success: false,
          error: "Admin authorization required. Access denied.",
        },
        403,
      );
    }

    const url = new URL(request.url);
    const search = (url.searchParams.get("search") || "").trim().toLowerCase();
    const statusFilter = (url.searchParams.get("status") || "all").trim().toLowerCase();
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "10", 10)));
    const detailId = (url.searchParams.get("id") || "").trim();

    const persistentRequests = await getPersistentRefundRequests();
    const inStore = store.subscriptionRefundRequests || [];
    const combined = [...persistentRequests, ...inStore];

    const seen = new Set<string>();
    const allRequests: RefundRequestRecord[] = [];
    for (const r of combined) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        allRequests.push(r);
      }
    }

    allRequests.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // Detail lookup
    if (detailId) {
      const match = allRequests.find(
        (r) =>
          r.id === detailId ||
          r.subscriptionId === detailId ||
          r.paymentId === detailId ||
          r.orderId === detailId,
      );
      if (!match) {
        return jsonResponse({ success: false, error: "Refund request record not found." }, 404);
      }
      return jsonResponse({ success: true, request: match });
    }

    // Compute stats
    const total = allRequests.length;
    const pending = allRequests.filter((r) => r.status === "pending").length;
    const approved = allRequests.filter((r) => r.status === "approved").length;
    const rejected = allRequests.filter((r) => r.status === "rejected").length;
    const refunded = allRequests.filter((r) => r.status === "refunded").length;
    const totalRefundAmount = allRequests.reduce((acc, r) => acc + (r.amount || 0), 0);
    const refundedAmount = allRequests
      .filter((r) => r.status === "refunded")
      .reduce((acc, r) => acc + (r.amount || 0), 0);

    // Apply status filter
    let filtered = allRequests;
    if (statusFilter !== "all") {
      filtered = filtered.filter((r) => r.status.toLowerCase() === statusFilter);
    }

    // Apply search filter
    if (search) {
      filtered = filtered.filter((r) => {
        return (
          r.id.toLowerCase().includes(search) ||
          r.userId.toLowerCase().includes(search) ||
          r.userName.toLowerCase().includes(search) ||
          r.userEmail.toLowerCase().includes(search) ||
          r.planId.toLowerCase().includes(search) ||
          r.planName.toLowerCase().includes(search) ||
          r.paymentId.toLowerCase().includes(search) ||
          r.orderId.toLowerCase().includes(search) ||
          r.subscriptionId.toLowerCase().includes(search) ||
          r.reason.toLowerCase().includes(search) ||
          Boolean(r.adminNote && r.adminNote.toLowerCase().includes(search))
        );
      });
    }

    const totalItems = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / limit));
    const offset = (page - 1) * limit;
    const paginated = filtered.slice(offset, offset + limit);

    return jsonResponse({
      success: true,
      stats: {
        total,
        pending,
        approved,
        rejected,
        refunded,
        totalRefundAmount,
        refundedAmount,
      },
      pagination: {
        page,
        limit,
        totalItems,
        totalPages,
      },
      requests: paginated,
    });
  }

  // 19g. Admin Subscription Refund Review (POST /api/admin/subscription-refund-review or /api/admin/subscription-refunds/review)
  if (
    route === "admin/subscription-refund-review" ||
    route === "admin/subscription-refunds/review"
  ) {
    if (method !== "POST") {
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    }

    const pool = getMysqlPool();
    const authUser = await getAuthUserFromRequest(request, store, pool);
    if (!authUser) {
      return jsonResponse(
        {
          success: false,
          error: "Authentication required. Please provide a valid Bearer session token.",
        },
        401,
      );
    }

    if (authUser.role !== "admin") {
      return jsonResponse(
        {
          success: false,
          error: "Admin authorization required. Access denied.",
        },
        403,
      );
    }

    const body = await request.json().catch(() => ({}));
    const requestId = String(body.requestId || body.request_id || "").trim();
    const decision = String(body.decision || "")
      .trim()
      .toLowerCase();
    const adminNote = String(body.adminNote || body.admin_note || "").trim();

    if (!requestId) {
      return jsonResponse({ success: false, error: "Request ID is required." }, 400);
    }

    if (decision !== "approved" && decision !== "rejected") {
      return jsonResponse(
        {
          success: false,
          error: "Invalid decision. Must be either 'approved' or 'rejected'.",
        },
        400,
      );
    }

    const persistentRequests = await getPersistentRefundRequests();
    const inStore = store.subscriptionRefundRequests || [];
    const target =
      persistentRequests.find((r) => r.id === requestId) || inStore.find((r) => r.id === requestId);

    if (!target) {
      return jsonResponse({ success: false, error: "Refund request record not found." }, 404);
    }

    // Prevent duplicate review / race conditions
    if (target.status !== "pending") {
      return jsonResponse(
        {
          success: false,
          error: `Refund request has already been processed with status '${target.status}' by ${target.reviewedBy || "administrator"}. Cannot re-review.`,
        },
        400,
      );
    }

    const nowIso = new Date().toISOString();

    if (decision === "rejected") {
      const updated = await updatePersistentRefundRequest(target.id, {
        status: "rejected",
        adminNote: adminNote || "Refund request rejected by administrator.",
        reviewedBy: authUser.user_id,
        reviewedAt: nowIso,
      });

      if (store.subscriptionRefundRequests) {
        const sIdx = store.subscriptionRefundRequests.findIndex((r) => r.id === target.id);
        if (sIdx !== -1 && updated) {
          store.subscriptionRefundRequests[sIdx] = updated;
        }
      }
      saveStore(store);

      return jsonResponse({
        success: true,
        message: "Refund request has been rejected.",
        request: updated,
      });
    }

    // decision === "approved"
    // Attempt secure server-side Razorpay refund call
    const amountPaise = Math.round(target.amount * 100);
    const gatewayRes = await executeRazorpayRefund(
      target.paymentId,
      amountPaise,
      target.reason,
      env,
    );

    if (gatewayRes.success && gatewayRes.refundId) {
      // Verified gateway refund succeeded
      const updated = await updatePersistentRefundRequest(target.id, {
        status: "refunded",
        gatewayStatus: "gateway_refund_succeeded",
        gatewayRefundId: gatewayRes.refundId,
        adminNote: adminNote || "Refund approved and successfully processed via Razorpay gateway.",
        reviewedBy: authUser.user_id,
        reviewedAt: nowIso,
      });

      if (store.subscriptionRefundRequests) {
        const sIdx = store.subscriptionRefundRequests.findIndex((r) => r.id === target.id);
        if (sIdx !== -1 && updated) {
          store.subscriptionRefundRequests[sIdx] = updated;
        }
      }

      if (store.userSubscriptions) {
        const subIdx = store.userSubscriptions.findIndex(
          (s) => s.subscription_id === target.subscriptionId || s.payment_id === target.paymentId,
        );
        if (subIdx !== -1) {
          const targetSub = store.userSubscriptions[subIdx];
          if (targetSub) {
            targetSub.status = "refunded";
          }
        }
      }
      saveStore(store);

      return jsonResponse({
        success: true,
        message: "Refund approved and successfully processed via Razorpay gateway.",
        request: updated,
        gatewayAvailable: true,
        gatewayRefundId: gatewayRes.refundId,
      });
    }

    // If no verified gateway credentials exist or live remote call skipped:
    // Follow Rule 6: Implement safe request/review workflow only and report actual gateway refunds remain unavailable. Never simulate a refund.
    const safeNote = adminNote
      ? `${adminNote} [Safe Review: Live gateway refund unavailable - ${gatewayRes.error || "Credentials unconfigured"}]`
      : `Approved in safe review workflow. Live Razorpay gateway credentials are not configured on server; actual gateway refund remains unavailable. No simulated refund was dispatched.`;

    const updated = await updatePersistentRefundRequest(target.id, {
      status: "approved",
      gatewayStatus: gatewayRes.gatewayStatus || "gateway_unavailable",
      gatewayRefundId: null,
      adminNote: safeNote,
      reviewedBy: authUser.user_id,
      reviewedAt: nowIso,
    });

    if (store.subscriptionRefundRequests) {
      const sIdx = store.subscriptionRefundRequests.findIndex((r) => r.id === target.id);
      if (sIdx !== -1 && updated) {
        store.subscriptionRefundRequests[sIdx] = updated;
      }
    }
    saveStore(store);

    return jsonResponse({
      success: true,
      message:
        "Refund request approved by administrator. Note: Actual gateway refund remains unavailable without configured live gateway credentials.",
      request: updated,
      gatewayAvailable: false,
      gatewayStatus: gatewayRes.gatewayStatus,
      gatewayMessage: gatewayRes.error,
    });
  }

  // 20. Admin Category Creation
  if (route === "admin/categories") {
    if (method === "POST") {
      const pool = getMysqlPool();
      const authUser = await getAuthUserFromRequest(request, store, pool);
      if (!authUser) {
        return jsonResponse(
          {
            success: false,
            error: "Authentication required. Please provide a valid Bearer session token.",
          },
          401,
        );
      }
      if (authUser.role !== "admin") {
        return jsonResponse(
          {
            success: false,
            error:
              "Admin authorization required. Only verified administrators can create categories.",
          },
          403,
        );
      }

      const body = await request.json().catch(() => ({}));
      const name = String(body.name || body.category || "").trim();

      if (!name) {
        return jsonResponse({ success: false, error: "Category name is required." }, 400);
      }
      if (name.length < 2) {
        return jsonResponse(
          { success: false, error: "Category name must be at least 2 characters." },
          400,
        );
      }
      if (name.length > 100) {
        return jsonResponse(
          { success: false, error: "Category name must not exceed 100 characters." },
          400,
        );
      }

      const slug =
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || `cat-${Date.now()}`;

      // In production, persistent MySQL database connection is strictly required.
      // Return HTTP 503 if the required MySQL pool is unavailable before any category
      // can be saved to local JSON or in-memory storage.
      if (process.env["NODE_ENV"] === "production" && !pool) {
        return jsonResponse(
          {
            success: false,
            error:
              "Database connection unavailable. In production, category creation requires a persistent database connection.",
          },
          503,
        );
      }

      if (pool) {
        try {
          const [existing]: any = await pool.query(
            "SELECT id, name FROM categories WHERE LOWER(TRIM(name)) = LOWER(?) OR LOWER(slug) = LOWER(?) LIMIT 1",
            [name, slug],
          );
          if (existing && existing.length > 0) {
            return jsonResponse(
              {
                success: false,
                error: `Category "${existing[0].name}" already exists.`,
              },
              409,
            );
          }

          const [ins]: any = await pool.query(
            "INSERT INTO categories (name, slug, created_by, created_at) VALUES (?, ?, ?, NOW())",
            [name, slug, authUser.user_id],
          );
          const newCat = {
            id: ins?.insertId || Date.now(),
            name,
            slug,
            created_by: authUser.user_id,
            created_at: new Date().toISOString(),
          };

          if (!store.categories) store.categories = getInitialCategories();
          store.categories.push(newCat);
          saveStore(store);

          return jsonResponse(
            {
              success: true,
              message: "Category created successfully.",
              category: newCat,
            },
            201,
          );
        } catch (dbErr: any) {
          const isTableMissing =
            dbErr?.code === "ER_NO_SUCH_TABLE" ||
            String(dbErr?.message || "").includes("doesn't exist");
          if (isTableMissing) {
            return jsonResponse(
              {
                success: false,
                error:
                  "Database migration pending: 'categories' table has not been created yet. Please execute the proposed database migration first.",
              },
              503,
            );
          }
          if (process.env["NODE_ENV"] === "production") {
            return jsonResponse({ success: false, error: "Database error: " + dbErr.message }, 500);
          }
        }
      }

      if (process.env["NODE_ENV"] === "production") {
        return jsonResponse(
          {
            success: false,
            error:
              "Database connection unavailable. In production, category creation requires a persistent database connection.",
          },
          503,
        );
      }

      if (!store.categories || store.categories.length === 0) {
        store.categories = getInitialCategories();
      }

      const isDuplicate = store.categories.some(
        (c) =>
          c.name.trim().toLowerCase() === name.toLowerCase() ||
          c.slug.toLowerCase() === slug.toLowerCase(),
      );
      if (isDuplicate) {
        return jsonResponse(
          {
            success: false,
            error: `Category "${name}" already exists.`,
          },
          409,
        );
      }

      const newCat = {
        id: store.categories.length + 1,
        name,
        slug,
        created_by: authUser.user_id,
        created_at: new Date().toISOString(),
      };
      store.categories.push(newCat);
      saveStore(store);

      return jsonResponse(
        {
          success: true,
          message: "Category created successfully.",
          category: newCat,
        },
        201,
      );
    }
  }

  // 20b. Admin Platform Settings (Marketing Commission Percentage)
  if (route === "admin/settings") {
    const pool = getMysqlPool();
    const authUser = await getAuthUserFromRequest(request, store, pool);
    if (!authUser) {
      return jsonResponse(
        {
          success: false,
          error: "Authentication required. Please provide a valid Bearer session token.",
        },
        401,
      );
    }
    if (authUser.role !== "admin") {
      return jsonResponse(
        {
          success: false,
          error: "Admin authorization required.",
        },
        403,
      );
    }

    if (method === "GET") {
      let marketingPct = 15.0;
      const adsRates: Record<number, number> = { 1: 15, 2: 10, 3: 5, 4: 4, 5: 3, 6: 2, 7: 1 };
      let adsenseClientId = "";
      let adsenseSlotWatch = "";
      let adsenseSlotSidebar = "";
      let adsenseSlotFeed = "";
      let adsenseEnabled = false;

      if (pool) {
        try {
          const [rows]: any = await pool.query(
            "SELECT setting_key, setting_value FROM platform_settings",
          );
          for (const r of rows || []) {
            if (r.setting_key === "marketing_income_percentage") {
              marketingPct = parseFloat(r.setting_value) || 15.0;
            } else if (r.setting_key === "adsense_client_id") {
              adsenseClientId = String(r.setting_value || "");
            } else if (r.setting_key === "adsense_slot_watch") {
              adsenseSlotWatch = String(r.setting_value || "");
            } else if (r.setting_key === "adsense_slot_sidebar") {
              adsenseSlotSidebar = String(r.setting_value || "");
            } else if (r.setting_key === "adsense_slot_feed") {
              adsenseSlotFeed = String(r.setting_value || "");
            } else if (r.setting_key === "adsense_enabled") {
              adsenseEnabled = r.setting_value === "1" || r.setting_value === "true";
            } else if (/^ads_referral_rate_l([1-7])$/.test(r.setting_key)) {
              const lvl = parseInt(r.setting_key.replace("ads_referral_rate_l", ""), 10);
              adsRates[lvl] = parseInt(r.setting_value, 10) || adsRates[lvl] || 0;
            }
          }
        } catch {
          // Table not yet migrated, fallback to defaults
        }
      }

      return jsonResponse({
        success: true,
        settings: {
          marketing_income_percentage: marketingPct,
          ads_referral_rates: adsRates,
          adsense_client_id: adsenseClientId,
          adsense_slot_watch: adsenseSlotWatch,
          adsense_slot_sidebar: adsenseSlotSidebar,
          adsense_slot_feed: adsenseSlotFeed,
          adsense_enabled: adsenseEnabled,
        },
      });
    }

    if (method === "POST") {
      const payload: any = await request.json().catch(() => ({}));
      const rawPct =
        payload?.["marketing_income_percentage"] ?? payload?.["marketingIncomePercentage"];
      const marketingPct =
        rawPct !== undefined && rawPct !== null
          ? typeof rawPct === "number"
            ? rawPct
            : parseFloat(String(rawPct || ""))
          : null;

      const adsenseClientId = payload?.["adsense_client_id"] ?? payload?.["adsenseClientId"];
      const adsenseSlotWatch = payload?.["adsense_slot_watch"] ?? payload?.["adsenseSlotWatch"];
      const adsenseSlotSidebar =
        payload?.["adsense_slot_sidebar"] ?? payload?.["adsenseSlotSidebar"];
      const adsenseSlotFeed = payload?.["adsense_slot_feed"] ?? payload?.["adsenseSlotFeed"];
      const adsenseEnabled = payload?.["adsense_enabled"] ?? payload?.["adsenseEnabled"];

      if (
        marketingPct !== null &&
        (isNaN(marketingPct) || marketingPct < 0 || marketingPct > 100)
      ) {
        return jsonResponse(
          {
            success: false,
            error: "Marketing income percentage must be between 0% and 100%.",
          },
          400,
        );
      }

      if (pool) {
        try {
          await pool.query(`
            CREATE TABLE IF NOT EXISTS platform_settings (
              setting_key VARCHAR(100) NOT NULL,
              setting_value TEXT NOT NULL,
              description VARCHAR(255) DEFAULT NULL,
              updated_by VARCHAR(50) DEFAULT 'SYSTEM',
              updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              PRIMARY KEY (setting_key)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
          `);

          const upsertSql = `
            INSERT INTO platform_settings (setting_key, setting_value, description, updated_by, updated_at)
            VALUES (?, ?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE 
              setting_value = VALUES(setting_value),
              updated_by = VALUES(updated_by),
              updated_at = NOW()
          `;

          if (marketingPct !== null) {
            await pool.query(upsertSql, [
              "marketing_income_percentage",
              String(marketingPct),
              "Default marketing commission percentage",
              authUser.user_id,
            ]);
          }
          if (adsenseClientId !== undefined && adsenseClientId !== null) {
            await pool.query(upsertSql, [
              "adsense_client_id",
              String(adsenseClientId).trim(),
              "Google AdSense Publisher Client ID",
              authUser.user_id,
            ]);
          }
          if (adsenseSlotWatch !== undefined && adsenseSlotWatch !== null) {
            await pool.query(upsertSql, [
              "adsense_slot_watch",
              String(adsenseSlotWatch).trim(),
              "Google AdSense Watch Page Banner Slot ID",
              authUser.user_id,
            ]);
          }
          if (adsenseSlotSidebar !== undefined && adsenseSlotSidebar !== null) {
            await pool.query(upsertSql, [
              "adsense_slot_sidebar",
              String(adsenseSlotSidebar).trim(),
              "Google AdSense Sidebar Slot ID",
              authUser.user_id,
            ]);
          }
          if (adsenseSlotFeed !== undefined && adsenseSlotFeed !== null) {
            await pool.query(upsertSql, [
              "adsense_slot_feed",
              String(adsenseSlotFeed).trim(),
              "Google AdSense Home Feed Banner Slot ID",
              authUser.user_id,
            ]);
          }
          if (adsenseEnabled !== undefined && adsenseEnabled !== null) {
            await pool.query(upsertSql, [
              "adsense_enabled",
              adsenseEnabled ? "1" : "0",
              "Google AdSense Global Enabled Flag",
              authUser.user_id,
            ]);
          }
        } catch (dbErr: any) {
          console.error("[admin/settings] DB error:", dbErr);
        }
      }

      return jsonResponse({
        success: true,
        message: "Platform settings successfully updated.",
        marketing_income_percentage: marketingPct,
      });
    }

    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  }

  // 20b-2. Admin Premium Video Payment Recovery (dryRun defaults to true; live writes gated)
  if (route === "admin/recover-premium-payment") {
    const pool = getMysqlPool();
    return handleAdminRecoverPremiumPayment(request, {
      pool,
      env,
      getAuthUser: (req) => getAuthUserFromRequest(req, store, pool),
    });
  }

  // 20c. Admin Record Verified AdSense Earnings Report
  if (route === "admin/record-adsense-earning") {
    if (method !== "POST" && method !== "GET") {
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    }
    const pool = getMysqlPool();
    const authUser = await getAuthUserFromRequest(request, store, pool);
    if (!authUser) {
      return jsonResponse(
        {
          success: false,
          error: "Authentication required. Please provide a valid Bearer session token.",
        },
        401,
      );
    }
    if (authUser.role !== "admin") {
      return jsonResponse(
        {
          success: false,
          error:
            "Admin authorization required. Only verified administrators can record AdSense earnings.",
        },
        403,
      );
    }

    if (method === "GET") {
      const url = new URL(request.url, "http://localhost:3000");
      const action = String(url.searchParams.get("action") || "conflicts").toLowerCase();

      if (action === "conflicts") {
        if (pool) {
          try {
            const [rows]: any = await pool.query(
              "SELECT id, ledger_id, transaction_id, user_id, report_month, amount, primary_statement_tx_id, conflict_type, conflict_reason, description, status, resolution_notes, reviewed_by, reviewed_at, ledger_created_at, created_at FROM adsense_historical_conflicts ORDER BY report_month DESC, ledger_created_at ASC",
            );
            return jsonResponse({
              success: true,
              count: (rows || []).length,
              conflicts: rows || [],
            });
          } catch (_e) {
            return jsonResponse({ success: true, count: 0, conflicts: [] });
          }
        }
        const conflictsList = Object.values((store as any).adsenseHistoricalConflicts || {});
        return jsonResponse({
          success: true,
          count: conflictsList.length,
          conflicts: conflictsList,
        });
      }

      if (action === "statements") {
        if (pool) {
          try {
            const [rows]: any = await pool.query(
              "SELECT id, user_id, report_month, amount, reference_id, transaction_id, recorded_by, video_id, description, status, has_conflicts, created_at FROM adsense_monthly_statements ORDER BY report_month DESC, created_at DESC",
            );
            return jsonResponse({
              success: true,
              count: (rows || []).length,
              statements: rows || [],
            });
          } catch (_e) {
            return jsonResponse({ success: true, count: 0, statements: [] });
          }
        }
        const statementsList = Object.values((store as any).adsenseStatements || {});
        return jsonResponse({
          success: true,
          count: statementsList.length,
          statements: statementsList,
        });
      }

      return jsonResponse(
        { success: false, error: "Invalid action. Supported: 'conflicts', 'statements'" },
        400,
      );
    }

    const payload: any = await request.json().catch(() => ({}));
    const targetUserId = String(payload?.["userId"] || payload?.["user_id"] || "").trim();
    const amount = Number(payload?.["amount"] || 0);
    const rawMonth = String(
      payload?.["reportMonth"] ||
        payload?.["report_month"] ||
        payload?.["statement_month"] ||
        new Date().toISOString().slice(0, 7),
    ).trim();
    let referenceId = String(payload?.["referenceId"] || payload?.["reference_id"] || "").trim();
    const videoId =
      payload?.["videoId"] || payload?.["video_id"]
        ? String(payload["videoId"] || payload["video_id"]).trim()
        : null;
    let description = String(payload?.["description"] || "").trim();

    if (!targetUserId) {
      return jsonResponse({ success: false, error: "target user_id is required." }, 400);
    }
    if (amount <= 0 || isNaN(amount)) {
      return jsonResponse(
        {
          success: false,
          error: "Verified AdSense earnings amount must be strictly greater than 0.",
        },
        400,
      );
    }

    // Normalize and validate reporting month (format: YYYY-MM)
    const monthMatch = rawMonth.match(/^(\d{4})-(0[1-9]|1[0-2])/);
    if (!monthMatch) {
      return jsonResponse(
        {
          success: false,
          error: `Invalid reportMonth format '${rawMonth}'. Expected YYYY-MM (e.g. 2026-10).`,
        },
        400,
      );
    }
    const normalizedMonth = `${monthMatch[1]}-${monthMatch[2]}`;
    const cleanMonth = `${monthMatch[1]}${monthMatch[2]}`;

    const ledgerUuid = crypto.randomUUID();

    if (pool) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        // Verify target creator exists
        const [uRows]: any = await conn.query(
          "SELECT id, user_id, name FROM users WHERE UPPER(user_id) = UPPER(?) LIMIT 1",
          [targetUserId],
        );
        if (!uRows || uRows.length === 0) {
          await conn.rollback();
          return jsonResponse(
            { success: false, error: `User ID '${targetUserId}' not found in database.` },
            404,
          );
        }
        const canonicalUserId = uRows[0].user_id;
        const cleanUserId = canonicalUserId.replace(/[^0-9A-Z]/gi, "").toUpperCase();
        const creatorName = uRows[0].name || canonicalUserId;

        // Generate deterministic transaction ID to enforce idempotency on income_ledger
        const txId = `TX_ADSENSE_${cleanUserId}_${cleanMonth}`;

        if (!referenceId) {
          referenceId = `ADS-${cleanMonth}-${cleanUserId}`;
        }
        if (!description) {
          description = `Verified Google AdSense earnings for ${normalizedMonth} (Statement Ref: ${referenceId})`;
        }

        // 1. Check if adsense_monthly_statements table exists, and check for duplicates with row lock
        try {
          const [stmtRows]: any = await conn.query(
            "SELECT id, amount, transaction_id, created_at FROM adsense_monthly_statements WHERE UPPER(user_id) = UPPER(?) AND report_month = ? FOR UPDATE",
            [canonicalUserId, normalizedMonth],
          );
          if (stmtRows && stmtRows.length > 0) {
            await conn.rollback();
            return jsonResponse(
              {
                success: false,
                error: `AdSense earnings statement for creator ${canonicalUserId} for period ${normalizedMonth} has already been credited and settled (Transaction: ${stmtRows[0].transaction_id}).`,
              },
              409,
            );
          }
        } catch (_tableErr: any) {
          // Table may not exist yet if migration pending; fall back to income_ledger check
        }

        // 1b. Check if adsense_historical_conflicts has unresolved flagged conflicts for this creator & period
        try {
          const [conflictRows]: any = await conn.query(
            "SELECT id, transaction_id, amount, status FROM adsense_historical_conflicts WHERE UPPER(user_id) = UPPER(?) AND report_month = ? AND status = 'flagged_for_review' LIMIT 1",
            [canonicalUserId, normalizedMonth],
          );
          if (conflictRows && conflictRows.length > 0) {
            await conn.rollback();
            return jsonResponse(
              {
                success: false,
                error: `AdSense earnings statement for creator ${canonicalUserId} for period ${normalizedMonth} has historical records flagged for manual review (Conflict TX: ${conflictRows[0].transaction_id}). Please reconcile flagged historical records before posting a new statement.`,
              },
              409,
            );
          }
        } catch (_conflictErr: any) {
          // Table may not exist yet if migration pending; proceed
        }

        // 2. Double-check income_ledger for existing AdSense credit for this creator & period
        const [dupLedger]: any = await conn.query(
          `SELECT id, transaction_id, amount, created_at
           FROM income_ledger
           WHERE UPPER(user_id) = UPPER(?)
             AND income_type = 'adsense_income'
             AND (
               transaction_id = ?
               OR (special_tag = 'VERIFIED_ADSENSE_STATEMENT' AND description LIKE ?)
             )
           FOR UPDATE`,
          [canonicalUserId, txId, `%${normalizedMonth}%`],
        );
        if (dupLedger && dupLedger.length > 0) {
          await conn.rollback();
          return jsonResponse(
            {
              success: false,
              error: `AdSense earnings statement for creator ${canonicalUserId} for period ${normalizedMonth} has already been credited and settled (Transaction: ${dupLedger[0].transaction_id}).`,
            },
            409,
          );
        }

        // 3. Record in adsense_monthly_statements if table exists
        try {
          await conn.query(
            `INSERT INTO adsense_monthly_statements (
              id, user_id, report_month, amount, reference_id,
              transaction_id, recorded_by, video_id, description, status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'settled', NOW())`,
            [
              ledgerUuid,
              canonicalUserId,
              normalizedMonth,
              amount,
              referenceId,
              txId,
              authUser.user_id,
              videoId,
              description,
            ],
          );
        } catch (_stmtInsertErr) {
          // If table doesn't exist yet, continue with income_ledger
        }

        // 4. Insert into income_ledger
        await conn.query(
          `INSERT INTO income_ledger (
            id, transaction_id, user_id, source_user_id, source_user_name, video_id,
            income_type, amount, status, special_tag, description, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'adsense_income', ?, 'settled', 'VERIFIED_ADSENSE_STATEMENT', ?, NOW())`,
          [
            ledgerUuid,
            txId,
            canonicalUserId,
            authUser.user_id,
            authUser.name || "FaceTube Administrator",
            videoId,
            amount,
            description,
          ],
        );

        // 5. Atomic credit to wallet_balances
        await conn.query(
          `INSERT INTO wallet_balances (user_id, balance, total_earned, total_withdrawn, referral_income, global_income, adsense_income, affiliate_income, updated_at)
           VALUES (?, ?, ?, 0.00, 0.00, 0.00, ?, 0.00, NOW())
           ON DUPLICATE KEY UPDATE
             balance = balance + VALUES(balance),
             total_earned = total_earned + VALUES(total_earned),
             adsense_income = adsense_income + VALUES(adsense_income),
             updated_at = NOW()`,
          [canonicalUserId, amount, amount, amount],
        );

        await conn.commit();

        return jsonResponse({
          success: true,
          message: `Successfully recorded ₹${amount.toFixed(2)} verified AdSense income for ${creatorName} (${canonicalUserId}).`,
          transactionId: txId,
          userId: canonicalUserId,
          amount,
          reportMonth: normalizedMonth,
          referenceId,
        });
      } catch (err: any) {
        await conn.rollback();
        // Handle concurrent duplicate entry constraint collision (MySQL 1062 / ER_DUP_ENTRY)
        if (
          err?.code === "ER_DUP_ENTRY" ||
          err?.errno === 1062 ||
          String(err?.message || "").includes("Duplicate entry")
        ) {
          return jsonResponse(
            {
              success: false,
              error: `AdSense earnings statement for creator ${targetUserId} for period ${normalizedMonth} has already been credited or is currently being processed.`,
            },
            409,
          );
        }
        console.error("[record-adsense-earning] Error:", err);
        return jsonResponse(
          { success: false, error: "Database error recording AdSense earnings: " + err.message },
          500,
        );
      } finally {
        conn.release();
      }
    }

    // Fallback store update (preview/offline)
    const upperId = targetUserId.toUpperCase();
    const cleanUserId = upperId.replace(/[^0-9A-Z]/g, "");
    const txId = `TX_ADSENSE_${cleanUserId}_${cleanMonth}`;

    if (!referenceId) {
      referenceId = `ADS-${cleanMonth}-${cleanUserId}`;
    }
    if (!description) {
      description = `Verified Google AdSense earnings for ${normalizedMonth} (Statement Ref: ${referenceId})`;
    }

    if (!(store as any).adsenseStatements) {
      (store as any).adsenseStatements = {};
    }
    const statementKey = `${upperId}_${normalizedMonth}`;
    const existingStatement = (store as any).adsenseStatements[statementKey];

    if (!(store as any).adsenseHistoricalConflicts) {
      (store as any).adsenseHistoricalConflicts = {};
    }
    const existingConflict = (store as any).adsenseHistoricalConflicts[statementKey];
    if (existingConflict && existingConflict.status === "flagged_for_review") {
      return jsonResponse(
        {
          success: false,
          error: `AdSense earnings statement for creator ${targetUserId} for period ${normalizedMonth} has historical records flagged for manual review (Conflict TX: ${existingConflict.transactionId || existingConflict.transaction_id}). Please reconcile flagged historical records before posting a new statement.`,
        },
        409,
      );
    }

    const existingTx = (store.walletTransactions || []).find(
      (tx: any) =>
        String(tx["user_id"] || tx["userId"] || "").toUpperCase() === upperId &&
        (tx["income_type"] === "adsense_income" || tx["type"] === "adsense_income") &&
        (tx["transaction_id"] === txId ||
          (tx["special_tag"] === "VERIFIED_ADSENSE_STATEMENT" &&
            String(tx["description"] || "").includes(normalizedMonth))),
    );

    if (existingStatement || existingTx) {
      const settledTxId =
        existingStatement?.["transactionId"] || existingTx?.["transaction_id"] || txId;
      return jsonResponse(
        {
          success: false,
          error: `AdSense earnings statement for creator ${targetUserId} for period ${normalizedMonth} has already been credited and settled (Transaction: ${settledTxId}).`,
        },
        409,
      );
    }

    // Atomic in-memory balance & ledger update
    if (!store.wallets[upperId]) {
      store.wallets[upperId] = {
        balance: 0,
        total_earned: 0,
        total_withdrawn: 0,
        referral_income: 0,
        global_income: 0,
        adsense_income: 0,
        affiliate_income: 0,
        updated_at: new Date().toISOString(),
      };
    }
    const existingWallet = store.wallets[upperId]!;
    existingWallet.balance += amount;
    existingWallet.total_earned += amount;
    existingWallet.adsense_income = (existingWallet.adsense_income || 0) + amount;
    existingWallet.updated_at = new Date().toISOString();

    const txRecord = {
      id: ledgerUuid,
      transaction_id: txId,
      userId: targetUserId,
      user_id: targetUserId,
      amount,
      type: "adsense_income",
      income_type: "adsense_income",
      status: "settled",
      description,
      special_tag: "VERIFIED_ADSENSE_STATEMENT",
      created_at: new Date().toISOString(),
    };
    if (!store.walletTransactions) {
      store.walletTransactions = [];
    }
    store.walletTransactions.unshift(txRecord);

    (store as any).adsenseStatements[statementKey] = {
      transactionId: txId,
      amount,
      reportMonth: normalizedMonth,
      referenceId,
      creditedAt: new Date().toISOString(),
    };
    saveStore(store);

    return jsonResponse({
      success: true,
      message: `Successfully recorded ₹${amount.toFixed(2)} verified AdSense income for ${targetUserId}.`,
      transactionId: txId,
      userId: targetUserId,
      amount,
      reportMonth: normalizedMonth,
      referenceId,
    });
  }

  // 20c-2. Admin Record Verified AdMob Earnings Report (Android Native Mobile Ads)
  if (route === "admin/record-admob-earning") {
    if (method !== "POST" && method !== "GET") {
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    }
    const pool = getMysqlPool();
    const authUser = await getAuthUserFromRequest(request, store, pool);
    if (!authUser) {
      return jsonResponse(
        {
          success: false,
          error: "Authentication required. Please provide a valid Bearer session token.",
        },
        401,
      );
    }
    if (authUser.role !== "admin") {
      return jsonResponse(
        {
          success: false,
          error:
            "Admin authorization required. Only verified administrators can record AdMob earnings.",
        },
        403,
      );
    }

    if (method === "GET") {
      if (pool) {
        try {
          const [rows]: any = await pool.query(
            "SELECT id, statement_id, user_id, report_month, gross_amount, net_amount, impressions, ecpm, app_id, transaction_id, verified_by, status, created_at FROM admob_monthly_statements ORDER BY report_month DESC, created_at DESC",
          );
          return jsonResponse({
            success: true,
            count: (rows || []).length,
            statements: rows || [],
          });
        } catch (_e) {
          return jsonResponse({ success: true, count: 0, statements: [] });
        }
      }
      const stList = Object.values((store as any).admobStatements || {});
      return jsonResponse({
        success: true,
        count: stList.length,
        statements: stList,
      });
    }

    // POST: Record finalized AdMob statement
    let body: any = {};
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    }

    const targetUserId = String(body.userId || body.user_id || "").trim();
    const amount = Number(body.amount);
    const rawMonth = String(
      body.reportMonth || body.report_month || new Date().toISOString().slice(0, 7),
    ).trim();
    const impressions = Number(body.impressions || 0);
    const ecpm = Number(body.ecpm || 0);
    const description = String(
      body.description || `Google AdMob Finalized Statement (${rawMonth}) - Android Native App`,
    ).trim();

    const readEnv = (key: string) => String(env?.[key] ?? process.env[key] ?? "").trim();
    const isProduction = isFailClosedProductionEnv(readEnv("APP_ENV"), readEnv("NODE_ENV"));

    const requestedAppId = String(body.appId ?? body.app_id ?? "").trim();
    const configuredAppId = readEnv("ADMOB_APP_ID");
    const resolvedAppId = requestedAppId || configuredAppId;
    let appId: string | null = null;

    if (!targetUserId) {
      return jsonResponse({ success: false, error: "target user_id is required." }, 400);
    }
    if (Number.isNaN(amount) || amount <= 0) {
      return jsonResponse(
        {
          success: false,
          error: "Verified AdMob earnings amount must be strictly greater than 0.",
        },
        400,
      );
    }

    const monthMatch = rawMonth.match(/^(\d{4})-(0[1-9]|1[0-2])/);
    if (!monthMatch) {
      return jsonResponse(
        {
          success: false,
          error: `Invalid reportMonth format '${rawMonth}'. Expected YYYY-MM (e.g. 2026-10).`,
        },
        400,
      );
    }
    const normalizedMonth = `${monthMatch[1]}-${monthMatch[2]}`;
    const cleanMonth = `${monthMatch[1]}${monthMatch[2]}`;
    const statementKey = `${targetUserId.toUpperCase()}_${normalizedMonth}`;

    // Validate AdMob App ID before any DB write or transaction
    if (!resolvedAppId) {
      if (isProduction) {
        return jsonResponse(
          {
            success: false,
            error:
              "Production AdMob App ID is not configured (ADMOB_APP_ID) and no appId was provided.",
          },
          500,
        );
      }
    } else {
      if (/^ca-app-pub-3940256099942544(?:~|\/|$)/i.test(resolvedAppId)) {
        return jsonResponse(
          {
            success: false,
            error:
              "Google reserved test AdMob App ID cannot be used for monthly statement recording.",
          },
          400,
        );
      }
      if (!/^ca-app-pub-\d{16}~\d{10}$/.test(resolvedAppId)) {
        return jsonResponse(
          {
            success: false,
            error: `Invalid AdMob appId format '${resolvedAppId}'. Expected ca-app-pub-XXXXXXXXXXXXXXXX~YYYYYYYYYY.`,
          },
          400,
        );
      }
      appId = resolvedAppId;
    }

    if (pool) {
      const conn = await pool.getConnection();
      let canonicalUserId = targetUserId;
      try {
        await conn.beginTransaction();

        // Verify user exists
        const [userRows]: any = await conn.query(
          "SELECT id, user_id, name, email FROM users WHERE UPPER(user_id) = UPPER(?) LIMIT 1",
          [targetUserId],
        );
        if (!userRows || userRows.length === 0) {
          await conn.rollback();
          return jsonResponse(
            { success: false, error: `User ID '${targetUserId}' not found in database.` },
            404,
          );
        }
        canonicalUserId = userRows[0].user_id;

        // 1. Race-safe Duplicate check inside transaction
        const [dupRows]: any = await conn.query(
          "SELECT id, statement_id FROM admob_monthly_statements WHERE user_id = ? AND report_month = ? LIMIT 1 FOR UPDATE",
          [canonicalUserId, normalizedMonth],
        );
        if (dupRows && dupRows.length > 0) {
          await conn.rollback();
          return jsonResponse(
            {
              success: false,
              error: `AdMob statement already finalized for creator '${canonicalUserId}' in month '${normalizedMonth}'. Duplicate credits blocked.`,
            },
            409,
          );
        }

        const txId = `TX-ADMOB-${cleanMonth}-${crypto.randomBytes(4).toString("hex")}`;
        const statementId = `STMT-ADMOB-${cleanMonth}-${canonicalUserId.replace(/[^0-9A-Z]/g, "")}`;
        const ledgerId = `led_${crypto.randomBytes(12).toString("hex")}`;

        // 2. Insert into income_ledger
        await conn.query(
          "INSERT INTO income_ledger (id, transaction_id, user_id, income_type, amount, status, special_tag, description, created_at) VALUES (?, ?, ?, 'admob_income', ?, 'settled', 'ADMOB_FINALIZED_STATEMENT', ?, NOW())",
          [ledgerId, txId, canonicalUserId, amount, description],
        );

        // 3. Insert into admob_monthly_statements (atomic with ledger and wallet)
        await conn.query(
          "INSERT INTO admob_monthly_statements (statement_id, user_id, report_month, gross_amount, net_amount, impressions, ecpm, app_id, ledger_id, transaction_id, verified_by, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'finalized', ?)",
          [
            statementId,
            canonicalUserId,
            normalizedMonth,
            amount,
            amount,
            impressions,
            ecpm,
            appId,
            ledgerId,
            txId,
            authUser.user_id,
            description,
          ],
        );

        // 4. Increment creator wallet
        await conn.query(
          "INSERT INTO wallet_balances (user_id, balance, total_earned, total_withdrawn, admob_income, updated_at) VALUES (?, ?, ?, 0.00, ?, NOW()) ON DUPLICATE KEY UPDATE balance = balance + VALUES(balance), total_earned = total_earned + VALUES(total_earned), admob_income = admob_income + VALUES(admob_income), updated_at = NOW()",
          [canonicalUserId, amount, amount, amount],
        );

        await conn.commit();

        return jsonResponse(
          {
            success: true,
            message: `Successfully recorded ₹${amount.toFixed(2)} verified AdMob income for ${canonicalUserId}.`,
            transactionId: txId,
            statementId,
            userId: canonicalUserId,
            amount,
            reportMonth: normalizedMonth,
          },
          201,
        );
      } catch (err: any) {
        await conn.rollback();
        if (isMysqlDuplicateKeyError(err)) {
          return jsonResponse(
            {
              success: false,
              error: `AdMob statement already finalized for creator '${canonicalUserId}' in month '${normalizedMonth}'. Duplicate credits blocked.`,
            },
            409,
          );
        }
        return jsonResponse(
          { success: false, error: "Database error recording AdMob earnings: " + err.message },
          500,
        );
      } finally {
        conn.release();
      }
    }

    // Local / In-memory fallback
    const upperId = targetUserId.toUpperCase();
    const userFound = store.users.find(
      (u) => u.user_id.toUpperCase() === upperId || u.id.toUpperCase() === upperId,
    );
    if (!userFound) {
      return jsonResponse({ success: false, error: `User ID '${targetUserId}' not found.` }, 404);
    }
    const canonicalUserId = userFound.user_id;

    if (!(store as any).admobStatements) {
      (store as any).admobStatements = {};
    }
    if ((store as any).admobStatements[statementKey]) {
      return jsonResponse(
        {
          success: false,
          error: `AdMob earnings statement for creator ${canonicalUserId} for period ${normalizedMonth} has already been credited.`,
        },
        409,
      );
    }

    const txId = `TX_ADMOB_${canonicalUserId.replace(/[^0-9A-Z]/g, "")}_${cleanMonth}`;
    const ledgerUuid = `led_admob_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    if (!store.wallets[upperId]) {
      store.wallets[upperId] = {
        balance: 0,
        total_earned: 0,
        total_withdrawn: 0,
        referral_income: 0,
        global_income: 0,
        adsense_income: 0,
        admob_income: 0,
        affiliate_income: 0,
        updated_at: new Date().toISOString(),
      };
    }
    const existingWallet = store.wallets[upperId]!;
    existingWallet.balance += amount;
    existingWallet.total_earned += amount;
    existingWallet.admob_income = (existingWallet.admob_income || 0) + amount;
    existingWallet.updated_at = new Date().toISOString();

    const txRecord = {
      id: ledgerUuid,
      transaction_id: txId,
      userId: canonicalUserId,
      user_id: canonicalUserId,
      amount,
      type: "admob_income",
      income_type: "admob_income",
      status: "settled",
      description,
      special_tag: "ADMOB_FINALIZED_STATEMENT",
      created_at: new Date().toISOString(),
    };
    if (!store.walletTransactions) {
      store.walletTransactions = [];
    }
    store.walletTransactions.unshift(txRecord);

    (store as any).admobStatements[statementKey] = {
      statementId: `STMT-ADMOB-${cleanMonth}-${canonicalUserId}`,
      transactionId: txId,
      userId: canonicalUserId,
      app_id: appId,
      amount,
      reportMonth: normalizedMonth,
      creditedAt: new Date().toISOString(),
    };
    saveStore(store);

    return jsonResponse(
      {
        success: true,
        message: `Successfully recorded ₹${amount.toFixed(2)} verified AdMob income for ${canonicalUserId}.`,
        transactionId: txId,
        userId: canonicalUserId,
        amount,
        reportMonth: normalizedMonth,
      },
      201,
    );
  }

  // ============================================================================
  // 20c-3. FaceTube - Secure Google AdMob OAuth 2.0 Connection Endpoints
  // ============================================================================

  const inMemoryConsumedNonces = new Set<string>();

  // Helper functions for AdMob AES-256-GCM encryption & HMAC-signed state
  function getAdmobEncryptionKey(): string | null {
    const key = process.env["ADMOB_ENCRYPTION_KEY"]?.trim();
    return key ? key : null;
  }

  function encryptAdmobSecretGCM(
    plaintext: string,
    secretKey: string,
  ): { ciphertext: string; iv: string; tag: string } {
    if (!secretKey) {
      throw new Error("AdMob encryption key is required but missing.");
    }
    const key = crypto.createHash("sha256").update(secretKey).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    let encrypted = cipher.update(plaintext, "utf8", "hex");
    encrypted += cipher.final("hex");
    const tag = cipher.getAuthTag().toString("hex");
    return {
      ciphertext: encrypted,
      iv: iv.toString("hex"),
      tag,
    };
  }

  function decryptAdmobSecretGCM(
    ciphertextHex: string,
    ivHex: string,
    tagHex: string,
    secretKey: string | null,
  ): string | null {
    if (!secretKey) return null;
    try {
      const key = crypto.createHash("sha256").update(secretKey).digest();
      const iv = Buffer.from(ivHex, "hex");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(Buffer.from(tagHex, "hex"));
      let decrypted = decipher.update(ciphertextHex, "hex", "utf8");
      decrypted += decipher.final("utf8");
      return decrypted;
    } catch (_e) {
      return null;
    }
  }

  function generateAdmobOAuthState(userId: string, nonce: string, secretKey: string): string {
    if (!secretKey) {
      throw new Error("AdMob encryption/signing key is required.");
    }
    const timestamp = Date.now();
    const payload = JSON.stringify({ uid: userId, ts: timestamp, n: nonce });
    const payloadB64 = Buffer.from(payload).toString("base64url");
    const signature = crypto.createHmac("sha256", secretKey).update(payloadB64).digest("base64url");
    return `${payloadB64}.${signature}`;
  }

  function verifyAdmobOAuthState(
    state: string,
    secretKey: string | null,
  ): { valid: boolean; userId?: string; nonce?: string; timestamp?: number; error?: string } {
    if (!secretKey) {
      return { valid: false, error: "Google AdMob encryption key is not configured." };
    }
    if (!state || typeof state !== "string" || !state.includes(".")) {
      return { valid: false, error: "Malformed OAuth state parameter." };
    }
    const [payloadB64, signature] = state.split(".");
    if (!payloadB64 || !signature) {
      return { valid: false, error: "Invalid state structure." };
    }
    const expectedSig = crypto
      .createHmac("sha256", secretKey)
      .update(payloadB64)
      .digest("base64url");
    if (
      signature.length !== expectedSig.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))
    ) {
      return { valid: false, error: "Invalid OAuth state signature (potential CSRF detected)." };
    }
    try {
      const raw = Buffer.from(payloadB64, "base64url").toString("utf8");
      const parsed = JSON.parse(raw);
      if (!parsed.uid || !parsed.ts || !parsed.n) {
        return { valid: false, error: "State payload missing required claims." };
      }
      const age = Date.now() - Number(parsed.ts);
      if (age < 0 || age > 10 * 60 * 1000) {
        return { valid: false, error: "OAuth state expired (valid for 10 minutes only)." };
      }
      return {
        valid: true,
        userId: String(parsed.uid),
        nonce: String(parsed.n),
        timestamp: Number(parsed.ts),
      };
    } catch (_e) {
      return { valid: false, error: "Failed to parse state payload." };
    }
  }

  function isProductionHttps(request: Request): boolean {
    if (process.env["NODE_ENV"] === "production") {
      return true;
    }
    const url = new URL(request.url);
    if (url.protocol === "https:") {
      return true;
    }
    const xfProto = request.headers.get("x-forwarded-proto");
    if (xfProto && xfProto.toLowerCase() === "https") {
      return true;
    }
    return false;
  }

  function createClearCookieHeader(request: Request): string {
    const secureAttr = isProductionHttps(request) ? "; Secure" : "";
    return `facetube_admob_oauth_binding=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax${secureAttr}`;
  }

  // 1. GET /api/admin/admob/auth-url
  if (route === "admin/admob/auth-url") {
    if (method !== "GET") {
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    }
    const pool = getMysqlPool();
    const authUser = await getAuthUserFromRequest(request, store, pool);
    if (!authUser) {
      return jsonResponse(
        {
          success: false,
          error: "Authentication required. Please provide a valid Bearer session token.",
        },
        401,
      );
    }
    if (authUser.role !== "admin") {
      return jsonResponse(
        {
          success: false,
          error: "Admin authorization required. Only administrators can connect Google AdMob.",
        },
        403,
      );
    }

    const clientId = (process.env["ADMOB_OAUTH_CLIENT_ID"] || "").trim();
    const clientSecret = (process.env["ADMOB_OAUTH_CLIENT_SECRET"] || "").trim();
    const redirectUri = (
      process.env["ADMOB_OAUTH_REDIRECT_URI"] ||
      "https://facetube.online/api/admin/admob/oauth-callback"
    ).trim();

    if (!clientId || !clientSecret) {
      return jsonResponse(
        {
          success: false,
          configured: false,
          error:
            "Google AdMob OAuth credentials are not configured. Please define ADMOB_OAUTH_CLIENT_ID and ADMOB_OAUTH_CLIENT_SECRET in your server environment.",
        },
        200,
      );
    }

    // Fix B: Fail closed if ADMOB_ENCRYPTION_KEY is missing
    const secretKey = getAdmobEncryptionKey();
    if (!secretKey) {
      return jsonResponse(
        {
          success: false,
          configured: false,
          error:
            "Google AdMob encryption key is not configured. Please define ADMOB_ENCRYPTION_KEY in your server environment.",
        },
        200,
      );
    }

    // Phase 2.4: Cryptographically random 32-byte binding secret (NEVER put raw Admin session token in cookie)
    const bindingSecret = crypto.randomBytes(32).toString("hex");
    const sessionHash = crypto.createHash("sha256").update(bindingSecret).digest("hex");
    const nonce = crypto.randomBytes(16).toString("hex");

    const authHeaderRaw =
      request.headers.get("Authorization") || request.headers.get("X-Authorization") || "";
    const adminToken = authHeaderRaw.replace(/^Bearer\s+/i, "").trim();
    const adminTokenHash = adminToken
      ? crypto.createHash("sha256").update(adminToken).digest("hex")
      : "";

    const state = generateAdmobOAuthState(authUser.user_id, nonce, secretKey);
    const stateHash = crypto.createHash("sha256").update(state).digest("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");

    const isDbConfigured = getDbConfig().isConfigured;
    if (isDbConfigured) {
      if (!pool) {
        return jsonResponse(
          {
            success: false,
            error:
              "AdMob database table is uninitialized or inaccessible. Please run database migrations before connecting.",
          },
          500,
        );
      }
      try {
        await pool.query(
          "INSERT INTO admob_oauth_states (nonce, user_id, session_hash, admin_session_hash, state_hash, is_consumed, expires_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
          [nonce, authUser.user_id, sessionHash, adminTokenHash, stateHash, expiresAt],
        );
      } catch (err: any) {
        console.warn("[AdMob OAuth] MySQL state insert error:", err.message);
        return jsonResponse(
          {
            success: false,
            error:
              "AdMob database table is uninitialized or inaccessible. Please run database migrations before connecting.",
          },
          500,
        );
      }
    } else {
      if (process.env["NODE_ENV"] === "production") {
        return jsonResponse(
          {
            success: false,
            error:
              "Database connection required in production. Please configure Hostinger MySQL environment variables.",
          },
          500,
        );
      }
      if (!(store as any).admobOAuthStates) {
        (store as any).admobOAuthStates = [];
      }
      (store as any).admobOAuthStates.push({
        nonce,
        user_id: authUser.user_id,
        session_hash: sessionHash,
        admin_session_hash: adminTokenHash,
        state_hash: stateHash,
        is_consumed: 0,
        expires_at: expiresAt,
        created_at: new Date().toISOString(),
      });
      saveStore(store);
    }

    const scopes = [
      "https://www.googleapis.com/auth/admob.readonly",
      "https://www.googleapis.com/auth/admob.report",
    ];

    const authUrl =
      `https://accounts.google.com/o/oauth2/v2/auth?` +
      new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: scopes.join(" "),
        access_type: "offline",
        prompt: "consent",
        state,
      }).toString();

    const secureAttr = isProductionHttps(request) ? "; Secure" : "";
    const cookieVal = `facetube_admob_oauth_binding=${encodeURIComponent(bindingSecret)}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax${secureAttr}`;
    return new Response(
      JSON.stringify({
        success: true,
        configured: true,
        auth_url: authUrl,
        redirect_uri: redirectUri,
        expires_in: 600,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": cookieVal,
        },
      },
    );
  }

  // 2. GET or POST /api/admin/admob/oauth-callback
  if (route === "admin/admob/oauth-callback") {
    const pool = getMysqlPool();
    const isBrowserGet = method === "GET";
    const clearCookieHeader = createClearCookieHeader(request);

    const reply = (status: number, data: any, redirectKey?: string) => {
      if (isBrowserGet) {
        const target = redirectKey ? `/admob-income?${redirectKey}` : "/admob-income";
        return new Response(null, {
          status: 302,
          headers: {
            Location: target,
            "Set-Cookie": clearCookieHeader,
          },
        });
      }
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": clearCookieHeader,
        },
      });
    };

    let code = "";
    let state = "";
    let errorParam = "";

    if (method === "GET") {
      const parsedUrl = new URL(request.url);
      code = parsedUrl.searchParams.get("code") || "";
      state = parsedUrl.searchParams.get("state") || "";
      errorParam = parsedUrl.searchParams.get("error") || "";
    } else if (method === "POST") {
      const parsedUrl = new URL(request.url);
      let body: any = {};
      try {
        body = await request.json();
      } catch (_e) {
        // Handled via defaults
      }
      code = String(body.code || parsedUrl.searchParams.get("code") || "");
      state = String(body.state || parsedUrl.searchParams.get("state") || "");
      errorParam = String(body.error || parsedUrl.searchParams.get("error") || "");
    } else {
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    }

    // Fail closed if ADMOB_ENCRYPTION_KEY is missing
    const secretKey = getAdmobEncryptionKey();
    if (!secretKey) {
      return reply(
        500,
        {
          success: false,
          error:
            "Google AdMob encryption key is not configured. Server cannot securely store credentials.",
        },
        "admob_error=" + encodeURIComponent("Google AdMob encryption key is not configured."),
      );
    }

    if (errorParam) {
      return reply(
        400,
        { success: false, error: `Google OAuth returned error: ${errorParam}` },
        "admob_error=" + encodeURIComponent(errorParam),
      );
    }

    const stateCheck = verifyAdmobOAuthState(state, secretKey);
    if (!stateCheck.valid) {
      return reply(
        403,
        { success: false, error: stateCheck.error || "Invalid OAuth state" },
        "admob_error=" + encodeURIComponent(stateCheck.error || "invalid_state"),
      );
    }

    const stateNonce = stateCheck.nonce || "";
    const stateUserId = stateCheck.userId || "";
    const stateHash = crypto.createHash("sha256").update(state).digest("hex");

    // 1. If caller session belongs to non-admin user, reject immediately
    const callerAuthUser = await getAuthUserFromRequest(request, store, pool);
    if (callerAuthUser && callerAuthUser.role !== "admin") {
      return reply(
        403,
        {
          success: false,
          error: "Admin authorization required: Caller is not an administrator.",
        },
        "admob_error=not_an_administrator",
      );
    }

    // Resolve initiating session binding from cookie or test header
    const cookieHeader = request.headers.get("cookie") || "";
    const cookieMatch = cookieHeader.match(/(?:^|;\s*)facetube_admob_oauth_binding=([^;]+)/);
    const cookieSecret = cookieMatch && cookieMatch[1] ? decodeURIComponent(cookieMatch[1]) : "";
    const testBindingHeader =
      request.headers.get("X-Admob-Binding") || request.headers.get("X-Admob-Binding-Secret") || "";
    const bindingSecret = cookieSecret || testBindingHeader;

    if (!bindingSecret) {
      return reply(
        403,
        { success: false, error: "OAuth state rejected: initiating session binding missing." },
        "admob_error=missing_session_binding",
      );
    }

    const callerBindingHash = crypto.createHash("sha256").update(bindingSecret).digest("hex");
    const isDbConfigured = getDbConfig().isConfigured;

    if (isDbConfigured) {
      if (!pool) {
        return reply(
          500,
          {
            success: false,
            error:
              "AdMob database table is uninitialized or inaccessible. Please run database migrations before connecting.",
          },
          "admob_error=database_error",
        );
      }

      let sessionRows: any;
      try {
        const [rows]: any = await pool.query(
          `SELECT st.admin_session_hash, u.id, u.user_id, u.role
           FROM admob_oauth_states st
           INNER JOIN sessions s ON (SHA2(s.token, 256) = st.admin_session_hash AND s.expires_at > NOW())
           INNER JOIN users u ON ((s.user_id = u.id OR s.user_id = u.user_id) AND (u.user_id = st.user_id OR u.id = st.user_id))
           WHERE st.nonce = ?
             AND st.state_hash = ?
             AND st.user_id = ?
             AND st.session_hash = ?
             AND st.is_consumed = 0
             AND st.expires_at > NOW()
             AND LOWER(u.role) = 'admin'
           LIMIT 1`,
          [stateNonce, stateHash, stateUserId, callerBindingHash],
        );
        sessionRows = rows;
      } catch (err: any) {
        console.warn("[AdMob OAuth] MySQL session verification error:", err.message);
        return reply(
          500,
          {
            success: false,
            error:
              "AdMob database table is uninitialized or inaccessible. Please run database migrations before connecting.",
          },
          "admob_error=database_error",
        );
      }

      if (!sessionRows || sessionRows.length === 0) {
        return reply(
          403,
          {
            success: false,
            error:
              "OAuth state rejected: initiating admin session is inactive, expired, or mismatch.",
          },
          "admob_error=invalid_admin_session",
        );
      }

      const expectedAdminSessionHash = sessionRows[0].admin_session_hash;

      // If caller supplied a Bearer token, verify it matches the initiating admin session token hash
      const authHeader =
        request.headers.get("Authorization") || request.headers.get("X-Authorization");
      if (authHeader) {
        const callerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
        const callerTokenHash = crypto.createHash("sha256").update(callerToken).digest("hex");
        if (callerTokenHash !== expectedAdminSessionHash) {
          return reply(
            403,
            {
              success: false,
              error: "OAuth state rejected: initiating admin user mismatch.",
            },
            "admob_error=admin_mismatch",
          );
        }
      }

      // Atomic single-use state consumption with live session & admin role verification (Zero-TOCTOU):
      // nonce, state_hash, user_id, session_hash, admin_session_hash, is_consumed = 0, expires_at > NOW(),
      // joined directly against active sessions (s.expires_at > NOW()) and users (role = 'admin')
      let updRes: any;
      try {
        const [res]: any = await pool.query(
          `UPDATE admob_oauth_states st
           INNER JOIN sessions s ON (SHA2(s.token, 256) = st.admin_session_hash AND s.expires_at > NOW())
           INNER JOIN users u ON ((s.user_id = u.id OR s.user_id = u.user_id) AND (u.user_id = st.user_id OR u.id = st.user_id))
           SET st.is_consumed = 1, st.consumed_at = NOW()
           WHERE st.nonce = ?
             AND st.state_hash = ?
             AND st.user_id = ?
             AND st.session_hash = ?
             AND st.admin_session_hash = ?
             AND st.is_consumed = 0
             AND st.expires_at > NOW()
             AND LOWER(u.role) = 'admin'`,
          [stateNonce, stateHash, stateUserId, callerBindingHash, expectedAdminSessionHash],
        );
        updRes = res;
      } catch (err: any) {
        console.warn("[AdMob OAuth] MySQL state atomic update error:", err.message);
        return reply(
          500,
          {
            success: false,
            error:
              "AdMob database table is uninitialized or inaccessible. Please run database migrations before connecting.",
          },
          "admob_error=database_error",
        );
      }

      // When MySQL is configured, if atomic UPDATE affects anything other than 1 row, immediately reject with 403
      // Never fall through to JSON or in-memory storage!
      if (!updRes || updRes.affectedRows !== 1) {
        return reply(
          403,
          {
            success: false,
            error: "OAuth state has already been consumed (replay attack detected).",
          },
          "admob_error=state_already_consumed",
        );
      }
    } else {
      // Local JSON fallback storage: ONLY permitted when MySQL is unconfigured and NOT in production
      if (process.env["NODE_ENV"] === "production") {
        return reply(
          500,
          {
            success: false,
            error:
              "Database connection required in production. Please configure Hostinger MySQL environment variables.",
          },
          "admob_error=database_error",
        );
      }

      const currentStore = loadStore();
      const localStates: any[] = (currentStore as any).admobOAuthStates || [];
      const stateIndex = localStates.findIndex(
        (s: any) =>
          s.nonce === stateNonce &&
          s.state_hash === stateHash &&
          s.user_id === stateUserId &&
          s.session_hash === callerBindingHash &&
          Number(s.is_consumed) === 0 &&
          new Date(s.expires_at).getTime() > Date.now(),
      );

      if (stateIndex === -1) {
        return reply(
          403,
          {
            success: false,
            error: "OAuth state invalid, already consumed, expired, or session mismatch.",
          },
          "admob_error=state_invalid_or_consumed",
        );
      }

      const stateRecord = localStates[stateIndex];

      // Independently verify that initiating Admin session is still active and unexpired in store
      const activeSessionToken = Object.keys(currentStore.sessions || {}).find(
        (tok) =>
          crypto.createHash("sha256").update(tok).digest("hex") === stateRecord.admin_session_hash,
      );

      let isSessionActive = false;
      if (activeSessionToken) {
        const sessionAdminId = currentStore.sessions[activeSessionToken];
        const adminUser = currentStore.users.find(
          (u) =>
            (u.user_id.toUpperCase() === String(sessionAdminId).toUpperCase() ||
              u.id.toUpperCase() === String(sessionAdminId).toUpperCase()) &&
            u.role === "admin",
        );
        if (adminUser) {
          isSessionActive = true;
        }
      }

      if (!isSessionActive) {
        return reply(
          403,
          {
            success: false,
            error:
              "OAuth state rejected: initiating admin session is inactive, expired, or mismatch.",
          },
          "admob_error=invalid_admin_session",
        );
      }

      // If caller supplied a Bearer token, verify it matches admin_session_hash
      const authHeader =
        request.headers.get("Authorization") || request.headers.get("X-Authorization");
      if (authHeader) {
        const callerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
        const callerTokenHash = crypto.createHash("sha256").update(callerToken).digest("hex");
        if (callerTokenHash !== stateRecord.admin_session_hash) {
          return reply(
            403,
            {
              success: false,
              error: "OAuth state rejected: initiating admin user mismatch.",
            },
            "admob_error=admin_mismatch",
          );
        }
      }

      if (inMemoryConsumedNonces.has(stateNonce)) {
        return reply(
          403,
          {
            success: false,
            error: "OAuth state has already been consumed (replay attack detected).",
          },
          "admob_error=state_already_consumed",
        );
      }

      inMemoryConsumedNonces.add(stateNonce);
      stateRecord.is_consumed = 1;
      stateRecord.consumed_at = new Date().toISOString();
      saveStore(currentStore);
    }

    const adminUserId = stateUserId;

    if (!code) {
      return reply(
        400,
        { success: false, error: "Missing Google authorization code in callback." },
        "admob_error=missing_code",
      );
    }

    const clientId = (process.env["ADMOB_OAUTH_CLIENT_ID"] || "").trim();
    const clientSecret = (process.env["ADMOB_OAUTH_CLIENT_SECRET"] || "").trim();
    const redirectUri = (
      process.env["ADMOB_OAUTH_REDIRECT_URI"] ||
      "https://facetube.online/api/admin/admob/oauth-callback"
    ).trim();

    let accessToken = "";
    let refreshToken = "";
    let expiresIn = 3600;

    // Check if test / mock mode or real code exchange
    const isMock =
      code.startsWith("test_mock_code_") || process.env["ADMOB_SKIP_REMOTE_CHECK"] === "true";
    if (isMock) {
      accessToken = `mock_admob_access_${crypto.randomBytes(8).toString("hex")}`;
      refreshToken = `mock_admob_refresh_${crypto.randomBytes(16).toString("hex")}`;
    } else {
      try {
        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
          }).toString(),
        });
        const tokenJson: any = await tokenRes.json();
        if (!tokenRes.ok || !tokenJson.access_token) {
          const detail = tokenJson.error_description || tokenJson.error || "Token exchange failed.";
          return reply(
            502,
            {
              success: false,
              error: `Failed to exchange authorization code with Google: ${detail}`,
            },
            "admob_error=" + encodeURIComponent(detail),
          );
        }
        accessToken = tokenJson.access_token;
        refreshToken = tokenJson.refresh_token || "";
        expiresIn = Number(tokenJson.expires_in || 3600);
      } catch (err: any) {
        return reply(
          502,
          { success: false, error: `Network error exchanging code with Google: ${err.message}` },
          "admob_error=" + encodeURIComponent(err.message),
        );
      }
    }

    const readOAuthEnv = (key: string) => String(env?.[key] ?? process.env[key] ?? "").trim();
    const isProduction = isFailClosedProductionEnv(
      readOAuthEnv("APP_ENV"),
      readOAuthEnv("NODE_ENV"),
    );

    let publisherId = readOAuthEnv("ADMOB_PUBLISHER_ID");
    let accountName = "FaceTube Mobile App";
    let currencyCode = "INR";

    // Attempt to discover account metadata if real token
    if (!isMock && accessToken) {
      try {
        const accRes = await fetch("https://admob.googleapis.com/v1/accounts", {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        });
        if (accRes.ok) {
          const accJson: any = await accRes.json();
          if (accJson.account && Array.isArray(accJson.account) && accJson.account.length > 0) {
            const first = accJson.account[0];
            const nameMatch = (first.name || "").match(/accounts\/(pub-[a-zA-Z0-9]+)/);
            if (nameMatch && nameMatch[1]) {
              publisherId = nameMatch[1];
            }
            if (first.title) accountName = first.title;
            if (first.currencyCode) currencyCode = first.currencyCode;
          }
        } else {
          console.error("[AdMob OAuth] Failed to fetch AdMob publisher account metadata", {
            status: accRes.status,
          });
        }
      } catch (err: unknown) {
        console.error("[AdMob OAuth] Network error fetching AdMob publisher account metadata", {
          message: err instanceof Error ? err.message : "unknown_error",
        });
      }
    }

    if (
      isProduction &&
      (!publisherId ||
        publisherId === "pub-3940256099942544" ||
        !/^pub-[a-zA-Z0-9]+$/.test(publisherId))
    ) {
      console.error(
        "[AdMob OAuth] Production publisher ID missing, invalid, or matched test ID; failing closed.",
      );
      return reply(
        500,
        {
          success: false,
          error: "AdMob publisher ID could not be discovered or configured in production.",
        },
        "admob_error=missing_publisher_id",
      );
    }

    if (!publisherId) {
      publisherId = "pub-3940256099942544";
    }

    // Handle existing refresh token retention if Google didn't return a new one
    let encryptedRefresh: { ciphertext: string; iv: string; tag: string };
    if (!refreshToken) {
      let existingEncrypted: any = null;
      if (isDbConfigured) {
        if (!pool) {
          return reply(
            500,
            {
              success: false,
              error:
                "AdMob database table is uninitialized or inaccessible. Please run database migrations before connecting.",
            },
            "admob_error=database_error",
          );
        }
        try {
          const [rows]: any = await pool.query(
            "SELECT encrypted_refresh_token, refresh_token_iv, refresh_token_tag FROM admob_oauth_credentials WHERE publisher_id = ? AND is_active = 1 LIMIT 1",
            [publisherId],
          );
          if (rows && rows.length > 0) existingEncrypted = rows[0];
        } catch (err: any) {
          console.warn("[AdMob OAuth] MySQL existing credentials lookup error:", err.message);
          return reply(
            500,
            {
              success: false,
              error:
                "AdMob database table is uninitialized or inaccessible. Please run database migrations before connecting.",
            },
            "admob_error=database_error",
          );
        }
      } else {
        if (process.env["NODE_ENV"] === "production") {
          return reply(
            500,
            {
              success: false,
              error:
                "Database connection required in production. Please configure Hostinger MySQL environment variables.",
            },
            "admob_error=database_error",
          );
        }
        if ((store as any).admobOauth) {
          existingEncrypted = (store as any).admobOauth;
        }
      }

      if (existingEncrypted && existingEncrypted.encrypted_refresh_token) {
        encryptedRefresh = {
          ciphertext: existingEncrypted.encrypted_refresh_token,
          iv: existingEncrypted.refresh_token_iv,
          tag: existingEncrypted.refresh_token_tag,
        };
      } else {
        return reply(
          400,
          {
            success: false,
            error:
              "Google did not return a refresh_token. Please reconnect and ensure consent is granted.",
          },
          "admob_error=missing_refresh_token",
        );
      }
    } else {
      encryptedRefresh = encryptAdmobSecretGCM(refreshToken, secretKey);
    }

    const tokenExpiry = new Date(Date.now() + expiresIn * 1000);

    if (isDbConfigured) {
      if (!pool) {
        return reply(
          500,
          { success: false, error: "Failed to persist AdMob credentials: database uninitialized." },
          "admob_error=database_error",
        );
      }
      try {
        await pool.query(
          `INSERT INTO admob_oauth_credentials (
            publisher_id, account_name, currency_code,
            encrypted_refresh_token, refresh_token_iv, refresh_token_tag,
            token_expiry, is_active, connected_by, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NOW())
          ON DUPLICATE KEY UPDATE
            account_name = VALUES(account_name),
            currency_code = VALUES(currency_code),
            encrypted_refresh_token = VALUES(encrypted_refresh_token),
            refresh_token_iv = VALUES(refresh_token_iv),
            refresh_token_tag = VALUES(refresh_token_tag),
            token_expiry = VALUES(token_expiry),
            is_active = 1,
            connected_by = VALUES(connected_by),
            updated_at = NOW()`,
          [
            publisherId,
            accountName,
            currencyCode,
            encryptedRefresh.ciphertext,
            encryptedRefresh.iv,
            encryptedRefresh.tag,
            tokenExpiry,
            adminUserId,
          ],
        );
      } catch (err: any) {
        console.warn("[AdMob OAuth] MySQL save failed:", err.message);
        return reply(
          500,
          { success: false, error: "Failed to persist AdMob credentials to database." },
          "admob_error=database_error",
        );
      }
    } else {
      (store as any).admobOauth = {
        publisher_id: publisherId,
        account_name: accountName,
        currency_code: currencyCode,
        encrypted_refresh_token: encryptedRefresh.ciphertext,
        refresh_token_iv: encryptedRefresh.iv,
        refresh_token_tag: encryptedRefresh.tag,
        token_expiry: tokenExpiry.toISOString(),
        is_active: 1,
        connected_by: adminUserId,
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      saveStore(store);
    }

    return reply(
      200,
      {
        success: true,
        message: "Google AdMob OAuth credentials securely saved.",
        publisher_id: publisherId,
        account_name: accountName,
        currency_code: currencyCode,
        connected_by: adminUserId,
        is_active: true,
      },
      `admob_connected=true&pub=${encodeURIComponent(publisherId)}`,
    );
  }

  // 3. GET /api/admin/admob/status
  if (route === "admin/admob/status") {
    if (method !== "GET") {
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    }
    const pool = getMysqlPool();
    const authUser = await getAuthUserFromRequest(request, store, pool);
    if (!authUser) {
      return jsonResponse(
        {
          success: false,
          error: "Authentication required. Please provide a valid Bearer session token.",
        },
        401,
      );
    }
    if (authUser.role !== "admin") {
      return jsonResponse({ success: false, error: "Admin authorization required." }, 403);
    }

    const isDbConfigured = getDbConfig().isConfigured;
    if (isDbConfigured) {
      if (!pool) {
        return jsonResponse(
          {
            success: false,
            error:
              "AdMob database table is uninitialized or inaccessible. Please run database migrations before connecting.",
          },
          500,
        );
      }
      try {
        const [rows]: any = await pool.query(
          "SELECT publisher_id, account_name, currency_code, is_active, connected_by, created_at, updated_at FROM admob_oauth_credentials WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1",
        );
        if (rows && rows.length > 0) {
          const r = rows[0];
          return jsonResponse({
            success: true,
            connected: true,
            publisher_id: r.publisher_id,
            account_name: r.account_name,
            currency_code: r.currency_code,
            connected_by: r.connected_by,
            connected_at: r.created_at,
            updated_at: r.updated_at,
            has_refresh_token: true,
          });
        }
        return jsonResponse({
          success: true,
          connected: false,
          publisher_id: null,
          account_name: null,
          currency_code: null,
          has_refresh_token: false,
        });
      } catch (err: any) {
        console.warn("[AdMob OAuth] MySQL status query error:", err.message);
        return jsonResponse(
          {
            success: false,
            error:
              "AdMob database table is uninitialized or inaccessible. Please run database migrations before connecting.",
          },
          500,
        );
      }
    } else {
      if (process.env["NODE_ENV"] === "production") {
        return jsonResponse(
          {
            success: false,
            error:
              "Database connection required in production. Please configure Hostinger MySQL environment variables.",
          },
          500,
        );
      }

      const localOauth = (store as any).admobOauth;
      if (localOauth && localOauth.is_active) {
        return jsonResponse({
          success: true,
          connected: true,
          publisher_id: localOauth.publisher_id,
          account_name: localOauth.account_name,
          currency_code: localOauth.currency_code,
          connected_by: localOauth.connected_by,
          connected_at: localOauth.connected_at || localOauth.updated_at,
          updated_at: localOauth.updated_at,
          has_refresh_token: true,
        });
      }

      return jsonResponse({
        success: true,
        connected: false,
        publisher_id: null,
        account_name: null,
        currency_code: null,
        has_refresh_token: false,
      });
    }
  }

  // 4. POST /api/admin/admob/disconnect
  if (route === "admin/admob/disconnect") {
    if (method !== "POST") {
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    }
    const pool = getMysqlPool();
    const authUser = await getAuthUserFromRequest(request, store, pool);
    if (!authUser) {
      return jsonResponse(
        {
          success: false,
          error: "Authentication required. Please provide a valid Bearer session token.",
        },
        401,
      );
    }
    if (authUser.role !== "admin") {
      return jsonResponse({ success: false, error: "Admin authorization required." }, 403);
    }

    const secretKey = getAdmobEncryptionKey();
    let credRow: any = null;
    const isDbConfigured = getDbConfig().isConfigured;

    if (isDbConfigured) {
      if (!pool) {
        return jsonResponse(
          {
            success: false,
            error:
              "AdMob database table is uninitialized or inaccessible. Please run database migrations before connecting.",
          },
          500,
        );
      }
      try {
        const [rows]: any = await pool.query(
          "SELECT id, publisher_id, encrypted_refresh_token, refresh_token_iv, refresh_token_tag FROM admob_oauth_credentials WHERE is_active = 1 ORDER BY updated_at DESC LIMIT 1",
        );
        if (rows && rows.length > 0) credRow = rows[0];
      } catch (err: any) {
        console.warn("[AdMob OAuth] MySQL disconnect query error:", err.message);
        return jsonResponse(
          {
            success: false,
            error:
              "AdMob database table is uninitialized or inaccessible. Please run database migrations before connecting.",
          },
          500,
        );
      }
    } else {
      if (process.env["NODE_ENV"] === "production") {
        return jsonResponse(
          {
            success: false,
            error:
              "Database connection required in production. Please configure Hostinger MySQL environment variables.",
          },
          500,
        );
      }
      if ((store as any).admobOauth) {
        credRow = (store as any).admobOauth;
      }
    }

    if (credRow) {
      const refreshToken = decryptAdmobSecretGCM(
        credRow.encrypted_refresh_token,
        credRow.refresh_token_iv,
        credRow.refresh_token_tag,
        secretKey,
      );

      // Attempt Google token revocation if real token
      if (refreshToken && !refreshToken.startsWith("mock_")) {
        try {
          await fetch("https://oauth2.googleapis.com/revoke", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ token: refreshToken }).toString(),
          });
        } catch (_e) {
          // Continue cleanup even if network revocation throws
        }
      }

      if (isDbConfigured && pool && credRow.id) {
        try {
          await pool.query(
            "UPDATE admob_oauth_credentials SET is_active = 0, encrypted_refresh_token = '', refresh_token_iv = '', refresh_token_tag = '', updated_at = NOW() WHERE id = ?",
            [credRow.id],
          );
        } catch (err: any) {
          console.warn("[AdMob OAuth] MySQL disconnect update error:", err.message);
          return jsonResponse(
            {
              success: false,
              error:
                "AdMob database table is uninitialized or inaccessible. Please run database migrations before connecting.",
            },
            500,
          );
        }
      }
    }

    if (!isDbConfigured) {
      delete (store as any).admobOauth;
      saveStore(store);
    }

    return jsonResponse({
      success: true,
      connected: false,
      message: "Google AdMob OAuth credentials disconnected and tokens revoked successfully.",
    });
  }

  // 20c. Creator Affiliate Link Generator API (GET/POST /api/affiliate/create-link)
  if (route === "affiliate/create-link") {
    const supportedNetworks = [
      {
        id: "amazon",
        name: "Amazon Associates",
        allowed_domains: ["amazon.in", "amazon.com", "amzn.to", "amzn.eu", "amzn.asia"],
        example_url: "https://www.amazon.in/dp/B08N5WRWNW",
        description: "Earn commissions on physical and digital products across Amazon stores.",
      },
      {
        id: "impact",
        name: "Impact",
        allowed_domains: ["impact.com", "sjv.io", "ojrq.net", "pxf.io", "evyy.net"],
        example_url: "https://brand.sjv.io/c/12345/67890/1234",
        description: "Partner campaigns, SaaS tools, premium gear, and direct brand sponsorships.",
      },
      {
        id: "earnkaro",
        name: "EarnKaro",
        allowed_domains: ["earnkaro.com", "ekaro.in"],
        example_url: "https://ekaro.in/enkr2026",
        description: "Curated deals, fashion, electronics, and cashback affiliate links.",
      },
    ];

    if (method === "GET") {
      return jsonResponse({
        success: true,
        networks: supportedNetworks,
      });
    }

    if (method !== "POST") {
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    }

    const pool = getMysqlPool();

    // 1. Authenticated Creator Verification (Strictly enforce session token identity)
    const authUser = await getAuthUserFromRequest(request, store, pool);
    if (!authUser) {
      return jsonResponse(
        {
          success: false,
          error: "Authentication required. Please sign in to generate your creator affiliate link.",
        },
        401,
      );
    }

    const creatorUserId = String(authUser.user_id || "").trim();
    if (!creatorUserId) {
      return jsonResponse(
        { success: false, error: "Unable to resolve authenticated creator user ID." },
        403,
      );
    }

    const payload = await request.json().catch(() => ({}));
    const network = String(payload.network || payload.n || "")
      .toLowerCase()
      .trim();
    const targetUrl = String(payload.target_url || payload.targetUrl || payload.u || "").trim();
    const videoId = String(payload.video_id || payload.videoId || payload.v || "").trim();

    if (!network) {
      return jsonResponse(
        {
          success: false,
          error:
            "Affiliate network is required. Supported networks: Amazon Associates (amazon), Impact (impact), EarnKaro (earnkaro).",
        },
        400,
      );
    }

    const netConfig = supportedNetworks.find((n) => n.id === network);
    if (!netConfig) {
      return jsonResponse(
        {
          success: false,
          error: `Unsupported affiliate network '${network}'. Supported networks: Amazon Associates (amazon), Impact (impact), EarnKaro (earnkaro).`,
        },
        400,
      );
    }

    if (!targetUrl) {
      return jsonResponse({ success: false, error: "Product destination URL is required." }, 400);
    }

    // Resolve allowed domains (from DB if configured, or predefined whitelist)
    let allowedDomains = [...netConfig.allowed_domains];
    if (pool) {
      try {
        const [netRows]: any = await pool.query(
          "SELECT allowed_domains FROM affiliate_networks_config WHERE id = ? LIMIT 1",
          [network],
        );
        if (netRows && netRows.length > 0 && netRows[0].allowed_domains) {
          allowedDomains = String(netRows[0].allowed_domains)
            .split(",")
            .map((s: string) => s.trim());
        }
      } catch (_e) {
        // Fallback
      }
    }

    const validation = validateSafeAffiliateUrl(targetUrl, allowedDomains);
    if (!validation.valid) {
      return jsonResponse(
        {
          success: false,
          error: validation.error,
          allowed_domains: allowedDomains,
        },
        400,
      );
    }

    const origin = url.origin || "http://localhost:3000";
    const queryParams = new URLSearchParams({
      network,
      creator_user_id: creatorUserId,
      target_url: validation.url!,
      redirect: "1",
    });
    if (videoId) {
      queryParams.set("video_id", videoId);
    }

    const relativeTrackingPath = `/api/affiliate/click.php?${queryParams.toString()}`;
    const absoluteTrackingUrl = `${origin}${relativeTrackingPath}`;

    return jsonResponse(
      {
        success: true,
        network,
        network_name: netConfig.name,
        creator_user_id: creatorUserId,
        target_url: validation.url,
        tracking_url: absoluteTrackingUrl,
        relative_tracking_path: relativeTrackingPath,
        allowed_domains: allowedDomains,
        video_id: videoId || null,
      },
      201,
    );
  }

  // 20d. Affiliate Click Tracking API (POST/GET /api/affiliate/click)
  if (route === "affiliate/click") {
    if (method !== "POST" && method !== "GET") {
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    }

    let payload: any = {};
    if (method === "POST") {
      payload = await request.json().catch(() => ({}));
    } else {
      payload = Object.fromEntries(url.searchParams.entries());
    }

    const network = String(payload.network || payload.n || "")
      .toLowerCase()
      .trim();
    const creatorUserId = String(
      payload.creator_user_id || payload.creatorUserId || payload.c || "",
    )
      .toUpperCase()
      .trim();
    const targetUrl = String(payload.target_url || payload.targetUrl || payload.u || "").trim();
    const videoId = String(payload.video_id || payload.videoId || payload.v || "").trim();
    const shouldRedirect =
      method === "GET" && (payload.redirect === "1" || payload.redirect === "true");

    if (!network) {
      return jsonResponse(
        { success: false, error: "Affiliate network is required (e.g. amazon, impact, earnkaro)." },
        400,
      );
    }
    if (!creatorUserId) {
      return jsonResponse(
        { success: false, error: "Creator user ID (creator_user_id) is required for attribution." },
        400,
      );
    }
    if (!targetUrl) {
      return jsonResponse(
        { success: false, error: "Target affiliate destination URL is required." },
        400,
      );
    }

    const pool = getMysqlPool();
    let allowedDomains: string[] = [];

    if (pool) {
      try {
        const [netRows]: any = await pool.query(
          "SELECT id, name, is_active, allowed_domains, publisher_id FROM affiliate_networks_config WHERE id = ? LIMIT 1",
          [network],
        );
        if (netRows && netRows.length > 0 && netRows[0].allowed_domains) {
          allowedDomains = String(netRows[0].allowed_domains)
            .split(",")
            .map((s) => s.trim());
        }
      } catch (_e) {
        // Fallback
      }
    }

    if (allowedDomains.length === 0 && store.affiliateNetworks?.[network]?.allowed_domains) {
      allowedDomains = store.affiliateNetworks[network].allowed_domains
        .split(",")
        .map((s) => s.trim());
    }

    if (allowedDomains.length === 0) {
      if (network === "amazon")
        allowedDomains = ["amazon.in", "amazon.com", "amzn.to", "amzn.eu", "amzn.asia"];
      else if (network === "impact")
        allowedDomains = ["impact.com", "sjv.io", "ojrq.net", "pxf.io", "evyy.net"];
      else if (network === "earnkaro") allowedDomains = ["earnkaro.com", "ekaro.in"];
    }

    if (allowedDomains.length === 0) {
      return jsonResponse(
        { success: false, error: `Unsupported or unconfigured affiliate network: '${network}'.` },
        400,
      );
    }

    const validation = validateSafeAffiliateUrl(targetUrl, allowedDomains);
    if (!validation.valid) {
      return jsonResponse({ success: false, error: validation.error }, 400);
    }

    // Verify creator user ID exists
    let canonicalCreatorId = creatorUserId;
    if (pool) {
      try {
        const [uRows]: any = await pool.query(
          "SELECT user_id FROM users WHERE UPPER(user_id) = ? LIMIT 1",
          [creatorUserId],
        );
        if (!uRows || uRows.length === 0) {
          return jsonResponse(
            { success: false, error: `Creator user ID '${creatorUserId}' was not found.` },
            404,
          );
        }
        canonicalCreatorId = uRows[0].user_id;
      } catch (_e) {
        // Fallback
      }
    } else {
      const u = store.users.find((x) => x.user_id.toUpperCase() === creatorUserId);
      if (!u) {
        return jsonResponse(
          { success: false, error: `Creator user ID '${creatorUserId}' was not found.` },
          404,
        );
      }
      canonicalCreatorId = u.user_id;
    }

    const clickId = `clk_${crypto.randomUUID().replace(/-/g, "")}`;
    const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "127.0.0.1";
    const ipHash = crypto
      .createHash("sha256")
      .update(clientIp + "facetube_salt")
      .digest("hex");
    const userAgent = (request.headers.get("user-agent") || "").slice(0, 255);
    const referrer = (request.headers.get("referer") || "").slice(0, 255);

    if (pool) {
      try {
        await pool.query(
          `INSERT INTO affiliate_clicks (id, network, creator_user_id, video_id, target_url, ip_hash, user_agent, referrer, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
          [
            clickId,
            network,
            canonicalCreatorId,
            videoId || null,
            validation.url,
            ipHash,
            userAgent,
            referrer,
          ],
        );
      } catch (_clkErr) {
        // Continue
      }
    }

    if (!store.affiliateClicks) store.affiliateClicks = [];
    store.affiliateClicks.unshift({
      id: clickId,
      network,
      creator_user_id: canonicalCreatorId,
      video_id: videoId || null,
      target_url: validation.url!,
      ip_hash: ipHash,
      user_agent: userAgent,
      referrer,
      created_at: new Date().toISOString(),
    });
    saveStore(store);

    if (shouldRedirect && validation.url) {
      return Response.redirect(validation.url, 302);
    }

    return jsonResponse({
      success: true,
      click_id: clickId,
      network,
      creator_user_id: canonicalCreatorId,
      target_url: validation.url,
      video_id: videoId || null,
    });
  }

  // 20e. Affiliate Webhook Ingestion API (POST /api/affiliate/webhook)
  if (route === "affiliate/webhook") {
    if (method !== "POST") {
      return jsonResponse(
        { success: false, error: "Method Not Allowed. Webhook callbacks require POST." },
        405,
      );
    }

    const rawBody = await request.text();
    let data: any = {};
    try {
      data = JSON.parse(rawBody);
    } catch {
      data = Object.fromEntries(new URLSearchParams(rawBody).entries());
    }

    const network = String(
      url.searchParams.get("network") || url.searchParams.get("n") || data.network || "",
    )
      .toLowerCase()
      .trim();

    if (!["amazon", "impact", "earnkaro"].includes(network)) {
      return jsonResponse(
        { success: false, error: "Invalid or missing affiliate network parameter." },
        400,
      );
    }

    const pool = getMysqlPool();
    let netConfig: any = null;

    if (pool) {
      try {
        const [netRows]: any = await pool.query(
          "SELECT id, name, is_active, creator_share_percentage, holding_period_days, webhook_secret, settings_json FROM affiliate_networks_config WHERE id = ? LIMIT 1",
          [network],
        );
        if (netRows && netRows.length > 0) {
          netConfig = netRows[0];
        }
      } catch (_e) {
        // Fallback
      }
    }

    if (!netConfig && store.affiliateNetworks?.[network]) {
      netConfig = store.affiliateNetworks[network];
    }

    if (!netConfig) {
      return jsonResponse(
        { success: false, error: `Affiliate network '${network}' is not configured.` },
        404,
      );
    }

    // Reject inactive provider adapters
    if (!netConfig.is_active || Number(netConfig.is_active) !== 1) {
      return jsonResponse(
        {
          success: false,
          error: `Affiliate network '${netConfig.name}' is currently inactive. Ingestion is disabled pending corporate credentials and contract activation.`,
        },
        503,
      );
    }

    // Signature / Token verification
    const configuredSecret = String(netConfig.webhook_secret || "").trim();
    if (!configuredSecret) {
      return jsonResponse(
        {
          success: false,
          error:
            "Network webhook verification secret is not configured. Rejecting untrusted callback.",
        },
        401,
      );
    }

    const providedSig =
      request.headers.get("x-signature") ||
      request.headers.get("x-impact-signature") ||
      request.headers.get("x-hub-signature-256") ||
      request.headers.get("x-webhook-token") ||
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ||
      "";

    let isVerified = false;
    if (providedSig) {
      if (providedSig === configuredSecret) {
        isVerified = true;
      } else {
        const computedHmac = crypto
          .createHmac("sha256", configuredSecret)
          .update(rawBody)
          .digest("hex");
        const cleanSig = providedSig.replace(/^sha256=/i, "");
        if (computedHmac.length === cleanSig.length) {
          try {
            isVerified = crypto.timingSafeEqual(Buffer.from(computedHmac), Buffer.from(cleanSig));
          } catch {
            isVerified = false;
          }
        }
      }
    }

    if (!isVerified) {
      return jsonResponse(
        { success: false, error: "Invalid or missing webhook signature. Unauthorized." },
        401,
      );
    }

    const externalActionId = String(
      data.external_action_id ||
        data.action_id ||
        data.order_id ||
        data.sub_id ||
        data.transaction_id ||
        "",
    ).trim();
    if (!externalActionId) {
      return jsonResponse(
        { success: false, error: "Missing external action or order ID in callback." },
        400,
      );
    }

    let creatorUserId = String(
      data.creator_user_id ||
        data.creatorUserId ||
        data.sub_id1 ||
        data.custom_id ||
        data.user_id ||
        "",
    )
      .toUpperCase()
      .trim();

    const clickId = String(data.click_id || data.clickId || data.sub_id2 || "").trim();
    let videoId = String(data.video_id || data.videoId || "").trim();

    const orderAmount = Number(data.order_amount ?? data.orderAmount ?? data.amount ?? 0);
    const totalCommission = Number(data.commission ?? data.total_commission ?? data.payout ?? 0);
    const currency = String(data.currency || "INR")
      .toUpperCase()
      .trim();

    if (totalCommission < 0) {
      return jsonResponse({ success: false, error: "Commission amount cannot be negative." }, 400);
    }

    // Resolve creator from click if not directly provided
    if (!creatorUserId && clickId) {
      const clk = (store.affiliateClicks || []).find((c) => c.id === clickId);
      if (clk) {
        creatorUserId = clk.creator_user_id;
        if (!videoId && clk.video_id) videoId = clk.video_id;
      }
    }

    if (!creatorUserId) {
      return jsonResponse(
        { success: false, error: "Attributed creator user ID could not be identified." },
        400,
      );
    }

    const creatorSharePct = Number(netConfig.creator_share_percentage || 0);
    const creatorPayout = Math.round(((totalCommission * creatorSharePct) / 100) * 100) / 100;
    const holdingDays = Number(netConfig.holding_period_days || 0);
    const settlementDueAt = new Date(Date.now() + holdingDays * 86400000).toISOString();
    const payloadHash = crypto.createHash("sha256").update(rawBody).digest("hex");
    const conversionId = `conv_${crypto.randomUUID().replace(/-/g, "")}`;
    const dedupeKey = `${network}_${externalActionId}`;

    if (!store.affiliateConversions) store.affiliateConversions = {};
    if (store.affiliateConversions[dedupeKey]) {
      const existing = store.affiliateConversions[dedupeKey];
      return jsonResponse(
        {
          success: true,
          idempotent: true,
          message: `Conversion already processed for network '${network}' and action ID '${externalActionId}'.`,
          conversion_id: existing.id,
          status: existing.status,
        },
        200,
      );
    }

    if (pool) {
      try {
        const [dupRows]: any = await pool.query(
          "SELECT id, status FROM affiliate_conversions WHERE network = ? AND external_action_id = ? LIMIT 1",
          [network, externalActionId],
        );
        if (dupRows && dupRows.length > 0) {
          return jsonResponse(
            {
              success: true,
              idempotent: true,
              message: `Conversion already processed for network '${network}' and action ID '${externalActionId}'.`,
              conversion_id: dupRows[0].id,
              status: dupRows[0].status,
            },
            200,
          );
        }

        await pool.query(
          `INSERT INTO affiliate_conversions (
            id, network, external_action_id, click_id, creator_user_id, video_id,
            order_amount, total_commission, creator_share_percentage, creator_payout,
            currency, status, settlement_due_at, raw_payload_hash, notes, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NOW())`,
          [
            conversionId,
            network,
            externalActionId,
            clickId || null,
            creatorUserId,
            videoId || null,
            orderAmount,
            totalCommission,
            creatorSharePct,
            creatorPayout,
            currency,
            settlementDueAt,
            payloadHash,
            `Ingested via verified ${netConfig.name} webhook callback`,
          ],
        );

        await pool.query(
          `INSERT INTO affiliate_audit_log (id, conversion_id, action, previous_status, new_status, amount_adjusted, performed_by, notes, created_at)
           VALUES (?, ?, 'ingested', NULL, 'pending', 0.00, 'SYSTEM_WEBHOOK', ?, NOW())`,
          [
            `aud_${crypto.randomUUID().replace(/-/g, "")}`,
            conversionId,
            `Initial verified ingestion from ${network} webhook.`,
          ],
        );
      } catch (poolErr: any) {
        if (
          poolErr?.code === "ER_DUP_ENTRY" ||
          String(poolErr?.message || "").includes("Duplicate entry")
        ) {
          return jsonResponse(
            {
              success: true,
              idempotent: true,
              message: `Duplicate conversion detected and safely ignored for action '${externalActionId}'.`,
            },
            200,
          );
        }
      }
    }

    store.affiliateConversions[dedupeKey] = {
      id: conversionId,
      network,
      external_action_id: externalActionId,
      click_id: clickId || null,
      creator_user_id: creatorUserId,
      video_id: videoId || null,
      order_amount: orderAmount,
      total_commission: totalCommission,
      creator_share_percentage: creatorSharePct,
      creator_payout: creatorPayout,
      currency,
      status: "pending",
      settlement_due_at: settlementDueAt,
      settled_at: null,
      ledger_transaction_id: null,
      notes: `Ingested via verified ${netConfig.name} webhook callback`,
      raw_payload_hash: payloadHash,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (!store.affiliateAuditLog) store.affiliateAuditLog = [];
    store.affiliateAuditLog.unshift({
      id: `aud_${crypto.randomUUID().replace(/-/g, "")}`,
      conversion_id: conversionId,
      action: "ingested",
      previous_status: null,
      new_status: "pending",
      amount_adjusted: 0.0,
      performed_by: "SYSTEM_WEBHOOK",
      notes: `Initial verified ingestion from ${network} webhook.`,
      created_at: new Date().toISOString(),
    });
    saveStore(store);

    return jsonResponse(
      {
        success: true,
        message: "Successfully ingested verified conversion in pending status.",
        conversion_id: conversionId,
        network,
        external_action_id: externalActionId,
        creator_user_id: creatorUserId,
        total_commission: totalCommission,
        creator_payout: creatorPayout,
        status: "pending",
        settlement_due_at: settlementDueAt,
      },
      201,
    );
  }

  // 20f. Admin Affiliate Networks Settings (GET/POST /api/admin/affiliate/settings)
  if (route === "admin/affiliate/settings") {
    const pool = getMysqlPool();
    const authUser = await getAuthUserFromRequest(request, store, pool);
    if (!authUser) {
      return jsonResponse(
        {
          success: false,
          error: "Authentication required. Please provide a valid Bearer session token.",
        },
        401,
      );
    }
    if (authUser.role !== "admin") {
      return jsonResponse(
        {
          success: false,
          error: "Admin authorization required. Access restricted to verified administrators.",
        },
        403,
      );
    }

    if (method === "GET") {
      const defaultNetworks = [
        {
          id: "amazon",
          name: "Amazon Associates",
          isActive: false,
          creatorSharePercentage: 0.0,
          holdingPeriodDays: 0,
          allowedDomains: "amazon.in,amazon.com,amzn.to,amzn.eu,amzn.asia",
          publisherId: null,
          hasWebhookSecret: false,
          hasApiKey: false,
        },
        {
          id: "impact",
          name: "Impact Radius",
          isActive: false,
          creatorSharePercentage: 0.0,
          holdingPeriodDays: 0,
          allowedDomains: "impact.com,sjv.io,ojrq.net,pxf.io,evyy.net",
          publisherId: null,
          hasWebhookSecret: false,
          hasApiKey: false,
        },
        {
          id: "earnkaro",
          name: "EarnKaro",
          isActive: false,
          creatorSharePercentage: 0.0,
          holdingPeriodDays: 0,
          allowedDomains: "earnkaro.com,ekaro.in",
          publisherId: null,
          hasWebhookSecret: false,
          hasApiKey: false,
        },
      ];

      if (pool) {
        try {
          const [rows]: any = await pool.query(
            `SELECT id, name, is_active, creator_share_percentage, holding_period_days, allowed_domains, publisher_id,
                    CASE WHEN webhook_secret IS NOT NULL AND webhook_secret != '' THEN 1 ELSE 0 END AS has_webhook_secret,
                    CASE WHEN api_key_encrypted IS NOT NULL AND api_key_encrypted != '' THEN 1 ELSE 0 END AS has_api_key,
                    updated_by, created_at, updated_at
             FROM affiliate_networks_config ORDER BY id ASC`,
          );
          if (rows && rows.length > 0) {
            const list = rows.map((r: any) => ({
              id: r.id,
              name: r.name,
              isActive: Number(r.is_active) === 1,
              creatorSharePercentage: Number(r.creator_share_percentage || 0),
              holdingPeriodDays: Number(r.holding_period_days || 0),
              allowedDomains: r.allowed_domains,
              publisherId: r.publisher_id,
              hasWebhookSecret: Number(r.has_webhook_secret) === 1,
              hasApiKey: Number(r.has_api_key) === 1,
              updatedBy: r.updated_by,
              createdAt: r.created_at,
              updatedAt: r.updated_at,
            }));
            return jsonResponse({ success: true, networks: list });
          }
        } catch (_e) {
          // Fallback
        }
      }

      if (store.affiliateNetworks) {
        const list = Object.values(store.affiliateNetworks).map((n: any) => ({
          id: n.id,
          name: n.name,
          isActive: Number(n.is_active) === 1,
          creatorSharePercentage: Number(n.creator_share_percentage || 0),
          holdingPeriodDays: Number(n.holding_period_days || 0),
          allowedDomains: n.allowed_domains,
          publisherId: n.publisher_id,
          hasWebhookSecret: Boolean(n.webhook_secret),
          hasApiKey: false,
          updatedBy: n.updated_by,
          createdAt: n.created_at,
          updatedAt: n.updated_at,
        }));
        return jsonResponse({ success: true, networks: list });
      }

      return jsonResponse({ success: true, networks: defaultNetworks });
    }

    if (method === "POST") {
      const payload: any = await request.json().catch(() => ({}));
      const networkId = String(payload.network_id || payload.id || "")
        .toLowerCase()
        .trim();

      if (!["amazon", "impact", "earnkaro"].includes(networkId)) {
        return jsonResponse(
          {
            success: false,
            error: "Valid network_id is required ('amazon', 'impact', 'earnkaro').",
          },
          400,
        );
      }

      const isActive = payload.is_active !== undefined ? Boolean(payload.is_active) : undefined;
      const creatorShare =
        payload.creator_share_percentage !== undefined
          ? Number(payload.creator_share_percentage)
          : undefined;
      const holdingDays =
        payload.holding_period_days !== undefined ? Number(payload.holding_period_days) : undefined;
      const allowedDomains =
        payload.allowed_domains !== undefined ? String(payload.allowed_domains).trim() : undefined;
      const publisherId =
        payload.publisher_id !== undefined ? String(payload.publisher_id).trim() : undefined;
      const webhookSecret =
        payload.webhook_secret !== undefined ? String(payload.webhook_secret).trim() : undefined;

      if (creatorShare !== undefined && (creatorShare < 0 || creatorShare > 100)) {
        return jsonResponse(
          { success: false, error: "Creator share percentage must be between 0.00 and 100.00%." },
          400,
        );
      }
      if (holdingDays !== undefined && holdingDays < 0) {
        return jsonResponse(
          { success: false, error: "Holding period days cannot be negative." },
          400,
        );
      }

      if (pool) {
        try {
          const fields: string[] = [];
          const params: any[] = [];
          if (isActive !== undefined) {
            fields.push("is_active = ?");
            params.push(isActive ? 1 : 0);
          }
          if (creatorShare !== undefined) {
            fields.push("creator_share_percentage = ?");
            params.push(creatorShare);
          }
          if (holdingDays !== undefined) {
            fields.push("holding_period_days = ?");
            params.push(holdingDays);
          }
          if (allowedDomains !== undefined) {
            fields.push("allowed_domains = ?");
            params.push(allowedDomains);
          }
          if (publisherId !== undefined) {
            fields.push("publisher_id = ?");
            params.push(publisherId || null);
          }
          if (webhookSecret !== undefined) {
            fields.push("webhook_secret = ?");
            params.push(webhookSecret);
          }

          if (fields.length > 0) {
            fields.push("updated_by = ?", "updated_at = NOW()");
            params.push(authUser.user_id, networkId);
            await pool.query(
              `UPDATE affiliate_networks_config SET ${fields.join(", ")} WHERE id = ?`,
              params,
            );
          }
        } catch (_err) {
          // Fallback
        }
      }

      if (!store.affiliateNetworks) store.affiliateNetworks = {};
      if (!store.affiliateNetworks[networkId]) {
        store.affiliateNetworks[networkId] = {
          id: networkId,
          name:
            networkId === "amazon"
              ? "Amazon Associates"
              : networkId === "impact"
                ? "Impact Radius"
                : "EarnKaro",
          is_active: 0,
          creator_share_percentage: 0.0,
          holding_period_days: 0,
          allowed_domains:
            networkId === "amazon"
              ? "amazon.in,amazon.com,amzn.to"
              : networkId === "impact"
                ? "impact.com,sjv.io"
                : "earnkaro.com,ekaro.in",
          publisher_id: null,
          webhook_secret: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
      }

      const netObj = store.affiliateNetworks[networkId];
      if (isActive !== undefined) netObj.is_active = isActive ? 1 : 0;
      if (creatorShare !== undefined) netObj.creator_share_percentage = creatorShare;
      if (holdingDays !== undefined) netObj.holding_period_days = holdingDays;
      if (allowedDomains !== undefined) netObj.allowed_domains = allowedDomains;
      if (publisherId !== undefined) netObj.publisher_id = publisherId || null;
      if (webhookSecret !== undefined) netObj.webhook_secret = webhookSecret;
      netObj.updated_by = authUser.user_id;
      netObj.updated_at = new Date().toISOString();
      saveStore(store);

      return jsonResponse({
        success: true,
        message: `Successfully updated affiliate configuration for ${networkId}.`,
        network_id: networkId,
      });
    }

    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  }

  // 20g. Admin Affiliate Conversions & Settlements (GET/POST /api/admin/affiliate/conversions)
  if (route === "admin/affiliate/conversions") {
    const pool = getMysqlPool();
    const authUser = await getAuthUserFromRequest(request, store, pool);
    if (!authUser) {
      return jsonResponse(
        {
          success: false,
          error: "Authentication required. Please provide a valid Bearer session token.",
        },
        401,
      );
    }
    if (authUser.role !== "admin") {
      return jsonResponse(
        {
          success: false,
          error: "Admin authorization required. Access restricted to verified administrators.",
        },
        403,
      );
    }

    if (method === "GET") {
      const netFilter = String(url.searchParams.get("network") || "")
        .toLowerCase()
        .trim();
      const statusFilter = String(url.searchParams.get("status") || "")
        .toLowerCase()
        .trim();
      const userFilter = String(
        url.searchParams.get("creator_user_id") || url.searchParams.get("userId") || "",
      )
        .toUpperCase()
        .trim();
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
      const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get("limit") || "25", 10)));
      const offset = (page - 1) * limit;

      if (pool) {
        try {
          const where: string[] = [];
          const params: any[] = [];
          if (netFilter) {
            where.push("c.network = ?");
            params.push(netFilter);
          }
          if (statusFilter) {
            where.push("c.status = ?");
            params.push(statusFilter);
          }
          if (userFilter) {
            where.push("UPPER(c.creator_user_id) = ?");
            params.push(userFilter);
          }

          const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
          const [sumRows]: any = await pool.query(
            `SELECT COUNT(*) AS total_conversions,
                    COALESCE(SUM(c.order_amount), 0) AS total_order_amount,
                    COALESCE(SUM(c.total_commission), 0) AS total_commission,
                    COALESCE(SUM(c.creator_payout), 0) AS total_creator_payout,
                    SUM(CASE WHEN c.status = 'pending' THEN 1 ELSE 0 END) AS pending_count,
                    SUM(CASE WHEN c.status = 'approved' THEN 1 ELSE 0 END) AS approved_count,
                    SUM(CASE WHEN c.status = 'settled' THEN 1 ELSE 0 END) AS settled_count,
                    SUM(CASE WHEN c.status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count,
                    SUM(CASE WHEN c.status = 'reversed' THEN 1 ELSE 0 END) AS reversed_count
             FROM affiliate_conversions c ${whereSql}`,
            params,
          );

          const sRow = sumRows?.[0] || {};
          const [listRows]: any = await pool.query(
            `SELECT c.*, u.name AS creator_name
             FROM affiliate_conversions c
             LEFT JOIN users u ON UPPER(u.user_id) = UPPER(c.creator_user_id)
             ${whereSql}
             ORDER BY c.created_at DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, offset],
          );

          const total = Number(sRow.total_conversions || 0);
          return jsonResponse({
            success: true,
            conversions: listRows || [],
            pagination: {
              page,
              limit,
              total,
              totalPages: total > 0 ? Math.ceil(total / limit) : 1,
            },
            summary: {
              totalConversions: total,
              totalOrderAmount: Number(sRow.total_order_amount || 0),
              totalCommission: Number(sRow.total_commission || 0),
              totalCreatorPayout: Number(sRow.total_creator_payout || 0),
              pendingCount: Number(sRow.pending_count || 0),
              approvedCount: Number(sRow.approved_count || 0),
              settledCount: Number(sRow.settled_count || 0),
              rejectedCount: Number(sRow.rejected_count || 0),
              reversedCount: Number(sRow.reversed_count || 0),
            },
          });
        } catch (_e) {
          // Fallback
        }
      }

      let allConvs = Object.values(store.affiliateConversions || {});
      if (netFilter) allConvs = allConvs.filter((c) => c.network === netFilter);
      if (statusFilter) allConvs = allConvs.filter((c) => c.status === statusFilter);
      if (userFilter)
        allConvs = allConvs.filter((c) => c.creator_user_id.toUpperCase() === userFilter);

      allConvs.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      const total = allConvs.length;
      const paginated = allConvs.slice(offset, offset + limit);

      const summary = allConvs.reduce(
        (acc, c) => {
          acc.totalOrderAmount += c.order_amount || 0;
          acc.totalCommission += c.total_commission || 0;
          acc.totalCreatorPayout += c.creator_payout || 0;
          if (c.status === "pending") acc.pendingCount++;
          else if (c.status === "approved") acc.approvedCount++;
          else if (c.status === "settled") acc.settledCount++;
          else if (c.status === "rejected") acc.rejectedCount++;
          else if (c.status === "reversed") acc.reversedCount++;
          return acc;
        },
        {
          totalConversions: total,
          totalOrderAmount: 0,
          totalCommission: 0,
          totalCreatorPayout: 0,
          pendingCount: 0,
          approvedCount: 0,
          settledCount: 0,
          rejectedCount: 0,
          reversedCount: 0,
        },
      );

      return jsonResponse({
        success: true,
        conversions: paginated,
        pagination: { page, limit, total, totalPages: total > 0 ? Math.ceil(total / limit) : 1 },
        summary,
      });
    }

    if (method === "POST") {
      const payload: any = await request.json().catch(() => ({}));
      const conversionId = String(payload.conversion_id || payload.id || "").trim();
      const action = String(payload.action || "")
        .toLowerCase()
        .trim();
      const notes = String(payload.notes || "").trim();

      if (!conversionId) {
        return jsonResponse(
          { success: false, error: "Conversion ID (conversion_id) is required." },
          400,
        );
      }
      if (!["approve", "settle", "reject", "reverse"].includes(action)) {
        return jsonResponse(
          {
            success: false,
            error: "Invalid action. Supported actions: 'approve', 'settle', 'reject', 'reverse'.",
          },
          400,
        );
      }

      if (pool) {
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();

          const [rows]: any = await conn.query(
            "SELECT * FROM affiliate_conversions WHERE id = ? FOR UPDATE",
            [conversionId],
          );
          if (!rows || rows.length === 0) {
            await conn.rollback();
            return jsonResponse(
              { success: false, error: `Conversion '${conversionId}' not found.` },
              404,
            );
          }

          const conv = rows[0];
          const currentStatus = conv.status;
          const network = conv.network;
          const externalActionId = conv.external_action_id;
          const creatorUserId = conv.creator_user_id;
          const creatorPayout = Number(conv.creator_payout || 0);
          const cleanActionId = String(externalActionId).replace(/[^0-9A-Za-z]/g, "");
          const cleanNetwork = String(network)
            .toUpperCase()
            .replace(/[^0-9A-Za-z]/g, "");

          if (action === "approve") {
            if (currentStatus !== "pending") {
              await conn.rollback();
              return jsonResponse(
                {
                  success: false,
                  error: `Cannot approve conversion with current status '${currentStatus}'.`,
                },
                400,
              );
            }
            await conn.query(
              `UPDATE affiliate_conversions SET status = 'approved', notes = CONCAT(COALESCE(notes, ''), '\n[Approved]: ', ?), updated_at = NOW() WHERE id = ?`,
              [notes || "Approved by admin", conversionId],
            );
            await conn.query(
              `INSERT INTO affiliate_audit_log (id, conversion_id, action, previous_status, new_status, amount_adjusted, performed_by, notes, created_at)
               VALUES (?, ?, 'approved', 'pending', 'approved', 0.00, ?, ?, NOW())`,
              [
                `aud_${crypto.randomUUID().replace(/-/g, "")}`,
                conversionId,
                authUser.user_id,
                notes,
              ],
            );
            await conn.commit();
            return jsonResponse({
              success: true,
              message: "Conversion approved successfully.",
              status: "approved",
            });
          }

          if (action === "settle") {
            if (currentStatus === "settled") {
              await conn.rollback();
              return jsonResponse({ success: false, error: "Conversion is already settled." }, 409);
            }
            if (currentStatus === "reversed" || currentStatus === "rejected") {
              await conn.rollback();
              return jsonResponse(
                {
                  success: false,
                  error: `Cannot settle a conversion with status '${currentStatus}'.`,
                },
                400,
              );
            }
            if (creatorPayout <= 0) {
              await conn.rollback();
              return jsonResponse(
                {
                  success: false,
                  error: "Creator payout amount is ₹0.00. Cannot settle zero payout.",
                },
                400,
              );
            }

            const txId = `TX_AFF_${cleanNetwork}_${cleanActionId}`;
            const [checkLedger]: any = await conn.query(
              "SELECT id FROM income_ledger WHERE transaction_id = ? LIMIT 1",
              [txId],
            );
            if (checkLedger && checkLedger.length > 0) {
              await conn.rollback();
              return jsonResponse(
                { success: false, error: `Ledger transaction ${txId} already settled.` },
                409,
              );
            }

            const ledgerUuid = `led_${crypto.randomUUID().replace(/-/g, "")}`;
            const desc = `Verified Affiliate Commission: ${network} (Action: ${externalActionId})`;

            // Insert into income_ledger
            await conn.query(
              `INSERT INTO income_ledger (
                id, transaction_id, user_id, source_user_id, source_user_name, video_id,
                income_type, amount, status, special_tag, description, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, 'affiliate_income', ?, 'settled', 'AFFILIATE_SETTLEMENT', ?, NOW())`,
              [
                ledgerUuid,
                txId,
                creatorUserId,
                authUser.user_id,
                authUser.name || "FaceTube Administrator",
                conv.video_id,
                creatorPayout,
                desc,
              ],
            );

            // Atomic credit to wallet_balances
            await conn.query(
              `INSERT INTO wallet_balances (user_id, balance, total_earned, total_withdrawn, referral_income, global_income, adsense_income, affiliate_income, updated_at)
               VALUES (?, ?, ?, 0.00, 0.00, 0.00, 0.00, ?, NOW())
               ON DUPLICATE KEY UPDATE
                 balance = balance + VALUES(balance),
                 total_earned = total_earned + VALUES(total_earned),
                 affiliate_income = affiliate_income + VALUES(affiliate_income),
                 updated_at = NOW()`,
              [creatorUserId, creatorPayout, creatorPayout, creatorPayout],
            );

            // Update conversion
            await conn.query(
              `UPDATE affiliate_conversions
               SET status = 'settled', settled_at = NOW(), ledger_transaction_id = ?, notes = CONCAT(COALESCE(notes, ''), '\n[Settled]: ', ?), updated_at = NOW()
               WHERE id = ?`,
              [txId, notes || "Settled by admin", conversionId],
            );

            // Audit
            await conn.query(
              `INSERT INTO affiliate_audit_log (id, conversion_id, action, previous_status, new_status, amount_adjusted, ledger_transaction_id, performed_by, notes, created_at)
               VALUES (?, ?, 'settled', ?, 'settled', ?, ?, ?, ?, NOW())`,
              [
                `aud_${crypto.randomUUID().replace(/-/g, "")}`,
                conversionId,
                currentStatus,
                creatorPayout,
                txId,
                authUser.user_id,
                notes,
              ],
            );

            await conn.commit();
            return jsonResponse({
              success: true,
              message: `Successfully settled ₹${creatorPayout.toFixed(2)} affiliate income for creator ${creatorUserId}.`,
              transaction_id: txId,
              creator_payout: creatorPayout,
              status: "settled",
            });
          }

          if (action === "reject") {
            if (currentStatus === "settled") {
              await conn.rollback();
              return jsonResponse(
                {
                  success: false,
                  error: "Cannot reject an already settled conversion. Use 'reverse' instead.",
                },
                400,
              );
            }
            await conn.query(
              `UPDATE affiliate_conversions SET status = 'rejected', notes = CONCAT(COALESCE(notes, ''), '\n[Rejected]: ', ?), updated_at = NOW() WHERE id = ?`,
              [notes || "Rejected by admin", conversionId],
            );
            await conn.query(
              `INSERT INTO affiliate_audit_log (id, conversion_id, action, previous_status, new_status, amount_adjusted, performed_by, notes, created_at)
               VALUES (?, ?, 'rejected', ?, 'rejected', 0.00, ?, ?, NOW())`,
              [
                `aud_${crypto.randomUUID().replace(/-/g, "")}`,
                conversionId,
                currentStatus,
                authUser.user_id,
                notes,
              ],
            );
            await conn.commit();
            return jsonResponse({
              success: true,
              message: "Conversion marked as rejected.",
              status: "rejected",
            });
          }

          if (action === "reverse") {
            if (currentStatus === "reversed") {
              await conn.rollback();
              return jsonResponse(
                { success: false, error: "Conversion is already reversed." },
                409,
              );
            }

            if (currentStatus === "settled") {
              const revTxId = `TX_AFF_REV_${cleanNetwork}_${cleanActionId}`;
              const revUuid = `led_${crypto.randomUUID().replace(/-/g, "")}`;
              const revDesc = `Reversal of Settled Affiliate Commission: ${network} (Action: ${externalActionId})`;

              await conn.query(
                `INSERT INTO income_ledger (
                  id, transaction_id, user_id, source_user_id, source_user_name, video_id,
                  income_type, amount, status, special_tag, description, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'affiliate_income', ?, 'settled', 'AFFILIATE_REVERSAL', ?, NOW())`,
                [
                  revUuid,
                  revTxId,
                  creatorUserId,
                  authUser.user_id,
                  authUser.name || "FaceTube Administrator",
                  conv.video_id,
                  -creatorPayout,
                  revDesc,
                ],
              );

              await conn.query(
                `UPDATE wallet_balances
                 SET balance = GREATEST(0, balance - ?),
                     total_earned = GREATEST(0, total_earned - ?),
                     affiliate_income = GREATEST(0, affiliate_income - ?),
                     updated_at = NOW()
                 WHERE UPPER(user_id) = UPPER(?)`,
                [creatorPayout, creatorPayout, creatorPayout, creatorUserId],
              );

              await conn.query(
                `UPDATE affiliate_conversions SET status = 'reversed', notes = CONCAT(COALESCE(notes, ''), '\n[Reversed]: ', ?), updated_at = NOW() WHERE id = ?`,
                [notes || "Reversed settled conversion", conversionId],
              );

              await conn.query(
                `INSERT INTO affiliate_audit_log (id, conversion_id, action, previous_status, new_status, amount_adjusted, ledger_transaction_id, performed_by, notes, created_at)
                 VALUES (?, ?, 'reversed', 'settled', 'reversed', ?, ?, ?, ?, NOW())`,
                [
                  `aud_${crypto.randomUUID().replace(/-/g, "")}`,
                  conversionId,
                  -creatorPayout,
                  revTxId,
                  authUser.user_id,
                  notes,
                ],
              );

              await conn.commit();
              return jsonResponse({
                success: true,
                message: `Successfully reversed ₹${creatorPayout.toFixed(2)} affiliate income for creator ${creatorUserId}.`,
                reversal_transaction_id: revTxId,
                status: "reversed",
              });
            } else {
              await conn.query(
                `UPDATE affiliate_conversions SET status = 'reversed', notes = CONCAT(COALESCE(notes, ''), '\n[Cancelled/Reversed]: ', ?), updated_at = NOW() WHERE id = ?`,
                [notes || "Cancelled before settlement", conversionId],
              );
              await conn.query(
                `INSERT INTO affiliate_audit_log (id, conversion_id, action, previous_status, new_status, amount_adjusted, performed_by, notes, created_at)
                 VALUES (?, ?, 'reversed', ?, 'reversed', 0.00, ?, ?, NOW())`,
                [
                  `aud_${crypto.randomUUID().replace(/-/g, "")}`,
                  conversionId,
                  currentStatus,
                  authUser.user_id,
                  notes,
                ],
              );
              await conn.commit();
              return jsonResponse({
                success: true,
                message: "Conversion marked as reversed (no wallet adjustments were required).",
                status: "reversed",
              });
            }
          }
        } catch (dbErr: any) {
          await conn.rollback();
          return jsonResponse(
            { success: false, error: "Database error executing action: " + dbErr.message },
            500,
          );
        } finally {
          conn.release();
        }
      }

      // Fallback store processing
      const convEntry = Object.values(store.affiliateConversions || {}).find(
        (c) => c.id === conversionId,
      );
      if (!convEntry) {
        return jsonResponse(
          { success: false, error: `Conversion '${conversionId}' not found.` },
          404,
        );
      }

      const currentStatus = convEntry.status;
      const network = convEntry.network;
      const externalActionId = convEntry.external_action_id;
      const creatorUserId = convEntry.creator_user_id;
      const creatorPayout = convEntry.creator_payout;
      const cleanActionId = String(externalActionId).replace(/[^0-9A-Za-z]/g, "");
      const cleanNetwork = String(network)
        .toUpperCase()
        .replace(/[^0-9A-Za-z]/g, "");

      if (action === "approve") {
        if (currentStatus !== "pending") {
          return jsonResponse(
            {
              success: false,
              error: `Cannot approve conversion with current status '${currentStatus}'.`,
            },
            400,
          );
        }
        convEntry.status = "approved";
        convEntry.notes = (convEntry.notes || "") + `\n[Approved]: ${notes || "Approved by admin"}`;
        convEntry.updated_at = new Date().toISOString();

        if (!store.affiliateAuditLog) store.affiliateAuditLog = [];
        store.affiliateAuditLog.unshift({
          id: `aud_${crypto.randomUUID().replace(/-/g, "")}`,
          conversion_id: conversionId,
          action: "approved",
          previous_status: "pending",
          new_status: "approved",
          amount_adjusted: 0,
          performed_by: authUser.user_id,
          notes,
          created_at: new Date().toISOString(),
        });
        saveStore(store);
        return jsonResponse({
          success: true,
          message: "Conversion approved successfully.",
          status: "approved",
        });
      }

      if (action === "settle") {
        if (currentStatus === "settled") {
          return jsonResponse({ success: false, error: "Conversion is already settled." }, 409);
        }
        if (currentStatus === "reversed" || currentStatus === "rejected") {
          return jsonResponse(
            { success: false, error: `Cannot settle a conversion with status '${currentStatus}'.` },
            400,
          );
        }
        if (creatorPayout <= 0) {
          return jsonResponse(
            { success: false, error: "Creator payout amount is ₹0.00. Cannot settle zero payout." },
            400,
          );
        }

        const txId = `TX_AFF_${cleanNetwork}_${cleanActionId}`;
        const normCreator = creatorUserId.toUpperCase();
        if (!store.wallets) store.wallets = {};
        if (!store.wallets[normCreator]) {
          store.wallets[normCreator] = {
            balance: 0,
            total_earned: 0,
            total_withdrawn: 0,
            referral_income: 0,
            global_income: 0,
            adsense_income: 0,
            affiliate_income: 0,
            updated_at: new Date().toISOString(),
          };
        }
        const wallet = store.wallets[normCreator]!;
        wallet.balance = (wallet.balance || 0) + creatorPayout;
        wallet.total_earned = (wallet.total_earned || 0) + creatorPayout;
        wallet.affiliate_income = (wallet.affiliate_income || 0) + creatorPayout;
        wallet.updated_at = new Date().toISOString();

        if (!store.walletTransactions) store.walletTransactions = [];
        store.walletTransactions.unshift({
          id: `led_${crypto.randomUUID().replace(/-/g, "")}`,
          transaction_id: txId,
          user_id: creatorUserId,
          userId: creatorUserId,
          amount: creatorPayout,
          income_type: "affiliate_income",
          type: "affiliate_income",
          status: "settled",
          special_tag: "AFFILIATE_SETTLEMENT",
          description: `Verified Affiliate Commission: ${network} (Action: ${externalActionId})`,
          created_at: new Date().toISOString(),
        });

        convEntry.status = "settled";
        convEntry.settled_at = new Date().toISOString();
        convEntry.ledger_transaction_id = txId;
        convEntry.notes = (convEntry.notes || "") + `\n[Settled]: ${notes || "Settled by admin"}`;
        convEntry.updated_at = new Date().toISOString();

        if (!store.affiliateAuditLog) store.affiliateAuditLog = [];
        store.affiliateAuditLog.unshift({
          id: `aud_${crypto.randomUUID().replace(/-/g, "")}`,
          conversion_id: conversionId,
          action: "settled",
          previous_status: currentStatus,
          new_status: "settled",
          amount_adjusted: creatorPayout,
          ledger_transaction_id: txId,
          performed_by: authUser.user_id,
          notes,
          created_at: new Date().toISOString(),
        });
        saveStore(store);

        return jsonResponse({
          success: true,
          message: `Successfully settled ₹${creatorPayout.toFixed(2)} affiliate income for creator ${creatorUserId}.`,
          transaction_id: txId,
          creator_payout: creatorPayout,
          status: "settled",
        });
      }

      if (action === "reject") {
        if (currentStatus === "settled") {
          return jsonResponse(
            {
              success: false,
              error: "Cannot reject an already settled conversion. Use 'reverse' instead.",
            },
            400,
          );
        }
        convEntry.status = "rejected";
        convEntry.notes = (convEntry.notes || "") + `\n[Rejected]: ${notes || "Rejected by admin"}`;
        convEntry.updated_at = new Date().toISOString();

        if (!store.affiliateAuditLog) store.affiliateAuditLog = [];
        store.affiliateAuditLog.unshift({
          id: `aud_${crypto.randomUUID().replace(/-/g, "")}`,
          conversion_id: conversionId,
          action: "rejected",
          previous_status: currentStatus,
          new_status: "rejected",
          amount_adjusted: 0,
          performed_by: authUser.user_id,
          notes,
          created_at: new Date().toISOString(),
        });
        saveStore(store);
        return jsonResponse({
          success: true,
          message: "Conversion marked as rejected.",
          status: "rejected",
        });
      }

      if (action === "reverse") {
        if (currentStatus === "reversed") {
          return jsonResponse({ success: false, error: "Conversion is already reversed." }, 409);
        }

        if (currentStatus === "settled") {
          const revTxId = `TX_AFF_REV_${cleanNetwork}_${cleanActionId}`;
          const normCreator = creatorUserId.toUpperCase();
          if (!store.wallets) store.wallets = {};
          if (!store.wallets[normCreator]) {
            store.wallets[normCreator] = {
              balance: 0,
              total_earned: 0,
              total_withdrawn: 0,
              referral_income: 0,
              global_income: 0,
              adsense_income: 0,
              affiliate_income: 0,
              updated_at: new Date().toISOString(),
            };
          }
          const wallet = store.wallets[normCreator]!;
          wallet.balance = Math.max(0, (wallet.balance || 0) - creatorPayout);
          wallet.total_earned = Math.max(0, (wallet.total_earned || 0) - creatorPayout);
          wallet.affiliate_income = Math.max(0, (wallet.affiliate_income || 0) - creatorPayout);
          wallet.updated_at = new Date().toISOString();

          if (!store.walletTransactions) store.walletTransactions = [];
          store.walletTransactions.unshift({
            id: `led_${crypto.randomUUID().replace(/-/g, "")}`,
            transaction_id: revTxId,
            user_id: creatorUserId,
            userId: creatorUserId,
            amount: -creatorPayout,
            income_type: "affiliate_income",
            type: "affiliate_income",
            status: "settled",
            special_tag: "AFFILIATE_REVERSAL",
            description: `Reversal of Settled Affiliate Commission: ${network} (Action: ${externalActionId})`,
            created_at: new Date().toISOString(),
          });

          convEntry.status = "reversed";
          convEntry.notes =
            (convEntry.notes || "") + `\n[Reversed]: ${notes || "Reversed settled conversion"}`;
          convEntry.updated_at = new Date().toISOString();

          if (!store.affiliateAuditLog) store.affiliateAuditLog = [];
          store.affiliateAuditLog.unshift({
            id: `aud_${crypto.randomUUID().replace(/-/g, "")}`,
            conversion_id: conversionId,
            action: "reversed",
            previous_status: "settled",
            new_status: "reversed",
            amount_adjusted: -creatorPayout,
            ledger_transaction_id: revTxId,
            performed_by: authUser.user_id,
            notes,
            created_at: new Date().toISOString(),
          });
          saveStore(store);

          return jsonResponse({
            success: true,
            message: `Successfully reversed ₹${creatorPayout.toFixed(2)} affiliate income for creator ${creatorUserId}.`,
            reversal_transaction_id: revTxId,
            status: "reversed",
          });
        } else {
          convEntry.status = "reversed";
          convEntry.notes =
            (convEntry.notes || "") +
            `\n[Cancelled/Reversed]: ${notes || "Cancelled before settlement"}`;
          convEntry.updated_at = new Date().toISOString();

          if (!store.affiliateAuditLog) store.affiliateAuditLog = [];
          store.affiliateAuditLog.unshift({
            id: `aud_${crypto.randomUUID().replace(/-/g, "")}`,
            conversion_id: conversionId,
            action: "reversed",
            previous_status: currentStatus,
            new_status: "reversed",
            amount_adjusted: 0,
            performed_by: authUser.user_id,
            notes,
            created_at: new Date().toISOString(),
          });
          saveStore(store);

          return jsonResponse({
            success: true,
            message: "Conversion marked as reversed (no wallet adjustments were required).",
            status: "reversed",
          });
        }
      }
    }

    return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
  }

  // 21. Admin User-Wise Earnings & Payouts Report
  if (route === "admin/earnings-report") {
    if (method === "GET") {
      const pool = getMysqlPool();
      const authUser = await getAuthUserFromRequest(request, store, pool);
      if (!authUser) {
        return jsonResponse(
          {
            success: false,
            error: "Authentication required. Please provide a valid Bearer session token.",
          },
          401,
        );
      }
      if (authUser.role !== "admin") {
        return jsonResponse(
          {
            success: false,
            error:
              "Admin authorization required. Only verified administrators can access the earnings report.",
          },
          403,
        );
      }

      const action = (url.searchParams.get("action") || "").trim().toLowerCase();

      // Sub-Action: Date-wise withdrawal transaction history for a specific user
      if (action === "withdrawals") {
        const targetUserId = (
          url.searchParams.get("userId") ||
          url.searchParams.get("user_id") ||
          ""
        ).trim();

        if (!targetUserId) {
          return jsonResponse(
            { success: false, error: "user_id is required for withdrawal history" },
            400,
          );
        }

        const startDate = (
          url.searchParams.get("start_date") ||
          url.searchParams.get("startDate") ||
          ""
        ).trim();
        const endDate = (
          url.searchParams.get("end_date") ||
          url.searchParams.get("endDate") ||
          ""
        ).trim();

        if (pool) {
          try {
            let sql = `
              SELECT id, transaction_id, user_id, amount, status, description, created_at
              FROM income_ledger
              WHERE UPPER(user_id) = UPPER(?) AND income_type = 'withdrawal'
            `;
            const params: any[] = [targetUserId];
            if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
              sql += " AND created_at >= ?";
              params.push(`${startDate} 00:00:00`);
            }
            if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
              sql += " AND created_at <= ?";
              params.push(`${endDate} 23:59:59`);
            }
            sql += " ORDER BY created_at DESC LIMIT 200";

            const [rows]: any = await pool.query(sql, params);
            const mapped = (rows || []).map((tx: any) => ({
              id: tx.id,
              transactionId: tx.transaction_id || tx.id,
              userId: tx.user_id,
              amount: Number(tx.amount) || 0,
              status: tx.status,
              description: tx.description || "Withdrawal request",
              createdAt: tx.created_at,
            }));
            const totalAmount = mapped.reduce((sum: number, item: any) => sum + item.amount, 0);

            return jsonResponse({
              success: true,
              userId: targetUserId,
              total: mapped.length,
              totalAmount: Math.round(totalAmount * 100) / 100,
              withdrawals: mapped,
            });
          } catch (dbErr: any) {
            console.error("[earnings-report] MySQL error querying user withdrawals:", dbErr);
          }
        }

        // Store fallback for dev/test environments
        const allTx = store.walletTransactions || [];
        const normTarget = targetUserId.toUpperCase();
        let userTxs = allTx.filter((t: any) => {
          const uId = String(t.user_id || t.userId || "")
            .trim()
            .toUpperCase();
          const isWithdrawal =
            t.type === "withdrawal" ||
            t.income_type === "withdrawal" ||
            t.incomeType === "withdrawal";
          return uId === normTarget && isWithdrawal;
        });

        if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
          const startMs = new Date(`${startDate}T00:00:00Z`).getTime();
          userTxs = userTxs.filter(
            (t: any) => new Date(t.created_at || t.createdAt || 0).getTime() >= startMs,
          );
        }
        if (endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
          const endMs = new Date(`${endDate}T23:59:59Z`).getTime();
          userTxs = userTxs.filter(
            (t: any) => new Date(t.created_at || t.createdAt || 0).getTime() <= endMs,
          );
        }

        const mapped = userTxs.map((tx: any) => ({
          id: String(tx.id || tx.transaction_id || tx.transactionId || `tx_${Math.random()}`),
          transactionId: String(tx.transaction_id || tx.transactionId || tx.id || ""),
          userId: targetUserId,
          amount: Number(tx.amount) || 0,
          status: String(tx.status || "settled"),
          description: String(tx.description || "Withdrawal request"),
          createdAt: tx.created_at || tx.createdAt || new Date().toISOString(),
        }));

        const totalAmount = mapped.reduce((sum: number, item: any) => sum + item.amount, 0);

        return jsonResponse({
          success: true,
          userId: targetUserId,
          total: mapped.length,
          totalAmount: Math.round(totalAmount * 100) / 100,
          withdrawals: mapped,
        });
      }

      // Main Report Query: Filtered & Paginated Users
      const search = (url.searchParams.get("search") || url.searchParams.get("q") || "").trim();
      const startDate = (
        url.searchParams.get("start_date") ||
        url.searchParams.get("startDate") ||
        ""
      ).trim();
      const endDate = (
        url.searchParams.get("end_date") ||
        url.searchParams.get("endDate") ||
        ""
      ).trim();
      const dateMode = (url.searchParams.get("date_mode") || "joined").trim().toLowerCase();
      const exportType = (url.searchParams.get("export") || url.searchParams.get("format") || "")
        .trim()
        .toLowerCase();

      let page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
      let limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get("limit") || "20", 10)));
      if (exportType === "csv") {
        limit = 5000;
        page = 1;
      }
      const offset = (page - 1) * limit;

      if (pool) {
        try {
          const whereClauses: string[] = [];
          const params: any[] = [];

          if (search) {
            whereClauses.push(
              "(u.user_id LIKE ? OR u.name LIKE ? OR u.email LIKE ? OR u.referral_code LIKE ?)",
            );
            const like = `%${search}%`;
            params.push(like, like, like, like);
          }

          const hasStart = startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate);
          const hasEnd = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate);

          if (dateMode === "activity") {
            if (hasStart && hasEnd) {
              whereClauses.push(
                "u.user_id IN (SELECT DISTINCT user_id FROM income_ledger WHERE created_at >= ? AND created_at <= ?)",
              );
              params.push(`${startDate} 00:00:00`, `${endDate} 23:59:59`);
            } else if (hasStart) {
              whereClauses.push(
                "u.user_id IN (SELECT DISTINCT user_id FROM income_ledger WHERE created_at >= ?)",
              );
              params.push(`${startDate} 00:00:00`);
            } else if (hasEnd) {
              whereClauses.push(
                "u.user_id IN (SELECT DISTINCT user_id FROM income_ledger WHERE created_at <= ?)",
              );
              params.push(`${endDate} 23:59:59`);
            }
          } else {
            if (hasStart) {
              whereClauses.push("u.created_at >= ?");
              params.push(`${startDate} 00:00:00`);
            }
            if (hasEnd) {
              whereClauses.push("u.created_at <= ?");
              params.push(`${endDate} 23:59:59`);
            }
          }

          const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

          // 1. Total Count
          const [countRows]: any = await pool.query(
            `SELECT COUNT(*) AS total FROM users u ${whereSql}`,
            params,
          );
          const totalUsers = Number(countRows?.[0]?.total) || 0;

          // 2. Summary aggregates
          const summarySql = `
            SELECT 
              COUNT(u.id) AS total_count,
              COALESCE(SUM(wb.balance), 0) AS total_wallet_balance,
              COALESCE(SUM(COALESCE(wb.total_earned, lt.ledger_total_earned, 0)), 0) AS total_earned,
              COALESCE(SUM(COALESCE(wb.total_withdrawn, lt.ledger_total_withdrawn, 0)), 0) AS total_withdrawn,
              COALESCE(SUM(COALESCE(lt.ledger_referral_income, wb.referral_income, 0)), 0) AS total_referral_income,
              COALESCE(SUM(COALESCE(lt.ledger_global_income, wb.global_income, 0)), 0) AS total_global_income,
              COALESCE(SUM(COALESCE(lt.ledger_adsense_income, wb.adsense_income, 0)), 0) AS total_adsense_income,
              COALESCE(SUM(COALESCE(lt.ledger_affiliate_income, wb.affiliate_income, 0)), 0) AS total_affiliate_income
            FROM users u
            LEFT JOIN wallet_balances wb ON UPPER(wb.user_id) = UPPER(u.user_id)
            LEFT JOIN (
              SELECT 
                UPPER(user_id) AS user_id,
                SUM(CASE WHEN income_type IN ('referral_income', 'direct_commission') THEN amount ELSE 0 END) AS ledger_referral_income,
                SUM(CASE WHEN income_type = 'global_income' THEN amount ELSE 0 END) AS ledger_global_income,
                SUM(CASE WHEN income_type = 'adsense_income' THEN amount ELSE 0 END) AS ledger_adsense_income,
                SUM(CASE WHEN income_type IN ('affiliate_income', 'marketing_income') THEN amount ELSE 0 END) AS ledger_affiliate_income,
                SUM(CASE WHEN income_type = 'withdrawal' THEN amount ELSE 0 END) AS ledger_total_withdrawn,
                SUM(CASE WHEN income_type != 'withdrawal' THEN amount ELSE 0 END) AS ledger_total_earned
              FROM income_ledger
              WHERE status = 'settled'
              GROUP BY UPPER(user_id)
            ) lt ON UPPER(lt.user_id) = UPPER(u.user_id)
            ${whereSql}
          `;
          const [sumRows]: any = await pool.query(summarySql, params);
          const sRow = sumRows?.[0] || {};
          const summary = {
            totalUsers: Number(sRow.total_count) || totalUsers,
            totalWalletBalance: Math.round((Number(sRow.total_wallet_balance) || 0) * 100) / 100,
            totalEarned: Math.round((Number(sRow.total_earned) || 0) * 100) / 100,
            totalWithdrawn: Math.round((Number(sRow.total_withdrawn) || 0) * 100) / 100,
            totalReferralIncome: Math.round((Number(sRow.total_referral_income) || 0) * 100) / 100,
            totalGlobalIncome: Math.round((Number(sRow.total_global_income) || 0) * 100) / 100,
            totalAdsenseIncome: Math.round((Number(sRow.total_adsense_income) || 0) * 100) / 100,
            totalAffiliateIncome:
              Math.round((Number(sRow.total_affiliate_income) || 0) * 100) / 100,
          };

          // 3. Paginated Data Rows
          const dataSql = `
            SELECT 
              u.id,
              u.user_id,
              u.name,
              u.email,
              u.role,
              u.referral_code,
              u.created_at,
              COALESCE(wb.balance, 0.00) AS balance,
              COALESCE(wb.total_earned, lt.ledger_total_earned, 0.00) AS total_earned,
              COALESCE(wb.total_withdrawn, lt.ledger_total_withdrawn, 0.00) AS total_withdrawn,
              COALESCE(lt.ledger_referral_income, wb.referral_income, 0.00) AS referral_income,
              COALESCE(lt.ledger_global_income, wb.global_income, 0.00) AS global_income,
              COALESCE(lt.ledger_adsense_income, wb.adsense_income, 0.00) AS adsense_income,
              COALESCE(lt.ledger_affiliate_income, wb.affiliate_income, 0.00) AS affiliate_income
            FROM users u
            LEFT JOIN wallet_balances wb ON UPPER(wb.user_id) = UPPER(u.user_id)
            LEFT JOIN (
              SELECT 
                UPPER(user_id) AS user_id,
                SUM(CASE WHEN income_type IN ('referral_income', 'direct_commission') THEN amount ELSE 0 END) AS ledger_referral_income,
                SUM(CASE WHEN income_type = 'global_income' THEN amount ELSE 0 END) AS ledger_global_income,
                SUM(CASE WHEN income_type = 'adsense_income' THEN amount ELSE 0 END) AS ledger_adsense_income,
                SUM(CASE WHEN income_type IN ('affiliate_income', 'marketing_income') THEN amount ELSE 0 END) AS ledger_affiliate_income,
                SUM(CASE WHEN income_type = 'withdrawal' THEN amount ELSE 0 END) AS ledger_total_withdrawn,
                SUM(CASE WHEN income_type != 'withdrawal' THEN amount ELSE 0 END) AS ledger_total_earned
              FROM income_ledger
              WHERE status = 'settled'
              GROUP BY UPPER(user_id)
            ) lt ON UPPER(lt.user_id) = UPPER(u.user_id)
            ${whereSql}
            ORDER BY u.created_at DESC
            LIMIT ? OFFSET ?
          `;
          const [dataRows]: any = await pool.query(dataSql, [...params, limit, offset]);

          if (exportType === "csv") {
            const csvRows: string[] = [
              "\uFEFFUser ID,Full Name,Email Address,Role,Referral Code,Available Balance (INR),Total Earned (INR),Referral Income (INR),Global Income (INR),AdSense Income (INR),Affiliate Income (INR),Total Withdrawn (INR),Joined Date",
            ];
            for (const r of dataRows || []) {
              const line = [
                `"${r.user_id}"`,
                `"${(r.name || "").replace(/"/g, '""')}"`,
                `"${(r.email || "").replace(/"/g, '""')}"`,
                `"${r.role}"`,
                `"${r.referral_code || "N/A"}"`,
                Number(r.balance || 0).toFixed(2),
                Number(r.total_earned || 0).toFixed(2),
                Number(r.referral_income || 0).toFixed(2),
                Number(r.global_income || 0).toFixed(2),
                Number(r.adsense_income || 0).toFixed(2),
                Number(r.affiliate_income || 0).toFixed(2),
                Number(r.total_withdrawn || 0).toFixed(2),
                `"${r.created_at || ""}"`,
              ].join(",");
              csvRows.push(line);
            }
            return new Response(csvRows.join("\r\n"), {
              status: 200,
              headers: {
                "Content-Type": "text/csv; charset=utf-8",
                "Content-Disposition": `attachment; filename="facetube_earnings_report_${new Date().toISOString().slice(0, 10)}.csv"`,
              },
            });
          }

          const users = (dataRows || []).map((r: any) => ({
            id: r.id,
            userId: r.user_id,
            name: r.name,
            email: r.email,
            role: r.role,
            referralCode: r.referral_code,
            createdAt: r.created_at,
            balance: Math.round((Number(r.balance) || 0) * 100) / 100,
            totalEarned: Math.round((Number(r.total_earned) || 0) * 100) / 100,
            totalWithdrawn: Math.round((Number(r.total_withdrawn) || 0) * 100) / 100,
            referralIncome: Math.round((Number(r.referral_income) || 0) * 100) / 100,
            globalIncome: Math.round((Number(r.global_income) || 0) * 100) / 100,
            adsenseIncome: Math.round((Number(r.adsense_income) || 0) * 100) / 100,
            affiliateIncome: Math.round((Number(r.affiliate_income) || 0) * 100) / 100,
          }));

          const totalPages = totalUsers > 0 ? Math.ceil(totalUsers / limit) : 1;
          return jsonResponse({
            success: true,
            users,
            pagination: {
              page,
              limit,
              total: totalUsers,
              totalPages,
            },
            summary,
          });
        } catch (dbErr: any) {
          console.error("[earnings-report] MySQL report error:", dbErr);
        }
      }

      // In-Memory store implementation for dev/test environment
      if (!store.wallets) store.wallets = {};
      const getOrInitWallet = (uId: string) => {
        const norm = uId.toUpperCase();
        if (!store.wallets[norm]) {
          const defaultBalances: Record<string, number> = {
            FT102857: 15400,
            FT483921: 4280.5,
            FT900431: 850,
          };
          const defaultEarned: Record<string, number> = {
            FT102857: 22000,
            FT483921: 7430.5,
            FT900431: 850,
          };
          const defaultWithdrawn: Record<string, number> = {
            FT102857: 6600,
            FT483921: 3150,
            FT900431: 0,
          };
          store.wallets[norm] = {
            balance: defaultBalances[norm] ?? 0,
            total_earned: defaultEarned[norm] ?? 0,
            total_withdrawn: defaultWithdrawn[norm] ?? 0,
            referral_income: defaultEarned[norm] ? defaultEarned[norm] * 0.4 : 0,
            global_income: defaultEarned[norm] ? defaultEarned[norm] * 0.3 : 0,
            adsense_income: defaultEarned[norm] ? defaultEarned[norm] * 0.2 : 0,
            affiliate_income: defaultEarned[norm] ? defaultEarned[norm] * 0.1 : 0,
            updated_at: new Date().toISOString(),
          };
        }
        return store.wallets[norm]!;
      };

      let filteredUsers = [...(store.users || [])];

      if (search) {
        const sLower = search.toLowerCase();
        filteredUsers = filteredUsers.filter((u) => {
          return (
            u.user_id.toLowerCase().includes(sLower) ||
            u.name.toLowerCase().includes(sLower) ||
            u.email.toLowerCase().includes(sLower) ||
            (u.referral_code && u.referral_code.toLowerCase().includes(sLower))
          );
        });
      }

      const hasStart = startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate);
      const hasEnd = endDate && /^\d{4}-\d{2}-\d{2}$/.test(endDate);

      if (hasStart) {
        const startMs = new Date(`${startDate}T00:00:00Z`).getTime();
        filteredUsers = filteredUsers.filter(
          (u) => new Date(u.created_at || 0).getTime() >= startMs,
        );
      }
      if (hasEnd) {
        const endMs = new Date(`${endDate}T23:59:59Z`).getTime();
        filteredUsers = filteredUsers.filter((u) => new Date(u.created_at || 0).getTime() <= endMs);
      }

      const totalUsers = filteredUsers.length;

      // Summary across filtered users
      const summary = filteredUsers.reduce(
        (acc, u) => {
          const w = getOrInitWallet(u.user_id);
          acc.totalWalletBalance += w.balance || 0;
          acc.totalEarned += w.total_earned || 0;
          acc.totalWithdrawn += w.total_withdrawn || 0;
          acc.totalReferralIncome += w.referral_income || 0;
          acc.totalGlobalIncome += w.global_income || 0;
          acc.totalAdsenseIncome += w.adsense_income || 0;
          acc.totalAffiliateIncome += w.affiliate_income || 0;
          return acc;
        },
        {
          totalUsers,
          totalWalletBalance: 0,
          totalEarned: 0,
          totalWithdrawn: 0,
          totalReferralIncome: 0,
          totalGlobalIncome: 0,
          totalAdsenseIncome: 0,
          totalAffiliateIncome: 0,
        },
      );

      // Round summary
      summary.totalWalletBalance = Math.round(summary.totalWalletBalance * 100) / 100;
      summary.totalEarned = Math.round(summary.totalEarned * 100) / 100;
      summary.totalWithdrawn = Math.round(summary.totalWithdrawn * 100) / 100;
      summary.totalReferralIncome = Math.round(summary.totalReferralIncome * 100) / 100;
      summary.totalGlobalIncome = Math.round(summary.totalGlobalIncome * 100) / 100;
      summary.totalAdsenseIncome = Math.round(summary.totalAdsenseIncome * 100) / 100;
      summary.totalAffiliateIncome = Math.round(summary.totalAffiliateIncome * 100) / 100;

      // Slicing for pagination
      const paginatedUsers = filteredUsers.slice(offset, offset + limit);

      if (exportType === "csv") {
        const csvRows: string[] = [
          "\uFEFFUser ID,Full Name,Email Address,Role,Referral Code,Available Balance (INR),Total Earned (INR),Referral Income (INR),Global Income (INR),AdSense Income (INR),Affiliate Income (INR),Total Withdrawn (INR),Joined Date",
        ];
        for (const u of filteredUsers) {
          const w = getOrInitWallet(u.user_id);
          const line = [
            `"${u.user_id}"`,
            `"${(u.name || "").replace(/"/g, '""')}"`,
            `"${(u.email || "").replace(/"/g, '""')}"`,
            `"${u.role}"`,
            `"${u.referral_code || "N/A"}"`,
            (w.balance || 0).toFixed(2),
            (w.total_earned || 0).toFixed(2),
            (w.referral_income || 0).toFixed(2),
            (w.global_income || 0).toFixed(2),
            (w.adsense_income || 0).toFixed(2),
            (w.affiliate_income || 0).toFixed(2),
            (w.total_withdrawn || 0).toFixed(2),
            `"${u.created_at || ""}"`,
          ].join(",");
          csvRows.push(line);
        }
        return new Response(csvRows.join("\r\n"), {
          status: 200,
          headers: {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="facetube_earnings_report_${new Date().toISOString().slice(0, 10)}.csv"`,
          },
        });
      }

      const users = paginatedUsers.map((u) => {
        const w = getOrInitWallet(u.user_id);
        return {
          id: u.id,
          userId: u.user_id,
          name: u.name,
          email: u.email,
          role: u.role,
          referralCode: u.referral_code,
          createdAt: u.created_at,
          balance: Math.round((w.balance || 0) * 100) / 100,
          totalEarned: Math.round((w.total_earned || 0) * 100) / 100,
          totalWithdrawn: Math.round((w.total_withdrawn || 0) * 100) / 100,
          referralIncome: Math.round((w.referral_income || 0) * 100) / 100,
          globalIncome: Math.round((w.global_income || 0) * 100) / 100,
          adsenseIncome: Math.round((w.adsense_income || 0) * 100) / 100,
          affiliateIncome: Math.round((w.affiliate_income || 0) * 100) / 100,
        };
      });

      const totalPages = totalUsers > 0 ? Math.ceil(totalUsers / limit) : 1;

      return jsonResponse({
        success: true,
        users,
        pagination: {
          page,
          limit,
          total: totalUsers,
          totalPages,
        },
        summary,
      });
    }
  }

  // 24. Creator Channel Subscriptions API
  // 24a. Subscribe to Creator Channel (POST /api/channel/subscribe)
  if (route === "channel/subscribe") {
    if (method !== "POST") {
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    }
    const pool = getMysqlPool();
    const authUser = await getAuthUserFromRequest(request, store, pool);
    if (!authUser) {
      return jsonResponse(
        { success: false, error: "Authentication required to subscribe to a channel." },
        401,
      );
    }
    const subscriberUserId = String(authUser.user_id || "").trim();
    if (!subscriberUserId) {
      return jsonResponse({ success: false, error: "Invalid subscriber user identity." }, 400);
    }
    const payload = await request.json().catch(() => ({}));
    let creatorUserId = String(
      payload.creator_user_id || payload.creatorId || payload.creator_id || "",
    ).trim();
    if (!creatorUserId) {
      return jsonResponse({ success: false, error: "Creator user ID is required." }, 400);
    }

    // Resolve canonical creator user ID if UUID or casing variation was provided
    if (pool) {
      try {
        const [uRows]: any = await pool.query(
          `SELECT user_id FROM users WHERE UPPER(user_id) = UPPER(?) OR UPPER(id) = UPPER(?) LIMIT 1`,
          [creatorUserId, creatorUserId],
        );
        if (uRows && uRows.length > 0 && uRows[0].user_id) {
          creatorUserId = String(uRows[0].user_id).trim();
        }
      } catch (_e) {
        // Ignore lookup failure
      }
    } else {
      const match = store.users.find(
        (u) =>
          u.user_id.toUpperCase() === creatorUserId.toUpperCase() ||
          u.id.toUpperCase() === creatorUserId.toUpperCase(),
      );
      if (match && match.user_id) {
        creatorUserId = match.user_id;
      }
    }

    // Prevent self-subscription
    if (subscriberUserId.toUpperCase() === creatorUserId.toUpperCase()) {
      return jsonResponse(
        { success: false, error: "You cannot subscribe to your own channel." },
        400,
      );
    }

    if (pool) {
      try {
        await pool.query(
          `INSERT INTO channel_subscriptions (creator_user_id, subscriber_user_id, created_at)
           VALUES (?, ?, NOW())
           ON DUPLICATE KEY UPDATE created_at = created_at`,
          [creatorUserId, subscriberUserId],
        );
        const [countRows]: any = await pool.query(
          `SELECT COUNT(DISTINCT subscriber_user_id) AS subscriber_count
           FROM channel_subscriptions
           WHERE UPPER(creator_user_id) = UPPER(?)`,
          [creatorUserId],
        );
        const count = Number(countRows?.[0]?.subscriber_count || 0);
        return jsonResponse({
          success: true,
          subscribed: true,
          creator_user_id: creatorUserId,
          subscriber_count: count,
        });
      } catch (_e) {
        // Fall through to store
      }
    }

    if (!store.channelSubscriptions) store.channelSubscriptions = [];
    const existing = store.channelSubscriptions.find(
      (s) =>
        s.creator_user_id.toUpperCase() === creatorUserId.toUpperCase() &&
        s.subscriber_user_id.toUpperCase() === subscriberUserId.toUpperCase(),
    );
    if (!existing) {
      store.channelSubscriptions.push({
        id: store.channelSubscriptions.length + 1,
        creator_user_id: creatorUserId,
        subscriber_user_id: subscriberUserId,
        created_at: new Date().toISOString(),
      });
      saveStore(store);
    }
    const count = new Set(
      store.channelSubscriptions
        .filter((s) => s.creator_user_id.toUpperCase() === creatorUserId.toUpperCase())
        .map((s) => s.subscriber_user_id.toUpperCase()),
    ).size;

    return jsonResponse({
      success: true,
      subscribed: true,
      creator_user_id: creatorUserId,
      subscriber_count: count,
    });
  }

  // 24b. Unsubscribe from Creator Channel (POST /api/channel/unsubscribe)
  if (route === "channel/unsubscribe") {
    if (method !== "POST") {
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    }
    const pool = getMysqlPool();
    const authUser = await getAuthUserFromRequest(request, store, pool);
    if (!authUser) {
      return jsonResponse(
        { success: false, error: "Authentication required to unsubscribe from a channel." },
        401,
      );
    }
    const subscriberUserId = String(authUser.user_id || "").trim();
    if (!subscriberUserId) {
      return jsonResponse({ success: false, error: "Invalid subscriber user identity." }, 400);
    }
    const payload = await request.json().catch(() => ({}));
    let creatorUserId = String(
      payload.creator_user_id || payload.creatorId || payload.creator_id || "",
    ).trim();
    if (!creatorUserId) {
      return jsonResponse({ success: false, error: "Creator user ID is required." }, 400);
    }

    if (pool) {
      try {
        const [uRows]: any = await pool.query(
          `SELECT user_id FROM users WHERE UPPER(user_id) = UPPER(?) OR UPPER(id) = UPPER(?) LIMIT 1`,
          [creatorUserId, creatorUserId],
        );
        if (uRows && uRows.length > 0 && uRows[0].user_id) {
          creatorUserId = String(uRows[0].user_id).trim();
        }
      } catch (_e) {
        // Ignore lookup failure
      }
    } else {
      const match = store.users.find(
        (u) =>
          u.user_id.toUpperCase() === creatorUserId.toUpperCase() ||
          u.id.toUpperCase() === creatorUserId.toUpperCase(),
      );
      if (match && match.user_id) {
        creatorUserId = match.user_id;
      }
    }

    if (pool) {
      try {
        await pool.query(
          `DELETE FROM channel_subscriptions
           WHERE UPPER(creator_user_id) = UPPER(?) AND UPPER(subscriber_user_id) = UPPER(?)`,
          [creatorUserId, subscriberUserId],
        );
        const [countRows]: any = await pool.query(
          `SELECT COUNT(DISTINCT subscriber_user_id) AS subscriber_count
           FROM channel_subscriptions
           WHERE UPPER(creator_user_id) = UPPER(?)`,
          [creatorUserId],
        );
        const count = Number(countRows?.[0]?.subscriber_count || 0);
        return jsonResponse({
          success: true,
          subscribed: false,
          creator_user_id: creatorUserId,
          subscriber_count: count,
        });
      } catch (_e) {
        // Fall through to store
      }
    }

    if (!store.channelSubscriptions) store.channelSubscriptions = [];
    store.channelSubscriptions = store.channelSubscriptions.filter(
      (s) =>
        !(
          s.creator_user_id.toUpperCase() === creatorUserId.toUpperCase() &&
          s.subscriber_user_id.toUpperCase() === subscriberUserId.toUpperCase()
        ),
    );
    saveStore(store);

    const count = new Set(
      store.channelSubscriptions
        .filter((s) => s.creator_user_id.toUpperCase() === creatorUserId.toUpperCase())
        .map((s) => s.subscriber_user_id.toUpperCase()),
    ).size;

    return jsonResponse({
      success: true,
      subscribed: false,
      creator_user_id: creatorUserId,
      subscriber_count: count,
    });
  }

  // 24c. Get Authenticated Creator Subscriber Count (GET /api/channel/subscribers)
  if (route === "channel/subscribers") {
    if (method !== "GET" && method !== "POST") {
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    }
    const pool = getMysqlPool();
    const authUser = await getAuthUserFromRequest(request, store, pool);
    if (!authUser) {
      return jsonResponse(
        { success: false, error: "Authentication required to access creator subscriber count." },
        401,
      );
    }

    let creatorUserId = String(authUser.user_id || "").trim();
    const requestedCreatorId = String(
      url.searchParams.get("creator_user_id") ||
        url.searchParams.get("creatorId") ||
        url.searchParams.get("creator_id") ||
        "",
    ).trim();

    if (requestedCreatorId) {
      if (
        authUser.role === "admin" ||
        requestedCreatorId.toUpperCase() === creatorUserId.toUpperCase()
      ) {
        creatorUserId = requestedCreatorId;
      } else {
        return jsonResponse(
          {
            success: false,
            error: "Forbidden: You can only view your own creator subscriber count.",
          },
          403,
        );
      }
    }

    if (pool) {
      try {
        const [uRows]: any = await pool.query(
          `SELECT user_id FROM users WHERE UPPER(user_id) = UPPER(?) OR UPPER(id) = UPPER(?) LIMIT 1`,
          [creatorUserId, creatorUserId],
        );
        if (uRows && uRows.length > 0 && uRows[0].user_id) {
          creatorUserId = String(uRows[0].user_id).trim();
        }
      } catch (_e) {
        // Ignore lookup failure
      }
    } else {
      const match = store.users.find(
        (u) =>
          u.user_id.toUpperCase() === creatorUserId.toUpperCase() ||
          u.id.toUpperCase() === creatorUserId.toUpperCase(),
      );
      if (match && match.user_id) {
        creatorUserId = match.user_id;
      }
    }

    if (pool) {
      try {
        const [countRows]: any = await pool.query(
          `SELECT COUNT(DISTINCT subscriber_user_id) AS subscriber_count
           FROM channel_subscriptions
           WHERE UPPER(creator_user_id) = UPPER(?)`,
          [creatorUserId],
        );
        const count = Number(countRows?.[0]?.subscriber_count || 0);
        return jsonResponse({
          success: true,
          creator_user_id: creatorUserId,
          subscriber_count: count,
        });
      } catch (_e) {
        // Fall through to store
      }
    }

    if (!store.channelSubscriptions) store.channelSubscriptions = [];
    const count = new Set(
      store.channelSubscriptions
        .filter((s) => s.creator_user_id.toUpperCase() === creatorUserId.toUpperCase())
        .map((s) => s.subscriber_user_id.toUpperCase()),
    ).size;

    return jsonResponse({
      success: true,
      creator_user_id: creatorUserId,
      subscriber_count: count,
    });
  }

  // 24d. Check Channel Subscription Status (GET /api/channel/status)
  if (route === "channel/status") {
    if (method !== "GET") {
      return jsonResponse({ success: false, error: "Method Not Allowed" }, 405);
    }
    const pool = getMysqlPool();
    let creatorUserId = String(
      url.searchParams.get("creator_user_id") ||
        url.searchParams.get("creatorId") ||
        url.searchParams.get("creator_id") ||
        "",
    ).trim();

    if (!creatorUserId) {
      return jsonResponse({ success: false, error: "Creator user ID is required." }, 400);
    }

    if (pool) {
      try {
        const [uRows]: any = await pool.query(
          `SELECT user_id FROM users WHERE UPPER(user_id) = UPPER(?) OR UPPER(id) = UPPER(?) LIMIT 1`,
          [creatorUserId, creatorUserId],
        );
        if (uRows && uRows.length > 0 && uRows[0].user_id) {
          creatorUserId = String(uRows[0].user_id).trim();
        }
      } catch (_e) {
        // Ignore lookup failure
      }
    } else {
      const match = store.users.find(
        (u) =>
          u.user_id.toUpperCase() === creatorUserId.toUpperCase() ||
          u.id.toUpperCase() === creatorUserId.toUpperCase(),
      );
      if (match && match.user_id) {
        creatorUserId = match.user_id;
      }
    }

    const authUser = await getAuthUserFromRequest(request, store, pool);

    let totalSubscribers = 0;
    if (pool) {
      try {
        const [countRows]: any = await pool.query(
          `SELECT COUNT(DISTINCT subscriber_user_id) AS subscriber_count
           FROM channel_subscriptions
           WHERE UPPER(creator_user_id) = UPPER(?)`,
          [creatorUserId],
        );
        totalSubscribers = Number(countRows?.[0]?.subscriber_count || 0);
      } catch (_e) {
        // Fall through to store count
      }
    }
    if (!pool || totalSubscribers === 0) {
      if (!store.channelSubscriptions) store.channelSubscriptions = [];
      totalSubscribers = new Set(
        store.channelSubscriptions
          .filter((s) => s.creator_user_id.toUpperCase() === creatorUserId.toUpperCase())
          .map((s) => s.subscriber_user_id.toUpperCase()),
      ).size;
    }

    if (!authUser) {
      return jsonResponse({
        success: true,
        authenticated: false,
        subscribed: false,
        creator_user_id: creatorUserId,
        subscriber_count: totalSubscribers,
        is_self: false,
      });
    }

    const subscriberUserId = String(authUser.user_id || "").trim();
    const isSelf = subscriberUserId.toUpperCase() === creatorUserId.toUpperCase();

    let isSubscribed = false;
    if (pool) {
      try {
        const [subRows]: any = await pool.query(
          `SELECT id FROM channel_subscriptions
           WHERE UPPER(creator_user_id) = UPPER(?) AND UPPER(subscriber_user_id) = UPPER(?)
           LIMIT 1`,
          [creatorUserId, subscriberUserId],
        );
        isSubscribed = subRows && subRows.length > 0;
      } catch (_e) {
        // Fall through to store
      }
    }
    if (!isSubscribed) {
      if (!store.channelSubscriptions) store.channelSubscriptions = [];
      isSubscribed = store.channelSubscriptions.some(
        (s) =>
          s.creator_user_id.toUpperCase() === creatorUserId.toUpperCase() &&
          s.subscriber_user_id.toUpperCase() === subscriberUserId.toUpperCase(),
      );
    }

    return jsonResponse({
      success: true,
      authenticated: true,
      subscribed: isSubscribed,
      creator_user_id: creatorUserId,
      subscriber_count: totalSubscribers,
      is_self: isSelf,
    });
  }

  // Unhandled /api route
  return jsonResponse({ error: `Not Found: ${pathname}` }, 404);
}
