import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleApiRequest, resetInMemoryStore } from "./api-handler";
import { setTestPersistentDataDir } from "./payments";

describe("FaceTube Admin KYC Backend: RBAC, Review, Audit & Self-Verification Prevention Tests", () => {
  let testDataDir = "";
  let STORE_PATH = "";
  let adminToken = "";
  let regularUserToken = "";

  const adminEmail = "admin@facetube.com";
  const regularUserEmail = "alex@facetube.com";
  const testCreatorId = "FT_TEST_CREATOR_99";

  before(async () => {
    testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-admin-kyc-test-"));
    STORE_PATH = path.join(testDataDir, "facetube_store.json");
    setTestPersistentDataDir(testDataDir);
    resetInMemoryStore();

    // Authenticate Admin User (FT102857)
    const adminLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: adminEmail, password: "password" }),
    });
    const adminRes = await handleApiRequest(adminLoginReq);
    assert.ok(adminRes);
    assert.equal(adminRes.status, 200);
    const adminBody = await adminRes.json();
    assert.ok(adminBody.token);
    adminToken = adminBody.token;

    // Authenticate Regular User (FT483921)
    const userLoginReq = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: regularUserEmail, password: "password123" }),
    });
    const userRes = await handleApiRequest(userLoginReq);
    assert.ok(userRes);
    assert.equal(userRes.status, 200);
    const userBody = await userRes.json();
    assert.ok(userBody.token);
    regularUserToken = userBody.token;
  });

  after(() => {
    setTestPersistentDataDir(null);
    resetInMemoryStore();
    if (testDataDir) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // 1. Prevention of User Self-Verification
  // ==========================================================================
  describe("1. Prevention of User Self-Verification", () => {
    it("Enforces 'Submitted' status when user attempts to submit Personal KYC with 'Verified'", async () => {
      const payload = {
        userId: testCreatorId,
        fullName: "Test Creator Name",
        mobile: "+91 9876543210",
        dob: "1995-04-12",
        address: "123 Film City Road",
        city: "Mumbai",
        state: "Maharashtra",
        pincode: "400001",
        nomineeName: "Test Nominee",
        nomineeRelation: "Sibling",
        nomineeMobile: "+91 9876543211",
        status: "Verified", // Malicious / self-verification attempt!
      };

      const req = new Request("http://localhost:3000/api/kyc/personal", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${regularUserToken}`,
        },
        body: JSON.stringify(payload),
      });

      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(
        data.kyc.status,
        "Submitted",
        "Personal KYC status MUST be 'Submitted', never self-verified",
      );

      // Verify persistence in store
      const store = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
      assert.equal(store.personalKyc[testCreatorId].status, "Submitted");
    });

    it("Enforces 'Submitted' status when user attempts to submit Bank KYC with 'Verified'", async () => {
      const payload = {
        userId: testCreatorId,
        accountHolderName: "Test Creator Name",
        bankName: "State Bank of India",
        accountNumber: "123456789012",
        ifscCode: "SBIN0001234",
        branchName: "Nariman Point",
        accountType: "Saving",
        upiId: "testcreator@sbi",
        status: "Verified", // Malicious / self-verification attempt!
      };

      const req = new Request("http://localhost:3000/api/kyc/bank", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${regularUserToken}`,
        },
        body: JSON.stringify(payload),
      });

      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(
        data.kyc.status,
        "Submitted",
        "Bank KYC status MUST be 'Submitted', never self-verified",
      );

      // Verify persistence in store
      const store = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
      assert.equal(store.bankKyc[testCreatorId].status, "Submitted");
    });
  });

  // ==========================================================================
  // 2. Admin RBAC & Authorization
  // ==========================================================================
  describe("2. Admin RBAC & Authorization Enforcement", () => {
    it("Rejects unauthenticated request to /api/admin/kyc/list with HTTP 401", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc/list", {
        method: "GET",
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 401);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.match(body.error, /Authentication required/i);
    });

    it("Rejects non-admin user request to /api/admin/kyc/list with HTTP 403", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc/list", {
        method: "GET",
        headers: { Authorization: `Bearer ${regularUserToken}` },
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.match(body.error, /Admin authorization required/i);
    });

    it("Rejects non-admin user request to /api/admin/kyc-list shim with HTTP 403", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc-list", {
        method: "GET",
        headers: { Authorization: `Bearer ${regularUserToken}` },
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 403);
    });

    it("Rejects non-admin user review attempt with HTTP 403", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc/review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${regularUserToken}`,
        },
        body: JSON.stringify({
          type: "personal",
          userId: testCreatorId,
          decision: "approved",
        }),
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 403);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.match(body.error, /Admin authorization required/i);
    });

    it("Rejects non-admin user audit log access with HTTP 403", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc/audit", {
        method: "GET",
        headers: { Authorization: `Bearer ${regularUserToken}` },
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 403);
    });
  });

  // ==========================================================================
  // 3. Admin Listing & KPI Stats
  // ==========================================================================
  describe("3. Admin KYC Listing, Filtering & Statistics", () => {
    it("Allows admin to list submissions and includes calculated stats", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc/list?status=all", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.success, true);
      assert.ok(data.stats);
      assert.equal(typeof data.stats.totalPending, "number");
      assert.equal(typeof data.stats.pendingPersonal, "number");
      assert.equal(typeof data.stats.pendingBank, "number");
      assert.equal(typeof data.stats.totalVerified, "number");
      assert.equal(typeof data.stats.totalRejected, "number");
      assert.ok(Array.isArray(data.submissions));
      assert.ok(data.pagination);
    });

    it("Filters submissions by type (type=personal)", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc/list?type=personal&status=all", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.ok(data.submissions.length > 0);
      for (const item of data.submissions) {
        assert.equal(item.type, "personal");
      }
    });

    it("Filters submissions by type (type=bank)", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc/list?type=bank&status=all", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.ok(data.submissions.length > 0);
      for (const item of data.submissions) {
        assert.equal(item.type, "bank");
      }
    });

    it("Supports filtering by specific creator userId", async () => {
      const req = new Request(
        `http://localhost:3000/api/admin/kyc/list?userId=${testCreatorId}&status=all`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${adminToken}` },
        },
      );
      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.ok(data.submissions.length >= 1);
      for (const item of data.submissions) {
        assert.equal(item.userId.toUpperCase(), testCreatorId);
      }
    });

    it("Supports compatibility wrapper /api/admin/kyc-list", async () => {
      const req = new Request(
        `http://localhost:3000/api/admin/kyc-list?userId=${testCreatorId}&status=all`,
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
    });
  });

  // ==========================================================================
  // 4. Admin Review: Approval & Audit Trail
  // ==========================================================================
  describe("4. Admin Review: Approval Workflow & Audit Trail", () => {
    it("Allows admin to approve Personal KYC submission and logs audit entry", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc/review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          type: "personal",
          userId: testCreatorId,
          decision: "approved",
          adminNote: "Government ID verified and valid.",
        }),
      });

      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.success, true);
      assert.equal(data.decision, "approved");
      assert.equal(data.status, "Verified");
      assert.ok(data.audit);
      assert.equal(data.audit.action, "approved");
      assert.equal(data.audit.previousStatus, "Submitted");
      assert.equal(data.audit.newStatus, "Verified");
      assert.equal(data.audit.adminNote, "Government ID verified and valid.");

      // Check persistence
      const store = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
      assert.equal(store.personalKyc[testCreatorId].status, "Verified");
      assert.equal(store.personalKyc[testCreatorId].reviewedBy, "FT102857");
    });

    it("Blocks re-reviewing an already Verified KYC submission with HTTP 400", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc/review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          type: "personal",
          userId: testCreatorId,
          decision: "approved",
        }),
      });

      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /Only KYC submissions with status 'Submitted' can be reviewed/i);
    });
  });

  // ==========================================================================
  // 5. Admin Review: Rejection & Mandatory Reason
  // ==========================================================================
  describe("5. Admin Review: Rejection Workflow & Validation", () => {
    it("Rejects rejection decision without mandatory rejectionReason with HTTP 400", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc/review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          type: "bank",
          userId: testCreatorId,
          decision: "rejected",
          // missing rejectionReason!
        }),
      });

      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.success, false);
      assert.match(data.error, /Rejection reason is required/i);
    });

    it("Rejects review with invalid KYC type with HTTP 400", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc/review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          type: "invalid_type",
          userId: testCreatorId,
          decision: "approved",
        }),
      });

      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /Invalid or missing KYC type/i);
    });

    it("Allows admin to reject Bank KYC submission with valid reason", async () => {
      const reason = "Bank statement blurred and account holder name mismatch.";
      const req = new Request("http://localhost:3000/api/admin/kyc/review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          type: "bank",
          userId: testCreatorId,
          decision: "rejected",
          rejectionReason: reason,
          adminNote: "Flagged during verification audit.",
        }),
      });

      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.success, true);
      assert.equal(data.decision, "rejected");
      assert.equal(data.status, "Rejected");
      assert.equal(data.audit.rejectionReason, reason);

      // Check persistence
      const store = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
      assert.equal(store.bankKyc[testCreatorId].status, "Rejected");
      assert.equal(store.bankKyc[testCreatorId].rejectionReason, reason);
    });
  });

  // ==========================================================================
  // 6. Audit Trail History API
  // ==========================================================================
  describe("6. Audit Trail History API (/api/admin/kyc/audit)", () => {
    it("Retrieves recorded audit history entries in reverse chronological order", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc/audit", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();

      assert.equal(data.success, true);
      assert.ok(Array.isArray(data.auditLogs));
      assert.ok(data.auditLogs.length >= 2, "Expected at least 2 audit entries from above tests");

      // Verify the latest action is at the top
      assert.equal(data.auditLogs[0].userId, testCreatorId);
      assert.equal(data.auditLogs[0].action, "rejected");
      assert.equal(data.auditLogs[1].userId, testCreatorId);
      assert.equal(data.auditLogs[1].action, "approved");
    });

    it("Filters audit history by action (action=approved)", async () => {
      const req = new Request(
        `http://localhost:3000/api/admin/kyc/audit?userId=${testCreatorId}&action=approved`,
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
      assert.ok(data.auditLogs.length >= 1);
      for (const log of data.auditLogs) {
        assert.equal(log.action, "approved");
      }
    });

    it("Supports compatibility wrapper /api/admin/kyc-audit", async () => {
      const req = new Request("http://localhost:3000/api/admin/kyc-audit", {
        method: "GET",
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      const res = await handleApiRequest(req);
      assert.ok(res);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.ok(Array.isArray(data.auditLogs));
    });
  });
});
