import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { markVideoPromoted } from "../lib/video-service.js";
import {
  initiatePremiumVideoPayment,
  initiateAdsPromotionPayment,
} from "../lib/razorpay-service.js";

const ROOT_DIR = process.cwd();

function readProjectFile(relPath: string): string {
  return fs.readFileSync(path.join(ROOT_DIR, relPath), "utf8");
}

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

describe("Task 1: PHP Razorpay Credential Loading & Security Protection", () => {
  it("1. api/config/database.php defines getRazorpayConfig() loading env vars and razorpay_credentials.php", () => {
    const dbPhp = readProjectFile("api/config/database.php");
    assert.match(dbPhp, /function getRazorpayConfig\(/);
    assert.match(dbPhp, /razorpay_credentials\.php/);
    assert.match(dbPhp, /RAZORPAY_KEY_ID/);
    assert.match(dbPhp, /RAZORPAY_KEY_SECRET/);
    assert.match(dbPhp, /static \$cached = null/);
  });

  it("2. create-order.php, verify.php, and subscription-refund-review.php all use getRazorpayConfig()", () => {
    const createOrderPhp = readProjectFile("api/payments/create-order.php");
    const verifyPhp = readProjectFile("api/payments/verify.php");
    const refundReviewPhp = readProjectFile("api/admin/subscription-refund-review.php");

    assert.match(createOrderPhp, /getRazorpayConfig\(\)/);
    assert.match(verifyPhp, /getRazorpayConfig\(\)/);
    assert.match(refundReviewPhp, /getRazorpayConfig\(\)/);

    // Must never echo/return or log Razorpay secrets
    assert.doesNotMatch(createOrderPhp, /jsonResponse\(\[[^\]]*\$keySecret/);
    assert.doesNotMatch(verifyPhp, /jsonResponse\(\[[^\]]*\$secret/);
    assert.doesNotMatch(refundReviewPhp, /jsonResponse\(\[[^\]]*\$rzpSecret/);
    assert.doesNotMatch(verifyPhp, /error_log\([^\n]*\$secret/);
  });

  it("3. api/config/razorpay_credentials.php is not committed and credential files are gitignored & blocked in .htaccess", () => {
    const trackedCredFileExists = fs.existsSync(
      path.join(ROOT_DIR, "api/config/razorpay_credentials.php"),
    );
    assert.equal(trackedCredFileExists, false);

    const gitignore = readProjectFile(".gitignore");
    assert.match(gitignore, /\*_credentials\.php/);
    assert.match(gitignore, /api\/config\/\*_credentials\.php/);

    const htaccess = readProjectFile("api/.htaccess");
    assert.match(htaccess, /_credentials\\\.php/);
  });
});

describe("Task 2: Promotion Success Confirmation & Duplicate Notification Prevention", () => {
  it("1. markVideoPromoted fails closed and rejects when /videos/promote.php fails", async () => {
    const origFetch = globalThis.fetch;
    const origLocalStorage = (globalThis as any).localStorage;
    const storage = createMemoryStorage();
    storage.setItem(
      "facetube_uploaded_videos",
      JSON.stringify([
        {
          id: "vid-test-1",
          userId: "FT483921",
          title: "Test Video",
          isPromoted: false,
        },
      ]),
    );
    (globalThis as any).localStorage = storage;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ success: false, error: "Database promotion update failed" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    try {
      await assert.rejects(
        () =>
          markVideoPromoted({
            videoId: "vid-test-1",
            planId: "plan-7-days",
            durationDays: 7,
            paymentId: "pay_fail_1",
          }),
        /Database promotion update failed|Promotion was not confirmed/i,
      );

      const stored = JSON.parse(storage.getItem("facetube_uploaded_videos") || "[]");
      assert.equal(stored[0]?.isPromoted, false);
    } finally {
      globalThis.fetch = origFetch;
      (globalThis as any).localStorage = origLocalStorage;
    }
  });

  it("2. initiatePremiumVideoPayment fires onSuccess once even if Razorpay handler fires twice, and only after verify + video create succeed", async () => {
    const origFetch = globalThis.fetch;
    const origWindow = (globalThis as any).window;
    const origLocalStorage = (globalThis as any).localStorage;
    (globalThis as any).localStorage = createMemoryStorage();

    let capturedOptions: any = null;
    (globalThis as any).window = {
      location: { hostname: "localhost" },
      Razorpay: class MockRazorpay {
        constructor(opts: any) {
          capturedOptions = opts;
        }
        open() {
          // Simulate duplicate Razorpay checkout handler invocations
          void capturedOptions.handler({
            razorpay_payment_id: "pay_dup_123",
            razorpay_order_id: "order_dup_123",
            razorpay_signature: "sig_valid_123",
          });
          void capturedOptions.handler({
            razorpay_payment_id: "pay_dup_123",
            razorpay_order_id: "order_dup_123",
            razorpay_signature: "sig_valid_123",
          });
          // Simulate delayed modal dismiss after completion already began
          capturedOptions.modal?.ondismiss?.();
        }
      },
    };

    const apiCalls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      apiCalls.push(url);
      if (url.includes("/payments/create-order.php")) {
        return new Response(
          JSON.stringify({
            orderId: "order_dup_123",
            amount: 6,
            amountInSubunits: 600,
            currency: "INR",
            keyId: "rzp_test_key",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/payments/verify.php")) {
        return new Response(
          JSON.stringify({
            verified: true,
            paymentId: "pay_dup_123",
            orderId: "order_dup_123",
            txNumber: 5,
            isSpecialTransaction: false,
            specialTag: "NORMAL_PREMIUM",
            distribution: { adminAmount: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/videos/create.php")) {
        return new Response(JSON.stringify({ success: true, video: { id: "vid-dup-1" } }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/ledger/distribute")) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      let successCount = 0;
      let failureCount = 0;
      let cancelCount = 0;

      await new Promise<void>((resolve) => {
        void initiatePremiumVideoPayment({
          uploaderUserId: "FT483921",
          uploaderName: "Test Creator",
          videoId: "vid-dup-1",
          videoTitle: "Promo Test",
          videoUrl: "https://cdn.example.com/test.mp4",
          contentType: "long",
          onSuccess: () => {
            successCount++;
            setTimeout(resolve, 25);
          },
          onFailure: () => {
            failureCount++;
            resolve();
          },
          onCancel: () => {
            cancelCount++;
          },
        });
      });

      assert.equal(successCount, 1);
      assert.equal(failureCount, 0);
      assert.equal(cancelCount, 0);
      assert.equal(apiCalls.filter((u) => u.includes("/payments/verify.php")).length, 1);
      assert.equal(apiCalls.filter((u) => u.includes("/videos/create.php")).length, 1);
    } finally {
      globalThis.fetch = origFetch;
      (globalThis as any).window = origWindow;
      (globalThis as any).localStorage = origLocalStorage;
    }
  });

  it("3. initiatePremiumVideoPayment fails and never invokes onSuccess when video persistence fails", async () => {
    const origFetch = globalThis.fetch;
    const origWindow = (globalThis as any).window;
    const origLocalStorage = (globalThis as any).localStorage;
    (globalThis as any).localStorage = createMemoryStorage();

    (globalThis as any).window = {
      location: { hostname: "localhost" },
      Razorpay: class MockRazorpay {
        private opts: any;
        constructor(opts: any) {
          this.opts = opts;
        }
        open() {
          void this.opts.handler({
            razorpay_payment_id: "pay_err_1",
            razorpay_order_id: "order_err_1",
            razorpay_signature: "sig_err_1",
          });
        }
      },
    };

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/payments/create-order.php")) {
        return new Response(
          JSON.stringify({
            orderId: "order_err_1",
            amount: 6,
            amountInSubunits: 600,
            currency: "INR",
            keyId: "rzp_test_key",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/payments/verify.php")) {
        return new Response(
          JSON.stringify({ verified: true, paymentId: "pay_err_1", orderId: "order_err_1" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/videos/create.php")) {
        return new Response(JSON.stringify({ success: false, error: "DB write failed" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      let successCount = 0;
      let capturedError = "";

      await new Promise<void>((resolve) => {
        void initiatePremiumVideoPayment({
          uploaderUserId: "FT483921",
          uploaderName: "Test Creator",
          videoId: "vid-err-1",
          videoTitle: "Fail Video",
          videoUrl: "https://cdn.example.com/fail.mp4",
          contentType: "short",
          onSuccess: () => {
            successCount++;
            resolve();
          },
          onFailure: (err) => {
            capturedError = err;
            resolve();
          },
        });
      });

      assert.equal(successCount, 0);
      assert.match(capturedError, /DB write failed|Server rejected/i);
    } finally {
      globalThis.fetch = origFetch;
      (globalThis as any).window = origWindow;
      (globalThis as any).localStorage = origLocalStorage;
    }
  });

  it("4. initiateAdsPromotionPayment prevents duplicate completion and fails safely if /videos/promote.php rejects", async () => {
    const origFetch = globalThis.fetch;
    const origWindow = (globalThis as any).window;
    const origLocalStorage = (globalThis as any).localStorage;
    (globalThis as any).localStorage = createMemoryStorage();

    (globalThis as any).window = {
      location: { hostname: "localhost" },
      Razorpay: class MockRazorpay {
        private opts: any;
        constructor(opts: any) {
          this.opts = opts;
        }
        open() {
          void this.opts.handler({
            razorpay_payment_id: "pay_ads_1",
            razorpay_order_id: "order_ads_1",
            razorpay_signature: "sig_ads_1",
          });
          void this.opts.handler({
            razorpay_payment_id: "pay_ads_1",
            razorpay_order_id: "order_ads_1",
            razorpay_signature: "sig_ads_1",
          });
        }
      },
    };

    let promoteCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/payments/create-order.php")) {
        return new Response(
          JSON.stringify({
            orderId: "order_ads_1",
            amount: 100,
            amountInSubunits: 10000,
            currency: "INR",
            keyId: "rzp_test_key",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/payments/verify.php")) {
        return new Response(
          JSON.stringify({ verified: true, paymentId: "pay_ads_1", orderId: "order_ads_1" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/videos/promote.php")) {
        promoteCalls++;
        return new Response(JSON.stringify({ success: false, error: "Promotion table locked" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      let successCount = 0;
      let failureMsg = "";

      await new Promise<void>((resolve) => {
        void initiateAdsPromotionPayment({
          userId: "FT483921",
          userName: "Test Creator",
          videoId: "vid-ads-1",
          planId: "plan-7-days",
          planName: "7 Days",
          durationDays: 7,
          price: 100,
          onSuccess: () => {
            successCount++;
            resolve();
          },
          onFailure: (err) => {
            failureMsg = err;
            resolve();
          },
        });
      });

      assert.equal(promoteCalls, 1);
      assert.equal(successCount, 0);
      assert.match(failureMsg, /Promotion table locked|Promotion was not confirmed/i);
    } finally {
      globalThis.fetch = origFetch;
      (globalThis as any).window = origWindow;
      (globalThis as any).localStorage = origLocalStorage;
    }
  });

  it("5. upload.tsx and ads-promotions.tsx render the requested celebratory confirmation copy with deduplication", () => {
    const uploadTsx = readProjectFile("src/routes/upload.tsx");
    const adsPromotionsTsx = readProjectFile("src/routes/ads-promotions.tsx");

    assert.match(uploadTsx, /🎉 Your Video Promotion Was Successful!/);
    assert.match(
      uploadTsx,
      /Your video has been uploaded successfully and your promotion is now active\. Thank you for promoting on FaceTube! ❤️/,
    );
    assert.match(uploadTsx, /notifiedSuccessIdsRef/);
    assert.match(uploadTsx, /notifiedPromoKeysRef/);
    assert.match(uploadTsx, /notifiedItemIdsRef/);

    assert.match(adsPromotionsTsx, /🎉 Your Video Promotion Was Successful!/);
    assert.match(
      adsPromotionsTsx,
      /Your video has been uploaded successfully and your promotion is now active\. Thank you for promoting on FaceTube! ❤️/,
    );
    assert.match(adsPromotionsTsx, /notifiedPromoIdsRef/);
  });

  it("6. initiatePremiumVideoPayment does NOT perform a second client-side Global Pool distribution after server verification", async () => {
    const origFetch = globalThis.fetch;
    const origWindow = (globalThis as any).window;
    const origLocalStorage = (globalThis as any).localStorage;
    const storage = createMemoryStorage();
    // Seed existing premium video in localStorage that old client-side code would try to pay out
    storage.setItem(
      "facetube_uploaded_videos",
      JSON.stringify([
        {
          id: "vid-existing-other",
          userId: "CR_OTHER",
          title: "Existing Video",
          videoType: "premium",
          paymentStatus: "paid",
        },
      ]),
    );
    (globalThis as any).localStorage = storage;

    let capturedOptions: any = null;
    (globalThis as any).window = {
      location: { hostname: "localhost" },
      Razorpay: class MockRazorpay {
        constructor(opts: any) {
          capturedOptions = opts;
        }
        open() {
          void capturedOptions.handler({
            razorpay_payment_id: "pay_no_double_1",
            razorpay_order_id: "order_no_double_1",
            razorpay_signature: "sig_no_double_1",
          });
        }
      },
    };

    const apiCalls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      apiCalls.push(url);
      if (url.includes("/payments/create-order.php")) {
        return new Response(
          JSON.stringify({
            orderId: "order_no_double_1",
            amount: 6,
            amountInSubunits: 600,
            currency: "INR",
            keyId: "rzp_test_key",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/payments/verify.php")) {
        return new Response(
          JSON.stringify({
            verified: true,
            paymentId: "pay_no_double_1",
            orderId: "order_no_double_1",
            txNumber: 2,
            isSpecialTransaction: false,
            specialTag: "NORMAL_PREMIUM",
            distribution: {
              adminAmount: 1,
              globalPoolAmount: 3,
              eligibleVideoCount: 1,
              distinctCreatorCount: 1,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/videos/create.php")) {
        return new Response(JSON.stringify({ success: true, video: { id: "vid-no-double" } }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/wallet/balance.php")) {
        return new Response(
          JSON.stringify({
            success: true,
            wallet: {
              user_id: "FT483921",
              balance: 0,
              total_earned: 0,
              total_withdrawn: 0,
              referral_income: 0,
              global_income: 0,
              adsense_income: 0,
              affiliate_income: 0,
              updated_at: "2026-01-01T00:00:00.000Z",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/wallet/transactions.php")) {
        return new Response(JSON.stringify({ success: true, transactions: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      let paymentResult: unknown = null;
      await new Promise<void>((resolve, reject) => {
        void initiatePremiumVideoPayment({
          uploaderUserId: "FT483921",
          uploaderName: "Test Creator",
          videoId: "vid-no-double",
          videoTitle: "No Double Payout Test",
          videoUrl: "https://cdn.example.com/test.mp4",
          contentType: "long",
          onSuccess: (res) => {
            paymentResult = res;
            resolve();
          },
          onFailure: (err) => reject(new Error(err)),
        });
      });

      assert.equal(paymentResult, "pay_no_double_1");
      assert.equal(
        apiCalls.some((u) => u.includes("/ledger/distribute")),
        false,
      );
      assert.equal(
        apiCalls.some((u) => u.includes("/wallet/balance.php")),
        true,
      );
      assert.equal(
        apiCalls.some((u) => u.includes("/wallet/transactions.php")),
        true,
      );

      const localLedger = JSON.parse(storage.getItem("facetube_income_ledger_v3") || "[]");
      assert.equal(localLedger.length, 0);

      const localWallets = JSON.parse(storage.getItem("facetube_user_wallets_v3") || "{}");
      assert.equal(localWallets["CR_OTHER"], undefined);
      assert.equal(localWallets["FT102857"], undefined);
    } finally {
      globalThis.fetch = origFetch;
      (globalThis as any).window = origWindow;
      (globalThis as any).localStorage = origLocalStorage;
    }
  });
});
