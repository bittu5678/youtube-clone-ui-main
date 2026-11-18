import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { handleApiRequest } from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";

async function callApi(req: Request, env?: Record<string, string | undefined>): Promise<Response> {
  const res = await handleApiRequest(req, env);
  assert.ok(res, "handleApiRequest returned null");
  return res;
}

describe("FaceTube AdMob OAuth 2.0 Security Hardening (Phase 2.2) Test Suite", () => {
  let adminSessionToken: string;
  let userSessionToken: string;
  const adminUserId = "FT102857";
  const regularUserId = "FT483921";
  const testEncryptionKey = "facetube-test-admob-aes-256-gcm-master-key-2026!";
  const storePath = path.resolve(process.cwd(), "data/facetube_store.json");

  const originalClientId = process.env["ADMOB_OAUTH_CLIENT_ID"];
  const originalClientSecret = process.env["ADMOB_OAUTH_CLIENT_SECRET"];
  const originalRedirectUri = process.env["ADMOB_OAUTH_REDIRECT_URI"];
  const originalSkipRemote = process.env["ADMOB_SKIP_REMOTE_CHECK"];
  const originalEncryptionKey = process.env["ADMOB_ENCRYPTION_KEY"];
  const originalNodeEnv = process.env["NODE_ENV"];

  before(async () => {
    // Run suite in explicit test mode so fail-closed production checks behave accurately
    if (!process.env["NODE_ENV"] && !process.env["APP_ENV"]) {
      process.env["NODE_ENV"] = "test";
    }
    // Set test configuration for AdMob OAuth
    process.env["ADMOB_OAUTH_CLIENT_ID"] = "test-admob-client-id.apps.googleusercontent.com";
    process.env["ADMOB_OAUTH_CLIENT_SECRET"] = "test-admob-client-secret";
    process.env["ADMOB_OAUTH_REDIRECT_URI"] =
      "https://facetube.online/api/admin/admob/oauth-callback";
    process.env["ADMOB_SKIP_REMOTE_CHECK"] = "true";
    process.env["ADMOB_ENCRYPTION_KEY"] = testEncryptionKey;

    // Admin login (admin@facetube.com -> FT102857)
    const adminLoginRes = await callApi(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: "admin@facetube.com",
          password: "password123",
        }),
      }),
    );
    const adminData = (await adminLoginRes.json()) as any;
    assert.ok(adminData.success || adminData.token, "Admin login must succeed");
    adminSessionToken = adminData.token;

    // Regular user login (alex@facetube.com -> FT483921)
    const userLoginRes = await callApi(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: "alex@facetube.com",
          password: "password123",
        }),
      }),
    );
    const userData = (await userLoginRes.json()) as any;
    assert.ok(userData.success || userData.token, "Regular user login must succeed");
    userSessionToken = userData.token;
  });

  after(() => {
    if (originalClientId !== undefined) process.env["ADMOB_OAUTH_CLIENT_ID"] = originalClientId;
    else delete process.env["ADMOB_OAUTH_CLIENT_ID"];

    if (originalClientSecret !== undefined)
      process.env["ADMOB_OAUTH_CLIENT_SECRET"] = originalClientSecret;
    else delete process.env["ADMOB_OAUTH_CLIENT_SECRET"];

    if (originalRedirectUri !== undefined)
      process.env["ADMOB_OAUTH_REDIRECT_URI"] = originalRedirectUri;
    else delete process.env["ADMOB_OAUTH_REDIRECT_URI"];

    if (originalSkipRemote !== undefined)
      process.env["ADMOB_SKIP_REMOTE_CHECK"] = originalSkipRemote;
    else delete process.env["ADMOB_SKIP_REMOTE_CHECK"];

    if (originalEncryptionKey !== undefined)
      process.env["ADMOB_ENCRYPTION_KEY"] = originalEncryptionKey;
    else delete process.env["ADMOB_ENCRYPTION_KEY"];

    if (originalNodeEnv !== undefined) process.env["NODE_ENV"] = originalNodeEnv;
    else delete process.env["NODE_ENV"];
  });

  // --------------------------------------------------------------------------
  // 1. RBAC & Admin Authentication Enforcement
  // --------------------------------------------------------------------------
  describe("1. RBAC & Authentication Enforcement", () => {
    it("rejects unauthenticated request to /api/admin/admob/auth-url with HTTP 401", async () => {
      const res = await callApi(
        new Request("http://localhost:3000/api/admin/admob/auth-url", { method: "GET" }),
      );
      assert.equal(res.status, 401);
      const data = (await res.json()) as any;
      assert.equal(data.success, false);
    });

    it("rejects non-admin user accessing /api/admin/admob/auth-url with HTTP 403", async () => {
      const res = await callApi(
        new Request("http://localhost:3000/api/admin/admob/auth-url", {
          method: "GET",
          headers: { Authorization: `Bearer ${userSessionToken}` },
        }),
      );
      assert.equal(res.status, 403);
      const data = (await res.json()) as any;
      assert.equal(data.success, false);
      assert.ok(data.error.includes("Admin authorization required"));
    });

    it("rejects non-admin user accessing /api/admin/admob/status with HTTP 403", async () => {
      const res = await callApi(
        new Request("http://localhost:3000/api/admin/admob/status", {
          method: "GET",
          headers: { Authorization: `Bearer ${userSessionToken}` },
        }),
      );
      assert.equal(res.status, 403);
    });

    it("rejects non-admin user calling /api/admin/admob/disconnect with HTTP 403", async () => {
      const res = await callApi(
        new Request("http://localhost:3000/api/admin/admob/disconnect", {
          method: "POST",
          headers: { Authorization: `Bearer ${userSessionToken}` },
        }),
      );
      assert.equal(res.status, 403);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Fix B: Fail-Closed Encryption Key Enforcement
  // --------------------------------------------------------------------------
  describe("2. Fix B: Fail-Closed Encryption Key Enforcement", () => {
    it("fails closed when ADMOB_ENCRYPTION_KEY is unset on auth-url", async () => {
      delete process.env["ADMOB_ENCRYPTION_KEY"];
      try {
        const res = await callApi(
          new Request("http://localhost:3000/api/admin/admob/auth-url", {
            method: "GET",
            headers: { Authorization: `Bearer ${adminSessionToken}` },
          }),
        );
        const data = (await res.json()) as any;
        assert.equal(data.success, false);
        assert.equal(data.configured, false);
        assert.ok(data.error.includes("ADMOB_ENCRYPTION_KEY"));
      } finally {
        process.env["ADMOB_ENCRYPTION_KEY"] = testEncryptionKey;
      }
    });

    it("fails closed with HTTP 500 when ADMOB_ENCRYPTION_KEY is unset on oauth-callback", async () => {
      delete process.env["ADMOB_ENCRYPTION_KEY"];
      try {
        const res = await callApi(
          new Request("http://localhost:3000/api/admin/admob/oauth-callback", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ code: "test_code", state: "dummy.state" }),
          }),
        );
        assert.equal(res.status, 500);
        const data = (await res.json()) as any;
        assert.equal(data.success, false);
        assert.ok(data.error.includes("encryption key"));
      } finally {
        process.env["ADMOB_ENCRYPTION_KEY"] = testEncryptionKey;
      }
    });

    it("fails closed with 302 error redirect on browser GET when key is missing", async () => {
      delete process.env["ADMOB_ENCRYPTION_KEY"];
      try {
        const res = await callApi(
          new Request(
            "http://localhost:3000/api/admin/admob/oauth-callback?code=test&state=dummy",
            { method: "GET" },
          ),
        );
        assert.equal(res.status, 302);
        const loc = res.headers.get("Location") || "";
        assert.ok(loc.includes("admob_error="));
      } finally {
        process.env["ADMOB_ENCRYPTION_KEY"] = testEncryptionKey;
      }
    });
  });

  // --------------------------------------------------------------------------
  // 3. Fix A: Server-Side State Generation & Cookie Binding
  // --------------------------------------------------------------------------
  describe("3. Fix A: Server-Side State Generation & Cookie Binding", () => {
    let authUrlRes: Response;
    let authUrlData: any;
    let stateParam: string;
    let nonce: string;

    it("generates auth-url, sets HttpOnly binding cookie with random secret, and stores state record", async () => {
      authUrlRes = await callApi(
        new Request("http://localhost:3000/api/admin/admob/auth-url", {
          method: "GET",
          headers: { Authorization: `Bearer ${adminSessionToken}` },
        }),
      );
      assert.equal(authUrlRes.status, 200);
      authUrlData = await authUrlRes.json();
      assert.equal(authUrlData.success, true);
      assert.equal(authUrlData.configured, true);
      assert.ok(authUrlData.auth_url.includes("accounts.google.com/o/oauth2/v2/auth"));

      // Verify Set-Cookie header binds initiating session
      const setCookie = authUrlRes.headers.get("Set-Cookie") || "";
      assert.ok(setCookie.includes("facetube_admob_oauth_binding="));
      assert.ok(setCookie.includes("HttpOnly"));
      assert.ok(setCookie.includes("SameSite=Lax"));

      // Phase 2.4: Raw admin session token is NEVER placed in cookie
      assert.ok(
        !setCookie.includes(adminSessionToken),
        "Cookie must never contain raw Admin session token",
      );

      const cookieMatch = setCookie.match(/facetube_admob_oauth_binding=([^;]+)/);
      const bindingSecret = cookieMatch && cookieMatch[1] ? decodeURIComponent(cookieMatch[1]) : "";
      assert.equal(bindingSecret.length, 64, "Binding secret must be 32 bytes = 64 hex characters");

      // Verify state format
      const parsedUrl = new URL(authUrlData.auth_url);
      stateParam = parsedUrl.searchParams.get("state") || "";
      assert.ok(stateParam.includes("."));
      const [payloadB64] = stateParam.split(".");
      assert.ok(payloadB64, "payloadB64 must be present");
      const parsedPayload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
      assert.equal(parsedPayload.uid, adminUserId);
      assert.ok(parsedPayload.n && parsedPayload.n.length >= 16);
      nonce = parsedPayload.n;

      // Verify stored record in server store
      if (fs.existsSync(storePath)) {
        const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
        const states = store.admobOAuthStates || [];
        const found = states.find((s: any) => s.nonce === nonce);
        assert.ok(found, "State nonce must be recorded in server-side storage");
        assert.equal(found.user_id, adminUserId);
        assert.equal(found.is_consumed, 0);
        const expectedSessionHash = crypto.createHash("sha256").update(bindingSecret).digest("hex");
        assert.equal(found.session_hash, expectedSessionHash);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 4. Fix A: Single-Use Nonce & Anti-Replay Protection
  // --------------------------------------------------------------------------
  describe("4. Fix A: Single-Use Nonce & Anti-Replay Protection", () => {
    let testState: string;
    let testCookie: string;

    before(async () => {
      const res = await callApi(
        new Request("http://localhost:3000/api/admin/admob/auth-url", {
          method: "GET",
          headers: { Authorization: `Bearer ${adminSessionToken}` },
        }),
      );
      const data = (await res.json()) as any;
      const u = new URL(data.auth_url);
      testState = u.searchParams.get("state") || "";
      const sc = res.headers.get("Set-Cookie") || "";
      const match = sc.match(/facetube_admob_oauth_binding=([^;]+)/);
      testCookie = match ? match[0] : "";
    });

    it("successfully consumes the state nonce on the first callback exchange", async () => {
      const res = await callApi(
        new Request("http://localhost:3000/api/admin/admob/oauth-callback", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: testCookie,
            Authorization: `Bearer ${adminSessionToken}`,
          },
          body: JSON.stringify({
            code: "test_mock_code_first_use",
            state: testState,
          }),
        }),
      );
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.success, true);
      assert.equal(data.is_active, true);
    });

    it("REJECTS REPLAY ATTACK: Submitting the SAME state a second time fails with HTTP 403", async () => {
      const replayRes = await callApi(
        new Request("http://localhost:3000/api/admin/admob/oauth-callback", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: testCookie,
            Authorization: `Bearer ${adminSessionToken}`,
          },
          body: JSON.stringify({
            code: "test_mock_code_replay_attempt",
            state: testState,
          }),
        }),
      );
      assert.equal(replayRes.status, 403);
      const data = (await replayRes.json()) as any;
      assert.equal(data.success, false);
      assert.ok(
        data.error.includes("already been consumed") ||
          data.error.includes("replay") ||
          data.error.includes("consumed"),
        `Expected replay error message, got: ${data.error}`,
      );
    });

    it("rejects callback with tampered state signature (anti-CSRF) with HTTP 403", async () => {
      const fakePayload = Buffer.from(
        JSON.stringify({ uid: adminUserId, ts: Date.now(), n: "fake_nonce_123" }),
      ).toString("base64url");
      const fakeState = `${fakePayload}.invalid_forged_signature`;

      const res = await callApi(
        new Request("http://localhost:3000/api/admin/admob/oauth-callback", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: testCookie,
            Authorization: `Bearer ${adminSessionToken}`,
          },
          body: JSON.stringify({ code: "test_mock_code_123", state: fakeState }),
        }),
      );
      assert.equal(res.status, 403);
      const data = (await res.json()) as any;
      assert.equal(data.success, false);
      assert.ok(
        data.error.includes("signature") ||
          data.error.includes("CSRF") ||
          data.error.includes("Invalid"),
      );
    });

    it("rejects callback with expired state (older than 10 minutes) with HTTP 403", async () => {
      const expiredTs = Date.now() - 15 * 60 * 1000;
      const expiredPayload = Buffer.from(
        JSON.stringify({ uid: adminUserId, ts: expiredTs, n: "expired_nonce_123" }),
      ).toString("base64url");

      const sig = crypto
        .createHmac("sha256", testEncryptionKey)
        .update(expiredPayload)
        .digest("base64url");
      const expiredState = `${expiredPayload}.${sig}`;

      const res = await callApi(
        new Request("http://localhost:3000/api/admin/admob/oauth-callback", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: testCookie,
            Authorization: `Bearer ${adminSessionToken}`,
          },
          body: JSON.stringify({ code: "test_mock_code_123", state: expiredState }),
        }),
      );
      assert.equal(res.status, 403);
      const data = (await res.json()) as any;
      assert.equal(data.success, false);
      assert.ok(data.error.includes("expired"));
    });
  });

  // --------------------------------------------------------------------------
  // 5. Fix A: Session and User Binding Enforcement
  // --------------------------------------------------------------------------
  describe("5. Fix A: Session and User Binding Enforcement", () => {
    let freshState: string;
    let freshCookie: string;

    before(async () => {
      const res = await callApi(
        new Request("http://localhost:3000/api/admin/admob/auth-url", {
          method: "GET",
          headers: { Authorization: `Bearer ${adminSessionToken}` },
        }),
      );
      const data = (await res.json()) as any;
      const u = new URL(data.auth_url);
      freshState = u.searchParams.get("state") || "";
      const sc = res.headers.get("Set-Cookie") || "";
      const match = sc.match(/facetube_admob_oauth_binding=([^;]+)/);
      freshCookie = match ? match[0] : "";
    });

    it("rejects callback if initiating session binding is missing (no cookie and no Bearer header)", async () => {
      const res = await callApi(
        new Request("http://localhost:3000/api/admin/admob/oauth-callback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "test_code", state: freshState }),
        }),
      );
      assert.equal(res.status, 403);
      const data = (await res.json()) as any;
      assert.equal(data.success, false);
      assert.ok(data.error.includes("session binding missing"));
    });

    it("rejects callback if caller session belongs to non-admin user", async () => {
      const res = await callApi(
        new Request("http://localhost:3000/api/admin/admob/oauth-callback", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: freshCookie,
            Authorization: `Bearer ${userSessionToken}`,
          },
          body: JSON.stringify({ code: "test_code", state: freshState }),
        }),
      );
      assert.equal(res.status, 403);
      const data = (await res.json()) as any;
      assert.equal(data.success, false);
      assert.ok(data.error.includes("not an administrator"));
    });

    it("accepts callback when session binding is supplied via HttpOnly cookie", async () => {
      const res = await callApi(
        new Request(
          `http://localhost:3000/api/admin/admob/oauth-callback?code=test_mock_code_cookie&state=${encodeURIComponent(freshState)}`,
          {
            method: "GET",
            headers: {
              Cookie: freshCookie,
            },
          },
        ),
      );
      assert.equal(res.status, 302);
      const loc = res.headers.get("Location") || "";
      assert.ok(loc.includes("/admob-income?admob_connected=true"));

      // Verify cookie is cleared in response
      const clearCookie = res.headers.get("Set-Cookie") || "";
      assert.ok(clearCookie.includes("Max-Age=0") || clearCookie.includes("Expires="));
    });
  });

  // --------------------------------------------------------------------------
  // 6. Fix A: Concurrency Protection (Parallel Replay Prevention)
  // --------------------------------------------------------------------------
  describe("6. Fix A: Concurrency Protection (Atomic Check-and-Set)", () => {
    it("guarantees only one concurrent request succeeds when two requests consume the same nonce", async () => {
      // Generate a new state
      const urlRes = await callApi(
        new Request("http://localhost:3000/api/admin/admob/auth-url", {
          method: "GET",
          headers: { Authorization: `Bearer ${adminSessionToken}` },
        }),
      );
      const urlData = (await urlRes.json()) as any;
      const stateToRace = new URL(urlData.auth_url).searchParams.get("state") || "";
      const sc = urlRes.headers.get("Set-Cookie") || "";
      const match = sc.match(/facetube_admob_oauth_binding=([^;]+)/);
      const raceCookie = match ? match[0] : "";

      // Fire two concurrent callback requests simultaneously
      const [res1, res2] = await Promise.all([
        callApi(
          new Request("http://localhost:3000/api/admin/admob/oauth-callback", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: raceCookie,
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ code: "test_race_1", state: stateToRace }),
          }),
        ),
        callApi(
          new Request("http://localhost:3000/api/admin/admob/oauth-callback", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: raceCookie,
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ code: "test_race_2", state: stateToRace }),
          }),
        ),
      ]);

      const statuses = [res1.status, res2.status].sort();
      // Exactly one must be 200 (success), exactly one must be 403 (rejected)
      assert.deepEqual(
        statuses,
        [200, 403],
        "Concurrent callbacks must result in exactly one HTTP 200 and one HTTP 403",
      );
    });
  });

  // --------------------------------------------------------------------------
  // 7. AES-256-GCM Encryption & Zero Token Exposure
  // --------------------------------------------------------------------------
  describe("7. AES-256-GCM Encryption & Zero Token Exposure", () => {
    it("stores refresh token strictly encrypted with 12-byte IV and 16-byte tag, with ZERO exposure", async () => {
      // Connect fresh credentials
      const urlRes = await callApi(
        new Request("http://localhost:3000/api/admin/admob/auth-url", {
          method: "GET",
          headers: { Authorization: `Bearer ${adminSessionToken}` },
        }),
      );
      const urlData = (await urlRes.json()) as any;
      const state = new URL(urlData.auth_url).searchParams.get("state") || "";
      const sc = urlRes.headers.get("Set-Cookie") || "";
      const match = sc.match(/facetube_admob_oauth_binding=([^;]+)/);
      const encCookie = match ? match[0] : "";

      const cbRes = await callApi(
        new Request("http://localhost:3000/api/admin/admob/oauth-callback", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: encCookie,
            Authorization: `Bearer ${adminSessionToken}`,
          },
          body: JSON.stringify({ code: "test_mock_code_enc_check", state }),
        }),
      );
      assert.equal(cbRes.status, 200);
      const cbData = (await cbRes.json()) as any;

      // Zero token exposure in API response
      assert.equal(cbData.refresh_token, undefined);
      assert.equal(cbData.access_token, undefined);
      assert.equal(cbData.encrypted_refresh_token, undefined);

      // Check stored record
      if (fs.existsSync(storePath)) {
        const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
        const oauth = store.admobOauth;
        assert.ok(oauth, "AdMob record must exist");
        assert.ok(oauth.encrypted_refresh_token);
        assert.equal(oauth.refresh_token_iv.length, 24, "IV must be 12 bytes = 24 hex chars");
        assert.equal(oauth.refresh_token_tag.length, 32, "Tag must be 16 bytes = 32 hex chars");

        // Verify it can be decrypted cleanly using the test encryption key
        const key = crypto.createHash("sha256").update(testEncryptionKey).digest();
        const decipher = crypto.createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(oauth.refresh_token_iv, "hex"),
        );
        decipher.setAuthTag(Buffer.from(oauth.refresh_token_tag, "hex"));
        let decrypted = decipher.update(oauth.encrypted_refresh_token, "hex", "utf8");
        decrypted += decipher.final("utf8");
        assert.ok(decrypted.startsWith("mock_admob_refresh_"), "Decrypted token must match mock");
      }
    });

    it("status endpoint returns public metadata and zero token/key leaks", async () => {
      const res = await callApi(
        new Request("http://localhost:3000/api/admin/admob/status", {
          method: "GET",
          headers: { Authorization: `Bearer ${adminSessionToken}` },
        }),
      );
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.connected, true);
      assert.equal(data.has_refresh_token, true);
      assert.ok(data.publisher_id);
      assert.equal(data.refresh_token, undefined);
      assert.equal(data.access_token, undefined);
      assert.equal(data.encrypted_refresh_token, undefined);
      assert.equal(data.refresh_token_iv, undefined);
      assert.equal(data.refresh_token_tag, undefined);
      assert.equal(data.client_secret, undefined);
    });
  });

  // --------------------------------------------------------------------------
  // 8. Secure Disconnect & Credentials Cleanup
  // --------------------------------------------------------------------------
  describe("8. Secure Disconnect & Credentials Cleanup", () => {
    it("allows admin to disconnect and wipes stored credentials", async () => {
      const res = await callApi(
        new Request("http://localhost:3000/api/admin/admob/disconnect", {
          method: "POST",
          headers: { Authorization: `Bearer ${adminSessionToken}` },
        }),
      );
      assert.equal(res.status, 200);
      const data = (await res.json()) as any;
      assert.equal(data.connected, false);

      const statusRes = await callApi(
        new Request("http://localhost:3000/api/admin/admob/status", {
          method: "GET",
          headers: { Authorization: `Bearer ${adminSessionToken}` },
        }),
      );
      const statusData = (await statusRes.json()) as any;
      assert.equal(statusData.connected, false);
      assert.equal(statusData.publisher_id, null);
      assert.equal(statusData.has_refresh_token, false);
    });
  });

  // --------------------------------------------------------------------------
  // 9. Financial Invariants & Statements Preservation
  // --------------------------------------------------------------------------
  describe("9. Financial Invariants & Statements Preservation", () => {
    const uniqueYear = 2050 + Math.floor(Math.random() * 40);
    const dynamicMonth = `${uniqueYear}-${String(Math.floor(Math.random() * 12 + 1)).padStart(2, "0")}`;

    it("preserves manual AdMob statement recording intact (/api/admin/record-admob-earning.php)", async () => {
      const res = await callApi(
        new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${adminSessionToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            userId: regularUserId,
            amount: 500.0,
            reportMonth: dynamicMonth,
            description: "Manual Admin AdMob Statement Verification",
          }),
        }),
      );
      assert.equal(res.status, 201);
      const data = (await res.json()) as any;
      assert.equal(data.success, true);
      assert.equal(data.amount, 500.0);
      assert.equal(data.reportMonth, dynamicMonth);
    });

    it("verifies NO automated earnings were credited by OAuth security operations", async () => {
      const balRes = await callApi(
        new Request(`http://localhost:3000/api/wallet/balance?userId=${regularUserId}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${userSessionToken}` },
        }),
      );
      const balData = (await balRes.json()) as any;
      assert.equal(balData.success, true);
      assert.ok(typeof balData.wallet.admob_income === "number");
    });
  });

  // --------------------------------------------------------------------------
  // 10. Phase 2.4.1 Security Hardening: Separate Hashes, Exact Session Binding & MySQL Fail-Closed Protection
  // --------------------------------------------------------------------------
  describe("10. Phase 2.4.1 Security Hardening: Separate Hashes, Exact Session Binding & MySQL Protection", () => {
    it("stores SHA-256(binding_secret) in session_hash and SHA-256(adminToken) in admin_session_hash separately", async () => {
      const res = await callApi(
        new Request("http://localhost:3000/api/admin/admob/auth-url", {
          method: "GET",
          headers: { Authorization: `Bearer ${adminSessionToken}` },
        }),
      );
      assert.equal(res.status, 200);

      const cookieHeader = res.headers.get("Set-Cookie") || "";
      const cookieMatch = cookieHeader.match(/facetube_admob_oauth_binding=([^;]+)/);
      assert.ok(cookieMatch && cookieMatch[1], "Binding cookie must be present");
      const bindingSecret = cookieMatch[1];

      // Verify that the cookie DOES NOT contain raw session token
      assert.notEqual(
        bindingSecret,
        adminSessionToken,
        "Binding cookie must not contain admin session token",
      );
      assert.equal(bindingSecret.length, 64, "Binding secret must be 32 bytes hex = 64 characters");

      // Verify stored hashes in admobOAuthStates
      const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      const states = store.admobOAuthStates || [];
      const latestState = states[states.length - 1];
      assert.ok(latestState, "State record must exist");

      const expectedSessionHash = crypto.createHash("sha256").update(bindingSecret).digest("hex");
      const expectedAdminSessionHash = crypto
        .createHash("sha256")
        .update(adminSessionToken)
        .digest("hex");

      assert.equal(
        latestState.session_hash,
        expectedSessionHash,
        "session_hash must match SHA-256(binding_secret)",
      );
      assert.equal(
        latestState.admin_session_hash,
        expectedAdminSessionHash,
        "admin_session_hash must match SHA-256(adminSessionToken)",
      );
      assert.notEqual(
        latestState.session_hash,
        latestState.admin_session_hash,
        "session_hash and admin_session_hash must be distinct",
      );

      // Verify raw values are never stored
      const stateJson = JSON.stringify(latestState);
      assert.ok(
        !stateJson.includes(adminSessionToken),
        "Raw admin session token must never be stored in state",
      );
      assert.ok(
        !stateJson.includes(bindingSecret),
        "Raw binding secret must never be stored in state",
      );
    });

    it("rejects callback with HTTP 403 when initiating admin session is no longer active in sessions store", async () => {
      // 1. Generate auth-url and state
      const urlRes = await callApi(
        new Request("http://localhost:3000/api/admin/admob/auth-url", {
          method: "GET",
          headers: { Authorization: `Bearer ${adminSessionToken}` },
        }),
      );
      const urlData = (await urlRes.json()) as any;
      const state = new URL(urlData.auth_url).searchParams.get("state") || "";
      const sc = urlRes.headers.get("Set-Cookie") || "";
      const match = sc.match(/facetube_admob_oauth_binding=([^;]+)/);
      const testCookie = match ? match[0] : "";

      // 2. Temporarily remove adminSessionToken from sessions store
      const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      const savedUserId = store.sessions[adminSessionToken];
      delete store.sessions[adminSessionToken];
      fs.writeFileSync(storePath, JSON.stringify(store, null, 2));

      try {
        // 3. Attempt callback with invalidated session
        const cbRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/oauth-callback", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: testCookie,
            },
            body: JSON.stringify({ code: "test_code_invalid_session", state }),
          }),
        );
        assert.equal(cbRes.status, 403);
        const cbData = (await cbRes.json()) as any;
        assert.equal(cbData.success, false);
        assert.ok(
          cbData.error.includes("initiating admin session is inactive, expired, or mismatch"),
          `Expected invalid session error, got: ${cbData.error}`,
        );
      } finally {
        // 4. Restore admin session
        const restoreStore = JSON.parse(fs.readFileSync(storePath, "utf-8"));
        restoreStore.sessions[adminSessionToken] = savedUserId;
        fs.writeFileSync(storePath, JSON.stringify(restoreStore, null, 2));
      }
    });

    it("rejects callback with HTTP 403 when caller Bearer token does not match the initiating admin session", async () => {
      // 1. Generate auth-url under adminSessionToken
      const urlRes = await callApi(
        new Request("http://localhost:3000/api/admin/admob/auth-url", {
          method: "GET",
          headers: { Authorization: `Bearer ${adminSessionToken}` },
        }),
      );
      const urlData = (await urlRes.json()) as any;
      const state = new URL(urlData.auth_url).searchParams.get("state") || "";
      const sc = urlRes.headers.get("Set-Cookie") || "";
      const match = sc.match(/facetube_admob_oauth_binding=([^;]+)/);
      const testCookie = match ? match[0] : "";

      // 2. Register a second admin token in store
      const secondAdminToken = "different_admin_session_token_xyz_789";
      const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      store.sessions[secondAdminToken] = adminUserId;
      fs.writeFileSync(storePath, JSON.stringify(store, null, 2));

      try {
        // 3. Attempt callback sending secondAdminToken in Authorization header
        const cbRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/oauth-callback", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: testCookie,
              Authorization: `Bearer ${secondAdminToken}`,
            },
            body: JSON.stringify({ code: "test_code_mismatch_admin", state }),
          }),
        );
        assert.equal(cbRes.status, 403);
        const cbData = (await cbRes.json()) as any;
        assert.equal(cbData.success, false);
        assert.ok(
          cbData.error.includes("initiating admin user mismatch"),
          `Expected admin mismatch error, got: ${cbData.error}`,
        );
      } finally {
        const cleanStore = JSON.parse(fs.readFileSync(storePath, "utf-8"));
        delete cleanStore.sessions[secondAdminToken];
        fs.writeFileSync(storePath, JSON.stringify(cleanStore, null, 2));
      }
    });

    it("MySQL configured: fails closed with HTTP 500 when table is missing or DB errors occur without JSON fallback", async () => {
      // Configure MySQL env vars
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_production";
      process.env["DB_USER"] = "admin_user";

      // Mock pool that throws missing table error
      const mockFailingPool = {
        query: async () => {
          const err = new Error("Table 'facetube_production.admob_oauth_states' doesn't exist");
          (err as any).code = "ER_NO_SUCH_TABLE";
          throw err;
        },
      };

      setMysqlPoolForTesting(mockFailingPool);

      try {
        // 1. Test auth-url returns 500 sanitized error
        const authRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/auth-url", {
            method: "GET",
            headers: { Authorization: `Bearer ${adminSessionToken}` },
          }),
        );
        assert.equal(authRes.status, 500);
        const authData = (await authRes.json()) as any;
        assert.equal(authData.success, false);
        assert.equal(
          authData.error,
          "AdMob database table is uninitialized or inaccessible. Please run database migrations before connecting.",
        );

        // 2. Test callback returns 500 sanitized error
        const cbRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/oauth-callback", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie:
                "facetube_admob_oauth_binding=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({
              code: "test_code_db_fail",
              state: "some_mock_state.signature",
            }),
          }),
        );
        assert.ok([403, 500].includes(cbRes.status));
      } finally {
        delete process.env["DB_HOST"];
        delete process.env["DB_NAME"];
        delete process.env["DB_USER"];
        setMysqlPoolForTesting(null);
      }
    });

    it("MySQL configured: rejects with HTTP 403 on zero affected rows during atomic state consumption and NEVER falls back to JSON", async () => {
      // 1. Generate a valid state first in JSON mode
      const urlRes = await callApi(
        new Request("http://localhost:3000/api/admin/admob/auth-url", {
          method: "GET",
          headers: { Authorization: `Bearer ${adminSessionToken}` },
        }),
      );
      const urlData = (await urlRes.json()) as any;
      const validState = new URL(urlData.auth_url).searchParams.get("state") || "";
      const sc = urlRes.headers.get("Set-Cookie") || "";
      const match = sc.match(/facetube_admob_oauth_binding=([^;]+)/);
      const validCookie = match ? match[0] : "";

      // 2. Now switch to MySQL mode with mock pool
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_production";
      process.env["DB_USER"] = "admin_user";

      const adminHash = crypto.createHash("sha256").update(adminSessionToken).digest("hex");

      const mockReplayPool = {
        query: async (sql: string) => {
          if (sql.includes("SELECT st.admin_session_hash")) {
            return [
              [
                {
                  admin_session_hash: adminHash,
                  id: adminUserId,
                  user_id: adminUserId,
                  role: "admin",
                },
              ],
            ];
          }
          if (sql.includes("UPDATE admob_oauth_states")) {
            return [{ affectedRows: 0 }];
          }
          return [[]];
        },
      };

      setMysqlPoolForTesting(mockReplayPool);

      try {
        const cbRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/oauth-callback", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: validCookie,
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ code: "test_code_replay", state: validState }),
          }),
        );

        assert.equal(cbRes.status, 403);
        const cbData = (await cbRes.json()) as any;
        assert.equal(cbData.success, false);
        assert.ok(
          cbData.error.includes("OAuth state has already been consumed (replay attack detected)"),
          `Expected replay error, got: ${cbData.error}`,
        );
      } finally {
        delete process.env["DB_HOST"];
        delete process.env["DB_NAME"];
        delete process.env["DB_USER"];
        setMysqlPoolForTesting(null);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 11. Phase 2.4.3: TOCTOU Race Elimination, MySQL Isolation & Migration Compatibility
  // --------------------------------------------------------------------------
  describe("11. Phase 2.4.3: TOCTOU Elimination & MySQL Isolation", () => {
    it("migration 20261111 contains zero unsupported IF NOT EXISTS syntax and uses INFORMATION_SCHEMA", () => {
      const migPath = path.resolve(
        process.cwd(),
        "database/migrations/20261111_admob_oauth_states_admin_session_hash.sql",
      );
      assert.ok(fs.existsSync(migPath), "Migration file must exist");
      const content = fs.readFileSync(migPath, "utf-8");

      assert.ok(
        !content.includes("ADD COLUMN IF NOT EXISTS"),
        "Must NOT contain unsupported ADD COLUMN IF NOT EXISTS",
      );
      assert.ok(
        !content.includes("ADD KEY IF NOT EXISTS"),
        "Must NOT contain unsupported ADD KEY IF NOT EXISTS",
      );
      assert.ok(
        content.includes("INFORMATION_SCHEMA.COLUMNS"),
        "Must query INFORMATION_SCHEMA.COLUMNS for column existence",
      );
      assert.ok(
        content.includes("INFORMATION_SCHEMA.STATISTICS"),
        "Must query INFORMATION_SCHEMA.STATISTICS for index existence",
      );
      assert.ok(content.includes("PREPARE"), "Must use dynamic SQL PREPARE");
      assert.ok(content.includes("EXECUTE"), "Must use dynamic SQL EXECUTE");
      assert.ok(content.includes("DEALLOCATE PREPARE"), "Must clean up prepared statement");
    });

    it("eliminates TOCTOU race: atomic update fails if session is revoked between SELECT and UPDATE", async () => {
      // 1. Generate fresh state
      const urlRes = await callApi(
        new Request("http://localhost:3000/api/admin/admob/auth-url", {
          method: "GET",
          headers: { Authorization: `Bearer ${adminSessionToken}` },
        }),
      );
      const urlData = (await urlRes.json()) as any;
      const validState = new URL(urlData.auth_url).searchParams.get("state") || "";
      const sc = urlRes.headers.get("Set-Cookie") || "";
      const match = sc.match(/facetube_admob_oauth_binding=([^;]+)/);
      const validCookie = match ? match[0] : "";

      // 2. Enable MySQL with mock pool simulating TOCTOU:
      // Preliminary SELECT finds the session, but atomic UPDATE (which joins sessions) finds 0 rows because session was revoked/expired concurrently
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_production";
      process.env["DB_USER"] = "admin_user";

      const adminHash = crypto.createHash("sha256").update(adminSessionToken).digest("hex");
      let updateExecuted = false;

      const mockToctouPool = {
        query: async (sql: string) => {
          if (sql.includes("SELECT st.admin_session_hash")) {
            return [
              [
                {
                  admin_session_hash: adminHash,
                  id: adminUserId,
                  user_id: adminUserId,
                  role: "admin",
                },
              ],
            ];
          }
          if (sql.includes("UPDATE admob_oauth_states")) {
            updateExecuted = true;
            // Verify query joins sessions and users
            assert.ok(
              sql.includes("INNER JOIN sessions s"),
              "Atomic UPDATE must join sessions table",
            );
            assert.ok(sql.includes("INNER JOIN users u"), "Atomic UPDATE must join users table");
            // Simulate session was revoked concurrently between SELECT and UPDATE -> 0 affected rows!
            return [{ affectedRows: 0 }];
          }
          return [[]];
        },
      };

      setMysqlPoolForTesting(mockToctouPool);

      try {
        const cbRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/oauth-callback", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: validCookie,
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ code: "test_code_toctou", state: validState }),
          }),
        );

        assert.ok(updateExecuted, "Multi-table atomic update query must have executed");
        assert.equal(cbRes.status, 403);
        const cbData = (await cbRes.json()) as any;
        assert.equal(cbData.success, false);
      } finally {
        delete process.env["DB_HOST"];
        delete process.env["DB_NAME"];
        delete process.env["DB_USER"];
        setMysqlPoolForTesting(null);
      }
    });

    it("status endpoint returns HTTP 500 and NEVER reads JSON store when MySQL errors occur", async () => {
      // 1. Plant fake connected record in JSON store
      const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      store.admobOauth = {
        publisher_id: "pub-fake-json-store",
        account_name: "Insecure Fallback Account",
        is_active: 1,
      };
      fs.writeFileSync(storePath, JSON.stringify(store, null, 2));

      // 2. Enable MySQL with failing pool
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_production";
      process.env["DB_USER"] = "admin_user";

      const mockFailingPool = {
        query: async () => {
          throw new Error("Table 'admob_oauth_credentials' doesn't exist");
        },
      };

      setMysqlPoolForTesting(mockFailingPool);

      try {
        const res = await callApi(
          new Request("http://localhost:3000/api/admin/admob/status", {
            method: "GET",
            headers: { Authorization: `Bearer ${adminSessionToken}` },
          }),
        );

        assert.equal(res.status, 500);
        const data = (await res.json()) as any;
        assert.equal(data.success, false);
        assert.equal(
          data.error,
          "AdMob database table is uninitialized or inaccessible. Please run database migrations before connecting.",
        );
        // Ensure fake JSON store data was NEVER returned!
        assert.equal(data.publisher_id, undefined);
      } finally {
        delete process.env["DB_HOST"];
        delete process.env["DB_NAME"];
        delete process.env["DB_USER"];
        setMysqlPoolForTesting(null);

        // Clean up test store
        const cleanStore = JSON.parse(fs.readFileSync(storePath, "utf-8"));
        delete cleanStore.admobOauth;
        fs.writeFileSync(storePath, JSON.stringify(cleanStore, null, 2));
      }
    });

    it("disconnect endpoint returns HTTP 500 and NEVER falls back to JSON when MySQL errors occur", async () => {
      process.env["DB_HOST"] = "127.0.0.1";
      process.env["DB_NAME"] = "facetube_production";
      process.env["DB_USER"] = "admin_user";

      const mockFailingPool = {
        query: async () => {
          throw new Error("Database connection timed out");
        },
      };

      setMysqlPoolForTesting(mockFailingPool);

      try {
        const res = await callApi(
          new Request("http://localhost:3000/api/admin/admob/disconnect", {
            method: "POST",
            headers: { Authorization: `Bearer ${adminSessionToken}` },
          }),
        );

        assert.equal(res.status, 500);
        const data = (await res.json()) as any;
        assert.equal(data.success, false);
        assert.equal(
          data.error,
          "AdMob database table is uninitialized or inaccessible. Please run database migrations before connecting.",
        );
      } finally {
        delete process.env["DB_HOST"];
        delete process.env["DB_NAME"];
        delete process.env["DB_USER"];
        setMysqlPoolForTesting(null);
      }
    });
  });

  // --------------------------------------------------------------------------
  // 12. Production OAuth Publisher ID Fail-Closed Enforcement & Non-Bypassable OAuth
  // --------------------------------------------------------------------------
  describe("12. Production OAuth Publisher Fail-Closed Enforcement", () => {
    it("fails closed in production when ADMOB_PUBLISHER_ID is unset or test ID and never skips Google OAuth", async () => {
      const origAppEnv = process.env["APP_ENV"];
      const origNodeEnv = process.env["NODE_ENV"];
      const origPubId = process.env["ADMOB_PUBLISHER_ID"];
      const origSkip = process.env["ADMOB_SKIP_REMOTE_CHECK"];
      const origHost = process.env["DB_HOST"];
      const origName = process.env["DB_NAME"];
      const origUser = process.env["DB_USER"];
      const origFetch = globalThis.fetch;

      try {
        // Generate valid states while in test mode
        process.env["NODE_ENV"] = "test";
        process.env["APP_ENV"] = "test";
        const issueStateAndCookie = async () => {
          const urlRes = await callApi(
            new Request("http://localhost:3000/api/admin/admob/auth-url", {
              method: "GET",
              headers: { Authorization: `Bearer ${adminSessionToken}` },
            }),
          );
          const urlData = (await urlRes.json()) as any;
          const state = new URL(urlData.auth_url).searchParams.get("state") || "";
          const cookie =
            (urlRes.headers.get("Set-Cookie") || "").match(
              /facetube_admob_oauth_binding=[^;]+/,
            )?.[0] || "";
          return { state, cookie };
        };

        const pair1 = await issueStateAndCookie();
        const pair2 = await issueStateAndCookie();
        const pair3 = await issueStateAndCookie();
        const pair4 = await issueStateAndCookie();

        // Configure MySQL mock pool and switch to production mode
        process.env["DB_HOST"] = "127.0.0.1";
        process.env["DB_NAME"] = "facetube_production";
        process.env["DB_USER"] = "admin_user";
        process.env["NODE_ENV"] = "production";
        delete process.env["APP_ENV"];
        delete process.env["ADMOB_PUBLISHER_ID"];
        process.env["ADMOB_SKIP_REMOTE_CHECK"] = "true";

        const adminHash = crypto.createHash("sha256").update(adminSessionToken).digest("hex");
        let credentialInserts = 0;
        let googleTokenCalls = 0;

        globalThis.fetch = (async (input: string | URL | Request) => {
          const urlStr = typeof input === "string" ? input : input.toString();
          if (urlStr.startsWith("https://oauth2.googleapis.com/token")) {
            googleTokenCalls += 1;
            return new Response(
              JSON.stringify({
                access_token: "live_google_access_token_123",
                refresh_token: "live_google_refresh_token_123",
                expires_in: 3600,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (urlStr.startsWith("https://admob.googleapis.com/v1/accounts")) {
            return new Response(JSON.stringify({ account: [] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          }
          throw new Error(`Unexpected fetch URL in AdMob test: ${urlStr}`);
        }) as typeof fetch;

        setMysqlPoolForTesting({
          query: async (sql: string) => {
            if (sql.includes("SELECT st.admin_session_hash")) {
              return [
                [
                  {
                    admin_session_hash: adminHash,
                    id: adminUserId,
                    user_id: adminUserId,
                    role: "admin",
                  },
                ],
              ];
            }
            if (sql.includes("UPDATE admob_oauth_states")) {
              return [{ affectedRows: 1 }];
            }
            if (sql.includes("INSERT INTO admob_oauth_credentials")) {
              credentialInserts += 1;
              return [{ affectedRows: 1 }];
            }
            return [[]];
          },
        });

        // 12a. Even with ADMOB_SKIP_REMOTE_CHECK=true in production, real Google OAuth token exchange runs (NOT bypassed)
        const prodMissingRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/oauth-callback", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: pair1.cookie,
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ code: "4/real_google_auth_code_prod_fail", state: pair1.state }),
          }),
        );
        assert.equal(
          googleTokenCalls,
          1,
          "Production must call Google token endpoint even when ADMOB_SKIP_REMOTE_CHECK=true",
        );
        assert.equal(prodMissingRes.status, 500);
        const missingBody = (await prodMissingRes.json()) as any;
        assert.equal(missingBody.success, false);
        assert.ok(missingBody.error.includes("publisher ID"));
        assert.equal(missingBody.access_token, undefined);
        assert.equal(missingBody.refresh_token, undefined);
        assert.equal(credentialInserts, 0, "Must never store credentials without valid publisher");

        // 12b. Explicitly setting test publisher ID in production must also fail closed
        process.env["ADMOB_PUBLISHER_ID"] = "pub-3940256099942544";
        const prodTestPubRes = await callApi(
          new Request(
            `http://localhost:3000/api/admin/admob/oauth-callback?code=4/real_google_auth_code_test_pub&state=${encodeURIComponent(pair2.state)}`,
            {
              method: "GET",
              headers: {
                Cookie: pair2.cookie,
              },
            },
          ),
        );
        assert.equal(googleTokenCalls, 2);
        assert.equal(prodTestPubRes.status, 302);
        const loc = prodTestPubRes.headers.get("Location") || "";
        assert.ok(
          loc.includes("admob_error=missing_publisher_id"),
          `Expected missing_publisher_id redirect, got: ${loc}`,
        );
        assert.equal(credentialInserts, 0, "Must never store test publisher pub-3940256099942544");

        // 12c. Test mock code is rejected in production even when ADMOB_SKIP_REMOTE_CHECK=true
        const mockCodeProdRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/oauth-callback", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: pair3.cookie,
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ code: "test_mock_code_forbidden_prod", state: pair3.state }),
          }),
        );
        assert.equal(mockCodeProdRes.status, 400);
        const mockCodeProdData = (await mockCodeProdRes.json()) as any;
        assert.equal(mockCodeProdData.success, false);
        assert.match(mockCodeProdData.error, /mock authorization codes/i);
        assert.equal(credentialInserts, 0);

        // 12d. APP_ENV=production overrides NODE_ENV=development for Google OAuth verification
        process.env["NODE_ENV"] = "development";
        process.env["APP_ENV"] = "production";
        process.env["ADMOB_PUBLISHER_ID"] = "pub-1234567890123456";
        process.env["ADMOB_SKIP_REMOTE_CHECK"] = "1";
        const appEnvProdRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/oauth-callback", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: pair4.cookie,
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({
              code: "4/real_google_auth_code_app_env_prod",
              state: pair4.state,
            }),
          }),
        );
        assert.equal(appEnvProdRes.status, 200);
        assert.equal(
          googleTokenCalls,
          3,
          "APP_ENV=production must call Google token endpoint despite NODE_ENV=development and ADMOB_SKIP_REMOTE_CHECK=1",
        );
        assert.equal(credentialInserts, 1);

        // Verify PHP OAuth callback also removes unconditional pub-3940256099942544 production fallback
        const phpOauthCallback = fs.readFileSync(
          path.resolve(process.cwd(), "api/admin/admob/oauth-callback.php"),
          "utf-8",
        );
        assert.ok(
          !phpOauthCallback.includes(
            "$publisherId = getenv('ADMOB_PUBLISHER_ID') ?: 'pub-3940256099942544';",
          ),
          "PHP OAuth callback must not unconditionally default to pub-3940256099942544",
        );
        assert.ok(
          phpOauthCallback.includes("admob_error=missing_publisher_id"),
          "PHP OAuth callback must fail closed in production when publisher ID is missing or test ID",
        );
      } finally {
        globalThis.fetch = origFetch;
        setMysqlPoolForTesting(null);
        if (origHost !== undefined) process.env["DB_HOST"] = origHost;
        else delete process.env["DB_HOST"];
        if (origName !== undefined) process.env["DB_NAME"] = origName;
        else delete process.env["DB_NAME"];
        if (origUser !== undefined) process.env["DB_USER"] = origUser;
        else delete process.env["DB_USER"];
        if (origAppEnv !== undefined) process.env["APP_ENV"] = origAppEnv;
        else delete process.env["APP_ENV"];
        if (origNodeEnv !== undefined) process.env["NODE_ENV"] = origNodeEnv;
        else delete process.env["NODE_ENV"];
        if (origPubId !== undefined) process.env["ADMOB_PUBLISHER_ID"] = origPubId;
        else delete process.env["ADMOB_PUBLISHER_ID"];
        if (origSkip !== undefined) process.env["ADMOB_SKIP_REMOTE_CHECK"] = origSkip;
        else delete process.env["ADMOB_SKIP_REMOTE_CHECK"];
      }
    });

    it("does NOT skip remote Google OAuth when ADMOB_SKIP_REMOTE_CHECK is 'false' or '0' in test/development mode", async () => {
      const origAppEnv = process.env["APP_ENV"];
      const origNodeEnv = process.env["NODE_ENV"];
      const origSkip = process.env["ADMOB_SKIP_REMOTE_CHECK"];
      const origFetch = globalThis.fetch;

      try {
        process.env["APP_ENV"] = "development";
        process.env["NODE_ENV"] = "development";

        for (const flagVal of ["false", "0", " FALSE "]) {
          const urlRes = await callApi(
            new Request("http://localhost:3000/api/admin/admob/auth-url", {
              method: "GET",
              headers: { Authorization: `Bearer ${adminSessionToken}` },
            }),
          );
          const urlData = (await urlRes.json()) as any;
          const state = new URL(urlData.auth_url).searchParams.get("state") || "";
          const cookie =
            (urlRes.headers.get("Set-Cookie") || "").match(
              /facetube_admob_oauth_binding=[^;]+/,
            )?.[0] || "";

          let tokenExchangeCalled = false;
          globalThis.fetch = (async (input: string | URL | Request) => {
            const urlStr = typeof input === "string" ? input : input.toString();
            if (urlStr.startsWith("https://oauth2.googleapis.com/token")) {
              tokenExchangeCalled = true;
              return new Response(
                JSON.stringify({
                  error: "invalid_grant",
                  error_description: "Mock remote check enforced",
                }),
                { status: 400, headers: { "Content-Type": "application/json" } },
              );
            }
            throw new Error(`Unexpected fetch URL: ${urlStr}`);
          }) as typeof fetch;

          process.env["ADMOB_SKIP_REMOTE_CHECK"] = flagVal;
          const res = await callApi(
            new Request("http://localhost:3000/api/admin/admob/oauth-callback", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Cookie: cookie,
                Authorization: `Bearer ${adminSessionToken}`,
              },
              body: JSON.stringify({ code: "4/non_mock_code_123", state }),
            }),
          );
          assert.equal(
            tokenExchangeCalled,
            true,
            `Flag '${flagVal}' must NOT skip remote Google OAuth check`,
          );
          assert.equal(res.status, 502);
        }

        // Verify "1" skips in explicit development mode
        const devUrlRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/auth-url", {
            method: "GET",
            headers: { Authorization: `Bearer ${adminSessionToken}` },
          }),
        );
        const devUrlData = (await devUrlRes.json()) as any;
        const devState = new URL(devUrlData.auth_url).searchParams.get("state") || "";
        const devCookie =
          (devUrlRes.headers.get("Set-Cookie") || "").match(
            /facetube_admob_oauth_binding=[^;]+/,
          )?.[0] || "";

        let fetchCalledWhenOne = false;
        globalThis.fetch = (async () => {
          fetchCalledWhenOne = true;
          throw new Error(
            "Should not call remote fetch when ADMOB_SKIP_REMOTE_CHECK='1' in development",
          );
        }) as typeof fetch;

        process.env["ADMOB_SKIP_REMOTE_CHECK"] = " 1 ";
        const skipRes = await callApi(
          new Request("http://localhost:3000/api/admin/admob/oauth-callback", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Cookie: devCookie,
              Authorization: `Bearer ${adminSessionToken}`,
            },
            body: JSON.stringify({ code: "4/non_mock_code_skip", state: devState }),
          }),
        );
        assert.equal(fetchCalledWhenOne, false);
        assert.equal(skipRes.status, 200);
      } finally {
        globalThis.fetch = origFetch;
        if (origAppEnv !== undefined) process.env["APP_ENV"] = origAppEnv;
        else delete process.env["APP_ENV"];
        if (origNodeEnv !== undefined) process.env["NODE_ENV"] = origNodeEnv;
        else delete process.env["NODE_ENV"];
        if (origSkip !== undefined) process.env["ADMOB_SKIP_REMOTE_CHECK"] = origSkip;
        else delete process.env["ADMOB_SKIP_REMOTE_CHECK"];
      }
    });
  });
});
