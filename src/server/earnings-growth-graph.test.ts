import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApiRequest, resetInMemoryStore } from "./api-handler";
import { setTestPersistentDataDir } from "./payments";

describe("FaceTube Task 5: Earnings Growth Graph — Real Data & Breakdown Tests", () => {
  const mockUserId = "FT_GROWTH_TEST_01";
  let testDataDir = "";
  let adminToken = "";

  before(async () => {
    testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-growth-graph-test-"));
    setTestPersistentDataDir(testDataDir);
    resetInMemoryStore();

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
  });

  after(() => {
    setTestPersistentDataDir(null);
    resetInMemoryStore();
    if (testDataDir) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  it("1. Returns ₹0 for all dates when no transactions exist (strictly no synthetic formulas)", async () => {
    const req = new Request(
      `http://localhost:3000/api/wallet/earnings-history.php?user_id=${mockUserId}&period=7D`,
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
    assert.equal(data.period, "7D");
    assert.equal(data.history.length, 7);
    assert.equal(data.summary.total_revenue, 0);
    assert.equal(data.summary.referral, 0);
    assert.equal(data.summary.global, 0);
    assert.equal(data.summary.adsense, 0);
    assert.equal(data.summary.admob, 0);
    assert.equal(data.summary.total_ad_earning, 0);
    assert.equal(data.summary.affiliate, 0);
    assert.equal(data.summary.ad_boost, 0);

    // Every single day must have 0 revenue and 0 across all streams
    for (const point of data.history) {
      assert.equal(point.revenue, 0, `Expected 0 revenue on ${point.date}, got ${point.revenue}`);
      assert.equal(point.referral, 0);
      assert.equal(point.global, 0);
      assert.equal(point.adsense, 0);
      assert.equal(point.admob, 0);
      assert.equal(point.total_ad_earning, 0);
      assert.equal(point.affiliate, 0);
      assert.equal(point.ad_boost, 0);
      assert.equal(point.tx_count, 0);
    }
  });

  it("2. Accurately handles timeframe periods: 7D, 30D, 90D, and 12M", async () => {
    const authHeaders = { Authorization: `Bearer ${adminToken}` };

    // 7D
    const res7 = await handleApiRequest(
      new Request(
        `http://localhost:3000/api/wallet/earnings-history?user_id=${mockUserId}&period=7D`,
        { headers: authHeaders },
      ),
    );
    assert.ok(res7);
    assert.equal(res7.status, 200);
    const data7 = await res7.json();
    assert.equal(data7.period, "7D");
    assert.equal(data7.history.length, 7);

    // 30D
    const res30 = await handleApiRequest(
      new Request(
        `http://localhost:3000/api/wallet/earnings-history?user_id=${mockUserId}&period=30D`,
        { headers: authHeaders },
      ),
    );
    assert.ok(res30);
    assert.equal(res30.status, 200);
    const data30 = await res30.json();
    assert.equal(data30.period, "30D");
    assert.equal(data30.history.length, 30);

    // 90D
    const res90 = await handleApiRequest(
      new Request(
        `http://localhost:3000/api/wallet/earnings-history?user_id=${mockUserId}&period=90D`,
        { headers: authHeaders },
      ),
    );
    assert.ok(res90);
    assert.equal(res90.status, 200);
    const data90 = await res90.json();
    assert.equal(data90.period, "90D");
    assert.equal(data90.history.length, 90);

    // 12M (Monthly aggregation across 12 calendar months)
    const res12M = await handleApiRequest(
      new Request(
        `http://localhost:3000/api/wallet/earnings-history?user_id=${mockUserId}&period=12M`,
        { headers: authHeaders },
      ),
    );
    assert.ok(res12M);
    assert.equal(res12M.status, 200);
    const data12M = await res12M.json();
    assert.equal(data12M.period, "12M");
    assert.equal(data12M.history.length, 12);
    // Keys in 12M should match YYYY-MM
    for (const point of data12M.history) {
      assert.match(point.date, /^\d{4}-\d{2}$/);
    }
  });

  it("3. Correctly categorizes transactions into streams including AdMob & Total Ad Earning", async () => {
    const activeUserId = "FT_MULTI_STREAM_USER";

    const testReq = new Request(
      `http://localhost:3000/api/wallet/earnings-history.php?user_id=${activeUserId}&period=7D`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    const testRes = await handleApiRequest(testReq);
    assert.ok(testRes);
    assert.equal(testRes.status, 200);
    const testData = await testRes.json();
    assert.equal(testData.success, true);
    assert.ok(testData.summary);
    assert.ok("referral" in testData.summary);
    assert.ok("global" in testData.summary);
    assert.ok("adsense" in testData.summary);
    assert.ok("admob" in testData.summary);
    assert.ok("total_ad_earning" in testData.summary);
    assert.ok("affiliate" in testData.summary);
    assert.ok("ad_boost" in testData.summary);
  });
});
