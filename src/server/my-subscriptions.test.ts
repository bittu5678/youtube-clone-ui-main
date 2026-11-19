import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApiRequest, resetInMemoryStore } from "./api-handler";
import { resetPersistentPremiumState, setTestPersistentDataDir } from "./payments";

describe("Task 2 - Phase 2D: My Subscriptions & Payment History Tests", () => {
  let testDataDir = "";
  const secret = "test_razorpay_secret_my_sub_123456";
  const keyId = "rzp_test_my_sub_key_123456";
  const testEnv = {
    RAZORPAY_KEY_ID: keyId,
    RAZORPAY_KEY_SECRET: secret,
    RAZORPAY_SKIP_REMOTE_CHECK: "true",
  };

  let userToken = "";
  let otherUserToken = "";
  const standardUserId = "FT483921"; // Alex Rivera
  const otherUserId = "FT900431"; // Maya Patel

  before(async () => {
    testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-my-sub-test-"));
    setTestPersistentDataDir(testDataDir);
    resetInMemoryStore();

    // 1. Reset state
    await resetPersistentPremiumState(10, [], []);

    // 2. Authenticate standard user (Alex Rivera)
    const loginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
    });
    const loginRes = await handleApiRequest(loginReq);
    assert.ok(loginRes);
    const loginData = await loginRes.json();
    assert.ok(loginData.token);
    userToken = loginData.token;

    // 3. Authenticate second user (Maya Patel)
    const otherLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "maya@facetube.com", password: "password123" }),
    });
    const otherLoginRes = await handleApiRequest(otherLoginReq);
    assert.ok(otherLoginRes);
    const otherLoginData = await otherLoginRes.json();
    assert.ok(otherLoginData.token);
    otherUserToken = otherLoginData.token;
  });

  // Suite 1: Authentication & HTTP Method Verification
  describe("1. Authentication & HTTP Method Verification (/api/subscriptions/my)", () => {
    it("rejects unauthenticated requests to /api/subscriptions/my with HTTP 401", async () => {
      const req = new Request("http://localhost:3000/api/subscriptions/my", {
        method: "GET",
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /authentication required/i);
    });

    it("rejects unauthenticated requests to /api/subscriptions/active with HTTP 401", async () => {
      const req = new Request("http://localhost:3000/api/subscriptions/active", {
        method: "GET",
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /authentication required/i);
    });

    it("rejects non-GET HTTP methods with HTTP 405 Method Not Allowed", async () => {
      for (const method of ["POST", "PUT", "DELETE"]) {
        const req = new Request("http://localhost:3000/api/subscriptions/my", {
          method,
          headers: { Authorization: `Bearer ${userToken}` },
        });
        const res = await handleApiRequest(req, testEnv);
        assert.ok(res);
        assert.equal(res.status, 405);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.match(data.error, /method not allowed/i);
      }
    });
  });

  // Suite 2: Empty State
  describe("2. Empty State Handling", () => {
    it("returns hasActiveSubscription: false, null subscription, and empty history for new user", async () => {
      await resetPersistentPremiumState(10, [], []);

      const req = new Request("http://localhost:3000/api/subscriptions/my", {
        method: "GET",
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.hasActiveSubscription, false);
      assert.equal(data.subscription, null);
      assert.equal(data.activeSubscription, null);
      assert.ok(Array.isArray(data.history));
      assert.equal(data.history.length, 0);
      assert.ok(Array.isArray(data.subscriptions));
      assert.equal(data.subscriptions.length, 0);
    });
  });

  // Suite 3: User Ownership Enforcement
  describe("3. Strict User Ownership Enforcement", () => {
    it("never returns another user's subscriptions even when queried with spoofed user_id parameter", async () => {
      const now = Date.now();
      // Setup subscription for user B (John Doe)
      const subUserB = {
        subscriptionId: "sub_b_111",
        userId: otherUserId,
        planId: "member-vip-monthly",
        orderId: "order_b_111",
        paymentId: "pay_b_111",
        amount: 149.0,
        currency: "INR",
        status: "active" as const,
        startsAt: new Date(now - 86400000).toISOString(),
        expiresAt: new Date(now + 29 * 86400000).toISOString(),
        durationDays: 30,
      };

      await resetPersistentPremiumState(10, [], [subUserB]);

      // Standard user A attempts to query spoofed user_id in query string
      const spoofReq = new Request(
        `http://localhost:3000/api/subscriptions/my?user_id=${otherUserId}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${userToken}` }, // Session is user A
        },
      );
      const res = await handleApiRequest(spoofReq, testEnv);
      assert.ok(res);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.success, true);
      // User A must NOT see User B's active subscription
      assert.equal(data.hasActiveSubscription, false);
      assert.equal(data.subscription, null);
      assert.equal(data.subscriptions.length, 0);

      // Meanwhile, User B querying their own endpoint sees their active subscription
      const userBReq = new Request("http://localhost:3000/api/subscriptions/my", {
        method: "GET",
        headers: { Authorization: `Bearer ${otherUserToken}` },
      });
      const userBRes = await handleApiRequest(userBReq, testEnv);
      assert.ok(userBRes);
      assert.equal(userBRes.status, 200);
      const userBData = await userBRes.json();
      assert.equal(userBData.success, true);
      assert.equal(userBData.hasActiveSubscription, true);
      assert.equal(userBData.subscription.userId, otherUserId);
      assert.equal(userBData.subscription.planId, "member-vip-monthly");
    });
  });

  // Suite 4: Active Subscription Details & Remaining Days
  describe("4. Active Subscription Attributes & Remaining Days Calculation", () => {
    it("returns active subscription with resolved plan name, remaining days, and valid payment info", async () => {
      const now = Date.now();
      const activeSub = {
        subscriptionId: "sub_alex_active_123",
        userId: standardUserId,
        planId: "member-vip-monthly",
        orderId: "order_alex_act_456",
        paymentId: "pay_alex_act_789",
        amount: 149.0,
        currency: "INR",
        status: "active" as const,
        startsAt: new Date(now - 2 * 86400000).toISOString(),
        expiresAt: new Date(now + 28 * 86400000).toISOString(),
        durationDays: 30,
      };

      await resetPersistentPremiumState(10, [], [activeSub]);

      const req = new Request("http://localhost:3000/api/subscriptions/my", {
        method: "GET",
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.hasActiveSubscription, true);
      assert.ok(data.subscription);

      const sub = data.subscription;
      assert.equal(sub.subscriptionId, "sub_alex_active_123");
      assert.equal(sub.userId, standardUserId);
      assert.equal(sub.planId, "member-vip-monthly");
      assert.equal(sub.planName, "VIP Supporter");
      assert.equal(sub.amount, 149.0);
      assert.equal(sub.currency, "INR");
      assert.equal(sub.status, "active");
      assert.equal(sub.isExpired, false);
      assert.ok(sub.remainingDays >= 27 && sub.remainingDays <= 29);
      assert.equal(sub.paymentId, "pay_alex_act_789");
      assert.equal(sub.orderId, "order_alex_act_456");
      assert.ok(sub.startsAt);
      assert.ok(sub.expiresAt);
    });
  });

  // Suite 5: Expired Subscriptions History Separation
  describe("5. Separate Previous/Expired Subscriptions History", () => {
    it("correctly separates active subscription and past expired subscriptions in history", async () => {
      const now = Date.now();
      // 1 expired sub from last month
      const pastExpiredSub = {
        subscriptionId: "sub_alex_past_001",
        userId: standardUserId,
        planId: "member-monthly",
        orderId: "order_alex_past_001",
        paymentId: "pay_alex_past_001",
        amount: 49.0,
        currency: "INR",
        status: "active" as const,
        startsAt: new Date(now - 60 * 86400000).toISOString(),
        expiresAt: new Date(now - 30 * 86400000).toISOString(), // Expired 30 days ago
        durationDays: 30,
      };

      // 1 current active sub
      const currentActiveSub = {
        subscriptionId: "sub_alex_curr_002",
        userId: standardUserId,
        planId: "member-annual",
        orderId: "order_alex_curr_002",
        paymentId: "pay_alex_curr_002",
        amount: 999.0,
        currency: "INR",
        status: "active" as const,
        startsAt: new Date(now - 5 * 86400000).toISOString(),
        expiresAt: new Date(now + 360 * 86400000).toISOString(), // Valid for 360 more days
        durationDays: 365,
      };

      await resetPersistentPremiumState(10, [], [currentActiveSub, pastExpiredSub]);

      const req = new Request("http://localhost:3000/api/subscriptions/my", {
        method: "GET",
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.hasActiveSubscription, true);

      // Active subscription check
      assert.equal(data.subscription.subscriptionId, "sub_alex_curr_002");
      assert.equal(data.subscription.planName, "All-Access Annual");
      assert.equal(data.subscription.isExpired, false);
      assert.ok(data.subscription.remainingDays > 300);

      // History check
      assert.ok(Array.isArray(data.history));
      assert.equal(data.history.length, 1);
      const histItem = data.history[0];
      assert.equal(histItem.subscriptionId, "sub_alex_past_001");
      assert.equal(histItem.planId, "member-monthly");
      assert.equal(histItem.planName, "Creator Member");
      assert.equal(histItem.amount, 49.0);
      assert.equal(histItem.isExpired, true);
      assert.equal(histItem.remainingDays, 0);
      assert.equal(histItem.status, "expired");
      assert.equal(histItem.paymentId, "pay_alex_past_001");
    });
  });

  // Suite 6: End-to-End Integration Flow (Order -> Verify -> /my reflection)
  describe("6. End-to-End Payment Verification to /my Endpoint Reflection", () => {
    it("activates subscription via payment verification and confirms immediate reflection in /api/subscriptions/my", async () => {
      await resetPersistentPremiumState(10, [], []);

      // 1. Create order
      const orderReq = new Request("http://localhost:3000/api/payments/create-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          purpose: "paid_subscription",
          userId: standardUserId,
          planId: "member-monthly",
        }),
      });
      const orderRes = await handleApiRequest(orderReq, testEnv);
      assert.ok(orderRes);
      assert.equal(orderRes.status, 200);
      const orderData = await orderRes.json();
      assert.ok(orderData.orderId);

      // 2. Verify payment
      const paymentId = `pay_sub_e2e_${Date.now()}`;
      const crypto = await import("node:crypto");
      const signature = crypto
        .createHmac("sha256", secret)
        .update(`${orderData.orderId}|${paymentId}`)
        .digest("hex");

      const verifyReq = new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          orderId: orderData.orderId,
          paymentId,
          signature,
          userId: standardUserId,
          purpose: "paid_subscription",
          planId: "member-monthly",
        }),
      });
      const verifyRes = await handleApiRequest(verifyReq, testEnv);
      assert.ok(verifyRes);
      assert.equal(verifyRes.status, 200);
      const verifyData = await verifyRes.json();
      assert.equal(verifyData.verified, true);
      assert.ok(verifyData.subscription);

      // 3. Query /api/subscriptions/my and assert active membership
      const myReq = new Request("http://localhost:3000/api/subscriptions/my", {
        method: "GET",
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const myRes = await handleApiRequest(myReq, testEnv);
      assert.ok(myRes);
      assert.equal(myRes.status, 200);
      const myData = await myRes.json();

      assert.equal(myData.success, true);
      assert.equal(myData.hasActiveSubscription, true);
      assert.ok(myData.subscription);
      assert.equal(myData.subscription.paymentId, paymentId);
      assert.equal(myData.subscription.planId, "member-monthly");
      assert.equal(myData.subscription.planName, "Creator Member");
      assert.equal(myData.subscription.amount, 49.0);
      assert.equal(myData.subscription.isExpired, false);
      assert.ok(myData.subscription.remainingDays >= 29);
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
