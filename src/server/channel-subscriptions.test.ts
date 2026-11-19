import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApiRequest, resetInMemoryStore } from "./api-handler";
import { setTestPersistentDataDir } from "./payments";
import { getMysqlPool } from "./mysql";

describe("FaceTube Phase 3: Creator Channel Subscriptions Tests", () => {
  let testDataDir = "";
  let storePath = "";
  let adminToken = "";
  let userTokenAlex = "";
  let userTokenMaya = "";

  const alexUserId = "FT483921";
  const mayaUserId = "FT900431";
  const adminUserId = "FT102857";

  before(async () => {
    testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-channel-subs-test-"));
    storePath = path.join(testDataDir, "facetube_store.json");
    setTestPersistentDataDir(testDataDir);
    resetInMemoryStore();

    // 1. Authenticate as Admin (admin@facetube.com / FT102857)
    const adminLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "admin@facetube.com", password: "password" }),
      }),
    );
    assert.ok(adminLoginRes);
    const adminData = await adminLoginRes.json();
    assert.ok(adminData.token, "Admin login must provide token");
    adminToken = adminData.token;

    // 2. Authenticate as Standard User Alex Rivera (alex@facetube.com / FT483921)
    const alexLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
      }),
    );
    assert.ok(alexLoginRes);
    const alexData = await alexLoginRes.json();
    assert.ok(alexData.token, "Alex login must provide token");
    userTokenAlex = alexData.token;

    // 3. Authenticate as Standard User Maya Lin (maya@facetube.com / FT900431)
    const mayaLoginRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "maya@facetube.com", password: "password123" }),
      }),
    );
    assert.ok(mayaLoginRes);
    const mayaData = await mayaLoginRes.json();
    assert.ok(mayaData.token, "Maya login must provide token");
    userTokenMaya = mayaData.token;
  });

  beforeEach(async () => {
    // Reset subscriptions in isolated test store
    if (storePath && fs.existsSync(storePath)) {
      try {
        const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
        store.channelSubscriptions = [];
        fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
      } catch (_e) {
        // Ignore file read/parse errors
      }
    }

    // Reset subscriptions in MySQL database if configured
    const pool = getMysqlPool();
    if (pool) {
      try {
        await pool.query("DELETE FROM channel_subscriptions");
      } catch (_e) {
        // Table may not exist yet in local testing environment
      }
    }
  });

  after(() => {
    setTestPersistentDataDir(null);
    resetInMemoryStore();
    if (testDataDir) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // 1. Unauthenticated Requests (HTTP 401)
  // ---------------------------------------------------------------------------
  describe("1. Unauthenticated 401 Rejections", () => {
    it("rejects unauthenticated subscribe request with HTTP 401", async () => {
      const req = new Request("http://localhost:3000/api/channel/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creator_user_id: alexUserId }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /authentication required/i);
    });

    it("rejects unauthenticated unsubscribe request with HTTP 401", async () => {
      const req = new Request("http://localhost:3000/api/channel/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creator_user_id: alexUserId }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /authentication required/i);
    });

    it("rejects unauthenticated creator subscriber count query with HTTP 401", async () => {
      const req = new Request("http://localhost:3000/api/channel/subscribers", {
        method: "GET",
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /authentication required/i);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Public Status & Zero Count Baseline
  // ---------------------------------------------------------------------------
  describe("2. Public Channel Status & Zero Count Baseline", () => {
    it("returns HTTP 200 with zero subscriber count for a channel with no subscribers", async () => {
      const req = new Request(
        `http://localhost:3000/api/channel/status?creator_user_id=${alexUserId}`,
        { method: "GET" },
      );
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.authenticated, false);
      assert.equal(data.subscribed, false);
      assert.equal(data.subscriber_count, 0);
      assert.equal(data.is_self, false);
    });

    it("rejects status check when creator_user_id parameter is missing with HTTP 400", async () => {
      const req = new Request("http://localhost:3000/api/channel/status", {
        method: "GET",
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /creator user id is required/i);
    });

    it("detects is_self: true when creator checks their own channel status", async () => {
      const req = new Request(
        `http://localhost:3000/api/channel/status?creator_user_id=${alexUserId}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${userTokenAlex}` },
        },
      );
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.authenticated, true);
      assert.equal(data.is_self, true);
      assert.equal(data.subscribed, false);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Self-Subscription Prevention (HTTP 400)
  // ---------------------------------------------------------------------------
  describe("3. Self-Subscription Prevention", () => {
    it("rejects a creator subscribing to their own channel with HTTP 400", async () => {
      const req = new Request("http://localhost:3000/api/channel/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userTokenAlex}`,
        },
        body: JSON.stringify({ creator_user_id: alexUserId }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /cannot subscribe to your own channel/i);
    });

    it("rejects self-subscription case-insensitively", async () => {
      const req = new Request("http://localhost:3000/api/channel/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userTokenAlex}`,
        },
        body: JSON.stringify({ creator_user_id: alexUserId.toLowerCase() }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /cannot subscribe to your own channel/i);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Successful Subscription & Duplicate Prevention (Idempotency)
  // ---------------------------------------------------------------------------
  describe("4. Subscription Flow & Duplicate Prevention", () => {
    it("allows Maya to subscribe to Alex's channel with HTTP 200 and count = 1", async () => {
      const req = new Request("http://localhost:3000/api/channel/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userTokenMaya}`,
        },
        body: JSON.stringify({ creator_user_id: alexUserId }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.subscribed, true);
      assert.equal(data.subscriber_count, 1);

      // Verify status endpoint reflects subscription
      const statusReq = new Request(
        `http://localhost:3000/api/channel/status?creator_user_id=${alexUserId}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${userTokenMaya}` },
        },
      );
      const statusRes = await handleApiRequest(statusReq);
      assert.ok(statusRes);
      const statusData = await statusRes.json();
      assert.equal(statusData.subscribed, true);
      assert.equal(statusData.is_self, false);
      assert.equal(statusData.subscriber_count, 1);
    });

    it("prevents duplicate subscriptions and does not inflate subscriber count", async () => {
      // First subscription
      const req1 = new Request("http://localhost:3000/api/channel/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userTokenMaya}`,
        },
        body: JSON.stringify({ creator_user_id: alexUserId }),
      });
      const res1 = await handleApiRequest(req1);
      assert.ok(res1);
      const data1 = await res1.json();
      assert.equal(data1.subscriber_count, 1);

      // Duplicate subscription by same user
      const req2 = new Request("http://localhost:3000/api/channel/subscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userTokenMaya}`,
        },
        body: JSON.stringify({ creator_user_id: alexUserId }),
      });
      const res2 = await handleApiRequest(req2);
      assert.ok(res2);
      assert.equal(res2.status, 200);
      const data2 = await res2.json();
      assert.equal(data2.success, true);
      assert.equal(data2.subscribed, true);
      assert.equal(data2.subscriber_count, 1, "Duplicate subscription must not increment count");
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Creator Isolation on /api/channel/subscribers (HTTP 403 vs HTTP 200)
  // ---------------------------------------------------------------------------
  describe("5. Creator Isolation Enforcement", () => {
    it("allows a creator to inspect their own subscriber count", async () => {
      // Maya subscribes to Alex
      await handleApiRequest(
        new Request("http://localhost:3000/api/channel/subscribe", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userTokenMaya}`,
          },
          body: JSON.stringify({ creator_user_id: alexUserId }),
        }),
      );

      // Alex queries their own count
      const req = new Request("http://localhost:3000/api/channel/subscribers", {
        method: "GET",
        headers: { Authorization: `Bearer ${userTokenAlex}` },
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.creator_user_id, alexUserId);
      assert.equal(data.subscriber_count, 1);
    });

    it("rejects non-admin user querying another creator's subscriber count with HTTP 403", async () => {
      // Maya attempts to query Alex's subscriber count via /api/channel/subscribers
      const req = new Request(
        `http://localhost:3000/api/channel/subscribers?creator_user_id=${alexUserId}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${userTokenMaya}` },
        },
      );
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /forbidden.*only view your own creator subscriber count/i);
    });

    it("allows an admin user to inspect any creator's subscriber count with HTTP 200", async () => {
      // Admin queries Alex's subscriber count
      const req = new Request(
        `http://localhost:3000/api/channel/subscribers?creator_user_id=${alexUserId}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.creator_user_id, alexUserId);
      assert.equal(typeof data.subscriber_count, "number");
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Unsubscribe Flow & State Synchronization
  // ---------------------------------------------------------------------------
  describe("6. Unsubscribe Flow & State Synchronization", () => {
    it("allows Maya to unsubscribe from Alex with count decrementing to 0", async () => {
      // 1. Subscribe
      await handleApiRequest(
        new Request("http://localhost:3000/api/channel/subscribe", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${userTokenMaya}`,
          },
          body: JSON.stringify({ creator_user_id: alexUserId }),
        }),
      );

      // 2. Unsubscribe
      const unsubReq = new Request("http://localhost:3000/api/channel/unsubscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userTokenMaya}`,
        },
        body: JSON.stringify({ creator_user_id: alexUserId }),
      });
      const unsubRes = await handleApiRequest(unsubReq);
      assert.ok(unsubRes);
      assert.equal(unsubRes.status, 200);
      const unsubData = await unsubRes.json();
      assert.equal(unsubData.success, true);
      assert.equal(unsubData.subscribed, false);
      assert.equal(unsubData.subscriber_count, 0);

      // 3. Status check confirms unsubscribed state
      const statusReq = new Request(
        `http://localhost:3000/api/channel/status?creator_user_id=${alexUserId}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${userTokenMaya}` },
        },
      );
      const statusRes = await handleApiRequest(statusReq);
      assert.ok(statusRes);
      const statusData = await statusRes.json();
      assert.equal(statusData.subscribed, false);
      assert.equal(statusData.subscriber_count, 0);

      // 4. Alex's creator subscriber count is 0
      const alexCountRes = await handleApiRequest(
        new Request("http://localhost:3000/api/channel/subscribers", {
          method: "GET",
          headers: { Authorization: `Bearer ${userTokenAlex}` },
        }),
      );
      assert.ok(alexCountRes);
      const alexCountData = await alexCountRes.json();
      assert.equal(alexCountData.subscriber_count, 0);
    });

    it("handles unsubscribing when not subscribed gracefully without error", async () => {
      const unsubReq = new Request("http://localhost:3000/api/channel/unsubscribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userTokenMaya}`,
        },
        body: JSON.stringify({ creator_user_id: alexUserId }),
      });
      const unsubRes = await handleApiRequest(unsubReq);
      assert.ok(unsubRes);
      assert.equal(unsubRes.status, 200);
      const unsubData = await unsubRes.json();
      assert.equal(unsubData.success, true);
      assert.equal(unsubData.subscribed, false);
      assert.equal(unsubData.subscriber_count, 0);
    });
  });
});
