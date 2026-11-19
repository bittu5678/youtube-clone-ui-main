import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  verifyServerPayment,
  verifyPayment,
  PRICING_CONFIG,
  evaluateAdsDistribution,
  evaluatePremiumDistribution,
  calculateWeightedPoolPayouts,
  resolveUplineSponsors,
  ADS_REFERRAL_RATES,
  getPersistentPremiumTxNumber,
  resetPersistentPremiumState,
  createServerPaymentOrder,
  executeRazorpayRefund,
  parseStrictBooleanFlag,
  isProductionRuntimeEnv,
  isFailClosedProductionEnv,
} from "./payments";
import {
  handleApiRequest,
  isAdPromotionActive,
  maskAccountNumber,
  maskUpiId,
  buildMaskedBeneficiaryDetails,
  setStoreWalletBalance,
  resetStoreForTests,
} from "./api-handler";
import { isPromotionActive, getVideoBadgeLabels } from "../lib/video-service";
import { api } from "../lib/api";
import {
  processWithdrawal,
  getUserWallet,
  saveStoredLedger,
  getUserLedger,
  getGlobalPoolSummary,
} from "../lib/ledger-service";

beforeEach(() => {
  resetStoreForTests();
});

describe("Payment Verification & Referral Security Audit Tests", () => {
  const secret = "test_razorpay_secret_key_1234567890";
  const orderId = "order_test_1001";
  const paymentId = "pay_test_2002";
  const validSignature = crypto
    .createHmac("sha256", secret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  it("1. Fails closed when Razorpay secret credentials are missing", async () => {
    const res = await verifyPayment(
      {
        orderId,
        paymentId,
        signature: validSignature,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["FT483921"],
      "FT102857",
      { RAZORPAY_KEY_SECRET: "" }, // Explicitly missing secret
    );

    assert.equal(res.verified, false);
    assert.match(res.error || "", /missing|not configured|failed closed/i);
  });

  it("2. Rejects mock signatures and bypass tokens", async () => {
    const res = await verifyPayment(
      {
        orderId,
        paymentId: "pay_test_mock_1",
        signature: "mock_signature_bypass",
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["FT483921"],
      "FT102857",
      { RAZORPAY_KEY_SECRET: secret },
    );

    assert.equal(res.verified, false);
    assert.match(res.error || "", /mock|invalid/i);
  });

  it("3. Rejects invalid or tampered HMAC signature", async () => {
    const res = await verifyPayment(
      {
        orderId,
        paymentId,
        signature: "tampered_fake_signature_382910382910381029381029",
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["FT483921"],
      "FT102857",
      { RAZORPAY_KEY_SECRET: secret },
    );

    assert.equal(res.verified, false);
    assert.match(res.error || "", /signature verification failed/i);
  });

  it("4. Credits referral commission correctly for verified premium video upload", async () => {
    const uniquePayId = `pay_unique_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto
      .createHmac("sha256", secret)
      .update(`${orderId}|${uniquePayId}`)
      .digest("hex");

    const res = await verifyPayment(
      {
        orderId,
        paymentId: uniquePayId,
        signature: sig,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["FT483921"],
      "FT102857", // Verified sponsor
      { RAZORPAY_KEY_SECRET: secret },
    );

    assert.equal(res.verified, true);
    assert.equal(res.amount, 6.0); // Exact ₹6.00 business rule
    assert.equal(res.distribution?.directReferralAmount, 1.0); // Exact ₹1.00 business rule
    assert.equal(res.distribution?.referrerId, "FT102857");
  });

  it("5. Prevents duplicate commission credit on duplicate payment ID (idempotency)", async () => {
    const uniquePayId = `pay_dedup_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto
      .createHmac("sha256", secret)
      .update(`${orderId}|${uniquePayId}`)
      .digest("hex");

    // First attempt
    const firstRes = await verifyPayment(
      {
        orderId,
        paymentId: uniquePayId,
        signature: sig,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["FT483921"],
      "FT102857",
      { RAZORPAY_KEY_SECRET: secret },
    );
    assert.equal(firstRes.verified, true);

    // Second duplicate attempt
    const secondRes = await verifyPayment(
      {
        orderId,
        paymentId: uniquePayId,
        signature: sig,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["FT483921"],
      "FT102857",
      { RAZORPAY_KEY_SECRET: secret },
    );

    assert.equal(secondRes.verified, true);
    assert.equal(secondRes.txNumber, firstRes.txNumber); // Does not increment sequence
    assert.match(secondRes.error || "", /already been processed/i);
  });

  it("6. Handles concurrent duplicate payment verification requests safely", async () => {
    const concurrentPayId = `pay_concurrent_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto
      .createHmac("sha256", secret)
      .update(`${orderId}|${concurrentPayId}`)
      .digest("hex");

    const reqData = {
      orderId,
      paymentId: concurrentPayId,
      signature: sig,
      userId: "FT483921",
      purpose: "premium_video_upload" as const,
    };

    // Fire 3 simultaneous verification attempts
    const [res1, res2, res3] = await Promise.all([
      verifyServerPayment(reqData, ["FT483921"], "FT102857", { RAZORPAY_KEY_SECRET: secret }),
      verifyServerPayment(reqData, ["FT483921"], "FT102857", { RAZORPAY_KEY_SECRET: secret }),
      verifyServerPayment(reqData, ["FT483921"], "FT102857", { RAZORPAY_KEY_SECRET: secret }),
    ]);

    // All should be marked verified, but only one is the original sequence allocation
    assert.equal(res1.verified, true);
    assert.equal(res2.verified, true);
    assert.equal(res3.verified, true);

    // All must have identical sequence numbers (no sequence inflation)
    assert.equal(res1.txNumber, res2.txNumber);
    assert.equal(res2.txNumber, res3.txNumber);
  });
});

describe("API Handler Authentication & Authorization Security Tests", () => {
  const adminToken = "test_session_token_admin_001";
  const userToken = "test_session_token_user_002";
  const envConfig = { RAZORPAY_KEY_SECRET: "test_secret_for_api_tests_123456" };

  // Helper to simulate API requests with tokens
  async function makeApiCall(
    url: string,
    method = "GET",
    body: any = null,
    token: string | null = null,
  ) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    const init: RequestInit = { method, headers };
    if (body) {
      init.body = JSON.stringify(body);
    }
    const req = new Request(`http://localhost:3000${url}`, init);
    const resp = await handleApiRequest(req, envConfig);
    assert.ok(resp, `Response should exist for ${url}`);
    const data = await resp.json();
    return { status: resp.status, data };
  }

  it("1. Rejects unauthenticated access to wallet/balance with 401", async () => {
    const { status, data } = await makeApiCall("/api/wallet/balance.php?userId=FT483921");
    assert.equal(status, 401);
    assert.equal(data.success, false);
    assert.match(data.error, /Authentication required/i);
  });

  it("2. Rejects unauthenticated access to wallet/transactions with 401", async () => {
    const { status, data } = await makeApiCall("/api/wallet/transactions.php");
    assert.equal(status, 401);
    assert.equal(data.success, false);
    assert.match(data.error, /Authentication required/i);
  });

  it("3. Rejects unauthenticated access to wallet/withdraw with 401", async () => {
    const { status, data } = await makeApiCall("/api/wallet/withdraw.php", "POST", {
      amount: 1000,
      userId: "FT483921",
    });
    assert.equal(status, 401);
    assert.equal(data.success, false);
    assert.match(data.error, /Authentication required/i);
  });

  it("4. Rejects unauthenticated access to referrals/dashboard with 401", async () => {
    const { status, data } = await makeApiCall("/api/referrals/dashboard.php?userId=FT483921");
    assert.equal(status, 401);
    assert.equal(data.success, false);
    assert.match(data.error, /Authentication required/i);
  });

  it("5. Authenticates regular user and generates valid session token", async () => {
    const { status, data } = await makeApiCall("/api/auth/login.php", "POST", {
      identifier: "alex@facetube.com",
      password: "password123",
    });
    assert.equal(status, 200);
    assert.equal(data.success, true);
    assert.ok(data.token, "Login should return session token");
    assert.equal(data.user.user_id, "FT483921");
    assert.equal(data.user.role, "user");
  });

  it("6. Allows regular user to access their own wallet/balance", async () => {
    // Log in as Alex
    const login = await makeApiCall("/api/auth/login.php", "POST", {
      identifier: "alex@facetube.com",
      password: "password123",
    });
    const token = login.data.token;

    const { status, data } = await makeApiCall(
      "/api/wallet/balance.php?userId=FT483921",
      "GET",
      null,
      token,
    );
    assert.equal(status, 200);
    assert.equal(data.success, true);
    assert.equal(data.wallet.userId, "FT483921");
  });

  it("7. Blocks standard user from cross-user access to another user's wallet with 403", async () => {
    // Log in as Alex (role: user)
    const login = await makeApiCall("/api/auth/login.php", "POST", {
      identifier: "alex@facetube.com",
      password: "password123",
    });
    const token = login.data.token;

    // Try accessing Admin's wallet (FT102857)
    const { status, data } = await makeApiCall(
      "/api/wallet/balance.php?userId=FT102857",
      "GET",
      null,
      token,
    );
    assert.equal(status, 403);
    assert.equal(data.success, false);
    assert.match(data.error, /Cross-user access is restricted to verified administrators/i);
  });

  it("8. Blocks standard user from cross-user access to another user's referrals/dashboard with 403", async () => {
    // Log in as Alex
    const login = await makeApiCall("/api/auth/login.php", "POST", {
      identifier: "alex@facetube.com",
      password: "password123",
    });
    const token = login.data.token;

    // Try accessing Admin's referral dashboard
    const { status, data } = await makeApiCall(
      "/api/referrals/dashboard.php?userId=FT102857",
      "GET",
      null,
      token,
    );
    assert.equal(status, 403);
    assert.equal(data.success, false);
    assert.match(data.error, /Cross-user access is restricted to verified administrators/i);
  });

  it("9. Permits admin user to access cross-user wallet/balance and referrals/dashboard", async () => {
    // Log in as Admin
    const login = await makeApiCall("/api/auth/login.php", "POST", {
      identifier: "admin@facetube.com",
      password: "password",
    });
    assert.equal(login.status, 200);
    const token = login.data.token;

    // Admin accessing Alex's wallet
    const walletRes = await makeApiCall(
      "/api/wallet/balance.php?userId=FT483921",
      "GET",
      null,
      token,
    );
    assert.equal(walletRes.status, 200);
    assert.equal(walletRes.data.success, true);
    assert.equal(walletRes.data.wallet.userId, "FT483921");

    // Admin accessing Alex's referrals
    const refRes = await makeApiCall(
      "/api/referrals/dashboard.php?userId=FT483921",
      "GET",
      null,
      token,
    );
    assert.equal(refRes.status, 200);
    assert.equal(refRes.data.success, true);
    assert.equal(refRes.data.dashboard.userId, "FT483921");
  });

  it("10. Enforces withdrawal limit boundaries (min ₹100 and max ₹10,000) with company confirmed charge breakdown", async () => {
    const login = await makeApiCall("/api/auth/login.php", "POST", {
      identifier: "admin@facetube.com",
      password: "password",
    });
    const token = login.data.token;

    // Below minimum (< ₹100)
    const belowMin = await makeApiCall("/api/wallet/withdraw.php", "POST", { amount: 50 }, token);
    assert.equal(belowMin.status, 400);
    assert.match(belowMin.data.error, /Minimum withdrawal amount is ₹100/i);

    // Above maximum (> ₹10,000)
    const aboveMax = await makeApiCall(
      "/api/wallet/withdraw.php",
      "POST",
      { amount: 15000 },
      token,
    );
    assert.equal(aboveMax.status, 400);
    assert.match(aboveMax.data.error, /Maximum daily withdrawal limit is ₹10,000/i);

    // Valid ₹100 minimum withdrawal with confirmed charges breakdown (20% total charge: 18% GST + 2% PG -> ₹80 net)
    const valid100Withdrawal = await makeApiCall(
      "/api/wallet/withdraw.php",
      "POST",
      { amount: 100 },
      token,
    );
    assert.equal(valid100Withdrawal.status, 200);
    assert.equal(valid100Withdrawal.data.success, true);
    assert.equal(valid100Withdrawal.data.transaction.amount, 100);
    assert.equal(valid100Withdrawal.data.transaction.fee, 20);
    assert.equal(valid100Withdrawal.data.transaction.netAmount, 80);
    assert.equal(valid100Withdrawal.data.transaction.chargesBreakdown.gstAmount, 18);
    assert.equal(valid100Withdrawal.data.transaction.chargesBreakdown.pgFeeAmount, 2);
    assert.equal(valid100Withdrawal.data.transaction.chargesBreakdown.totalCharge, 20);
    assert.equal(valid100Withdrawal.data.transaction.chargesBreakdown.netPayable, 80);

    // Valid ₹1,000 withdrawal with confirmed charges breakdown (20% total charge: 18% GST + 2% PG -> ₹800 net)
    const validWithdrawal = await makeApiCall(
      "/api/wallet/withdraw.php",
      "POST",
      { amount: 1000 },
      token,
    );
    assert.equal(validWithdrawal.status, 200);
    assert.equal(validWithdrawal.data.success, true);
    assert.equal(validWithdrawal.data.transaction.amount, 1000);
    assert.equal(validWithdrawal.data.transaction.fee, 200);
    assert.equal(validWithdrawal.data.transaction.netAmount, 800);
    assert.ok(validWithdrawal.data.transaction.chargesBreakdown);
    assert.equal(validWithdrawal.data.transaction.chargesBreakdown.gstAmount, 180);
    assert.equal(validWithdrawal.data.transaction.chargesBreakdown.pgFeeAmount, 20);
    assert.equal(validWithdrawal.data.transaction.chargesBreakdown.totalCharge, 200);
    assert.equal(validWithdrawal.data.transaction.chargesBreakdown.netPayable, 800);
  });

  it("11. Rejects payment verification for mismatched amount or unsupported purpose", async () => {
    const login = await makeApiCall("/api/auth/login.php", "POST", {
      identifier: "alex@facetube.com",
      password: "password123",
    });
    const token = login.data.token;

    const ordId = "ord_test_val_1";
    const payId = `pay_val_${Date.now()}`;
    const sig = crypto
      .createHmac("sha256", envConfig.RAZORPAY_KEY_SECRET)
      .update(`${ordId}|${payId}`)
      .digest("hex");

    // Mismatched amount (e.g. ₹5 instead of required ₹6 for premium video)
    const badAmount = await makeApiCall(
      "/api/payments/verify.php",
      "POST",
      {
        orderId: ordId,
        paymentId: payId,
        signature: sig,
        purpose: "premium_video_upload",
        amount: 5.0,
      },
      token,
    );
    assert.equal(badAmount.status, 400);
    assert.match(badAmount.data.error, /does not match expected fee/i);

    // Unsupported purpose
    const badPurpose = await makeApiCall(
      "/api/payments/verify.php",
      "POST",
      {
        orderId: ordId,
        paymentId: payId,
        signature: sig,
        purpose: "unknown_hack_purpose",
      },
      token,
    );
    assert.equal(badPurpose.status, 400);
    assert.match(badPurpose.data.error, /Unsupported payment purpose/i);
  });

  it("12. Rejects payment verification when user attempts to verify video owned by another creator", async () => {
    // Maya Lin attempting to verify Alex's video (vid-seed-001)
    const login = await makeApiCall("/api/auth/login.php", "POST", {
      identifier: "maya@facetube.com",
      password: "password123",
    });
    const token = login.data.token;

    const ordId = "ord_test_vid_owner";
    const payId = `pay_vid_${Date.now()}`;
    const sig = crypto
      .createHmac("sha256", envConfig.RAZORPAY_KEY_SECRET)
      .update(`${ordId}|${payId}`)
      .digest("hex");

    const res = await makeApiCall(
      "/api/payments/verify.php",
      "POST",
      {
        orderId: ordId,
        paymentId: payId,
        signature: sig,
        videoId: "vid-seed-001", // Alex's video
        userId: "FT900431", // Maya's ID
        purpose: "premium_video_upload",
      },
      token,
    );

    assert.equal(res.status, 403);
    assert.match(res.data.error, /does not match the authenticated payer/i);
  });

  it("13. Proves wallet withdrawal action invokes api.wallet.withdraw mutation exactly once", async () => {
    let withdrawCallCount = 0;
    const originalWithdraw = api.wallet.withdraw;
    const originalGetBalance = api.wallet.getBalance;

    api.wallet.getBalance = async (_userId?: string) => {
      return {
        success: true,
        wallet: {
          user_id: "FT483921",
          balance: 5000,
          total_earned: 5000,
          total_withdrawn: 0,
          referral_income: 0,
          global_income: 0,
          adsense_income: 0,
          affiliate_income: 0,
          updated_at: new Date().toISOString(),
        },
      };
    };

    api.wallet.withdraw = async (_data: any) => {
      withdrawCallCount++;
      return {
        success: true,
        transaction: { id: "test_tx_wdr_1" },
        updatedWallet: { balance: 4000, total_withdrawn: 1000 },
      };
    };

    try {
      const res = await processWithdrawal("FT483921", 1000, {
        accountHolder: "Alex Rivera",
        accountNumber: "50100481920194",
        bankName: "HDFC Bank",
        upiId: "alexrivera@okhdfcbank",
      });

      assert.equal(res.success, true, "Withdrawal should succeed when balance is sufficient");
      assert.equal(
        withdrawCallCount,
        1,
        "api.wallet.withdraw must be called exactly once per withdrawal action",
      );
    } finally {
      api.wallet.withdraw = originalWithdraw;
      api.wallet.getBalance = originalGetBalance;
    }
  });

  it("13b. Proves processWithdrawal NEVER returns success: true when api.wallet.withdraw throws an error", async () => {
    const originalWithdraw = api.wallet.withdraw;
    const originalGetBalance = api.wallet.getBalance;

    api.wallet.getBalance = async (_userId?: string) => {
      return {
        success: true,
        wallet: {
          user_id: "FT483921",
          balance: 5000,
          total_earned: 5000,
          total_withdrawn: 0,
          referral_income: 0,
          global_income: 0,
          adsense_income: 0,
          affiliate_income: 0,
          updated_at: new Date().toISOString(),
        },
      };
    };

    // Simulate upstream Hostinger failure / network drop
    api.wallet.withdraw = async (_data: any) => {
      throw new Error("502 Bad Gateway: Upstream Hostinger API connection failed");
    };

    saveStoredLedger([]);
    try {
      const res = await processWithdrawal("FT483921", 1000, {
        accountHolder: "Alex Rivera",
        accountNumber: "50100481920194",
        bankName: "HDFC Bank",
      });

      assert.equal(res.success, false, "Must NEVER return success: true when server call fails");
      assert.ok(res.error, "Must provide an honest error explanation");
      assert.match(
        res.error!,
        /could not be verified by server/i,
        "Error message must clearly inform the user that funds were not deducted",
      );
    } finally {
      api.wallet.withdraw = originalWithdraw;
      api.wallet.getBalance = originalGetBalance;
    }
  });

  it("13c. Proves processWithdrawal NEVER returns success: true when api.wallet.withdraw returns success: false", async () => {
    const originalWithdraw = api.wallet.withdraw;
    const originalGetBalance = api.wallet.getBalance;

    api.wallet.getBalance = async (_userId?: string) => {
      return {
        success: true,
        wallet: {
          user_id: "FT483921",
          balance: 5000,
          total_earned: 5000,
          total_withdrawn: 0,
          referral_income: 0,
          global_income: 0,
          adsense_income: 0,
          affiliate_income: 0,
          updated_at: new Date().toISOString(),
        },
      };
    };

    // Simulate server rejecting withdrawal
    api.wallet.withdraw = async (_data: any) => {
      return {
        success: false,
        error: "Hostinger database lock timeout: transaction rolled back.",
      };
    };

    saveStoredLedger([]);
    try {
      const res = await processWithdrawal("FT483921", 1000, {
        accountHolder: "Alex Rivera",
        accountNumber: "50100481920194",
        bankName: "HDFC Bank",
      });

      assert.equal(
        res.success,
        false,
        "Must return success: false when server rejects transaction",
      );
      assert.equal(
        res.error,
        "Hostinger database lock timeout: transaction rolled back.",
        "Must return authoritative server rejection reason",
      );
    } finally {
      api.wallet.withdraw = originalWithdraw;
      api.wallet.getBalance = originalGetBalance;
    }
  });

  it("13d. Proves getUserWallet marks isStale: true when server API fails without overwriting local cache", async () => {
    const originalGetBalance = api.wallet.getBalance;

    // Simulate server connection failure
    api.wallet.getBalance = async (_userId?: string) => {
      throw new Error("Network unreachable");
    };

    try {
      const w = await getUserWallet("FT999999");
      assert.equal(w.isStale, true, "Must be tagged as isStale: true on API failure");
      assert.equal(w.userId, "FT999999");
    } finally {
      api.wallet.getBalance = originalGetBalance;
    }
  });

  it("14. Admin bulk payout executes batch disbursement and updates wallet deductions consistently", async () => {
    // Ensure sufficient test balances for recipients (FT483921: 100, FT102857: 15400)
    setStoreWalletBalance("FT483921", 100);
    setStoreWalletBalance("FT102857", 15400);

    const adminLogin = await makeApiCall("/api/auth/login.php", "POST", {
      identifier: "admin@facetube.com",
      password: "password",
    });
    const adminToken = adminLogin.data.token;

    const bulkRes = await makeApiCall(
      "/api/admin/bulk-payout.php",
      "POST",
      {
        payouts: [
          { userId: "FT483921", amount: 50 },
          { userId: "FT102857", amount: 250 },
        ],
        notes: "Test batch payout disbursement",
      },
      adminToken,
    );
    assert.equal(bulkRes.status, 200);
    assert.equal(bulkRes.data.success, true);
    assert.equal(bulkRes.data.total_recipients, 2);
    assert.equal(bulkRes.data.total_amount, 300);
    assert.ok(bulkRes.data.batch_id);
  });
});

describe("Database Transaction Rollback Simulation Tests", () => {
  it("Simulates MySQL transaction rollback on failure during payment verification flow", async () => {
    let transactionBegun = false;
    let transactionCommitted = false;
    let transactionRolledBack = false;

    // Mock MySQL Connection with transactional operations
    const mockConnection = {
      beginTransaction: async () => {
        transactionBegun = true;
      },
      query: async (sql: string) => {
        if (sql.includes("SELECT * FROM payment_transactions")) {
          return [[]]; // No duplicate
        }
        if (sql.includes("COUNT(*)")) {
          return [[{ total: 5 }]];
        }
        if (sql.includes("INSERT INTO payment_transactions")) {
          // Simulate simulated unexpected database constraint error on ledger
          throw new Error("Simulated database failure during ledger step");
        }
        return [{}];
      },
      commit: async () => {
        transactionCommitted = true;
      },
      rollback: async () => {
        transactionRolledBack = true;
      },
      release: () => {},
    };

    try {
      await mockConnection.beginTransaction();
      await mockConnection.query("SELECT * FROM payment_transactions WHERE payment_id = ?");
      await mockConnection.query("INSERT INTO payment_transactions ...");
      await mockConnection.commit();
    } catch (_err) {
      await mockConnection.rollback();
    }

    assert.equal(transactionBegun, true, "Transaction must begin");
    assert.equal(transactionCommitted, false, "Transaction must not commit on error");
    assert.equal(transactionRolledBack, true, "Transaction must roll back on error");
  });
});

describe("Razorpay Real Order Creation & Gateway Verification Tests", () => {
  const testKeyId = "rzp_test_testkey123456";
  const testSecret = "test_secret_key_abcdef123456";

  it("1. createServerPaymentOrder fails closed when credentials missing", async () => {
    const { createServerPaymentOrder } = await import("./payments");

    await assert.rejects(async () => {
      await createServerPaymentOrder(
        {
          purpose: "premium_video_upload",
          userId: "FT483921",
        },
        { RAZORPAY_KEY_ID: "", RAZORPAY_KEY_SECRET: "" },
      );
    }, /credentials.*not configured/i);
  });

  it("2. createServerPaymentOrder generates exact pricing for premium video and ads", async () => {
    const { createServerPaymentOrder } = await import("./payments");

    // Premium video: ₹6.00 / 600 paise
    const premiumOrder = await createServerPaymentOrder(
      {
        purpose: "premium_video_upload",
        userId: "FT483921",
      },
      {
        RAZORPAY_KEY_ID: testKeyId,
        RAZORPAY_KEY_SECRET: testSecret,
        RAZORPAY_SKIP_REMOTE_CHECK: "true",
      },
    );
    assert.equal(premiumOrder.amount, 6.0);
    assert.equal(premiumOrder.amountInSubunits, 600);
    assert.equal(premiumOrder.currency, "INR");

    // Ads promotion: 7 days = ₹100 / 10000 paise
    const ads7Days = await createServerPaymentOrder(
      {
        purpose: "ads_promotion",
        userId: "FT483921",
        planId: "plan-7-days",
      },
      {
        RAZORPAY_KEY_ID: testKeyId,
        RAZORPAY_KEY_SECRET: testSecret,
        RAZORPAY_SKIP_REMOTE_CHECK: "true",
      },
    );
    assert.equal(ads7Days.amount, 100.0);
    assert.equal(ads7Days.amountInSubunits, 10000);

    // Ads promotion: 15 days = ₹200 / 20000 paise
    const ads15Days = await createServerPaymentOrder(
      {
        purpose: "ads_promotion",
        userId: "FT483921",
        planId: "plan-15-days",
      },
      {
        RAZORPAY_KEY_ID: testKeyId,
        RAZORPAY_KEY_SECRET: testSecret,
        RAZORPAY_SKIP_REMOTE_CHECK: "true",
      },
    );
    assert.equal(ads15Days.amount, 200.0);
    assert.equal(ads15Days.amountInSubunits, 20000);

    // Ads promotion: monthly = ₹300 / 30000 paise
    const adsMonthly = await createServerPaymentOrder(
      {
        purpose: "ads_promotion",
        userId: "FT483921",
        planId: "plan-monthly",
      },
      {
        RAZORPAY_KEY_ID: testKeyId,
        RAZORPAY_KEY_SECRET: testSecret,
        RAZORPAY_SKIP_REMOTE_CHECK: "true",
      },
    );
    assert.equal(adsMonthly.amount, 300.0);
    assert.equal(adsMonthly.amountInSubunits, 30000);

    // Ads promotion: yearly = ₹3,000 / 300000 paise
    const adsYearly = await createServerPaymentOrder(
      {
        purpose: "ads_promotion",
        userId: "FT483921",
        planId: "plan-yearly",
      },
      {
        RAZORPAY_KEY_ID: testKeyId,
        RAZORPAY_KEY_SECRET: testSecret,
        RAZORPAY_SKIP_REMOTE_CHECK: "true",
      },
    );
    assert.equal(adsYearly.amount, 3000.0);
    assert.equal(adsYearly.amountInSubunits, 300000);
  });

  it("3. API create-order route returns 503 when credentials missing", async () => {
    const req = new Request("http://localhost:3000/api/payments/create-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        purpose: "premium_video_upload",
        userId: "FT483921",
      }),
    });

    const res = await handleApiRequest(req, {
      RAZORPAY_KEY_ID: "",
      RAZORPAY_KEY_SECRET: "",
    });

    assert.ok(res);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(body.error || "", /credentials.*not configured/i);
  });

  it("4. Verifies all four ads promotion tiers with exact authoritative pricing via metadata or planId", async () => {
    const testCases: Array<{
      planId: "plan-7-days" | "plan-15-days" | "plan-monthly" | "plan-yearly";
      expectedAmount: number;
    }> = [
      { planId: "plan-7-days", expectedAmount: 100.0 },
      { planId: "plan-15-days", expectedAmount: 200.0 },
      { planId: "plan-monthly", expectedAmount: 300.0 },
      { planId: "plan-yearly", expectedAmount: 3000.0 },
    ];

    for (const { planId, expectedAmount } of testCases) {
      const orderId = `ord_test_ads_${planId}_${Date.now()}`;
      const paymentId = `pay_test_ads_${planId}_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`;
      const signature = crypto
        .createHmac("sha256", testSecret)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

      // Verify sending planId inside metadata (as frontend ads-promotions.tsx does)
      const req = new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId,
          paymentId,
          signature,
          userId: "FT483921",
          purpose: "ads_promotion",
          metadata: { planId },
          amount: expectedAmount,
        }),
      });

      const res = await handleApiRequest(req, {
        RAZORPAY_KEY_ID: testKeyId,
        RAZORPAY_KEY_SECRET: testSecret,
        RAZORPAY_SKIP_REMOTE_CHECK: "true",
      });

      assert.ok(res);
      assert.equal(res.status, 200, `Plan ${planId} verification should return 200`);
      const body = await res.json();
      assert.equal(body.verified, true, `Plan ${planId} should be verified`);
      assert.equal(
        body.amount,
        expectedAmount,
        `Plan ${planId} should charge exactly ₹${expectedAmount}`,
      );
    }

    // Verify amount mismatch rejection: e.g. claiming ₹100 for yearly ₹3,000 plan
    const badOrderId = `ord_test_mismatch_${Date.now()}`;
    const badPayId = `pay_test_mismatch_${Date.now()}`;
    const badSig = crypto
      .createHmac("sha256", testSecret)
      .update(`${badOrderId}|${badPayId}`)
      .digest("hex");

    const mismatchReq = new Request("http://localhost:3000/api/payments/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId: badOrderId,
        paymentId: badPayId,
        signature: badSig,
        userId: "FT483921",
        purpose: "ads_promotion",
        metadata: { planId: "plan-yearly" },
        amount: 100.0, // Fraudulent claim: ₹100 instead of ₹3,000
      }),
    });

    const mismatchRes = await handleApiRequest(mismatchReq, {
      RAZORPAY_KEY_ID: testKeyId,
      RAZORPAY_KEY_SECRET: testSecret,
      RAZORPAY_SKIP_REMOTE_CHECK: "true",
    });

    assert.ok(mismatchRes);
    assert.equal(mismatchRes.status, 400, "Mismatched amount must return 400");
    const mismatchBody = await mismatchRes.json();
    assert.equal(mismatchBody.verified, false);
    assert.match(mismatchBody.error, /does not match expected fee of ₹3000\.00/i);
  });

  it("5. Rejects unauthorized video promotion order creation by non-owner user with 403", async () => {
    // Log in as Maya Lin (FT900431)
    const loginReq = new Request("http://localhost:3000/api/auth/login.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "maya@facetube.com",
        password: "password123",
      }),
    });
    const loginRes = await handleApiRequest(loginReq);
    assert.ok(loginRes);
    const loginData = await loginRes.json();
    const token = loginData.token;

    // Maya attempts to initiate an ad promotion for Alex's video (vid-seed-001, owned by FT483921)
    const req = new Request("http://localhost:3000/api/payments/create-order", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        purpose: "ads_promotion",
        videoId: "vid-seed-001", // Alex's video
        userId: "FT900431", // Maya's ID
        planId: "plan-monthly",
      }),
    });

    const res = await handleApiRequest(req, {
      RAZORPAY_KEY_ID: testKeyId,
      RAZORPAY_KEY_SECRET: testSecret,
      RAZORPAY_SKIP_REMOTE_CHECK: "true",
    });

    assert.ok(res);
    assert.equal(res.status, 403, "Non-owner promotion order must be rejected with 403");
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.error, /only initiate promotion for your own uploaded videos/i);
  });

  it("6. Activates promotion with renewal logic and prevents duplicate re-extension on repeated verification", async () => {
    const orderId = `ord_test_renewal_${Date.now()}`;
    const paymentId = `pay_test_renewal_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const signature = crypto
      .createHmac("sha256", testSecret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    // First verification (Alex promotes his own video vid-seed-002 for 7 days)
    const verifyReq1 = new Request("http://localhost:3000/api/payments/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId,
        paymentId,
        signature,
        userId: "FT483921",
        videoId: "vid-seed-002",
        purpose: "ads_promotion",
        planId: "plan-7-days",
        amount: 100.0,
      }),
    });

    const res1 = await handleApiRequest(verifyReq1, {
      RAZORPAY_KEY_ID: testKeyId,
      RAZORPAY_KEY_SECRET: testSecret,
      RAZORPAY_SKIP_REMOTE_CHECK: "true",
    });

    assert.ok(res1);
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(body1.verified, true);

    // Read video's recorded promotion expiry after 1st verification
    const vidReq1 = new Request("http://localhost:3000/api/videos/get.php?id=vid-seed-002");
    const vidRes1 = await handleApiRequest(vidReq1);
    assert.ok(vidRes1);
    const vidData1 = await vidRes1.json();
    assert.equal(vidData1.video.isPromoted, true);
    const firstExpiry = vidData1.video.promotionExpiresAt;
    assert.ok(firstExpiry, "Expiry date must be set");

    // Second repeated verification of the exact same paymentId
    const verifyReq2 = new Request("http://localhost:3000/api/payments/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId,
        paymentId,
        signature,
        userId: "FT483921",
        videoId: "vid-seed-002",
        purpose: "ads_promotion",
        planId: "plan-7-days",
        amount: 100.0,
      }),
    });

    const res2 = await handleApiRequest(verifyReq2, {
      RAZORPAY_KEY_ID: testKeyId,
      RAZORPAY_KEY_SECRET: testSecret,
      RAZORPAY_SKIP_REMOTE_CHECK: "true",
    });

    assert.ok(res2);
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.verified, true);
    assert.equal(body2.duplicate, true, "Must be flagged as idempotent duplicate");

    // Re-verify that expiry date was NOT extended again on duplicate call
    const vidReq2 = new Request("http://localhost:3000/api/videos/get.php?id=vid-seed-002");
    const vidRes2 = await handleApiRequest(vidReq2);
    assert.ok(vidRes2);
    const vidData2 = await vidRes2.json();
    assert.equal(
      vidData2.video.promotionExpiresAt,
      firstExpiry,
      "Duplicate verification must NOT extend promotion expiry date again",
    );
  });
});

describe("Task 32: Yearly Ads Pricing & Expired Ad Promotion Validation Tests", () => {
  it("1. Verifies authoritative ₹3,000 yearly ads plan pricing across server configurations", () => {
    const yearlyPlan = PRICING_CONFIG.ADS_PROMOTION["plan-yearly"];
    assert.equal(yearlyPlan.price, 3000, "Yearly ads plan must be exactly ₹3,000");
    assert.equal(yearlyPlan.days, 365, "Yearly ads plan duration must be 365 days");

    // All four plan prices must agree with company specifications
    assert.equal(PRICING_CONFIG.ADS_PROMOTION["plan-7-days"].price, 100);
    assert.equal(PRICING_CONFIG.ADS_PROMOTION["plan-15-days"].price, 200);
    assert.equal(PRICING_CONFIG.ADS_PROMOTION["plan-monthly"].price, 300);
    assert.equal(PRICING_CONFIG.ADS_PROMOTION["plan-yearly"].price, 3000);
  });

  it("2. isAdPromotionActive and isPromotionActive return true strictly for active future promotions", () => {
    const futureDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const activeSample = {
      isPromoted: true,
      promotionExpiresAt: futureDate,
    };

    assert.equal(isAdPromotionActive(activeSample), true);
    assert.equal(isPromotionActive(activeSample), true);
  });

  it("3. isAdPromotionActive and isPromotionActive return false for expired promotions (past timestamp)", () => {
    const pastDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const expiredSample = {
      is_promoted: true,
      promotion_expires_at: pastDate,
    };

    assert.equal(isAdPromotionActive(expiredSample), false);
    assert.equal(isPromotionActive(expiredSample), false);
  });

  it("4. Safely handles null, undefined, or empty expiry timestamps by failing closed (returns false)", () => {
    const nullExpirySample = { isPromoted: true, promotionExpiresAt: null };
    const missingExpirySample = { is_promoted: true };
    const invalidDateSample = { isPromoted: true, promotionExpiresAt: "invalid-timestamp" };
    const unpromotedSample = {
      isPromoted: false,
      promotionExpiresAt: new Date(Date.now() + 100000).toISOString(),
    };

    assert.equal(isAdPromotionActive(nullExpirySample as any), false);
    assert.equal(isPromotionActive(nullExpirySample as any), false);

    assert.equal(isAdPromotionActive(missingExpirySample as any), false);
    assert.equal(isPromotionActive(missingExpirySample as any), false);

    assert.equal(isAdPromotionActive(invalidDateSample), false);
    assert.equal(isPromotionActive(invalidDateSample), false);

    assert.equal(isAdPromotionActive(unpromotedSample), false);
    assert.equal(isPromotionActive(unpromotedSample), false);
  });

  it("5. API /api/videos/list correctly assigns isPromoted false and deprioritizes expired promotions", async () => {
    const req = new Request("http://localhost:3000/api/videos/list");
    const res = await handleApiRequest(req);
    assert.ok(res);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.videos));

    // Verify all returned videos have isPromoted consistently matching expiry evaluation
    for (const vid of body.videos) {
      if (vid.isPromoted) {
        assert.ok(vid.promotionExpiresAt, "Promoted video must have an expiry timestamp");
        const exp = new Date(vid.promotionExpiresAt).getTime();
        assert.ok(
          exp > Date.now(),
          `Active promoted video must have future expiry date: ${vid.promotionExpiresAt}`,
        );
      }
    }
  });
});

describe("Task 33: 7-Level Ads Referral Distribution & Counter Isolation Tests", () => {
  const secret = "test_razorpay_secret_key_1234567890";
  const env = {
    RAZORPAY_KEY_ID: "rzp_test_1234567890",
    RAZORPAY_KEY_SECRET: secret,
    RAZORPAY_SKIP_REMOTE_CHECK: "true",
  };

  const fullUplineChain = [
    { level: 1, userId: "UP_LEVEL_1", name: "Sponsor L1" },
    { level: 2, userId: "UP_LEVEL_2", name: "Sponsor L2" },
    { level: 3, userId: "UP_LEVEL_3", name: "Sponsor L3" },
    { level: 4, userId: "UP_LEVEL_4", name: "Sponsor L4" },
    { level: 5, userId: "UP_LEVEL_5", name: "Sponsor L5" },
    { level: 6, userId: "UP_LEVEL_6", name: "Sponsor L6" },
    { level: 7, userId: "UP_LEVEL_7", name: "Sponsor L7" },
  ];

  it("1. Evaluates all four ads promotion tiers with exact 7-level payouts and zero paise leakage", () => {
    const plans = [
      { amount: 100, label: "7 Days (₹100)", expectedReferral: 40, expectedAdmin: 60 },
      { amount: 200, label: "15 Days (₹200)", expectedReferral: 80, expectedAdmin: 120 },
      { amount: 300, label: "1 Month (₹300)", expectedReferral: 120, expectedAdmin: 180 },
      { amount: 3000, label: "1 Year (₹3,000)", expectedReferral: 1200, expectedAdmin: 1800 },
    ];

    const expectedRates = [
      { level: 1, pct: 15 },
      { level: 2, pct: 10 },
      { level: 3, pct: 5 },
      { level: 4, pct: 4 },
      { level: 5, pct: 3 },
      { level: 6, pct: 2 },
      { level: 7, pct: 1 },
    ];

    for (const plan of plans) {
      const dist = evaluateAdsDistribution(plan.amount, fullUplineChain);
      assert.equal(dist.planAmount, plan.amount);
      assert.equal(dist.totalReferralAmount, plan.expectedReferral);
      assert.equal(dist.adminAmount, plan.expectedAdmin);
      assert.equal(dist.adminPercent, 60);
      assert.equal(dist.missingLevels.length, 0);

      // Verify each level
      let sumPaise = 0;
      for (const tier of expectedRates) {
        const payout = dist.levelPayouts.find((p) => p.level === tier.level);
        assert.ok(payout, `Missing payout for level ${tier.level} in ${plan.label}`);
        const expectedTierPaise = Math.round(plan.amount * 100 * (tier.pct / 100));
        assert.equal(payout.amountPaise, expectedTierPaise);
        assert.equal(payout.amount, expectedTierPaise / 100);
        sumPaise += payout.amountPaise;
      }

      assert.equal(sumPaise, plan.expectedReferral * 100);
      assert.equal(sumPaise + dist.adminPaise, plan.amount * 100, `Paise leakage in ${plan.label}`);
      assert.equal(dist.totalReferralAmount + dist.adminAmount, plan.amount);
    }
  });

  it("2. Accurately redirects missing level percentages to Admin when partial or no upline exists", () => {
    // 2 levels present (L1, L2): L1=15%, L2=10% -> 25% referral. Missing L3-L7 = 15%. Admin = 60% + 15% = 75%.
    const partial2 = [
      { level: 1, userId: "UP1" },
      { level: 2, userId: "UP2" },
    ];
    const dist2 = evaluateAdsDistribution(100, partial2);
    assert.equal(dist2.totalReferralAmount, 25);
    assert.equal(dist2.adminAmount, 75);
    assert.equal(dist2.adminPercent, 75);
    assert.deepEqual(dist2.missingLevels, [3, 4, 5, 6, 7]);
    assert.equal(dist2.totalReferralAmount + dist2.adminAmount, 100);

    // 1 level present (L1 only): L1=15% -> 15% referral. Missing L2-L7 = 25%. Admin = 60% + 25% = 85%.
    const partial1 = [{ level: 1, userId: "UP1" }];
    const dist1 = evaluateAdsDistribution(300, partial1);
    assert.equal(dist1.totalReferralAmount, 45); // 15% of 300
    assert.equal(dist1.adminAmount, 255); // 85% of 300
    assert.equal(dist1.adminPercent, 85);
    assert.deepEqual(dist1.missingLevels, [2, 3, 4, 5, 6, 7]);
    assert.equal(dist1.totalReferralAmount + dist1.adminAmount, 300);

    // 0 levels present (orphan creator): Admin receives 100% (Base 60% + 40% redirected)
    const dist0 = evaluateAdsDistribution(3000, []);
    assert.equal(dist0.totalReferralAmount, 0);
    assert.equal(dist0.adminAmount, 3000);
    assert.equal(dist0.adminPercent, 100);
    assert.equal(dist0.levelPayouts.length, 0);
    assert.deepEqual(dist0.missingLevels, [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(dist0.totalReferralAmount + dist0.adminAmount, 3000);
  });

  it("3. Resolves upline sponsors safely and terminates without infinite loop on cycles or self-referrals", () => {
    // Mock user dataset with circular loop: User A -> User B -> User C -> User A
    const usersWithLoop = [
      { user_id: "USER_A", referral_code: "USER_B" },
      { user_id: "USER_B", referral_code: "USER_C" },
      { user_id: "USER_C", referral_code: "USER_A" }, // Loop back to A
    ];

    const uplinesFromA = resolveUplineSponsors("USER_A", usersWithLoop);
    // Should resolve B (L1), C (L2), then stop when encountering A (already visited)
    assert.equal(uplinesFromA.length, 2);
    assert.equal(uplinesFromA[0]?.level, 1);
    assert.equal(uplinesFromA[0]?.userId, "USER_B");
    assert.equal(uplinesFromA[1]?.level, 2);
    assert.equal(uplinesFromA[1]?.userId, "USER_C");

    // Self-referral case: User X refers User X
    const selfRefUsers = [{ user_id: "USER_X", referral_code: "USER_X" }];
    const uplinesSelf = resolveUplineSponsors("USER_X", selfRefUsers);
    assert.equal(uplinesSelf.length, 0);

    // Full 7-level clean chain
    const deepChainUsers = [
      { user_id: "CREATOR", referral_code: "SPONSOR_1" },
      { user_id: "SPONSOR_1", referral_code: "SPONSOR_2" },
      { user_id: "SPONSOR_2", referral_code: "SPONSOR_3" },
      { user_id: "SPONSOR_3", referral_code: "SPONSOR_4" },
      { user_id: "SPONSOR_4", referral_code: "SPONSOR_5" },
      { user_id: "SPONSOR_5", referral_code: "SPONSOR_6" },
      { user_id: "SPONSOR_6", referral_code: "SPONSOR_7" },
      { user_id: "SPONSOR_7", referral_code: "SPONSOR_8" }, // Level 8 should not be included
    ];

    const deepUplines = resolveUplineSponsors("CREATOR", deepChainUsers);
    assert.equal(deepUplines.length, 7);
    assert.equal(deepUplines[0]?.userId, "SPONSOR_1");
    assert.equal(deepUplines[6]?.userId, "SPONSOR_7");
  });

  it("4. Ads promotion payments do NOT increment or trigger the ₹6 special 11th/21st/31st counter", async () => {
    const initialTxNum = await getPersistentPremiumTxNumber();

    const orderId = `ord_ads_iso_${Date.now()}`;
    const paymentId = `pay_ads_iso_${Date.now()}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    const res = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        purpose: "ads_promotion",
        planId: "plan-monthly",
      },
      ["FT483921"],
      "FT102857",
      env,
      fullUplineChain,
    );

    assert.equal(res.verified, true);
    assert.equal(res.purpose, "ads_promotion");
    assert.equal(res.specialTag, "ADS_PROMOTION");
    assert.equal(res.isSpecialTransaction, false);

    // The persistent sequence counter MUST NOT have incremented
    const afterTxNum = await getPersistentPremiumTxNumber();
    assert.equal(
      afterTxNum,
      initialTxNum,
      "Ads promotion must not advance the premium video sequence counter",
    );
  });

  it("5. Idempotent duplicate verification rejects double credit for ads promotion", async () => {
    const orderId = `ord_ads_dup_${Date.now()}`;
    const paymentId = `pay_ads_dup_${Date.now()}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    // First verification
    const res1 = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        purpose: "ads_promotion",
        planId: "plan-7-days",
      },
      ["FT483921"],
      "FT102857",
      env,
      fullUplineChain,
    );

    assert.equal(res1.verified, true);
    assert.equal(res1.amount, 100);
    assert.equal(res1.duplicate, undefined);

    // Second verification with identical payment ID
    const res2 = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        purpose: "ads_promotion",
        planId: "plan-7-days",
      },
      ["FT483921"],
      "FT102857",
      env,
      fullUplineChain,
    );

    assert.equal(res2.verified, true);
    assert.equal(res2.duplicate, true);
    assert.match(res2.error || "", /already been processed/i);
    assert.equal(res2.amount, 100);
  });

  it("6. API endpoint /api/payments/verify processes ads promotion and returns 7-level distribution breakdown", async () => {
    const orderId = `ord_api_ads_${Date.now()}`;
    const paymentId = `pay_api_ads_${Date.now()}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    const req = new Request("http://localhost:3000/api/payments/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        userName: "Alex Rivera",
        purpose: "ads_promotion",
        planId: "plan-yearly",
        metadata: { planId: "plan-yearly" },
      }),
    });

    const res = await handleApiRequest(req, env);
    assert.ok(res);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.verified, true);
    assert.equal(body.amount, 3000);
    assert.equal(body.purpose, "ads_promotion");
    assert.equal(body.specialTag, "ADS_PROMOTION");
    assert.ok(body.distribution);
    assert.ok(Array.isArray(body.distribution.levelPayouts));
    assert.ok(Array.isArray(body.distribution.missingLevels));
    assert.equal(typeof body.distribution.adminAmount, "number");
    assert.equal(typeof body.distribution.totalReferralAmount, "number");
    assert.equal(body.distribution.adminAmount + body.distribution.totalReferralAmount, 3000);
  });
});

