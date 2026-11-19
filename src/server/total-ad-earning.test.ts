import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { handleApiRequest } from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";
import { api } from "../lib/api.ts";
import {
  calculateTotalAdEarning,
  getUserWallet,
  processWithdrawal,
  saveStoredWallets,
  saveStoredLedger,
  type UserWallet,
} from "../lib/ledger-service.ts";

const ROOT = process.cwd();

const ADMIN_SESSION_ROW = {
  id: 1,
  user_id: "FT000001",
  name: "Platform Admin",
  mobile: "9999999999",
  email: "admin@facetube.online",
  role: "admin",
  referral_code: "FTADMIN",
  avatar_url: null,
  created_at: "2026-01-01 00:00:00",
};

const CREATOR_SESSION_ROW = {
  id: 2,
  user_id: "FT777001",
  name: "Creator User",
  mobile: "8888888888",
  email: "creator@facetube.online",
  role: "user",
  referral_code: "FTCREATOR",
  avatar_url: null,
  created_at: "2026-02-01 00:00:00",
};

const memoryStore = new Map<string, string>();
const mockLocalStorage = {
  getItem: (key: string) => memoryStore.get(key) ?? null,
  setItem: (key: string, value: string) => memoryStore.set(key, String(value)),
  removeItem: (key: string) => memoryStore.delete(key),
  clear: () => memoryStore.clear(),
};

const originalWindow = (globalThis as any).window;
const originalLocalStorage = (globalThis as any).localStorage;

