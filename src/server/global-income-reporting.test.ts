import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pool, PoolConnection } from "mysql2/promise";
import { handleApiRequest } from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";
import {
  handleAdminRecoverPremiumPayment,
  type RecoveryAuthUser,
  type RecoveryMediaDirs,
} from "./premium-recovery.ts";
import { api } from "../lib/api.ts";
import {
  deriveGlobalIncomeDisplayState,
  getAuthoritativeUserLedger,
  getAuthoritativeUserWallet,
  getGlobalPoolSummary,
  getUserLedger,
  getUserWallet,
  saveStoredLedger,
  saveStoredWallets,
  type GlobalPoolSummary,
  type LedgerTransaction,
  type UserWallet,
} from "../lib/ledger-service.ts";

const ROOT = process.cwd();

const memoryStore = new Map<string, string>();
const mockLocalStorage = {
  getItem: (key: string) => memoryStore.get(key) ?? null,
  setItem: (key: string, value: string) => memoryStore.set(key, String(value)),
  removeItem: (key: string) => memoryStore.delete(key),
  clear: () => memoryStore.clear(),
};

const originalWindow = (globalThis as any).window;
const originalLocalStorage = (globalThis as any).localStorage;

function signRazorpay(orderId: string, paymentId: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");
}

function makeVerifyMockPool(handlers: {
  paymentTxRow: Record<string, any>;
  forUpdateReturnsEmptyThenDup?: boolean;
  premiumTxRow?: Record<string, any> | null | "THROW";
  refLedgerRow?: Record<string, any> | null | "THROW";
  adsRefLedgerRow?: Record<string, any> | null | "THROW";
  glbLedgerRows?: Array<Record<string, any>> | "THROW";
  orderPurpose?: string;
}) {
  const queryLog: Array<{ sql: string; params?: any[] }> = [];
  const mockQuery = async (sql: string, params?: any[]) => {
    queryLog.push({ sql, params });

    if (sql.includes("FROM user_sessions")) {
      return [
        [
          {
            id: "u-payer",
            user_id: "FT_PAYER_1",
            name: "Payer One",
            mobile: "9999999999",
            email: "payer1@facetube.online",
            role: "user",
            referral_code: "FT_SPONSOR_99",
            created_at: new Date().toISOString(),
          },
        ],
      ];
    }
    if (sql.includes("GET_LOCK")) return [[{ acquired: 1 }]];
    if (sql.includes("RELEASE_LOCK")) return [[{ released: 1 }]];
    if (sql.includes("FROM payment_orders")) {
      return [
        [
          {
            order_id: handlers.paymentTxRow.order_id,
            user_id: "FT_PAYER_1",
            user_name: "Payer One",
            purpose: handlers.orderPurpose ?? handlers.paymentTxRow.purpose,
            amount: handlers.paymentTxRow.amount,
            status: "created",
          },
        ],
      ];
    }
    if (sql.includes("FROM uploaded_videos WHERE id = ?")) {
      return [[]];
    }
    if (sql.includes("FROM payment_transactions WHERE payment_id = ? FOR UPDATE")) {
      if (handlers.forUpdateReturnsEmptyThenDup) {
        return [[]];
      }
      return [[handlers.paymentTxRow]];
    }
    if (sql.includes("FROM payment_transactions WHERE payment_id = ? LIMIT 1")) {
      return [[handlers.paymentTxRow]];
    }
    if (sql.includes("SELECT user_id FROM users WHERE role = 'admin'")) {
      return [[{ user_id: "FT102857" }]];
    }
    if (sql.includes("SELECT COUNT(*) as total FROM payment_transactions")) {
      return [[{ total: 4 }]];
    }
    if (sql.includes("SELECT id, user_id, referral_code FROM users")) {
      return [[{ id: "u-payer", user_id: "FT_PAYER_1", referral_code: "FT_RACE_SPONSOR" }]];
    }
    if (sql.includes("SELECT user_id FROM users") && sql.includes("UPPER(referral_code)")) {
      return [[{ user_id: "FT_RACE_SPONSOR" }]];
    }
    if (sql.includes("FROM uploaded_videos") && sql.includes("video_type = 'premium'")) {
      return [[]];
    }
    if (sql.includes("INSERT INTO payment_transactions")) {
      const err: any = new Error("Duplicate entry for key 'uniq_pt_payment_id'");
      err.code = "ER_DUP_ENTRY";
      throw err;
    }
    if (sql.includes("FROM premium_transactions WHERE payment_id = ?")) {
      if (handlers.premiumTxRow === "THROW") {
        throw new Error("Table premium_transactions missing");
      }
      return [handlers.premiumTxRow ? [handlers.premiumTxRow] : []];
    }
    if (sql.includes("FROM income_ledger") && sql.includes("global_income")) {
      if (handlers.glbLedgerRows === "THROW") {
        throw new Error("Ledger query error");
      }
      return [handlers.glbLedgerRows ?? []];
    }
    if (sql.includes("FROM income_ledger WHERE transaction_id = ?")) {
      const txId = String(params?.[0] ?? "");
      if (txId.startsWith("TX_REF_")) {
        if (handlers.refLedgerRow === "THROW") {
          throw new Error("Ref ledger query error");
        }
        return [handlers.refLedgerRow ? [handlers.refLedgerRow] : []];
      }
      if (txId.startsWith("TX_ADS_L1_")) {
        if (handlers.adsRefLedgerRow === "THROW") {
          throw new Error("Ads ref ledger query error");
        }
        return [handlers.adsRefLedgerRow ? [handlers.adsRefLedgerRow] : []];
      }
      return [[]];
    }

    return [[]];
  };

  const pool = {
    query: mockQuery,
    getConnection: async () => ({
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
      query: mockQuery,
    }),
  } as any;

  return { pool, queryLog };
}

