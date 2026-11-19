import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApiRequest, resetInMemoryStore } from "./api-handler";
import { resetPersistentPremiumState, setTestPersistentDataDir } from "./payments";

describe("Phase 2F: Subscription Refund System Tests", () => {
  let testDataDir = "";
  const secret = "test_razorpay_secret_refund_123456";
  const keyId = "rzp_test_refund_key_123456";
  const testEnv = {
    RAZORPAY_KEY_ID: keyId,
    RAZORPAY_KEY_SECRET: secret,
    RAZORPAY_SKIP_REMOTE_CHECK: "true",
  };

  let standardUserToken = "";
  let otherUserToken = "";
  let adminToken = "";

  const standardUserId = "FT483921"; // Alex Rivera (regular user)
  const otherUserId = "FT900431"; // Maya Patel (regular user)
  const adminUserId = "FT102857"; // Sarah Jenkins (admin user)

  let userSubId = "";
  let otherUserSubId = "";
  let activePaymentId = "";
  let otherPaymentId = "";

  before(async () => {
    testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-sub-refund-test-"));
    setTestPersistentDataDir(testDataDir);
    resetInMemoryStore();

    // 1. Generate unique dynamic IDs for isolation
    const testRunId = Date.now();
    userSubId = `sub_user_test_refund_${testRunId}`;
    otherUserSubId = `sub_other_test_refund_${testRunId}`;
    activePaymentId = `pay_refund_test_${testRunId}_1`;
    otherPaymentId = `pay_refund_test_${testRunId}_2`;

    // 2. Clear store.subscriptionRefundRequests in isolated test store if present
    try {
      const storePath = path.join(testDataDir, "facetube_store.json");
      if (fs.existsSync(storePath)) {
        const storeData = JSON.parse(fs.readFileSync(storePath, "utf-8"));
        storeData.subscriptionRefundRequests = [];
        fs.writeFileSync(storePath, JSON.stringify(storeData, null, 2), "utf-8");
      }
    } catch (_e) {
      // ignore
    }

    // 3. Reset state with seeded subscriptions
    const now = Date.now();
    const userSub = {
      subscriptionId: userSubId,
      id: userSubId,
      userId: standardUserId,
      planId: "member-monthly",
      planName: "Creator Member",
      orderId: `order_refund_test_${testRunId}_1`,
      paymentId: activePaymentId,
      amount: 499,
      currency: "INR",
      status: "active",
      startsAt: new Date(now - 86400000).toISOString(),
      expiresAt: new Date(now + 29 * 86400000).toISOString(),
      durationDays: 30,
      createdAt: new Date(now - 86400000).toISOString(),
    };

    const otherSub = {
      subscriptionId: otherUserSubId,
      id: otherUserSubId,
      userId: otherUserId,
      planId: "member-vip-monthly",
      planName: "VIP Supporter",
      orderId: `order_refund_test_${testRunId}_2`,
      paymentId: otherPaymentId,
      amount: 999,
      currency: "INR",
      status: "active",
      startsAt: new Date(now - 86400000).toISOString(),
      expiresAt: new Date(now + 29 * 86400000).toISOString(),
      durationDays: 30,
      createdAt: new Date(now - 86400000).toISOString(),
    };

    await resetPersistentPremiumState(10, [], [userSub as any, otherSub as any], []);

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

    // 3. Authenticate other user (Maya Patel)
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

    // 4. Authenticate admin user (Sarah Jenkins)
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
  });

  describe("1. User Refund Authentication & Input Validation", () => {
    it("rejects unauthenticated POST to /api/subscriptions/refund-request with HTTP 401", async () => {
      const req = new Request("http://localhost:3000/api/subscriptions/refund-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subscriptionId: userSubId,
          reason: "Requesting a refund for test",
        }),
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /authentication required/i);
    });

    it("rejects unauthenticated GET to /api/subscriptions/refund-requests with HTTP 401", async () => {
      const req = new Request("http://localhost:3000/api/subscriptions/refund-requests", {
        method: "GET",
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /authentication required/i);
    });

    it("rejects refund request without subscriptionId with HTTP 400", async () => {
      const req = new Request("http://localhost:3000/api/subscriptions/refund-request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${standardUserToken}`,
        },
        body: JSON.stringify({
          reason: "Accidental renewal, please refund",
        }),
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /subscription id is required/i);
    });

    it("rejects refund request with reason shorter than 5 characters with HTTP 400", async () => {
      const req = new Request("http://localhost:3000/api/subscriptions/refund-request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${standardUserToken}`,
        },
        body: JSON.stringify({
          subscriptionId: userSubId,
          reason: "bad",
        }),
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /minimum 5 characters/i);
    });

    it("rejects refund request for nonexistent subscription with HTTP 404", async () => {
      const req = new Request("http://localhost:3000/api/subscriptions/refund-request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${standardUserToken}`,
        },
        body: JSON.stringify({
          subscriptionId: "sub_nonexistent_99999",
          reason: "I want to refund a subscription that does not exist",
        }),
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /not found/i);
    });
  });

  describe("2. User Ownership Enforcement", () => {
    it("rejects user A requesting refund for user B's subscription with HTTP 403", async () => {
      // Alex Rivera (standardUserToken) attempts to request refund for Maya Patel's subscription (otherSubId)
      const req = new Request("http://localhost:3000/api/subscriptions/refund-request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${standardUserToken}`,
        },
        body: JSON.stringify({
          subscriptionId: otherUserSubId,
          reason: "Attempting to refund another user's subscription without authorization",
        }),
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /only submit refund requests for your own subscriptions/i);
    });
  });

  let createdRequestId = "";

  describe("3. Successful Refund Request & Duplicate Protection", () => {
    it("allows user to submit a refund request for their own subscription with HTTP 201", async () => {
      const req = new Request("http://localhost:3000/api/subscriptions/refund-request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${standardUserToken}`,
        },
        body: JSON.stringify({
          subscriptionId: userSubId,
          reason:
            "Accidentally renewed my creator membership, please refund to original payment source.",
        }),
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.ok(data.request);
      assert.equal(data.request.subscriptionId, userSubId);
      assert.equal(data.request.userId, standardUserId);
      assert.equal(data.request.status, "pending");
      assert.equal(data.request.amount, 499);
      assert.equal(data.request.gatewayRefundId, null);
      // Critical check: Never mark refund as successful merely because request was submitted!
      assert.notEqual(data.request.status, "refunded");

      createdRequestId = data.request.id;
    });

    it("blocks duplicate refund request for the same subscription payment with HTTP 409", async () => {
      const req = new Request("http://localhost:3000/api/subscriptions/refund-request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${standardUserToken}`,
        },
        body: JSON.stringify({
          subscriptionId: userSubId,
          reason: "Second attempt to request refund for the same subscription.",
        }),
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 409);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /duplicate refund requests are not permitted/i);
    });

    it("retrieves user's refund history and does not leak requests from other users", async () => {
      // Alex Rivera retrieves their requests
      const userReq = new Request("http://localhost:3000/api/subscriptions/refund-requests", {
        method: "GET",
        headers: { Authorization: `Bearer ${standardUserToken}` },
      });
      const userRes = await handleApiRequest(userReq, testEnv);
      assert.ok(userRes);
      assert.equal(userRes.status, 200);
      const userData = await userRes.json();
      assert.equal(userData.success, true);
      assert.ok(Array.isArray(userData.requests));
      assert.equal(userData.requests.length, 1);
      assert.equal(userData.requests[0].id, createdRequestId);
      assert.equal(userData.requests[0].userId, standardUserId);

      // Maya Patel retrieves their requests (should be empty, no leaks)
      const otherReq = new Request("http://localhost:3000/api/subscriptions/refund-requests", {
        method: "GET",
        headers: { Authorization: `Bearer ${otherUserToken}` },
      });
      const otherRes = await handleApiRequest(otherReq, testEnv);
      assert.ok(otherRes);
      assert.equal(otherRes.status, 200);
      const otherData = await otherRes.json();
      assert.equal(otherData.success, true);
      assert.ok(Array.isArray(otherData.requests));
      assert.equal(otherData.requests.length, 0);
    });
  });

  describe("4. Admin Authorization & Refund Listing", () => {
    it("rejects non-admin user from accessing /api/admin/subscription-refunds with HTTP 403", async () => {
      const req = new Request("http://localhost:3000/api/admin/subscription-refunds", {
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

    it("allows admin user to list refund requests with stats, search, and pagination", async () => {
      const req = new Request(
        "http://localhost:3000/api/admin/subscription-refunds?status=pending&limit=10",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.ok(data.stats);
      assert.equal(data.stats.pending >= 1, true);
      assert.ok(data.pagination);
      assert.ok(Array.isArray(data.requests));
      const found = data.requests.find((r: any) => r.id === createdRequestId);
      assert.ok(found);
      assert.equal(found.status, "pending");
      assert.equal(found.userId, standardUserId);
    });

    it("allows admin user to fetch specific refund request by ID", async () => {
      const req = new Request(
        `http://localhost:3000/api/admin/subscription-refunds?id=${createdRequestId}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.ok(data.request);
      assert.equal(data.request.id, createdRequestId);
    });
  });

  describe("5. Admin Review Actions (Approve / Reject) & Gateway Parity", () => {
    it("rejects non-admin user from reviewing a refund request with HTTP 403", async () => {
      const req = new Request("http://localhost:3000/api/admin/subscription-refund-review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${standardUserToken}`,
        },
        body: JSON.stringify({
          requestId: createdRequestId,
          decision: "rejected",
          adminNote: "Unauthorized review attempt",
        }),
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /admin authorization required/i);
    });

    it("rejects review with invalid decision parameter with HTTP 400", async () => {
      const req = new Request("http://localhost:3000/api/admin/subscription-refund-review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          requestId: createdRequestId,
          decision: "maybe",
          adminNote: "Invalid decision",
        }),
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /must be either 'approved' or 'rejected'/i);
    });

    it("allows admin to reject a refund request and records audit fields", async () => {
      const req = new Request("http://localhost:3000/api/admin/subscription-refund-review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          requestId: createdRequestId,
          decision: "rejected",
          adminNote:
            "Rejected because member consumed subscriber perks during active billing cycle.",
        }),
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.ok(data.request);
      assert.equal(data.request.status, "rejected");
      assert.equal(data.request.reviewedBy, adminUserId);
      assert.equal(
        data.request.adminNote,
        "Rejected because member consumed subscriber perks during active billing cycle.",
      );
      assert.ok(data.request.reviewedAt);
    });

    it("blocks re-review of an already processed request with HTTP 400", async () => {
      const req = new Request("http://localhost:3000/api/admin/subscription-refund-review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          requestId: createdRequestId,
          decision: "approved",
          adminNote: "Attempting to re-review rejected request",
        }),
      });
      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /cannot re-review/i);
    });

    it("safely records approval without marking refunded when gateway is unconfigured or skipped", async () => {
      // 1. Submit a refund request for Maya Patel's subscription
      const subReq = new Request("http://localhost:3000/api/subscriptions/refund-request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${otherUserToken}`,
        },
        body: JSON.stringify({
          subscriptionId: otherUserSubId,
          reason: "Requesting a refund for VIP supporter plan within 24h.",
        }),
      });
      const subRes = await handleApiRequest(subReq, testEnv);
      assert.ok(subRes);
      assert.equal(subRes.status, 201);
      const subData = await subRes.json();
      const secondRequestId = subData.request.id;

      // 2. Admin approves with RAZORPAY_SKIP_REMOTE_CHECK: "true"
      const reviewReq = new Request("http://localhost:3000/api/admin/subscription-refund-review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          requestId: secondRequestId,
          decision: "approved",
          adminNote: "Approved per SLA. Gateway refund skipped in test environment.",
        }),
      });
      const reviewRes = await handleApiRequest(reviewReq, testEnv);
      assert.ok(reviewRes);
      assert.equal(reviewRes.status, 200);
      const reviewData = await reviewRes.json();
      assert.equal(reviewData.success, true);
      assert.ok(reviewData.request);
      assert.equal(reviewData.request.status, "approved");
      assert.equal(reviewData.request.gatewayStatus, "gateway_unavailable");
      assert.equal(reviewData.request.gatewayRefundId, null);
      // Subscription remains active until confirmed gateway settlement!
      assert.notEqual(reviewData.request.status, "refunded");
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
