import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApiRequest, resetInMemoryStore } from "./api-handler";
import {
  createServerPaymentOrder,
  verifyServerPayment,
  resetPersistentPremiumState,
  setTestPersistentDataDir,
  PRICING_CONFIG,
} from "./payments";
import { api } from "../lib/api";

describe("Task 2 - Phase 2B: Paid Subscription Payment Verification & Activation Tests", () => {
  let testDataDir = "";
  const secret = "test_razorpay_secret_key_sub_987654321";
  const keyId = "rzp_test_sub_key_123456789";
  const testEnv = {
    RAZORPAY_KEY_ID: keyId,
    RAZORPAY_KEY_SECRET: secret,
    RAZORPAY_SKIP_REMOTE_CHECK: "true",
  };

  let userToken = "";
  let otherUserToken = "";
  const standardUserId = "FT483921"; // alex@facetube.com
  const otherUserId = "FT900431"; // maya@facetube.com

  before(async () => {
    testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-sub-checkout-test-"));
    setTestPersistentDataDir(testDataDir);
    resetInMemoryStore();

    // Clean persistent state for test isolation
    await resetPersistentPremiumState(10, [], []);

    // 1. Authenticate standard user (FT483921)
    const userLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
    });
    const userLoginRes = await handleApiRequest(userLoginReq);
    assert.ok(userLoginRes);
    const userData = await userLoginRes.json();
    assert.ok(userData.token);
    userToken = userData.token;

    // 2. Authenticate second user (FT900431)
    const otherLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "maya@facetube.com", password: "password123" }),
    });
    const otherLoginRes = await handleApiRequest(otherLoginReq);
    assert.ok(otherLoginRes);
    const otherData = await otherLoginRes.json();
    assert.ok(otherData.token);
    otherUserToken = otherData.token;
  });

  // Suite 1: Signature Security & Fail-Closed Behavior
  describe("1. Razorpay Signature Verification & Fail-Closed Guard", () => {
    it("fails closed when RAZORPAY_KEY_SECRET is missing", async () => {
      const orderId = "order_sub_test_secret_missing";
      const paymentId = "pay_sub_test_secret_missing";
      const sig = crypto
        .createHmac("sha256", secret)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

      const res = await verifyServerPayment(
        {
          orderId,
          paymentId,
          signature: sig,
          userId: standardUserId,
          purpose: "paid_subscription",
          planId: "member-monthly",
        },
        [],
        null,
        { RAZORPAY_KEY_SECRET: "" }, // Explicitly empty secret
      );

      assert.equal(res.verified, false);
      assert.match(res.error || "", /missing|not configured|failed closed/i);
    });

    it("rejects invalid or tampered HMAC signature", async () => {
      const orderId = "order_sub_test_tampered";
      const paymentId = "pay_sub_test_tampered";

      const res = await verifyServerPayment(
        {
          orderId,
          paymentId,
          signature: "tampered_fake_signature_hash_1234567890abcdef",
          userId: standardUserId,
          purpose: "paid_subscription",
          planId: "member-monthly",
        },
        [],
        null,
        testEnv,
      );

      assert.equal(res.verified, false);
      assert.match(res.error || "", /invalid.*signature/i);
    });

    it("rejects mock signatures and bypass tokens", async () => {
      const orderId = "order_sub_test_mock_sig";
      const paymentId = "pay_sub_test_mock_sig";

      const res = await verifyServerPayment(
        {
          orderId,
          paymentId,
          signature: "mock_signature_bypass",
          userId: standardUserId,
          purpose: "paid_subscription",
          planId: "member-monthly",
        },
        [],
        null,
        testEnv,
      );

      assert.equal(res.verified, false);
      assert.match(res.error || "", /mock.*rejected|signature missing/i);
    });
  });

  // Suite 2: Plan Price Resolution & Amount Mismatch Protection
  describe("2. Authoritative Plan Price Resolution & Mismatch Protection", () => {
    it("creates server order with authoritative price for member-monthly (₹49)", async () => {
      const order = await createServerPaymentOrder(
        {
          purpose: "paid_subscription",
          userId: standardUserId,
          planId: "member-monthly",
        },
        testEnv,
      );

      assert.ok(order.orderId);
      assert.equal(order.amount, 49.0);
      assert.equal(order.amountInSubunits, 4900);
      assert.equal(order.currency, "INR");
      assert.equal(order.purpose, "paid_subscription");
    });

    it("creates server order with authoritative price for member-annual (₹999)", async () => {
      const order = await createServerPaymentOrder(
        {
          purpose: "paid_subscription",
          userId: standardUserId,
          planId: "member-annual",
        },
        testEnv,
      );

      assert.ok(order.orderId);
      assert.equal(order.amount, 999.0);
      assert.equal(order.amountInSubunits, 99900);
    });

    it("rejects payment verification when requested amount does not match plan price", async () => {
      const orderId = `order_sub_mismatch_${Date.now()}`;
      const paymentId = `pay_sub_mismatch_${Date.now()}`;
      const signature = crypto
        .createHmac("sha256", secret)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

      const req = new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          orderId,
          paymentId,
          signature,
          userId: standardUserId,
          purpose: "paid_subscription",
          planId: "member-monthly", // Expected ₹49.00
          amount: 1.0, // Tampered client amount: ₹1.00
        }),
      });

      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 400);

      const data = await res.json();
      assert.equal(data.verified, false);
      assert.match(data.error || "", /does not match expected fee/i);
    });
  });

  // Suite 3: User Ownership & Authorization Guards
  describe("3. User Ownership & Order Authorization", () => {
    it("rejects verification when order was created for another user", async () => {
      // 1. Create order for standard user (FT483921)
      const createReq = new Request("http://localhost:3000/api/payments/create-order", {
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
      const createRes = await handleApiRequest(createReq, testEnv);
      assert.ok(createRes);
      const orderData = await createRes.json();
      assert.ok(orderData.orderId);

      // 2. Maya (otherUserToken) attempts to verify Alex's order
      const paymentId = `pay_steal_${Date.now()}`;
      const signature = crypto
        .createHmac("sha256", secret)
        .update(`${orderData.orderId}|${paymentId}`)
        .digest("hex");

      const verifyReq = new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${otherUserToken}`, // Maya's token
        },
        body: JSON.stringify({
          orderId: orderData.orderId,
          paymentId,
          signature,
          userId: otherUserId, // Maya trying to verify Alex's order
          purpose: "paid_subscription",
          planId: "member-monthly",
        }),
      });

      const verifyRes = await handleApiRequest(verifyReq, testEnv);
      assert.ok(verifyRes);
      assert.equal(verifyRes.status, 403);

      const verifyData = await verifyRes.json();
      assert.equal(verifyData.verified, false);
      assert.match(verifyData.error || "", /unauthorized.*belong/i);
    });
  });

  // Suite 4: Successful Activation, Expiry Calculation & Strict Financial Rules
  describe("4. Subscription Activation, Expiry Calculation & Strict Financial Rules", () => {
    let orderId = "";
    let paymentId = "";
    let signature = "";

    before(async () => {
      orderId = `order_sub_success_${Date.now()}`;
      paymentId = `pay_sub_success_${Date.now()}`;
      signature = crypto
        .createHmac("sha256", secret)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");
    });

    it("successfully verifies payment and activates 30-day subscription for member-monthly", async () => {
      const res = await verifyServerPayment(
        {
          orderId,
          paymentId,
          signature,
          userId: standardUserId,
          userName: "Alex Rivera",
          purpose: "paid_subscription",
          planId: "member-monthly",
        },
        [],
        null,
        testEnv,
      );

      assert.equal(res.verified, true);
      assert.equal(res.amount, 49.0);
      assert.equal(res.purpose, "paid_subscription");
      assert.equal(res.specialTag, "PAID_SUBSCRIPTION");
      assert.equal(res.txNumber, 0); // Premium video sequence counter must NOT increment!

      // Verify subscription record structure
      assert.ok(res.subscription, "Must return active subscription record");
      assert.ok(
        res.subscription.subscriptionId.startsWith("sub_"),
        "subscriptionId must have sub_ prefix",
      );
      assert.equal(res.subscription.userId, standardUserId);
      assert.equal(res.subscription.planId, "member-monthly");
      assert.equal(res.subscription.orderId, orderId);
      assert.equal(res.subscription.paymentId, paymentId);
      assert.equal(res.subscription.amount, 49.0);
      assert.equal(res.subscription.currency, "INR");
      assert.equal(res.subscription.status, "active");
      assert.equal(res.subscription.durationDays, 30);

      // Verify expiry calculation (30 days in future)
      const startsTime = new Date(res.subscription.startsAt).getTime();
      const expiresTime = new Date(res.subscription.expiresAt).getTime();
      const diffDays = Math.round((expiresTime - startsTime) / (1000 * 60 * 60 * 24));
      assert.equal(diffDays, 30, "Expiry must be 30 days from start date");
    });

    it("strictly preserves financial rules: zero referral commission, zero admin allocation, zero pool allocation", async () => {
      const testOrderId = `order_sub_fin_${Date.now()}`;
      const testPaymentId = `pay_sub_fin_${Date.now()}`;
      const testSig = crypto
        .createHmac("sha256", secret)
        .update(`${testOrderId}|${testPaymentId}`)
        .digest("hex");

      const res = await verifyServerPayment(
        {
          orderId: testOrderId,
          paymentId: testPaymentId,
          signature: testSig,
          userId: standardUserId,
          purpose: "paid_subscription",
          planId: "member-monthly",
          referrerUserId: "FT102857", // Even if referrer passed, subscriptions grant NO commission!
        },
        [{ userId: "FT900431", adEarnings: 100 }],
        "FT102857",
        testEnv,
      );

      assert.equal(res.verified, true);
      // Confirm NO distribution object granting payouts or commissions
      assert.equal(
        res.distribution,
        undefined,
        "Subscription must NOT distribute revenue to referral or pool",
      );
    });

    it("accurately calculates 365-day expiry for annual plan (member-annual)", async () => {
      const annualOrderId = `order_sub_ann_${Date.now()}`;
      const annualPayId = `pay_sub_ann_${Date.now()}`;
      const annualSig = crypto
        .createHmac("sha256", secret)
        .update(`${annualOrderId}|${annualPayId}`)
        .digest("hex");

      const res = await verifyServerPayment(
        {
          orderId: annualOrderId,
          paymentId: annualPayId,
          signature: annualSig,
          userId: standardUserId,
          purpose: "paid_subscription",
          planId: "member-annual",
        },
        [],
        null,
        testEnv,
      );

      assert.equal(res.verified, true);
      assert.equal(res.amount, 999.0);
      assert.ok(res.subscription);
      assert.equal(res.subscription.durationDays, 365);

      const startsTime = new Date(res.subscription.startsAt).getTime();
      const expiresTime = new Date(res.subscription.expiresAt).getTime();
      const diffDays = Math.round((expiresTime - startsTime) / (1000 * 60 * 60 * 24));
      assert.equal(diffDays, 365, "Expiry must be 365 days from start date for annual tier");
    });
  });

  // Suite 5: Idempotency & Duplicate Verification Protection
  describe("5. Idempotent Duplicate Verification Guard", () => {
    it("returns duplicate: true on repeated verification and preserves original subscription", async () => {
      const orderId = `order_sub_dup_${Date.now()}`;
      const paymentId = `pay_sub_dup_${Date.now()}`;
      const signature = crypto
        .createHmac("sha256", secret)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

      // First verification call
      const res1 = await verifyServerPayment(
        {
          orderId,
          paymentId,
          signature,
          userId: standardUserId,
          purpose: "paid_subscription",
          planId: "member-monthly",
        },
        [],
        null,
        testEnv,
      );
      assert.equal(res1.verified, true);
      assert.equal(res1.duplicate, undefined);
      assert.ok(res1.subscription);
      const originalSubId = res1.subscription.subscriptionId;

      // Second identical verification call (replay attack or network duplicate)
      const res2 = await verifyServerPayment(
        {
          orderId,
          paymentId,
          signature,
          userId: standardUserId,
          purpose: "paid_subscription",
          planId: "member-monthly",
        },
        [],
        null,
        testEnv,
      );

      assert.equal(res2.verified, true);
      assert.equal(res2.duplicate, true, "Must flag as duplicate");
      assert.match(res2.error || "", /already been processed|idempotent/i);
      assert.ok(res2.subscription);
      assert.equal(
        res2.subscription.subscriptionId,
        originalSubId,
        "Duplicate verification must return identical original subscription ID without creating a new one",
      );
    });
  });

  // Suite 6: Full API Endpoint Integration & Active Subscription Retrieval
  describe("6. Full API Integration & Active Subscription Query", () => {
    it("verifies subscription via POST /api/payments/verify and retrieves active status via GET /api/subscriptions/active", async () => {
      // 1. Create order via API
      const createReq = new Request("http://localhost:3000/api/payments/create-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          purpose: "paid_subscription",
          userId: standardUserId,
          planId: "member-vip-monthly",
        }),
      });
      const createRes = await handleApiRequest(createReq, testEnv);
      assert.ok(createRes);
      assert.equal(createRes.status, 200);
      const order = await createRes.json();
      assert.ok(order.orderId);
      assert.equal(order.amount, 149.0);

      // 2. Verify payment via API
      const payId = `pay_api_sub_${Date.now()}`;
      const sig = crypto
        .createHmac("sha256", secret)
        .update(`${order.orderId}|${payId}`)
        .digest("hex");

      const verifyReq = new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          orderId: order.orderId,
          paymentId: payId,
          signature: sig,
          userId: standardUserId,
          purpose: "paid_subscription",
          planId: "member-vip-monthly",
        }),
      });

      const verifyRes = await handleApiRequest(verifyReq, testEnv);
      assert.ok(verifyRes);
      assert.equal(verifyRes.status, 200);
      const verifyData = await verifyRes.json();
      assert.equal(verifyData.verified, true);
      assert.ok(verifyData.subscription);
      assert.equal(verifyData.subscription.planId, "member-vip-monthly");
      assert.equal(verifyData.subscription.amount, 149.0);

      // 3. Query active subscription via GET /api/subscriptions/active
      const activeReq = new Request("http://localhost:3000/api/subscriptions/active", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });
      const activeRes = await handleApiRequest(activeReq, testEnv);
      assert.ok(activeRes);
      assert.equal(activeRes.status, 200);

      const activeData = await activeRes.json();
      assert.equal(activeData.success, true);
      assert.equal(activeData.hasActiveSubscription, true);
      assert.ok(activeData.subscription);
      assert.equal(activeData.subscription.userId, standardUserId);
      assert.equal(activeData.subscription.planId, "member-vip-monthly");
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