describe("FaceTube — Phase 1 Approved Global Income Pool Reporting Fixes", () => {
  beforeEach(() => {
    setMysqlPoolForTesting(null);
    (globalThis as any).window = {
      ...globalThis,
      location: { hostname: "localhost" },
    };
    (globalThis as any).localStorage = mockLocalStorage;
    memoryStore.clear();
  });

  afterEach(() => {
    setMysqlPoolForTesting(null);
    (globalThis as any).window = originalWindow;
    (globalThis as any).localStorage = originalLocalStorage;
    memoryStore.clear();
  });

  // --------------------------------------------------------------------------
  // 1. Duplicate payment verification reporting (Node + PHP parity)
  // --------------------------------------------------------------------------
  describe("1. Duplicate payment verification reporting & authoritative referrerId", () => {
    const keyId = "rzp_live_test_reporting";
    const secret = "rzp_secret_reporting_123";
    const prodEnv = {
      APP_ENV: "production",
      NODE_ENV: "development",
      RAZORPAY_KEY_ID: keyId,
      RAZORPAY_KEY_SECRET: secret,
    };

    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            id: "pay_dup_001",
            order_id: "order_dup_001",
            status: "captured",
            amount: 600,
            currency: "INR",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("resolves duplicate referrerId from authoritative premium_transactions (never payer user_id) and counts videos & distinct creators", async () => {
      const orderId = "order_dup_001";
      const paymentId = "pay_dup_001";
      const sig = signRazorpay(orderId, paymentId, secret);

      const { pool } = makeVerifyMockPool({
        paymentTxRow: {
          payment_id: paymentId,
          order_id: orderId,
          user_id: "FT_PAYER_1",
          amount: 6,
          purpose: "premium_video_upload",
          tx_number: 5,
          is_special: 0,
          special_tag: "NORMAL_PREMIUM",
          referral_commission: 1,
          admin_allocation: 1,
          global_pool_allocation: 3,
        },
        premiumTxRow: { referrer_id: "FT_SPONSOR_99" },
        glbLedgerRows: [
          { user_id: "CR_A", amount: 0.6 },
          { user_id: " cr_a ", amount: 0.6 },
          { user_id: "CR_A", amount: 0.6 },
          { user_id: "CR_B", amount: 0.6 },
          { user_id: " cr_b", amount: 0.6 },
        ],
      });

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/payments/verify", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer tok_payer_1",
          },
          body: JSON.stringify({
            orderId,
            paymentId,
            signature: sig,
            userId: "FT_PAYER_1",
            purpose: "premium_video_upload",
          }),
        }),
        prodEnv,
        { pool },
      );

      assert.equal(res?.status, 200);
      const body = await res?.json();
      assert.equal(body.verified, true);
      assert.equal(body.duplicate, true);
      assert.equal(body.txNumber, 5);
      assert.equal(body.distribution.referrerId, "FT_SPONSOR_99");
      assert.notEqual(body.distribution.referrerId, "FT_PAYER_1");
      assert.equal(body.distribution.eligibleVideoCount, 5);
      assert.equal(body.distribution.eligibleMembersCount, 5);
      assert.equal(body.distribution.distinctCreatorCount, 2);
      assert.equal(body.distribution.perMemberShare, 0.6);
      assert.equal(body.distribution.globalPoolAmount, 3);
    });

    it("falls back to authoritative income_ledger TX_REF_<paymentId> when premium_transactions is unavailable", async () => {
      const orderId = "order_dup_001";
      const paymentId = "pay_dup_001";
      const sig = signRazorpay(orderId, paymentId, secret);

      const { pool } = makeVerifyMockPool({
        paymentTxRow: {
          payment_id: paymentId,
          order_id: orderId,
          user_id: "FT_PAYER_1",
          amount: 6,
          purpose: "premium_video_upload",
          tx_number: 6,
          is_special: 0,
          special_tag: "NORMAL_PREMIUM",
          referral_commission: 1,
          admin_allocation: 1,
          global_pool_allocation: 3,
        },
        premiumTxRow: "THROW",
        refLedgerRow: { user_id: "FT_LEDGER_SPONSOR" },
        glbLedgerRows: [{ user_id: "CR_ONLY", amount: 3.0 }],
      });

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/payments/verify", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer tok_payer_1",
          },
          body: JSON.stringify({
            orderId,
            paymentId,
            signature: sig,
            userId: "FT_PAYER_1",
            purpose: "premium_video_upload",
          }),
        }),
        prodEnv,
        { pool },
      );

      assert.equal(res?.status, 200);
      const body = await res?.json();
      assert.equal(body.duplicate, true);
      assert.equal(body.distribution.referrerId, "FT_LEDGER_SPONSOR");
      assert.equal(body.distribution.eligibleVideoCount, 1);
      assert.equal(body.distribution.distinctCreatorCount, 1);
    });

    it("returns null (never invents payer user_id or zero counts) when authoritative duplicate metadata cannot be reconstructed", async () => {
      const orderId = "order_dup_001";
      const paymentId = "pay_dup_001";
      const sig = signRazorpay(orderId, paymentId, secret);

      const { pool } = makeVerifyMockPool({
        paymentTxRow: {
          payment_id: paymentId,
          order_id: orderId,
          user_id: "FT_PAYER_1",
          amount: 6,
          purpose: "premium_video_upload",
          tx_number: 7,
          is_special: 0,
          special_tag: "NORMAL_PREMIUM",
          referral_commission: 1,
          admin_allocation: 1,
          global_pool_allocation: 3,
        },
        premiumTxRow: null,
        refLedgerRow: null,
        glbLedgerRows: "THROW",
      });

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/payments/verify", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer tok_payer_1",
          },
          body: JSON.stringify({
            orderId,
            paymentId,
            signature: sig,
            userId: "FT_PAYER_1",
            purpose: "premium_video_upload",
          }),
        }),
        prodEnv,
        { pool },
      );

      assert.equal(res?.status, 200);
      const body = await res?.json();
      assert.equal(body.duplicate, true);
      assert.equal(body.distribution.referrerId, null);
      assert.equal(body.distribution.eligibleVideoCount, null);
      assert.equal(body.distribution.eligibleMembersCount, null);
      assert.equal(body.distribution.distinctCreatorCount, null);
      assert.equal(body.distribution.perMemberShare, null);
      assert.equal(body.distribution.globalPoolAmount, 3);
    });

    it("resolves authoritative referrerId and pool counts in ER_DUP_ENTRY concurrent race catch path", async () => {
      const orderId = "order_dup_001";
      const paymentId = "pay_dup_001";
      const sig = signRazorpay(orderId, paymentId, secret);

      const { pool } = makeVerifyMockPool({
        forUpdateReturnsEmptyThenDup: true,
        paymentTxRow: {
          payment_id: paymentId,
          order_id: orderId,
          user_id: "FT_PAYER_1",
          amount: 6,
          purpose: "premium_video_upload",
          tx_number: 8,
          is_special: 0,
          special_tag: "NORMAL_PREMIUM",
          referral_commission: 1,
          admin_allocation: 1,
          global_pool_allocation: 3,
        },
        premiumTxRow: { referrer_id: "FT_RACE_SPONSOR" },
        glbLedgerRows: [
          { user_id: "CR_1", amount: 1.0 },
          { user_id: "CR_1", amount: 1.0 },
          { user_id: "CR_2", amount: 1.0 },
        ],
      });

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/payments/verify", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer tok_payer_1",
          },
          body: JSON.stringify({
            orderId,
            paymentId,
            signature: sig,
            userId: "FT_PAYER_1",
            purpose: "premium_video_upload",
          }),
        }),
        prodEnv,
        { pool },
      );

      assert.equal(res?.status, 200);
      const body = await res?.json();
      assert.equal(body.duplicate, true);
      assert.equal(body.txNumber, 8);
      assert.equal(body.distribution.referrerId, "FT_RACE_SPONSOR");
      assert.notEqual(body.distribution.referrerId, "FT_PAYER_1");
      assert.equal(body.distribution.eligibleVideoCount, 3);
      assert.equal(body.distribution.distinctCreatorCount, 2);
      assert.equal(body.distribution.perMemberShare, 1.0);
    });

    it("resolves ads_promotion duplicate referrerId from TX_ADS_L1_<paymentId> (or null if none) and keeps special tx counts at 0", async () => {
      const orderId = "order_dup_001";
      const paymentId = "pay_dup_001";
      const sig = signRazorpay(orderId, paymentId, secret);

      // Ads promotion duplicate with Level 1 ledger record
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            id: paymentId,
            order_id: orderId,
            status: "captured",
            amount: 10000,
            currency: "INR",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch;

      const { pool: adsPool } = makeVerifyMockPool({
        paymentTxRow: {
          payment_id: paymentId,
          order_id: orderId,
          user_id: "FT_PAYER_1",
          amount: 100,
          purpose: "ads_promotion",
          tx_number: 0,
          is_special: 0,
          special_tag: "ADS_PROMOTION",
          referral_commission: 15,
          admin_allocation: 85,
          global_pool_allocation: 0,
        },
        adsRefLedgerRow: { user_id: "FT_ADS_L1" },
      });

      const adsRes = await handleApiRequest(
        new Request("http://localhost:3000/api/payments/verify", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer tok_payer_1",
          },
          body: JSON.stringify({
            orderId,
            paymentId,
            signature: sig,
            userId: "FT_PAYER_1",
            purpose: "ads_promotion",
            planId: "plan-7-days",
          }),
        }),
        prodEnv,
        { pool: adsPool },
      );

      assert.equal(adsRes?.status, 200);
      const adsBody = await adsRes?.json();
      assert.equal(adsBody.duplicate, true);
      assert.equal(adsBody.distribution.referrerId, "FT_ADS_L1");
      assert.equal(adsBody.distribution.eligibleVideoCount, 0);
      assert.equal(adsBody.distribution.distinctCreatorCount, 0);

      // Special tx #11 duplicate with global_pool_allocation = 0 reports authoritative 0 counts
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            id: paymentId,
            order_id: orderId,
            status: "captured",
            amount: 600,
            currency: "INR",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch;

      const { pool: specPool } = makeVerifyMockPool({
        paymentTxRow: {
          payment_id: paymentId,
          order_id: orderId,
          user_id: "FT_PAYER_1",
          amount: 6,
          purpose: "premium_video_upload",
          tx_number: 11,
          is_special: 1,
          special_tag: "SPECIAL_GLOBAL_RULE",
          referral_commission: 1,
          admin_allocation: 4,
          global_pool_allocation: 0,
        },
        premiumTxRow: { referrer_id: "FT_SPEC_SPONSOR" },
      });

      const specRes = await handleApiRequest(
        new Request("http://localhost:3000/api/payments/verify", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer tok_payer_1",
          },
          body: JSON.stringify({
            orderId,
            paymentId,
            signature: sig,
            userId: "FT_PAYER_1",
            purpose: "premium_video_upload",
          }),
        }),
        prodEnv,
        { pool: specPool },
      );

      assert.equal(specRes?.status, 200);
      const specBody = await specRes?.json();
      assert.equal(specBody.duplicate, true);
      assert.equal(specBody.isSpecialTransaction, true);
      assert.equal(specBody.distribution.referrerId, "FT_SPEC_SPONSOR");
      assert.equal(specBody.distribution.eligibleVideoCount, 0);
      assert.equal(specBody.distribution.distinctCreatorCount, 0);
      assert.equal(specBody.distribution.perMemberShare, 0);
    });

    it("maintains PHP verify.php fast-path distribution metadata and authoritative referrerId parity", () => {
      const phpSource = fs.readFileSync(path.join(ROOT, "api/payments/verify.php"), "utf8");
      assert.ok(phpSource.includes("function resolveDuplicateReferrerId("));
      assert.ok(phpSource.includes("function buildDuplicateVerifyResponse("));
      assert.ok(
        phpSource.includes("if ($orderRecord['status'] === 'paid')") &&
          phpSource.includes("$fastExistingTx"),
        "PHP fast-path duplicate must check payment_transactions to include authoritative distribution metadata",
      );
      assert.ok(
        !phpSource.includes("'referrerId' => $existingTx['user_id']"),
        "PHP verify.php must never emit payer user_id as duplicate referrerId",
      );
      assert.ok(phpSource.includes("SELECT referrer_id"));
      assert.ok(phpSource.includes("'TX_REF_' . $existingPaymentId"));
      assert.ok(phpSource.includes("'TX_ADS_L1_' . $existingPaymentId"));
      // Ensure excluded SQL TRIM(user_id) normalization was NOT introduced in verify.php
      assert.ok(!phpSource.includes("UPPER(TRIM(user_id)) != UPPER(?)"));
    });
  });

  // --------------------------------------------------------------------------
  // 2. Admin premium recovery reporting (Node + PHP parity)
  // --------------------------------------------------------------------------
  describe("2. Admin premium recovery reporting fields (eligibleVideosCount, eligibleVideoCount, distinctCreatorCount)", () => {
    let tmpDir: string;
    let mediaDirs: RecoveryMediaDirs;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-recovery-report-"));
      const videosDir = path.join(tmpDir, "videos");
      const thumbsDir = path.join(tmpDir, "thumbnails");
      fs.mkdirSync(videosDir, { recursive: true });
      fs.mkdirSync(thumbsDir, { recursive: true });
      fs.writeFileSync(path.join(videosDir, "vid_rec_1.mp4"), "fake-mp4-data");
      fs.writeFileSync(path.join(thumbsDir, "thumb_rec_1.jpg"), "fake-jpg-data");
      mediaDirs = { videosDir, thumbnailsDir: thumbsDir };
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function createRecoveryMockPool(params: {
      priorTxCount: number;
      eligibleVideos: Array<{ video_id: string; user_id: string; ad_earnings: number }>;
    }): Pool {
      const mockQuery = async (sql: string) => {
        if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) {
          return [[{ COLUMN_NAME: "ad_earnings" }, { COLUMN_NAME: "is_blocked" }]];
        }
        if (sql.includes("SELECT COUNT(*) AS total FROM payment_transactions")) {
          return [[{ total: params.priorTxCount }]];
        }
        if (sql.includes("FROM users WHERE UPPER(user_id) = UPPER(?)")) {
          return [
            [
              {
                id: "u-rec",
                user_id: "FT_REC_UPLOADER",
                name: "Recovery Uploader",
                role: "user",
                referral_code: "FT_REC_REF",
                created_at: "2026-01-01 00:00:00",
              },
            ],
          ];
        }
        if (sql.includes("UPPER(referral_code) = UPPER(?)")) {
          return [[{ user_id: "FT_REC_REF" }]];
        }
        if (sql.includes("FROM users WHERE role = 'admin'")) {
          return [[{ user_id: "FT102857" }]];
        }
        if (sql.includes("SELECT id AS video_id, user_id")) {
          return [params.eligibleVideos];
        }
        return [[]];
      };

      const conn = {
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
        query: mockQuery,
      } as unknown as PoolConnection;

      return {
        query: mockQuery,
        getConnection: async () => conn,
      } as unknown as Pool;
    }

    it("preserves eligibleVideosCount and reports eligibleVideoCount & normalized distinctCreatorCount on normal recovery dry-run", async () => {
      const adminUser: RecoveryAuthUser = { user_id: "FT102857", role: "admin" };
      const pool = createRecoveryMockPool({
        priorTxCount: 2,
        eligibleVideos: [
          { video_id: "v1", user_id: " cr_alpha ", ad_earnings: 0 },
          { video_id: "v2", user_id: "CR_ALPHA", ad_earnings: 0 },
          { video_id: "v3", user_id: "cr_alpha", ad_earnings: 0 },
          { video_id: "v4", user_id: "CR_BETA ", ad_earnings: 0 },
        ],
      });

      const fakeFetch = (async (input: any) => {
        const url = String(input);
        if (url.includes("/v1/payments/")) {
          return new Response(
            JSON.stringify({
              id: "pay_rec_001",
              order_id: "order_rec_001",
              status: "captured",
              amount: 600,
              currency: "INR",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            id: "order_rec_001",
            status: "paid",
            amount: 600,
            amount_paid: 600,
            currency: "INR",
            created_at: 1730000000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch;

      const res = await handleAdminRecoverPremiumPayment({
        method: "POST",
        pool,
        authUser: adminUser,
        body: {
          dryRun: true,
          items: [
            {
              paymentId: "pay_rec_001",
              orderId: "order_rec_001",
              userId: "FT_REC_UPLOADER",
              title: "Recovered Premium Video",
              contentType: "long",
              videoFilename: "vid_rec_1.mp4",
              thumbnailFilename: "thumb_rec_1.jpg",
            },
          ],
        },
        env: {
          RAZORPAY_KEY_ID: "rzp_live_rec",
          RAZORPAY_KEY_SECRET: "rzp_secret_rec",
        },
        fetchImpl: fakeFetch,
        mediaDirs,
      });

      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.success, true);
      const acc = data.items[0].accounting;
      assert.equal(acc.txNumber, 3);
      assert.equal(acc.isSpecial, false);
      assert.equal(acc.eligibleVideosCount, 4);
      assert.equal(acc.eligibleVideoCount, 4);
      assert.equal(acc.distinctCreatorCount, 2);
      // Locked financial formulas intact: ₹1 referral, ₹1 admin, ₹3 global pool (4 × ₹0.75)
      assert.equal(acc.referralCommission, 1);
      assert.equal(acc.adminAllocation, 1);
      assert.equal(acc.globalPoolAllocation, 3);
    });

    it("reports 0 for eligibleVideosCount, eligibleVideoCount, and distinctCreatorCount on special 11th transaction recovery", async () => {
      const adminUser: RecoveryAuthUser = { user_id: "FT102857", role: "admin" };
      const pool = createRecoveryMockPool({
        priorTxCount: 10, // Next tx is #11 (SPECIAL_GLOBAL_RULE)
        eligibleVideos: [{ video_id: "v1", user_id: "CR_ALPHA", ad_earnings: 0 }],
      });

      const fakeFetch = (async (input: any) => {
        const url = String(input);
        if (url.includes("/v1/payments/")) {
          return new Response(
            JSON.stringify({
              id: "pay_rec_11",
              order_id: "order_rec_11",
              status: "captured",
              amount: 600,
              currency: "INR",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            id: "order_rec_11",
            status: "paid",
            amount: 600,
            amount_paid: 600,
            currency: "INR",
            created_at: 1730000000,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch;

      const res = await handleAdminRecoverPremiumPayment({
        method: "POST",
        pool,
        authUser: adminUser,
        body: {
          dryRun: true,
          items: [
            {
              paymentId: "pay_rec_11",
              orderId: "order_rec_11",
              userId: "FT_REC_UPLOADER",
              title: "Special 11th Video",
              contentType: "short",
              videoFilename: "vid_rec_1.mp4",
              thumbnailFilename: "thumb_rec_1.jpg",
            },
          ],
        },
        env: {
          RAZORPAY_KEY_ID: "rzp_live_rec",
          RAZORPAY_KEY_SECRET: "rzp_secret_rec",
        },
        fetchImpl: fakeFetch,
        mediaDirs,
      });

      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      const acc = data.items[0].accounting;
      assert.equal(acc.txNumber, 11);
      assert.equal(acc.isSpecial, true);
      assert.equal(acc.specialTag, "SPECIAL_GLOBAL_RULE");
      assert.equal(acc.eligibleVideosCount, 0);
      assert.equal(acc.eligibleVideoCount, 0);
      assert.equal(acc.distinctCreatorCount, 0);
      // Locked special rule: ₹1 referral, ₹4 admin, ₹0 global pool
      assert.equal(acc.referralCommission, 1);
      assert.equal(acc.adminAllocation, 4);
      assert.equal(acc.globalPoolAllocation, 0);
    });

    it("maintains PHP recover-premium-payment.php reporting parity without altering SQL eligibility", () => {
      const phpSource = fs.readFileSync(
        path.join(ROOT, "api/admin/recover-premium-payment.php"),
        "utf8",
      );
      assert.ok(phpSource.includes("'eligibleVideosCount' => $eligibleVideoCount"));
      assert.ok(phpSource.includes("'eligibleVideoCount' => $eligibleVideoCount"));
      assert.ok(phpSource.includes("'distinctCreatorCount' => $distinctCreatorCount"));
      assert.ok(phpSource.includes("AND UPPER(user_id) != UPPER(?)"));
      assert.ok(!phpSource.includes("UPPER(TRIM(user_id)) != UPPER(?)"));
    });
  });

  // --------------------------------------------------------------------------
  // 3. Global Income page strict server-only data & unavailable UI states
  // --------------------------------------------------------------------------
  describe("3. Global Income server-only fetchers, stale cache rejection, and UI states", () => {
    const originalGetBalance = api.wallet.getBalance;
    const originalGetTransactions = api.wallet.getTransactions;
    const originalGetGlobalPoolSummary = api.wallet.getGlobalPoolSummary;

    afterEach(() => {
      api.wallet.getBalance = originalGetBalance;
      api.wallet.getTransactions = originalGetTransactions;
      api.wallet.getGlobalPoolSummary = originalGetGlobalPoolSummary;
    });

    it("getAuthoritativeUserWallet rejects localStorage cache and never fabricates ₹0.00 on server failure while preserving shared getUserWallet fallback", async () => {
      saveStoredWallets({
        FT777001: {
          userId: "FT777001",
          balance: 1500,
          totalEarned: 1500,
          totalWithdrawn: 0,
          referralIncome: 200,
          globalIncome: 888.88,
          adsenseIncome: 300,
          admobIncome: 111.12,
          affiliateIncome: 0,
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      });

      api.wallet.getBalance = async () => {
        throw new Error("HTTP 503 Service Unavailable");
      };

      const strictRes = await getAuthoritativeUserWallet("FT777001");
      assert.equal(strictRes.wallet, null);
      assert.ok(strictRes.error && strictRes.error.includes("503"));

      // Shared getUserWallet behavior for other pages must remain unchanged
      const sharedWallet = await getUserWallet("FT777001");
      assert.equal(sharedWallet.isStale, true);
      assert.equal(sharedWallet.globalIncome, 888.88);
    });

    it("getAuthoritativeUserLedger rejects localStorage cache on server failure while preserving shared getUserLedger fallback", async () => {
      saveStoredLedger([
        {
          id: "cached-glb-1",
          transactionId: "TX_GLB_CACHED_1",
          userId: "FT777001",
          incomeType: "global_income",
          amount: 1.5,
          status: "settled",
          description: "Stale cached global share",
          createdAt: "2026-11-01T00:00:00.000Z",
        },
      ]);

      api.wallet.getTransactions = async () => {
        throw new Error("HTTP 500 Internal Server Error");
      };

      const strictLedger = await getAuthoritativeUserLedger("FT777001");
      assert.deepEqual(strictLedger.transactions, []);
      assert.ok(strictLedger.error && strictLedger.error.includes("500"));

      // Shared getUserLedger behavior for other pages must remain unchanged
      const sharedLedger = await getUserLedger("FT777001");
      assert.equal(sharedLedger.length, 1);
      assert.equal(sharedLedger[0]?.isStale, true);
      assert.equal(sharedLedger[0]?.transactionId, "TX_GLB_CACHED_1");
    });

    it("getGlobalPoolSummary surfaces server error cleanly without local calculation", async () => {
      api.wallet.getGlobalPoolSummary = async () => {
        throw new Error("HTTP 401 Unauthorized");
      };

      const summary = await getGlobalPoolSummary("FT777001");
      assert.equal(summary.isStale, true);
      assert.ok(summary.error && summary.error.includes("401"));
    });

    it("deriveGlobalIncomeDisplayState renders live server values when all 3 authenticated endpoints succeed", () => {
      const liveWallet: UserWallet = {
        userId: "FT777001",
        balance: 50,
        totalEarned: 50,
        totalWithdrawn: 0,
        referralIncome: 10,
        globalIncome: 18.45,
        adsenseIncome: 21.55,
        admobIncome: 0,
        affiliateIncome: 0,
        updatedAt: "2026-11-18T00:00:00.000Z",
        isStale: false,
      };
      const liveSummary: GlobalPoolSummary = {
        excludedUserId: "FT777001",
        poolAmount: 3,
        poolPaise: 300,
        eligibleVideoCount: 5,
        distinctCreatorCount: 2,
        estimatedEqualSharePerVideo: 0.6,
        totalAdEarnings: 0,
        weightingMode: "equal_fallback",
        isStale: false,
      };
      const liveTx: LedgerTransaction[] = [
        {
          id: "tx-glb-1",
          transactionId: "TX_GLB_LIVE_1",
          userId: "FT777001",
          incomeType: "global_income",
          amount: 0.6,
          status: "settled",
          description: "Live global pool payout",
          createdAt: "2026-11-18T00:00:00.000Z",
          isStale: false,
        },
        {
          id: "tx-ref-1",
          transactionId: "TX_REF_LIVE_1",
          userId: "FT777001",
          incomeType: "referral_income",
          amount: 1.0,
          status: "settled",
          description: "Referral payout (must be excluded)",
          createdAt: "2026-11-18T00:00:00.000Z",
          isStale: false,
        },
      ];

      const view = deriveGlobalIncomeDisplayState({
        loading: false,
        userId: "FT777001",
        wallet: liveWallet,
        walletError: null,
        transactions: liveTx,
        ledgerError: null,
        poolSummary: liveSummary,
      });

      assert.equal(view.hasAnyServerError, false);
      assert.equal(view.globalIncomeValue, "₹18.45");
      assert.equal(view.globalIncomeCaption, "Eligible video share");
      assert.equal(view.eligibleVideosValue, 5);
      assert.equal(view.eligibleVideosCaption, "2 creators · Sponsor uploads");
      assert.equal(view.sharePerVideoValue, "₹0.60");
      assert.equal(view.distributionStatusCaption, "Server ledger synced");
      assert.equal(view.ledgerHeaderSubtitle, "Live database ledger records");
      assert.equal(view.visibleTransactions.length, 1);
      assert.equal(view.visibleTransactions[0]?.transactionId, "TX_GLB_LIVE_1");
    });

    it("deriveGlobalIncomeDisplayState shows unavailable states and 'Awaiting server sync' whenever ANY required server request fails or returns stale data", () => {
      const liveWallet: UserWallet = {
        userId: "FT777001",
        balance: 50,
        totalEarned: 50,
        totalWithdrawn: 0,
        referralIncome: 10,
        globalIncome: 18.45,
        adsenseIncome: 21.55,
        admobIncome: 0,
        affiliateIncome: 0,
        updatedAt: "2026-11-18T00:00:00.000Z",
        isStale: false,
      };
      const liveSummary: GlobalPoolSummary = {
        excludedUserId: "FT777001",
        poolAmount: 3,
        poolPaise: 300,
        eligibleVideoCount: 5,
        distinctCreatorCount: 2,
        estimatedEqualSharePerVideo: 0.6,
        totalAdEarnings: 0,
        weightingMode: "equal_fallback",
        isStale: false,
      };

      // A. Wallet request failed -> must show "—" (NOT ₹0.00) and "Awaiting server sync"
      const walletFailView = deriveGlobalIncomeDisplayState({
        loading: false,
        userId: "FT777001",
        wallet: null,
        walletError: "HTTP 503",
        transactions: [],
        ledgerError: null,
        poolSummary: liveSummary,
      });
      assert.equal(walletFailView.globalIncomeValue, "—");
      assert.equal(walletFailView.globalIncomeCaption, "Server balance unavailable");
      assert.equal(walletFailView.distributionStatusCaption, "Awaiting server sync");
      assert.equal(walletFailView.eligibleVideosValue, 5);

      // B. Stale cached wallet passed -> rejected even without walletError string
      const staleWalletView = deriveGlobalIncomeDisplayState({
        loading: false,
        userId: "FT777001",
        wallet: { ...liveWallet, isStale: true },
        walletError: null,
        transactions: [],
        ledgerError: null,
        poolSummary: liveSummary,
      });
      assert.equal(staleWalletView.globalIncomeValue, "—");
      assert.equal(staleWalletView.globalIncomeCaption, "Server balance unavailable");
      assert.equal(staleWalletView.distributionStatusCaption, "Awaiting server sync");

      // C. Ledger request failed -> unavailable subtitle & empty message, "Awaiting server sync"
      const ledgerFailView = deriveGlobalIncomeDisplayState({
        loading: false,
        userId: "FT777001",
        wallet: liveWallet,
        walletError: null,
        transactions: [],
        ledgerError: "HTTP 500",
        poolSummary: liveSummary,
      });
      assert.equal(ledgerFailView.ledgerHeaderSubtitle, "Server ledger unavailable");
      assert.ok(ledgerFailView.ledgerEmptyMessage.includes("Server ledger unavailable"));
      assert.equal(ledgerFailView.visibleTransactions.length, 0);
      assert.equal(ledgerFailView.distributionStatusCaption, "Awaiting server sync");

      // D. Stale cached ledger entries passed -> rejected & never rendered
      const staleLedgerView = deriveGlobalIncomeDisplayState({
        loading: false,
        userId: "FT777001",
        wallet: liveWallet,
        walletError: null,
        transactions: [
          {
            id: "stale-1",
            transactionId: "TX_GLB_STALE_1",
            userId: "FT777001",
            incomeType: "global_income",
            amount: 3.0,
            status: "settled",
            description: "Stale local row",
            createdAt: "2026-11-01T00:00:00.000Z",
            isStale: true,
          },
        ],
        ledgerError: null,
        poolSummary: liveSummary,
      });
      assert.equal(staleLedgerView.visibleTransactions.length, 0);
      assert.equal(staleLedgerView.ledgerHeaderSubtitle, "Server ledger unavailable");
      assert.equal(staleLedgerView.distributionStatusCaption, "Awaiting server sync");

      // E. Pool summary failed -> "—", unavailable captions, and "Awaiting server sync"
      const poolFailView = deriveGlobalIncomeDisplayState({
        loading: false,
        userId: "FT777001",
        wallet: liveWallet,
        walletError: null,
        transactions: [],
        ledgerError: null,
        poolSummary: { ...liveSummary, isStale: true, error: "Database offline" },
      });
      assert.equal(poolFailView.eligibleVideosValue, "—");
      assert.equal(poolFailView.eligibleVideosCaption, "Server summary unavailable");
      assert.equal(poolFailView.sharePerVideoValue, "—");
      assert.equal(poolFailView.sharePerVideoCaption, "Live pool data required");
      assert.equal(poolFailView.distributionStatusCaption, "Awaiting server sync");
    });

    it("verifies src/routes/global-income.tsx uses strict server-only fetchers and never renders stale cached balance", () => {
      const routeSource = fs.readFileSync(path.join(ROOT, "src/routes/global-income.tsx"), "utf8");
      assert.ok(routeSource.includes("getAuthoritativeUserWallet"));
      assert.ok(routeSource.includes("getAuthoritativeUserLedger"));
      assert.ok(routeSource.includes("getGlobalPoolSummary"));
      assert.ok(routeSource.includes("deriveGlobalIncomeDisplayState"));
      assert.ok(!routeSource.includes("getUserWallet("));
      assert.ok(!routeSource.includes("getUserLedger("));
      assert.ok(!routeSource.includes("Cached server balance"));
    });
  });
});
