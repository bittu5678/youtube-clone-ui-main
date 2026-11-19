import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApiRequest, resetInMemoryStore } from "./api-handler.ts";
import { setTestPersistentDataDir } from "./payments.ts";

describe("AdSense Monthly Statement Idempotency & Duplicate Prevention Tests", () => {
  let adminToken = "";
  let userToken = "";
  let testDataDir = "";
  let storePath = "";

  before(async () => {
    testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-adsense-dup-test-"));
    storePath = path.join(testDataDir, "facetube_store.json");
    setTestPersistentDataDir(testDataDir);
    resetInMemoryStore();

    // 1. Authenticate as Admin (FT102857 / admin@facetube.com)
    const adminLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "admin@facetube.com", password: "password123" }),
    });
    const adminLoginRes = await handleApiRequest(adminLoginReq);
    assert.ok(adminLoginRes, "Admin login request must return a response");
    const adminData = await adminLoginRes.json();
    assert.ok(adminData.token, "Admin login must return a session token");
    adminToken = adminData.token;

    // 2. Authenticate as Standard User (FT483921 / alex@facetube.com)
    const userLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
    });
    const userLoginRes = await handleApiRequest(userLoginReq);
    assert.ok(userLoginRes, "User login request must return a response");
    const userData = await userLoginRes.json();
    assert.ok(userData.token, "User login must return a session token");
    userToken = userData.token;
  });

  after(() => {
    setTestPersistentDataDir(null);
    resetInMemoryStore();
    if (testDataDir) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  describe("1. Authentication & RBAC Authorization", () => {
    it("rejects unauthenticated requests with HTTP 401", async () => {
      const req = new Request("http://localhost:3000/api/admin/record-adsense-earning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: "FT483921",
          amount: 500,
          reportMonth: "2026-08",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /authentication required/i);
    });

    it("rejects non-admin users with HTTP 403", async () => {
      const req = new Request("http://localhost:3000/api/admin/record-adsense-earning", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          userId: "FT483921",
          amount: 500,
          reportMonth: "2026-08",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /admin authorization required/i);
    });
  });

  describe("2. Parameter Validation", () => {
    it("rejects missing target user with HTTP 400", async () => {
      const req = new Request("http://localhost:3000/api/admin/record-adsense-earning", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          amount: 500,
          reportMonth: "2026-08",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /user_id is required/i);
    });

    it("rejects negative or zero amount with HTTP 400", async () => {
      const req = new Request("http://localhost:3000/api/admin/record-adsense-earning", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          userId: "FT483921",
          amount: 0,
          reportMonth: "2026-08",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /strictly greater than 0/i);
    });

    it("rejects invalid reportMonth format with HTTP 400", async () => {
      const req = new Request("http://localhost:3000/api/admin/record-adsense-earning", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          userId: "FT483921",
          amount: 500,
          reportMonth: "invalid-month",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /invalid reportMonth format/i);
    });
  });

  describe("3. Initial Statement Credit & Atomic Wallet Update", () => {
    it("successfully records valid monthly statement and credits wallet", async () => {
      // Check initial wallet balance
      const initialWalletReq = new Request(
        "http://localhost:3000/api/wallet/balance?userId=FT483921",
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      const initialWalletRes = await handleApiRequest(initialWalletReq);
      const initialWalletData = await initialWalletRes?.json();
      const initialBalance = Number(initialWalletData?.wallet?.balance || 0);
      const initialAdsense = Number(initialWalletData?.wallet?.adsense_income || 0);

      const recordReq = new Request("http://localhost:3000/api/admin/record-adsense-earning", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          userId: "FT483921",
          amount: 1500,
          reportMonth: "2026-07",
        }),
      });
      const recordRes = await handleApiRequest(recordReq);
      assert.ok(recordRes);
      assert.equal(recordRes.status, 200);
      const recordData = await recordRes.json();
      assert.equal(recordData.success, true);
      assert.equal(recordData.amount, 1500);
      assert.equal(recordData.reportMonth, "2026-07");
      assert.ok(recordData.transactionId.startsWith("TX_ADSENSE_FT483921_202607"));

      // Check updated wallet balance
      const updatedWalletReq = new Request(
        "http://localhost:3000/api/wallet/balance?userId=FT483921",
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      const updatedWalletRes = await handleApiRequest(updatedWalletReq);
      const updatedWalletData = await updatedWalletRes?.json();
      assert.equal(
        Number(updatedWalletData?.wallet?.balance || 0),
        initialBalance + 1500,
        "Wallet balance must be credited exactly ₹1,500",
      );
      assert.equal(
        Number(updatedWalletData?.wallet?.adsense_income || 0),
        initialAdsense + 1500,
        "AdSense income metric must be incremented by ₹1,500",
      );
    });
  });

  describe("4. Sequential Duplicate Statement Rejection", () => {
    it("rejects duplicate submission for the same creator and month without altering balance", async () => {
      // Capture wallet balance before duplicate attempt
      const preWalletReq = new Request("http://localhost:3000/api/wallet/balance?userId=FT483921", {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const preWalletRes = await handleApiRequest(preWalletReq);
      const preWalletData = await preWalletRes?.json();
      const balanceBefore = Number(preWalletData?.wallet?.balance || 0);

      // Attempt duplicate submission for 2026-07
      const duplicateReq = new Request("http://localhost:3000/api/admin/record-adsense-earning", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          userId: "FT483921",
          amount: 1500,
          reportMonth: "2026-07",
        }),
      });
      const duplicateRes = await handleApiRequest(duplicateReq);
      assert.ok(duplicateRes);
      assert.equal(
        duplicateRes.status,
        409,
        "Must return HTTP 409 Conflict on duplicate submission",
      );
      const duplicateData = await duplicateRes.json();
      assert.equal(duplicateData.success, false);
      assert.match(duplicateData.error, /already been credited and settled/i);

      // Verify wallet balance remained completely unchanged
      const postWalletReq = new Request(
        "http://localhost:3000/api/wallet/balance?userId=FT483921",
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      const postWalletRes = await handleApiRequest(postWalletReq);
      const postWalletData = await postWalletRes?.json();
      const balanceAfter = Number(postWalletData?.wallet?.balance || 0);
      assert.equal(
        balanceAfter,
        balanceBefore,
        "Wallet balance must NOT be credited again on duplicate",
      );
    });
  });

  describe("5. Concurrent Duplicate Submission Resilience", () => {
    it("handles simultaneous duplicate requests such that exactly ONE succeeds and all others fail with 409", async () => {
      const month = "2026-06";
      const targetUser = "FT900431"; // Maya Lin

      const preWalletReq = new Request(
        `http://localhost:3000/api/wallet/balance?userId=${targetUser}`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      const preWalletRes = await handleApiRequest(preWalletReq);
      const preWalletData = await preWalletRes?.json();
      const balanceBefore = Number(preWalletData?.wallet?.balance || 0);

      // Fire 5 concurrent requests simultaneously
      const concurrentRequests = Array.from({ length: 5 }, () =>
        handleApiRequest(
          new Request("http://localhost:3000/api/admin/record-adsense-earning", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
              userId: targetUser,
              amount: 2500,
              reportMonth: month,
            }),
          }),
        ),
      );

      const responses = await Promise.all(concurrentRequests);
      const statuses = responses.map((r) => r?.status);
      const successCount = statuses.filter((s) => s === 200).length;
      const conflictCount = statuses.filter((s) => s === 409).length;

      assert.equal(successCount, 1, "Exactly one concurrent request must succeed with HTTP 200");
      assert.equal(
        conflictCount,
        4,
        "Remaining 4 concurrent requests must fail with HTTP 409 Conflict",
      );

      // Verify wallet was credited exactly once
      const postWalletReq = new Request(
        `http://localhost:3000/api/wallet/balance?userId=${targetUser}`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      const postWalletRes = await handleApiRequest(postWalletReq);
      const postWalletData = await postWalletRes?.json();
      const balanceAfter = Number(postWalletData?.wallet?.balance || 0);

      assert.equal(
        balanceAfter,
        balanceBefore + 2500,
        "Wallet balance must increase by exactly one payout amount (₹2,500), not multiplied",
      );
    });
  });

  describe("6. Multi-Month & Multi-Creator Independence", () => {
    it("allows statements for different months for the same creator", async () => {
      const req = new Request("http://localhost:3000/api/admin/record-adsense-earning", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          userId: "FT483921",
          amount: 800,
          reportMonth: "2026-05",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.reportMonth, "2026-05");
    });

    it("allows statements for the same month for different creators", async () => {
      const req = new Request("http://localhost:3000/api/admin/record-adsense-earning", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          userId: "FT900431",
          amount: 950,
          reportMonth: "2026-05",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.userId, "FT900431");
      assert.equal(data.reportMonth, "2026-05");
    });
  });

  describe("7. Historical Conflict Isolation & Administrative Reporting", () => {
    it("allows administrators to query statements and historical conflicts via GET", async () => {
      const stmtReq = new Request(
        "http://localhost:3000/api/admin/record-adsense-earning?action=statements",
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      const stmtRes = await handleApiRequest(stmtReq);
      assert.ok(stmtRes);
      assert.equal(stmtRes.status, 200);
      const stmtData = await stmtRes.json();
      assert.equal(stmtData.success, true);
      assert.ok(Array.isArray(stmtData.statements));

      const conflictReq = new Request(
        "http://localhost:3000/api/admin/record-adsense-earning?action=conflicts",
        {
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      const conflictRes = await handleApiRequest(conflictReq);
      assert.ok(conflictRes);
      assert.equal(conflictRes.status, 200);
      const conflictData = await conflictRes.json();
      assert.equal(conflictData.success, true);
      assert.ok(Array.isArray(conflictData.conflicts));
    });

    it("blocks new statement recording when a creator/month has historical records flagged for review", async () => {
      // Simulate flagged historical conflict for FT483921 in 2026-03
      const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      if (!store.adsenseHistoricalConflicts) {
        store.adsenseHistoricalConflicts = {};
      }
      store.adsenseHistoricalConflicts["FT483921_2026-03"] = {
        id: "conf-test-01",
        transactionId: "TX_ADSENSE_HIST_CONFLICT_01",
        userId: "FT483921",
        reportMonth: "2026-03",
        amount: 300,
        status: "flagged_for_review",
      };
      fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");

      const req = new Request("http://localhost:3000/api/admin/record-adsense-earning", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          userId: "FT483921",
          amount: 500,
          reportMonth: "2026-03",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 409);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /flagged for manual review/i);

      // Clean up test conflict
      delete store.adsenseHistoricalConflicts["FT483921_2026-03"];
      fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
    });
  });
});