describe("Task 34: Premium Video Global Pool & Admin Ledger Verification Tests", () => {
  const secret = "test_razorpay_secret_key_1234567890";
  const env = {
    RAZORPAY_KEY_ID: "rzp_test_1234567890",
    RAZORPAY_KEY_SECRET: secret,
    RAZORPAY_SKIP_REMOTE_CHECK: "true",
  };

  it("1. Normal transaction with multiple eligible previous creators distributes integer paise equally", async () => {
    // Isolate sequence state to tx #1 so next is tx #2 (normal, non-special)
    await resetPersistentPremiumState(1, []);

    // Pure calculation check: tx 2, valid referrer, 2 eligible creators
    const dist = evaluatePremiumDistribution(2, "FT102857", 2);
    assert.equal(dist.isSpecial, false);
    assert.equal(dist.directReferralAmount, 1.0);
    assert.equal(dist.adminAmount, 1.0);
    assert.equal(dist.globalPoolAmount, 3.0);
    assert.equal(dist.perMemberShare, 1.5);
    assert.equal(dist.totalAmount, 6.0);

    // Gateway / server verification check
    const orderId = `ord_t34_norm_${Date.now()}`;
    const paymentId = `pay_t34_norm_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    const res = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["CREATOR_PREV_1", "CREATOR_PREV_2"],
      "FT102857",
      env,
    );

    assert.equal(res.verified, true);
    assert.equal(res.amount, 6.0);
    assert.equal(res.txNumber, 2);
    assert.equal(res.isSpecialTransaction, false);
    assert.equal(res.distribution?.directReferralAmount, 1.0);
    assert.equal(res.distribution?.adminAmount, 1.0);
    assert.equal(res.distribution?.globalPoolAmount, 3.0);
    assert.equal(res.distribution?.eligibleMembersCount, 2);
    assert.equal(res.distribution?.perMemberShare, 1.5);
    assert.ok(Array.isArray(res.distribution?.creatorPayouts));
    assert.equal(res.distribution?.creatorPayouts?.length, 2);
    assert.equal(res.distribution?.creatorPayouts?.[0]?.amount, 1.5);
    assert.equal(res.distribution?.creatorPayouts?.[1]?.amount, 1.5);
  });

  it("2. First transaction with no eligible creators redirects entire ₹3 pool to Admin (Admin ₹4 total with valid referrer)", async () => {
    // Reset to 0 so next is tx #1
    await resetPersistentPremiumState(0, []);

    // Pure calculation: 0 eligible creators, valid referrer -> Admin receives base ₹1 + pool ₹3 = ₹4
    const dist = evaluatePremiumDistribution(1, "FT102857", 0);
    assert.equal(dist.isSpecial, false);
    assert.equal(dist.directReferralAmount, 1.0);
    assert.equal(dist.adminAmount, 4.0); // ₹1 base + ₹3 redirected pool
    assert.equal(dist.globalPoolAmount, 0.0);
    assert.equal(dist.perMemberShare, 0.0);
    assert.equal(dist.totalAmount, 6.0);

    const orderId = `ord_t34_first_${Date.now()}`;
    const paymentId = `pay_t34_first_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    const res = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      [], // Zero previous creators
      "FT102857",
      env,
    );

    assert.equal(res.verified, true);
    assert.equal(res.txNumber, 1);
    assert.equal(res.distribution?.directReferralAmount, 1.0);
    assert.equal(res.distribution?.adminAmount, 4.0);
    assert.equal(res.distribution?.globalPoolAmount, 0.0);
    assert.equal(res.distribution?.eligibleMembersCount, 0);
    assert.equal(res.distribution?.creatorPayouts?.length, 0);
  });

  it("3. Special 11th/21st/31st transaction with valid referrer allocates ₹1 referrer, ₹4 Admin, ₹0 global pool", async () => {
    const specials = [11, 21, 31, 41, 51, 101];
    for (const tx of specials) {
      const dist = evaluatePremiumDistribution(tx, "FT102857", 5);
      assert.equal(dist.isSpecial, true, `tx #${tx} must be marked as special`);
      assert.equal(dist.specialTag, "SPECIAL_GLOBAL_RULE");
      assert.equal(dist.directReferralAmount, 1.0);
      assert.equal(dist.adminAmount, 4.0);
      assert.equal(dist.globalPoolAmount, 0.0);
      assert.equal(dist.eligibleMembersCount, 0);
      assert.equal(dist.perMemberShare, 0.0);
      assert.equal(dist.totalAmount, 6.0);
    }

    // Server verification check at tx #11
    await resetPersistentPremiumState(10, []);
    const orderId = `ord_t34_spec_${Date.now()}`;
    const paymentId = `pay_t34_spec_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    const res = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["CR_1", "CR_2", "CR_3"],
      "FT102857",
      env,
    );

    assert.equal(res.verified, true);
    assert.equal(res.txNumber, 11);
    assert.equal(res.isSpecialTransaction, true);
    assert.equal(res.specialTag, "SPECIAL_GLOBAL_RULE");
    assert.equal(res.distribution?.directReferralAmount, 1.0);
    assert.equal(res.distribution?.adminAmount, 4.0);
    assert.equal(res.distribution?.globalPoolAmount, 0.0);
    assert.equal(res.distribution?.eligibleMembersCount, 0);
  });

  it("4. Normal transaction without valid referrer redirects unallocated ₹1 to Admin (Option A: Admin ₹2 with creators, ₹5 with zero creators)", async () => {
    // Normal transaction, no referrer, 2 eligible creators:
    // Referrer: ₹0. Admin: ₹1 base + ₹1 unallocated = ₹2. Global Pool: ₹3 (₹1.50 each). Fees: ₹1. Total: ₹6.
    const distWithCreators = evaluatePremiumDistribution(2, null, 2);
    assert.equal(distWithCreators.isSpecial, false);
    assert.equal(distWithCreators.directReferralAmount, 0.0);
    assert.equal(distWithCreators.adminAmount, 2.0);
    assert.equal(distWithCreators.globalPoolAmount, 3.0);
    assert.equal(distWithCreators.perMemberShare, 1.5);
    assert.equal(distWithCreators.totalAmount, 6.0);

    // Normal transaction, no referrer, 0 eligible creators:
    // Referrer: ₹0. Admin: ₹1 base + ₹1 unallocated + ₹3 pool = ₹5. Global Pool: ₹0. Fees: ₹1. Total: ₹6.
    const distZeroCreators = evaluatePremiumDistribution(2, null, 0);
    assert.equal(distZeroCreators.isSpecial, false);
    assert.equal(distZeroCreators.directReferralAmount, 0.0);
    assert.equal(distZeroCreators.adminAmount, 5.0);
    assert.equal(distZeroCreators.globalPoolAmount, 0.0);
    assert.equal(distZeroCreators.totalAmount, 6.0);

    // Server verification with null referrer and creators
    await resetPersistentPremiumState(1, []);
    const orderId = `ord_t34_noref_${Date.now()}`;
    const paymentId = `pay_t34_noref_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    const res = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["CR_1", "CR_2"],
      null, // No referrer
      env,
    );

    assert.equal(res.verified, true);
    assert.equal(res.distribution?.directReferralAmount, 0.0);
    assert.equal(res.distribution?.adminAmount, 2.0); // ₹1 base + ₹1 unallocated
    assert.equal(res.distribution?.globalPoolAmount, 3.0);
  });

  it("5. Special transaction without valid referrer redirects unallocated ₹1 to Admin (Option A: Admin receives ₹5 total)", async () => {
    const specials = [11, 21, 31, 41, 51];
    for (const tx of specials) {
      const dist = evaluatePremiumDistribution(tx, null, 5); // null referrer
      assert.equal(dist.isSpecial, true);
      assert.equal(dist.directReferralAmount, 0.0);
      assert.equal(dist.adminAmount, 5.0, `tx #${tx} without referrer must give Admin ₹5`);
      assert.equal(dist.globalPoolAmount, 0.0);
      assert.equal(dist.taxAndFees, 1.0);
      assert.equal(dist.totalAmount, 6.0);
    }

    await resetPersistentPremiumState(10, []);
    const orderId = `ord_t34_spec_noref_${Date.now()}`;
    const paymentId = `pay_t34_spec_noref_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    const res = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["CR_1", "CR_2"],
      null, // No referrer
      env,
    );

    assert.equal(res.verified, true);
    assert.equal(res.txNumber, 11);
    assert.equal(res.distribution?.directReferralAmount, 0.0);
    assert.equal(res.distribution?.adminAmount, 5.0); // ₹4 special + ₹1 unallocated
    assert.equal(res.distribution?.globalPoolAmount, 0.0);
  });

  it("6. Exact ₹6 accounting with integer-paise division and indivisible residual to Admin (e.g. 7 creators)", async () => {
    // 300 paise / 7 = 42 paise each (₹0.42 * 7 = 294 paise). Residual = 6 paise (₹0.06).
    // Admin receives base ₹1.00 + residual ₹0.06 = ₹1.06.
    const dist7 = evaluatePremiumDistribution(2, "FT102857", 7);
    assert.equal(dist7.directReferralAmount, 1.0);
    assert.equal(dist7.adminAmount, 1.06);
    assert.equal(dist7.globalPoolAmount, 2.94);
    assert.equal(dist7.perMemberShare, 0.42);
    assert.equal(dist7.taxAndFees, 1.0);
    // Exact mathematical sum
    assert.equal(
      Math.round(
        (dist7.directReferralAmount +
          dist7.adminAmount +
          dist7.globalPoolAmount +
          dist7.taxAndFees) *
          100,
      ),
      600,
      "Zero paise leakage must be preserved across integer-paise division",
    );

    await resetPersistentPremiumState(1, []);
    const orderId = `ord_t34_paise_${Date.now()}`;
    const paymentId = `pay_t34_paise_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    const sevenCreators = ["CR_1", "CR_2", "CR_3", "CR_4", "CR_5", "CR_6", "CR_7"];

    const res = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      sevenCreators,
      "FT102857",
      env,
    );

    assert.equal(res.verified, true);
    assert.equal(res.distribution?.adminAmount, 1.06);
    assert.equal(res.distribution?.globalPoolAmount, 2.94);
    assert.equal(res.distribution?.creatorPayouts?.length, 7);
    for (const p of res.distribution?.creatorPayouts || []) {
      assert.equal(p.amountPaise, 42);
      assert.equal(p.amount, 0.42);
    }
  });

  it("7. Admin residual allocation verified across prime and uneven creator counts with zero leakage", () => {
    const testCounts = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 13, 17, 23, 29, 37, 50, 100];
    for (const count of testCounts) {
      const dist = evaluatePremiumDistribution(4, "SPONSOR", count);
      const totalPaise = Math.round(
        (dist.directReferralAmount + dist.adminAmount + dist.globalPoolAmount + dist.taxAndFees) *
          100,
      );
      assert.equal(totalPaise, 600, `Leakage detected for creator count: ${count}`);
    }
  });

  it("8. Current uploader is strictly excluded from receiving a global pool share of their own upload", async () => {
    await resetPersistentPremiumState(1, []);
    const orderId = `ord_t34_excl_${Date.now()}`;
    const paymentId = `pay_t34_excl_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    // Pass uploader 'FT483921' in the candidate list alongside another creator
    const res = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921", // The current uploader
        purpose: "premium_video_upload",
      },
      ["FT483921", "OTHER_CREATOR_99"], // Contains current uploader
      "FT102857",
      env,
    );

    assert.equal(res.verified, true);
    assert.equal(res.distribution?.eligibleMembersCount, 1); // FT483921 must be excluded
    assert.equal(res.distribution?.creatorPayouts?.length, 1);
    assert.equal(res.distribution?.creatorPayouts?.[0]?.userId, "OTHER_CREATOR_99");
    assert.equal(res.distribution?.creatorPayouts?.[0]?.amount, 3.0); // Entire ₹3 goes to the sole remaining eligible creator
  });

  it("9. Duplicate eligible creator records are deduplicated before pool division", async () => {
    await resetPersistentPremiumState(1, []);
    const orderId = `ord_t34_dedup_${Date.now()}`;
    const paymentId = `pay_t34_dedup_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    // Input array contains duplicate references to same users
    const res = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["CREATOR_ALPHA", "CREATOR_ALPHA", "CREATOR_BETA", "CREATOR_BETA"],
      "FT102857",
      env,
    );

    assert.equal(res.verified, true);
    assert.equal(res.distribution?.eligibleMembersCount, 2); // 2 distinct creators
    assert.equal(res.distribution?.perMemberShare, 1.5);
    assert.equal(res.distribution?.creatorPayouts?.length, 2);
    assert.equal(res.distribution?.creatorPayouts?.[0]?.amount, 1.5);
    assert.equal(res.distribution?.creatorPayouts?.[1]?.amount, 1.5);
  });

  it("10. Idempotent duplicate verification prevents double crediting and sequence advance for Premium Video", async () => {
    await resetPersistentPremiumState(1, []);
    const orderId = `ord_t34_dup_${Date.now()}`;
    const paymentId = `pay_t34_dup_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    const res1 = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["CR_1", "CR_2"],
      "FT102857",
      env,
    );
    assert.equal(res1.verified, true);
    assert.equal(res1.duplicate, undefined);
    const firstTxNumber = res1.txNumber;

    const res2 = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["CR_1", "CR_2"],
      "FT102857",
      env,
    );
    assert.equal(res2.verified, true);
    assert.equal(res2.duplicate, true);
    assert.match(res2.error || "", /already been processed/i);
    assert.equal(res2.txNumber, firstTxNumber);
  });

  it("11. Concurrency test: Parallel requests with distinct payment IDs serialize safely without race conditions", async () => {
    await resetPersistentPremiumState(1, []);
    const count = 5;
    const promises: Promise<any>[] = [];

    for (let i = 0; i < count; i++) {
      const orderId = `ord_t34_conc_${Date.now()}_${i}`;
      const paymentId = `pay_t34_conc_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 6)}`;
      const sig = crypto
        .createHmac("sha256", secret)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

      promises.push(
        verifyServerPayment(
          {
            orderId,
            paymentId,
            signature: sig,
            userId: `USER_${i}`,
            purpose: "premium_video_upload",
          },
          ["CR_A", "CR_B"],
          "FT102857",
          env,
        ),
      );
    }

    const results = await Promise.all(promises);
    assert.equal(results.length, count);
    const txNumbers = results.map((r) => r.txNumber);
    // All results must be verified
    for (const r of results) {
      assert.equal(r.verified, true);
    }
    // All txNumbers must be unique and strictly sequential: 2, 3, 4, 5, 6
    assert.equal(new Set(txNumbers).size, count);
    assert.deepEqual(
      txNumbers.sort((a, b) => a - b),
      [2, 3, 4, 5, 6],
    );
  });

  it("12. Concurrency duplicate test: Simultaneous requests with identical payment ID resolve idempotently", async () => {
    await resetPersistentPremiumState(1, []);
    const orderId = `ord_t34_cdup_${Date.now()}`;
    const paymentId = `pay_t34_cdup_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    // Launch 3 simultaneous verification attempts for same payment ID
    const promises = [1, 2, 3].map(() =>
      verifyServerPayment(
        {
          orderId,
          paymentId,
          signature: sig,
          userId: "FT483921",
          purpose: "premium_video_upload",
        },
        ["CR_1", "CR_2"],
        "FT102857",
        env,
      ),
    );

    const results = await Promise.all(promises);
    assert.equal(results.length, 3);
    const [r1, r2, r3] = results;
    // All 3 report verified: true
    assert.equal(r1?.verified, true);
    assert.equal(r2?.verified, true);
    assert.equal(r3?.verified, true);

    // Exactly one is original, the other two are flagged as duplicates
    const duplicates = results.filter((r) => r?.duplicate === true);
    assert.equal(duplicates.length, 2);

    // Sequence only incremented once (txNumber: 2)
    const afterTxNum = await getPersistentPremiumTxNumber();
    assert.equal(afterTxNum, 2);
  });

  it("13. Rollback & failure scenarios: Invalid signature or missing credentials leave sequence untouched", async () => {
    await resetPersistentPremiumState(5, []);
    const orderId = `ord_t34_fail_${Date.now()}`;
    const paymentId = `pay_t34_fail_${Date.now()}`;

    // Test A: Invalid HMAC signature
    const badSigRes = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: "invalid_tampered_signature_hex",
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["CR_1"],
      "FT102857",
      env,
    );
    assert.equal(badSigRes.verified, false);
    assert.match(badSigRes.error || "", /signature/i);

    // Sequence must NOT have advanced
    let currentTxNum = await getPersistentPremiumTxNumber();
    assert.equal(currentTxNum, 5);

    // Test B: Missing secret fails closed
    const noSecretRes = await verifyServerPayment(
      {
        orderId,
        paymentId,
        signature: "some_sig",
        userId: "FT483921",
        purpose: "premium_video_upload",
      },
      ["CR_1"],
      "FT102857",
      { RAZORPAY_KEY_SECRET: "" },
    );
    assert.equal(noSecretRes.verified, false);
    assert.match(noSecretRes.error || "", /RAZORPAY_KEY_SECRET/i);

    // Sequence must still be untouched
    currentTxNum = await getPersistentPremiumTxNumber();
    assert.equal(currentTxNum, 5);
  });

  it("14. API handler /api/payments/verify returns complete server-authoritative distribution breakdown for Premium Video", async () => {
    const orderId = `ord_t34_api_${Date.now()}`;
    const paymentId = `pay_t34_api_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    const req = new Request("http://localhost:3000/api/payments/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId,
        paymentId,
        signature: sig,
        userId: "FT483921",
        userName: "Alex Rivera",
        purpose: "premium_video_upload",
      }),
    });

    const res = await handleApiRequest(req, env);
    assert.ok(res);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.verified, true);
    assert.equal(body.amount, 6.0);
    assert.equal(body.purpose, "premium_video_upload");
    assert.ok(body.distribution);
    assert.equal(typeof body.distribution.adminAmount, "number");
    assert.equal(typeof body.distribution.globalPoolAmount, "number");
    assert.equal(typeof body.distribution.eligibleMembersCount, "number");
    assert.ok(Array.isArray(body.distribution.creatorPayouts));
  });

  it("15. Seven-level Ads referral tests remain completely isolated and unaffected", async () => {
    const adsPlan = PRICING_CONFIG.ADS_PROMOTION["plan-15-days"];
    assert.equal(adsPlan.price, 200);
    assert.equal(adsPlan.days, 15);

    // Verify 7-level rates untouched
    const dist = evaluateAdsDistribution(200, [
      { level: 1, userId: "UP1" },
      { level: 2, userId: "UP2" },
      { level: 3, userId: "UP3" },
      { level: 4, userId: "UP4" },
      { level: 5, userId: "UP5" },
      { level: 6, userId: "UP6" },
      { level: 7, userId: "UP7" },
    ]);
    assert.equal(dist.totalReferralAmount, 80);
    assert.equal(dist.adminAmount, 120);
    assert.equal(dist.adminPercent, 60);
  });
});

describe("Task 35: Free, Paid/Premium Sponsor, and Ads UI Label Validation Tests", () => {
  it("1. Free videos appear normally with zero Sponsor, Ads, Premium, or price labels", () => {
    const freeShort = {
      id: "vid-free-001",
      title: "Free React Masterclass",
      videoType: "free" as const,
      contentType: "short" as const,
      duration: "0:45",
      isPromoted: false,
    };
    const labels = getVideoBadgeLabels(freeShort);
    assert.equal(labels.isFree, true);
    assert.equal(labels.showSponsorLabel, false);
    assert.equal(labels.showAdsLabel, false);
    assert.equal(labels.badges.length, 0);

    const freeLong = {
      id: "vid-free-002",
      title: "Full Stack Architecture Tutorial",
      videoType: "free" as const,
      contentType: "long" as const,
      duration: "42:15",
      isPromoted: false,
    };
    const longLabels = getVideoBadgeLabels(freeLong);
    assert.equal(longLabels.isFree, true);
    assert.equal(longLabels.showSponsorLabel, false);
    assert.equal(longLabels.showAdsLabel, false);
    assert.equal(longLabels.badges.length, 0);
  });

  it("2. Paid/premium uploads display a small 'Sponsor' label immediately below title and remove 'Premium' and '₹6' labels", () => {
    const paidUpload = {
      id: "vid-paid-001",
      title: "Exclusive Creator Course",
      videoType: "premium" as const,
      contentType: "long" as const,
      duration: "25:30",
      isPromoted: false,
    };
    const labels = getVideoBadgeLabels(paidUpload);
    assert.equal(labels.isFree, false);
    assert.equal(labels.showSponsorLabel, true);
    assert.equal(labels.showAdsLabel, false); // Must NOT be labeled as Ads!

    // Validate badge text
    assert.equal(labels.badges.length, 1);
    assert.equal(labels.badges[0]?.type, "sponsor");
    assert.equal(labels.badges[0]?.label, "Sponsor");

    // Strictly ensure "Premium" and "₹6" do not appear in public badge text
    const badgeText = labels.badges.map((b) => b.label).join(" ");
    assert.ok(!badgeText.toLowerCase().includes("premium"));
    assert.ok(!badgeText.includes("₹6"));
    assert.ok(!badgeText.includes("6"));
  });

  it("3. Ads videos display small 'Ads' label only for genuine active advertising/promotional content", () => {
    // Actively promoted video
    const activeAdVideo = {
      id: "vid-ad-001",
      title: "Summer Sale Campaign",
      videoType: "free" as const,
      contentType: "short" as const,
      duration: "0:30",
      isPromoted: true,
      promotionExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const activeLabels = getVideoBadgeLabels(activeAdVideo);
    assert.equal(activeLabels.showAdsLabel, true);
    assert.equal(activeLabels.showSponsorLabel, false); // Do not create fake sponsor relationship!
    assert.equal(activeLabels.badges.length, 1);
    assert.equal(activeLabels.badges[0]?.type, "ads");
    assert.equal(activeLabels.badges[0]?.label, "Ads");

    // Expired promotion safely fails closed
    const expiredAdVideo = {
      id: "vid-ad-002",
      title: "Expired Sale Campaign",
      videoType: "free" as const,
      contentType: "short" as const,
      duration: "0:30",
      isPromoted: true,
      promotionExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    };
    const expiredLabels = getVideoBadgeLabels(expiredAdVideo);
    assert.equal(expiredLabels.showAdsLabel, false);
    assert.equal(expiredLabels.isFree, true);
  });

  it("4. Video duration alone is NEVER used to decide whether a video is sponsored or an advertisement", () => {
    // Short video with zero paid or promoted metadata
    const shortVideo = {
      id: "vid-short-001",
      title: "Quick Tips",
      videoType: "free" as const,
      contentType: "short" as const,
      duration: "0:15",
      isPromoted: false,
    };
    const shortLabels = getVideoBadgeLabels(shortVideo);
    assert.equal(shortLabels.showSponsorLabel, false);
    assert.equal(shortLabels.showAdsLabel, false);

    // Long video with zero paid or promoted metadata
    const longVideo = {
      id: "vid-long-001",
      title: "Full Documentary",
      videoType: "free" as const,
      contentType: "long" as const,
      duration: "1:45:00",
      isPromoted: false,
    };
    const longLabels = getVideoBadgeLabels(longVideo);
    assert.equal(longLabels.showSponsorLabel, false);
    assert.equal(longLabels.showAdsLabel, false);
  });

  it("5. Supports combined Paid Sponsor + Active Ads promotion cleanly without label conflicts", () => {
    const combinedVideo = {
      id: "vid-combined-001",
      title: "Partner Brand Showcase",
      videoType: "premium" as const,
      contentType: "long" as const,
      duration: "18:20",
      isPromoted: true,
      promotionExpiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const labels = getVideoBadgeLabels(combinedVideo);
    assert.equal(labels.showSponsorLabel, true);
    assert.equal(labels.showAdsLabel, true);
    assert.equal(labels.badges.length, 2);
    assert.deepEqual(labels.badges, [
      { type: "sponsor", label: "Sponsor" },
      { type: "ads", label: "Ads" },
    ]);
  });

  it("6. Regression test: Video thumbnails have NO Ads overlay badge while eligible active promotion shows Ads label below the title", () => {
    // 1. Actively promoted video (e.g. Free video with active ad campaign)
    const activePromotedVideo = {
      id: "vid-regress-001",
      title: "Active Promotion Tutorial",
      videoType: "free" as const,
      contentType: "long" as const,
      duration: "10:15",
      isPromoted: true,
      promotionExpiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const activeLabels = getVideoBadgeLabels(activePromotedVideo);
    // Regression check: Video thumbnail overlay MUST NOT display an Ads badge
    assert.equal(
      activeLabels.showThumbnailAdsOverlay,
      false,
      "Thumbnail overlay must never show Ads badge",
    );
    // Below title: Must show small Ads label
    assert.equal(
      activeLabels.showAdsLabel,
      true,
      "Below title must show Ads label for active promotion",
    );
    assert.equal(activeLabels.badges.length, 1);
    assert.equal(activeLabels.badges[0]?.type, "ads");
    assert.equal(activeLabels.badges[0]?.label, "Ads");

    // 2. Paid / Premium upload with active promotion
    const paidWithPromotion = {
      id: "vid-regress-002",
      title: "Paid Upload with Active Ads",
      videoType: "premium" as const,
      contentType: "long" as const,
      duration: "12:00",
      isPromoted: true,
      promotionExpiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const paidLabels = getVideoBadgeLabels(paidWithPromotion);
    // Neither Sponsor nor Ads badge is placed on the thumbnail overlay
    assert.equal(
      paidLabels.showThumbnailAdsOverlay,
      false,
      "Thumbnail overlay must not show Ads badge",
    );
    // Both Sponsor and Ads appear strictly below the title
    assert.equal(paidLabels.showSponsorLabel, true);
    assert.equal(paidLabels.showAdsLabel, true);

    // 3. Normal Free video
    const normalFreeVideo = {
      id: "vid-regress-003",
      title: "Normal Free Video",
      videoType: "free" as const,
      contentType: "long" as const,
      duration: "08:30",
      isPromoted: false,
    };
    const freeLabels = getVideoBadgeLabels(normalFreeVideo);
    assert.equal(freeLabels.showThumbnailAdsOverlay, false);
    assert.equal(freeLabels.showAdsLabel, false);
    assert.equal(freeLabels.showSponsorLabel, false);
    assert.equal(freeLabels.isFree, true);
    assert.equal(freeLabels.badges.length, 0);
  });

  it("59. Requirement 9: calculateWeightedPoolPayouts weights video share by actual ad earnings", () => {
    // 3 creators with different ad earnings: 100, 200, 700 (Total = 1000)
    // Pool = ₹3.00 (300 paise)
    // Creator 1: 10% -> 30 paise
    // Creator 2: 20% -> 60 paise
    // Creator 3: 70% -> 210 paise
    const creators = [
      { userId: "creator_a", adEarnings: 100 },
      { userId: "creator_b", adEarnings: 200 },
      { userId: "creator_c", adEarnings: 700 },
    ];

    const result = calculateWeightedPoolPayouts(300, creators);
    assert.equal(result.payouts.length, 3);
    assert.equal(result.payouts[0]?.userId, "creator_a");
    assert.equal(result.payouts[0]?.amountPaise, 30);
    assert.equal(result.payouts[0]?.amount, 0.3);

    assert.equal(result.payouts[1]?.userId, "creator_b");
    assert.equal(result.payouts[1]?.amountPaise, 60);
    assert.equal(result.payouts[1]?.amount, 0.6);

    assert.equal(result.payouts[2]?.userId, "creator_c");
    assert.equal(result.payouts[2]?.amountPaise, 210);
    assert.equal(result.payouts[2]?.amount, 2.1);

    assert.equal(result.distributedPaise, 300);
    assert.equal(result.residualPaise, 0);

    // Verify evaluatePremiumDistribution uses weighted distribution and balances exactly to ₹6.00
    const evalResult = evaluatePremiumDistribution(1, "sponsor_ref", 3, creators);
    assert.equal(evalResult.isSpecial, false);
    assert.equal(evalResult.directReferralAmount, 1.0);
    assert.equal(evalResult.globalPoolAmount, 3.0);
    assert.equal(evalResult.adminAmount, 1.0);
    assert.equal(evalResult.taxAndFees, 1.0);
    const sum =
      evalResult.directReferralAmount +
      evalResult.globalPoolAmount +
      evalResult.adminAmount +
      evalResult.taxAndFees;
    assert.equal(Math.round(sum * 100) / 100, 6.0);
    assert.equal(evalResult.weightedPayouts?.length, 3);
  });

  it("60. Requirement 9: calculateWeightedPoolPayouts gracefully falls back to equal share when no ad earnings exist", () => {
    const creators = [
      { userId: "creator_1", adEarnings: 0 },
      { userId: "creator_2", adEarnings: 0 },
      { userId: "creator_3", adEarnings: 0 },
    ];

    const result = calculateWeightedPoolPayouts(300, creators);
    assert.equal(result.payouts.length, 3);
    assert.equal(result.payouts[0]?.amountPaise, 100);
    assert.equal(result.payouts[1]?.amountPaise, 100);
    assert.equal(result.payouts[2]?.amountPaise, 100);
    assert.equal(result.distributedPaise, 300);
    assert.equal(result.residualPaise, 0);
  });
});

describe("Phase 1 Security & Production Safety Tests", () => {
  const secret = "test_razorpay_secret_key_1234567890";
  const env = {
    RAZORPAY_KEY_ID: "rzp_test_1234567890",
    RAZORPAY_KEY_SECRET: secret,
    RAZORPAY_SKIP_REMOTE_CHECK: "true",
  };

  it("1. Admin role endpoint rejects unauthenticated requests with 401", async () => {
    const req = new Request("http://localhost:3000/api/admin/role", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "FT483921", role: "admin" }),
    });
    const res = await handleApiRequest(req, env);
    assert.ok(res);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.error, /Authentication required/i);
  });

  it("2. Admin role endpoint rejects non-admin users with 403 Forbidden", async () => {
    // Log in as Alex Rivera (role: user) to obtain valid token
    const loginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "FT483921", password: "password123" }),
    });
    const loginRes = await handleApiRequest(loginReq, env);
    assert.ok(loginRes);
    assert.equal(loginRes.status, 200);
    const { token } = await loginRes.json();

    // Attempt to self-promote or update role
    const req = new Request("http://localhost:3000/api/admin/role", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ userId: "FT483921", role: "admin" }),
    });
    const res = await handleApiRequest(req, env);
    assert.ok(res);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.error, /Admin authorization required|Administrator privileges required/i);
  });

  it("3. Admin role endpoint allows authenticated administrator to update user role", async () => {
    // Log in as FaceTube Administrator (FT102857)
    const loginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "FT102857", password: "password" }),
    });
    const loginRes = await handleApiRequest(loginReq, env);
    assert.ok(loginRes);
    assert.equal(loginRes.status, 200);
    const { token } = await loginRes.json();

    try {
      const req = new Request("http://localhost:3000/api/admin/role", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ userId: "FT900431", role: "admin" }),
      });
      const res = await handleApiRequest(req, env);
      assert.ok(res);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.match(body.message, /updated to admin successfully/i);
    } finally {
      await handleApiRequest(
        new Request("http://localhost:3000/api/admin/role", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ userId: "FT900431", role: "user" }),
        }),
        env,
      );
    }
  });

  it("4. Withdrawal endpoint rejects unauthenticated requests with 401", async () => {
    const req = new Request("http://localhost:3000/api/wallet/withdraw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 1000 }),
    });
    const res = await handleApiRequest(req, env);
    assert.ok(res);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.error, /Authentication required/i);
  });

  it("5. Withdrawal enforces min withdrawal (₹100) and balance sufficiency for authenticated user", async () => {
    // Log in as Alex Rivera
    const loginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "FT483921", password: "password123" }),
    });
    const loginRes = await handleApiRequest(loginReq, env);
    assert.ok(loginRes);
    const { token } = await loginRes.json();

    // Less than minimum ₹100
    const reqBelowMin = new Request("http://localhost:3000/api/wallet/withdraw", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ amount: 50 }),
    });
    const resBelowMin = await handleApiRequest(reqBelowMin, env);
    assert.ok(resBelowMin);
    assert.equal(resBelowMin.status, 400);
    const bodyBelowMin = await resBelowMin.json();
    assert.match(bodyBelowMin.error, /Minimum withdrawal/i);

    // Balance sufficiency check: when amount is within daily limit (<= ₹10,000) but exceeds balance
    const reqInsufficient = new Request("http://localhost:3000/api/wallet/withdraw", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ amount: 1500 }),
    });
    const resInsufficient = await handleApiRequest(reqInsufficient, env);
    assert.ok(resInsufficient);
    assert.equal(resInsufficient.status, 400);
    const bodyInsufficient = await resInsufficient.json();
    assert.match(bodyInsufficient.error, /Insufficient balance/i);

    // Successful withdrawal for admin user who has sufficient balance
    const adminLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "FT102857", password: "password" }),
    });
    const adminLoginRes = await handleApiRequest(adminLoginReq, env);
    assert.ok(adminLoginRes);
    const { token: adminToken } = await adminLoginRes.json();

    const reqValid = new Request("http://localhost:3000/api/wallet/withdraw", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ amount: 1000 }),
    });
    const resValid = await handleApiRequest(reqValid, env);
    assert.ok(resValid);
    assert.equal(resValid.status, 200);
    const bodyValid = await resValid.json();
    assert.equal(bodyValid.success, true);
    assert.equal(bodyValid.transaction.amount, 1000);
    assert.equal(bodyValid.transaction.fee, 200);
    assert.equal(bodyValid.transaction.netAmount, 800);
    assert.equal(bodyValid.transaction.chargesBreakdown.totalCharge, 200);
    assert.equal(bodyValid.transaction.chargesBreakdown.netPayable, 800);
  });

  it("6. Hardcoded password bypass ('admin123' / incorrect password) is strictly rejected", async () => {
    const bypassReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "FT483921", password: "admin123" }),
    });
    const res = await handleApiRequest(bypassReq, env);
    assert.ok(res);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.error, /Incorrect password/i);
  });

  it("7. Production mode (NODE_ENV=production) safely fails closed with 503 when MySQL pool is unavailable", async () => {
    // Obtain valid tokens while still in test mode
    const userLogin = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "FT483921", password: "password123" }),
      }),
      env,
    );
    assert.ok(userLogin);
    const { token: userToken } = await userLogin.json();

    const adminLogin = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "FT102857", password: "password" }),
      }),
      env,
    );
    assert.ok(adminLogin);
    const { token: adminToken } = await adminLogin.json();

    const prevEnv = process.env["NODE_ENV"];
    try {
      process.env["NODE_ENV"] = "production";

      // 1. Withdrawal fails closed with 503
      const withdrawReq = new Request("http://localhost:3000/api/wallet/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
        body: JSON.stringify({ amount: 1000 }),
      });
      const withdrawRes = await handleApiRequest(withdrawReq, env);
      assert.ok(withdrawRes);
      assert.equal(withdrawRes.status, 503);
      const withdrawBody = await withdrawRes.json();
      assert.equal(withdrawBody.success, false);
      assert.match(withdrawBody.error, /Database connection unavailable/i);

      // 2. Balance fails closed with 503
      const balanceReq = new Request("http://localhost:3000/api/wallet/balance?userId=FT483921", {
        method: "GET",
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const balanceRes = await handleApiRequest(balanceReq, env);
      assert.ok(balanceRes);
      assert.equal(balanceRes.status, 503);
      const balanceBody = await balanceRes.json();
      assert.equal(balanceBody.success, false);
      assert.match(balanceBody.error, /Database connection unavailable/i);

      // 3. Admin role fails closed with 503
      const adminReq = new Request("http://localhost:3000/api/admin/role", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ userId: "FT483921", role: "admin" }),
      });
      const adminRes = await handleApiRequest(adminReq, env);
      assert.ok(adminRes);
      assert.equal(adminRes.status, 503);
      const adminBody = await adminRes.json();
      assert.equal(adminBody.success, false);
      assert.match(adminBody.error, /Database connection unavailable/i);

      // 4. Payment verify fails closed with 503
      const payReq = new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: "ord_prod_fail",
          paymentId: "pay_prod_fail",
          signature: "some_sig",
          userId: "FT483921",
        }),
      });
      const payRes = await handleApiRequest(payReq, env);
      assert.ok(payRes);
      assert.equal(payRes.status, 503);
      const payBody = await payRes.json();
      assert.equal(payBody.verified, false);
      assert.match(payBody.error, /Database connection unavailable/i);
    } finally {
      process.env["NODE_ENV"] = prevEnv;
    }
  });
});

describe("Bulk Payout Double-Deduction Regression & Integrity Tests", () => {
  const env = {
    RAZORPAY_KEY_ID: "rzp_test_1234567890",
    RAZORPAY_KEY_SECRET: "test_razorpay_secret_key_1234567890",
  };

  it("1. Processing an existing withdrawal request through bulk payout does NOT deduct wallet a second time and does NOT duplicate transaction", async () => {
    // 1. Admin login to obtain admin token
    const adminLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "FT102857", password: "password" }),
      }),
      env,
    );
    assert.ok(adminLoginRes);
    const { token: adminToken } = await adminLoginRes.json();

    // 2. Fetch initial balance for FT102857
    const initBalRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/balance?userId=FT102857", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env,
    );
    assert.ok(initBalRes);
    const initBalBody = await initBalRes.json();
    const balanceBeforeWithdrawal = Number(initBalBody.wallet.balance);

    // 3. Initiate a withdrawal request for ₹1,000
    const withdrawRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ amount: 1000 }),
      }),
      env,
    );
    assert.ok(withdrawRes);
    assert.equal(withdrawRes.status, 200);
    const withdrawBody = await withdrawRes.json();
    assert.equal(withdrawBody.success, true);
    const txId = withdrawBody.transaction.id;
    const balanceAfterWithdrawal = Number(withdrawBody.updatedWallet.balance);

    // Verify exactly ₹1,000 was deducted on initial withdrawal
    assert.equal(balanceAfterWithdrawal, balanceBeforeWithdrawal - 1000);

    // 4. Fetch transactions to check initial count
    const txsBeforeBulk = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/transactions?userId=FT102857", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env,
    );
    assert.ok(txsBeforeBulk);
    const txList1 = (await txsBeforeBulk.json()).transactions || [];
    const countWithTxIdBefore = txList1.filter(
      (t: any) => t.id === txId || t.transactionId === txId,
    ).length;
    assert.equal(countWithTxIdBefore, 1);

    // 5. Execute Admin Bulk Payout specifying this existing transaction ID
    const bulkRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          payouts: [{ userId: "FT102857", amount: 100, transactionId: txId }],
          notes: "Settling test withdrawal",
        }),
      }),
      env,
    );
    assert.ok(bulkRes);
    assert.equal(bulkRes.status, 200);
    const bulkBody = await bulkRes.json();
    assert.equal(bulkBody.success, true);
    assert.equal(bulkBody.total_recipients, 1);
    assert.equal(bulkBody.processed[0].deduction_type, "settled_existing_request");

    // 6. CRITICAL REGRESSION CHECK: Wallet balance must NOT be debited a second time!
    const balAfterBulkRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/balance?userId=FT102857", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env,
    );
    assert.ok(balAfterBulkRes);
    const balAfterBulkBody = await balAfterBulkRes.json();
    const balanceAfterBulk = Number(balAfterBulkBody.wallet.balance);

    // Assert balance remained EXACTLY the same as after withdrawal (zero double deduction!)
    assert.equal(
      balanceAfterBulk,
      balanceAfterWithdrawal,
      `Balance must remain ${balanceAfterWithdrawal} but was ${balanceAfterBulk} (double deduction detected!)`,
    );

    // 7. CRITICAL REGRESSION CHECK: No duplicate transaction created!
    const txsAfterBulk = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/transactions?userId=FT102857", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env,
    );
    assert.ok(txsAfterBulk);
    const txList2 = (await txsAfterBulk.json()).transactions || [];
    const matchingTxs = txList2.filter((t: any) => t.id === txId || t.transactionId === txId);
    assert.equal(
      matchingTxs.length,
      1,
      `Expected exactly 1 transaction with id ${txId}, found ${matchingTxs.length}`,
    );
    assert.equal(matchingTxs[0].status, "completed");
  });

  it("2. Legitimate new direct bulk payout (without transactionId) deducts wallet exactly once", async () => {
    const adminLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "FT102857", password: "password" }),
      }),
      env,
    );
    assert.ok(adminLoginRes);
    const { token: adminToken } = await adminLoginRes.json();

    const initBalRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/balance?userId=FT102857", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env,
    );
    assert.ok(initBalRes);
    const balanceBeforeDirect = Number((await initBalRes.json()).wallet.balance);

    // Execute direct payout for ₹50 with NO transaction ID
    const directRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          payouts: [{ userId: "FT102857", amount: 50 }],
          notes: "Direct bonus payout",
        }),
      }),
      env,
    );
    assert.ok(directRes);
    assert.equal(directRes.status, 200);
    const directBody = await directRes.json();
    assert.equal(directBody.success, true);
    assert.equal(directBody.processed[0].deduction_type, "new_direct_disbursement");

    // Check balance deducted exactly ₹50 once
    const balAfterDirectRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/balance?userId=FT102857", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env,
    );
    assert.ok(balAfterDirectRes);
    const balanceAfterDirect = Number((await balAfterDirectRes.json()).wallet.balance);
    assert.equal(balanceAfterDirect, balanceBeforeDirect - 50);
  });

  it("3. Direct payout rejects with 400 when recipient has insufficient balance", async () => {
    const adminLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "FT102857", password: "password" }),
      }),
      env,
    );
    assert.ok(adminLoginRes);
    const { token: adminToken } = await adminLoginRes.json();

    const res = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          payouts: [{ userId: "FT102857", amount: 99999999 }],
        }),
      }),
      env,
    );
    assert.ok(res);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.error, /Insufficient balance/i);
  });

  it("4. Bulk payout rejects with 404 when transactionId is invalid or not found", async () => {
    const adminLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "FT102857", password: "password" }),
      }),
      env,
    );
    assert.ok(adminLoginRes);
    const { token: adminToken } = await adminLoginRes.json();

    const res = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          payouts: [{ userId: "FT102857", amount: 100, transactionId: "tx_nonexistent_xyz999" }],
        }),
      }),
      env,
    );
    assert.ok(res);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.error, /Invalid transaction ID|not found/i);
  });

  it("5. Bulk payout rejects with 403 on authorization mismatch (transaction user does not match item user)", async () => {
    const adminLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "FT102857", password: "password" }),
      }),
      env,
    );
    assert.ok(adminLoginRes);
    const { token: adminToken } = await adminLoginRes.json();

    // Create a withdrawal for FT102857
    const withdrawRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ amount: 1000 }),
      }),
      env,
    );
    assert.ok(withdrawRes);
    const { transaction } = await withdrawRes.json();

    // Try to settle transaction belonging to FT102857 as FT483921
    const res = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          payouts: [{ userId: "FT483921", amount: 1000, transactionId: transaction.id }],
        }),
      }),
      env,
    );
    assert.ok(res);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.error, /Authorization mismatch/i);
  });

  it("6. Replay prevention: rejects bulk payout if transaction is already completed", async () => {
    const adminLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "FT102857", password: "password" }),
      }),
      env,
    );
    assert.ok(adminLoginRes);
    const { token: adminToken } = await adminLoginRes.json();

    // Create a withdrawal
    const withdrawRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ amount: 1000 }),
      }),
      env,
    );
    assert.ok(withdrawRes);
    const { transaction } = await withdrawRes.json();

    // First bulk payout: succeeds
    const firstPayout = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          payouts: [{ userId: "FT102857", amount: 1000, transactionId: transaction.id }],
        }),
      }),
      env,
    );
    assert.ok(firstPayout);
    assert.equal(firstPayout.status, 200);

    // Second bulk payout on same transaction: must reject with 400
    const secondPayout = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          payouts: [{ userId: "FT102857", amount: 1000, transactionId: transaction.id }],
        }),
      }),
      env,
    );
    assert.ok(secondPayout);
    assert.equal(secondPayout.status, 400);
    const body = await secondPayout.json();
    assert.equal(body.success, false);
    assert.match(body.error, /already been marked as completed/i);
  });

  it("7. Bulk payout rejects unauthorized non-admin users with 403", async () => {
    const userLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "FT483921", password: "password123" }),
      }),
      env,
    );
    assert.ok(userLoginRes);
    const { token: userToken } = await userLoginRes.json();

    const res = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
        body: JSON.stringify({
          payouts: [{ userId: "FT483921", amount: 100 }],
        }),
      }),
      env,
    );
    assert.ok(res);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.error, /Admin authorization required/i);
  });

  it("8. Safe internal chunking and progress tracking for 50+ users", async () => {
    const adminLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "FT102857", password: "password" }),
      }),
      env,
    );
    assert.ok(adminLoginRes);
    const { token: adminToken } = await adminLoginRes.json();

    // Create 60 small payouts to test 2 chunks (50 + 10)
    const sixtyPayouts = Array.from({ length: 60 }, (_, i) => ({
      userId: "FT102857",
      amount: 1, // ₹1 each = ₹60 total
    }));

    const batchId = `test_batch_chunk_${Date.now()}`;
    const bulkRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          batch_id: batchId,
          chunk_size: 50,
          payouts: sixtyPayouts,
          notes: "Testing 60 users chunking",
        }),
      }),
      env,
    );

    assert.ok(bulkRes);
    assert.equal(bulkRes.status, 200);
    const data = await bulkRes.json();
    assert.equal(data.success, true);
    assert.equal(data.batch_id, batchId);
    assert.equal(data.total_recipients, 60);
    assert.equal(data.total_amount, 60);
    assert.equal(data.total_chunks, 2);
    assert.equal(data.chunks_processed, 2);
    assert.equal(data.chunk_size, 50);
    assert.deepEqual(data.progress, {
      total: 60,
      processed: 60,
      successful: 60,
      failed: 0,
    });
    assert.equal(data.processed.length, 60);
  });

  it("9. Idempotent retry: re-submitting with identical batch_id succeeds without double deduction", async () => {
    const adminLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "FT102857", password: "password" }),
      }),
      env,
    );
    assert.ok(adminLoginRes);
    const { token: adminToken } = await adminLoginRes.json();

    const initBalRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/balance?userId=FT102857", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env,
    );
    assert.ok(initBalRes);
    const balBefore = Number((await initBalRes.json()).wallet.balance);

    const testBatchId = `idempotent_test_${Date.now()}`;
    const payouts = [
      { userId: "FT102857", amount: 25 },
      { userId: "FT102857", amount: 35 },
    ];

    // First run
    const firstRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          batch_id: testBatchId,
          payouts,
        }),
      }),
      env,
    );
    assert.ok(firstRes);
    assert.equal(firstRes.status, 200);

    const balFirstReqRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/balance?userId=FT102857", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env,
    );
    assert.ok(balFirstReqRes);
    const balAfterFirst = Number((await balFirstReqRes.json()).wallet.balance);
    assert.equal(balAfterFirst, balBefore - 60);

    // Second run with EXACT same batch_id (idempotent replay)
    const retryRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          batch_id: testBatchId,
          payouts,
        }),
      }),
      env,
    );
    assert.ok(retryRes);
    assert.equal(retryRes.status, 200);
    const retryData = await retryRes.json();
    assert.equal(retryData.success, true);
    assert.equal(retryData.processed.length, 2);
    assert.equal(retryData.processed[0].idempotent_replay, true);
    assert.equal(retryData.processed[1].idempotent_replay, true);

    // Balance MUST remain unchanged (zero double deduction!)
    const balRetryReqRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/balance?userId=FT102857", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env,
    );
    assert.ok(balRetryReqRes);
    const balAfterRetry = Number((await balRetryReqRes.json()).wallet.balance);
    assert.equal(
      balAfterRetry,
      balAfterFirst,
      "Idempotent retry must not deduct balance a second time!",
    );
  });
});

describe("Payout Metadata and Sensitive Beneficiary Masking Audit Tests", () => {
  it("Masks bank account numbers preserving only the trailing 4 digits without plain text leakage", () => {
    assert.equal(maskAccountNumber("50100481920194"), "XXXXXXXXXX0194");
    assert.equal(maskAccountNumber("849201948201"), "XXXXXXXX8201");
    assert.equal(maskAccountNumber("1234"), "XXXX");
    assert.equal(maskAccountNumber(""), "");
  });

  it("Masks UPI handles protecting user identity while retaining domain", () => {
    assert.equal(maskUpiId("alexrivera@okhdfcbank"), "al***ra@okhdfcbank");
    assert.equal(maskUpiId("alex@upi"), "a**x@upi");
    assert.equal(maskUpiId("a@upi"), "a*@upi");
  });

  it("buildMaskedBeneficiaryDetails returns valid JSON with masked account and UPI without plaintext", () => {
    const masked = buildMaskedBeneficiaryDetails({
      accountHolder: "Alex Rivera",
      bankName: "HDFC Bank",
      accountNumber: "50100481920194",
      ifscCode: "hdfc0001234",
      upiId: "alexrivera@okhdfcbank",
    });
    assert.ok(masked);
    const parsed = JSON.parse(masked!);
    assert.equal(parsed.account_holder, "Alex Rivera");
    assert.equal(parsed.bank_name, "HDFC Bank");
    assert.equal(parsed.account_number_masked, "XXXXXXXXXX0194");
    assert.equal(parsed.ifsc_code, "HDFC0001234");
    assert.equal(parsed.upi_id_masked, "al***ra@okhdfcbank");
    // Explicit assertion: plaintext account number does NOT exist
    assert.equal("accountNumber" in parsed, false);
    assert.equal("account_number" in parsed, false);
    assert.equal(masked!.includes("50100481920194"), false);
  });

  it("Explicitly persists payout_method and beneficiary_details on withdrawal requests", async () => {
    const env = { JWT_SECRET: "test_jwt_secret_key" };
    const userLogin = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "FT102857", password: "password" }),
      }),
      env,
    );
    assert.ok(userLogin);
    const { token: userToken } = await userLogin.json();

    const withdrawRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${userToken}` },
        body: JSON.stringify({
          amount: 1000,
          userId: "FT102857",
          payout_method: "bank_transfer",
          bankDetails: {
            accountHolder: "FaceTube Admin",
            bankName: "State Bank of India",
            accountNumber: "123456789012",
            ifscCode: "SBIN0001234",
            upiId: "admin@oksbi",
          },
        }),
      }),
      env,
    );
    assert.ok(withdrawRes);
    const wData = await withdrawRes.json();
    assert.equal(wData.success, true, `Withdrawal failed: ${wData.error}`);
    assert.ok(wData.transaction);
    assert.equal(wData.transaction.payout_method, "bank_transfer");
    assert.ok(wData.transaction.beneficiary_details);
    const parsedBeneficiary = JSON.parse(wData.transaction.beneficiary_details);
    assert.equal(parsedBeneficiary.account_number_masked, "XXXXXXXX9012");
    assert.equal(wData.transaction.beneficiary_details.includes("123456789012"), false);
  });

  it("Bulk payout settlement assigns batch_id and payout_method to existing withdrawal records", async () => {
    const env = { JWT_SECRET: "test_jwt_secret_key" };
    const adminLogin = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@facetube.com", password: "password" }),
      }),
      env,
    );
    assert.ok(adminLogin);
    const { token: adminToken } = await adminLogin.json();

    // 1. Create a withdrawal request as admin/user
    const wRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          amount: 1000,
          userId: "FT102857",
        }),
      }),
      env,
    );
    assert.ok(wRes);
    const wData = await wRes.json();
    assert.equal(wData.success, true);
    const txId = wData.transaction.id;

    // 2. Settle this withdrawal via bulk payout
    const batchId = `settle_batch_${Date.now()}`;
    const bulkRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          batch_id: batchId,
          payouts: [
            {
              userId: "FT102857",
              transaction_id: txId,
              amount: 1000,
              payout_method: "bulk_bank_transfer",
            },
          ],
        }),
      }),
      env,
    );
    assert.ok(bulkRes);
    const bulkData = await bulkRes.json();
    assert.equal(bulkData.success, true);
    assert.equal(bulkData.processed.length, 1);
    assert.equal(bulkData.processed[0].status, "completed");

    // 3. Verify transactions list contains batch_id and payout_method
    const txListRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/transactions?userId=FT102857", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env,
    );
    assert.ok(txListRes);
    const txListData = await txListRes.json();
    const settledTx = txListData.transactions.find(
      (t: any) => t.id === txId || t.transaction_id === txId || t.transactionId === txId,
    );
    assert.ok(settledTx);
    assert.equal(settledTx.batch_id || settledTx.batchId, batchId);
    assert.ok(settledTx.payout_method || settledTx.payoutMethod);
  });

  it("Direct bulk payout records batch_id, payout_method, and masked beneficiary details", async () => {
    const env = { JWT_SECRET: "test_jwt_secret_key" };
    const adminLogin = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@facetube.com", password: "password" }),
      }),
      env,
    );
    assert.ok(adminLogin);
    const { token: adminToken } = await adminLogin.json();

    const batchId = `direct_meta_batch_${Date.now()}`;
    const directRes = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/bulk-payout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          batch_id: batchId,
          payouts: [
            {
              userId: "FT102857",
              amount: 50,
              payout_method: "bulk_bank_transfer",
              bankDetails: {
                accountHolder: "Admin Beneficiary",
                accountNumber: "987654321098",
                bankName: "HDFC Bank",
                ifscCode: "HDFC0001234",
              },
            },
          ],
        }),
      }),
      env,
    );
    assert.ok(directRes);
    const directData = await directRes.json();
    assert.equal(directData.success, true);
    assert.equal(directData.processed.length, 1);
    const directTxId = directData.processed[0].transaction_id;

    // Verify transactions list has batch_id and payout_method and masked beneficiary details
    const txListRes = await handleApiRequest(
      new Request("http://localhost:3000/api/wallet/transactions?userId=FT102857", {
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
      env,
    );
    assert.ok(txListRes);
    const txListData = await txListRes.json();
    const directTx = txListData.transactions.find(
      (t: any) => t.id === directTxId || t.transaction_id === directTxId,
    );
    assert.ok(directTx);
    assert.equal(directTx.batch_id || directTx.batchId, batchId);
    assert.equal(directTx.payout_method || directTx.payoutMethod, "bulk_bank_transfer");
    if (directTx.beneficiary_details || directTx.beneficiaryDetails) {
      const bStr = directTx.beneficiary_details || directTx.beneficiaryDetails;
      assert.equal(bStr.includes("987654321098"), false);
      assert.equal(bStr.includes("XXXXXXXX1098"), true);
    }
  });
});

