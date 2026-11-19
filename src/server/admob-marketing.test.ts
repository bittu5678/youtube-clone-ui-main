import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  handleApiRequest,
  isFailClosedProductionEnv,
  isMysqlDuplicateKeyError,
  resetInMemoryStore,
} from "./api-handler.ts";
import { setMysqlPoolForTesting } from "./mysql.ts";
import { setTestPersistentDataDir } from "./payments.ts";
import { ADMOB_TEST_IDS, resolveAdMobConfig, requireAdMobConfig } from "../lib/admob-service.ts";

describe("FaceTube Google AdMob Integration & Backend Statements Test Suite", () => {
  let adminToken = "";
  let userToken = "";
  const targetCreator = "FT483921";
  const testMonth = "2026-08";
  let testDataDir = "";
  let storePath = "";
  const originalNodeEnv = process.env["NODE_ENV"];

  before(async () => {
    if (!process.env["NODE_ENV"] && !process.env["APP_ENV"]) {
      process.env["NODE_ENV"] = "test";
    }
    testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-admob-marketing-test-"));
    storePath = path.join(testDataDir, "facetube_store.json");
    setTestPersistentDataDir(testDataDir);
    resetInMemoryStore();

    // 1. Authenticate as Admin (admin@facetube.com)
    const adminLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "admin@facetube.com", password: "password123" }),
    });
    const adminLoginRes = await handleApiRequest(adminLoginReq);
    assert.ok(adminLoginRes, "Admin login request must return a response");
    const adminData = (await adminLoginRes.json()) as any;
    assert.ok(adminData.token, "Admin login must return a session token");
    adminToken = adminData.token;

    // 2. Authenticate as Standard User (alex@facetube.com)
    const userLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "alex@facetube.com", password: "password123" }),
    });
    const userLoginRes = await handleApiRequest(userLoginReq);
    assert.ok(userLoginRes, "User login request must return a response");
    const userData = (await userLoginRes.json()) as any;
    assert.ok(userData.token, "User login must return a session token");
    userToken = userData.token;
  });

  after(() => {
    setMysqlPoolForTesting(null);
    if (originalNodeEnv !== undefined) process.env["NODE_ENV"] = originalNodeEnv;
    else delete process.env["NODE_ENV"];

    setTestPersistentDataDir(null);
    resetInMemoryStore();
    if (testDataDir) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  it("1. Admin Authorization Enforcement", async () => {
    // 1a. Unauthenticated request rejected with 401
    const unauthReq = new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: targetCreator,
        amount: 500,
        reportMonth: testMonth,
      }),
    });
    const unauthRes = await handleApiRequest(unauthReq);
    assert.ok(unauthRes, "Handler returned a response");
    assert.equal(unauthRes.status, 401, "Rejects unauthenticated request with 401");

    // 1b. Regular non-admin user rejected with 403
    const userReq = new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        userId: targetCreator,
        amount: 500,
        reportMonth: testMonth,
      }),
    });
    const userRes = await handleApiRequest(userReq);
    assert.ok(userRes, "Handler returned a response");
    assert.equal(userRes.status, 403, "Rejects non-admin user with 403");
  });

  it("2. Input Validation (Amount, UserId, Month format)", async () => {
    // 2a. Missing userId -> 400
    const missingUserReq = new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        amount: 500,
        reportMonth: testMonth,
      }),
    });
    const missingUserRes = await handleApiRequest(missingUserReq);
    assert.equal(missingUserRes?.status, 400, "Rejects missing userId with 400");

    // 2b. Zero or negative amount -> 400
    const invalidAmountReq = new Request(
      "http://localhost:3000/api/admin/record-admob-earning.php",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          userId: targetCreator,
          amount: -50,
          reportMonth: testMonth,
        }),
      },
    );
    const invalidAmountRes = await handleApiRequest(invalidAmountReq);
    assert.equal(invalidAmountRes?.status, 400, "Rejects negative amount with 400");

    // 2c. Invalid reportMonth format -> 400
    const invalidMonthReq = new Request(
      "http://localhost:3000/api/admin/record-admob-earning.php",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          userId: targetCreator,
          amount: 500,
          reportMonth: "invalid-month",
        }),
      },
    );
    const invalidMonthRes = await handleApiRequest(invalidMonthReq);
    assert.equal(invalidMonthRes?.status, 400, "Rejects invalid reportMonth with 400");
  });

  it("3. Successful Statement Recording, Existing Balance Preservation & Duplicate Protection", async () => {
    const testAmount = 350.75;

    // 3a. Snapshot creator wallet before AdMob credit
    const preWalletReq = new Request(
      `http://localhost:3000/api/wallet/balance.php?userId=${targetCreator}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      },
    );
    const preWalletRes = await handleApiRequest(preWalletReq);
    const preWalletBody = (await preWalletRes?.json()) as any;
    assert.equal(preWalletBody.success, true);
    const preWallet = preWalletBody.wallet;

    // 3b. Record verified AdMob monthly statement
    const recordReq = new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        userId: targetCreator,
        amount: testAmount,
        reportMonth: testMonth,
        impressions: 12500,
        ecpm: 28.06,
        description: "Google AdMob Finalized Performance Statement August 2026",
      }),
    });
    const recordRes = await handleApiRequest(recordReq);
    assert.equal(recordRes?.status, 201, "Successfully credits statement with 201");
    const recordBody = (await recordRes?.json()) as any;
    assert.equal(recordBody.success, true);
    assert.equal(recordBody.amount, testAmount);
    assert.ok(recordBody.transactionId, "Generated transaction ID");

    // 3c. Verify wallet admob_income, balance, and total_earned incremented while other incomes are preserved
    const walletReq = new Request(
      `http://localhost:3000/api/wallet/balance.php?userId=${targetCreator}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      },
    );
    const walletRes = await handleApiRequest(walletReq);
    const walletBody = (await walletRes?.json()) as any;
    assert.equal(walletBody.success, true);
    const postWallet = walletBody.wallet;

    assert.equal(
      Number((postWallet.admob_income - preWallet.admob_income).toFixed(2)),
      testAmount,
      "Wallet admob_income incremented by exact AdMob amount",
    );
    assert.equal(
      Number((postWallet.balance - preWallet.balance).toFixed(2)),
      testAmount,
      "Wallet balance incremented by exact AdMob amount",
    );
    assert.equal(
      Number((postWallet.total_earned - preWallet.total_earned).toFixed(2)),
      testAmount,
      "Wallet total_earned incremented by exact AdMob amount",
    );
    assert.equal(
      postWallet.referral_income,
      preWallet.referral_income,
      "Existing referral_income preserved",
    );
    assert.equal(
      postWallet.global_income,
      preWallet.global_income,
      "Existing global_income preserved",
    );
    assert.equal(
      postWallet.adsense_income,
      preWallet.adsense_income,
      "Existing adsense_income preserved",
    );
    assert.equal(
      postWallet.affiliate_income,
      preWallet.affiliate_income,
      "Existing affiliate_income preserved",
    );
    assert.equal(
      postWallet.total_withdrawn,
      preWallet.total_withdrawn,
      "Existing total_withdrawn preserved",
    );

    // 3d. Duplicate prevention: Re-recording same user and month returns 409 Conflict
    const dupReq = new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        userId: targetCreator,
        amount: testAmount,
        reportMonth: testMonth,
      }),
    });
    const dupRes = await handleApiRequest(dupReq);
    assert.equal(dupRes?.status, 409, "Blocks duplicate statement credit with HTTP 409 Conflict");

    // Verify wallet balance did not change after duplicate attempt
    const afterDupWalletRes = await handleApiRequest(
      new Request(`http://localhost:3000/api/wallet/balance.php?userId=${targetCreator}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      }),
    );
    const afterDupWallet = ((await afterDupWalletRes?.json()) as any).wallet;
    assert.equal(afterDupWallet.admob_income, postWallet.admob_income);
    assert.equal(afterDupWallet.balance, postWallet.balance);
  });

  it("4. Admin AdMob Statements Listing", async () => {
    const listReq = new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
      method: "GET",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const listRes = await handleApiRequest(listReq);
    assert.equal(listRes?.status, 200, "Returns HTTP 200 for statements list");
    const listBody = (await listRes?.json()) as any;
    assert.equal(listBody.success, true);
    assert.ok(Array.isArray(listBody.statements), "Statements list is an array");
    assert.ok(listBody.count > 0, "Contains recorded statements");
  });

  it("5. Zero Default for Existing Wallet Records Without admob_income Field", async () => {
    const testUser = "FT900431";
    const originalWallet =
      fs.existsSync(storePath) &&
      JSON.parse(fs.readFileSync(storePath, "utf-8")).wallets?.[testUser]
        ? structuredClone(JSON.parse(fs.readFileSync(storePath, "utf-8")).wallets[testUser])
        : null;

    if (fs.existsSync(storePath)) {
      const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
      if (store.wallets?.[testUser]) {
        delete store.wallets[testUser].admob_income;
        fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
      }
    }

    try {
      const res = await handleApiRequest(
        new Request(`http://localhost:3000/api/wallet/balance.php?userId=${testUser}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      );
      assert.equal(res?.status, 200);
      const body = (await res?.json()) as any;
      assert.equal(body.success, true);
      assert.equal(body.wallet.admob_income, 0, "Legacy wallet without admob_income defaults to 0");
      assert.equal(body.wallet.admobIncome, 0, "CamelCase admobIncome defaults to 0");
    } finally {
      if (originalWallet && fs.existsSync(storePath)) {
        const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
        store.wallets[testUser] = originalWallet;
        fs.writeFileSync(storePath, JSON.stringify(store, null, 2), "utf-8");
      }
    }
  });

  it("6. MySQL Path: Credits wallet_balances.admob_income, Preserves Other Balances, Enforces Duplicate Protection & Zero Default", async () => {
    const origHost = process.env["DB_HOST"];
    const origName = process.env["DB_NAME"];
    const origUser = process.env["DB_USER"];

    process.env["DB_HOST"] = "127.0.0.1";
    process.env["DB_NAME"] = "facetube_test";
    process.env["DB_USER"] = "test_user";

    const mysqlWalletState = {
      user_id: targetCreator,
      balance: 4280.5,
      total_earned: 7430.5,
      total_withdrawn: 3150.0,
      referral_income: 1079.5,
      global_income: 2450.0,
      adsense_income: 1890.2,
      admob_income: 0.0,
      affiliate_income: 940.8,
      updated_at: "2026-11-13 08:00:00",
    };

    const recordedStatements = new Map<string, { id: number; statement_id: string }>();
    let committed = false;
    let rolledBack = false;

    const executeQuery = async (sql: string, params: any[] = []) => {
      if (sql.includes("FROM sessions s") && sql.includes("JOIN users u")) {
        return [
          [
            {
              id: "a0000000-0000-0000-0000-000000000001",
              user_id: "FT102857",
              name: "FaceTube Administrator",
              email: "admin@facetube.com",
              role: "admin",
              referral_code: "FTVIP",
            },
          ],
        ];
      }
      if (sql.includes("SELECT id, user_id, name, email FROM users WHERE UPPER(user_id)")) {
        return [[{ id: "a0000000-0000-0000-0000-000000000002", user_id: targetCreator }]];
      }
      if (sql.includes("FROM admob_monthly_statements WHERE user_id = ? AND report_month = ?")) {
        const key = `${params[0]}_${params[1]}`;
        const existing = recordedStatements.get(key);
        return [existing ? [existing] : []];
      }
      if (sql.startsWith("INSERT INTO income_ledger")) {
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith("INSERT INTO admob_monthly_statements")) {
        assert.equal(
          params[7],
          null,
          "Non-production calls omitting appId must bind SQL NULL, never Google test App ID",
        );
        const key = `${params[1]}_${params[2]}`;
        recordedStatements.set(key, { id: 1, statement_id: String(params[0]) });
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith("INSERT INTO wallet_balances")) {
        assert.ok(
          sql.includes("admob_income") &&
            sql.includes("admob_income = admob_income + VALUES(admob_income)"),
          "MySQL wallet_balances query must explicitly insert and increment admob_income",
        );
        assert.equal(
          params.length,
          4,
          "Wallet query must bind [userId, balance, total_earned, admob_income]",
        );
        assert.equal(
          params[1],
          params[3],
          "Credited admob_income must match credited balance amount",
        );
        mysqlWalletState.balance += Number(params[1]);
        mysqlWalletState.total_earned += Number(params[2]);
        mysqlWalletState.admob_income += Number(params[3]);
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("FROM wallet_balances WHERE UPPER(user_id) = UPPER(?)")) {
        return [[{ ...mysqlWalletState }]];
      }
      return [[]];
    };

    const mockPool = {
      query: executeQuery,
      getConnection: async () => ({
        beginTransaction: async () => {
          committed = false;
          rolledBack = false;
        },
        query: executeQuery,
        commit: async () => {
          committed = true;
        },
        rollback: async () => {
          rolledBack = true;
        },
        release: () => {},
      }),
    };

    setMysqlPoolForTesting(mockPool);

    try {
      // 6a. Zero default before any AdMob earnings
      const preRes = await handleApiRequest(
        new Request(`http://localhost:3000/api/wallet/balance?userId=${targetCreator}`, {
          method: "GET",
          headers: { Authorization: `Bearer ${adminToken}` },
        }),
      );
      assert.equal(preRes?.status, 200);
      const preData = (await preRes?.json()) as any;
      assert.equal(preData.wallet.admob_income, 0);
      assert.equal(preData.wallet.balance, 4280.5);

      // 6b. Record verified AdMob earning through MySQL path
      const creditRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: targetCreator,
            amount: 250.25,
            reportMonth: "2026-09",
          }),
        }),
      );
      assert.equal(creditRes?.status, 201);
      assert.equal(committed, true);
      assert.equal(mysqlWalletState.admob_income, 250.25);
      assert.equal(mysqlWalletState.balance, 4530.75);
      assert.equal(mysqlWalletState.total_earned, 7680.75);
      assert.equal(mysqlWalletState.referral_income, 1079.5);
      assert.equal(mysqlWalletState.global_income, 2450.0);
      assert.equal(mysqlWalletState.adsense_income, 1890.2);
      assert.equal(mysqlWalletState.affiliate_income, 940.8);
      assert.equal(mysqlWalletState.total_withdrawn, 3150.0);

      // 6c. Duplicate month blocked in MySQL path with 409 + rollback
      const dupRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: targetCreator,
            amount: 250.25,
            reportMonth: "2026-09",
          }),
        }),
      );
      assert.equal(dupRes?.status, 409);
      assert.equal(rolledBack, true);
      assert.equal(mysqlWalletState.admob_income, 250.25);
      assert.equal(mysqlWalletState.balance, 4530.75);
    } finally {
      setMysqlPoolForTesting(null);
      if (origHost !== undefined) process.env["DB_HOST"] = origHost;
      else delete process.env["DB_HOST"];
      if (origName !== undefined) process.env["DB_NAME"] = origName;
      else delete process.env["DB_NAME"];
      if (origUser !== undefined) process.env["DB_USER"] = origUser;
      else delete process.env["DB_USER"];
    }
  });

  it("7. Migration & Schema Verification for wallet_balances.admob_income", () => {
    const migrationPath = path.resolve(
      process.cwd(),
      "database/migrations/20261112_wallet_balances_admob_income.sql",
    );
    const schemaPath = path.resolve(process.cwd(), "database/schema.sql");

    assert.ok(
      fs.existsSync(migrationPath),
      "Migration 20261112_wallet_balances_admob_income.sql must exist",
    );
    const migrationSql = fs.readFileSync(migrationPath, "utf-8");
    assert.ok(migrationSql.includes("INFORMATION_SCHEMA.COLUMNS"));
    assert.ok(migrationSql.includes("wallet_balances"));
    assert.ok(migrationSql.includes("`admob_income` DECIMAL(14, 2) NOT NULL DEFAULT 0.00"));
    assert.ok(!migrationSql.includes("ADD COLUMN IF NOT EXISTS"));

    const schemaSql = fs.readFileSync(schemaPath, "utf-8");
    assert.ok(
      schemaSql.includes("`admob_income` DECIMAL(14, 2) NOT NULL DEFAULT 0.00"),
      "database/schema.sql must define wallet_balances.admob_income DECIMAL(14, 2) NOT NULL DEFAULT 0.00",
    );
  });

  it("8. Production App ID Safety: Fail-Closed Validation, ADMOB_APP_ID Resolution, Atomic Rollback & Duplicate Race 409", async () => {
    const origHost = process.env["DB_HOST"];
    const origName = process.env["DB_NAME"];
    const origUser = process.env["DB_USER"];
    const origNodeEnv = process.env["NODE_ENV"];
    const origAppEnv = process.env["APP_ENV"];
    const origAdMobAppId = process.env["ADMOB_APP_ID"];

    process.env["DB_HOST"] = "127.0.0.1";
    process.env["DB_NAME"] = "facetube_test";
    process.env["DB_USER"] = "test_user";

    const realProdAppId = "ca-app-pub-1234567890123456~1234567890";
    let ledgerInserts: number = 0;
    let walletInserts: number = 0;
    const recordedAppIds: Array<string | null> = [];
    let rolledBack = false;
    let committed = false;
    let getConnectionCalls: number = 0;
    let simulateStatementFailure:
      "none" | "missing_table" | "dup_race" | "not_null_23000" | "fk_23000" = "none";

    const executeQuery = async (sql: string, params: any[] = []) => {
      if (sql.includes("FROM sessions s") && sql.includes("JOIN users u")) {
        return [
          [
            {
              id: "a0000000-0000-0000-0000-000000000001",
              user_id: "FT102857",
              name: "FaceTube Administrator",
              email: "admin@facetube.com",
              role: "admin",
              referral_code: "FTVIP",
            },
          ],
        ];
      }
      if (sql.includes("SELECT id, user_id, name, email FROM users WHERE UPPER(user_id)")) {
        return [[{ id: "a0000000-0000-0000-0000-000000000002", user_id: targetCreator }]];
      }
      if (sql.includes("FROM admob_monthly_statements WHERE user_id = ? AND report_month = ?")) {
        return [[]];
      }
      if (sql.startsWith("INSERT INTO income_ledger")) {
        ledgerInserts += 1;
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith("INSERT INTO admob_monthly_statements")) {
        if (simulateStatementFailure === "missing_table") {
          const err: any = new Error(
            "Table 'facetube_test.admob_monthly_statements' doesn't exist",
          );
          err.code = "ER_NO_SUCH_TABLE";
          err.errno = 1146;
          throw err;
        }
        if (simulateStatementFailure === "dup_race") {
          const err: any = new Error(
            "Duplicate entry 'FT483921-2026-10' for key 'uniq_admob_statement_user_month'",
          );
          err.code = "ER_DUP_ENTRY";
          err.errno = 1062;
          err.sqlState = "23000";
          throw err;
        }
        if (simulateStatementFailure === "not_null_23000") {
          const err: any = new Error("Column 'verified_by' cannot be null");
          err.code = "ER_BAD_NULL_ERROR";
          err.errno = 1048;
          err.sqlState = "23000";
          throw err;
        }
        if (simulateStatementFailure === "fk_23000") {
          const err: any = new Error(
            "Cannot add or update a child row: a foreign key constraint fails",
          );
          err.code = "ER_NO_REFERENCED_ROW_2";
          err.errno = 1452;
          err.sqlState = "23000";
          throw err;
        }
        recordedAppIds.push(params[7]);
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith("INSERT INTO wallet_balances")) {
        walletInserts += 1;
        return [{ affectedRows: 1 }];
      }
      return [[]];
    };

    const mockPool = {
      query: executeQuery,
      getConnection: async () => {
        getConnectionCalls += 1;
        return {
          beginTransaction: async () => {
            rolledBack = false;
            committed = false;
          },
          query: executeQuery,
          commit: async () => {
            committed = true;
          },
          rollback: async () => {
            rolledBack = true;
          },
          release: () => {},
        };
      },
    };

    setMysqlPoolForTesting(mockPool);

    try {
      // 8a. Fail closed when neither NODE_ENV nor APP_ENV is set and ADMOB_APP_ID is missing
      delete process.env["NODE_ENV"];
      delete process.env["APP_ENV"];
      delete process.env["ADMOB_APP_ID"];
      const unsetEnvRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: targetCreator,
            amount: 100,
            reportMonth: "2026-10",
          }),
        }),
      );
      assert.equal(
        unsetEnvRes?.status,
        500,
        "Fails closed when env mode is unset and ADMOB_APP_ID is missing",
      );
      assert.equal(getConnectionCalls, 0, "Does not start transaction on missing ADMOB_APP_ID");

      // 8b. NODE_ENV=production rejects missing ADMOB_APP_ID before DB transaction
      process.env["NODE_ENV"] = "production";
      const missingConfigRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: targetCreator,
            amount: 100,
            reportMonth: "2026-10",
          }),
        }),
      );
      assert.equal(missingConfigRes?.status, 500);
      assert.equal(getConnectionCalls, 0);

      // 8c. Reject Google reserved test publisher ID (even if explicitly passed or set in ADMOB_APP_ID) & malformed/ad-unit IDs
      for (const badId of [
        "ca-app-pub-3940256099942544~3347511713",
        "ca-app-pub-3940256099942544~9999999999",
        "ca-app-pub-1234567890123456/1234567890",
        "invalid-app-id",
      ]) {
        const badRes = await handleApiRequest(
          new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
              userId: targetCreator,
              amount: 100,
              reportMonth: "2026-10",
              appId: badId,
            }),
          }),
        );
        assert.equal(badRes?.status, 400, `Production rejects invalid/test appId '${badId}'`);
      }

      process.env["ADMOB_APP_ID"] = "ca-app-pub-3940256099942544~3347511713";
      const testEnvIdRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: targetCreator,
            amount: 100,
            reportMonth: "2026-10",
          }),
        }),
      );
      assert.equal(
        testEnvIdRes?.status,
        400,
        "Rejects misconfigured ADMOB_APP_ID containing reserved test publisher ID",
      );
      assert.equal(getConnectionCalls, 0, "Never opens DB transaction for invalid/test App IDs");

      // 8d. Valid production ADMOB_APP_ID resolves when caller omits appId
      process.env["ADMOB_APP_ID"] = realProdAppId;
      const validProdRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: targetCreator,
            amount: 325.5,
            reportMonth: "2026-10",
          }),
        }),
      );
      assert.equal(validProdRes?.status, 201);
      assert.equal(committed, true);
      assert.equal(recordedAppIds[0], realProdAppId);
      assert.equal(walletInserts, 1);

      // 8e. Failure inserting into admob_monthly_statements rolls back income_ledger and skips wallet_balances
      const ledgerBeforeFail = ledgerInserts;
      const walletBeforeFail = walletInserts;
      simulateStatementFailure = "missing_table";
      const stmtFailRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: targetCreator,
            amount: 325.5,
            reportMonth: "2026-11",
          }),
        }),
      );
      assert.equal(
        stmtFailRes?.status,
        500,
        "Returns 500 when monthly statement persistence fails",
      );
      assert.equal(rolledBack, true, "Rolls back transaction when statement insert fails");
      assert.equal(committed, false, "Does not commit transaction on statement failure");
      assert.equal(ledgerInserts, ledgerBeforeFail + 1, "Rolled back ledger attempt");
      assert.equal(
        walletInserts,
        walletBeforeFail,
        "Never updates wallet_balances on statement fail",
      );

      // 8f. Concurrent duplicate key race (ER_DUP_ENTRY / 1062) rolls back and returns 409 Conflict
      simulateStatementFailure = "dup_race";
      const raceDupRes = await handleApiRequest(
        new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            userId: targetCreator,
            amount: 325.5,
            reportMonth: "2026-10",
          }),
        }),
      );
      assert.equal(raceDupRes?.status, 409, "Returns 409 Conflict on UNIQUE constraint race");
      assert.equal(rolledBack, true, "Rolls back transaction on ER_DUP_ENTRY");
      assert.equal(committed, false, "Never commits on duplicate race");
      assert.equal(walletInserts, walletBeforeFail, "Never credits wallet on duplicate race");

      // 8f-2. Other SQLSTATE 23000 integrity errors (errno 1048 NOT NULL, errno 1452 FK) return 500 after rollback
      for (const failureMode of ["not_null_23000", "fk_23000"] as const) {
        const ledgerBefore23000: number = ledgerInserts;
        const walletBefore23000: number = walletInserts;
        simulateStatementFailure = failureMode;
        const integrityRes = await handleApiRequest(
          new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
              userId: targetCreator,
              amount: 325.5,
              reportMonth: "2026-12",
            }),
          }),
        );
        assert.equal(
          integrityRes?.status,
          500,
          `Non-1062 SQLSTATE 23000 error (${failureMode}) must return HTTP 500, not 409`,
        );
        assert.equal(rolledBack, true, `Rolls back transaction on ${failureMode}`);
        assert.equal(committed, false, `Does not commit transaction on ${failureMode}`);
        assert.equal(ledgerInserts, ledgerBefore23000 + 1, "Attempted ledger insert rolled back");
        assert.equal(walletInserts, walletBefore23000, `Never credits wallet on ${failureMode}`);
      }

      // 8f-3. Fail-closed APP_ENV / NODE_ENV matrix with missing ADMOB_APP_ID
      simulateStatementFailure = "none";
      delete process.env["ADMOB_APP_ID"];
      const envMatrix: Array<{
        appEnv: string | undefined;
        nodeEnv: string | undefined;
        expectedProd: boolean;
        label: string;
      }> = [
        {
          appEnv: "test",
          nodeEnv: undefined,
          expectedProd: false,
          label: "APP_ENV=test, NODE_ENV empty",
        },
        {
          appEnv: undefined,
          nodeEnv: "test",
          expectedProd: false,
          label: "APP_ENV empty, NODE_ENV=test",
        },
        {
          appEnv: "development",
          nodeEnv: "test",
          expectedProd: false,
          label: "APP_ENV=development, NODE_ENV=test",
        },
        {
          appEnv: "staging",
          nodeEnv: "test",
          expectedProd: true,
          label: "APP_ENV=staging, NODE_ENV=test",
        },
        {
          appEnv: "unknown",
          nodeEnv: "development",
          expectedProd: true,
          label: "APP_ENV=unknown, NODE_ENV=development",
        },
        { appEnv: undefined, nodeEnv: undefined, expectedProd: true, label: "Both empty" },
        {
          appEnv: "production",
          nodeEnv: "test",
          expectedProd: true,
          label: "APP_ENV=production, NODE_ENV=test",
        },
        {
          appEnv: "development",
          nodeEnv: "production",
          expectedProd: true,
          label: "APP_ENV=development, NODE_ENV=production",
        },
      ];

      for (const tc of envMatrix) {
        assert.equal(
          isFailClosedProductionEnv(tc.appEnv, tc.nodeEnv),
          tc.expectedProd,
          `isFailClosedProductionEnv mismatch for ${tc.label}`,
        );

        if (tc.appEnv !== undefined) process.env["APP_ENV"] = tc.appEnv;
        else delete process.env["APP_ENV"];
        if (tc.nodeEnv !== undefined) process.env["NODE_ENV"] = tc.nodeEnv;
        else delete process.env["NODE_ENV"];

        const connBefore: number = getConnectionCalls;
        const walletBefore: number = walletInserts;
        const envRes = await handleApiRequest(
          new Request("http://localhost:3000/api/admin/record-admob-earning.php", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${adminToken}`,
            },
            body: JSON.stringify({
              userId: targetCreator,
              amount: 120,
              reportMonth: "2026-09",
            }),
          }),
        );
        if (tc.expectedProd) {
          assert.equal(envRes?.status, 500, `${tc.label} must fail closed with HTTP 500`);
          assert.equal(getConnectionCalls, connBefore, `${tc.label} must not open DB transaction`);
          assert.equal(walletInserts, walletBefore, `${tc.label} must not credit wallet`);
        } else {
          assert.equal(envRes?.status, 201, `${tc.label} must allow non-production recording`);
          assert.equal(committed, true, `${tc.label} commits atomic transaction`);
          assert.equal(walletInserts, walletBefore + 1, `${tc.label} credits wallet`);
        }
      }

      // 8f-4. Duplicate-key helper & PHP endpoint parity verification
      assert.equal(
        isMysqlDuplicateKeyError({ code: "ER_DUP_ENTRY", errno: 1062, sqlState: "23000" }),
        true,
      );
      assert.equal(isMysqlDuplicateKeyError({ errno: 1062 }), true);
      assert.equal(
        isMysqlDuplicateKeyError({ code: "ER_BAD_NULL_ERROR", errno: 1048, sqlState: "23000" }),
        false,
      );
      assert.equal(
        isMysqlDuplicateKeyError({
          code: "ER_NO_REFERENCED_ROW_2",
          errno: 1452,
          sqlState: "23000",
        }),
        false,
      );
      assert.equal(isMysqlDuplicateKeyError({ sqlState: "23000" }), false);

      const phpSource = fs.readFileSync(
        path.resolve(process.cwd(), "api/admin/record-admob-earning.php"),
        "utf-8",
      );
      assert.ok(
        phpSource.includes("if ($mysqlErrno === 1062)"),
        "PHP endpoint must classify HTTP 409 strictly on MySQL errno 1062",
      );
      assert.ok(
        !phpSource.includes("$sqlState === '23000'"),
        "PHP endpoint must NOT treat generic SQLSTATE 23000 as duplicate-key 409",
      );
      assert.ok(
        phpSource.includes("count($presentEnvs) === 0") &&
          phpSource.includes("!in_array($v, $nonProdEnvs, true)"),
        "PHP endpoint must enforce fail-closed APP_ENV/NODE_ENV validation across every non-empty value",
      );

      // 8g. Migration files & .env.example verification
      const migration20261108 = fs.readFileSync(
        path.resolve(process.cwd(), "database/migrations/20261108_admob_income_foundation.sql"),
        "utf-8",
      );
      assert.ok(
        migration20261108.includes("`app_id` VARCHAR(100) DEFAULT NULL"),
        "20261108 migration must use DEFAULT NULL for app_id",
      );
      assert.ok(
        !migration20261108.includes("3940256099942544"),
        "20261108 migration must not contain Google test App ID",
      );

      const migration20261113 = fs.readFileSync(
        path.resolve(
          process.cwd(),
          "database/migrations/20261113_admob_statements_remove_test_app_id_default.sql",
        ),
        "utf-8",
      );
      assert.ok(migration20261113.includes("INFORMATION_SCHEMA.TABLES"));
      assert.ok(migration20261113.includes("INFORMATION_SCHEMA.COLUMNS"));
      assert.ok(migration20261113.includes("MODIFY COLUMN `app_id` VARCHAR(100) DEFAULT NULL"));

      const envExample = fs.readFileSync(path.resolve(process.cwd(), ".env.example"), "utf-8");
      assert.ok(
        /^ADMOB_APP_ID=$/m.test(envExample),
        ".env.example must define empty ADMOB_APP_ID=",
      );
    } finally {
      setMysqlPoolForTesting(null);
      if (origHost !== undefined) process.env["DB_HOST"] = origHost;
      else delete process.env["DB_HOST"];
      if (origName !== undefined) process.env["DB_NAME"] = origName;
      else delete process.env["DB_NAME"];
      if (origUser !== undefined) process.env["DB_USER"] = origUser;
      else delete process.env["DB_USER"];
      if (origNodeEnv !== undefined) process.env["NODE_ENV"] = origNodeEnv;
      else delete process.env["NODE_ENV"];
      if (origAppEnv !== undefined) process.env["APP_ENV"] = origAppEnv;
      else delete process.env["APP_ENV"];
      if (origAdMobAppId !== undefined) process.env["ADMOB_APP_ID"] = origAdMobAppId;
      else delete process.env["ADMOB_APP_ID"];
    }
  });

  it("9. Android & Client AdMob Configuration: Dev Test IDs, Production Fail-Closed, and Runbook", () => {
    // 9a. Development/test mode preserves official Google test IDs and enables isTesting
    const devConfig = resolveAdMobConfig({
      MODE: "development",
      DEV: true,
      PROD: false,
    });
    assert.equal(devConfig.valid, true);
    assert.equal(devConfig.isProduction, false);
    assert.equal(devConfig.isTesting, true);
    assert.equal(devConfig.appId, ADMOB_TEST_IDS.APP_ID);
    assert.equal(devConfig.bannerAdUnitId, ADMOB_TEST_IDS.BANNER);
    assert.equal(devConfig.interstitialAdUnitId, ADMOB_TEST_IDS.INTERSTITIAL);
    assert.equal(devConfig.rewardedAdUnitId, ADMOB_TEST_IDS.REWARDED);

    const testModeConfig = resolveAdMobConfig({ NODE_ENV: "test" });
    assert.equal(testModeConfig.valid, true);
    assert.equal(testModeConfig.isTesting, true);

    // 9b. Production fails when real AdMob IDs are missing (never falls back to test IDs)
    const missingProdConfig = resolveAdMobConfig({
      MODE: "production",
      PROD: true,
      DEV: false,
    });
    assert.equal(missingProdConfig.valid, false);
    assert.equal(missingProdConfig.isProduction, true);
    assert.equal(missingProdConfig.isTesting, false);
    assert.equal(missingProdConfig.appId, "");
    assert.equal(missingProdConfig.bannerAdUnitId, "");
    assert.throws(() => requireAdMobConfig({ MODE: "production", PROD: true }));

    // Ambiguous / empty env also fails closed
    const emptyEnvConfig = resolveAdMobConfig({});
    assert.equal(emptyEnvConfig.isProduction, true);
    assert.equal(emptyEnvConfig.valid, false);
    assert.equal(emptyEnvConfig.isTesting, false);

    // 9c. Production rejects Google test App ID and test ad unit IDs
    const testAppInProd = resolveAdMobConfig({
      MODE: "production",
      PROD: true,
      VITE_ADMOB_APP_ID: ADMOB_TEST_IDS.APP_ID,
      VITE_ADMOB_BANNER_AD_UNIT_ID: "ca-app-pub-1234567890123456/1111111111",
      VITE_ADMOB_INTERSTITIAL_AD_UNIT_ID: "ca-app-pub-1234567890123456/2222222222",
      VITE_ADMOB_REWARDED_AD_UNIT_ID: "ca-app-pub-1234567890123456/3333333333",
    });
    assert.equal(testAppInProd.valid, false);
    assert.equal(testAppInProd.isTesting, false);
    assert.ok(testAppInProd.error?.includes("test AdMob ID"));

    const testBannerInProd = resolveAdMobConfig({
      MODE: "production",
      PROD: true,
      VITE_ADMOB_APP_ID: "ca-app-pub-1234567890123456~1234567890",
      VITE_ADMOB_BANNER_AD_UNIT_ID: ADMOB_TEST_IDS.BANNER,
      VITE_ADMOB_INTERSTITIAL_AD_UNIT_ID: "ca-app-pub-1234567890123456/2222222222",
      VITE_ADMOB_REWARDED_AD_UNIT_ID: "ca-app-pub-1234567890123456/3333333333",
    });
    assert.equal(testBannerInProd.valid, false);
    assert.ok(testBannerInProd.error?.includes("test AdMob ID"));

    // 9d. Valid real production IDs pass with isTesting disabled
    const validProd = requireAdMobConfig({
      MODE: "production",
      PROD: true,
      VITE_ADMOB_APP_ID: "ca-app-pub-1234567890123456~1234567890",
      VITE_ADMOB_BANNER_AD_UNIT_ID: "ca-app-pub-1234567890123456/1111111111",
      VITE_ADMOB_INTERSTITIAL_AD_UNIT_ID: "ca-app-pub-1234567890123456/2222222222",
      VITE_ADMOB_REWARDED_AD_UNIT_ID: "ca-app-pub-1234567890123456/3333333333",
    });
    assert.equal(validProd.valid, true);
    assert.equal(validProd.isProduction, true);
    assert.equal(validProd.isTesting, false);

    // 9e. AndroidManifest.xml, build.gradle, capacitor.config.ts, and Migration Runbook verification
    const manifest = fs.readFileSync(
      path.resolve(process.cwd(), "android/app/src/main/AndroidManifest.xml"),
      "utf-8",
    );
    assert.ok(
      manifest.includes("${admobApplicationId}"),
      "AndroidManifest.xml must use Gradle placeholder ${admobApplicationId}",
    );
    assert.ok(
      !manifest.includes("3940256099942544"),
      "AndroidManifest.xml must not hardcode Google test App ID",
    );

    const buildGradle = fs.readFileSync(
      path.resolve(process.cwd(), "android/app/build.gradle"),
      "utf-8",
    );
    assert.ok(buildGradle.includes("admobApplicationId"), "build.gradle must inject placeholder");
    assert.ok(
      buildGradle.includes("GradleException"),
      "build.gradle must fail release builds missing valid ADMOB_APP_ID",
    );

    const capConfig = fs.readFileSync(path.resolve(process.cwd(), "capacitor.config.ts"), "utf-8");
    assert.ok(
      !capConfig.includes("initializeForTesting: true"),
      "capacitor.config.ts must not unconditionally hardcode initializeForTesting: true",
    );

    const runbook = fs.readFileSync(
      path.resolve(process.cwd(), "database/ADMOB_MIGRATION_RUNBOOK.md"),
      "utf-8",
    );
    assert.ok(runbook.includes("20261108_admob_income_foundation.sql"));
    assert.ok(runbook.includes("20261112_wallet_balances_admob_income.sql"));
    assert.ok(runbook.includes("20261113_admob_statements_remove_test_app_id_default.sql"));
    assert.ok(runbook.includes("mysqldump"));
  });
});
