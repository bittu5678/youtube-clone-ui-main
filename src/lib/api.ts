/**
 * FaceTube - Centralized Production PHP REST API Client
 * Replaces Supabase queries with direct PHP + MySQL backend endpoints.
 * Base URL configurable via VITE_API_BASE_URL (defaults to /api)
 */

import { cropAndResizeTo9to16 } from "./image-effects";

export const PRODUCTION_API_URL = "https://api.facetube.online";

/**
 * Returns the base URL for FaceTube PHP API calls.
 * 1. Explicit override: VITE_API_BASE_URL (if provided)
 * 2. Production browser: Automatically defaults to https://api.facetube.online on facetube.online
 * 3. Production SSR: Defaults to https://api.facetube.online when NODE_ENV is production
 * 4. Local development / Preview: Defaults to /api (handled by Vite dev middleware)
 */
export function getApiBaseUrl(): string {
  // 1. Explicit environment variable override
  const envApiUrl =
    (typeof import.meta !== "undefined" && import.meta.env?.["VITE_API_BASE_URL"]) ||
    (typeof process !== "undefined" && process.env?.["VITE_API_BASE_URL"]);
  if (envApiUrl) {
    const rawApi = String(envApiUrl).trim().replace(/\/+$/, "");
    if (
      rawApi.toLowerCase().includes("api.facetube.online") &&
      rawApi.toLowerCase().endsWith("/api")
    ) {
      return rawApi.replace(/\/api\/?$/i, "");
    }
    return rawApi;
  }

  // 2. Production browser: Automatically route to live PHP + MySQL backend on api.facetube.online
  if (typeof window !== "undefined") {
    const host = window.location.hostname.toLowerCase();
    const isLocalOrPreview =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host.endsWith(".local") ||
      host.includes("run.app") ||
      host.includes("aistudio");

    if (
      host === "facetube.online" ||
      host === "www.facetube.online" ||
      host === "api.facetube.online" ||
      host.endsWith(".facetube.online") ||
      (!isLocalOrPreview && (import.meta.env?.PROD || process.env["NODE_ENV"] === "production"))
    ) {
      return PRODUCTION_API_URL;
    }
  }

  // 3. Production SSR (Server-Side Rendering)
  if (typeof window === "undefined" && process.env["NODE_ENV"] === "production") {
    if (process.env["USE_REMOTE_PHP_API"] === "true") {
      return PRODUCTION_API_URL;
    }
    return "/api";
  }

  // 4. Local development / Preview fallback (handled by Vite dev middleware)
  return "/api";
}

export const API_BASE_URL = getApiBaseUrl();

export const TOKEN_STORAGE_KEY = "facetube_auth_token";

