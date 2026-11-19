import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApiRequest, resetInMemoryStore, resetStoreForTests } from "./api-handler.ts";
import { serveUploadFile } from "./uploads-handler.ts";
import { setTestPersistentDataDir, resetPersistentPremiumState } from "./payments.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";
import {
  normalizeVideoVisibility,
  validateVisibilityRules,
  signPrivateMediaUrl,
  verifyPrivateMediaSignature,
} from "./private-media.ts";

let testDataDir = "";
const createdPublicArtifacts: string[] = [];

const sha256File = (filePath: string): string =>
  crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");

const protectedStorePath = path.resolve(process.cwd(), "data", "facetube_store.json");
const protectedPremPath = path.resolve(process.cwd(), "data", "premium_transactions.json");
let initialStoreHash = "";
let initialPremHash = "";

async function loginUser(
  identifier: string,
  password = "password123",
): Promise<{ token: string; userId: string }> {
  const res = await handleApiRequest(
    new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier, password }),
    }),
  );
  assert.ok(res, "Login must return response");
  assert.equal(res.status, 200, `Login failed for ${identifier}`);
  const json = await res.json();
  assert.ok(json.token, "Login must return Bearer token");
  return { token: json.token, userId: json.user.userId || json.user.user_id };
}

async function verifyTestPayment(params: {
  userId: string;
  purpose: "premium_video_upload" | "ads_promotion";
  videoId?: string;
  secret: string;
}): Promise<string> {
  const suffix = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const orderId = `order_vis_${suffix}`;
  const paymentId = `pay_vis_${suffix}`;
  const sig = crypto
    .createHmac("sha256", params.secret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");

  const env = {
    NODE_ENV: "test",
    RAZORPAY_KEY_ID: "rzp_test_vis",
    RAZORPAY_KEY_SECRET: params.secret,
    RAZORPAY_SKIP_REMOTE_CHECK: "true",
  };
  const res = await handleApiRequest(
    new Request("http://localhost:3000/api/payments/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId,
        paymentId,
        signature: sig,
        userId: params.userId,
        videoId: params.videoId,
        purpose: params.purpose,
      }),
    }),
    env,
    { pool: null },
  );
  assert.equal(res?.status, 200, "Payment verification must succeed in test env");
  return paymentId;
}