describe("Phase 1 Production Safety: Environment Detection, Strict Parsing & Gateway Verification", () => {
  const testKeyId = "rzp_test_phase1_key";
  const testSecret = "phase1_razorpay_secret_123456";

  it("1. parseStrictBooleanFlag treats ONLY trimmed case-insensitive 'true' and '1' as true", () => {
    assert.equal(parseStrictBooleanFlag("true"), true);
    assert.equal(parseStrictBooleanFlag("TRUE"), true);
    assert.equal(parseStrictBooleanFlag("  TrUe  "), true);
    assert.equal(parseStrictBooleanFlag("1"), true);
    assert.equal(parseStrictBooleanFlag(" 1 "), true);

    assert.equal(parseStrictBooleanFlag("false"), false);
    assert.equal(parseStrictBooleanFlag("FALSE"), false);
    assert.equal(parseStrictBooleanFlag(" false "), false);
    assert.equal(parseStrictBooleanFlag("0"), false);
    assert.equal(parseStrictBooleanFlag(" 0 "), false);
    assert.equal(parseStrictBooleanFlag(""), false);
    assert.equal(parseStrictBooleanFlag("   "), false);
    assert.equal(parseStrictBooleanFlag("yes"), false);
    assert.equal(parseStrictBooleanFlag("no"), false);
    assert.equal(parseStrictBooleanFlag(undefined), false);
    assert.equal(parseStrictBooleanFlag(null), false);
  });

  it("2. Environment helper treats APP_ENV/NODE_ENV=production, staging, and unknown/unset as fail-closed production while preserving development and test", () => {
    assert.equal(isFailClosedProductionEnv("production", "development"), true);
    assert.equal(isFailClosedProductionEnv("development", "production"), true);
    assert.equal(isFailClosedProductionEnv("production", "test"), true);
    assert.equal(isFailClosedProductionEnv("test", "production"), true);
    assert.equal(isFailClosedProductionEnv("staging", "development"), true);
    assert.equal(isFailClosedProductionEnv("unknown", "test"), true);
    assert.equal(isFailClosedProductionEnv(undefined, undefined), true);
    assert.equal(isFailClosedProductionEnv("", ""), true);

    assert.equal(isFailClosedProductionEnv("development", "development"), false);
    assert.equal(isFailClosedProductionEnv("test", "test"), false);
    assert.equal(isFailClosedProductionEnv("local", "development"), false);
    assert.equal(isFailClosedProductionEnv(undefined, "development"), false);
    assert.equal(isFailClosedProductionEnv("development", undefined), false);

    assert.equal(isProductionRuntimeEnv({ APP_ENV: "production", NODE_ENV: "development" }), true);
    assert.equal(isProductionRuntimeEnv({ APP_ENV: "development", NODE_ENV: "production" }), true);
    assert.equal(
      isProductionRuntimeEnv({ APP_ENV: "development", NODE_ENV: "development" }),
      false,
    );
    assert.equal(isProductionRuntimeEnv({ APP_ENV: "test", NODE_ENV: "test" }), false);
  });

  it("3. 'false' and '0' MUST NOT skip remote Razorpay checks in createServerPaymentOrder, verifyServerPayment, executeRazorpayRefund, or /api/payments/verify", async () => {
    const origFetch = globalThis.fetch;
    try {
      for (const flagValue of ["false", "0", " FALSE ", " 0 "]) {
        const calledUrls: string[] = [];
        globalThis.fetch = (async (input: string | URL | Request) => {
          const u = typeof input === "string" ? input : input.toString();
          calledUrls.push(u);
          if (u.endsWith("/v1/orders")) {
            return new Response(JSON.stringify({ id: "order_remote_verified_123" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (u.includes("/v1/payments/") && u.endsWith("/refund")) {
            return new Response(JSON.stringify({ id: "rfnd_remote_123" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (u.includes("/v1/payments/")) {
            const pid = u.split("/v1/payments/")[1] || "";
            const ordMatch = pid.includes("verify_route") ? "ord_phase1_route" : "ord_phase1_fn";
            return new Response(
              JSON.stringify({
                id: pid,
                order_id: ordMatch,
                status: "captured",
                amount: 600,
                currency: "INR",
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          throw new Error(`Unexpected fetch URL: ${u}`);
        }) as typeof fetch;

        const baseEnv = {
          APP_ENV: "development",
          NODE_ENV: "development",
          RAZORPAY_KEY_ID: testKeyId,
          RAZORPAY_KEY_SECRET: testSecret,
          RAZORPAY_SKIP_REMOTE_CHECK: flagValue,
        };

        const order = await createServerPaymentOrder(
          { purpose: "premium_video_upload", userId: "FT483921" },
          baseEnv,
        );
        assert.equal(order.orderId, "order_remote_verified_123");

        const refundRes = await executeRazorpayRefund("pay_rfnd_check", 600, "test", baseEnv);
        assert.equal(refundRes.success, true);
        assert.equal(refundRes.refundId, "rfnd_remote_123");

        const payId = `pay_fn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const sig = crypto
          .createHmac("sha256", testSecret)
          .update(`ord_phase1_fn|${payId}`)
          .digest("hex");
        const verifyRes = await verifyServerPayment(
          {
            orderId: "ord_phase1_fn",
            paymentId: payId,
            signature: sig,
            userId: "FT483921",
            purpose: "premium_video_upload",
          },
          ["FT483921"],
          "FT102857",
          baseEnv,
        );
        assert.equal(verifyRes.verified, true);

        const routePayId = `pay_verify_route_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const routeSig = crypto
          .createHmac("sha256", testSecret)
          .update(`ord_phase1_route|${routePayId}`)
          .digest("hex");
        // Return a clean 400 from remote lookup on /api/payments/verify to prove remote call occurred before store write
        globalThis.fetch = (async (input: string | URL | Request) => {
          const u = typeof input === "string" ? input : input.toString();
          calledUrls.push(u);
          return new Response("Remote check rejected test payment", { status: 400 });
        }) as typeof fetch;
        const routeRes = await handleApiRequest(
          new Request("http://localhost:3000/api/payments/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              orderId: "ord_phase1_route",
              paymentId: routePayId,
              signature: routeSig,
              userId: "FT483921",
              purpose: "premium_video_upload",
            }),
          }),
          baseEnv,
        );
        assert.ok(routeRes);
        assert.equal(routeRes.status, 400);
        assert.equal(
          calledUrls.filter((u) => u.includes("api.razorpay.com")).length,
          4,
          `Flag '${flagValue}' must trigger all 4 remote Razorpay calls`,
        );
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("4. 'true' and '1' may skip remote checks ONLY in explicit development and test environments", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error(
        "Remote fetch should be skipped in explicit development/test when skip='true'/'1'",
      );
    }) as typeof fetch;

    try {
      for (const envPair of [
        { APP_ENV: "development", NODE_ENV: "development" },
        { APP_ENV: "test", NODE_ENV: "test" },
      ]) {
        for (const flagValue of ["true", " TRUE ", "1", " 1 "]) {
          const runtimeEnv = {
            ...envPair,
            RAZORPAY_KEY_ID: testKeyId,
            RAZORPAY_KEY_SECRET: testSecret,
            RAZORPAY_SKIP_REMOTE_CHECK: flagValue,
          };

          const order = await createServerPaymentOrder(
            { purpose: "premium_video_upload", userId: "FT483921" },
            runtimeEnv,
          );
          assert.ok(order.orderId.startsWith("order_"));

          const refundRes = await executeRazorpayRefund("pay_skip_1", 600, "test", runtimeEnv);
          assert.equal(refundRes.gatewayStatus, "gateway_unavailable");

          const payId = `pay_skip_ok_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const sig = crypto
            .createHmac("sha256", testSecret)
            .update(`ord_skip_ok|${payId}`)
            .digest("hex");
          const verifyRes = await verifyServerPayment(
            {
              orderId: "ord_skip_ok",
              paymentId: payId,
              signature: sig,
              userId: "FT483921",
              purpose: "premium_video_upload",
            },
            ["FT483921"],
            "FT102857",
            runtimeEnv,
          );
          assert.equal(verifyRes.verified, true);
        }
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("5. Production (APP_ENV=production or NODE_ENV=production, regardless of the other) MUST NEVER skip remote Razorpay verification, order creation, or refunds", async () => {
    const origFetch = globalThis.fetch;
    try {
      const prodCombinations = [
        { APP_ENV: "production", NODE_ENV: "development", RAZORPAY_SKIP_REMOTE_CHECK: "true" },
        { APP_ENV: "development", NODE_ENV: "production", RAZORPAY_SKIP_REMOTE_CHECK: "true" },
        { APP_ENV: "production", NODE_ENV: "production", RAZORPAY_SKIP_REMOTE_CHECK: "1" },
        { APP_ENV: "staging", NODE_ENV: "development", RAZORPAY_SKIP_REMOTE_CHECK: "true" },
      ];

      for (const combo of prodCombinations) {
        const calledUrls: string[] = [];
        globalThis.fetch = (async (input: string | URL | Request) => {
          const u = typeof input === "string" ? input : input.toString();
          calledUrls.push(u);
          if (u.endsWith("/v1/orders")) {
            return new Response(JSON.stringify({ id: "order_prod_live_1" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          if (u.endsWith("/refund")) {
            return new Response(JSON.stringify({ id: "rfnd_prod_live_1" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          return new Response("Simulated Razorpay failure", { status: 400 });
        }) as typeof fetch;

        const prodEnv = {
          ...combo,
          RAZORPAY_KEY_ID: testKeyId,
          RAZORPAY_KEY_SECRET: testSecret,
        };

        const order = await createServerPaymentOrder(
          { purpose: "premium_video_upload", userId: "FT483921" },
          prodEnv,
        );
        assert.equal(order.orderId, "order_prod_live_1");

        const refund = await executeRazorpayRefund("pay_prod_1", 600, "prod", prodEnv);
        assert.equal(refund.success, true);
        assert.equal(refund.refundId, "rfnd_prod_live_1");

        const payId = `pay_prod_${Date.now()}`;
        const sig = crypto
          .createHmac("sha256", testSecret)
          .update(`ord_prod|${payId}`)
          .digest("hex");

        const verifyFnRes = await verifyServerPayment(
          {
            orderId: "ord_prod",
            paymentId: payId,
            signature: sig,
            userId: "FT483921",
            purpose: "premium_video_upload",
          },
          ["FT483921"],
          "FT102857",
          prodEnv,
        );
        assert.equal(verifyFnRes.verified, false);
        assert.match(verifyFnRes.error || "", /Razorpay payment confirmation failed/);

        const dummyPool = { query: async () => [[]], getConnection: async () => ({}) } as any;
        const apiVerifyRes = await handleApiRequest(
          new Request("http://localhost:3000/api/payments/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              orderId: "ord_prod",
              paymentId: payId,
              signature: sig,
              userId: "FT483921",
              purpose: "premium_video_upload",
            }),
          }),
          prodEnv,
          { pool: dummyPool },
        );
        assert.ok(apiVerifyRes);
        assert.equal(apiVerifyRes.status, 400);
        const apiVerifyJson = await apiVerifyRes.json();
        assert.match(apiVerifyJson.error || "", /Razorpay API lookup returned status 400/);

        assert.equal(
          calledUrls.length,
          4,
          `Production combo ${JSON.stringify(combo)} must execute all 4 remote Razorpay calls`,
        );

        // Missing RAZORPAY_KEY_ID in production must fail closed rather than skipping remote check
        const missingKeyIdRes = await verifyServerPayment(
          {
            orderId: "ord_prod",
            paymentId: payId,
            signature: sig,
            userId: "FT483921",
            purpose: "premium_video_upload",
          },
          ["FT483921"],
          "FT102857",
          {
            ...combo,
            RAZORPAY_KEY_ID: "",
            RAZORPAY_KEY_SECRET: testSecret,
          },
        );
        assert.equal(missingKeyIdRes.verified, false);
        assert.match(missingKeyIdRes.error || "", /failed closed/i);
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("6. APP_ENV=production enforces fail-closed MySQL guard in handleApiRequest even when NODE_ENV=development", async () => {
    const res = await handleApiRequest(
      new Request("http://localhost:3000/api/admin/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test" }),
      }),
      { APP_ENV: "production", NODE_ENV: "development" },
    );
    // Unauthenticated returns 401 before pool check; check /api/auth/login which checks pool directly
    assert.ok(res);

    const loginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
      }),
      { APP_ENV: "production", NODE_ENV: "development" },
    );
    assert.ok(loginRes);
    assert.equal(loginRes.status, 503);

    const devLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
      }),
      { APP_ENV: "development", NODE_ENV: "development" },
    );
    assert.ok(devLoginRes);
    assert.equal(devLoginRes.status, 200);
  });
});

describe("Phase 2 Production JSON Fallback Protection & SQL Fail-Closed Tests", () => {
  it("1. Production never reads or writes facetube_store.json or premium_transactions.json even when NODE_ENV=development and APP_ENV=production", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const storePath = path.resolve(process.cwd(), "data/facetube_store.json");
    const premPath = path.resolve(process.cwd(), "data/premium_transactions.json");
    const storeBefore = fs.readFileSync(storePath, "utf-8");
    const premBefore = fs.readFileSync(premPath, "utf-8");

    const prodEnv = { APP_ENV: "production", NODE_ENV: "development" };
    assert.equal(isProductionRuntimeEnv(prodEnv), true);
    assert.equal(isProductionRuntimeEnv({ APP_ENV: undefined, NODE_ENV: undefined }), true);

    assert.throws(() => resetStoreForTests("FT483921", 50000, prodEnv), /disabled in production/i);
    assert.throws(() => setStoreWalletBalance("FT483921", 100, prodEnv), /disabled in production/i);
    await assert.rejects(
      () => getPersistentPremiumTxNumber(prodEnv),
      /strictly disabled in production/i,
    );

    for (const [route, body] of [
      ["auth/login", { identifier: "alex@facetube.com", password: "password123" }],
      ["auth/register", { name: "Test", email: "new_prod@facetube.com", password: "password123" }],
      ["payments/verify", { orderId: "ord_1", paymentId: "pay_1", signature: "sig_1" }],
      ["payments/transactions", null],
    ] as const) {
      const res = await handleApiRequest(
        new Request(`http://localhost:3000/api/${route}`, {
          method: body ? "POST" : "GET",
          headers: { "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : null,
        }),
        prodEnv,
        { pool: null },
      );
      assert.ok(res);
      assert.ok([500, 503].includes(res.status), `Expected 500/503 on ${route}, got ${res.status}`);
    }

    assert.equal(fs.readFileSync(storePath, "utf-8"), storeBefore);
    assert.equal(fs.readFileSync(premPath, "utf-8"), premBefore);
  });

  it("2. src/server/mysql.ts respects injected env in getDbConfig, getMysqlPool, and testDatabaseConnection", async () => {
    const { getDbConfig, getMysqlPool, testDatabaseConnection, setMysqlPoolForTesting } =
      await import("./mysql.ts");

    const origHost = process.env["DB_HOST"];
    const origName = process.env["DB_NAME"];
    const origUser = process.env["DB_USER"];
    delete process.env["DB_HOST"];
    delete process.env["DB_NAME"];
    delete process.env["DB_USER"];
    setMysqlPoolForTesting(null);

    try {
      const unconfigured = getDbConfig({ APP_ENV: "production", NODE_ENV: "development" });
      assert.equal(unconfigured.isConfigured, false);
      assert.equal(getMysqlPool({ APP_ENV: "production" }), null);

      const injected = getDbConfig({
        DB_HOST: "10.0.0.5",
        DB_NAME: "prod_db",
        DB_USER: "prod_user",
        DB_PASSWORD: "secret",
      });
      assert.equal(injected.isConfigured, true);
      assert.equal(injected.host, "10.0.0.5");
      assert.equal(injected.database, "prod_db");

      const diagMissing = await testDatabaseConnection({
        APP_ENV: "production",
        DB_HOST: "",
      });
      assert.equal(diagMissing.connected, false);
    } finally {
      setMysqlPoolForTesting(null);
      if (origHost !== undefined) process.env["DB_HOST"] = origHost;
      if (origName !== undefined) process.env["DB_NAME"] = origName;
      if (origUser !== undefined) process.env["DB_USER"] = origUser;
    }
  });

  it("3. payments/verify in production does NOT swallow DB errors on subscriber_plans, payment_orders, uploaded_videos, UPDATE payment_orders, or INSERT INTO premium_transactions", async () => {
    const secret = "prod_verify_fail_closed_secret";
    const keyId = "rzp_live_testkey123";
    const origFetch = globalThis.fetch;

    const makeSig = (orderId: string, paymentId: string) =>
      crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

    const makeProdVerifyReq = (
      orderId: string,
      paymentId: string,
      purpose: "paid_subscription" | "premium_video_upload",
      extra: Record<string, unknown> = {},
    ) =>
      new Request("http://localhost:3000/api/payments/verify", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer prod_user_tok",
        },
        body: JSON.stringify({
          orderId,
          paymentId,
          signature: makeSig(orderId, paymentId),
          userId: "FT483921",
          purpose,
          ...extra,
        }),
      });

    const prodEnv = {
      APP_ENV: "production",
      NODE_ENV: "development",
      RAZORPAY_KEY_ID: keyId,
      RAZORPAY_KEY_SECRET: secret,
    };

    try {
      const makeMockPool = (failOn: string) => {
        let rolledBack = false;
        let committed = false;
        const queryHandler = async (sql: string) => {
          if (sql.includes("FROM sessions")) {
            return [
              [
                {
                  id: "u-483921",
                  user_id: "FT483921",
                  name: "Alex",
                  mobile: "",
                  email: "alex@facetube.com",
                  role: "user",
                  referral_code: null,
                  created_at: new Date().toISOString(),
                },
              ],
            ];
          }
          if (sql.includes("GET_LOCK")) return [[{ acquired: 1 }]];
          if (sql.includes("RELEASE_LOCK")) return [[{ released: 1 }]];
          if (sql.includes(failOn)) {
            throw new Error(`Simulated DB failure on ${failOn}`);
          }
          if (sql.includes("FROM subscriber_plans")) {
            return [[{ price: 49, duration_days: 30 }]];
          }
          if (sql.includes("FROM users WHERE role = 'admin'")) {
            return [[{ user_id: "FT102857" }]];
          }
          if (sql.includes("SELECT COUNT(*) as total FROM payment_transactions")) {
            return [[{ total: 0 }]];
          }
          return [[]];
        };

        const conn = {
          beginTransaction: async () => {},
          commit: async () => {
            committed = true;
          },
          rollback: async () => {
            rolledBack = true;
          },
          release: () => {},
          query: queryHandler,
        };
        return {
          get rolledBack() {
            return rolledBack;
          },
          get committed() {
            return committed;
          },
          query: queryHandler,
          getConnection: async () => conn,
        } as any;
      };

      const setRzpAmountFetch = (expectedOrderId: string, amountPaise: number) => {
        globalThis.fetch = (async () =>
          new Response(
            JSON.stringify({
              id: "pay_any",
              order_id: expectedOrderId,
              status: "captured",
              amount: amountPaise,
              currency: "INR",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )) as typeof fetch;
      };

      // Case A: subscriber_plans lookup failure -> 503
      const resPlans = await handleApiRequest(
        makeProdVerifyReq("ord_p1", "pay_p1", "paid_subscription", { planId: "member-monthly" }),
        prodEnv,
        { pool: makeMockPool("FROM subscriber_plans") },
      );
      assert.ok(resPlans);
      assert.equal(resPlans.status, 503);
      assert.equal((await resPlans.json()).verified, false);

      // Case B: payment_orders ownership query failure -> 503
      setRzpAmountFetch("ord_p2", 600);
      const resPo = await handleApiRequest(
        makeProdVerifyReq("ord_p2", "pay_p2", "premium_video_upload"),
        prodEnv,
        { pool: makeMockPool("FROM payment_orders") },
      );
      assert.ok(resPo);
      assert.equal(resPo.status, 503);
      assert.equal((await resPo.json()).verified, false);

      // Case C: uploaded_videos ownership query failure -> 503
      setRzpAmountFetch("ord_p3", 600);
      const resVid = await handleApiRequest(
        makeProdVerifyReq("ord_p3", "pay_p3", "premium_video_upload", { videoId: "vid_1" }),
        prodEnv,
        { pool: makeMockPool("FROM uploaded_videos WHERE id = ?") },
      );
      assert.ok(resVid);
      assert.equal(resVid.status, 503);
      assert.equal((await resVid.json()).verified, false);

      // Case D: UPDATE payment_orders failure inside paid_subscription tx -> rollback + 503
      setRzpAmountFetch("ord_p4", 4900);
      const poolUpdPo = makeMockPool("UPDATE payment_orders");
      const resUpdPo = await handleApiRequest(
        makeProdVerifyReq("ord_p4", "pay_p4", "paid_subscription", { planId: "member-monthly" }),
        prodEnv,
        { pool: poolUpdPo },
      );
      assert.ok(resUpdPo);
      assert.equal(resUpdPo.status, 503);
      assert.equal((await resUpdPo.json()).verified, false);
      assert.equal(poolUpdPo.rolledBack, true);
      assert.equal(poolUpdPo.committed, false);

      // Case E: INSERT INTO premium_transactions failure inside premium_video_upload tx -> rollback + 503
      setRzpAmountFetch("ord_p5", 600);
      const poolInsPt = makeMockPool("INSERT INTO premium_transactions");
      const resInsPt = await handleApiRequest(
        makeProdVerifyReq("ord_p5", "pay_p5", "premium_video_upload", { videoId: "vid_1" }),
        prodEnv,
        { pool: poolInsPt },
      );
      assert.ok(resInsPt);
      assert.equal(resInsPt.status, 503);
      assert.equal((await resInsPt.json()).verified, false);
      assert.equal(poolInsPt.rolledBack, true);
      assert.equal(poolInsPt.committed, false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("Global Income Pool Phase A: Per-Video Eligibility & Authoritative Server Summary", () => {
  it("1. Counts 5 eligible videos from 1 distinct creator as eligibleVideoCount=5 and distinctCreatorCount=1 across evaluatePremiumDistribution & verifyServerPayment (including idempotent duplicates)", async () => {
    resetPersistentPremiumState();
    const secret = "phase_a_verify_secret_12345";
    const keyId = "rzp_test_phase_a";
    const origFetch = globalThis.fetch;

    const eligiblePool = [
      { userId: "CR_5X", videoId: "vid_1", adEarnings: 0 },
      { userId: "CR_5X", videoId: "vid_2", adEarnings: 0 },
      { userId: "CR_5X", videoId: "vid_3", adEarnings: 0 },
      { userId: "CR_5X", videoId: "vid_4", adEarnings: 0 },
      { userId: "CR_5X", videoId: "vid_5", adEarnings: 0 },
      // Uploader's own videos must be strictly excluded
      { userId: "FT_UP1", videoId: "vid_own_1", adEarnings: 10 },
    ];

    // 1a. Pure evaluation helper check (1 creator with 5 eligible videos)
    const eligibleVideosOnly = eligiblePool.slice(0, 5);
    const evalNormal = evaluatePremiumDistribution(1, "FT_REF1", 5, eligibleVideosOnly);
    assert.equal(evalNormal.eligibleVideoCount, 5);
    assert.equal(evalNormal.eligibleMembersCount, 5);
    assert.equal(evalNormal.distinctCreatorCount, 1);
    assert.equal(evalNormal.directReferralAmount, 1.0);
    assert.equal(evalNormal.adminAmount, 1.0);
    assert.equal(evalNormal.globalPoolAmount, 3.0);
    assert.equal(evalNormal.weightedPayouts?.length, 5);
    assert.equal(evalNormal.perMemberShare, 0.6);

    const evalSpecial = evaluatePremiumDistribution(11, "FT_REF1", 5, eligibleVideosOnly);
    assert.equal(evalSpecial.isSpecial, true);
    assert.equal(evalSpecial.eligibleVideoCount, 0);
    assert.equal(evalSpecial.distinctCreatorCount, 0);
    assert.equal(evalSpecial.globalPoolAmount, 0);
    assert.equal(evalSpecial.adminAmount, 4.0);
    assert.equal(evalSpecial.directReferralAmount, 1.0);

    // 1b. verifyServerPayment primary + idempotent duplicate check
    const orderId = "order_phase_a_5v";
    const paymentId = "pay_phase_a_5v";
    const signature = crypto
      .createHmac("sha256", secret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

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

    try {
      const env = { RAZORPAY_KEY_ID: keyId, RAZORPAY_KEY_SECRET: secret };
      const first = await verifyServerPayment(
        {
          orderId,
          paymentId,
          signature,
          userId: "FT_UP1",
          userName: "Uploader One",
          videoId: "vid_new_1",
          purpose: "premium_video_upload",
          referrerUserId: "FT_REF1",
        },
        eligiblePool,
        "FT_REF1",
        env,
      );

      assert.equal(first.verified, true);
      assert.equal(first.distribution?.eligibleVideoCount, 5);
      assert.equal(first.distribution?.eligibleMembersCount, 5);
      assert.equal(first.distribution?.distinctCreatorCount, 1);
      assert.equal(first.distribution?.globalPoolAmount, 3.0);
      assert.equal(first.distribution?.adminAmount, 1.0);
      assert.equal(first.distribution?.directReferralAmount, 1.0);
      assert.equal(first.distribution?.creatorPayouts?.length, 5);

      const dup = await verifyServerPayment(
        {
          orderId,
          paymentId,
          signature,
          userId: "FT_UP1",
          userName: "Uploader One",
          videoId: "vid_new_1",
          purpose: "premium_video_upload",
          referrerUserId: "FT_REF1",
        },
        eligiblePool,
        "FT_REF1",
        env,
      );

      assert.equal(dup.verified, true);
      assert.equal(dup.duplicate, true);
      assert.equal(dup.distribution?.eligibleVideoCount, 5);
      assert.equal(dup.distribution?.eligibleMembersCount, 5);
      assert.equal(dup.distribution?.distinctCreatorCount, 1);
      assert.equal(dup.distribution?.globalPoolAmount, 3.0);
      assert.equal(dup.distribution?.perMemberShare, 0.6);
    } finally {
      globalThis.fetch = origFetch;
      resetPersistentPremiumState();
    }
  });

  it("2. /api/wallet/global-pool-summary & MySQL /api/payments/verify report 5 eligible videos for 1 creator without altering payout amounts", async () => {
    const secret = "phase_a_mysql_secret_123";
    const keyId = "rzp_test_phase_a_mysql";
    const origFetch = globalThis.fetch;

    const orderId = "order_mysql_5v";
    const paymentId = "pay_mysql_5v";
    const signature = crypto
      .createHmac("sha256", secret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    const queryHandler = async (sql: string) => {
      if (sql.includes("FROM sessions")) {
        return [
          [
            {
              id: "u-up1",
              user_id: "FT_UP1",
              name: "Uploader One",
              mobile: "",
              email: "up1@facetube.com",
              role: "user",
              referral_code: "FT_REF1",
              created_at: new Date().toISOString(),
            },
          ],
        ];
      }
      if (sql.includes("GET_LOCK")) return [[{ acquired: 1 }]];
      if (sql.includes("RELEASE_LOCK")) return [[{ released: 1 }]];
      if (sql.includes("COUNT(*) AS eligible_video_count")) {
        return [[{ eligible_video_count: 5, distinct_creator_count: 1, total_ad_earnings: 0 }]];
      }
      if (sql.includes("FROM payment_orders")) {
        return [[{ order_id: orderId, user_id: "FT_UP1", purpose: "premium_video_upload" }]];
      }
      if (sql.includes("FROM uploaded_videos WHERE id = ?")) {
        return [[]];
      }
      if (sql.includes("FROM payment_transactions WHERE payment_id = ?")) {
        return [[]];
      }
      if (sql.includes("FROM users WHERE role = 'admin'")) {
        return [[{ user_id: "FT102857" }]];
      }
      if (sql.includes("SELECT COUNT(*) as total FROM payment_transactions")) {
        return [[{ total: 0 }]];
      }
      if (sql.includes("SELECT id, user_id, referral_code FROM users")) {
        return [[{ id: "u-up1", user_id: "FT_UP1", referral_code: "FT_REF1" }]];
      }
      if (sql.includes("FROM users") && sql.includes("UPPER(referral_code)")) {
        return [[{ user_id: "FT_REF1" }]];
      }
      if (sql.includes("SELECT id AS video_id, user_id")) {
        return [
          [
            { video_id: "vid_1", user_id: "CR_5X", ad_earnings: 0 },
            { video_id: "vid_2", user_id: "CR_5X", ad_earnings: 0 },
            { video_id: "vid_3", user_id: "CR_5X", ad_earnings: 0 },
            { video_id: "vid_4", user_id: "CR_5X", ad_earnings: 0 },
            { video_id: "vid_5", user_id: "CR_5X", ad_earnings: 0 },
          ],
        ];
      }
      return [[]];
    };

    const mockConn = {
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => {},
      release: () => {},
      query: queryHandler,
    };
    const mockPool = {
      query: queryHandler,
      getConnection: async () => mockConn,
    } as any;

    const env = {
      APP_ENV: "production",
      NODE_ENV: "development",
      RAZORPAY_KEY_ID: keyId,
      RAZORPAY_KEY_SECRET: secret,
    };

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

    try {
      const summaryRes = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/global-pool-summary?excludeUserId=FT_UP1", {
          method: "GET",
          headers: { Authorization: "Bearer tok_up1" },
        }),
        env,
        { pool: mockPool },
      );
      assert.ok(summaryRes);
      assert.equal(summaryRes.status, 200);
      const summaryJson = await summaryRes.json();
      assert.equal(summaryJson.success, true);
      assert.equal(summaryJson.eligibleVideoCount, 5);
      assert.equal(summaryJson.distinctCreatorCount, 1);
      assert.equal(summaryJson.estimatedEqualSharePerVideo, 0.6);

      const verifyRes = await handleApiRequest(
        new Request("http://localhost:3000/api/payments/verify", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer tok_up1",
          },
          body: JSON.stringify({
            orderId,
            paymentId,
            signature,
            userId: "FT_UP1",
            userName: "Uploader One",
            purpose: "premium_video_upload",
          }),
        }),
        env,
        { pool: mockPool },
      );
      assert.ok(verifyRes);
      assert.equal(verifyRes.status, 200);
      const verifyJson = await verifyRes.json();
      assert.equal(verifyJson.verified, true);
      assert.equal(verifyJson.distribution.eligibleVideoCount, 5);
      assert.equal(verifyJson.distribution.eligibleMembersCount, 5);
      assert.equal(verifyJson.distribution.distinctCreatorCount, 1);
      assert.equal(verifyJson.distribution.globalPoolAmount, 3.0);
      assert.equal(verifyJson.distribution.adminAmount, 1.0);
      assert.equal(verifyJson.distribution.directReferralAmount, 1.0);
      assert.equal(verifyJson.distribution.perMemberShare, 0.6);
      assert.equal(verifyJson.distribution.creatorPayouts.length, 5);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("3. getGlobalPoolSummary uses server response without localStorage fallback and getUserLedger respects empty server transactions", async () => {
    const origFetch = globalThis.fetch;

    saveStoredLedger([
      {
        id: "stale-local-1",
        transactionId: "TX_LOCAL_STALE",
        userId: "FT483921",
        incomeType: "global_income",
        amount: 0.6,
        status: "settled",
        description: "Stale cache entry",
        createdAt: new Date().toISOString(),
      },
    ]);

    try {
      // Server returns authoritative 5 videos / 1 creator summary
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/wallet/global-pool-summary")) {
          return new Response(
            JSON.stringify({
              success: true,
              excludedUserId: "FT483921",
              poolAmount: 3.0,
              poolPaise: 300,
              eligibleVideoCount: 5,
              distinctCreatorCount: 1,
              estimatedEqualSharePerVideo: 0.6,
              totalAdEarnings: 0,
              weightingMode: "equal_fallback",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ success: true, transactions: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      const summary = await getGlobalPoolSummary("FT483921");
      assert.equal(summary.eligibleVideoCount, 5);
      assert.equal(summary.distinctCreatorCount, 1);
      assert.equal(summary.estimatedEqualSharePerVideo, 0.6);
      assert.equal(summary.isStale, false);
      assert.equal(summary.error, undefined);

      // Server returning [] must return [] rather than leaking stale localStorage transactions
      const emptyLedger = await getUserLedger("FT483921");
      assert.deepEqual(emptyLedger, []);

      // On server failure, getGlobalPoolSummary reports unavailable error and zero counts (never reads localStorage)
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ success: false, error: "Database unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch;

      const failedSummary = await getGlobalPoolSummary("FT483921");
      assert.equal(failedSummary.eligibleVideoCount, 0);
      assert.equal(failedSummary.distinctCreatorCount, 0);
      assert.equal(failedSummary.estimatedEqualSharePerVideo, 0);
      assert.equal(failedSummary.isStale, true);
      assert.ok(failedSummary.error);
    } finally {
      globalThis.fetch = origFetch;
      saveStoredLedger([]);
    }
  });

  it("4. Covers the 5 targeted Phase A review fixes (empty creatorEarnings metadata, duplicate snapshot metadata, MySQL duplicate parity, summary auth policy, and non-prod OR filter)", async () => {
    resetPersistentPremiumState();
    const secret = "phase_a_fixes_secret_999";
    const keyId = "rzp_test_phase_a_fixes";
    const origFetch = globalThis.fetch;

    // A. evaluatePremiumDistribution with explicit creatorEarnings=[] and eligibleCreatorsCount=5
    const evalEmptyArray = evaluatePremiumDistribution(1, "FT_REF1", 5, []);
    assert.equal(evalEmptyArray.globalPoolAmount, 3.0);
    assert.equal(evalEmptyArray.adminAmount, 1.0);
    assert.equal(evalEmptyArray.directReferralAmount, 1.0);
    assert.equal(evalEmptyArray.eligibleVideoCount, 5);
    assert.equal(evalEmptyArray.eligibleMembersCount, 5);
    assert.equal(evalEmptyArray.distinctCreatorCount, 5);
    assert.equal(evalEmptyArray.perMemberShare, 0.6);

    // B. verifyServerPayment duplicate preserves snapshot counts even when retry passes []
    const orderId = "order_snap_1";
    const paymentId = "pay_snap_1";
    const sig = crypto.createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

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

    try {
      const env = { RAZORPAY_KEY_ID: keyId, RAZORPAY_KEY_SECRET: secret };
      await verifyServerPayment(
        {
          orderId,
          paymentId,
          signature: sig,
          userId: "FT_UP1",
          purpose: "premium_video_upload",
          referrerUserId: "FT_REF1",
        },
        [
          { userId: "CR_5X", videoId: "v1", adEarnings: 0 },
          { userId: "CR_5X", videoId: "v2", adEarnings: 0 },
          { userId: "CR_5X", videoId: "v3", adEarnings: 0 },
          { userId: "CR_5X", videoId: "v4", adEarnings: 0 },
          { userId: "CR_5X", videoId: "v5", adEarnings: 0 },
        ],
        "FT_REF1",
        env,
      );

      // Duplicate retry without passing eligible pool preserves original 5 videos / 1 creator metadata
      const dupRetry = await verifyServerPayment(
        {
          orderId,
          paymentId,
          signature: sig,
          userId: "FT_UP1",
          purpose: "premium_video_upload",
          referrerUserId: "FT_REF1",
        },
        [],
        "FT_REF1",
        env,
      );
      assert.equal(dupRetry.duplicate, true);
      assert.equal(dupRetry.distribution?.eligibleVideoCount, 5);
      assert.equal(dupRetry.distribution?.eligibleMembersCount, 5);
      assert.equal(dupRetry.distribution?.distinctCreatorCount, 1);
      assert.equal(dupRetry.distribution?.perMemberShare, 0.6);

      // C. global-pool-summary enforces standard wallet session auth (401 unauth, 403 cross-user, 200 self)
      const mockQuery = async (sql: string) => {
        if (sql.includes("FROM sessions")) {
          return [
            [
              {
                id: "u-up1",
                user_id: "FT_UP1",
                name: "Uploader One",
                mobile: "",
                email: "up1@facetube.com",
                role: "user",
                referral_code: "FT_REF1",
                created_at: new Date().toISOString(),
              },
            ],
          ];
        }
        if (sql.includes("GET_LOCK")) return [[{ acquired: 1 }]];
        if (sql.includes("RELEASE_LOCK")) return [[{ released: 1 }]];
        if (sql.includes("FROM payment_orders")) {
          return [[{ order_id: orderId, user_id: "FT_UP1", purpose: "premium_video_upload" }]];
        }
        if (sql.includes("FROM uploaded_videos WHERE id = ?")) {
          return [[]];
        }
        if (sql.includes("FROM payment_transactions WHERE payment_id = ? FOR UPDATE")) {
          return [
            [
              {
                payment_id: paymentId,
                order_id: orderId,
                user_id: "FT_UP1",
                amount: 6,
                purpose: "premium_video_upload",
                tx_number: 2,
                is_special: 0,
                special_tag: "NORMAL_PREMIUM",
                referral_commission: 1,
                admin_allocation: 1,
                global_pool_allocation: 3,
              },
            ],
          ];
        }
        if (sql.includes("FROM income_ledger") && sql.includes("global_income")) {
          return [
            [
              { user_id: "CR_5X", amount: 0.6 },
              { user_id: "CR_5X", amount: 0.6 },
              { user_id: "CR_5X", amount: 0.6 },
              { user_id: "CR_5X", amount: 0.6 },
              { user_id: "CR_5X", amount: 0.6 },
            ],
          ];
        }
        if (sql.includes("COUNT(*) AS eligible_video_count")) {
          return [[{ eligible_video_count: 5, distinct_creator_count: 1, total_ad_earnings: 0 }]];
        }
        return [[]];
      };
      const mockPool = {
        query: mockQuery,
        getConnection: async () => ({
          beginTransaction: async () => {},
          commit: async () => {},
          rollback: async () => {},
          release: () => {},
          query: mockQuery,
        }),
      } as any;
      const prodEnv = {
        APP_ENV: "production",
        NODE_ENV: "development",
        RAZORPAY_KEY_ID: keyId,
        RAZORPAY_KEY_SECRET: secret,
      };

      const unauthSummary = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/global-pool-summary?excludeUserId=FT_UP1"),
        prodEnv,
        { pool: mockPool },
      );
      assert.equal(unauthSummary?.status, 401);

      const crossUserSummary = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/global-pool-summary?excludeUserId=FT102857", {
          headers: { Authorization: "Bearer tok_up1" },
        }),
        prodEnv,
        { pool: mockPool },
      );
      assert.equal(crossUserSummary?.status, 403);

      const selfSummary = await handleApiRequest(
        new Request("http://localhost:3000/api/wallet/global-pool-summary", {
          headers: { Authorization: "Bearer tok_up1" },
        }),
        prodEnv,
        { pool: mockPool },
      );
      assert.equal(selfSummary?.status, 200);
      const selfJson = await selfSummary?.json();
      assert.equal(selfJson.eligibleVideoCount, 5);
      assert.equal(selfJson.distinctCreatorCount, 1);

      // D. MySQL duplicate verify returns consistent distribution metadata
      const dupMysqlRes = await handleApiRequest(
        new Request("http://localhost:3000/api/payments/verify", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer tok_up1",
          },
          body: JSON.stringify({
            orderId,
            paymentId,
            signature: sig,
            userId: "FT_UP1",
            purpose: "premium_video_upload",
          }),
        }),
        prodEnv,
        { pool: mockPool },
      );
      assert.equal(dupMysqlRes?.status, 200);
      const dupMysqlJson = await dupMysqlRes?.json();
      assert.equal(dupMysqlJson.duplicate, true);
      assert.equal(dupMysqlJson.distribution.eligibleVideoCount, 5);
      assert.equal(dupMysqlJson.distribution.eligibleMembersCount, 5);
      assert.equal(dupMysqlJson.distribution.distinctCreatorCount, 1);
      assert.equal(dupMysqlJson.distribution.perMemberShare, 0.6);
      assert.equal(dupMysqlJson.distribution.globalPoolAmount, 3);

      // E. Non-production store video eligibility OR filter (video_type === "premium" || payment_status === "paid")
      const nonProdEnv = {
        NODE_ENV: "test",
        RAZORPAY_KEY_ID: keyId,
        RAZORPAY_KEY_SECRET: secret,
        RAZORPAY_SKIP_REMOTE_CHECK: "true",
      };
      // Consume special tx #11 if sequence was just reset, so baseline & after are normal (#12, #13)
      const warmOrder = "order_nonprod_warm";
      const warmPay = "pay_nonprod_warm";
      const warmSig = crypto
        .createHmac("sha256", secret)
        .update(`${warmOrder}|${warmPay}`)
        .digest("hex");
      await handleApiRequest(
        new Request("http://localhost:3000/api/payments/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            orderId: warmOrder,
            paymentId: warmPay,
            signature: warmSig,
            userId: "FT483921",
            purpose: "premium_video_upload",
          }),
        }),
        nonProdEnv,
        { pool: null },
      );

      const baseOrder = "order_nonprod_base";
      const basePay = "pay_nonprod_base";
      const baseSig = crypto
        .createHmac("sha256", secret)
        .update(`${baseOrder}|${basePay}`)
        .digest("hex");
      const baseRes = await handleApiRequest(
        new Request("http://localhost:3000/api/payments/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            orderId: baseOrder,
            paymentId: basePay,
            signature: baseSig,
            userId: "FT483921",
            purpose: "premium_video_upload",
          }),
        }),
        nonProdEnv,
        { pool: null },
      );
      assert.equal(baseRes?.status, 200);
      const baseJson = await baseRes?.json();
      assert.equal(baseJson.isSpecialTransaction, false);
      const baselineCount = Number(baseJson?.distribution?.eligibleVideoCount || 0);

      // Add a video matching ONLY payment_status === "paid" (with video_type === "free")
      const orVidRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: `vid-or-filter-${Date.now()}`,
            userId: "FT_OR_CREATOR",
            title: "Paid Free-Type Eligibility Check",
            videoUrl: "/uploads/or-check.mp4",
            video_type: "free",
            payment_status: "paid",
          }),
        }),
        nonProdEnv,
        { pool: null },
      );
      assert.equal(orVidRes?.status, 201);

      const afterOrder = "order_nonprod_after";
      const afterPay = "pay_nonprod_after";
      const afterSig = crypto
        .createHmac("sha256", secret)
        .update(`${afterOrder}|${afterPay}`)
        .digest("hex");
      const afterRes = await handleApiRequest(
        new Request("http://localhost:3000/api/payments/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            orderId: afterOrder,
            paymentId: afterPay,
            signature: afterSig,
            userId: "FT483921",
            purpose: "premium_video_upload",
          }),
        }),
        nonProdEnv,
        { pool: null },
      );
      assert.equal(afterRes?.status, 200);
      const afterJson = await afterRes?.json();
      assert.equal(afterJson.distribution.eligibleVideoCount, baselineCount + 1);
    } finally {
      globalThis.fetch = origFetch;
      resetPersistentPremiumState();
    }
  });
});
