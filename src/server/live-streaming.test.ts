import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  handleApiRequest,
  generateLiveKitAccessToken,
  verifyLiveKitWebhook,
  base64UrlDecode,
  resetInMemoryStore,
} from "./api-handler.ts";

describe("LiveKit WebRTC Live Streaming Backend Foundation Tests (Stage 1)", () => {
  let adminToken = "";
  let creatorToken = "";
  let viewerToken = "";
  let testStreamId = "";
  let storeBackup = "";
  const storePath = path.resolve(process.cwd(), "data/facetube_store.json");
  const testApiSecret = "test-livekit-secret-key-12345";
  const originalSecret = process.env["LIVEKIT_API_SECRET"];

  before(async () => {
    process.env["LIVEKIT_API_SECRET"] = testApiSecret;

    if (fs.existsSync(storePath)) {
      storeBackup = fs.readFileSync(storePath, "utf-8");
    }
    resetInMemoryStore();

    // 1. Authenticate Admin (FT102857)
    const adminRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "admin@facetube.com", password: "password123" }),
      }),
    );
    assert.ok(adminRes);
    const adminData = await adminRes.json();
    adminToken = adminData.token;

    // 2. Authenticate Creator (Alex - FT483921)
    const creatorRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
      }),
    );
    assert.ok(creatorRes);
    const creatorData = await creatorRes.json();
    creatorToken = creatorData.token;

    // 3. Authenticate Viewer (Maya - FT900431)
    const viewerRes = await handleApiRequest(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: "maya@facetube.com", password: "password123" }),
      }),
    );
    assert.ok(viewerRes);
    const viewerData = await viewerRes.json();
    assert.ok(viewerData.token, "Maya login must succeed and return token");
    viewerToken = viewerData.token;

    // 4. Create a test stream owned by Creator (Alex - FT483921)
    const createStreamRes = await handleApiRequest(
      new Request("http://localhost:3000/api/live/streams", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${creatorToken}`,
        },
        body: JSON.stringify({
          title: "Alex's Live Dev Stream",
          description: "Building LiveKit integration live",
          category: "Coding & Tech",
        }),
      }),
    );
    assert.ok(createStreamRes);
    const createStreamData = await createStreamRes.json();
    assert.equal(createStreamRes.status, 201);
    assert.ok(createStreamData.stream);
    assert.ok(createStreamData.stream.id);
    assert.ok(createStreamData.stream.livekit_room_name);
    testStreamId = createStreamData.stream.id;
  });

  after(() => {
    if (originalSecret !== undefined) {
      process.env["LIVEKIT_API_SECRET"] = originalSecret;
    } else {
      delete process.env["LIVEKIT_API_SECRET"];
    }

    if (storeBackup && fs.existsSync(storePath)) {
      fs.writeFileSync(storePath, storeBackup, "utf-8");
    }
  });

  describe("1. LiveKit Token Generation & Permission Isolation", () => {
    it("mints an authoritative publisher token for the stream creator with publishing permissions", async () => {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({
            streamId: testStreamId,
            role: "publisher",
          }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.role, "publisher");
      assert.equal(data.identity, "FT483921");
      assert.ok(data.token);
      assert.ok(data.room.startsWith("room_"));

      // Decode token payload
      const parts = data.token.split(".");
      assert.equal(parts.length, 3);
      const payload = JSON.parse(base64UrlDecode(parts[1]).toString("utf8"));
      assert.equal(payload.sub, "FT483921");
      assert.equal(payload.video.room, data.room);
      assert.equal(payload.video.roomJoin, true);
      assert.equal(payload.video.canPublish, true);
      assert.equal(payload.video.canSubscribe, true);
      assert.deepEqual(payload.video.canPublishSources, ["camera", "microphone", "screen_share"]);
      assert.ok(payload.exp > payload.iat);
    });

    it("mints a subscriber token for a regular viewer with publish disabled", async () => {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${viewerToken}`,
          },
          body: JSON.stringify({
            streamId: testStreamId,
            role: "subscriber",
          }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.role, "subscriber");
      assert.equal(data.identity, "FT900431");

      // Verify claims: subscriber cannot publish
      const parts = data.token.split(".");
      const payload = JSON.parse(base64UrlDecode(parts[1]).toString("utf8"));
      assert.equal(payload.video.canPublish, false);
      assert.equal(payload.video.canSubscribe, true);
      assert.equal(payload.video.canPublishSources, undefined);
    });

    it("strictly rejects non-owner viewer requesting a publisher token with 403 Forbidden", async () => {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${viewerToken}`,
          },
          body: JSON.stringify({
            streamId: testStreamId,
            role: "publisher", // Non-owner attempting to hijack broadcaster role
          }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /Only the stream creator can publish/);
    });

    it("rejects unauthenticated token request with 401 Unauthorized", async () => {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ streamId: testStreamId }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 401);
    });

    it("returns 404 if stream does not exist", async () => {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${viewerToken}`,
          },
          body: JSON.stringify({ streamId: "live_non_existent_9999" }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 404);
    });

    it("returns all required Stage 2 frontend contract fields in token payload", async () => {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({
            streamId: testStreamId,
            role: "publisher",
          }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(typeof data.token, "string");
      assert.equal(typeof data.url, "string");
      assert.equal(typeof data.room, "string");
      assert.equal(typeof data.identity, "string");
      assert.equal(typeof data.role, "string");
      assert.equal(typeof data.expires_at, "number");
      assert.equal(typeof data.server_configured, "boolean");
    });
  });

  describe("2. Authenticated Heartbeat & Ownership Validation", () => {
    it("allows the stream owner to send broadcaster heartbeats", async () => {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/heartbeat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({
            streamId: testStreamId,
            role: "broadcaster",
            stats: { bitrate: 2500, fps: 30 },
          }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.role, "broadcaster");
    });

    it("rejects non-owner trying to send a broadcaster heartbeat with 403 Forbidden", async () => {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/heartbeat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${viewerToken}`,
          },
          body: JSON.stringify({
            streamId: testStreamId,
            role: "broadcaster",
          }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /Only the broadcaster can send broadcaster heartbeats/);
    });

    it("allows authenticated viewers to register presence heartbeats", async () => {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/heartbeat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${viewerToken}`,
          },
          body: JSON.stringify({
            streamId: testStreamId,
            role: "viewer",
          }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.role, "viewer");
    });
  });

  describe("3. End-Stream Ownership & History Preservation", () => {
    it("rejects unauthorized viewer attempting to terminate a stream with 403 Forbidden", async () => {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/end-stream", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${viewerToken}`,
          },
          body: JSON.stringify({ streamId: testStreamId }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 403);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /Only the stream owner or an administrator can end this stream/);
    });

    it("allows the stream creator to successfully end their stream", async () => {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/end-stream", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ streamId: testStreamId }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.stream.status, "ended");
      assert.equal(data.stream.viewers_count, 0);
      assert.ok(data.stream.ended_at);
    });

    it("handles repeated end-stream requests idempotently", async () => {
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/end-stream", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ streamId: testStreamId }),
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.match(data.message, /already ended/);
      assert.equal(data.stream.status, "ended");
    });
  });

  describe("4. Official LiveKit Webhook Signature Verification & Ingestion", () => {
    // Helper to generate a valid LiveKit webhook token matching official specs
    function createValidLiveKitWebhookToken(rawBody: string, secret: string) {
      const header = { alg: "HS256", typ: "JWT" };
      const bodyHash = crypto.createHash("sha256").update(rawBody).digest("base64");
      const payload = {
        iss: "test-api-key",
        sha256: bodyHash,
        iat: Math.floor(Date.now() / 1000),
      };

      const b64Url = (obj: any) =>
        Buffer.from(JSON.stringify(obj))
          .toString("base64")
          .replace(/=/g, "")
          .replace(/\+/g, "-")
          .replace(/\//g, "_");

      const headerB64 = b64Url(header);
      const payloadB64 = b64Url(payload);
      const sigInput = `${headerB64}.${payloadB64}`;
      const sig = crypto
        .createHmac("sha256", secret)
        .update(sigInput)
        .digest("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");

      return `${sigInput}.${sig}`;
    }

    it("accepts a cryptographically valid LiveKit webhook request", async () => {
      const webhookPayload = JSON.stringify({
        id: "EV_TEST_JOIN_001",
        event: "participant_joined",
        createdAt: Math.floor(Date.now() / 1000),
        room: {
          name: `room_${testStreamId}`,
          numParticipants: 5,
        },
        participant: {
          identity: "FT729104",
          name: "Priya",
        },
      });

      const validToken = createValidLiveKitWebhookToken(webhookPayload, testApiSecret);

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${validToken}`,
          },
          body: webhookPayload,
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.event, "participant_joined");
      assert.equal(data.processed, true);
    });

    it("rejects webhook request with an invalid/tampered signature with 401 Unauthorized", async () => {
      const webhookPayload = JSON.stringify({
        id: "EV_TEST_JOIN_002",
        event: "participant_joined",
      });

      // Sign with wrong secret
      const invalidToken = createValidLiveKitWebhookToken(webhookPayload, "wrong-fake-secret");

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${invalidToken}`,
          },
          body: webhookPayload,
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /signature verification failed/);
    });

    it("rejects webhook request when raw body does not match sha256 claim with 401 Unauthorized", async () => {
      const originalPayload = JSON.stringify({
        id: "EV_TEST_JOIN_003",
        event: "participant_joined",
      });
      const validToken = createValidLiveKitWebhookToken(originalPayload, testApiSecret);

      // Tamper the body after generating the token
      const tamperedPayload = JSON.stringify({
        id: "EV_TEST_JOIN_003",
        event: "participant_joined",
        tampered_field: "injected",
      });

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${validToken}`,
          },
          body: tamperedPayload,
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /hash mismatch/);
    });

    it("rejects webhook request with missing Authorization header with 401 Unauthorized", async () => {
      const payload = JSON.stringify({ id: "EV_NO_AUTH", event: "participant_joined" });
      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
        }),
      );
      assert.ok(res);
      assert.equal(res.status, 401);
    });

    it("processes duplicate webhook events idempotently without double processing", async () => {
      const duplicatePayload = JSON.stringify({
        id: "EV_TEST_DUPLICATE_999",
        event: "participant_joined",
        room: { name: `room_${testStreamId}`, numParticipants: 8 },
      });
      const token = createValidLiveKitWebhookToken(duplicatePayload, testApiSecret);

      // First delivery
      const res1 = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: duplicatePayload,
        }),
      );
      assert.ok(res1);
      assert.equal(res1.status, 200);

      // Second delivery (duplicate retry)
      const res2 = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: duplicatePayload,
        }),
      );
      assert.ok(res2);
      assert.equal(res2.status, 200);
      const data2 = await res2.json();
      assert.equal(data2.success, true);
      assert.equal(data2.idempotent, true);
      assert.equal(data2.duplicate, true);
    });
  });

  describe("5. Production Isolation & Fail-Closed Guard", () => {
    it("fails closed with 503 when NODE_ENV is production and database connection is unavailable", async () => {
      const origEnv = process.env["NODE_ENV"];
      process.env["NODE_ENV"] = "production";

      try {
        const res = await handleApiRequest(
          new Request("http://localhost:3000/api/live/token", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${creatorToken}`,
            },
            body: JSON.stringify({ streamId: testStreamId }),
          }),
        );
        assert.ok(res);
        assert.equal(res.status, 503);
        const data = await res.json();
        assert.equal(data.success, false);
        assert.match(data.error, /Database connection unavailable in production environment/);
      } finally {
        process.env["NODE_ENV"] = origEnv;
      }
    });

    it("fails closed with 500 on /api/live/token and /api/live/webhook in production when LiveKit credentials are missing", async () => {
      const prodMissingLkEnv = {
        APP_ENV: "production",
        NODE_ENV: "development",
        LIVEKIT_API_KEY: "",
        LIVEKIT_API_SECRET: "",
      };

      const mockStreamPool = {
        query: async (sql: string) => {
          if (sql.includes("FROM sessions")) {
            return [
              [
                {
                  id: "u-1",
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
          if (sql.includes("FROM live_streams")) {
            return [
              [
                {
                  id: testStreamId,
                  user_id: "FT483921",
                  livekit_room_name: `room_${testStreamId}`,
                  status: "live",
                },
              ],
            ];
          }
          return [[]];
        },
      } as any;

      const tokenRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${creatorToken}`,
          },
          body: JSON.stringify({ streamId: testStreamId, role: "publisher" }),
        }),
        prodMissingLkEnv,
        { pool: mockStreamPool },
      );
      assert.ok(tokenRes);
      assert.equal(tokenRes.status, 500);
      const tokenData = await tokenRes.json();
      assert.equal(tokenData.success, false);
      assert.equal(tokenData.token, undefined);
      assert.match(tokenData.error, /LIVEKIT_API_KEY|LIVEKIT_API_SECRET/i);

      const webhookRes = await handleApiRequest(
        new Request("http://localhost:3000/api/live/webhook", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer dummy",
          },
          body: JSON.stringify({ id: "EV_PROD_MISSING_SECRET", event: "participant_joined" }),
        }),
        prodMissingLkEnv,
        { pool: mockStreamPool },
      );
      assert.ok(webhookRes);
      assert.equal(webhookRes.status, 500);
      const webhookData = await webhookRes.json();
      assert.equal(webhookData.success, false);
      assert.match(webhookData.error, /LIVEKIT_API_SECRET/i);
    });
  });
});
