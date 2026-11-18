import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { handleApiRequest } from "./api-handler";
import { api } from "../lib/api";

describe("Task 2 - Phase 2A: Paid Subscriber Plans Foundation Tests", () => {
  let adminToken = "";
  let userToken = "";

  before(async () => {
    // 1. Authenticate as Admin (FT102857 / admin@facetube.com)
    const adminLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "admin@facetube.com", password: "password" }),
    });
    const adminLoginRes = await handleApiRequest(adminLoginReq);
    assert.ok(adminLoginRes, "Admin login request must return a response");
    const adminData = await adminLoginRes.json();
    assert.ok(adminData.token, "Admin login must return a session token");
    adminToken = adminData.token;

    // 2. Authenticate as Standard User (FT483921 / alex@facetube.com)
    const userLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
    });
    const userLoginRes = await handleApiRequest(userLoginReq);
    assert.ok(userLoginRes, "User login request must return a response");
    const userData = await userLoginRes.json();
    assert.ok(userData.token, "User login must return a session token");
    userToken = userData.token;
  });

  // Test Suite 1: Authentication & Authorization
  describe("1. Authentication & Method Verification (/api/subscriptions/plans)", () => {
    it("rejects unauthenticated requests with HTTP 401", async () => {
      const req = new Request("http://localhost:3000/api/subscriptions/plans", {
        method: "GET",
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 401);

      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /authentication required/i);
    });

    it("rejects non-GET HTTP methods with HTTP 405 Method Not Allowed", async () => {
      const req = new Request("http://localhost:3000/api/subscriptions/plans", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userToken}`,
        },
        body: JSON.stringify({ action: "test" }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 405);

      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /method not allowed/i);
    });
  });

  // Test Suite 2: Plan Listing & Schema
  describe("2. Subscriber Plans Catalog Listing & Schema", () => {
    it("returns HTTP 200 with active subscriber plans for authenticated user", async () => {
      const req = new Request("http://localhost:3000/api/subscriptions/plans", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.success, true);
      assert.ok(Array.isArray(data.plans), "plans must be an array");
      assert.ok(data.plans.length >= 3, "must return at least 3 initial plans");

      // Verify all returned plans are active for standard users
      for (const plan of data.plans) {
        assert.equal(plan.is_active, true, "standard user should only receive active plans");
        assert.ok(plan.plan_id, "plan must have a plan_id");
        assert.ok(plan.name, "plan must have a name");
        assert.ok(typeof plan.price === "number", "plan price must be a number");
        assert.ok(plan.price > 0, "plan price must be positive");
        assert.ok(typeof plan.duration_days === "number", "plan duration_days must be a number");
        assert.ok(Array.isArray(plan.perks), "plan perks must be an array of strings");
      }
    });

    it("contains expected baseline tiers: member-monthly, member-vip-monthly, member-annual", async () => {
      const req = new Request("http://localhost:3000/api/subscriptions/plans.php", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${userToken}`,
        },
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);

      const data = await res.json();
      const planIds = data.plans.map((p: any) => p.plan_id);

      assert.ok(planIds.includes("member-monthly"), "must include member-monthly plan");
      assert.ok(planIds.includes("member-vip-monthly"), "must include member-vip-monthly plan");
      assert.ok(planIds.includes("member-annual"), "must include member-annual plan");

      const monthly = data.plans.find((p: any) => p.plan_id === "member-monthly");
      assert.equal(monthly.price, 49.0);
      assert.equal(monthly.duration_days, 30);
      assert.ok(monthly.perks.length >= 3);

      const vip = data.plans.find((p: any) => p.plan_id === "member-vip-monthly");
      assert.equal(vip.price, 149.0);
      assert.equal(vip.duration_days, 30);

      const annual = data.plans.find((p: any) => p.plan_id === "member-annual");
      assert.equal(annual.price, 999.0);
      assert.equal(annual.duration_days, 365);
    });

    it("supports admin request with include_inactive parameter", async () => {
      const req = new Request(
        "http://localhost:3000/api/subscriptions/plans.php?include_inactive=1",
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${adminToken}`,
          },
        },
      );
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.success, true);
      assert.ok(Array.isArray(data.plans));
    });
  });

  // Test Suite 3: Migration File Integrity
  describe("3. SQL Migration File Verification", () => {
    it("verifies migration file exists and contains correct table structure", () => {
      const migrationPath = path.resolve(
        process.cwd(),
        "database/migrations/20261104_paid_subscriber_plans_and_refunds.sql",
      );
      assert.ok(fs.existsSync(migrationPath), "Migration file must exist on disk");

      const sql = fs.readFileSync(migrationPath, "utf-8");
      assert.ok(
        sql.includes("CREATE TABLE IF NOT EXISTS `subscriber_plans`"),
        "Must define subscriber_plans table",
      );
      assert.ok(
        sql.includes("`plan_id` VARCHAR(50) NOT NULL"),
        "Must include plan_id unique column",
      );
      assert.ok(sql.includes("`price` DECIMAL(10, 2) NOT NULL"), "Must include price column");
      assert.ok(
        sql.includes("`duration_days` INT UNSIGNED NOT NULL"),
        "Must include duration_days column",
      );
      assert.ok(sql.includes("`perks_json` TEXT DEFAULT NULL"), "Must include perks_json column");
      assert.ok(
        sql.includes("`is_active` TINYINT(1) NOT NULL DEFAULT 1"),
        "Must include is_active column",
      );
      assert.ok(
        sql.includes("INSERT IGNORE INTO `subscriber_plans`"),
        "Must use idempotent INSERT IGNORE for seed plans",
      );
      assert.ok(sql.includes("'member-monthly'"), "Seed data must contain member-monthly");
      assert.ok(sql.includes("'member-vip-monthly'"), "Seed data must contain member-vip-monthly");
      assert.ok(sql.includes("'member-annual'"), "Seed data must contain member-annual");
    });
  });

  // Test Suite 4: PHP Production Endpoint Integrity
  describe("4. PHP Production Endpoint (/api/subscriptions/plans.php) Verification", () => {
    it("verifies PHP endpoint file exists and implements secure conventions", () => {
      const phpPath = path.resolve(process.cwd(), "api/subscriptions/plans.php");
      assert.ok(fs.existsSync(phpPath), "api/subscriptions/plans.php must exist");

      const phpCode = fs.readFileSync(phpPath, "utf-8");
      assert.ok(phpCode.includes("getDatabaseConnection()"), "Must use getDatabaseConnection()");
      assert.ok(
        phpCode.includes("getAuthUser($pdo)"),
        "Must enforce authentication via getAuthUser",
      );
      assert.ok(phpCode.includes("is_active = 1"), "Must filter for active plans by default");
      assert.ok(phpCode.includes("subscriber_plans"), "Must query subscriber_plans table");
      assert.ok(phpCode.includes("baseline_fallback"), "Must support graceful baseline fallback");
    });
  });

  // Test Suite 5: Frontend Client API Helper
  describe("5. Frontend Client API Helper Verification", () => {
    it("verifies api.subscriptions.listPlans is defined and callable", () => {
      assert.ok(api.subscriptions, "api.subscriptions must be defined");
      assert.ok(
        typeof api.subscriptions.listPlans === "function",
        "api.subscriptions.listPlans must be a function",
      );
    });
  });

  // Test Suite 6: Phase 2 Production DB Fail-Closed Protection
  describe("6. Production Safety & No Baseline/JSON Fallback on /api/subscriptions/plans", () => {
    const prodEnv = { APP_ENV: "production", NODE_ENV: "development" };

    it("fails closed with 503 (never 401 or baseline_fallback) when production DB is unavailable", async () => {
      const noTokenRes = await handleApiRequest(
        new Request("http://localhost:3000/api/subscriptions/plans", { method: "GET" }),
        prodEnv,
        { pool: null },
      );
      assert.ok(noTokenRes);
      assert.equal(noTokenRes.status, 503);
      const noTokenData = await noTokenRes.json();
      assert.equal(noTokenData.success, false);
      assert.equal(noTokenData.plans, undefined);

      const withTokenRes = await handleApiRequest(
        new Request("http://localhost:3000/api/subscriptions/plans", {
          method: "GET",
          headers: { Authorization: `Bearer ${userToken}` },
        }),
        prodEnv,
        { pool: null },
      );
      assert.ok(withTokenRes);
      assert.equal(withTokenRes.status, 503);
    });

    it("fails closed with 503 when subscriber_plans table is missing or query fails in production", async () => {
      const makePool = (throwOnPlans: boolean) =>
        ({
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
            if (throwOnPlans) {
              const err = new Error("Table 'facetube.subscriber_plans' doesn't exist") as Error & {
                code?: string;
              };
              err.code = "ER_NO_SUCH_TABLE";
              throw err;
            }
            return [[]];
          },
        }) as any;

      const missingTableRes = await handleApiRequest(
        new Request("http://localhost:3000/api/subscriptions/plans", {
          method: "GET",
          headers: { Authorization: `Bearer ${userToken}` },
        }),
        prodEnv,
        { pool: makePool(true) },
      );
      assert.ok(missingTableRes);
      assert.equal(missingTableRes.status, 503);
      const missingData = await missingTableRes.json();
      assert.equal(missingData.success, false);
      assert.equal(missingData.plans, undefined);

      const zeroRowRes = await handleApiRequest(
        new Request("http://localhost:3000/api/subscriptions/plans", {
          method: "GET",
          headers: { Authorization: `Bearer ${userToken}` },
        }),
        prodEnv,
        { pool: makePool(false) },
      );
      assert.ok(zeroRowRes);
      assert.equal(zeroRowRes.status, 200);
      const zeroData = await zeroRowRes.json();
      assert.equal(zeroData.success, true);
      assert.equal(zeroData.source, "database");
      assert.deepEqual(zeroData.plans, []);
    });
  });
});