export function getStoredAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (raw && raw !== "null" && raw !== "undefined" && raw.trim() !== "") {
      return raw.trim();
    }

    // Secondary recovery: check session payload in case token storage key was desynchronized
    const sessionRaw = localStorage.getItem("facetube_session_v2");
    if (sessionRaw) {
      const parsed = JSON.parse(sessionRaw);
      if (
        parsed &&
        typeof parsed.token === "string" &&
        parsed.token !== "null" &&
        parsed.token !== "undefined" &&
        parsed.token.trim() !== ""
      ) {
        const recoveredToken = parsed.token.trim();
        localStorage.setItem(TOKEN_STORAGE_KEY, recoveredToken);
        return recoveredToken;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function setStoredAuthToken(token: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (
      token &&
      typeof token === "string" &&
      token !== "null" &&
      token !== "undefined" &&
      token.trim() !== ""
    ) {
      localStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
    } else {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch {
    // Storage quota or private browsing
  }
}

/**
 * Universal API Fetch Wrapper with Bearer Authentication
 */
export async function apiFetch<T = unknown>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getStoredAuthToken();
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (options.headers) {
    if (typeof (options.headers as any).entries === "function") {
      for (const [k, v] of (options.headers as any).entries()) {
        headers[k] = v;
      }
    } else {
      Object.assign(headers, options.headers);
    }
  }

  // Do not set Content-Type if sending FormData (browser sets boundary)
  if (!(options.body instanceof FormData) && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = "application/json";
  }

  const existingAuth = headers["Authorization"] || headers["authorization"];
  if (token && !existingAuth) {
    headers["Authorization"] = `Bearer ${token}`;
    headers["X-Authorization"] = `Bearer ${token}`;
  } else if (existingAuth && !headers["X-Authorization"] && !headers["x-authorization"]) {
    headers["X-Authorization"] = existingAuth;
  }

  const cleanEndpoint = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const baseUrl = getApiBaseUrl();
  let url = `${baseUrl}${cleanEndpoint}`;

  // When running on the server (SSR / Node.js runtime), fetch requires an absolute URL with protocol and host
  if (typeof window === "undefined" && !url.startsWith("http://") && !url.startsWith("https://")) {
    const port = process.env["PORT"] || 3000;
    url = `http://127.0.0.1:${port}${url.startsWith("/") ? "" : "/"}${url}`;
  }

  const res = await fetch(url, {
    ...options,
    headers,
  });

  const contentType = res.headers.get("content-type") || "";
  let data: any = null;

  if (contentType.includes("application/json")) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  } else {
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (
    typeof data === "string" &&
    (data.includes("<?php") || data.startsWith("<!DOCTYPE") || data.startsWith("<html"))
  ) {
    throw new Error(`Invalid response received from endpoint ${cleanEndpoint}`);
  }

  if (!res.ok) {
    const errorMsg =
      (typeof data === "object" && (data?.error || data?.message || data?.msg)) ||
      (typeof data === "string" && data) ||
      `HTTP error ${res.status}: ${res.statusText}`;
    const err = new Error(errorMsg) as Error & { status?: number; data?: unknown };
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data as T;
}

/**
 * Modular FaceTube PHP Backend Endpoints
 */
export const api = {
  // Authentication
  auth: {
    register: async (params: {
      name: string;
      mobile: string;
      email: string;
      password: string;
      referralCode?: string;
    }) => {
      const res = await apiFetch<{
        success: boolean;
        token?: string;
        user?: any;
        userId?: string;
        message?: string;
      }>("/auth/register.php", {
        method: "POST",
        body: JSON.stringify(params),
      });
      if (res.token) {
        setStoredAuthToken(res.token);
      }
      return res;
    },

    login: async (params: { identifier: string; password: string }) => {
      const res = await apiFetch<{
        success: boolean;
        token?: string;
        user?: any;
        message?: string;
      }>("/auth/login.php", {
        method: "POST",
        body: JSON.stringify(params),
      });
      if (res.token) {
        setStoredAuthToken(res.token);
      }
      return res;
    },

    logout: async () => {
      try {
        await apiFetch("/auth/logout.php", { method: "POST" });
      } finally {
        setStoredAuthToken(null);
      }
    },

    me: async () => {
      return apiFetch<{
        authenticated: boolean;
        user: any | null;
      }>("/auth/me.php");
    },

    changePassword: async (params: {
      currentPassword: string;
      newPassword: string;
      confirmPassword?: string;
    }) => {
      return apiFetch<{
        success: boolean;
        message?: string;
      }>("/auth/change-password.php", {
        method: "POST",
        body: JSON.stringify(params),
      });
    },

    forgotPassword: async (params: { identifier: string }) => {
      return apiFetch<{
        success: boolean;
        message: string;
      }>("/auth/forgot-password.php", {
        method: "POST",
        body: JSON.stringify(params),
      });
    },

    resetPassword: async (params: {
      email: string;
      token: string;
      newPassword: string;
      confirmPassword?: string;
    }) => {
      return apiFetch<{
        success: boolean;
        message: string;
      }>("/auth/reset-password.php", {
        method: "POST",
        body: JSON.stringify(params),
      });
    },
  },

  // Users & Profiles
  users: {
    getProfile: async (userId?: string) => {
      const q = userId ? `?userId=${encodeURIComponent(userId)}` : "";
      return apiFetch<{ success: boolean; profile: any }>(`/users/profile.php${q}`);
    },

    updateProfile: async (data: { name?: string; mobile?: string; avatar_url?: string }) => {
      return apiFetch<{ success: boolean; profile: any; message?: string }>("/users/profile.php", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },

    listUsers: async () => {
      return apiFetch<{ success: boolean; users: any[]; total: number }>("/users/list.php");
    },

    updateChannelLogo: async (data: {
      userId?: string;
      channelLogoUrl?: string;
      channelName?: string;
    }) => {
      return apiFetch<{
        success: boolean;
        message?: string;
        channel_logo_url?: string;
        channel_name?: string;
      }>("/users/channel-logo.php", {
        method: "POST",
        body: JSON.stringify({
          userId: data.userId,
          channel_logo_url: data.channelLogoUrl,
          channel_name: data.channelName,
        }),
      });
    },
  },

  // Videos
  videos: {
    list: async (params?: {
      userId?: string;
      videoType?: "free" | "premium";
      contentType?: "short" | "long";
      category?: string;
      search?: string;
      limit?: number;
      offset?: number;
    }) => {
      const searchParams = new URLSearchParams();
      if (params?.userId) searchParams.set("userId", params.userId);
      if (params?.videoType) searchParams.set("videoType", params.videoType);
      if (params?.contentType) searchParams.set("contentType", params.contentType);
      if (params?.category) searchParams.set("category", params.category);
      if (params?.search) searchParams.set("search", params.search);
      if (params?.limit) searchParams.set("limit", String(params.limit));
      if (params?.offset) searchParams.set("offset", String(params.offset));

      const qs = searchParams.toString();
      return apiFetch<{ success: boolean; videos: any[]; total: number }>(
        `/videos/list.php${qs ? `?${qs}` : ""}`,
      );
    },

    get: async (id: string) => {
      return apiFetch<{ success: boolean; video: any }>(
        `/videos/get.php?id=${encodeURIComponent(id)}`,
      );
    },

    create: async (videoData: any) => {
      return apiFetch<{ success: boolean; video: any }>("/videos/create.php", {
        method: "POST",
        body: JSON.stringify(videoData),
      });
    },

    like: async (videoId: string, userId: string) => {
      return apiFetch<{ success: boolean; liked: boolean; likes: number }>("/videos/like.php", {
        method: "POST",
        body: JSON.stringify({ videoId, userId }),
      });
    },

    getCounts: async (userId?: string) => {
      const q = userId ? `?userId=${encodeURIComponent(userId)}` : "";
      return apiFetch<{ success: boolean; counts: any }>(`/videos/counts.php${q}`);
    },

    promote: async (data: {
      videoId: string;
      planId: string;
      durationDays: number;
      paymentId?: string;
    }) => {
      return apiFetch<{ success: boolean; message: string; promotionExpiresAt: string }>(
        "/videos/promote.php",
        {
          method: "POST",
          body: JSON.stringify(data),
        },
      );
    },
  },

  // Comments
  comments: {
    list: async (videoId: string) => {
      return apiFetch<{ success: boolean; comments: any[]; total: number }>(
        `/comments/list.php?videoId=${encodeURIComponent(videoId)}`,
      );
    },

    create: async (data: {
      videoId: string;
      userId: string;
      userName: string;
      avatarUrl?: string;
      comment: string;
    }) => {
      return apiFetch<{ success: boolean; comment: any }>("/comments/create.php", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
  },

  // Images Media Library
  images: {
    list: async (params?: { userId?: string; category?: string; limit?: number }) => {
      const searchParams = new URLSearchParams();
      if (params?.userId) searchParams.set("userId", params.userId);
      if (params?.category) searchParams.set("category", params.category);
      if (params?.limit) searchParams.set("limit", String(params.limit));

      const qs = searchParams.toString();
      return apiFetch<{ success: boolean; images: any[]; total: number }>(
        `/images/list.php${qs ? `?${qs}` : ""}`,
      );
    },

    create: async (imageData: any) => {
      return apiFetch<{ success: boolean; image: any }>("/images/create.php", {
        method: "POST",
        body: JSON.stringify(imageData),
      });
    },
  },

  // Wallet & Income Ledger
  wallet: {
    getBalance: async (userId?: string) => {
      const q = userId ? `?userId=${encodeURIComponent(userId)}` : "";
      return apiFetch<{ success: boolean; wallet: any }>(`/wallet/balance.php${q}`);
    },

    getTransactions: async (userId?: string, limit?: number) => {
      const params = new URLSearchParams();
      if (userId) params.set("userId", userId);
      if (limit) params.set("limit", String(limit));
      const qs = params.toString();
      return apiFetch<{ success: boolean; transactions: any[]; total: number }>(
        `/wallet/transactions.php${qs ? `?${qs}` : ""}`,
      );
    },

    getGlobalPoolSummary: async (userId?: string) => {
      const q = userId ? `?userId=${encodeURIComponent(userId)}` : "";
      return apiFetch<{
        success: boolean;
        userId?: string | null;
        excludedUserId: string | null;
        poolAmount: number;
        poolPaise: number;
        eligibleVideoCount: number;
        platformEligibleVideoCount?: number;
        distinctCreatorCount: number;
        platformDistinctCreatorCount?: number;
        totalAdEarnings: number;
        platformTotalAdEarnings?: number;
        userEligibleVideoCount?: number | null;
        userTotalAdEarnings?: number | null;
        estimatedEqualSharePerVideo: number | null;
        weightingMode: "ad_earnings_weighted" | "equal_fallback";
      }>(`/wallet/global-pool-summary.php${q}`);
    },

    withdraw: async (
      data: {
        userId: string;
        amount: number;
        bankDetails?: {
          accountHolder?: string;
          accountNumber?: string;
          ifscCode?: string;
          upiId?: string;
          bankName?: string;
        };
      },
      options?: RequestInit,
    ) => {
      return apiFetch<{
        success: boolean;
        message?: string;
        transaction?: any;
        updatedWallet?: any;
        error?: string;
      }>("/wallet/withdraw.php", {
        method: "POST",
        body: JSON.stringify(data),
        ...options,
      });
    },

    getEarningsHistory: async (
      userId?: string,
      options?: number | { period?: "7D" | "30D" | "90D" | "12M"; days?: number },
    ) => {
      const params = new URLSearchParams();
      if (userId) params.set("user_id", userId);
      if (typeof options === "number") {
        params.set("days", String(options));
      } else if (options) {
        if (options.period) params.set("period", options.period);
        if (options.days) params.set("days", String(options.days));
      }
      return apiFetch<{
        success: boolean;
        user_id: string;
        period: "7D" | "30D" | "90D" | "12M";
        days: number;
        summary: {
          total_revenue: number;
          referral: number;
          global: number;
          adsense: number;
          admob: number;
          affiliate: number;
          ad_boost: number;
        };
        history: Array<{
          date: string;
          day: string;
          revenue: number;
          referral: number;
          global: number;
          adsense: number;
          admob: number;
          affiliate: number;
          ad_boost: number;
          referral_income: number;
          global_income: number;
          adsense_income: number;
          admob_income: number;
          affiliate_income: number;
          ad_boost_income: number;
          tx_count: number;
        }>;
      }>(`/wallet/earnings-history.php?${params.toString()}`);
    },
  },

  // KYC
  kyc: {
    getPersonal: async (userId?: string) => {
      const q = userId ? `?userId=${encodeURIComponent(userId)}` : "";
      return apiFetch<{ success: boolean; kyc: any }>(`/kyc/personal.php${q}`);
    },

    savePersonal: async (data: any) => {
      return apiFetch<{ success: boolean; message: string }>("/kyc/personal.php", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },

    getBank: async (userId?: string) => {
      const q = userId ? `?userId=${encodeURIComponent(userId)}` : "";
      return apiFetch<{ success: boolean; kyc: any }>(`/kyc/bank.php${q}`);
    },

    saveBank: async (data: any) => {
      return apiFetch<{ success: boolean; message: string }>("/kyc/bank.php", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },
  },

  // Referrals
  referrals: {
    getDashboard: async (userId?: string) => {
      const q = userId ? `?userId=${encodeURIComponent(userId)}` : "";
      return apiFetch<{ success: boolean; dashboard: any }>(`/referrals/dashboard.php${q}`);
    },
    getTeam: async (userId?: string, level?: number | "all") => {
      const params = new URLSearchParams();
      if (userId) params.set("userId", userId);
      if (level && level !== "all") params.set("level", String(level));
      const q = params.toString() ? `?${params.toString()}` : "";
      return apiFetch<{
        success: boolean;
        userId: string;
        totalTeamCount: number;
        directCount: number;
        levelCounts: Record<string, number>;
        members: Array<{
          id: string;
          userId: string;
          name: string;
          level: number;
          sponsor: string;
          sponsorUserId: string;
          joinedAt: string;
          role: string;
          rank: string;
          teamSize: number;
          status: "Active" | "Inactive";
          access: "Granted" | "Restricted";
        }>;
      }>(`/referrals/team.php${q}`);
    },
  },

  // Certificates
  certificates: {
    get: async (userId?: string) => {
      const q = userId ? `?userId=${encodeURIComponent(userId)}` : "";
      return apiFetch<{ success: boolean; certificate: any }>(`/certificates/get.php${q}`);
    },

    save: async (certData: any) => {
      return apiFetch<{ success: boolean; message: string; certificateId: string }>(
        "/certificates/save.php",
        {
          method: "POST",
          body: JSON.stringify(certData),
        },
      );
    },
  },

  // Payments & Transactions
  payments: {
    createOrder: async (data: {
      purpose: "premium_video_upload" | "ads_promotion" | "paid_subscription";
      userId: string;
      userName?: string;
      videoId?: string;
      contentType?: "short" | "long";
      planId?: string;
    }) => {
      return apiFetch<{
        orderId: string;
        amount: number;
        amountInSubunits: number;
        currency: "INR";
        purpose: string;
        keyId: string;
      }>("/payments/create-order.php", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },

    verify: async (data: {
      orderId: string;
      paymentId: string;
      signature?: string;
      userId: string;
      userName?: string;
      videoId?: string;
      purpose: "premium_video_upload" | "ads_promotion" | "paid_subscription";
      referrerUserId?: string | null;
      planId?: string;
      amount?: number;
      metadata?: Record<string, unknown>;
    }) => {
      return apiFetch<{
        verified: boolean;
        paymentId: string;
        orderId: string;
        amount: number;
        purpose?: string;
        planId?: string;
        txNumber?: number;
        isSpecialTransaction?: boolean;
        specialTag?: string;
        subscription?: {
          subscriptionId: string;
          userId: string;
          planId: string;
          orderId: string;
          paymentId: string;
          amount: number;
          currency: string;
          status: string;
          startsAt: string;
          expiresAt: string;
          durationDays?: number;
        };
        distribution?: any;
        duplicate?: boolean;
        error?: string;
      }>("/payments/verify.php", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },

    getTransactions: async () => {
      return apiFetch<{
        status: string;
        lastTxNumber: number;
        totalTransactions: number;
        transactions: any[];
      }>("/payments/transactions.php");
    },
  },

  // File Uploads
  uploads: {
    uploadImage: async (file: File) => {
      // Proportional 9:16 crop & resize to 1080x1920 (strict vertical format requirement)
      const processedFile = await cropAndResizeTo9to16(file);
      const formData = new FormData();
      formData.append("image", processedFile);
      return apiFetch<{
        success: boolean;
        url: string;
        fileName: string;
        format: string;
        fileSize: string;
      }>("/uploads/image.php", {
        method: "POST",
        body: formData,
      });
    },

    uploadVideo: async (file: File) => {
      const formData = new FormData();
      formData.append("video", file);
      return apiFetch<{
        success: boolean;
        url: string;
        fileName: string;
        format: string;
      }>("/uploads/video.php", {
        method: "POST",
        body: formData,
      });
    },

    uploadKyc: async (file: File) => {
      const formData = new FormData();
      formData.append("document", file);
      return apiFetch<{
        success: boolean;
        url: string;
        fileName: string;
      }>("/uploads/kyc.php", {
        method: "POST",
        body: formData,
      });
    },
  },

  // Admin
  admin: {
    getStats: async () => {
      return apiFetch<{ success: boolean; stats: any }>("/admin/stats.php");
    },

    updateRole: async (targetUserId: string, role: "admin" | "user") => {
      return apiFetch<{ success: boolean; message: string }>("/admin/role.php", {
        method: "POST",
        body: JSON.stringify({ targetUserId, role }),
      });
    },

    listVideos: async (params?: { includeBlocked?: boolean }) => {
      const q = params?.includeBlocked ? "?include_blocked=1" : "";
      return apiFetch<{
        success: boolean;
        videos: any[];
        counts: { total: number; blocked: number; shorts: number; long: number };
      }>(`/admin/videos.php${q}`);
    },

    updateVideoStatus: async (params: { videoId: string; isBlocked: boolean; reason?: string }) => {
      return apiFetch<{
        success: boolean;
        message: string;
        video_id: string;
        is_blocked: boolean;
      }>("/admin/videos.php", {
        method: "POST",
        body: JSON.stringify({
          videoId: params.videoId,
          isBlocked: params.isBlocked,
          reason: params.reason || "Content moderation",
        }),
      });
    },

    bulkPayout: async (params: {
      payouts: Array<{ userId: string; amount: number; transactionId?: string }>;
      notes?: string;
    }) => {
      return apiFetch<{
        success: boolean;
        message: string;
        batch_id: string;
        total_recipients: number;
        total_amount: number;
        processed: any[];
      }>("/admin/bulk-payout.php", {
        method: "POST",
        body: JSON.stringify(params),
      });
    },

    createCategory: async (name: string) => {
      return apiFetch<{
        success: boolean;
        message: string;
        category?: {
          id: string | number;
          name: string;
          slug: string;
          created_by?: string;
          created_at?: string;
        };
        error?: string;
      }>("/admin/categories.php", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
    },

    listSubscriptions: async (params?: {
      page?: number;
      limit?: number;
      search?: string;
      status?: "all" | "active" | "expired";
      id?: string;
    }) => {
      const q = new URLSearchParams();
      if (params?.page) q.set("page", String(params.page));
      if (params?.limit) q.set("limit", String(params.limit));
      if (params?.search) q.set("search", params.search);
      if (params?.status && params.status !== "all") q.set("status", params.status);
      if (params?.id) q.set("id", params.id);
      const qs = q.toString() ? `?${q.toString()}` : "";
      return apiFetch<{
        success: boolean;
        stats: {
          total: number;
          active: number;
          expired: number;
          totalRevenue: number;
        };
        pagination: {
          page: number;
          limit: number;
          totalItems: number;
          totalPages: number;
        };
        subscriptions: Array<{
          subscriptionId: string;
          userId: string;
          userName?: string;
          userEmail?: string;
          planId: string;
          planName: string;
          amount: number;
          currency: string;
          status: string;
          isExpired: boolean;
          remainingDays: number;
          orderId: string;
          paymentId: string;
          startsAt: string;
          expiresAt: string;
          createdAt: string;
          perks?: string[];
        }>;
        subscription?: any;
        error?: string;
      }>(`/admin/subscriptions.php${qs}`);
    },

    listRefundRequests: async (params?: {
      status?: string;
      search?: string;
      page?: number;
      limit?: number;
      id?: string;
    }) => {
      const q = new URLSearchParams();
      if (params?.status) q.set("status", params.status);
      if (params?.search) q.set("search", params.search);
      if (params?.page) q.set("page", String(params.page));
      if (params?.limit) q.set("limit", String(params.limit));
      if (params?.id) q.set("id", params.id);
      const qs = q.toString() ? `?${q.toString()}` : "";
      return apiFetch<{
        success: boolean;
        stats: {
          total: number;
          pending: number;
          approved: number;
          rejected: number;
          refunded: number;
          totalRefundAmount: number;
          refundedAmount: number;
        };
        pagination: {
          page: number;
          limit: number;
          totalItems: number;
          totalPages: number;
        };
        requests: Array<{
          id: string;
          subscriptionId: string;
          userId: string;
          userName: string;
          userEmail: string;
          planId: string;
          planName: string;
          paymentId: string;
          orderId: string;
          amount: number;
          currency: string;
          reason: string;
          status: "pending" | "approved" | "rejected" | "processing" | "refunded";
          gatewayStatus: string;
          gatewayRefundId?: string | null;
          adminNote?: string | null;
          reviewedBy?: string | null;
          reviewedAt?: string | null;
          createdAt: string;
          updatedAt: string;
        }>;
        request?: any;
        error?: string;
      }>(`/admin/subscription-refunds.php${qs}`);
    },

    reviewRefundRequest: async (data: {
      requestId: string;
      decision: "approved" | "rejected";
      adminNote?: string;
    }) => {
      return apiFetch<{
        success: boolean;
        message?: string;
        request?: any;
        gatewayRefundId?: string;
        gatewayAvailable?: boolean;
        error?: string;
      }>("/admin/subscription-refund-review.php", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },

    getEarningsReport: async (params?: {
      search?: string;
      startDate?: string;
      endDate?: string;
      page?: number;
      limit?: number;
      dateMode?: "joined" | "activity";
      export?: "csv";
    }) => {
      const query = new URLSearchParams();
      if (params?.search) query.set("search", params.search);
      if (params?.startDate) query.set("start_date", params.startDate);
      if (params?.endDate) query.set("end_date", params.endDate);
      if (params?.page) query.set("page", String(params.page));
      if (params?.limit) query.set("limit", String(params.limit));
      if (params?.dateMode) query.set("date_mode", params.dateMode);
      if (params?.export) query.set("export", params.export);
      const qStr = query.toString() ? `?${query.toString()}` : "";
      return apiFetch<{
        success: boolean;
        users: Array<{
          id: string;
          userId: string;
          name: string;
          email: string;
          role: string;
          referralCode: string | null;
          createdAt: string;
          balance: number;
          totalEarned: number;
          totalWithdrawn: number;
          referralIncome: number;
          globalIncome: number;
          adsenseIncome: number;
          admobIncome: number;
          totalAdEarning: number;
          affiliateIncome: number;
        }>;
        pagination: {
          page: number;
          limit: number;
          total: number;
          totalPages: number;
        };
        summary: {
          totalUsers: number;
          totalWalletBalance: number;
          totalEarned: number;
          totalWithdrawn: number;
          totalReferralIncome: number;
          totalGlobalIncome: number;
          totalAdsenseIncome: number;
          totalAdmobIncome: number;
          totalAdEarning: number;
          totalAffiliateIncome: number;
        };
      }>(`/admin/earnings-report.php${qStr}`);
    },

    getUserWithdrawalHistory: async (
      userId: string,
      params?: { startDate?: string; endDate?: string },
    ) => {
      const query = new URLSearchParams();
      query.set("action", "withdrawals");
      query.set("userId", userId);
      if (params?.startDate) query.set("start_date", params.startDate);
      if (params?.endDate) query.set("end_date", params.endDate);
      return apiFetch<{
        success: boolean;
        userId: string;
        total: number;
        totalAmount: number;
        withdrawals: Array<{
          id: string;
          transactionId: string;
          userId: string;
          amount: number;
          status: string;
          description: string;
          createdAt: string;
        }>;
      }>(`/admin/earnings-report.php?${query.toString()}`);
    },

    getSettings: async () => {
      return apiFetch<{
        success: boolean;
        settings: {
          marketing_income_percentage: number;
          ads_referral_rates: Record<number, number>;
          adsense_client_id?: string;
          adsense_slot_watch?: string;
          adsense_slot_sidebar?: string;
          adsense_slot_feed?: string;
          adsense_enabled?: boolean;
        };
      }>("/admin/settings.php");
    },

    updateSettings: async (params: {
      marketingIncomePercentage?: number;
      marketing_income_percentage?: number;
      adsenseClientId?: string;
      adsense_client_id?: string;
      adsenseSlotWatch?: string;
      adsense_slot_watch?: string;
      adsenseSlotSidebar?: string;
      adsense_slot_sidebar?: string;
      adsenseSlotFeed?: string;
      adsense_slot_feed?: string;
      adsenseEnabled?: boolean;
      adsense_enabled?: boolean;
    }) => {
      return apiFetch<{
        success: boolean;
        message: string;
        marketing_income_percentage?: number;
      }>("/admin/settings.php", {
        method: "POST",
        body: JSON.stringify(params),
      });
    },

    recordAdSenseEarning: async (params: {
      userId: string;
      amount: number;
      reportMonth: string;
      referenceId?: string | undefined;
      videoId?: string | undefined;
      description?: string | undefined;
    }) => {
      return apiFetch<{
        success: boolean;
        message: string;
        transactionId: string;
        userId: string;
        amount: number;
        reportMonth: string;
        referenceId: string;
      }>("/admin/record-adsense-earning.php", {
        method: "POST",
        body: JSON.stringify(params),
      });
    },

    listAdSenseConflicts: async () => {
      return apiFetch<{
        success: boolean;
        count: number;
        conflicts: Array<{
          id: string;
          ledger_id: string;
          transaction_id: string;
          user_id: string;
          report_month: string;
          amount: number;
          primary_statement_tx_id?: string | null | undefined;
          conflict_type: string;
          conflict_reason: string;
          description: string;
          status: string;
          resolution_notes?: string | null | undefined;
          reviewed_by?: string | null | undefined;
          reviewed_at?: string | null | undefined;
          ledger_created_at: string;
          created_at: string;
        }>;
      }>("/admin/record-adsense-earning.php?action=conflicts");
    },

    listAdSenseStatements: async () => {
      return apiFetch<{
        success: boolean;
        count: number;
        statements: Array<{
          id: string;
          user_id: string;
          report_month: string;
          amount: number;
          reference_id: string;
          transaction_id: string;
          recorded_by: string;
          video_id?: string | null | undefined;
          description: string;
          status: string;
          has_conflicts?: number | undefined;
          created_at: string;
        }>;
      }>("/admin/record-adsense-earning.php?action=statements");
    },

    recordAdMobEarning: async (params: {
      userId: string;
      amount: number;
      reportMonth: string;
      impressions?: number;
      ecpm?: number;
      appId?: string;
      description?: string | undefined;
    }) => {
      return apiFetch<{
        success: boolean;
        message: string;
        transactionId: string;
        statementId?: string;
        userId: string;
        amount: number;
        reportMonth: string;
      }>("/admin/record-admob-earning.php", {
        method: "POST",
        body: JSON.stringify(params),
      });
    },

    listAdMobStatements: async () => {
      return apiFetch<{
        success: boolean;
        count: number;
        statements: Array<{
          id: string | number;
          statement_id: string;
          user_id: string;
          report_month: string;
          gross_amount: number;
          net_amount: number;
          impressions: number;
          ecpm: number;
          app_id: string | null;
          transaction_id: string;
          verified_by: string;
          status: string;
          created_at: string;
        }>;
      }>("/admin/record-admob-earning.php");
    },

    // Affiliate Marketing Administration
    affiliate: {
      getSettings: async () => {
        return apiFetch<{
          success: boolean;
          networks: Array<{
            id: string;
            name: string;
            isActive: boolean;
            creatorSharePercentage: number;
            holdingPeriodDays: number;
            allowedDomains: string;
            publisherId: string | null;
            hasWebhookSecret: boolean;
            hasApiKey: boolean;
            updatedBy?: string | null;
            createdAt?: string;
            updatedAt?: string;
          }>;
        }>("/admin/affiliate/settings.php");
      },

      updateSettings: async (params: {
        network_id: string;
        is_active?: boolean;
        creator_share_percentage?: number;
        holding_period_days?: number;
        allowed_domains?: string;
        publisher_id?: string;
        webhook_secret?: string;
      }) => {
        return apiFetch<{
          success: boolean;
          message: string;
          network_id: string;
        }>("/admin/affiliate/settings.php", {
          method: "POST",
          body: JSON.stringify(params),
        });
      },

      getConversions: async (params?: {
        network?: string;
        status?: string;
        creator_user_id?: string;
        page?: number;
        limit?: number;
      }) => {
        const q = new URLSearchParams();
        if (params?.network) q.set("network", params.network);
        if (params?.status) q.set("status", params.status);
        if (params?.creator_user_id) q.set("creator_user_id", params.creator_user_id);
        if (params?.page) q.set("page", String(params.page));
        if (params?.limit) q.set("limit", String(params.limit));
        const qs = q.toString();
        return apiFetch<{
          success: boolean;
          conversions: Array<{
            id: string;
            network: string;
            external_action_id: string;
            click_id?: string | null;
            creator_user_id: string;
            creator_name?: string;
            video_id?: string | null;
            order_amount: number;
            total_commission: number;
            creator_share_percentage: number;
            creator_payout: number;
            currency: string;
            status: string;
            settlement_due_at?: string | null;
            settled_at?: string | null;
            ledger_transaction_id?: string | null;
            notes?: string | null;
            created_at: string;
            updated_at: string;
          }>;
          pagination: {
            page: number;
            limit: number;
            total: number;
            totalPages: number;
          };
          summary: {
            totalConversions: number;
            totalOrderAmount: number;
            totalCommission: number;
            totalCreatorPayout: number;
            pendingCount: number;
            approvedCount: number;
            settledCount: number;
            rejectedCount: number;
            reversedCount: number;
          };
        }>(`/admin/affiliate/conversions.php${qs ? `?${qs}` : ""}`);
      },

      processConversion: async (params: {
        conversion_id: string;
        action: "approve" | "settle" | "reject" | "reverse";
        notes?: string;
      }) => {
        return apiFetch<{
          success: boolean;
          message: string;
          status: string;
          transaction_id?: string;
          reversal_transaction_id?: string;
          creator_payout?: number;
        }>("/admin/affiliate/conversions.php", {
          method: "POST",
          body: JSON.stringify(params),
        });
      },
    },

    listKycSubmissions: async (params?: {
      type?: "all" | "personal" | "bank";
      status?: string;
      search?: string;
      userId?: string;
      page?: number;
      limit?: number;
    }) => {
      const q = new URLSearchParams();
      if (params?.type) q.set("type", params.type);
      if (params?.status) q.set("status", params.status);
      if (params?.search) q.set("search", params.search);
      if (params?.userId) q.set("userId", params.userId);
      if (params?.page) q.set("page", String(params.page));
      if (params?.limit) q.set("limit", String(params.limit));
      const qs = q.toString() ? `?${q.toString()}` : "";
      return apiFetch<{
        success: boolean;
        stats: {
          totalPending: number;
          pendingPersonal: number;
          pendingBank: number;
          totalVerified: number;
          totalRejected: number;
          totalSubmissions: number;
        };
        pagination: {
          page: number;
          limit: number;
          totalItems: number;
          totalPages: number;
        };
        submissions: Array<{
          id: string;
          type: "personal" | "bank";
          userId: string;
          fullName?: string;
          accountHolderName?: string;
          mobile?: string;
          dob?: string;
          address?: string;
          city?: string;
          state?: string;
          pincode?: string;
          nomineeName?: string;
          nomineeRelation?: string;
          nomineeMobile?: string;
          bankName?: string;
          accountNumber?: string;
          ifscCode?: string;
          branchName?: string;
          accountType?: string;
          upiId?: string;
          upiQrCodeUrl?: string;
          status: string;
          reviewedBy?: string | null;
          reviewedAt?: string | null;
          adminNote?: string | null;
          rejectionReason?: string | null;
          submittedAt: string;
          updatedAt: string;
        }>;
      }>(`/admin/kyc/list.php${qs}`);
    },

    reviewKycSubmission: async (data: {
      type: "personal" | "bank";
      userId: string;
      decision: "approved" | "rejected";
      adminNote?: string;
      rejectionReason?: string;
    }) => {
      return apiFetch<{
        success: boolean;
        message: string;
        decision: "approved" | "rejected";
        status: string;
        kyc?: any;
        audit?: any;
        error?: string;
      }>("/admin/kyc/review.php", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },

    getKycAuditHistory: async (params?: {
      userId?: string;
      type?: "all" | "personal" | "bank";
      action?: "all" | "approved" | "rejected";
      page?: number;
      limit?: number;
    }) => {
      const q = new URLSearchParams();
      if (params?.userId) q.set("userId", params.userId);
      if (params?.type) q.set("type", params.type);
      if (params?.action) q.set("action", params.action);
      if (params?.page) q.set("page", String(params.page));
      if (params?.limit) q.set("limit", String(params.limit));
      const qs = q.toString() ? `?${q.toString()}` : "";
      return apiFetch<{
        success: boolean;
        pagination: {
          page: number;
          limit: number;
          totalItems: number;
          totalPages: number;
        };
        auditLogs: Array<{
          id: string;
          kycType: string;
          kycId: string;
          userId: string;
          action: string;
          previousStatus: string;
          newStatus: string;
          adminNote: string | null;
          rejectionReason: string | null;
          reviewedBy: string;
          reviewedAt: string;
          createdAt: string;
        }>;
      }>(`/admin/kyc/audit.php${qs}`);
    },

    kyc: {
      list: async (params?: {
        type?: "all" | "personal" | "bank";
        status?: string;
        search?: string;
        userId?: string;
        page?: number;
        limit?: number;
      }) => {
        return api.admin.listKycSubmissions(params);
      },
      review: async (data: {
        type: "personal" | "bank";
        userId: string;
        decision: "approved" | "rejected";
        adminNote?: string;
        rejectionReason?: string;
      }) => {
        return api.admin.reviewKycSubmission(data);
      },
      audit: async (params?: {
        userId?: string;
        type?: "all" | "personal" | "bank";
        action?: "all" | "approved" | "rejected";
        page?: number;
        limit?: number;
      }) => {
        return api.admin.getKycAuditHistory(params);
      },
    },
  },

  // Categories
  categories: {
    list: async () => {
      return apiFetch<{
        success: boolean;
        source?: string;
        categories: Array<{
          id: string | number;
          name: string;
          slug: string;
          created_by?: string;
          created_at?: string;
        }>;
      }>("/categories/list.php");
    },
  },

  // Live Streams
  live: {
    listStreams: async () => {
      return apiFetch<{ success: boolean; streams: any[] }>("/live/streams.php");
    },

    createStream: async (params: {
      title: string;
      description?: string;
      category?: string;
      thumbnailUrl?: string;
    }) => {
      return apiFetch<{ success: boolean; message: string; stream: any }>("/live/streams.php", {
        method: "POST",
        body: JSON.stringify(params),
      });
    },

    getChatMessages: async (streamId: string) => {
      return apiFetch<{ success: boolean; stream_id: string; messages: any[] }>(
        `/live/chat.php?stream_id=${encodeURIComponent(streamId)}`,
      );
    },

    sendChatMessage: async (params: {
      streamId: string;
      message: string;
      isSuperchat?: boolean;
      superchatAmount?: number;
      userName?: string;
    }) => {
      return apiFetch<{ success: boolean; message: any }>("/live/chat.php", {
        method: "POST",
        body: JSON.stringify(params),
      });
    },

    getStreamToken: async (params: { streamId: string; role?: "publisher" | "subscriber" }) => {
      return apiFetch<{
        success: boolean;
        token: string;
        url: string;
        room: string;
        identity: string;
        role: "publisher" | "subscriber";
        expires_at: number;
        server_configured: boolean;
      }>("/live/token.php", {
        method: "POST",
        body: JSON.stringify(params),
      });
    },

    heartbeat: async (params: {
      streamId: string;
      role?: "broadcaster" | "viewer";
      stats?: {
        bitrate?: number;
        fps?: number;
        resolution?: string;
      };
    }) => {
      return apiFetch<{
        success: boolean;
        stream_id: string;
        status: string;
        role: string;
        active_viewers: number;
      }>("/live/heartbeat.php", {
        method: "POST",
        body: JSON.stringify(params),
      });
    },

    endStream: async (params: { streamId: string }) => {
      return apiFetch<{
        success: boolean;
        message: string;
        stream: {
          id: string;
          status: string;
          ended_at: string;
          viewers_count: number;
        };
      }>("/live/end-stream.php", {
        method: "POST",
        body: JSON.stringify(params),
      });
    },
  },

  // Affiliate Marketing (Creator Links & Click Tracking)
  affiliate: {
    generateLink: async (params: {
      network: "amazon" | "impact" | "earnkaro" | string;
      target_url: string;
      video_id?: string;
    }) => {
      return apiFetch<{
        success: boolean;
        network: string;
        network_name: string;
        creator_user_id: string;
        target_url: string;
        tracking_url: string;
        relative_tracking_path: string;
        allowed_domains: string[];
        video_id?: string | null;
        error?: string;
      }>("/affiliate/create-link.php", {
        method: "POST",
        body: JSON.stringify(params),
      });
    },
    getSupportedNetworks: async () => {
      return apiFetch<{
        success: boolean;
        networks: Array<{
          id: string;
          name: string;
          allowed_domains: string[];
          example_url: string;
          description: string;
        }>;
      }>("/affiliate/create-link.php");
    },
    trackClick: async (params: {
      network: "amazon" | "impact" | "earnkaro" | string;
      creator_user_id: string;
      target_url: string;
      video_id?: string;
    }) => {
      return apiFetch<{
        success: boolean;
        click_id: string;
        network: string;
        creator_user_id: string;
        target_url: string;
        video_id?: string | null;
      }>("/affiliate/click.php", {
        method: "POST",
        body: JSON.stringify(params),
      });
    },
  },

  // Paid Subscriber Plans
  subscriptions: {
    listPlans: async (params?: { includeInactive?: boolean }) => {
      const q = params?.includeInactive ? "?include_inactive=1" : "";
      return apiFetch<{
        success: boolean;
        source?: string;
        plans: Array<{
          id: string | number;
          plan_id: string;
          name: string;
          price: number;
          duration_days: number;
          perks: string[];
          is_active: boolean;
          created_at: string;
        }>;
      }>(`/subscriptions/plans.php${q}`);
    },

    getActive: async () => {
      return apiFetch<{
        success: boolean;
        hasActiveSubscription: boolean;
        subscription: {
          subscriptionId: string;
          userId: string;
          planId: string;
          planName?: string;
          orderId: string;
          paymentId: string;
          amount: number;
          currency: string;
          status: string;
          isExpired?: boolean;
          remainingDays?: number;
          startsAt: string;
          expiresAt: string;
        } | null;
        activeSubscription?: any;
        history?: any[];
        subscriptions?: any[];
      }>("/subscriptions/active");
    },

    getMy: async () => {
      return apiFetch<{
        success: boolean;
        hasActiveSubscription: boolean;
        subscription: {
          subscriptionId: string;
          userId: string;
          planId: string;
          planName: string;
          orderId: string;
          paymentId: string;
          amount: number;
          currency: string;
          status: string;
          isExpired: boolean;
          remainingDays: number;
          startsAt: string;
          expiresAt: string;
          createdAt?: string;
        } | null;
        activeSubscription: {
          subscriptionId: string;
          userId: string;
          planId: string;
          planName: string;
          orderId: string;
          paymentId: string;
          amount: number;
          currency: string;
          status: string;
          isExpired: boolean;
          remainingDays: number;
          startsAt: string;
          expiresAt: string;
          createdAt?: string;
        } | null;
        history: Array<{
          subscriptionId: string;
          userId: string;
          planId: string;
          planName: string;
          orderId: string;
          paymentId: string;
          amount: number;
          currency: string;
          status: string;
          isExpired: boolean;
          remainingDays: number;
          startsAt: string;
          expiresAt: string;
          createdAt?: string;
        }>;
        subscriptions: Array<{
          subscriptionId: string;
          userId: string;
          planId: string;
          planName: string;
          orderId: string;
          paymentId: string;
          amount: number;
          currency: string;
          status: string;
          isExpired: boolean;
          remainingDays: number;
          startsAt: string;
          expiresAt: string;
          createdAt?: string;
        }>;
      }>("/subscriptions/my");
    },

    verifySubscription: async (data: {
      orderId: string;
      paymentId: string;
      signature?: string;
      userId: string;
      planId: string;
      userName?: string;
      amount?: number;
    }) => {
      return api.payments.verify({
        ...data,
        purpose: "paid_subscription",
      });
    },

    requestRefund: async (data: { subscriptionId: string; reason: string }) => {
      return apiFetch<{
        success: boolean;
        message?: string;
        request?: {
          id: string;
          subscriptionId: string;
          userId: string;
          userName: string;
          userEmail: string;
          planId: string;
          planName: string;
          paymentId: string;
          orderId: string;
          amount: number;
          currency: string;
          reason: string;
          status: string;
          gatewayStatus: string;
          createdAt: string;
          updatedAt: string;
        };
        error?: string;
      }>("/subscriptions/refund-request.php", {
        method: "POST",
        body: JSON.stringify(data),
      });
    },

    getRefundRequests: async () => {
      return apiFetch<{
        success: boolean;
        requests: Array<{
          id: string;
          subscriptionId: string;
          userId: string;
          userName: string;
          userEmail: string;
          planId: string;
          planName: string;
          paymentId: string;
          orderId: string;
          amount: number;
          currency: string;
          reason: string;
          status: "pending" | "approved" | "rejected" | "processing" | "refunded";
          gatewayStatus: string;
          gatewayRefundId?: string | null;
          adminNote?: string | null;
          reviewedBy?: string | null;
          reviewedAt?: string | null;
          createdAt: string;
          updatedAt: string;
        }>;
        error?: string;
      }>("/subscriptions/refund-requests.php");
    },
  },

  channel: {
    subscribe: async (creatorUserId: string) => {
      return apiFetch<{
        success: boolean;
        subscribed: boolean;
        creator_user_id: string;
        subscriber_count: number;
        error?: string;
      }>("/channel/subscribe.php", {
        method: "POST",
        body: JSON.stringify({ creator_user_id: creatorUserId }),
      });
    },

    unsubscribe: async (creatorUserId: string) => {
      return apiFetch<{
        success: boolean;
        subscribed: boolean;
        creator_user_id: string;
        subscriber_count: number;
        error?: string;
      }>("/channel/unsubscribe.php", {
        method: "POST",
        body: JSON.stringify({ creator_user_id: creatorUserId }),
      });
    },

    getSubscriberCount: async (creatorUserId?: string) => {
      const qs = creatorUserId ? `?creator_user_id=${encodeURIComponent(creatorUserId)}` : "";
      return apiFetch<{
        success: boolean;
        creator_user_id: string;
        subscriber_count: number;
        error?: string;
      }>(`/channel/subscribers.php${qs}`);
    },

    getStatus: async (creatorUserId: string) => {
      return apiFetch<{
        success: boolean;
        authenticated?: boolean;
        subscribed: boolean;
        creator_user_id: string;
        subscriber_count: number;
        is_self?: boolean;
        error?: string;
      }>(`/channel/status.php?creator_user_id=${encodeURIComponent(creatorUserId)}`);
    },
  },
};
