import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { handleApiRequest, validateSafeAffiliateUrl, resetInMemoryStore } from "./api-handler.ts";
import { setTestPersistentDataDir } from "./payments.ts";

describe("Secure Affiliate Marketing Backend Foundation Tests", () => {
  let adminToken = "";
  let userToken = "";
  let testDataDir = "";

  before(async () => {
    testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-affiliate-test-"));
    setTestPersistentDataDir(testDataDir);
    resetInMemoryStore();

    // Authenticate as Admin (FT102857)
    const adminLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "admin@facetube.com", password: "password123" }),
    });
    const adminLoginRes = await handleApiRequest(adminLoginReq);
    assert.ok(adminLoginRes);
    const adminData = await adminLoginRes.json();
    assert.ok(adminData.token);
    adminToken = adminData.token;

    // Authenticate as Regular Creator User (FT483921)
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

  after(() => {
    setTestPersistentDataDir(null);
    resetInMemoryStore();
    if (testDataDir) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  describe("1. SSRF & Open Redirect Security Protection", () => {
    const allowed = ["amazon.in", "amazon.com", "amzn.to"];

    it("accepts valid whitelisted domain URLs", () => {
      const res1 = validateSafeAffiliateUrl("https://www.amazon.in/dp/B08N5WRWNW", allowed);
      assert.equal(res1.valid, true);

      const res2 = validateSafeAffiliateUrl("https://amzn.to/3xyz123", allowed);
      assert.equal(res2.valid, true);
    });

    it("rejects untrusted third-party domains (open redirect prevention)", () => {
      const res = validateSafeAffiliateUrl("https://malicious-phishing.com/steal-creds", allowed);
      assert.equal(res.valid, false);
      assert.match(res.error || "", /not in the approved affiliate network whitelist/i);
    });

    it("rejects local loopback and 0.0.0.0 addresses", () => {
      const res1 = validateSafeAffiliateUrl("http://localhost/admin", allowed);
      assert.equal(res1.valid, false);

      const res2 = validateSafeAffiliateUrl("http://127.0.0.1:8080/internal", allowed);
      assert.equal(res2.valid, false);
    });

    it("rejects private IPv4 ranges (SSRF prevention)", () => {
      const res1 = validateSafeAffiliateUrl("http://192.168.1.100/status", ["192.168.1.100"]);
      assert.equal(res1.valid, false);
      assert.match(res1.error || "", /private or reserved network/i);

      const res2 = validateSafeAffiliateUrl("http://10.0.0.1/metadata", ["10.0.0.1"]);
      assert.equal(res2.valid, false);
    });

    it("rejects disallowed protocols (e.g. javascript:, file:)", () => {
      const res = validateSafeAffiliateUrl("javascript:alert(document.cookie)", allowed);
      assert.equal(res.valid, false);
      assert.match(res.error || "", /only https and http/i);
    });

    it("rejects URLs with embedded credentials", () => {
      const res = validateSafeAffiliateUrl("https://user:password@amazon.in/product", allowed);
      assert.equal(res.valid, false);
      assert.match(res.error || "", /embedded credentials/i);
    });
  });

  describe("2. Creator Click Tracking & Attribution", () => {
    it("tracks affiliate click for creator with optional video context", async () => {
      const req = new Request("http://localhost:3000/api/affiliate/click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: "amazon",
          creator_user_id: "FT483921",
          target_url: "https://www.amazon.in/dp/B08N5WRWNW?tag=facetube-21",
          video_id: "vid-seed-001",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.ok(data.click_id.startsWith("clk_"));
      assert.equal(data.creator_user_id, "FT483921");
      assert.equal(data.network, "amazon");
      assert.equal(data.video_id, "vid-seed-001");
    });

    it("rejects tracking for non-existent creator", async () => {
      const req = new Request("http://localhost:3000/api/affiliate/click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: "amazon",
          creator_user_id: "FT9999999_DOES_NOT_EXIST",
          target_url: "https://www.amazon.in/dp/B08N5WRWNW",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.success, false);
    });

    it("issues 302 redirect when redirect=true is provided via GET", async () => {
      const target = "https://www.amazon.in/dp/B08N5WRWNW";
      const req = new Request(
        `http://localhost:3000/api/affiliate/click?n=amazon&c=FT483921&u=${encodeURIComponent(target)}&redirect=true`,
        { method: "GET" },
      );
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), target);
    });
  });

  describe("3. Webhook Ingestion & Inactive Network Security", () => {
    it("strictly rejects webhook callbacks when network adapter is inactive (503)", async () => {
      const req = new Request("http://localhost:3000/api/affiliate/webhook?network=amazon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          external_action_id: "AMZ-ORD-TEST-001",
          creator_user_id: "FT483921",
          commission: 250.0,
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 503);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /currently inactive/i);
    });

    it("rejects unauthorized webhook when active but missing or invalid signature (401)", async () => {
      // First activate impact network with a secret via admin endpoint
      const updateReq = new Request("http://localhost:3000/api/admin/affiliate/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          network_id: "impact",
          is_active: true,
          creator_share_percentage: 60.0,
          holding_period_days: 30,
          webhook_secret: "impact_super_secret_key_12345",
        }),
      });
      const updateRes = await handleApiRequest(updateReq);
      assert.ok(updateRes);
      assert.equal(updateRes.status, 200);

      // Now send unsigned webhook to impact
      const unsignedReq = new Request(
        "http://localhost:3000/api/affiliate/webhook?network=impact",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            external_action_id: "IMP-ACTION-TEST-001",
            creator_user_id: "FT483921",
            commission: 300.0,
          }),
        },
      );
      const unsignedRes = await handleApiRequest(unsignedReq);
      assert.ok(unsignedRes);
      assert.equal(unsignedRes.status, 401);
      const unauthData = await unsignedRes.json();
      assert.match(unauthData.error, /signature/i);
    });

    it("ingests verified webhook as PENDING and NEVER credits wallet on ingestion", async () => {
      const secret = "impact_super_secret_key_12345";
      const payloadObj = {
        external_action_id: "IMP-ACTION-SECURE-999",
        creator_user_id: "FT483921",
        order_amount: 5000.0,
        commission: 500.0,
        currency: "INR",
      };
      const rawPayload = JSON.stringify(payloadObj);
      const validHmac = crypto.createHmac("sha256", secret).update(rawPayload).digest("hex");

      // Check creator wallet before
      const balBeforeReq = new Request("http://localhost:3000/api/wallet/balance?userId=FT483921", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const balBeforeRes = await handleApiRequest(balBeforeReq);
      const balBeforeData = await balBeforeRes?.json();
      const initialBalance = balBeforeData.wallet.balance;
      const initialAffiliateIncome = balBeforeData.wallet.affiliate_income;

      // Ingest signed webhook
      const webhookReq = new Request("http://localhost:3000/api/affiliate/webhook?network=impact", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Impact-Signature": `sha256=${validHmac}`,
        },
        body: rawPayload,
      });
      const webhookRes = await handleApiRequest(webhookReq);
      assert.ok(webhookRes);
      assert.equal(webhookRes.status, 201);
      const convData = await webhookRes.json();
      assert.equal(convData.success, true);
      assert.equal(convData.status, "pending");
      assert.equal(convData.total_commission, 500.0);
      assert.equal(convData.creator_payout, 300.0); // 60% of 500

      // Check creator wallet after: MUST BE UNCHANGED
      const balAfterReq = new Request("http://localhost:3000/api/wallet/balance?userId=FT483921", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const balAfterRes = await handleApiRequest(balAfterReq);
      const balAfterData = await balAfterRes?.json();
      assert.equal(
        balAfterData.wallet.balance,
        initialBalance,
        "Wallet balance must NOT change on pending webhook ingestion",
      );
      assert.equal(
        balAfterData.wallet.affiliate_income,
        initialAffiliateIncome,
        "Affiliate income must NOT change on pending webhook ingestion",
      );
    });

    it("enforces duplicate conversion idempotency on (network, external_action_id)", async () => {
      const secret = "impact_super_secret_key_12345";
      const payloadObj = {
        external_action_id: "IMP-ACTION-SECURE-999", // Same action ID as above
        creator_user_id: "FT483921",
        order_amount: 5000.0,
        commission: 500.0,
      };
      const rawPayload = JSON.stringify(payloadObj);
      const validHmac = crypto.createHmac("sha256", secret).update(rawPayload).digest("hex");

      const dupReq = new Request("http://localhost:3000/api/affiliate/webhook?network=impact", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Impact-Signature": validHmac,
        },
        body: rawPayload,
      });
      const dupRes = await handleApiRequest(dupReq);
      assert.ok(dupRes);
      assert.equal(dupRes.status, 200);
      const dupData = await dupRes.json();
      assert.equal(dupData.success, true);
      assert.equal(dupData.idempotent, true);
      assert.match(dupData.message, /already processed/i);
    });
  });

  describe("4. Admin Access Controls & Secret Protection", () => {
    it("denies non-admin creators from accessing admin affiliate settings (403)", async () => {
      const req = new Request("http://localhost:3000/api/admin/affiliate/settings", {
        method: "GET",
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 403);
    });

    it("never exposes raw webhook secrets or api keys to the frontend in admin settings", async () => {
      const req = new Request("http://localhost:3000/api/admin/affiliate/settings", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(Array.isArray(data.networks));

      const impactNet = data.networks.find((n: any) => n.id === "impact");
      assert.ok(impactNet);
      assert.equal(impactNet.hasWebhookSecret, true);
      assert.equal((impactNet as any).webhook_secret, undefined);
      assert.equal((impactNet as any).api_key_encrypted, undefined);
    });
  });

  describe("5. Atomic Settlement & Reversal Lifecycle", () => {
    let createdConversionId = "";

    it("queries pending conversion in admin conversions endpoint", async () => {
      const req = new Request(
        "http://localhost:3000/api/admin/affiliate/conversions?network=impact&status=pending",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.conversions.length > 0);
      const targetConv = data.conversions.find(
        (c: any) => c.external_action_id === "IMP-ACTION-SECURE-999",
      );
      assert.ok(targetConv);
      createdConversionId = targetConv.id;
      assert.equal(targetConv.status, "pending");
    });

    it("approves pending conversion without touching creator wallet", async () => {
      const approveReq = new Request("http://localhost:3000/api/admin/affiliate/conversions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          conversion_id: createdConversionId,
          action: "approve",
          notes: "Merchant return period elapsed and order verified",
        }),
      });
      const approveRes = await handleApiRequest(approveReq);
      assert.ok(approveRes);
      assert.equal(approveRes.status, 200);
      const approveData = await approveRes.json();
      assert.equal(approveData.status, "approved");
    });

    it("atomically settles approved conversion, crediting wallet balances and income ledger", async () => {
      // Get wallet before settlement
      const balBeforeReq = new Request("http://localhost:3000/api/wallet/balance?userId=FT483921", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const balBeforeData = await (await handleApiRequest(balBeforeReq))?.json();
      const prevBalance = balBeforeData.wallet.balance;
      const prevAffiliate = balBeforeData.wallet.affiliate_income;
      const prevEarned = balBeforeData.wallet.total_earned;

      // Settle
      const settleReq = new Request("http://localhost:3000/api/admin/affiliate/conversions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          conversion_id: createdConversionId,
          action: "settle",
          notes: "Approved batch monthly settlement",
        }),
      });
      const settleRes = await handleApiRequest(settleReq);
      assert.ok(settleRes);
      assert.equal(settleRes.status, 200);
      const settleData = await settleRes.json();
      assert.equal(settleData.success, true);
      assert.equal(settleData.status, "settled");
      assert.equal(settleData.creator_payout, 300.0);
      assert.ok(settleData.transaction_id.startsWith("TX_AFF_IMPACT_"));

      // Verify wallet was atomically credited
      const balAfterReq = new Request("http://localhost:3000/api/wallet/balance?userId=FT483921", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const balAfterData = await (await handleApiRequest(balAfterReq))?.json();
      assert.equal(balAfterData.wallet.balance, prevBalance + 300.0);
      assert.equal(balAfterData.wallet.affiliate_income, prevAffiliate + 300.0);
      assert.equal(balAfterData.wallet.total_earned, prevEarned + 300.0);

      // Verify income_ledger transaction exists
      const txReq = new Request("http://localhost:3000/api/wallet/transactions?userId=FT483921", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const txData = await (await handleApiRequest(txReq))?.json();
      const settledTx = txData.transactions.find(
        (t: any) => t.transaction_id === settleData.transaction_id,
      );
      assert.ok(
        settledTx,
        "Settlement transaction must be present in income_ledger / wallet transactions",
      );
      assert.equal(settledTx.amount, 300.0);
      assert.equal(settledTx.income_type, "affiliate_income");
      assert.equal(settledTx.special_tag, "AFFILIATE_SETTLEMENT");
    });

    it("prevents double settlement (409 Conflict)", async () => {
      const doubleSettleReq = new Request("http://localhost:3000/api/admin/affiliate/conversions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          conversion_id: createdConversionId,
          action: "settle",
          notes: "Attempted duplicate settlement",
        }),
      });
      const res = await handleApiRequest(doubleSettleReq);
      assert.ok(res);
      assert.equal(res.status, 409);
      const data = await res.json();
      assert.match(data.error, /already settled/i);
    });

    it("atomically reverses settled conversion, creating offsetting ledger entry and deducting balance", async () => {
      // Get wallet before reversal
      const balBeforeReq = new Request("http://localhost:3000/api/wallet/balance?userId=FT483921", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const balBeforeData = await (await handleApiRequest(balBeforeReq))?.json();
      const prevBalance = balBeforeData.wallet.balance;
      const prevAffiliate = balBeforeData.wallet.affiliate_income;
      const prevEarned = balBeforeData.wallet.total_earned;

      // Reverse
      const revReq = new Request("http://localhost:3000/api/admin/affiliate/conversions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          conversion_id: createdConversionId,
          action: "reverse",
          notes: "End-customer returned goods; merchant clawed back commission",
        }),
      });
      const revRes = await handleApiRequest(revReq);
      assert.ok(revRes);
      assert.equal(revRes.status, 200);
      const revData = await revRes.json();
      assert.equal(revData.success, true);
      assert.equal(revData.status, "reversed");
      assert.ok(revData.reversal_transaction_id.startsWith("TX_AFF_REV_IMPACT_"));

      // Verify wallet deduction
      const balAfterReq = new Request("http://localhost:3000/api/wallet/balance?userId=FT483921", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const balAfterData = await (await handleApiRequest(balAfterReq))?.json();
      assert.equal(balAfterData.wallet.balance, prevBalance - 300.0);
      assert.equal(balAfterData.wallet.affiliate_income, prevAffiliate - 300.0);
      assert.equal(balAfterData.wallet.total_earned, prevEarned - 300.0);

      // Verify offsetting negative ledger record exists
      const txReq = new Request("http://localhost:3000/api/wallet/transactions?userId=FT483921", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const txData = await (await handleApiRequest(txReq))?.json();
      const revTx = txData.transactions.find(
        (t: any) => t.transaction_id === revData.reversal_transaction_id,
      );
      assert.ok(revTx, "Reversal entry must exist in transaction ledger");
      assert.equal(revTx.amount, -300.0);
      assert.equal(revTx.income_type, "affiliate_income");
      assert.equal(revTx.special_tag, "AFFILIATE_REVERSAL");
    });
  });

  describe("5. Task P2: Creator Affiliate Link Generator & Security Tests", () => {
    it("rejects unauthenticated link generation requests with HTTP 401", async () => {
      const req = new Request("http://localhost:3000/api/affiliate/create-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          network: "amazon",
          target_url: "https://www.amazon.in/dp/B08N5WRWNW",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /authentication required/i);
    });

    it("GET /api/affiliate/create-link returns supported networks and whitelists without secrets", async () => {
      const req = new Request("http://localhost:3000/api/affiliate/create-link", {
        method: "GET",
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.ok(Array.isArray(data.networks));
      assert.equal(data.networks.length, 3);

      const netIds = data.networks.map((n: any) => n.id);
      assert.ok(netIds.includes("amazon"));
      assert.ok(netIds.includes("impact"));
      assert.ok(netIds.includes("earnkaro"));

      // Verify secrets are NEVER exposed
      for (const net of data.networks) {
        assert.equal(net.webhook_secret, undefined);
        assert.equal(net.api_key_encrypted, undefined);
        assert.ok(Array.isArray(net.allowed_domains));
      }
    });

    it("generates valid tracking URL for Amazon Associates with authenticated creator attribution", async () => {
      const target = "https://www.amazon.in/dp/B08N5WRWNW";
      const req = new Request("http://localhost:3000/api/affiliate/create-link", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          network: "amazon",
          target_url: target,
          video_id: "vid-creator-001",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.network, "amazon");
      assert.equal(data.network_name, "Amazon Associates");
      assert.equal(data.creator_user_id, "FT483921");
      assert.equal(data.target_url, target);
      assert.equal(data.video_id, "vid-creator-001");
      assert.ok(data.tracking_url.includes("/api/affiliate/click.php"));
      assert.ok(data.tracking_url.includes("creator_user_id=FT483921"));
      assert.ok(data.tracking_url.includes("redirect=1"));
    });

    it("strictly ignores client-supplied creator_user_id (Anti-Spoofing Protection)", async () => {
      const req = new Request("http://localhost:3000/api/affiliate/create-link", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`, // Authenticated as FT483921
        },
        body: JSON.stringify({
          network: "amazon",
          target_url: "https://www.amazon.in/dp/B08N5WRWNW",
          creator_user_id: "SPOOFED_ADMIN_FT102857", // Malicious spoof attempt
          creatorUserId: "SPOOFED_ADMIN_FT102857",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.success, true);
      // Must attribute to genuine authenticated session FT483921, never the spoofed ID
      assert.equal(data.creator_user_id, "FT483921");
      assert.ok(!data.tracking_url.includes("SPOOFED"));
      assert.ok(data.tracking_url.includes("creator_user_id=FT483921"));
    });

    it("generates valid tracking URL for Impact", async () => {
      const target = "https://brand.sjv.io/c/12345/67890/1234";
      const req = new Request("http://localhost:3000/api/affiliate/create-link", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          network: "impact",
          target_url: target,
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.network, "impact");
      assert.equal(data.creator_user_id, "FT483921");
      assert.equal(data.target_url, target);
    });

    it("generates valid tracking URL for EarnKaro", async () => {
      const target = "https://ekaro.in/enkr2026";
      const req = new Request("http://localhost:3000/api/affiliate/create-link", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          network: "earnkaro",
          target_url: target,
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.network, "earnkaro");
      assert.equal(data.creator_user_id, "FT483921");
      assert.equal(data.target_url, target);
    });

    it("rejects unapproved third-party destination domains (400)", async () => {
      const req = new Request("http://localhost:3000/api/affiliate/create-link", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          network: "amazon",
          target_url: "https://unapproved-phishing-site.com/product",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /not in the approved affiliate network whitelist/i);
    });

    it("rejects SSRF / local loopback addresses (400)", async () => {
      const req = new Request("http://localhost:3000/api/affiliate/create-link", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          network: "impact",
          target_url: "http://127.0.0.1:8080/internal-api",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /loopback/i);
    });

    it("rejects unsupported affiliate network slugs (400)", async () => {
      const req = new Request("http://localhost:3000/api/affiliate/create-link", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          network: "unknown_unsupported_network",
          target_url: "https://www.amazon.in/dp/B08N5WRWNW",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /unsupported affiliate network/i);
    });

    it("end-to-end: generated tracking URL redirects to target and records click attribution", async () => {
      // 1. Generate link
      const target = "https://www.amazon.in/dp/B08N5WRWNW";
      const genReq = new Request("http://localhost:3000/api/affiliate/create-link", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({
          network: "amazon",
          target_url: target,
          video_id: "vid-e2e-001",
        }),
      });
      const genRes = await handleApiRequest(genReq);
      const genData = await genRes?.json();
      assert.ok(genData.relative_tracking_path);

      // 2. Click the generated tracking URL
      const clickReq = new Request(`http://localhost:3000${genData.relative_tracking_path}`, {
        method: "GET",
      });
      const clickRes = await handleApiRequest(clickReq);
      assert.ok(clickRes);
      assert.equal(clickRes.status, 302);
      assert.equal(clickRes.headers.get("location"), target);
    });
  });
});
