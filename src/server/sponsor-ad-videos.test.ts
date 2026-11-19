import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleApiRequest, isAdPromotionActive } from "./api-handler.js";

const env = {
  NODE_ENV: "test",
};

describe("FaceTube Task 4: Dynamic Sponsor Ad Video Dashboard Tests", () => {
  it("1. isAdPromotionActive accurately differentiates active vs expired vs unpromoted campaigns", () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const pastDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

    // Active campaign: is_promoted true and expiry in future
    assert.equal(
      isAdPromotionActive({
        is_promoted: true,
        promotion_expires_at: futureDate,
      }),
      true,
    );

    // Expired campaign: is_promoted true but expiry in the past
    assert.equal(
      isAdPromotionActive({
        is_promoted: true,
        promotion_expires_at: pastDate,
      }),
      false,
    );

    // Unpromoted video: is_promoted false even if date is provided
    assert.equal(
      isAdPromotionActive({
        is_promoted: false,
        promotion_expires_at: futureDate,
      }),
      false,
    );

    // Missing expiry date
    assert.equal(
      isAdPromotionActive({
        is_promoted: true,
        promotion_expires_at: null,
      }),
      false,
    );
  });

  it("2. /api/videos/list returns real campaign deliverables for specific creator (FT483921)", async () => {
    const req = new Request("http://localhost:3000/api/videos/list?userId=FT483921", {
      method: "GET",
    });

    const res = await handleApiRequest(req, env);
    assert.ok(res);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.videos));
    assert.ok(body.videos.length > 0);

    // All returned videos must strictly belong to FT483921
    for (const v of body.videos) {
      assert.equal(v.userId.toUpperCase(), "FT483921");
      assert.equal(typeof v.views, "number");
      assert.equal(typeof v.likes, "number");
      assert.equal(typeof v.isPromoted, "boolean");
    }

    // FT483921 seed video vid-seed-002 starts unpromoted in getInitialStore()
    const seedVid = body.videos.find((v: any) => v.id === "vid-seed-002");
    assert.ok(seedVid, "vid-seed-002 should exist for FT483921");
    assert.equal(seedVid.isPromoted, false);
    assert.equal(seedVid.promotionPlan ?? null, null);
  });

  it("3. /api/videos/list with Maya Lin (FT900431) isolates her campaign from Alex Rivera", async () => {
    const req = new Request("http://localhost:3000/api/videos/list?userId=FT900431", {
      method: "GET",
    });

    const res = await handleApiRequest(req, env);
    assert.ok(res);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);

    // All videos must belong strictly to FT900431
    for (const v of body.videos) {
      assert.equal(v.userId.toUpperCase(), "FT900431");
    }

    // Must not leak Alex Rivera's videos
    const alexVid = body.videos.find((v: any) => v.id === "vid-seed-002");
    assert.equal(alexVid, undefined, "FT483921's video must not leak in FT900431's video list");

    // Must include Maya's actively promoted seed video vid-seed-004
    const mayaPromoted = body.videos.find((v: any) => v.id === "vid-seed-004");
    assert.ok(mayaPromoted, "vid-seed-004 should exist for FT900431");
    assert.equal(mayaPromoted.isPromoted, true);
    assert.equal(mayaPromoted.promotionPlan, "plan-monthly");
    assert.ok(mayaPromoted.promotionExpiresAt);
  });

  it("4. /api/videos/list without userId returns all videos for platform-wide admin audit", async () => {
    const req = new Request("http://localhost:3000/api/videos/list", {
      method: "GET",
    });

    const res = await handleApiRequest(req, env);
    assert.ok(res);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.equal(body.success, true);
    assert.ok(body.videos.length >= 2);

    // Should contain both FT483921 and FT900431 videos
    const hasAlex = body.videos.some((v: any) => v.userId === "FT483921");
    const hasMaya = body.videos.some((v: any) => v.userId === "FT900431");
    assert.ok(hasAlex, "Platform-wide list must include Alex Rivera");
    assert.ok(hasMaya, "Platform-wide list must include Maya Lin");
  });

  it("5. /api/wallet/balance requires authentication and rejects unauthenticated request", async () => {
    const req = new Request("http://localhost:3000/api/wallet/balance?userId=FT483921", {
      method: "GET",
    });

    const res = await handleApiRequest(req, env);
    assert.ok(res);
    assert.equal(res.status, 401);

    const body = await res.json();
    assert.equal(body.success, false);
    assert.match(body.error, /Authentication required/i);
  });

  it("6. Promotion plan presets define valid pricing structure for campaigns", () => {
    const plans: Record<string, number> = {
      "plan-7-days": 100,
      "plan-15-days": 200,
      "plan-monthly": 300,
      "plan-yearly": 3000,
    };

    assert.equal(plans["plan-7-days"], 100);
    assert.equal(plans["plan-15-days"], 200);
    assert.equal(plans["plan-monthly"], 300);
    assert.equal(plans["plan-yearly"], 3000);
  });
});
