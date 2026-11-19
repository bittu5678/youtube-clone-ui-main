import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApiRequest, resetInMemoryStore, resetStoreForTests } from "./api-handler.ts";
import { setTestPersistentDataDir } from "./payments.ts";

let testDataDir = "";
let STORE_PATH = "";

function resetUserForTest(userId: string, balance = 25000) {
  const raw = fs.readFileSync(STORE_PATH, "utf-8");
  const store = JSON.parse(raw);
  if (!store.wallets) store.wallets = {};
  store.wallets[userId] = {
    balance,
    total_earned: balance + 5000,
    total_withdrawn: 0,
    referral_income: 0,
    global_income: 0,
    adsense_income: balance,
    affiliate_income: 0,
    updated_at: new Date().toISOString(),
  };

  // Filter out any today's withdrawals for clean test state
  const todayPrefix = new Date().toISOString().split("T")[0];
  if (Array.isArray(store.walletTransactions)) {
    store.walletTransactions = store.walletTransactions.filter((tx: any) => {
      const u = String(tx.user_id || tx.userId || "")
        .trim()
        .toUpperCase();
      if (u !== userId.toUpperCase()) return true;
      const d = String(tx.created_at || tx.createdAt || "").split("T")[0];
      return d !== todayPrefix;
    });
  }

  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

describe("FaceTube Node.js Withdrawal Security & Cumulative Daily Limit Tests", () => {
  const env = { JWT_SECRET: "test_jwt_secret_key" };

  before(() => {
    testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-withdrawal-sec-test-"));
    STORE_PATH = path.join(testDataDir, "facetube_store.json");
    setTestPersistentDataDir(testDataDir);
    resetInMemoryStore();
    resetStoreForTests(undefined, 50000, env);
  });

  after(() => {
    setTestPersistentDataDir(null);
    resetInMemoryStore();
    if (testDataDir) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  // Helper to login and get token
  async function getAuthToken(identifier: string, password = "password") {
    const loginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password }),
    });
    const res = await handleApiRequest(loginReq, env);
    assert.ok(res);
    assert.equal(res.status, 200);
    const body = await res.json();
    return body.token as string;
  }

  // --------------------------------------------------------------------------
  // 1. Server-Side KYC Approval Verification
  // --------------------------------------------------------------------------
  describe("1. Server-Side KYC Approval Verification", () => {
    it("Rejects withdrawal when user KYC is unverified or in 'Submitted' state (FT900431)", async () => {
      const raw = fs.readFileSync(STORE_PATH, "utf-8");
      const store = JSON.parse(raw);
      // Ensure FT900431 has balance but unverified KYC (status: 'Submitted' or missing bank KYC)
      if (!store.wallets) store.wallets = {};
      store.wallets["FT900431"] = {
        balance: 15000,
        total_earned: 15000,
        total_withdrawn: 0,
        referral_income: 0,
        global_income: 0,
        adsense_income: 15000,
        affiliate_income: 0,
        updated_at: new Date().toISOString(),
      };
      if (!store.personalKyc) store.personalKyc = {};
      store.personalKyc["FT900431"] = {
        fullName: "Maya Lin",
        status: "Submitted", // NOT Verified!
      };
      if (store.bankKyc) {
        delete store.bankKyc["FT900431"]; // Missing bank KYC
      }
      fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");

      const token = await getAuthToken("FT900431", "password123");

      const withdrawReq = new Request("http://localhost:3000/api/wallet/withdraw", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ amount: 1000 }),
      });

      const res = await handleApiRequest(withdrawReq, env);
      assert.ok(res);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.match(body.error, /KYC verification required/i);
    });

    it("Rejects withdrawal when user has missing personal KYC", async () => {
      const raw = fs.readFileSync(STORE_PATH, "utf-8");
      const store = JSON.parse(raw);
      // Temporarily remove personalKyc for FT483921
      const savedPKyc = store.personalKyc?.["FT483921"];
      delete store.personalKyc?.["FT483921"];
      fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");

      try {
        const token = await getAuthToken("FT483921", "password123");
        const withdrawReq = new Request("http://localhost:3000/api/wallet/withdraw", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ amount: 1000 }),
        });

        const res = await handleApiRequest(withdrawReq, env);
        assert.ok(res);
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.success, false);
        assert.match(body.error, /Personal KYC verification required/i);
      } finally {
        // Restore personalKyc
        const restoreStore = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
        if (savedPKyc) {
          if (!restoreStore.personalKyc) restoreStore.personalKyc = {};
          restoreStore.personalKyc["FT483921"] = savedPKyc;
          fs.writeFileSync(STORE_PATH, JSON.stringify(restoreStore, null, 2), "utf-8");
        }
      }
    });

    it("Rejects withdrawal when user has missing bank KYC", async () => {
      const raw = fs.readFileSync(STORE_PATH, "utf-8");
      const store = JSON.parse(raw);
      const savedBKyc = store.bankKyc?.["FT483921"];
      delete store.bankKyc?.["FT483921"];
      fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");

      try {
        const token = await getAuthToken("FT483921", "password123");
        const withdrawReq = new Request("http://localhost:3000/api/wallet/withdraw", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ amount: 1000 }),
        });

        const res = await handleApiRequest(withdrawReq, env);
        assert.ok(res);
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.success, false);
        assert.match(body.error, /Bank KYC verification required/i);
      } finally {
        const restoreStore = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
        if (savedBKyc) {
          if (!restoreStore.bankKyc) restoreStore.bankKyc = {};
          restoreStore.bankKyc["FT483921"] = savedBKyc;
          fs.writeFileSync(STORE_PATH, JSON.stringify(restoreStore, null, 2), "utf-8");
        }
      }
    });

    it("Rejects withdrawal when user KYC is in 'Rejected' state", async () => {
      const raw = fs.readFileSync(STORE_PATH, "utf-8");
      const store = JSON.parse(raw);
      const savedPKyc = store.personalKyc?.["FT483921"];
      if (!store.personalKyc) store.personalKyc = {};
      store.personalKyc["FT483921"] = {
        fullName: "Alex Rivera",
        status: "Rejected",
      };
      fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");

      try {
        const token = await getAuthToken("FT483921", "password123");
        const withdrawReq = new Request("http://localhost:3000/api/wallet/withdraw", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ amount: 1000 }),
        });

        const res = await handleApiRequest(withdrawReq, env);
        assert.ok(res);
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.success, false);
        assert.match(body.error, /Personal KYC verification required/i);
      } finally {
        const restoreStore = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
        if (savedPKyc) {
          restoreStore.personalKyc["FT483921"] = savedPKyc;
          fs.writeFileSync(STORE_PATH, JSON.stringify(restoreStore, null, 2), "utf-8");
        }
      }
    });

    it("Allows withdrawal when user has verified Personal KYC and verified Bank KYC (FT102857)", async () => {
      resetUserForTest("FT102857", 20000);
      const token = await getAuthToken("FT102857", "password");

      const withdrawReq = new Request("http://localhost:3000/api/wallet/withdraw", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ amount: 1000 }),
      });

      const res = await handleApiRequest(withdrawReq, env);
      assert.ok(res);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.transaction.amount, 1000);
      // Fee breakdown: 18% GST (180) + 2% PG (20) = 200, Net = 800
      assert.equal(body.transaction.fee, 200);
      assert.equal(body.transaction.netAmount, 800);
      assert.equal(body.transaction.chargesBreakdown.gstAmount, 180);
      assert.equal(body.transaction.chargesBreakdown.pgFeeAmount, 20);
      assert.equal(body.transaction.chargesBreakdown.totalDeductionPercent, 20);
      assert.equal(body.transaction.chargesBreakdown.netPayable, 800);
    });

    it("Rejects withdrawal request below ₹100 minimum limit", async () => {
      resetUserForTest("FT102857", 20000);
      const token = await getAuthToken("FT102857", "password");

      const withdrawReq = new Request("http://localhost:3000/api/wallet/withdraw", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ amount: 99 }),
      });

      const res = await handleApiRequest(withdrawReq, env);
      assert.ok(res);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.match(body.error, /Minimum withdrawal amount is ₹100/i);
    });

    it("Allows minimum withdrawal of ₹100 with exact 20% fee deduction (18% GST + 2% PG)", async () => {
      resetUserForTest("FT102857", 20000);
      const token = await getAuthToken("FT102857", "password");

      const withdrawReq = new Request("http://localhost:3000/api/wallet/withdraw", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ amount: 100 }),
      });

      const res = await handleApiRequest(withdrawReq, env);
      assert.ok(res);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.transaction.amount, 100);
      // Fee breakdown: 18% GST (₹18) + 2% PG (₹2) = ₹20 total deduction, Net = ₹80
      assert.equal(body.transaction.fee, 20);
      assert.equal(body.transaction.netAmount, 80);
      assert.equal(body.transaction.chargesBreakdown.gstAmount, 18);
      assert.equal(body.transaction.chargesBreakdown.pgFeeAmount, 2);
      assert.equal(body.transaction.chargesBreakdown.totalDeductionPercent, 20);
      assert.equal(body.transaction.chargesBreakdown.netPayable, 80);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Cumulative Daily Withdrawal Limit Enforcement (₹10,000 / day)
  // --------------------------------------------------------------------------
  describe("2. Cumulative Daily Withdrawal Limit Enforcement (₹10,000 / day)", () => {
    beforeEach(() => {
      resetUserForTest("FT102857", 30000);
    });

    it("Enforces cumulative ₹10,000 daily limit across multiple withdrawals", async () => {
      const token = await getAuthToken("FT102857", "password");

      // 1. First withdrawal: ₹5,000 -> succeeds (Cumulative: ₹5,000)
      const res1 = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/withdraw", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ amount: 5000 }),
        }),
        env,
      );
      assert.ok(res1);
      assert.equal(res1.status, 200);
      const body1 = await res1.json();
      assert.equal(body1.success, true);

      // 2. Second withdrawal: ₹4,000 -> succeeds (Cumulative: ₹9,000)
      const res2 = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/withdraw", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ amount: 4000 }),
        }),
        env,
      );
      assert.ok(res2);
      assert.equal(res2.status, 200);
      const body2 = await res2.json();
      assert.equal(body2.success, true);

      // 3. Third withdrawal: ₹2,000 -> must REJECT (9,000 + 2,000 = 11,000 > 10,000)
      const res3 = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/withdraw", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ amount: 2000 }),
        }),
        env,
      );
      assert.ok(res3);
      assert.equal(res3.status, 400);
      const body3 = await res3.json();
      assert.equal(body3.success, false);
      assert.match(body3.error, /Daily limit exceeded/i);
      assert.match(body3.error, /already withdrawn ₹9,000/i);
      assert.match(body3.error, /at most ₹1,000 more today/i);

      // 4. Exact remaining withdrawal: ₹1,000 -> succeeds (Cumulative: exactly ₹10,000)
      const res4 = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/withdraw", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ amount: 1000 }),
        }),
        env,
      );
      assert.ok(res4);
      assert.equal(res4.status, 200);
      const body4 = await res4.json();
      assert.equal(body4.success, true);

      // 5. Subsequent withdrawal after reaching ₹10,000 -> blocked until tomorrow
      const res5 = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/withdraw", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ amount: 1000 }),
        }),
        env,
      );
      assert.ok(res5);
      assert.equal(res5.status, 400);
      const body5 = await res5.json();
      assert.equal(body5.success, false);
      assert.match(body5.error, /Daily withdrawal limit of ₹10,000 reached/i);
    });

    it("Excludes failed withdrawals from the daily cumulative total", async () => {
      const token = await getAuthToken("FT102857", "password");

      // Inject a 'failed' withdrawal record into store
      const raw = fs.readFileSync(STORE_PATH, "utf-8");
      const store = JSON.parse(raw);
      if (!Array.isArray(store.walletTransactions)) store.walletTransactions = [];
      store.walletTransactions.unshift({
        id: `tx-failed-${Date.now()}`,
        userId: "FT102857",
        amount: 8000,
        type: "withdrawal",
        status: "failed", // Should be excluded from daily total!
        created_at: new Date().toISOString(),
      });
      fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");

      // Now user requests ₹5,000 -> should succeed because the ₹8,000 was failed
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/withdraw", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ amount: 5000 }),
        }),
        env,
      );
      assert.ok(res);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Concurrent Withdrawal Race Condition Safety
  // --------------------------------------------------------------------------
  describe("3. Concurrent Withdrawal Safety", () => {
    it("Safely serializes concurrent requests and prevents over-withdrawal", async () => {
      // User with exactly ₹3,000 balance
      resetUserForTest("FT102857", 3000);
      const token = await getAuthToken("FT102857", "password");

      // Fire 4 parallel withdrawal requests of ₹1,000 each (Total ₹4,000 > ₹3,000 balance)
      const promises = [1, 2, 3, 4].map(() =>
        handleApiRequest(
          new Request("http://localhost:3000/api/wallet/withdraw", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ amount: 1000 }),
          }),
          env,
        ),
      );

      const results = await Promise.all(promises);
      const statuses = results.map((r) => r?.status);
      const successCount = statuses.filter((s) => s === 200).length;
      const failCount = statuses.filter((s) => s === 400).length;

      // Exactly 3 must succeed (consuming ₹3,000) and 1 must fail with insufficient balance
      assert.equal(successCount, 3, "Exactly 3 withdrawals must succeed given ₹3,000 balance");
      assert.equal(failCount, 1, "The 4th withdrawal must fail due to insufficient balance");

      // Check final balance is exactly ₹0, never negative
      const raw = fs.readFileSync(STORE_PATH, "utf-8");
      const store = JSON.parse(raw);
      assert.equal(store.wallets["FT102857"].balance, 0);
      assert.equal(store.wallets["FT102857"].total_withdrawn, 3000);
    });

    it("Safely prevents concurrent requests from exceeding ₹10,000 daily limit", async () => {
      // User with abundant balance (₹50,000)
      resetUserForTest("FT102857", 50000);
      const token = await getAuthToken("FT102857", "password");

      // Fire 12 parallel requests of ₹1,000 each (Total ₹12,000 > ₹10,000 daily limit)
      const promises = Array.from({ length: 12 }, () =>
        handleApiRequest(
          new Request("http://localhost:3000/api/wallet/withdraw", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ amount: 1000 }),
          }),
          env,
        ),
      );

      const results = await Promise.all(promises);
      const statuses = results.map((r) => r?.status);
      const successCount = statuses.filter((s) => s === 200).length;
      const failCount = statuses.filter((s) => s === 400).length;

      // Exactly 10 should succeed (reaching ₹10,000) and 2 must fail due to daily limit exceeded
      assert.equal(successCount, 10, "At most 10 requests of ₹1,000 can succeed in one day");
      assert.equal(failCount, 2, "Requests beyond ₹10,000 must be rejected");

      // Total withdrawn today must be exactly ₹10,000
      const raw = fs.readFileSync(STORE_PATH, "utf-8");
      const store = JSON.parse(raw);
      assert.equal(store.wallets["FT102857"].total_withdrawn, 10000);
      assert.equal(store.wallets["FT102857"].balance, 40000);
    });
  });
});