describe("FaceTube Company Task: Total Ad Earning Display", () => {
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
  // 1. Business Rule: Total Ad Earning = AdSense + AdMob only
  // --------------------------------------------------------------------------
  describe("1. calculateTotalAdEarning() business rule", () => {
    it("sums only verified AdSense + AdMob and excludes Referral, Global Pool, Affiliate, and Ad Boost", () => {
      const wallet: UserWallet = {
        userId: "FT777001",
        balance: 9999,
        totalEarned: 15000,
        totalWithdrawn: 5001,
        referralIncome: 4000,
        globalIncome: 3000,
        adsenseIncome: 125.45,
        admobIncome: 74.55,
        affiliateIncome: 2500,
        updatedAt: "2026-11-01T00:00:00.000Z",
      };
      assert.equal(calculateTotalAdEarning(wallet), 200);
    });

    it("handles missing admobIncome, null wallet, and floating-point precision safely", () => {
      assert.equal(calculateTotalAdEarning(null), 0);
      assert.equal(calculateTotalAdEarning(undefined), 0);
      assert.equal(calculateTotalAdEarning({ adsenseIncome: 10.1 }), 10.1);
      assert.equal(calculateTotalAdEarning({ adsenseIncome: 0.1, admobIncome: 0.2 }), 0.3);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Wallet Balance: processWithdrawal() preserves admobIncome without changing formulas
  // --------------------------------------------------------------------------
  describe("2. processWithdrawal() preserves admobIncome & withdrawal math", () => {
    it("preserves admobIncome when server updatedWallet omits it and keeps 20% fee (18% GST + 2% PG)", async () => {
      const originalWithdraw = api.wallet.withdraw;
      const originalGetBalance = api.wallet.getBalance;
      const originalGetTransactions = api.wallet.getTransactions;
      try {
        saveStoredWallets({
          FT777001: {
            userId: "FT777001",
            balance: 2000,
            totalEarned: 2500,
            totalWithdrawn: 500,
            referralIncome: 300,
            globalIncome: 200,
            adsenseIncome: 650.25,
            admobIncome: 349.75,
            affiliateIncome: 1000,
            updatedAt: "2026-11-01T00:00:00.000Z",
          },
        });
        saveStoredLedger([]);

        api.wallet.getTransactions = async () => ({ success: true, transactions: [], total: 0 });
        api.wallet.getBalance = async () => ({
          success: true,
          wallet: {
            user_id: "FT777001",
            balance: 2000,
            total_earned: 2500,
            total_withdrawn: 500,
            referral_income: 300,
            global_income: 200,
            adsense_income: 650.25,
            admob_income: 349.75,
            affiliate_income: 1000,
            updated_at: "2026-11-01T00:00:00.000Z",
          },
        });

        // Simulate a backend response whose updatedWallet omits admobIncome / admob_income
        api.wallet.withdraw = async (data) => ({
          success: true,
          transaction: {
            id: "wd-001",
            transaction_id: "TX_WD_001",
            amount: data.amount,
          },
          updatedWallet: {
            userId: "FT777001",
            balance: 2000 - data.amount,
            totalEarned: 2500,
            totalWithdrawn: 500 + data.amount,
            referralIncome: 300,
            globalIncome: 200,
            adsenseIncome: 650.25,
            affiliateIncome: 1000,
          },
        });

        const res = await processWithdrawal("FT777001", 500, { upiId: "creator@upi" });
        assert.equal(res.success, true);
        assert.ok(res.updatedWallet);
        assert.equal(res.updatedWallet.balance, 1500);
        assert.equal(res.updatedWallet.totalWithdrawn, 1000);
        assert.equal(res.updatedWallet.adsenseIncome, 650.25);
        assert.equal(
          res.updatedWallet.admobIncome,
          349.75,
          "admobIncome must be preserved when omitted from server updatedWallet",
        );
        assert.equal(calculateTotalAdEarning(res.updatedWallet), 1000);

        // Withdrawal fee calculation unchanged: 20% fee (₹100) and 80% net (₹400)
        assert.equal(res.transaction?.fee, 100);
        assert.equal(res.transaction?.netAmount, 400);
      } finally {
        api.wallet.withdraw = originalWithdraw;
        api.wallet.getBalance = originalGetBalance;
        api.wallet.getTransactions = originalGetTransactions;
      }
    });

    it("uses server updatedWallet.admob_income when explicitly returned", async () => {
      const originalWithdraw = api.wallet.withdraw;
      const originalGetBalance = api.wallet.getBalance;
      const originalGetTransactions = api.wallet.getTransactions;
      try {
        saveStoredLedger([]);
        api.wallet.getTransactions = async () => ({ success: true, transactions: [], total: 0 });
        api.wallet.getBalance = async () => ({
          success: true,
          wallet: {
            user_id: "FT777001",
            balance: 1000,
            total_earned: 1000,
            total_withdrawn: 0,
            referral_income: 0,
            global_income: 0,
            adsense_income: 400,
            admob_income: 600,
            affiliate_income: 0,
            updated_at: "2026-11-01T00:00:00.000Z",
          },
        });
        api.wallet.withdraw = async (data) => ({
          success: true,
          transaction: { id: "wd-002", transaction_id: "TX_WD_002", amount: data.amount },
          updatedWallet: {
            user_id: "FT777001",
            balance: 800,
            total_earned: 1000,
            total_withdrawn: 200,
            referral_income: 0,
            global_income: 0,
            adsense_income: 400,
            admob_income: 600,
            affiliate_income: 0,
          },
        });

        const res = await processWithdrawal("FT777001", 200);
        assert.equal(res.success, true);
        assert.equal(res.updatedWallet?.admobIncome, 600);
        assert.equal(res.transaction?.fee, 40);
        assert.equal(res.transaction?.netAmount, 160);
      } finally {
        api.wallet.withdraw = originalWithdraw;
        api.wallet.getBalance = originalGetBalance;
        api.wallet.getTransactions = originalGetTransactions;
      }
    });

    it("preserves currentWallet.admobIncome when server updatedWallet returns explicit null admob_income/admobIncome", async () => {
      const originalWithdraw = api.wallet.withdraw;
      const originalGetBalance = api.wallet.getBalance;
      const originalGetTransactions = api.wallet.getTransactions;
      try {
        saveStoredWallets({
          FT777001: {
            userId: "FT777001",
            balance: 1200,
            totalEarned: 1500,
            totalWithdrawn: 300,
            referralIncome: 100,
            globalIncome: 200,
            adsenseIncome: 500,
            admobIncome: 425.5,
            affiliateIncome: 274.5,
            updatedAt: "2026-11-01T00:00:00.000Z",
          },
        });
        saveStoredLedger([]);

        api.wallet.getTransactions = async () => ({ success: true, transactions: [], total: 0 });
        api.wallet.getBalance = async () => ({
          success: true,
          wallet: {
            user_id: "FT777001",
            balance: 1200,
            total_earned: 1500,
            total_withdrawn: 300,
            referral_income: 100,
            global_income: 200,
            adsense_income: 500,
            admob_income: 425.5,
            affiliate_income: 274.5,
            updated_at: "2026-11-01T00:00:00.000Z",
          },
        });
        api.wallet.withdraw = async (data) => ({
          success: true,
          transaction: { id: "wd-null", transaction_id: "TX_WD_NULL", amount: data.amount },
          updatedWallet: {
            user_id: "FT777001",
            balance: 1200 - data.amount,
            total_earned: 1500,
            total_withdrawn: 300 + data.amount,
            referral_income: 100,
            global_income: 200,
            adsense_income: 500,
            admob_income: null,
            admobIncome: null,
            affiliate_income: 274.5,
          } as any,
        });

        const res = await processWithdrawal("FT777001", 300, { upiId: "creator@upi" });
        assert.equal(res.success, true);
        assert.ok(res.updatedWallet);
        assert.equal(res.updatedWallet.balance, 900);
        assert.equal(
          res.updatedWallet.admobIncome,
          425.5,
          "Explicit null admob_income/admobIncome must NOT reset currentWallet.admobIncome",
        );
        assert.equal(calculateTotalAdEarning(res.updatedWallet), 925.5);
        assert.equal(res.transaction?.fee, 60);
        assert.equal(res.transaction?.netAmount, 240);
      } finally {
        api.wallet.withdraw = originalWithdraw;
        api.wallet.getBalance = originalGetBalance;
        api.wallet.getTransactions = originalGetTransactions;
      }
    });

    it("preserves currentWallet.admobIncome when server response omits updatedWallet entirely", async () => {
      const originalWithdraw = api.wallet.withdraw;
      const originalGetBalance = api.wallet.getBalance;
      const originalGetTransactions = api.wallet.getTransactions;
      try {
        saveStoredWallets({
          FT777001: {
            userId: "FT777001",
            balance: 1000,
            totalEarned: 1000,
            totalWithdrawn: 0,
            referralIncome: 50,
            globalIncome: 50,
            adsenseIncome: 300,
            admobIncome: 250.75,
            affiliateIncome: 349.25,
            updatedAt: "2026-11-01T00:00:00.000Z",
          },
        });
        saveStoredLedger([]);

        api.wallet.getTransactions = async () => ({ success: true, transactions: [], total: 0 });
        api.wallet.getBalance = async () => ({
          success: true,
          wallet: {
            user_id: "FT777001",
            balance: 1000,
            total_earned: 1000,
            total_withdrawn: 0,
            referral_income: 50,
            global_income: 50,
            adsense_income: 300,
            admob_income: 250.75,
            affiliate_income: 349.25,
            updated_at: "2026-11-01T00:00:00.000Z",
          },
        });
        api.wallet.withdraw = async (data) => ({
          success: true,
          transaction: { id: "wd-no-wallet", transaction_id: "TX_WD_NOWAL", amount: data.amount },
        });

        const res = await processWithdrawal("FT777001", 250, { upiId: "creator@upi" });
        assert.equal(res.success, true);
        assert.ok(res.updatedWallet);
        assert.equal(res.updatedWallet.balance, 750);
        assert.equal(res.updatedWallet.totalWithdrawn, 250);
        assert.equal(res.updatedWallet.admobIncome, 250.75);
        assert.equal(calculateTotalAdEarning(res.updatedWallet), 550.75);
        assert.equal(res.transaction?.fee, 50);
        assert.equal(res.transaction?.netAmount, 200);
      } finally {
        api.wallet.withdraw = originalWithdraw;
        api.wallet.getBalance = originalGetBalance;
        api.wallet.getTransactions = originalGetTransactions;
      }
    });

    it("preserves cached admobIncome in getUserWallet() offline fallback when live API fails", async () => {
      const originalGetBalance = api.wallet.getBalance;
      try {
        saveStoredWallets({
          FT777001: {
            userId: "FT777001",
            balance: 850,
            totalEarned: 950,
            totalWithdrawn: 100,
            referralIncome: 100,
            globalIncome: 50,
            adsenseIncome: 310.25,
            admobIncome: 189.75,
            affiliateIncome: 300,
            updatedAt: "2026-11-01T00:00:00.000Z",
          },
        });

        api.wallet.getBalance = async () => {
          throw new Error("Simulated offline network failure");
        };

        const cached = await getUserWallet("FT777001");
        assert.equal(cached.isStale, true);
        assert.equal(cached.adsenseIncome, 310.25);
        assert.equal(cached.admobIncome, 189.75);
        assert.equal(calculateTotalAdEarning(cached), 500);
      } finally {
        api.wallet.getBalance = originalGetBalance;
      }
    });
  });

  // --------------------------------------------------------------------------
  // 3. Earnings History: admob category mapped strictly from admob_income (never referral)
  // --------------------------------------------------------------------------
  describe("3. GET /api/wallet/earnings-history (Node + PHP parity)", () => {
    it("maps admob_income to admob/admob_income and NEVER to referral in daily 7D mode", async () => {
      const todayKey = new Date().toISOString().split("T")[0]!;
      const mockPool = {
        query: async (sql: string) => {
          if (sql.includes("FROM sessions s")) {
            return [[CREATOR_SESSION_ROW]];
          }
          if (sql.includes("FROM income_ledger")) {
            return [
              [
                {
                  period_key: todayKey,
                  income_type: "admob_income",
                  total_amount: 145.5,
                  tx_count: 2,
                },
                {
                  period_key: todayKey,
                  income_type: "adsense_income",
                  total_amount: 254.5,
                  tx_count: 1,
                },
                {
                  period_key: todayKey,
                  income_type: "referral_income",
                  total_amount: 10,
                  tx_count: 1,
                },
                {
                  period_key: todayKey,
                  income_type: "global_income",
                  total_amount: 30,
                  tx_count: 1,
                },
                {
                  period_key: todayKey,
                  income_type: "affiliate_income",
                  total_amount: 50,
                  tx_count: 1,
                },
                {
                  period_key: todayKey,
                  income_type: "ad_boost_income",
                  total_amount: 20,
                  tx_count: 1,
                },
              ],
            ];
          }
          return [[]];
        },
      };
      setMysqlPoolForTesting(mockPool);

      const req = new Request(
        "http://localhost:3000/api/wallet/earnings-history?user_id=FT777001&period=7D",
        {
          method: "GET",
          headers: { Authorization: "Bearer creator-token" },
        },
      );
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.success, true);
      assert.equal(data.summary.admob, 145.5);
      assert.equal(data.summary.adsense, 254.5);
      assert.equal(data.summary.referral, 10, "admob_income must NEVER leak into referral");
      assert.equal(data.summary.global, 30);
      assert.equal(data.summary.affiliate, 50);
      assert.equal(data.summary.ad_boost, 20);
      assert.equal(data.summary.total_revenue, 510);

      const todayPoint = data.history.find((h: any) => h.date === todayKey);
      assert.ok(todayPoint);
      assert.equal(todayPoint.admob, 145.5);
      assert.equal(todayPoint.admob_income, 145.5);
      assert.equal(todayPoint.adsense, 254.5);
      assert.equal(todayPoint.referral, 10);
      assert.equal(todayPoint.revenue, 510);
    });

    it("maps admob_income properly in 12M monthly aggregation mode", async () => {
      const now = new Date();
      const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const mockPool = {
        query: async (sql: string) => {
          if (sql.includes("FROM sessions s")) {
            return [[CREATOR_SESSION_ROW]];
          }
          if (sql.includes("FROM income_ledger")) {
            return [
              [
                {
                  period_key: monthKey,
                  income_type: "ADMOB_INCOME",
                  total_amount: 88.25,
                  tx_count: 3,
                },
              ],
            ];
          }
          return [[]];
        },
      };
      setMysqlPoolForTesting(mockPool);

      const req = new Request(
        "http://localhost:3000/api/wallet/earnings-history?user_id=FT777001&period=12M",
        {
          method: "GET",
          headers: { Authorization: "Bearer creator-token" },
        },
      );
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.period, "12M");
      assert.equal(data.history.length, 12);
      assert.equal(data.summary.admob, 88.25);
      assert.equal(data.summary.referral, 0);
      const curMonth = data.history.find((h: any) => h.date === monthKey);
      assert.ok(curMonth);
      assert.equal(curMonth.admob, 88.25);
      assert.equal(curMonth.admob_income, 88.25);
      assert.equal(curMonth.referral, 0);
    });

    it("maintains PHP parity in api/wallet/earnings-history.php", () => {
      const php = fs.readFileSync(path.join(ROOT, "api/wallet/earnings-history.php"), "utf8");
      assert.ok(php.includes("'admob' => 0.0"), "PHP summary and timeline must initialize admob");
      assert.ok(php.includes("'admob_income' => 0.0"), "PHP timeline must initialize admob_income");
      assert.ok(
        php.includes("$type === 'admob_income'") && php.includes("$category = 'admob'"),
        "PHP must map admob_income strictly to admob",
      );
    });

    it("fails closed with 503 in production when MySQL pool is unavailable (Phase 2 protection)", async () => {
      const req = new Request(
        "http://localhost:3000/api/wallet/earnings-history?user_id=FT777001&period=30D",
        {
          method: "GET",
          headers: { Authorization: "Bearer creator-token" },
        },
      );
      const res = await handleApiRequest(req, {
        NODE_ENV: "production",
        DB_HOST: "",
        DB_NAME: "",
        DB_USER: "",
      });
      assert.ok(res);
      assert.equal(res.status, 503);
    });
  });

  // --------------------------------------------------------------------------
  // 4. Admin Earnings Report: AdMob + Total Ad Earning, DB column compat, CSV, date_mode
  // --------------------------------------------------------------------------
  describe("4. GET /api/admin/earnings-report (DB compat, JSON, CSV, date_mode, Phase 2)", () => {
    it("references wb.admob_income when column exists and returns separate + combined ad earnings", async () => {
      const executedSql: string[] = [];
      const mockPool = {
        query: async (sql: string) => {
          executedSql.push(sql);
          if (sql.includes("FROM sessions s")) {
            return [[ADMIN_SESSION_ROW]];
          }
          if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) {
            return [[{ COLUMN_NAME: "admob_income" }]];
          }
          if (sql.includes("SELECT COUNT(*)")) {
            return [[{ total: 1 }]];
          }
          if (sql.includes("AS total_admob_income")) {
            return [
              [
                {
                  total_count: 1,
                  total_wallet_balance: 1500,
                  total_earned: 2000,
                  total_withdrawn: 500,
                  total_referral_income: 300,
                  total_global_income: 200,
                  total_adsense_income: 420.5,
                  total_admob_income: 179.5,
                  total_affiliate_income: 900,
                },
              ],
            ];
          }
          if (sql.includes("AS admob_income")) {
            return [
              [
                {
                  id: 2,
                  user_id: "FT777001",
                  name: "Creator User",
                  email: "creator@facetube.online",
                  role: "user",
                  referral_code: "FTCREATOR",
                  created_at: "2026-02-01 00:00:00",
                  balance: 1500,
                  total_earned: 2000,
                  total_withdrawn: 500,
                  referral_income: 300,
                  global_income: 200,
                  adsense_income: 420.5,
                  admob_income: 179.5,
                  affiliate_income: 900,
                },
              ],
            ];
          }
          return [[]];
        },
      };
      setMysqlPoolForTesting(mockPool);

      const req = new Request(
        "http://localhost:3000/api/admin/earnings-report?date_mode=activity&start_date=2026-01-01&end_date=2026-12-31",
        {
          method: "GET",
          headers: { Authorization: "Bearer admin-token" },
        },
      );
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.success, true);
      assert.equal(data.summary.totalAdsenseIncome, 420.5);
      assert.equal(data.summary.totalAdmobIncome, 179.5);
      assert.equal(data.summary.totalAdEarning, 600);
      assert.equal(data.users.length, 1);
      assert.equal(data.users[0].adsenseIncome, 420.5);
      assert.equal(data.users[0].admobIncome, 179.5);
      assert.equal(data.users[0].totalAdEarning, 600);

      // Confirm wb.admob_income was used AND date_mode=activity filter was preserved
      const summaryQuery = executedSql.find((q) => q.includes("AS total_admob_income"))!;
      assert.ok(summaryQuery.includes("wb.admob_income"));
      assert.ok(
        summaryQuery.includes("SELECT DISTINCT user_id FROM income_ledger WHERE created_at >="),
        "date_mode=activity SQL filter must be preserved",
      );
    });

    it("omits wb.admob_income from SQL when wallet_balances.admob_income column is absent", async () => {
      const executedSql: string[] = [];
      const mockPool = {
        query: async (sql: string) => {
          executedSql.push(sql);
          if (sql.includes("FROM sessions s")) {
            return [[ADMIN_SESSION_ROW]];
          }
          if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) {
            return [[]]; // Column does NOT exist on legacy schema
          }
          if (sql.includes("SELECT COUNT(*)")) {
            return [[{ total: 1 }]];
          }
          if (sql.includes("AS total_admob_income")) {
            return [
              [
                {
                  total_count: 1,
                  total_wallet_balance: 300,
                  total_earned: 300,
                  total_withdrawn: 0,
                  total_referral_income: 0,
                  total_global_income: 0,
                  total_adsense_income: 110,
                  total_admob_income: 90,
                  total_affiliate_income: 100,
                },
              ],
            ];
          }
          if (sql.includes("AS admob_income")) {
            return [
              [
                {
                  id: 2,
                  user_id: "FT777001",
                  name: "Creator User",
                  email: "creator@facetube.online",
                  role: "user",
                  referral_code: "FTCREATOR",
                  created_at: "2026-02-01 00:00:00",
                  balance: 300,
                  total_earned: 300,
                  total_withdrawn: 0,
                  referral_income: 0,
                  global_income: 0,
                  adsense_income: 110,
                  admob_income: 90,
                  affiliate_income: 100,
                },
              ],
            ];
          }
          return [[]];
        },
      };
      setMysqlPoolForTesting(mockPool);

      const req = new Request(
        "http://localhost:3000/api/admin/earnings-report?date_mode=joined&start_date=2026-01-01",
        {
          method: "GET",
          headers: { Authorization: "Bearer admin-token" },
        },
      );
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.summary.totalAdsenseIncome, 110);
      assert.equal(data.summary.totalAdmobIncome, 90);
      assert.equal(data.summary.totalAdEarning, 200);
      assert.equal(data.users[0].totalAdEarning, 200);

      for (const q of executedSql) {
        assert.equal(
          q.includes("wb.admob_income"),
          false,
          "Must NOT reference wb.admob_income when column is missing from wallet_balances",
        );
      }
      const dataQuery = executedSql.find((q) => q.includes("AS admob_income"))!;
      assert.ok(dataQuery.includes("u.created_at >="), "date_mode=joined filter must be preserved");
    });

    it("exports AdSense, AdMob, and Total Ad Earning columns in CSV export", async () => {
      const mockPool = {
        query: async (sql: string) => {
          if (sql.includes("FROM sessions s")) return [[ADMIN_SESSION_ROW]];
          if (sql.includes("INFORMATION_SCHEMA.COLUMNS"))
            return [[{ COLUMN_NAME: "admob_income" }]];
          if (sql.includes("SELECT COUNT(*)")) return [[{ total: 1 }]];
          if (sql.includes("AS total_admob_income")) return [[{ total_count: 1 }]];
          if (sql.includes("AS admob_income")) {
            return [
              [
                {
                  id: 2,
                  user_id: "FT777001",
                  name: "Creator User",
                  email: "creator@facetube.online",
                  role: "user",
                  referral_code: "FTCREATOR",
                  created_at: "2026-02-01 00:00:00",
                  balance: 500,
                  total_earned: 600,
                  total_withdrawn: 100,
                  referral_income: 50,
                  global_income: 50,
                  adsense_income: 120.25,
                  admob_income: 79.75,
                  affiliate_income: 300,
                },
              ],
            ];
          }
          return [[]];
        },
      };
      setMysqlPoolForTesting(mockPool);

      const req = new Request("http://localhost:3000/api/admin/earnings-report?export=csv", {
        method: "GET",
        headers: { Authorization: "Bearer admin-token" },
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const csv = await res.text();
      assert.ok(csv.includes("AdSense Income (INR),AdMob Income (INR),Total Ad Earning (INR)"));
      assert.ok(csv.includes("120.25,79.75,200.00"));
    });

    it("fails closed with 503 in production when MySQL pool is unavailable (Phase 2 protection)", async () => {
      const req = new Request("http://localhost:3000/api/admin/earnings-report", {
        method: "GET",
        headers: { Authorization: "Bearer admin-token" },
      });
      const res = await handleApiRequest(req, {
        NODE_ENV: "production",
        DB_HOST: "",
        DB_NAME: "",
        DB_USER: "",
      });
      assert.ok(res);
      assert.equal(res.status, 503);
    });

    it("maintains PHP parity in api/admin/earnings-report.php", () => {
      const php = fs.readFileSync(path.join(ROOT, "api/admin/earnings-report.php"), "utf8");
      assert.ok(php.includes("INFORMATION_SCHEMA.COLUMNS"));
      assert.ok(php.includes("$wbAdmobFallback = $hasWalletAdmobCol ? 'wb.admob_income' : '0.00'"));
      assert.ok(php.includes("'totalAdmobIncome' => $totalAdmobIncome"));
      assert.ok(php.includes("'totalAdEarning' => $totalAdEarning"));
      assert.ok(php.includes("'admobIncome' => $rowAdmob"));
      assert.ok(php.includes("'totalAdEarning' => $rowTotalAd"));
      assert.ok(php.includes("'AdMob Income (INR)'"));
      assert.ok(php.includes("'Total Ad Earning (INR)'"));
      assert.ok(php.includes("if ($dateMode === 'activity')"));
    });

    it("falls back safely without referencing wb.admob_income when INFORMATION_SCHEMA probe throws", async () => {
      const executedSql: string[] = [];
      const mockPool = {
        query: async (sql: string) => {
          executedSql.push(sql);
          if (sql.includes("FROM sessions s")) return [[ADMIN_SESSION_ROW]];
          if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) {
            throw new Error("ER_TABLEACCESS_DENIED_ERROR: INFORMATION_SCHEMA access denied");
          }
          if (sql.includes("SELECT COUNT(*)")) return [[{ total: 1 }]];
          if (sql.includes("AS total_admob_income")) {
            return [
              [
                {
                  total_count: 1,
                  total_wallet_balance: 400,
                  total_earned: 400,
                  total_withdrawn: 0,
                  total_referral_income: 0,
                  total_global_income: 0,
                  total_adsense_income: 150,
                  total_admob_income: 50,
                  total_affiliate_income: 200,
                },
              ],
            ];
          }
          if (sql.includes("AS admob_income")) {
            return [
              [
                {
                  id: 2,
                  user_id: "FT777001",
                  name: "Creator User",
                  email: "creator@facetube.online",
                  role: "user",
                  referral_code: "FTCREATOR",
                  created_at: "2026-02-01 00:00:00",
                  balance: 400,
                  total_earned: 400,
                  total_withdrawn: 0,
                  referral_income: 0,
                  global_income: 0,
                  adsense_income: 150,
                  admob_income: 50,
                  affiliate_income: 200,
                },
              ],
            ];
          }
          return [[]];
        },
      };
      setMysqlPoolForTesting(mockPool);

      const req = new Request("http://localhost:3000/api/admin/earnings-report", {
        method: "GET",
        headers: { Authorization: "Bearer admin-token" },
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.summary.totalAdsenseIncome, 150);
      assert.equal(data.summary.totalAdmobIncome, 50);
      assert.equal(data.summary.totalAdEarning, 200);
      for (const q of executedSql) {
        assert.equal(
          q.includes("wb.admob_income"),
          false,
          "Must omit wb.admob_income if INFORMATION_SCHEMA probe throws",
        );
      }
    });
  });

  // --------------------------------------------------------------------------
  // 5. Admin Videos API: safe ad_earnings return without inventing per-video earnings
  // --------------------------------------------------------------------------
  describe("5. GET /api/admin/videos (DB compat, no invented earnings, Phase 2)", () => {
    it("returns uploaded_videos.ad_earnings when column exists", async () => {
      const executedSql: string[] = [];
      const mockPool = {
        query: async (sql: string) => {
          executedSql.push(sql);
          if (sql.includes("FROM sessions s")) return [[ADMIN_SESSION_ROW]];
          if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) return [[{ COLUMN_NAME: "ad_earnings" }]];
          if (sql.includes("FROM uploaded_videos")) {
            return [
              [
                {
                  id: "vid-1",
                  user_id: "FT777001",
                  creator_name: "Creator User",
                  title: "Verified Video",
                  content_type: "long",
                  is_blocked: 0,
                  ad_earnings: "42.75",
                  created_at: "2026-10-01 10:00:00",
                },
              ],
            ];
          }
          return [[]];
        },
      };
      setMysqlPoolForTesting(mockPool);

      const req = new Request("http://localhost:3000/api/admin/videos", {
        method: "GET",
        headers: { Authorization: "Bearer admin-token" },
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.videos.length, 1);
      assert.equal(data.videos[0].ad_earnings, 42.75);

      const videoSql = executedSql.find((q) => q.includes("FROM uploaded_videos"))!;
      assert.ok(videoSql.includes("COALESCE(ad_earnings, 0.00) AS ad_earnings"));
    });

    it("omits ad_earnings from SQL and payload when uploaded_videos.ad_earnings column does not exist", async () => {
      const executedSql: string[] = [];
      const mockPool = {
        query: async (sql: string) => {
          executedSql.push(sql);
          if (sql.includes("FROM sessions s")) return [[ADMIN_SESSION_ROW]];
          if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) return [[]];
          if (sql.includes("FROM uploaded_videos")) {
            return [
              [
                {
                  id: "vid-2",
                  user_id: "FT777001",
                  creator_name: "Creator User",
                  title: "Legacy Schema Video",
                  content_type: "short",
                  views: 50000,
                  is_blocked: 0,
                  created_at: "2026-10-02 10:00:00",
                },
              ],
            ];
          }
          return [[]];
        },
      };
      setMysqlPoolForTesting(mockPool);

      const req = new Request("http://localhost:3000/api/admin/videos", {
        method: "GET",
        headers: { Authorization: "Bearer admin-token" },
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.videos.length, 1);
      assert.equal(
        Object.prototype.hasOwnProperty.call(data.videos[0], "ad_earnings"),
        false,
        "Must NOT invent or calculate per-video ad_earnings when column is unsupported",
      );

      const videoSql = executedSql.find((q) => q.includes("FROM uploaded_videos"))!;
      assert.equal(videoSql.includes("ad_earnings"), false);
    });

    it("fails closed with 503 in production when MySQL pool is unavailable (Phase 2 protection)", async () => {
      const req = new Request("http://localhost:3000/api/admin/videos", {
        method: "GET",
        headers: { Authorization: "Bearer admin-token" },
      });
      const res = await handleApiRequest(req, {
        NODE_ENV: "production",
        DB_HOST: "",
        DB_NAME: "",
        DB_USER: "",
      });
      assert.ok(res);
      assert.equal(res.status, 503);
    });

    it("maintains PHP parity in api/admin/videos.php", () => {
      const php = fs.readFileSync(path.join(ROOT, "api/admin/videos.php"), "utf8");
      assert.ok(php.includes("INFORMATION_SCHEMA.COLUMNS"));
      assert.ok(php.includes("COLUMN_NAME = 'ad_earnings'"));
      assert.ok(
        php.includes(
          "$adEarningsSelect = $hasAdEarningsCol ? ', COALESCE(ad_earnings, 0.00) AS ad_earnings' : ''",
        ),
      );
    });

    it("falls back safely without selecting ad_earnings when INFORMATION_SCHEMA probe throws", async () => {
      const executedSql: string[] = [];
      const mockPool = {
        query: async (sql: string) => {
          executedSql.push(sql);
          if (sql.includes("FROM sessions s")) return [[ADMIN_SESSION_ROW]];
          if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) {
            throw new Error("ER_TABLEACCESS_DENIED_ERROR: INFORMATION_SCHEMA access denied");
          }
          if (sql.includes("FROM uploaded_videos")) {
            return [
              [
                {
                  id: "vid-probe-err",
                  user_id: "FT777001",
                  creator_name: "Creator User",
                  title: "Restricted Schema Video",
                  content_type: "long",
                  views: 9000,
                  is_blocked: 0,
                  created_at: "2026-10-03 10:00:00",
                },
              ],
            ];
          }
          return [[]];
        },
      };
      setMysqlPoolForTesting(mockPool);

      const req = new Request("http://localhost:3000/api/admin/videos", {
        method: "GET",
        headers: { Authorization: "Bearer admin-token" },
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.videos.length, 1);
      assert.equal(Object.prototype.hasOwnProperty.call(data.videos[0], "ad_earnings"), false);
      const videoSql = executedSql.find((q) => q.includes("FROM uploaded_videos"))!;
      assert.equal(videoSql.includes("ad_earnings"), false);
    });
  });

  // --------------------------------------------------------------------------
  // 6. UI Regression & Protection Checks
  // --------------------------------------------------------------------------
  describe("6. UI regression & Your Videos protection checks", () => {
    it("removes stale fallbacks/hardcoded earnings and wires AdMob + Total Ad Earning across UI routes", () => {
      const uploadSrc = fs.readFileSync(path.join(ROOT, "src/routes/upload.tsx"), "utf8");
      assert.equal(
        uploadSrc.includes("4,280.50"),
        false,
        "Stale ₹4,280.50 fallback must be removed",
      );
      assert.ok(uploadSrc.includes("calculateTotalAdEarning"));

      const modalSrc = fs.readFileSync(
        path.join(ROOT, "src/components/videohub/UploadOptionsModal.tsx"),
        "utf8",
      );
      assert.ok(modalSrc.includes("calculateTotalAdEarning"));
      assert.equal(modalSrc.includes("promo revenue"), false);

      const cardsSrc = fs.readFileSync(
        path.join(ROOT, "src/components/videohub/DashboardSummaryCards.tsx"),
        "utf8",
      );
      assert.equal(cardsSrc.includes("₹840 ad revenue"), false);
      assert.equal(cardsSrc.includes("₹3,150.00"), false);
      assert.equal(cardsSrc.includes("Last paid Sep 18"), false);

      const dashboardSrc = fs.readFileSync(path.join(ROOT, "src/routes/dashboard.tsx"), "utf8");
      assert.ok(dashboardSrc.includes('"adsense-income":'));
      assert.ok(dashboardSrc.includes('"admob-income":'));
      assert.ok(dashboardSrc.includes('"affiliate-income":'));
      assert.ok(dashboardSrc.includes('"withdrawal-balance":'));
      assert.ok(dashboardSrc.includes("earningsSummary?.admob"));
      assert.ok(dashboardSrc.includes("All 17 Summary Cards"));
      assert.ok(dashboardSrc.includes("Income Streams (7)"));
      assert.equal(dashboardSrc.includes("All 16 Summary Cards"), false);
      assert.equal(dashboardSrc.includes("Income Streams (6)"), false);

      const walletSrc = fs.readFileSync(path.join(ROOT, "src/routes/wallet-balance.tsx"), "utf8");
      assert.ok(walletSrc.includes("AdSense Income"));
      assert.ok(walletSrc.includes("AdMob Income"));
      assert.ok(walletSrc.includes("Total Ad Earning"));

      const yourVideosSrc = fs.readFileSync(path.join(ROOT, "src/routes/your-videos.tsx"), "utf8");
      assert.equal(yourVideosSrc.includes("ad_earnings"), false);
      assert.equal(yourVideosSrc.includes("Estimated Earnings"), false);
    });
  });
});
