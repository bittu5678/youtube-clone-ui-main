import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApiRequest, resetInMemoryStore } from "./api-handler";
import { resetPersistentPremiumState, setTestPersistentDataDir } from "./payments";

describe("Task 2 - Phase 2E: Admin Subscription Management Tests", () => {
  let testDataDir = "";
  const secret = "test_razorpay_secret_admin_sub_123456";
  const keyId = "rzp_test_admin_sub_key_123456";
  const testEnv = {
    RAZORPAY_KEY_ID: keyId,
    RAZORPAY_KEY_SECRET: secret,
    RAZORPAY_SKIP_REMOTE_CHECK: "true",
  };

  let adminToken = "";
  let standardUserToken = "";
  const standardUserId = "FT483921"; // Alex Rivera (regular user)
  const adminUserId = "FT102857"; // Sarah Jenkins (admin)

  // Seeded subscription IDs for inspection
  let activeSubId = "";
  let expiredSubId = "";

  before(async () => {
    testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-admin-sub-test-"));
    setTestPersistentDataDir(testDataDir);
    resetInMemoryStore();

    // 1. Reset state
    await resetPersistentPremiumState(10, [], []);

    // 2. Authenticate standard user (Alex Rivera)
    const userLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
    });
    const userLoginRes = await handleApiRequest(userLoginReq);
    assert.ok(userLoginRes);
    const userLoginData = await userLoginRes.json();
    assert.ok(userLoginData.token);
    standardUserToken = userLoginData.token;

    // 3. Authenticate admin user (Sarah Jenkins)
    const adminLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "admin@facetube.com", password: "password" }),
    });
    const adminLoginRes = await handleApiRequest(adminLoginReq);
    assert.ok(adminLoginRes);
    const adminLoginData = await adminLoginRes.json();
    assert.ok(adminLoginData.token);
    adminToken = adminLoginData.token;

    // 4. Seed an active subscription and an expired subscription
    const now = Date.now();
    activeSubId = "sub_active_test_admin_001";
    expiredSubId = "sub_expired_test_admin_002";

    const activeSub = {
      subscriptionId: activeSubId,
      id: activeSubId,
      userId: standardUserId,
      planId: "member-vip-monthly",
      planName: "VIP Monthly Supporter",
      orderId: "order_test_active_123",
      paymentId: "pay_test_active_123",
      amount: 149.0,
      currency: "INR",
      status: "active" as const,
      startsAt: new Date(now - 86400000).toISOString(),
      expiresAt: new Date(now + 29 * 86400000).toISOString(),
      durationDays: 30,
      createdAt: new Date(now - 86400000).toISOString(),
    };

    const expiredSub = {
      subscriptionId: expiredSubId,
      id: expiredSubId,
      userId: standardUserId,
      planId: "member-monthly",
      planName: "Monthly Supporter",
      orderId: "order_test_expired_456",
      paymentId: "pay_test_expired_456",
      amount: 49.0,
      currency: "INR",
      status: "expired" as const,
      startsAt: new Date(now - 60 * 86400000).toISOString(),
      expiresAt: new Date(now - 30 * 86400000).toISOString(),
      durationDays: 30,
      createdAt: new Date(now - 60 * 86400000).toISOString(),
    };

    await resetPersistentPremiumState(10, [], [activeSub, expiredSub]);
  });

  // Suite 1: Authorization & Security
  describe("1. Admin Authorization & Security Enforcement", () => {
    it("rejects unauthenticated requests to /api/admin/subscriptions with HTTP 401", async () => {
      const req = new Request("http://localhost:3000/api/admin/subscriptions", {
        method: "GET",
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /authentication required/i);
    });

    it("rejects non-admin (standard user) requests with HTTP 403 Forbidden", async () => {
      const req = new Request("http://localhost:3000/api/admin/subscriptions", {
        method: "GET",
        headers: { Authorization: `Bearer ${standardUserToken}` },
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /admin authorization required/i);
    });

    it("rejects non-GET HTTP methods with HTTP 405 Method Not Allowed", async () => {
      for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        const req = new Request("http://localhost:3000/api/admin/subscriptions", {
          method,
          headers: { Authorization: `Bearer ${adminToken}` },
        });
        const res = await handleApiRequest(req, testEnv);
        assert.ok(res);
        assert.equal(res.status, 405);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.match(data.error, /method not allowed/i);
      }
    });

    it("allows authenticated admin to access /api/admin/subscriptions", async () => {
      const req = new Request("http://localhost:3000/api/admin/subscriptions", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.ok(Array.isArray(data.subscriptions));
    });
  });

  // Suite 2: Statistics Aggregation
  describe("2. Statistics Metrics Aggregation", () => {
    it("returns total, active, expired, and totalRevenue stats for admin", async () => {
      const req = new Request("http://localhost:3000/api/admin/subscriptions", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.ok(data.stats);
      assert.equal(typeof data.stats.total, "number");
      assert.equal(typeof data.stats.active, "number");
      assert.equal(typeof data.stats.expired, "number");
      assert.equal(typeof data.stats.totalRevenue, "number");

      assert.ok(data.stats.total >= 2);
      assert.ok(data.stats.active >= 1);
      assert.ok(data.stats.expired >= 1);
      assert.equal(data.stats.total, data.stats.active + data.stats.expired);
      assert.ok(data.stats.totalRevenue > 0);
    });
  });

  // Suite 3: Status Filtering
  describe("3. Status Filtering (all, active, expired)", () => {
    it("filters subscriptions by status=active", async () => {
      const req = new Request("http://localhost:3000/api/admin/subscriptions?status=active", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.ok(data.subscriptions.length >= 1);
      for (const sub of data.subscriptions) {
        assert.equal(sub.status, "active");
        assert.ok(sub.remainingDays === null || sub.remainingDays >= 0);
      }
    });

    it("filters subscriptions by status=expired", async () => {
      const req = new Request("http://localhost:3000/api/admin/subscriptions?status=expired", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.ok(data.subscriptions.length >= 1);
      for (const sub of data.subscriptions) {
        assert.equal(sub.status, "expired");
      }
    });

    it("returns both active and expired when status=all", async () => {
      const req = new Request("http://localhost:3000/api/admin/subscriptions?status=all", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.ok(data.subscriptions.length >= 2);
      const statuses = new Set(data.subscriptions.map((s: any) => s.status));
      assert.ok(statuses.has("active"));
      assert.ok(statuses.has("expired"));
    });
  });

  // Suite 4: Search Functionality
  describe("4. Search Filtering (User ID, Name, Plan, IDs)", () => {
    it("finds subscriptions matching user ID or name", async () => {
      const req = new Request(
        `http://localhost:3000/api/admin/subscriptions?search=${standardUserId}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.ok(data.subscriptions.length >= 1);
      assert.equal(data.subscriptions[0].userId, standardUserId);
    });

    it("finds subscriptions matching plan tier name", async () => {
      const req = new Request("http://localhost:3000/api/admin/subscriptions?search=VIP", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.ok(data.subscriptions.length >= 1);
      assert.ok(data.subscriptions.some((s: any) => s.planName.includes("VIP")));
    });

    it("returns empty subscriptions list for unmatched search query", async () => {
      const req = new Request(
        "http://localhost:3000/api/admin/subscriptions?search=nonexistent_query_xyz999",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.subscriptions.length, 0);
      assert.equal(data.pagination.totalItems, 0);
    });
  });

  // Suite 5: Pagination Controls
  describe("5. Pagination (page, limit, totalPages)", () => {
    it("respects limit=1 and calculates totalPages correctly", async () => {
      const req = new Request("http://localhost:3000/api/admin/subscriptions?page=1&limit=1", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.subscriptions.length, 1);
      assert.equal(data.pagination.page, 1);
      assert.equal(data.pagination.limit, 1);
      assert.ok(data.pagination.totalPages >= 2);
    });

    it("fetches page 2 with subsequent records", async () => {
      const req = new Request("http://localhost:3000/api/admin/subscriptions?page=2&limit=1", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.subscriptions.length, 1);
      assert.equal(data.pagination.page, 2);
    });
  });

  // Suite 6: Subscription Detail View
  describe("6. Detailed Single Subscription Inspection (?id=...)", () => {
    it("returns full details for a valid subscription ID", async () => {
      assert.ok(activeSubId);
      const req = new Request(`http://localhost:3000/api/admin/subscriptions?id=${activeSubId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.success, true);
      assert.ok(data.subscription);
      assert.equal(data.subscription.id, activeSubId);
      assert.equal(data.subscription.userId, standardUserId);
      assert.ok(data.subscription.planName);
      assert.ok(data.subscription.amount);
      assert.ok(data.subscription.paymentId);
      assert.ok(data.subscription.orderId);
      assert.ok(data.subscription.startsAt);
      assert.ok(data.subscription.expiresAt);
      assert.equal(data.subscription.status, "active");
    });

    it("returns HTTP 404 when requested subscription ID does not exist", async () => {
      const req = new Request(
        "http://localhost:3000/api/admin/subscriptions?id=sub_nonexistent_xyz_999",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 404);
      const data = await res.json();

      assert.equal(data.success, false);
      assert.match(data.error, /subscription (record )?not found/i);
    });
  });

  after(() => {
    setTestPersistentDataDir(null);
    resetInMemoryStore();
    if (testDataDir) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
      testDataDir = "";
    }
  });
});
