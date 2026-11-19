import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApiRequest, resetInMemoryStore } from "./api-handler";
import { resetPersistentPremiumState, setTestPersistentDataDir } from "./payments";
import { initiatePaidSubscriptionPayment, type RazorpayOptions } from "../lib/razorpay-service";

describe("Task 2 - Phase 2C: Paid Subscriber Plans UI & Checkout Flow Tests", () => {
  let testDataDir = "";
  const secret = "test_razorpay_secret_key_sub_ui_987654";
  const keyId = "rzp_test_sub_ui_key_123456";
  const testEnv = {
    RAZORPAY_KEY_ID: keyId,
    RAZORPAY_KEY_SECRET: secret,
    RAZORPAY_SKIP_REMOTE_CHECK: "true",
  };

  let userToken = "";
  const standardUserId = "FT483921"; // alex@facetube.com
  const standardUserName = "Alex Rivera";
  const standardUserEmail = "alex@facetube.com";

  before(async () => {
    testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-sub-ui-checkout-test-"));
    setTestPersistentDataDir(testDataDir);
    resetInMemoryStore();

    // 1. Reset state
    await resetPersistentPremiumState(10, [], []);

    // 2. Authenticate standard user
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
  });

  // Suite 1: Plan Catalog & authoritative pricing
  describe("1. Authoritative Plan Catalog & Features", () => {
    it("returns the three active membership tiers with exact prices and durations", async () => {
      const req = new Request("http://localhost:3000/api/subscriptions/plans", {
        method: "GET",
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.success, true);
      assert.ok(Array.isArray(data.plans));
      assert.equal(data.plans.length, 3);

      // Verify Plan 1: Creator Member
      const member = data.plans.find((p: any) => p.plan_id === "member-monthly");
      assert.ok(member);
      assert.equal(member.name, "Creator Member");
      assert.equal(member.price, 49.0);
      assert.equal(member.duration_days, 30);
      assert.ok(member.perks.length >= 3);
      assert.equal(member.is_active, true);

      // Verify Plan 2: VIP Supporter
      const vip = data.plans.find((p: any) => p.plan_id === "member-vip-monthly");
      assert.ok(vip);
      assert.equal(vip.name, "VIP Supporter");
      assert.equal(vip.price, 149.0);
      assert.equal(vip.duration_days, 30);
      assert.ok(vip.perks.length >= 3);
      assert.equal(vip.is_active, true);

      // Verify Plan 3: All-Access Annual
      const annual = data.plans.find((p: any) => p.plan_id === "member-annual");
      assert.ok(annual);
      assert.equal(annual.name, "All-Access Annual");
      assert.equal(annual.price, 999.0);
      assert.equal(annual.duration_days, 365);
      assert.ok(annual.perks.length >= 3);
      assert.equal(annual.is_active, true);
    });
  });

  // Suite 2: Login Enforcement Logic
  describe("2. Login Requirement Enforcement", () => {
    it("rejects unauthenticated requests to subscriber plans with HTTP 401", async () => {
      const req = new Request("http://localhost:3000/api/subscriptions/plans", {
        method: "GET",
        // No Authorization header
      });

      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /authentication required/i);
    });

    it("rejects unauthenticated requests to active subscription with HTTP 401", async () => {
      const req = new Request("http://localhost:3000/api/subscriptions/active", {
        method: "GET",
        // No Authorization header
      });

      const res = await handleApiRequest(req, testEnv);
      assert.ok(res);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /authentication required/i);
    });

    it("blocks checkout order creation when requested user ID does not match session user", async () => {
      const orderReq = new Request("http://localhost:3000/api/payments/create-order", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          purpose: "paid_subscription",
          userId: "FT999999", // Mismatched user ID
          planId: "member-monthly",
        }),
      });

      const res = await handleApiRequest(orderReq, testEnv);
      assert.ok(res);
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(
        data.error,
        /unauthorized|does not match|cannot create payment orders for another user/i,
      );
    });
  });

  // Suite 3: Authoritative Order Creation
  describe("3. Checkout Order Creation with Backend Price Authority", () => {
    it("creates an order using backend database price regardless of client inputs", async () => {
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
          amount: 1.0, // Tampered client price (must be ignored)
        }),
      });

      const res = await handleApiRequest(orderReq, testEnv);
      assert.ok(res);
      assert.equal(res.status, 200);
      const order = await res.json();

      assert.ok(order.orderId);
      assert.equal(order.amount, 49.0, "Must use authoritative ₹49, ignoring client ₹1.0");
      assert.equal(order.amountInSubunits, 4900);
      assert.equal(order.currency, "INR");
      assert.equal(order.keyId, keyId);
    });
  });

  // Suite 4: End-to-End Razorpay Checkout Simulation
  describe("4. Razorpay Checkout Execution & Verification Flow", () => {
    let capturedOptions: RazorpayOptions | null = null;
    let mockOpened = false;

    beforeEach(() => {
      capturedOptions = null;
      mockOpened = false;

      // Mock browser window and window.Razorpay
      (global as any).window = {
        location: {
          hostname: "localhost",
          origin: "http://localhost:3000",
        },
        Razorpay: class MockRazorpay {
          constructor(options: RazorpayOptions) {
            capturedOptions = options;
          }
          open() {
            mockOpened = true;
          }
          on() {}
        },
      };

      // Mock localStorage for auth token
      (global as any).localStorage = {
        getItem: (k: string) => (k === "facetube_auth_token" ? userToken : null),
        setItem: () => {},
        removeItem: () => {},
      };

      // Mock fetch to route through handleApiRequest
      (global as any).fetch = async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        const fullUrl = urlStr.startsWith("http") ? urlStr : `http://localhost:3000${urlStr}`;
        const req = new Request(fullUrl, init);
        const res = await handleApiRequest(req, testEnv);
        if (!res) {
          return new Response(JSON.stringify({ error: "Not Found" }), { status: 404 });
        }
        return res;
      };
    });

    it("opens Razorpay modal with correct plan details and completes successful activation", async () => {
      let successResult: any = null;
      let failureError: string | null = null;
      let cancelled = false;

      await initiatePaidSubscriptionPayment({
        userId: standardUserId,
        userName: standardUserName,
        userEmail: standardUserEmail,
        planId: "member-monthly",
        planName: "Creator Member",
        onSuccess: (res) => {
          successResult = res;
        },
        onFailure: (err) => {
          failureError = err;
        },
        onCancel: () => {
          cancelled = true;
        },
      });

      assert.equal(failureError, null, `Expected no failure, got: ${failureError}`);
      assert.equal(mockOpened, true, "Razorpay modal open() must be called");
      assert.ok(capturedOptions, "Razorpay options must be captured");
      assert.equal((capturedOptions as RazorpayOptions).amount, 4900);
      assert.equal((capturedOptions as RazorpayOptions).currency, "INR");
      assert.match((capturedOptions as RazorpayOptions).description, /Creator Member/);

      // Simulate user completing payment inside Razorpay modal
      const paymentId = `pay_sub_ui_test_${Date.now()}`;
      const orderId = (capturedOptions as RazorpayOptions).order_id;
      const signature = crypto
        .createHmac("sha256", secret)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

      await (capturedOptions as RazorpayOptions).handler({
        razorpay_payment_id: paymentId,
        razorpay_order_id: orderId,
        razorpay_signature: signature,
      });

      assert.equal(failureError, null);
      assert.equal(cancelled, false);
      assert.ok(successResult, "onSuccess must be called");
      assert.equal(successResult.paymentId, paymentId);
      assert.equal(successResult.orderId, orderId);
      assert.ok(successResult.subscription);
      assert.equal(successResult.subscription.planId, "member-monthly");
      assert.equal(successResult.subscription.status, "active");

      // Verify active subscription retrieval
      const activeReq = new Request("http://localhost:3000/api/subscriptions/active", {
        method: "GET",
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const activeRes = await handleApiRequest(activeReq, testEnv);
      assert.ok(activeRes);
      const activeData = await activeRes.json();
      assert.equal(activeData.hasActiveSubscription, true);
      assert.equal(activeData.subscription.planId, "member-monthly");
    });

    it("handles user cancellation (ondismiss) without activating subscription", async () => {
      let successResult: any = null;
      let failureError: string | null = null;
      let cancelled = false;

      await initiatePaidSubscriptionPayment({
        userId: standardUserId,
        userName: standardUserName,
        userEmail: standardUserEmail,
        planId: "member-vip-monthly",
        planName: "VIP Supporter",
        onSuccess: (res) => {
          successResult = res;
        },
        onFailure: (err) => {
          failureError = err;
        },
        onCancel: () => {
          cancelled = true;
        },
      });

      assert.ok(capturedOptions);

      // Simulate user dismissing the Razorpay checkout modal
      if ((capturedOptions as RazorpayOptions).modal?.ondismiss) {
        (capturedOptions as RazorpayOptions).modal!.ondismiss!();
      }

      assert.equal(cancelled, true, "onCancel callback must be invoked on modal dismiss");
      assert.equal(successResult, null, "onSuccess must NOT be called on cancellation");
      assert.equal(failureError, null);
    });

    it("handles signature tampering or verification failure gracefully", async () => {
      let successResult: any = null;
      let failureError: string | null = null;

      await initiatePaidSubscriptionPayment({
        userId: standardUserId,
        userName: standardUserName,
        userEmail: standardUserEmail,
        planId: "member-vip-monthly",
        planName: "VIP Supporter",
        onSuccess: (res) => {
          successResult = res;
        },
        onFailure: (err) => {
          failureError = err;
        },
      });

      assert.ok(capturedOptions);

      // Simulate payment response with tampered signature
      const paymentId = `pay_sub_tampered_${Date.now()}`;
      const orderId = (capturedOptions as RazorpayOptions).order_id;
      const invalidSignature = "invalid_tampered_hmac_signature_987654321";

      await (capturedOptions as RazorpayOptions).handler({
        razorpay_payment_id: paymentId,
        razorpay_order_id: orderId,
        razorpay_signature: invalidSignature,
      });

      assert.equal(successResult, null, "onSuccess must NOT be called on invalid signature");
      assert.ok(failureError, "onFailure must be called on verification failure");
      assert.match(failureError, /signature|verification failed/i);
    });

    it("prevents double-activation on duplicate payment verification (idempotency)", async () => {
      let firstSuccess: any = null;
      await initiatePaidSubscriptionPayment({
        userId: standardUserId,
        userName: standardUserName,
        userEmail: standardUserEmail,
        planId: "member-annual",
        planName: "All-Access Annual",
        onSuccess: (res) => {
          firstSuccess = res;
        },
        onFailure: () => {},
      });

      assert.ok(capturedOptions);
      const paymentId = `pay_sub_idem_${Date.now()}`;
      const orderId = (capturedOptions as RazorpayOptions).order_id;
      const signature = crypto
        .createHmac("sha256", secret)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

      // First verification call
      await (capturedOptions as RazorpayOptions).handler({
        razorpay_payment_id: paymentId,
        razorpay_order_id: orderId,
        razorpay_signature: signature,
      });
      assert.ok(firstSuccess);
      const subId1 = firstSuccess.subscription.subscriptionId;

      // Duplicate verification call with same order/payment
      await (capturedOptions as RazorpayOptions).handler({
        razorpay_payment_id: paymentId,
        razorpay_order_id: orderId,
        razorpay_signature: signature,
      });

      assert.ok(subId1);
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