describe("Phase 1: Secure Video Visibility Backend (Node + PHP Parity)", () => {
  const testSecret = "test_razorpay_secret_vis_1234567890";
  let alexToken = "";
  let mayaToken = "";
  let adminToken = "";

  before(async () => {
    initialStoreHash = sha256File(protectedStorePath);
    initialPremHash = sha256File(protectedPremPath);
    testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-visibility-test-"));
    setTestPersistentDataDir(testDataDir);
    setMysqlPoolForTesting(null);
    resetInMemoryStore();
  });

  after(async () => {
    setMysqlPoolForTesting(null);
    await resetPersistentPremiumState().catch(() => {});
    setTestPersistentDataDir(null);
    resetInMemoryStore();
    for (const rel of createdPublicArtifacts) {
      const full = path.resolve(process.cwd(), rel);
      try {
        if (fs.existsSync(full)) {
          fs.unlinkSync(full);
        }
      } catch {
        // ignore cleanup error
      }
    }
    if (testDataDir) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
      testDataDir = "";
    }
    assert.equal(
      sha256File(protectedStorePath),
      initialStoreHash,
      "Protected facetube_store.json must remain unchanged",
    );
    assert.equal(
      sha256File(protectedPremPath),
      initialPremHash,
      "Protected premium_transactions.json must remain unchanged",
    );
  });

  beforeEach(async () => {
    setMysqlPoolForTesting(null);
    resetStoreForTests();
    const alex = await loginUser("alex@facetube.com");
    const maya = await loginUser("maya@facetube.com");
    const admin = await loginUser("admin@facetube.com");
    alexToken = alex.token;
    mayaToken = maya.token;
    adminToken = admin.token;
  });

  // --------------------------------------------------------------------------
  // 1. Unit rules & defaults
  // --------------------------------------------------------------------------
  describe("1. Visibility normalization & approved business rules", () => {
    it("defaults omitted/empty visibility to 'public' and rejects invalid strings", () => {
      assert.equal(normalizeVideoVisibility(undefined), "public");
      assert.equal(normalizeVideoVisibility(null), "public");
      assert.equal(normalizeVideoVisibility(""), "public");
      assert.equal(normalizeVideoVisibility("PUBLIC"), "public");
      assert.equal(normalizeVideoVisibility("Unlisted"), "unlisted");
      assert.equal(normalizeVideoVisibility(" private "), "private");
      assert.equal(normalizeVideoVisibility("friends_only"), null);
    });

    it("enforces Free (all 3), Paid Premium (public|unlisted), and Sponsored/Global Pool (public only)", () => {
      // Free video
      for (const vis of ["public", "unlisted", "private"] as const) {
        assert.equal(
          validateVisibilityRules({
            visibility: vis,
            videoType: "free",
            paymentStatus: "not_required",
          }).valid,
          true,
        );
      }

      // Paid Premium
      assert.equal(
        validateVisibilityRules({
          visibility: "public",
          videoType: "premium",
          paymentStatus: "paid",
        }).valid,
        true,
      );
      assert.equal(
        validateVisibilityRules({
          visibility: "unlisted",
          videoType: "premium",
          paymentStatus: "paid",
        }).valid,
        true,
      );
      assert.equal(
        validateVisibilityRules({
          visibility: "private",
          videoType: "premium",
          paymentStatus: "paid",
        }).valid,
        false,
      );

      // Sponsored / Promoted / Global Pool eligible
      assert.equal(
        validateVisibilityRules({
          visibility: "public",
          videoType: "free",
          paymentStatus: "not_required",
          isPromoted: true,
        }).valid,
        true,
      );
      assert.equal(
        validateVisibilityRules({
          visibility: "unlisted",
          videoType: "free",
          paymentStatus: "not_required",
          isPromoted: true,
        }).valid,
        false,
      );
      assert.equal(
        validateVisibilityRules({
          visibility: "unlisted",
          videoType: "free",
          paymentStatus: "not_required",
          isSponsored: true,
        }).valid,
        false,
      );
      assert.equal(
        validateVisibilityRules({
          visibility: "private",
          videoType: "free",
          paymentStatus: "not_required",
          globalPoolEligible: true,
        }).valid,
        false,
      );
    });

    it("seed videos default to 'public' visibility in /api/videos/list", async () => {
      const res = await handleApiRequest(new Request("http://localhost:3000/api/videos/list"));
      assert.equal(res?.status, 200);
      const data = await res?.json();
      assert.ok(Array.isArray(data.videos) && data.videos.length > 0);
      for (const v of data.videos) {
        assert.equal(v.visibility, "public");
      }
    });
  });

  // --------------------------------------------------------------------------
  // 2. Authentication, ownership & rule enforcement on videos/create & promote
  // --------------------------------------------------------------------------
  describe("2. Creation & promotion rules, auth, and anti-spoofing", () => {
    it("rejects unauthenticated videos/create (401) and cross-user creation (403) without FT483921 fallback", async () => {
      const unauthRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Unauth Attempt",
            video_url: "https://cdn.example.com/v.mp4",
          }),
        }),
      );
      assert.equal(unauthRes?.status, 401);

      const spoofRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${mayaToken}`,
          },
          body: JSON.stringify({
            user_id: "FT483921",
            title: "Spoof Alex Video",
            video_url: "https://cdn.example.com/v.mp4",
          }),
        }),
      );
      assert.equal(spoofRes?.status, 403);
    });

    it("rejects overwriting an existing video ID owned by another user (403)", async () => {
      const vidId = `vid-own-${Date.now()}`;
      const createRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${alexToken}`,
          },
          body: JSON.stringify({
            id: vidId,
            title: "Alex Original",
            video_url: "https://cdn.example.com/alex.mp4",
            visibility: "public",
          }),
        }),
      );
      assert.equal(createRes?.status, 201);

      const overwriteRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${mayaToken}`,
          },
          body: JSON.stringify({
            id: vidId,
            title: "Maya Hijack Attempt",
            video_url: "https://cdn.example.com/hijack.mp4",
            visibility: "private",
          }),
        }),
      );
      assert.equal(overwriteRes?.status, 403);
    });

    it("rejects invalid visibility (400), private on paid premium (400), non-public on sponsored/global-pool (400), and spoofed paid/promoted (402)", async () => {
      // Invalid visibility string
      const invalidVis = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${alexToken}`,
          },
          body: JSON.stringify({
            title: "Invalid Vis",
            video_url: "https://cdn.example.com/v.mp4",
            visibility: "secret_club",
          }),
        }),
      );
      assert.equal(invalidVis?.status, 400);

      // Verified payment for Alex
      const payId = await verifyTestPayment({
        userId: "FT483921",
        purpose: "premium_video_upload",
        secret: testSecret,
      });

      // Paid Premium with private -> 400
      const premPriv = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${alexToken}`,
          },
          body: JSON.stringify({
            title: "Premium Private Disallowed",
            video_url: "https://cdn.example.com/prem.mp4",
            video_type: "premium",
            payment_status: "paid",
            payment_id: payId,
            visibility: "private",
          }),
        }),
      );
      assert.equal(premPriv?.status, 400);

      // Paid Premium with public and unlisted -> 201
      for (const vis of ["public", "unlisted"] as const) {
        const premOk = await handleApiRequest(
          new Request("http://localhost:3000/api/videos/create", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${alexToken}`,
            },
            body: JSON.stringify({
              id: `vid-prem-${vis}-${Date.now()}`,
              title: `Premium ${vis}`,
              video_url: "https://cdn.example.com/prem.mp4",
              video_type: "premium",
              payment_status: "paid",
              payment_id: payId,
              visibility: vis,
            }),
          }),
        );
        assert.equal(premOk?.status, 201);
        const json = await premOk?.json();
        assert.equal(json.video.visibility, vis);
      }

      // Spoofed payment_status='paid' without payment_id -> 402
      const spoofPaid = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${alexToken}`,
          },
          body: JSON.stringify({
            title: "Spoof Paid",
            video_url: "https://cdn.example.com/spoof.mp4",
            video_type: "premium",
            payment_status: "paid",
            visibility: "public",
          }),
        }),
      );
      assert.equal(spoofPaid?.status, 402);

      // Sponsored / Global Pool / Promoted with unlisted or private -> 400
      for (const flag of ["is_promoted", "is_sponsored", "global_pool_eligible"] as const) {
        for (const vis of ["unlisted", "private"] as const) {
          const res = await handleApiRequest(
            new Request("http://localhost:3000/api/videos/create", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${alexToken}`,
              },
              body: JSON.stringify({
                title: `Sponsored Flag ${flag} ${vis}`,
                video_url: "https://cdn.example.com/sp.mp4",
                video_type: "free",
                visibility: vis,
                [flag]: true,
              }),
            }),
          );
          assert.equal(res?.status, 400, `${flag} with ${vis} must return 400`);
        }
      }

      // Spoofed is_promoted=true on create without ads_promotion tx -> 402
      const spoofPromo = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${alexToken}`,
          },
          body: JSON.stringify({
            title: "Spoof Promoted Create",
            video_url: "https://cdn.example.com/sp.mp4",
            is_promoted: true,
            visibility: "public",
          }),
        }),
      );
      assert.equal(spoofPromo?.status, 402);
    });

    it("videos/promote requires auth + ownership and rejects promoting unlisted or private videos", async () => {
      const unlistedId = `vid-unlisted-promo-${Date.now()}`;
      const privateId = `vid-private-promo-${Date.now()}`;
      const publicId = `vid-public-promo-${Date.now()}`;

      for (const [id, vis] of [
        [unlistedId, "unlisted"],
        [privateId, "private"],
        [publicId, "public"],
      ] as const) {
        const cr = await handleApiRequest(
          new Request("http://localhost:3000/api/videos/create", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${alexToken}`,
            },
            body: JSON.stringify({
              id,
              title: `Promo Target ${vis}`,
              video_url: "https://cdn.example.com/promo.mp4",
              visibility: vis,
            }),
          }),
        );
        assert.equal(cr?.status, 201);
      }

      // Unauthenticated -> 401
      const unauth = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/promote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ videoId: publicId }),
        }),
      );
      assert.equal(unauth?.status, 401);

      // Non-owner -> 403
      const nonOwner = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/promote", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${mayaToken}`,
          },
          body: JSON.stringify({ videoId: publicId }),
        }),
      );
      assert.equal(nonOwner?.status, 403);

      // Owner promoting unlisted/private -> 400
      for (const targetId of [unlistedId, privateId]) {
        const res = await handleApiRequest(
          new Request("http://localhost:3000/api/videos/promote", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${alexToken}`,
            },
            body: JSON.stringify({ videoId: targetId }),
          }),
        );
        assert.equal(res?.status, 400);
      }

      // Owner promoting public -> 200
      const okPromo = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/promote", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${alexToken}`,
          },
          body: JSON.stringify({ videoId: publicId }),
        }),
      );
      assert.equal(okPromo?.status, 200);

      // After promotion, owner cannot downgrade public promoted video to unlisted or private -> 400
      const downgradeRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${alexToken}`,
          },
          body: JSON.stringify({
            id: publicId,
            title: "Downgrade Attempt",
            video_url: "https://cdn.example.com/promo.mp4",
            visibility: "unlisted",
          }),
        }),
      );
      assert.equal(downgradeRes?.status, 400);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Listing, Get, Cross-User Privacy & Admin Privileges
  // --------------------------------------------------------------------------
  describe("3. Listing, Direct Get, Cross-User & Admin Access Control", () => {
    it("filters unlisted/private out of public feeds, search, category, shorts, and cross-user ?userId queries", async () => {
      const ts = Date.now();
      const pubId = `vis-pub-${ts}`;
      const unlId = `vis-unl-${ts}`;
      const prvId = `vis-prv-${ts}`;
      const unpaidPremId = `vis-unpaid-${ts}`;

      for (const payload of [
        {
          id: pubId,
          title: `VisibilityAuditUnique Public ${ts}`,
          video_url: "https://cdn.example.com/pub.mp4",
          content_type: "short",
          category: "Coding",
          visibility: "public",
        },
        {
          id: unlId,
          title: `VisibilityAuditUnique Unlisted ${ts}`,
          video_url: "https://cdn.example.com/unl.mp4",
          content_type: "short",
          category: "Coding",
          visibility: "unlisted",
        },
        {
          id: prvId,
          title: `VisibilityAuditUnique Private ${ts}`,
          video_url: "https://cdn.example.com/prv.mp4",
          content_type: "short",
          category: "Coding",
          visibility: "private",
        },
        {
          id: unpaidPremId,
          title: `VisibilityAuditUnique UnpaidPrem ${ts}`,
          video_url: "https://cdn.example.com/unpaid.mp4",
          video_type: "premium",
          payment_status: "pending",
          content_type: "short",
          category: "Coding",
          visibility: "public",
        },
      ]) {
        const r = await handleApiRequest(
          new Request("http://localhost:3000/api/videos/create", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${alexToken}`,
            },
            body: JSON.stringify(payload),
          }),
        );
        assert.equal(r?.status, 201);
      }

      // General public feed, search, category, shorts
      for (const query of [
        "",
        `?search=VisibilityAuditUnique`,
        `?category=Coding`,
        `?contentType=short`,
        `?videoType=free`,
        `?userId=FT483921`,
        `?userId=FT483921&include_blocked=1`,
      ]) {
        const res = await handleApiRequest(
          new Request(`http://localhost:3000/api/videos/list${query}`),
        );
        assert.equal(res?.status, 200);
        const ids = (await res!.json()).videos.map((v: any) => v.id);
        assert.ok(ids.includes(pubId), `Public video must be in list${query}`);
        assert.equal(ids.includes(unlId), false, `Unlisted must NOT be in public list${query}`);
        assert.equal(ids.includes(prvId), false, `Private must NOT be in public list${query}`);
        assert.equal(
          ids.includes(unpaidPremId),
          false,
          `Unpaid pending premium must NOT be in public list${query}`,
        );
      }

      // Authenticated OTHER user (Maya) querying Alex's userId must still see ONLY Alex's public video
      const mayaQueryRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/list?userId=FT483921&include_non_public=1", {
          headers: { Authorization: `Bearer ${mayaToken}` },
        }),
      );
      assert.equal(mayaQueryRes?.status, 200);
      const mayaIds = (await mayaQueryRes!.json()).videos.map((v: any) => v.id);
      assert.ok(mayaIds.includes(pubId));
      assert.equal(mayaIds.includes(unlId), false);
      assert.equal(mayaIds.includes(prvId), false);

      // Authenticated OWNER (Alex) sees public, unlisted, private, and own pending premium
      const alexQueryRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/list?userId=FT483921", {
          headers: { Authorization: `Bearer ${alexToken}` },
        }),
      );
      assert.equal(alexQueryRes?.status, 200);
      const alexIds = (await alexQueryRes!.json()).videos.map((v: any) => v.id);
      assert.ok(alexIds.includes(pubId));
      assert.ok(alexIds.includes(unlId));
      assert.ok(alexIds.includes(prvId));
      assert.ok(alexIds.includes(unpaidPremId));

      // Authenticated ADMIN sees all via ?userId, ?include_non_public=1, and /api/admin/videos
      const adminUserListRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/list?userId=FT483921", {
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      );
      const adminUserIds = (await adminUserListRes!.json()).videos.map((v: any) => v.id);
      assert.ok(adminUserIds.includes(pubId));
      assert.ok(adminUserIds.includes(unlId));
      assert.ok(adminUserIds.includes(prvId));

      const adminAllRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/list?include_non_public=1", {
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      );
      const adminAllIds = (await adminAllRes!.json()).videos.map((v: any) => v.id);
      assert.ok(adminAllIds.includes(unlId));
      assert.ok(adminAllIds.includes(prvId));

      const adminDashRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/videos", {
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      );
      assert.equal(adminDashRes?.status, 200);
      const adminDashVideos = (await adminDashRes!.json()).videos;
      assert.equal(adminDashVideos.find((v: any) => v.id === prvId)?.visibility, "private");
      assert.equal(adminDashVideos.find((v: any) => v.id === unlId)?.visibility, "unlisted");
    });

    it("videos/get allows unlisted by ID, blocks private for anon/other users (403), and allows owner/admin", async () => {
      const ts = Date.now();
      const unlId = `get-unl-${ts}`;
      const prvId = `get-prv-${ts}`;

      for (const [id, vis] of [
        [unlId, "unlisted"],
        [prvId, "private"],
      ] as const) {
        const r = await handleApiRequest(
          new Request("http://localhost:3000/api/videos/create", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${alexToken}`,
            },
            body: JSON.stringify({
              id,
              title: `Get Test ${vis}`,
              video_url: "https://cdn.example.com/get.mp4",
              visibility: vis,
            }),
          }),
        );
        assert.equal(r?.status, 201);
      }

      // Unlisted: accessible via direct ID anonymously and by Maya
      const anonUnl = await handleApiRequest(
        new Request(`http://localhost:3000/api/videos/get?id=${unlId}`),
      );
      assert.equal(anonUnl?.status, 200);
      assert.equal((await anonUnl!.json()).video.visibility, "unlisted");

      const mayaUnl = await handleApiRequest(
        new Request(`http://localhost:3000/api/videos/get?id=${unlId}`, {
          headers: { Authorization: `Bearer ${mayaToken}` },
        }),
      );
      assert.equal(mayaUnl?.status, 200);

      // Private: rejected for anonymous & Maya (403, zero metadata)
      for (const headers of [{}, { Authorization: `Bearer ${mayaToken}` }]) {
        const denied = await handleApiRequest(
          new Request(`http://localhost:3000/api/videos/get?id=${prvId}`, { headers }),
        );
        assert.equal(denied?.status, 403);
        const body = await denied?.json();
        assert.equal(body.success, false);
        assert.equal(body.video, undefined);
      }

      // Private: allowed for owner & admin
      for (const token of [alexToken, adminToken]) {
        const ok = await handleApiRequest(
          new Request(`http://localhost:3000/api/videos/get?id=${prvId}`, {
            headers: { Authorization: `Bearer ${token}` },
          }),
        );
        assert.equal(ok?.status, 200);
        const body = await ok?.json();
        assert.equal(body.video.id, prvId);
        assert.equal(body.video.visibility, "private");
      }
    });
  });

  // --------------------------------------------------------------------------
  // 4. Private Media Storage Isolation & Range Streaming
  // --------------------------------------------------------------------------
  describe("4. Private media storage isolation, static URL blocking & signed streaming", () => {
    it("moves uploaded local media out of public uploads/ on private create, blocks static /uploads/, and streams 200/206 only to authorized callers", async () => {
      const sampleBytes = Buffer.from("FACETUBE_PRIVATE_VIDEO_BYTES_0123456789ABCDEF");
      const form = new FormData();
      form.append("video", new File([sampleBytes], "secret_clip.mp4", { type: "video/mp4" }));

      const uploadRes = await handleApiRequest(
        new Request("http://localhost:3000/api/uploads/video", {
          method: "POST",
          body: form,
        }),
      );
      assert.equal(uploadRes?.status, 201);
      const uploadJson = await uploadRes?.json();
      const publicRelUrl: string = uploadJson.url; // "/uploads/videos/vid_..."
      assert.ok(publicRelUrl.startsWith("/uploads/videos/"));
      const uploadedFileName = path.basename(publicRelUrl);
      createdPublicArtifacts.push(path.join("uploads", "videos", uploadedFileName));

      const publicDiskPath = path.resolve(process.cwd(), "uploads", "videos", uploadedFileName);
      assert.equal(fs.existsSync(publicDiskPath), true, "Public upload should initially exist");

      const vidId = `priv-media-${Date.now()}`;
      const base64Thumb = `data:image/jpeg;base64,${Buffer.from("FAKE_JPEG_THUMB_DATA").toString("base64")}`;

      const createRes = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${alexToken}`,
          },
          body: JSON.stringify({
            id: vidId,
            title: "Truly Private Media Video",
            video_url: publicRelUrl,
            thumbnail_url: base64Thumb,
            video_type: "free",
            visibility: "private",
          }),
        }),
      );
      assert.equal(createRes?.status, 201);
      const createJson = await createRes?.json();

      // Public file must have been moved/unlinked from public uploads/
      assert.equal(
        fs.existsSync(publicDiskPath),
        false,
        "Private video file must be removed from public uploads/videos directory",
      );
      // Thumbnail must NOT exist under public uploads/images/
      const pubThumbPath = path.resolve(
        process.cwd(),
        "uploads",
        "images",
        `thumb_${vidId.replace(/[^a-zA-Z0-9_-]/g, "_")}.jpg`,
      );
      assert.equal(fs.existsSync(pubThumbPath), false);

      // Response URLs must be signed /api/videos/media URLs
      assert.ok(
        String(createJson.video.video_url).startsWith(
          `/api/videos/media?id=${encodeURIComponent(vidId)}`,
        ),
        "video_url must resolve to protected /api/videos/media endpoint",
      );
      assert.ok(
        String(createJson.video.thumbnail_url).startsWith(
          `/api/videos/media?id=${encodeURIComponent(vidId)}&kind=thumbnail`,
        ),
        "thumbnail_url must resolve to protected /api/videos/media thumbnail endpoint",
      );

      // Direct static /uploads/videos/<file> request must return 403
      const staticRes = await serveUploadFile(new Request(`http://localhost:3000${publicRelUrl}`));
      assert.equal(staticRes?.status, 403);

      // Protected /api/videos/media without auth/signature -> 401
      const unauthMedia = await handleApiRequest(
        new Request(`http://localhost:3000/api/videos/media?id=${vidId}&kind=video`),
      );
      assert.equal(unauthMedia?.status, 401);

      // Other user (Maya) with Bearer token -> 403
      const mayaMedia = await handleApiRequest(
        new Request(`http://localhost:3000/api/videos/media?id=${vidId}&kind=video`, {
          headers: { Authorization: `Bearer ${mayaToken}` },
        }),
      );
      assert.equal(mayaMedia?.status, 403);

      // Tampered signature -> 401
      const badSig = await handleApiRequest(
        new Request(
          `http://localhost:3000${createJson.video.video_url.replace(/sig=[^&]+/, "sig=0000bad")}`,
        ),
      );
      assert.equal(badSig?.status, 401);

      // Signed URL from videos/get -> 200 & exact bytes
      const signedMedia = await handleApiRequest(
        new Request(`http://localhost:3000${createJson.video.video_url}`),
      );
      assert.equal(signedMedia?.status, 200);
      assert.equal(signedMedia?.headers.get("Cache-Control")?.includes("private"), true);
      const streamedBuf = Buffer.from(await signedMedia!.arrayBuffer());
      assert.deepEqual(streamedBuf, sampleBytes);

      // Owner Bearer token with HTTP Range -> 206 Partial Content
      const rangeMedia = await handleApiRequest(
        new Request(`http://localhost:3000/api/videos/media?id=${vidId}&kind=video`, {
          headers: {
            Authorization: `Bearer ${alexToken}`,
            Range: "bytes=0-15",
          },
        }),
      );
      assert.equal(rangeMedia?.status, 206);
      assert.equal(rangeMedia?.headers.get("Content-Range"), `bytes 0-15/${sampleBytes.length}`);
      const partialBuf = Buffer.from(await rangeMedia!.arrayBuffer());
      assert.deepEqual(partialBuf, sampleBytes.subarray(0, 16));

      // Admin Bearer token -> 200
      const adminThumb = await handleApiRequest(
        new Request(`http://localhost:3000/api/videos/media?id=${vidId}&kind=thumbnail`, {
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      );
      assert.equal(adminThumb?.status, 200);
      assert.equal(await adminThumb!.text(), "FAKE_JPEG_THUMB_DATA");

      // Direct upload with visibility=private requires auth and returns private_media:// URL
      const privFormUnauth = new FormData();
      privFormUnauth.append("visibility", "private");
      privFormUnauth.append("video", new File([sampleBytes], "priv.mp4", { type: "video/mp4" }));
      const privUploadUnauth = await handleApiRequest(
        new Request("http://localhost:3000/api/uploads/video", {
          method: "POST",
          body: privFormUnauth,
        }),
      );
      assert.equal(privUploadUnauth?.status, 401);

      const privFormAuth = new FormData();
      privFormAuth.append("visibility", "private");
      privFormAuth.append("video", new File([sampleBytes], "priv.mp4", { type: "video/mp4" }));
      const privUploadAuth = await handleApiRequest(
        new Request("http://localhost:3000/api/uploads/video", {
          method: "POST",
          headers: { Authorization: `Bearer ${alexToken}` },
          body: privFormAuth,
        }),
      );
      assert.equal(privUploadAuth?.status, 201);
      const privUploadJson = await privUploadAuth?.json();
      assert.ok(String(privUploadJson.url).startsWith("private_media://videos/"));
      assert.equal(
        fs.existsSync(path.resolve(process.cwd(), "uploads", "videos", privUploadJson.fileName)),
        false,
      );
    });

    it("rejects expired signed media URLs", () => {
      const signed = signPrivateMediaUrl("vid-exp-1", "video", undefined, 60);
      const u = new URL(`http://localhost:3000${signed}`);
      assert.equal(
        verifyPrivateMediaSignature(
          "vid-exp-1",
          "video",
          u.searchParams.get("exp"),
          u.searchParams.get("sig"),
        ),
        true,
      );
      assert.equal(
        verifyPrivateMediaSignature("vid-exp-1", "video", "1000", u.searchParams.get("sig")),
        false,
      );
    });
  });

  // --------------------------------------------------------------------------
  // 5. MySQL Production-Mode Parity Tests
  // --------------------------------------------------------------------------
  describe("5. Production MySQL mockPool parity (visibility SQL, fail-closed migration check & promote)", () => {
    it("enforces fail-closed 500 if visibility column is missing when creating unlisted/private video", async () => {
      const capturedQueries: Array<{ sql: string; params: any[] }> = [];
      const mockQuery = async (sql: string, params: any[] = []) => {
        capturedQueries.push({ sql, params });
        if (sql.includes("FROM sessions")) {
          return [
            [
              {
                id: 2,
                user_id: "FT483921",
                name: "Alex Rivera",
                mobile: "",
                email: "alex@facetube.com",
                role: "user",
                referral_code: "CREATOR50",
                avatar_url: null,
                created_at: "2026-01-01 00:00:00",
              },
            ],
          ];
        }
        if (sql.includes("INFORMATION_SCHEMA.COLUMNS") && sql.includes("'visibility'")) {
          return [[]]; // migration not yet applied
        }
        return [[]];
      };
      const mockPool = { query: mockQuery } as any;
      const prodEnv = { APP_ENV: "production", NODE_ENV: "development" };

      const res = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/create", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer tok_alex_mysql",
          },
          body: JSON.stringify({
            id: "vid-mysql-nomig",
            title: "MySQL No Migration Private",
            video_url: "https://cdn.example.com/v.mp4",
            visibility: "private",
          }),
        }),
        prodEnv,
        { pool: mockPool },
      );
      assert.equal(res?.status, 500);
      const body = await res?.json();
      assert.match(body.error || "", /migration required/i);
    });

    it("applies visibility WHERE filter for non-owners in MySQL videos/list and enforces private/promote checks in videos/get + videos/promote", async () => {
      const capturedSql: string[] = [];
      const mockQuery = async (sql: string, params: any[] = []) => {
        capturedSql.push(sql);
        if (sql.includes("FROM sessions")) {
          const tok = String(params[0] || "");
          if (tok === "tok_alex") {
            return [
              [
                {
                  id: 2,
                  user_id: "FT483921",
                  name: "Alex",
                  mobile: "",
                  email: "alex@facetube.com",
                  role: "user",
                  referral_code: null,
                  avatar_url: null,
                  created_at: "2026-01-01",
                },
              ],
            ];
          }
          if (tok === "tok_maya") {
            return [
              [
                {
                  id: 3,
                  user_id: "FT900431",
                  name: "Maya",
                  mobile: "",
                  email: "maya@facetube.com",
                  role: "user",
                  referral_code: null,
                  avatar_url: null,
                  created_at: "2026-01-01",
                },
              ],
            ];
          }
          return [[]];
        }
        if (sql.includes("INFORMATION_SCHEMA.COLUMNS") && sql.includes("'visibility'")) {
          return [[{ COLUMN_NAME: "visibility" }]];
        }
        if (sql.includes("FROM uploaded_videos WHERE id = ?")) {
          const vidId = String(params[0]);
          if (vidId === "mysql-priv-1") {
            return [
              [
                {
                  id: "mysql-priv-1",
                  user_id: "FT483921",
                  creator_name: "Alex",
                  title: "MySQL Private",
                  video_url: "https://cdn.example.com/p.mp4",
                  thumbnail_url: "https://cdn.example.com/t.jpg",
                  video_type: "free",
                  content_type: "long",
                  payment_status: "not_required",
                  is_promoted: 0,
                  is_blocked: 0,
                  visibility: "private",
                },
              ],
            ];
          }
          return [[]];
        }
        if (
          sql.includes("FROM uploaded_videos") &&
          sql.includes("ORDER BY is_active_promoted DESC")
        ) {
          return [[]];
        }
        return [[]];
      };
      const mockPool = { query: mockQuery } as any;
      const prodEnv = { APP_ENV: "production", NODE_ENV: "development" };

      // Maya querying Alex's list -> SQL must filter visibility = 'public'
      capturedSql.length = 0;
      const listOther = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/list?userId=FT483921", {
          headers: { Authorization: "Bearer tok_maya" },
        }),
        prodEnv,
        { pool: mockPool },
      );
      assert.equal(listOther?.status, 200);
      assert.ok(
        capturedSql.some((s) => s.includes("COALESCE(visibility, 'public') = 'public'")),
        "Cross-user MySQL list must enforce public visibility filter in SQL",
      );

      // Alex querying own list -> SQL must NOT restrict to visibility = 'public'
      capturedSql.length = 0;
      const listOwner = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/list?userId=FT483921", {
          headers: { Authorization: "Bearer tok_alex" },
        }),
        prodEnv,
        { pool: mockPool },
      );
      assert.equal(listOwner?.status, 200);
      assert.equal(
        capturedSql.some((s) => s.includes("COALESCE(visibility, 'public') = 'public'")),
        false,
        "Owner MySQL list must return all own visibilities",
      );

      // Maya fetching Alex's private video via get -> 403
      const getDenied = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/get?id=mysql-priv-1", {
          headers: { Authorization: "Bearer tok_maya" },
        }),
        prodEnv,
        { pool: mockPool },
      );
      assert.equal(getDenied?.status, 403);

      // Alex fetching own private video via get -> 200
      const getOwner = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/get?id=mysql-priv-1", {
          headers: { Authorization: `Bearer tok_alex` },
        }),
        prodEnv,
        { pool: mockPool },
      );
      assert.equal(getOwner?.status, 200);

      // Alex promoting private video -> 400
      const promoDenied = await handleApiRequest(
        new Request("http://localhost:3000/api/videos/promote", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer tok_alex",
          },
          body: JSON.stringify({ videoId: "mysql-priv-1" }),
        }),
        prodEnv,
        { pool: mockPool },
      );
      assert.equal(promoDenied?.status, 400);
    });
  });

  // --------------------------------------------------------------------------
  // 6. PHP & SQL Migration Static Parity Assertions
  // --------------------------------------------------------------------------
  describe("6. Migration, .htaccess, and PHP endpoint parity checks", () => {
    it("contains idempotent additive SQL migration and base schema column", () => {
      const mig = fs.readFileSync(
        path.resolve(process.cwd(), "database/migrations/20261119_uploaded_videos_visibility.sql"),
        "utf8",
      );
      assert.match(mig, /uploaded_videos/);
      assert.match(
        mig,
        /`?visibility`?\s+ENUM\('+'?public'+'?,\s*'+'?unlisted'+'?,\s*'+'?private'+'?\)\s+NOT NULL\s+DEFAULT\s+'+'?public'+'?/i,
      );
      assert.match(mig, /idx_videos_visibility/i);

      const schema = fs.readFileSync(path.resolve(process.cwd(), "database/schema.sql"), "utf8");
      assert.match(
        schema,
        /`?visibility`?\s+ENUM\('public',\s*'unlisted',\s*'private'\)\s+NOT NULL\s+DEFAULT\s+'public'/i,
      );

      const htaccess = fs.readFileSync(
        path.resolve(process.cwd(), "api/storage/.htaccess"),
        "utf8",
      );
      assert.match(htaccess, /Require all denied/i);
      assert.match(htaccess, /Deny from all/i);
    });

    it("PHP endpoints mirror Node auth, visibility validation, view-count privacy ordering, and private media streaming", () => {
      const responsePhp = fs.readFileSync(path.resolve(process.cwd(), "api/response.php"), "utf8");
      const createPhp = fs.readFileSync(
        path.resolve(process.cwd(), "api/videos/create.php"),
        "utf8",
      );
      const listPhp = fs.readFileSync(path.resolve(process.cwd(), "api/videos/list.php"), "utf8");
      const getPhp = fs.readFileSync(path.resolve(process.cwd(), "api/videos/get.php"), "utf8");
      const mediaPhp = fs.readFileSync(path.resolve(process.cwd(), "api/videos/media.php"), "utf8");
      const promotePhp = fs.readFileSync(
        path.resolve(process.cwd(), "api/videos/promote.php"),
        "utf8",
      );
      const adminPhp = fs.readFileSync(path.resolve(process.cwd(), "api/admin/videos.php"), "utf8");
      const uploadPhp = fs.readFileSync(
        path.resolve(process.cwd(), "api/uploads/video.php"),
        "utf8",
      );

      assert.match(responsePhp, /function validateVideoVisibilityRules/);
      assert.match(responsePhp, /function moveLocalMediaToPrivate/);
      assert.match(responsePhp, /function verifyPrivateMediaSignature/);

      assert.match(createPhp, /getAuthUser\(\$pdo\)/);
      assert.doesNotMatch(createPhp, /FT483921/);
      assert.match(createPhp, /validateVideoVisibilityRules/);
      assert.match(createPhp, /moveLocalMediaToPrivate/);

      assert.match(listPhp, /COALESCE\(visibility,\s*'public'\)\s*=\s*'public'/);
      assert.match(listPhp, /\$canViewOwnerNonPublic/);

      // View increment must happen AFTER private access check in get.php
      const privateCheckIdx = getPhp.indexOf("$visibility === 'private'");
      const viewUpdateIdx = getPhp.indexOf("UPDATE uploaded_videos SET views = views + 1");
      assert.ok(privateCheckIdx > 0 && viewUpdateIdx > privateCheckIdx);

      assert.match(mediaPhp, /verifyPrivateMediaSignature/);
      assert.match(mediaPhp, /streamMediaFileWithRange/);

      assert.match(promotePhp, /getAuthUser\(\$pdo\)/);
      assert.match(promotePhp, /\$visibility !== 'public'/);

      assert.match(adminPhp, /visibility/);
      assert.match(uploadPhp, /ensurePrivateMediaDir\('videos'\)/);
    });
  });
});
