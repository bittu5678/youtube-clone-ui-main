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
  SPONSOR_ALLOCATION_RULES,
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
    queryLog.push(params !== undefined ? { sql, params } : { sql });

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
            order_id: handlers.paymentTxRow["order_id"],
            user_id: "FT_PAYER_1",
            user_name: "Payer One",
            purpose: handlers.orderPurpose ?? handlers.paymentTxRow["purpose"],
            amount: handlers.paymentTxRow["amount"],
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
      mediaDirs = { videos: [videosDir], images: [thumbsDir] };
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
        if (sql.includes("COUNT(*) AS total_tx")) {
          return [
            [
              {
                total_tx: params.priorTxCount,
                min_tx: params.priorTxCount > 0 ? 1 : 0,
                max_tx: params.priorTxCount,
                distinct_tx: params.priorTxCount,
              },
            ],
          ];
        }
        if (sql.includes("COUNT(*) AS total_pt_tx")) {
          return [
            [
              {
                total_pt_tx: params.priorTxCount,
                min_pt_tx: params.priorTxCount > 0 ? 1 : 0,
                max_pt_tx: params.priorTxCount,
                seed_rows: 0,
              },
            ],
          ];
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
      const adminUser: RecoveryAuthUser = {
        id: "u-admin",
        user_id: "FT102857",
        name: "Platform Admin",
        role: "admin",
      };
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
        if (url.includes("/v1/orders/") && url.endsWith("/payments")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: "pay_rec_001",
                  status: "captured",
                  amount: 600,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.includes("/v1/payments/")) {
          return new Response(
            JSON.stringify({
              id: "pay_rec_001",
              order_id: "order_rec_001",
              status: "captured",
              amount: 600,
              currency: "INR",
              amount_refunded: 0,
              refund_status: null,
              created_at: 1730000005,
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
            notes: {
              purpose: "premium_video_upload",
              userId: "FT_REC_UPLOADER",
              videoId: "vid_rec_001",
              contentType: "long",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch;

      const req = new Request("http://localhost:3000/api/admin/recover-premium-payment", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok_admin",
        },
        body: JSON.stringify({
          dryRun: true,
          items: [
            {
              paymentId: "pay_rec_001",
              orderId: "order_rec_001",
              videoId: "vid_rec_001",
              userId: "FT_REC_UPLOADER",
              title: "Recovered Premium Video",
              category: "Technology",
              contentType: "long",
              videoFilename: "vid_rec_1.mp4",
              thumbnailFilename: "thumb_rec_1.jpg",
            },
          ],
        }),
      });

      const res = await handleAdminRecoverPremiumPayment(req, {
        pool,
        getAuthUser: async () => adminUser,
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
      const acc = data.results[0].accounting;
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
      const adminUser: RecoveryAuthUser = {
        id: "u-admin",
        user_id: "FT102857",
        name: "Platform Admin",
        role: "admin",
      };
      const pool = createRecoveryMockPool({
        priorTxCount: 10, // Next tx is #11 (SPECIAL_GLOBAL_RULE)
        eligibleVideos: [{ video_id: "v1", user_id: "CR_ALPHA", ad_earnings: 0 }],
      });

      const fakeFetch = (async (input: any) => {
        const url = String(input);
        if (url.includes("/v1/orders/") && url.endsWith("/payments")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: "pay_rec_11",
                  status: "captured",
                  amount: 600,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.includes("/v1/payments/")) {
          return new Response(
            JSON.stringify({
              id: "pay_rec_11",
              order_id: "order_rec_11",
              status: "captured",
              amount: 600,
              currency: "INR",
              amount_refunded: 0,
              refund_status: null,
              created_at: 1730000005,
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
            notes: {
              purpose: "premium_video_upload",
              userId: "FT_REC_UPLOADER",
              videoId: "vid_rec_011",
              contentType: "short",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch;

      const req = new Request("http://localhost:3000/api/admin/recover-premium-payment", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tok_admin",
        },
        body: JSON.stringify({
          dryRun: true,
          items: [
            {
              paymentId: "pay_rec_11",
              orderId: "order_rec_11",
              videoId: "vid_rec_011",
              userId: "FT_REC_UPLOADER",
              title: "Special 11th Video",
              category: "Entertainment",
              contentType: "short",
              videoFilename: "vid_rec_1.mp4",
              thumbnailFilename: "thumb_rec_1.jpg",
            },
          ],
        }),
      });

      const res = await handleAdminRecoverPremiumPayment(req, {
        pool,
        getAuthUser: async () => adminUser,
        env: {
          RAZORPAY_KEY_ID: "rzp_live_rec",
          RAZORPAY_KEY_SECRET: "rzp_secret_rec",
        },
        fetchImpl: fakeFetch,
        mediaDirs,
      });

      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      const acc = data.results[0].accounting;
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

  // --------------------------------------------------------------------------
  // 4. Sponsor ₹6 allocation overview, separated platform/user stats, weightingMode
  // --------------------------------------------------------------------------
  describe("4. Global Pool reporting clarity, Sponsor ₹6 buckets, weightingMode & privacy", () => {
    const originalGetGlobalPoolSummary = api.wallet.getGlobalPoolSummary;

    afterEach(() => {
      api.wallet.getGlobalPoolSummary = originalGetGlobalPoolSummary;
    });

    it("SPONSOR_ALLOCATION_RULES & global-income.tsx display all 4 ₹6 buckets, no-referrer Admin rule, and #11/#21/#31 special rules", () => {
      const normal = SPONSOR_ALLOCATION_RULES.normalWithReferrer;
      assert.equal(normal.directReferral, 1);
      assert.equal(normal.admin, 1);
      assert.equal(normal.gstAndPg, 1);
      assert.equal(normal.globalPool, 3);
      assert.equal(normal.directReferral + normal.admin + normal.gstAndPg + normal.globalPool, 6);

      const noRef = SPONSOR_ALLOCATION_RULES.normalWithoutReferrer;
      assert.equal(noRef.directReferral, 0);
      assert.equal(noRef.admin, 2);
      assert.equal(noRef.gstAndPg, 1);
      assert.equal(noRef.globalPool, 3);
      assert.equal(noRef.directReferral + noRef.admin + noRef.gstAndPg + noRef.globalPool, 6);

      const spWithRef = SPONSOR_ALLOCATION_RULES.specialTransactions.withReferrer;
      assert.equal(spWithRef.globalPool, 0);
      assert.equal(spWithRef.directReferral, 1);
      assert.equal(spWithRef.admin, 4);
      assert.equal(spWithRef.gstAndPg, 1);
      assert.equal(
        spWithRef.directReferral + spWithRef.admin + spWithRef.gstAndPg + spWithRef.globalPool,
        6,
      );

      const spNoRef = SPONSOR_ALLOCATION_RULES.specialTransactions.withoutReferrer;
      assert.equal(spNoRef.globalPool, 0);
      assert.equal(spNoRef.directReferral, 0);
      assert.equal(spNoRef.admin, 5);
      assert.equal(spNoRef.gstAndPg, 1);
      assert.equal(
        spNoRef.directReferral + spNoRef.admin + spNoRef.gstAndPg + spNoRef.globalPool,
        6,
      );

      const routeSource = fs.readFileSync(path.join(ROOT, "src/routes/global-income.tsx"), "utf8");
      assert.ok(routeSource.includes("Direct Referral"));
      assert.ok(routeSource.includes("Admin Allocation"));
      assert.ok(routeSource.includes("GST + Payment Gateway"));
      assert.ok(routeSource.includes("Global Income Pool"));
      assert.ok(routeSource.includes("Without Referrer Rule"));
      assert.ok(routeSource.includes("Special Transactions"));
      assert.ok(routeSource.includes("Platform-Wide Global Pool Statistics"));
      assert.ok(routeSource.includes("Your Eligible Sponsor Videos"));
    });

    it("/api/wallet/global-pool-summary (Node MySQL + PHP parity) includes current user in platform counts, separates user stats, omits equal share when weighted, and leaks no individual creator earnings", async () => {
      const capturedSql: string[] = [];
      const makePoolForMetrics = (metrics: {
        eligible_video_count: number;
        distinct_creator_count: number;
        total_ad_earnings: number;
        user_eligible_video_count: number;
        user_total_ad_earnings: number;
      }) =>
        ({
          query: async (sql: string) => {
            capturedSql.push(sql);
            if (sql.includes("FROM sessions")) {
              return [
                [
                  {
                    id: "u-self",
                    user_id: "FT_SELF1",
                    name: "Creator Self",
                    mobile: "",
                    email: "self@facetube.com",
                    role: "user",
                    referral_code: "",
                    created_at: new Date().toISOString(),
                  },
                ],
              ];
            }
            if (sql.includes("COUNT(*) AS eligible_video_count")) {
              return [[metrics]];
            }
            return [[]];
          },
          getConnection: async () => {
            throw new Error("Unexpected write connection in read-only summary endpoint");
          },
        }) as unknown as Pool;

      const prodEnv = { APP_ENV: "production", NODE_ENV: "production" };

      // Weighted mode: total_ad_earnings > 0 -> estimatedEqualSharePerVideo must be null
      const weightedPool = makePoolForMetrics({
        eligible_video_count: 8,
        distinct_creator_count: 3,
        total_ad_earnings: 120.5,
        user_eligible_video_count: 2,
        user_total_ad_earnings: 45.25,
      });

      const weightedRes = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/global-pool-summary?userId=FT_SELF1", {
          method: "GET",
          headers: { Authorization: "Bearer tok_self1" },
        }),
        prodEnv,
        { pool: weightedPool },
      );
      assert.ok(weightedRes);
      assert.equal(weightedRes.status, 200);
      const weightedJson = (await weightedRes.json()) as any;
      assert.equal(weightedJson.success, true);
      assert.equal(weightedJson.userId, "FT_SELF1");
      assert.equal(weightedJson.excludedUserId, null);
      assert.equal(weightedJson.eligibleVideoCount, 8);
      assert.equal(weightedJson.platformEligibleVideoCount, 8);
      assert.equal(weightedJson.distinctCreatorCount, 3);
      assert.equal(weightedJson.platformDistinctCreatorCount, 3);
      assert.equal(weightedJson.totalAdEarnings, 120.5);
      assert.equal(weightedJson.platformTotalAdEarnings, 120.5);
      assert.equal(weightedJson.userEligibleVideoCount, 2);
      assert.equal(weightedJson.userTotalAdEarnings, 45.25);
      assert.equal(weightedJson.weightingMode, "ad_earnings_weighted");
      assert.equal(weightedJson.estimatedEqualSharePerVideo, null);

      // Must NOT expose any creator lists or other creators' individual earnings
      assert.equal(weightedJson.creatorPayouts, undefined);
      assert.equal(weightedJson.creators, undefined);
      assert.equal(weightedJson.videos, undefined);

      // Platform-wide summary SQL must NOT exclude the current user
      const summarySql = capturedSql.find((s) => s.includes("COUNT(*) AS eligible_video_count"));
      assert.ok(summarySql);
      assert.ok(!summarySql.includes("UPPER(user_id) != UPPER(?)"));
      assert.ok(summarySql.includes("user_eligible_video_count"));
      assert.ok(summarySql.includes("user_total_ad_earnings"));

      // Equal fallback mode: total_ad_earnings === 0 -> estimatedEqualSharePerVideo computed
      const equalPool = makePoolForMetrics({
        eligible_video_count: 5,
        distinct_creator_count: 2,
        total_ad_earnings: 0,
        user_eligible_video_count: 1,
        user_total_ad_earnings: 0,
      });
      const equalRes = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/global-pool-summary?userId=FT_SELF1", {
          method: "GET",
          headers: { Authorization: "Bearer tok_self1" },
        }),
        prodEnv,
        { pool: equalPool },
      );
      assert.ok(equalRes);
      assert.equal(equalRes.status, 200);
      const equalJson = (await equalRes.json()) as any;
      assert.equal(equalJson.weightingMode, "equal_fallback");
      assert.equal(equalJson.estimatedEqualSharePerVideo, 0.6);
      assert.equal(equalJson.userEligibleVideoCount, 1);
      assert.equal(equalJson.userTotalAdEarnings, 0);

      // PHP parity verification
      const phpSource = fs.readFileSync(
        path.join(ROOT, "api/wallet/global-pool-summary.php"),
        "utf8",
      );
      assert.ok(!phpSource.includes("UPPER(user_id) != UPPER(?)"));
      assert.ok(phpSource.includes("user_eligible_video_count"));
      assert.ok(phpSource.includes("user_total_ad_earnings"));
      assert.ok(phpSource.includes("'platformEligibleVideoCount' => $platformEligibleVideoCount"));
      assert.ok(phpSource.includes("'userEligibleVideoCount' => $userEligibleVideoCount"));
      assert.ok(phpSource.includes("'userTotalAdEarnings' => $userTotalAdEarnings"));
      assert.ok(phpSource.includes("weightingMode === 'equal_fallback'"));
    });

    it("deriveGlobalIncomeDisplayState & getGlobalPoolSummary distinguish ad_earnings_weighted vs equal_fallback, separate user stats, and refuse fabricated zero/equal estimates", async () => {
      api.wallet.getGlobalPoolSummary = async () => ({
        success: true,
        userId: "FT_SELF1",
        excludedUserId: null,
        poolAmount: 3,
        poolPaise: 300,
        eligibleVideoCount: 8,
        platformEligibleVideoCount: 8,
        distinctCreatorCount: 3,
        platformDistinctCreatorCount: 3,
        totalAdEarnings: 120.5,
        platformTotalAdEarnings: 120.5,
        userEligibleVideoCount: 2,
        userTotalAdEarnings: 45.25,
        // Even if an equal number were mistakenly sent alongside weighted mode, client strips it
        estimatedEqualSharePerVideo: 0.37,
        weightingMode: "ad_earnings_weighted",
      });

      const weightedSummary = await getGlobalPoolSummary("FT_SELF1");
      assert.equal(weightedSummary.isStale, false);
      assert.equal(weightedSummary.estimatedEqualSharePerVideo, null);
      assert.equal(weightedSummary.userEligibleVideoCount, 2);
      assert.equal(weightedSummary.userTotalAdEarnings, 45.25);

      const liveWallet: UserWallet = {
        userId: "FT_SELF1",
        balance: 50,
        totalEarned: 50,
        totalWithdrawn: 0,
        referralIncome: 10,
        globalIncome: 22.5,
        adsenseIncome: 17.5,
        admobIncome: 0,
        affiliateIncome: 0,
        updatedAt: "2026-11-18T00:00:00.000Z",
        isStale: false,
      };

      const weightedView = deriveGlobalIncomeDisplayState({
        loading: false,
        userId: "FT_SELF1",
        wallet: liveWallet,
        walletError: null,
        transactions: [],
        ledgerError: null,
        poolSummary: weightedSummary,
      });

      // Never displays equal-share ₹0.37 when ad_earnings_weighted
      assert.equal(weightedView.sharePerVideoValue, "Ad-Weighted");
      assert.ok(!weightedView.sharePerVideoValue.includes("0.37"));
      assert.ok(
        weightedView.sharePerVideoCaption.includes("Weighted by eligible video ad earnings"),
      );
      assert.equal(weightedView.weightingModeLabel, "Ad Earnings Weighted");
      assert.equal(weightedView.eligibleVideosValue, 8);
      assert.equal(weightedView.platformCreatorsValue, 3);
      assert.equal(weightedView.platformAdEarningsValue, "₹120.50");
      assert.equal(weightedView.userEligibleVideosValue, 2);
      assert.equal(weightedView.userAdEarningsValue, "₹45.25");

      // Missing/unavailable user fields or stale pool -> "—" (never fabricated ₹0.00)
      const unavailableView = deriveGlobalIncomeDisplayState({
        loading: false,
        userId: "FT_SELF1",
        wallet: liveWallet,
        walletError: null,
        transactions: [],
        ledgerError: null,
        poolSummary: { ...weightedSummary, isStale: true, error: "Timeout" },
      });
      assert.equal(unavailableView.platformCreatorsValue, "—");
      assert.equal(unavailableView.platformAdEarningsValue, "—");
      assert.equal(unavailableView.userEligibleVideosValue, "—");
      assert.equal(unavailableView.userAdEarningsValue, "—");
      assert.equal(unavailableView.sharePerVideoValue, "—");
      assert.equal(unavailableView.weightingModeLabel, "Unavailable");
      assert.equal(unavailableView.distributionStatusCaption, "Awaiting server sync");
    });
  });
});
