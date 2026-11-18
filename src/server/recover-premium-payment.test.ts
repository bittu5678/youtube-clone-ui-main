import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pool, PoolConnection } from "mysql2/promise";
import {
  handleAdminRecoverPremiumPayment,
  type RecoveryAuthUser,
  type RecoveryMediaDirs,
} from "./premium-recovery.ts";

interface FakeUserRow {
  id: string;
  user_id: string;
  name: string;
  role: "admin" | "user";
  referral_code: string | null;
  created_at: string;
}

interface FakeVideoRow {
  id: string;
  user_id: string;
  creator_name: string;
  title: string;
  description: string;
  video_url: string;
  thumbnail_url: string;
  video_type: string;
  content_type: string;
  category: string;
  duration: string;
  views: number;
  likes: number;
  payment_status: string;
  payment_id: string | null;
  payment_amount: number;
  is_promoted: number;
  ad_earnings?: number;
  is_blocked?: number;
  created_at: string;
}

interface FakePaymentOrderRow {
  order_id: string;
  user_id: string;
  user_name: string;
  video_id: string | null;
  purpose: string;
  plan_id: string | null;
  content_type: string | null;
  amount: number;
  currency: string;
  status: string;
  payment_id: string | null;
}

interface FakePaymentTxRow {
  id: number;
  order_id: string | null;
  payment_id: string;
  user_id: string;
  user_name: string;
  video_id: string | null;
  purpose: string;
  amount: number;
  tx_number: number;
  is_special: number;
  special_tag: string;
  referral_commission: number;
  admin_allocation: number;
  global_pool_allocation: number;
}

interface FakePremiumTxRow {
  id: string;
  tx_number: number;
  payment_id: string;
  order_id: string | null;
  video_id: string;
  user_id: string;
  referrer_id: string | null;
  amount: number;
  transaction_type: string;
  is_special: number;
  special_tag: string;
  referral_commission: number;
  admin_allocation: number;
  global_pool_allocation: number;
}

interface FakeLedgerRow {
  id: string;
  transaction_id: string;
  user_id: string;
  source_user_id: string | null;
  source_user_name: string | null;
  video_id: string | null;
  income_type: string;
  amount: number;
  status: string;
  special_tag: string | null;
  description: string;
}

interface FakeWalletRow {
  user_id: string;
  balance: number;
  total_earned: number;
  total_withdrawn: number;
  referral_income: number;
  global_income: number;
  adsense_income: number;
  affiliate_income: number;
}

interface FakeDbState {
  users: FakeUserRow[];
  uploaded_videos: FakeVideoRow[];
  payment_orders: FakePaymentOrderRow[];
  payment_transactions: FakePaymentTxRow[];
  premium_transactions: FakePremiumTxRow[];
  income_ledger: FakeLedgerRow[];
  wallet_balances: FakeWalletRow[];
}

class TransactionalFakeMysqlPool {
  public state: FakeDbState;
  public beginCount = 0;
  public commitCount = 0;
  public rollbackCount = 0;
  public writeQueryCount = 0;
  public lockHistory: string[] = [];
  public failOnPremiumTxInsertForPaymentId: string | null = null;
  public failOnGetLock = false;
  private lockHeld = false;
  private nextPtAutoId = 100;

  constructor(initial: Partial<FakeDbState> = {}) {
    this.state = {
      users: initial.users ?? [],
      uploaded_videos: initial.uploaded_videos ?? [],
      payment_orders: initial.payment_orders ?? [],
      payment_transactions: initial.payment_transactions ?? [],
      premium_transactions: initial.premium_transactions ?? [],
      income_ledger: initial.income_ledger ?? [],
      wallet_balances: initial.wallet_balances ?? [],
    };
  }

  private snapshot(): FakeDbState {
    return JSON.parse(JSON.stringify(this.state)) as FakeDbState;
  }

  async query(sql: string, params: unknown[] = []): Promise<[unknown, unknown]> {
    return this.executeSql(sql, params, null);
  }

  async getConnection(): Promise<PoolConnection> {
    let txBackup: FakeDbState | null = null;

    const conn = {
      beginTransaction: async () => {
        this.beginCount += 1;
        txBackup = this.snapshot();
      },
      commit: async () => {
        this.commitCount += 1;
        txBackup = null;
      },
      rollback: async () => {
        this.rollbackCount += 1;
        if (txBackup) {
          this.state = txBackup;
          txBackup = null;
        }
      },
      query: async (sql: string, params: unknown[] = []) => {
        return this.executeSql(sql, params, txBackup);
      },
      release: () => {
        if (txBackup) {
          this.state = txBackup;
          txBackup = null;
        }
      },
    };
    return conn as unknown as PoolConnection;
  }

  private async executeSql(
    rawSql: string,
    params: unknown[],
    _txBackup: FakeDbState | null,
  ): Promise<[unknown, unknown]> {
    const sql = rawSql.replace(/\s+/g, " ").trim();

    if (sql.startsWith("SELECT GET_LOCK(")) {
      const name = String(params[0] ?? "");
      this.lockHistory.push(`acquire:${name}`);
      if (this.failOnGetLock || this.lockHeld) {
        return [[{ acquired: 0 }], []];
      }
      this.lockHeld = true;
      return [[{ acquired: 1 }], []];
    }

    if (sql.startsWith("DO RELEASE_LOCK(")) {
      const name = String(params[0] ?? "");
      this.lockHistory.push(`release:${name}`);
      this.lockHeld = false;
      return [[], []];
    }

    if (sql.includes("FROM INFORMATION_SCHEMA.COLUMNS")) {
      return [[{ COLUMN_NAME: "ad_earnings" }, { COLUMN_NAME: "is_blocked" }], []];
    }

    if (sql.includes("FROM users WHERE UPPER(user_id) = UPPER(?)")) {
      const uid = String(params[0] ?? "").toUpperCase();
      const match = this.state.users.find((u) => u.user_id.toUpperCase() === uid);
      return [match ? [{ ...match }] : [], []];
    }

    if (
      sql.includes(
        "FROM users WHERE (UPPER(user_id) = UPPER(?) OR UPPER(referral_code) = UPPER(?))",
      )
    ) {
      const ref = String(params[0] ?? "").toUpperCase();
      const selfUid = String(params[2] ?? "").toUpperCase();
      const match = this.state.users.find(
        (u) =>
          (u.user_id.toUpperCase() === ref || (u.referral_code ?? "").toUpperCase() === ref) &&
          u.user_id.toUpperCase() !== selfUid,
      );
      return [match ? [{ user_id: match.user_id }] : [], []];
    }

    if (sql.includes("SELECT user_id FROM users WHERE role = 'admin'")) {
      const admins = this.state.users
        .filter((u) => u.role === "admin")
        .sort((a, b) => a.created_at.localeCompare(b.created_at));
      return [admins[0] ? [{ user_id: admins[0].user_id }] : [], []];
    }

    if (
      sql.includes("FROM uploaded_videos WHERE (video_type = 'premium' OR payment_status = 'paid')")
    ) {
      const excludedUid = String(params[0] ?? "").toUpperCase();
      const rows = this.state.uploaded_videos
        .filter(
          (v) =>
            (v.video_type === "premium" || v.payment_status === "paid") &&
            v.user_id.toUpperCase() !== excludedUid &&
            (v.is_blocked === undefined || v.is_blocked === 0),
        )
        .sort((a, b) => {
          const cmp = a.created_at.localeCompare(b.created_at);
          return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
        })
        .map((v) => ({
          video_id: v.id,
          user_id: v.user_id,
          ad_earnings: v.ad_earnings ?? 0,
        }));
      return [rows, []];
    }

    if (sql.includes("FROM payment_orders WHERE order_id = ?")) {
      const oid = String(params[0] ?? "");
      const row = this.state.payment_orders.find((o) => o.order_id === oid);
      return [row ? [{ ...row }] : [], []];
    }

    if (sql.includes("FROM payment_transactions WHERE payment_id = ? OR order_id = ?")) {
      const pid = String(params[0] ?? "");
      const oid = String(params[1] ?? "");
      const row = this.state.payment_transactions.find(
        (t) => t.payment_id === pid || t.order_id === oid,
      );
      return [row ? [{ ...row }] : [], []];
    }

    if (sql.includes("FROM premium_transactions WHERE payment_id = ? OR order_id = ?")) {
      const pid = String(params[0] ?? "");
      const oid = String(params[1] ?? "");
      const row = this.state.premium_transactions.find(
        (t) => t.payment_id === pid || t.order_id === oid,
      );
      return [row ? [{ ...row }] : [], []];
    }

    if (sql.includes("FROM uploaded_videos WHERE id = ? OR payment_id = ?")) {
      const vid = String(params[0] ?? "");
      const pid = String(params[1] ?? "");
      const row = this.state.uploaded_videos.find((v) => v.id === vid || v.payment_id === pid);
      return [row ? [{ ...row }] : [], []];
    }

    if (
      sql.includes("FROM income_ledger WHERE transaction_id IN (?, ?) OR transaction_id LIKE ?")
    ) {
      const refTx = String(params[0] ?? "");
      const admTx = String(params[1] ?? "");
      const glbPrefix = String(params[2] ?? "").replace(/%$/, "");
      const row = this.state.income_ledger.find(
        (l) =>
          l.transaction_id === refTx ||
          l.transaction_id === admTx ||
          l.transaction_id.startsWith(glbPrefix),
      );
      return [row ? [{ transaction_id: row.transaction_id }] : [], []];
    }

    if (
      sql.includes(
        "SELECT COALESCE(MAX(tx_number), 0) AS max_tx, COUNT(*) AS total_tx FROM payment_transactions",
      )
    ) {
      const premRows = this.state.payment_transactions.filter(
        (t) => t.purpose === "premium_video_upload",
      );
      const maxTx = premRows.reduce((m, r) => Math.max(m, r.tx_number), 0);
      return [[{ max_tx: maxTx, total_tx: premRows.length }], []];
    }

    if (sql.includes("SELECT COALESCE(MAX(tx_number), 0) AS max_pt_tx FROM premium_transactions")) {
      const maxTx = this.state.premium_transactions.reduce((m, r) => Math.max(m, r.tx_number), 0);
      return [[{ max_pt_tx: maxTx }], []];
    }

    if (
      sql.includes(
        "FROM payment_transactions WHERE tx_number = ? AND purpose = 'premium_video_upload'",
      )
    ) {
      const num = Number(params[0] ?? 0);
      const row = this.state.payment_transactions.find(
        (t) => t.tx_number === num && t.purpose === "premium_video_upload",
      );
      return [row ? [{ id: row.id }] : [], []];
    }

    if (sql.includes("FROM premium_transactions WHERE tx_number = ?")) {
      const num = Number(params[0] ?? 0);
      const row = this.state.premium_transactions.find((t) => t.tx_number === num);
      return [row ? [{ id: row.id }] : [], []];
    }

    // Write operations
    if (sql.startsWith("INSERT INTO payment_transactions")) {
      this.writeQueryCount += 1;
      const paymentId = String(params[1] ?? "");
      if (this.state.payment_transactions.some((r) => r.payment_id === paymentId)) {
        const dupErr = Object.assign(
          new Error(`Duplicate entry '${paymentId}' for key 'uniq_pt_payment_id'`),
          {
            code: "ER_DUP_ENTRY",
            errno: 1062,
          },
        );
        throw dupErr;
      }
      this.nextPtAutoId += 1;
      this.state.payment_transactions.push({
        id: this.nextPtAutoId,
        order_id: params[0] ? String(params[0]) : null,
        payment_id: paymentId,
        user_id: String(params[2] ?? ""),
        user_name: String(params[3] ?? ""),
        video_id: params[4] ? String(params[4]) : null,
        purpose: "premium_video_upload",
        amount: Number(params[5] ?? 6),
        tx_number: Number(params[6] ?? 0),
        is_special: Number(params[7] ?? 0),
        special_tag: String(params[8] ?? "NORMAL_PREMIUM"),
        referral_commission: Number(params[9] ?? 0),
        admin_allocation: Number(params[10] ?? 0),
        global_pool_allocation: Number(params[11] ?? 0),
      });
      return [{ affectedRows: 1 }, []];
    }

    if (sql.startsWith("INSERT INTO premium_transactions")) {
      this.writeQueryCount += 1;
      const paymentId = String(params[2] ?? "");
      const txNumber = Number(params[1] ?? 0);
      if (
        this.failOnPremiumTxInsertForPaymentId &&
        this.failOnPremiumTxInsertForPaymentId === paymentId
      ) {
        throw new Error(`Simulated SQL failure inserting premium_transactions for ${paymentId}`);
      }
      if (this.state.premium_transactions.some((r) => r.tx_number === txNumber)) {
        throw Object.assign(
          new Error(`Duplicate entry '${txNumber}' for key 'uniq_premium_tx_number'`),
          {
            code: "ER_DUP_ENTRY",
            errno: 1062,
          },
        );
      }
      if (this.state.premium_transactions.some((r) => r.payment_id === paymentId)) {
        throw Object.assign(
          new Error(`Duplicate entry '${paymentId}' for key 'uniq_premium_tx_payment_id'`),
          {
            code: "ER_DUP_ENTRY",
            errno: 1062,
          },
        );
      }
      this.state.premium_transactions.push({
        id: String(params[0] ?? ""),
        tx_number: txNumber,
        payment_id: paymentId,
        order_id: params[3] ? String(params[3]) : null,
        video_id: String(params[4] ?? ""),
        user_id: String(params[5] ?? ""),
        referrer_id: params[6] ? String(params[6]) : null,
        amount: Number(params[7] ?? 6),
        transaction_type: "premium_upload",
        is_special: Number(params[8] ?? 0),
        special_tag: String(params[9] ?? "NORMAL_PREMIUM"),
        referral_commission: Number(params[10] ?? 0),
        admin_allocation: Number(params[11] ?? 0),
        global_pool_allocation: Number(params[12] ?? 0),
      });
      return [{ affectedRows: 1 }, []];
    }

    if (sql.startsWith("INSERT INTO income_ledger")) {
      this.writeQueryCount += 1;
      const txId = String(params[1] ?? "");
      if (this.state.income_ledger.some((l) => l.transaction_id === txId)) {
        throw Object.assign(
          new Error(`Duplicate entry '${txId}' for key 'uniq_income_ledger_tx_id'`),
          {
            code: "ER_DUP_ENTRY",
            errno: 1062,
          },
        );
      }
      let incomeType = "referral_income";
      let amount = 1.0;
      let specialTag: string | null = null;
      let description = "";

      if (sql.includes("'referral_income', 1.0000")) {
        incomeType = "referral_income";
        amount = 1.0;
        specialTag = params[6] ? String(params[6]) : null;
        description = String(params[7] ?? "");
      } else if (sql.includes("'admin_allocation'")) {
        incomeType = "admin_allocation";
        amount = Number(params[6] ?? 0);
        specialTag = params[7] ? String(params[7]) : null;
        description = String(params[8] ?? "");
      } else {
        incomeType = "global_income";
        amount = Number(params[6] ?? 0);
        specialTag = params[7] ? String(params[7]) : null;
        description = String(params[8] ?? "");
      }

      this.state.income_ledger.push({
        id: String(params[0] ?? ""),
        transaction_id: txId,
        user_id: String(params[2] ?? ""),
        source_user_id: params[3] ? String(params[3]) : null,
        source_user_name: params[4] ? String(params[4]) : null,
        video_id: params[5] ? String(params[5]) : null,
        income_type: incomeType,
        amount,
        status: "settled",
        special_tag: specialTag,
        description,
      });
      return [{ affectedRows: 1 }, []];
    }

    if (sql.startsWith("INSERT INTO wallet_balances")) {
      this.writeQueryCount += 1;
      const userId = String(params[0] ?? "");
      const existing = this.state.wallet_balances.find(
        (w) => w.user_id.toUpperCase() === userId.toUpperCase(),
      );

      let addBalance = 0;
      let addRef = 0;
      let addGlobal = 0;
      if (sql.includes("VALUES (?, 1.00, 1.00")) {
        addBalance = 1.0;
        addRef = 1.0;
      } else if (sql.includes("global_income = global_income + VALUES(global_income)")) {
        addBalance = Number(params[1] ?? 0);
        addGlobal = Number(params[3] ?? 0);
      } else {
        addBalance = Number(params[1] ?? 0);
      }

      if (existing) {
        existing.balance = Math.round((existing.balance + addBalance) * 100) / 100;
        existing.total_earned = Math.round((existing.total_earned + addBalance) * 100) / 100;
        existing.referral_income = Math.round((existing.referral_income + addRef) * 100) / 100;
        existing.global_income = Math.round((existing.global_income + addGlobal) * 100) / 100;
      } else {
        this.state.wallet_balances.push({
          user_id: userId,
          balance: Math.round(addBalance * 100) / 100,
          total_earned: Math.round(addBalance * 100) / 100,
          total_withdrawn: 0,
          referral_income: Math.round(addRef * 100) / 100,
          global_income: Math.round(addGlobal * 100) / 100,
          adsense_income: 0,
          affiliate_income: 0,
        });
      }
      return [{ affectedRows: 1 }, []];
    }

    if (sql.startsWith("INSERT INTO uploaded_videos")) {
      this.writeQueryCount += 1;
      const id = String(params[0] ?? "");
      if (this.state.uploaded_videos.some((v) => v.id === id)) {
        throw Object.assign(new Error(`Duplicate entry '${id}' for key 'PRIMARY'`), {
          code: "ER_DUP_ENTRY",
          errno: 1062,
        });
      }
      this.state.uploaded_videos.push({
        id,
        user_id: String(params[1] ?? ""),
        creator_name: String(params[2] ?? ""),
        title: String(params[3] ?? ""),
        description: String(params[4] ?? ""),
        video_url: String(params[5] ?? ""),
        thumbnail_url: String(params[6] ?? ""),
        video_type: "premium",
        content_type: String(params[7] ?? "long"),
        category: String(params[8] ?? ""),
        duration: String(params[9] ?? "0:00"),
        views: 0,
        likes: 0,
        payment_status: "paid",
        payment_id: String(params[10] ?? ""),
        payment_amount: Number(params[11] ?? 6),
        is_promoted: 0,
        ad_earnings: 0,
        is_blocked: 0,
        created_at: new Date().toISOString(),
      });
      return [{ affectedRows: 1 }, []];
    }

    if (sql.startsWith("UPDATE payment_orders SET status = 'paid'")) {
      this.writeQueryCount += 1;
      const paymentId = String(params[0] ?? "");
      const orderId = String(params[1] ?? "");
      const row = this.state.payment_orders.find((o) => o.order_id === orderId);
      if (row) {
        row.status = "paid";
        row.payment_id = paymentId;
      }
      return [{ affectedRows: row ? 1 : 0 }, []];
    }

    if (sql.startsWith("INSERT INTO payment_orders")) {
      this.writeQueryCount += 1;
      const orderId = String(params[0] ?? "");
      if (this.state.payment_orders.some((o) => o.order_id === orderId)) {
        throw Object.assign(new Error(`Duplicate entry '${orderId}' for key 'uniq_po_order_id'`), {
          code: "ER_DUP_ENTRY",
          errno: 1062,
        });
      }
      this.state.payment_orders.push({
        order_id: orderId,
        user_id: String(params[1] ?? ""),
        user_name: String(params[2] ?? ""),
        video_id: params[3] ? String(params[3]) : null,
        purpose: "premium_video_upload",
        plan_id: null,
        content_type: String(params[4] ?? "long"),
        amount: Number(params[5] ?? 6),
        currency: "INR",
        status: "paid",
        payment_id: String(params[6] ?? ""),
      });
      return [{ affectedRows: 1 }, []];
    }

    throw new Error(`Unhandled SQL in FakePool: ${sql}`);
  }
}

const ADMIN_USER: RecoveryAuthUser = {
  id: "a0000000-0000-0000-0000-000000000001",
  user_id: "FT102857",
  name: "FaceTube Administrator",
  role: "admin",
};

const CUSTOMER_USER: RecoveryAuthUser = {
  id: "8baded68-1af2-49aa-bb93-c45e7815776b",
  user_id: "FT308128",
  name: "Khushnuma khatoon",
  role: "user",
};

const LONG_ITEM = {
  userId: "FT308128",
  userUuid: "8baded68-1af2-49aa-bb93-c45e7815776b",
  paymentId: "pay_U13qWSXKobAy1G",
  orderId: "order_U13qMEFDcwUk9g",
  videoId: "vid-1794878873383-uhiv",
  contentType: "long",
  videoFilename: "vid_1794878873_106d8ef1435a.mp4",
  thumbnailFilename: "img_1794878874_05627e.jpg",
  title: "सौरमंडल के 8 ग्रह और उनकी रोचक विशेषताएँ",
  category: "Education / Science",
  description: "आइए जानते हैं सौरमंडल के 8 ग्रहों के बारे में और उनकी खास विशेषताओं को समझते हैं।",
  duration: "08:42",
};

const SHORT_ITEM = {
  userId: "FT308128",
  userUuid: "8baded68-1af2-49aa-bb93-c45e7815776b",
  paymentId: "pay_U1FzvGe1eIom2G",
  orderId: "order_U1FziXEsFLM0M2",
  videoId: "vid-1794921663743-mq2n",
  contentType: "short",
  videoFilename: "vid_1794921664_1526401b2e9f.mp4",
  thumbnailFilename: "img_1794921665_534b4a.jpg",
  title: "मैं वो कलम नहीं, जो बिक जाते हैं दरबारों और चौबारों में",
  category: "Poetry / Shayari",
  description: "आत्मसम्मान और उसूलों को बयां करती एक खूबसूरत शायरी। हर कलम बिकने के लिए नहीं होती।",
  duration: "0:48",
};

function createBaseUsers(customerReferralCode: string | null = "FT483921"): FakeUserRow[] {
  return [
    {
      id: "a0000000-0000-0000-0000-000000000001",
      user_id: "FT102857",
      name: "FaceTube Administrator",
      role: "admin",
      referral_code: "FTVIP",
      created_at: "2026-01-01 00:00:00",
    },
    {
      id: "a0000000-0000-0000-0000-000000000002",
      user_id: "FT483921",
      name: "Alex Rivera",
      role: "user",
      referral_code: "CREATOR50",
      created_at: "2026-01-02 00:00:00",
    },
    {
      id: "a0000000-0000-0000-0000-000000000003",
      user_id: "FT900431",
      name: "Maya Lin",
      role: "user",
      referral_code: "FT483921",
      created_at: "2026-01-03 00:00:00",
    },
    {
      id: "8baded68-1af2-49aa-bb93-c45e7815776b",
      user_id: "FT308128",
      name: "Khushnuma khatoon",
      role: "user",
      referral_code: customerReferralCode,
      created_at: "2026-04-01 00:00:00",
    },
  ];
}

function createBaseEligibleVideos(): FakeVideoRow[] {
  return [
    {
      id: "vid-seed-003",
      user_id: "FT483921",
      creator_name: "Alex Rivera",
      title: "Creator 1",
      description: "",
      video_url: "https://api.facetube.online/uploads/videos/seed1.mp4",
      thumbnail_url: "https://api.facetube.online/uploads/images/seed1.jpg",
      video_type: "premium",
      content_type: "short",
      category: "Business",
      duration: "0:58",
      views: 100,
      likes: 10,
      payment_status: "paid",
      payment_id: "pay_seed_1",
      payment_amount: 6,
      is_promoted: 0,
      ad_earnings: 200,
      is_blocked: 0,
      created_at: "2026-02-01 00:00:00",
    },
    {
      id: "vid-seed-006",
      user_id: "FT900431",
      creator_name: "Maya Lin",
      title: "Creator 2",
      description: "",
      video_url: "https://api.facetube.online/uploads/videos/seed2.mp4",
      thumbnail_url: "https://api.facetube.online/uploads/images/seed2.jpg",
      video_type: "premium",
      content_type: "long",
      category: "Entertainment",
      duration: "12:00",
      views: 100,
      likes: 10,
      payment_status: "paid",
      payment_id: "pay_seed_2",
      payment_amount: 6,
      is_promoted: 0,
      ad_earnings: 100,
      is_blocked: 0,
      created_at: "2026-02-02 00:00:00",
    },
  ];
}

function createRazorpayFetchMock(
  overrides: Record<string, { status?: number; body: unknown }> = {},
) {
  const defaultMap: Record<string, unknown> = {
    "/orders/order_U13qMEFDcwUk9g": {
      id: "order_U13qMEFDcwUk9g",
      amount: 600,
      currency: "INR",
      created_at: 1794878870,
      notes: {
        purpose: "premium_video_upload",
        userId: "FT308128",
        videoId: "vid-1794878873383-uhiv",
        contentType: "long",
      },
    },
    "/payments/pay_U13qWSXKobAy1G": {
      id: "pay_U13qWSXKobAy1G",
      order_id: "order_U13qMEFDcwUk9g",
      status: "captured",
      amount: 600,
      currency: "INR",
      amount_refunded: 0,
      refund_status: null,
      created_at: 1794878873,
      notes: {
        purpose: "premium_video_upload",
        userId: "FT308128",
        videoId: "vid-1794878873383-uhiv",
      },
    },
    "/orders/order_U13qMEFDcwUk9g/payments": {
      items: [
        {
          id: "pay_U13qWSXKobAy1G",
          status: "captured",
          amount: 600,
        },
      ],
    },
    "/orders/order_U1FziXEsFLM0M2": {
      id: "order_U1FziXEsFLM0M2",
      amount: 600,
      currency: "INR",
      created_at: 1794921660,
      notes: {
        purpose: "premium_video_upload",
        userId: "FT308128",
        videoId: "vid-1794921663743-mq2n",
        contentType: "short",
      },
    },
    "/payments/pay_U1FzvGe1eIom2G": {
      id: "pay_U1FzvGe1eIom2G",
      order_id: "order_U1FziXEsFLM0M2",
      status: "captured",
      amount: 600,
      currency: "INR",
      amount_refunded: 0,
      refund_status: null,
      created_at: 1794921664,
      notes: {},
    },
    "/orders/order_U1FziXEsFLM0M2/payments": {
      items: [
        {
          id: "pay_U1FzvGe1eIom2G",
          status: "captured",
          amount: 600,
        },
      ],
    },
  };

  return (async (input: string | URL | Request): Promise<Response> => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const apiPath = rawUrl.replace(/^https:\/\/api\.razorpay\.com\/v1/, "");

    if (apiPath in overrides) {
      const ov = overrides[apiPath]!;
      return new Response(JSON.stringify(ov.body), {
        status: ov.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (apiPath in defaultMap) {
      return new Response(JSON.stringify(defaultMap[apiPath]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({ error: { code: "BAD_REQUEST_ERROR", description: "Not found" } }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}

describe("Premium Payment Recovery Endpoint — PHP Structural & Node Functional Tests", () => {
  let tmpMediaRoot = "";
  let mediaDirs: RecoveryMediaDirs;

  beforeEach(() => {
    tmpMediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "facetube-recovery-test-"));
    const videosDir = path.join(tmpMediaRoot, "videos");
    const imagesDir = path.join(tmpMediaRoot, "images");
    fs.mkdirSync(videosDir, { recursive: true });
    fs.mkdirSync(imagesDir, { recursive: true });

    fs.writeFileSync(path.join(videosDir, LONG_ITEM.videoFilename), Buffer.from("fake-mp4-long"));
    fs.writeFileSync(
      path.join(imagesDir, LONG_ITEM.thumbnailFilename),
      Buffer.from("fake-jpg-long"),
    );
    fs.writeFileSync(path.join(videosDir, SHORT_ITEM.videoFilename), Buffer.from("fake-mp4-short"));
    fs.writeFileSync(
      path.join(imagesDir, SHORT_ITEM.thumbnailFilename),
      Buffer.from("fake-jpg-short"),
    );

    mediaDirs = { videos: [videosDir], images: [imagesDir] };
  });

  afterEach(() => {
    if (tmpMediaRoot && fs.existsSync(tmpMediaRoot)) {
      fs.rmSync(tmpMediaRoot, { recursive: true, force: true });
    }
  });

  describe("PHP endpoint structural invariants & verify.php freeze", () => {
    const phpRecoveryPath = path.resolve(process.cwd(), "api/admin/recover-premium-payment.php");
    const phpVerifyPath = path.resolve(process.cwd(), "api/payments/verify.php");
    const phpRecoveryCode = fs.readFileSync(phpRecoveryPath, "utf-8");

    it("Enforces POST-only, admin-only auth, dryRun=true default, and HTTP 423 deployment blocker", () => {
      assert.ok(fs.existsSync(phpRecoveryPath), "api/admin/recover-premium-payment.php must exist");
      assert.ok(phpRecoveryCode.includes("$_SERVER['REQUEST_METHOD'] !== 'POST'"));
      assert.ok(phpRecoveryCode.includes("getAuthUser($pdo)"));
      assert.ok(
        phpRecoveryCode.includes("strtolower((string)($authUser['role'] ?? '')) !== 'admin'"),
      );
      assert.ok(phpRecoveryCode.includes("401"));
      assert.ok(phpRecoveryCode.includes("403"));
      assert.ok(phpRecoveryCode.includes("DEPLOYMENT BLOCKER"));
      assert.ok(phpRecoveryCode.includes("FACETUBE_ENABLE_PREMIUM_RECOVERY_LIVE_WRITES"));
      assert.ok(phpRecoveryCode.includes("423"));
      assert.ok(phpRecoveryCode.includes("return true;"), "parseDryRunFlag must default to true");
    });

    it("Acquires GET_LOCK('facetube_premium_tx_seq', 15), releases it in finally before jsonResponse, and does NOT swallow premium_transactions failures", () => {
      assert.ok(phpRecoveryCode.includes("GET_LOCK(?, 15)"));
      assert.ok(phpRecoveryCode.includes("facetube_premium_tx_seq"));
      assert.ok(phpRecoveryCode.includes("DO RELEASE_LOCK(?)"));
      assert.ok(phpRecoveryCode.includes("INSERT INTO premium_transactions"));

      // Verify INSERT INTO premium_transactions is NOT wrapped in an empty/ignored try/catch
      const premInsertIdx = phpRecoveryCode.indexOf("INSERT INTO premium_transactions (");
      assert.ok(premInsertIdx !== -1);
      const afterPremInsert = phpRecoveryCode.slice(premInsertIdx, premInsertIdx + 900);
      assert.ok(
        !afterPremInsert.includes("catch (Exception $ePt)"),
        "premium_transactions insert failure must NOT be silently ignored",
      );
      assert.ok(!phpRecoveryCode.includes("facetube_store.json"));
      assert.ok(!phpRecoveryCode.includes("premium_transactions.json"));
    });

    it("Keeps api/payments/verify.php completely free of recovery lock changes (frozen in this phase)", () => {
      const verifyCode = fs.readFileSync(phpVerifyPath, "utf-8");
      assert.ok(!verifyCode.includes("facetube_premium_tx_seq"));
    });
  });

  function buildRequest(body: unknown, method = "POST"): Request {
    return new Request("https://api.facetube.online/api/admin/recover-premium-payment.php", {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: method === "POST" ? JSON.stringify(body) : null,
    });
  }

  function makeEnv(liveWrites = false): Record<string, string | undefined> {
    return {
      RAZORPAY_KEY_ID: "rzp_live_test_key",
      RAZORPAY_KEY_SECRET: "rzp_live_test_secret",
      FACETUBE_API_BASE_URL: "https://api.facetube.online",
      ...(liveWrites ? { FACETUBE_ENABLE_PREMIUM_RECOVERY_LIVE_WRITES: "true" } : {}),
    };
  }

  it("Rejects non-POST methods (405), unauthenticated requests (401), and non-admin customer requests (403)", async () => {
    const pool = new TransactionalFakeMysqlPool({ users: createBaseUsers() });

    const res405 = await handleAdminRecoverPremiumPayment(
      new Request("https://api.facetube.online/api/admin/recover-premium-payment.php", {
        method: "GET",
      }),
      {
        pool: pool as unknown as Pool,
        env: makeEnv(),
        mediaDirs,
        fetchImpl: createRazorpayFetchMock(),
        getAuthUser: async () => ADMIN_USER,
      },
    );
    assert.equal(res405.status, 405);

    const res401 = await handleAdminRecoverPremiumPayment(buildRequest({ items: [LONG_ITEM] }), {
      pool: pool as unknown as Pool,
      env: makeEnv(),
      mediaDirs,
      fetchImpl: createRazorpayFetchMock(),
      getAuthUser: async () => null,
    });
    assert.equal(res401.status, 401);

    const res403 = await handleAdminRecoverPremiumPayment(buildRequest({ items: [LONG_ITEM] }), {
      pool: pool as unknown as Pool,
      env: makeEnv(),
      mediaDirs,
      fetchImpl: createRazorpayFetchMock(),
      getAuthUser: async () => CUSTOMER_USER,
    });
    assert.equal(res403.status, 403);
    assert.equal(pool.writeQueryCount, 0);
  });

  it("Blocks live recovery writes (dryRun=false) with HTTP 423 deploymentBlocker when opt-in env flag is absent", async () => {
    const pool = new TransactionalFakeMysqlPool({
      users: createBaseUsers(),
      uploaded_videos: createBaseEligibleVideos(),
    });

    const res = await handleAdminRecoverPremiumPayment(
      buildRequest({ dryRun: false, items: [LONG_ITEM, SHORT_ITEM] }),
      {
        pool: pool as unknown as Pool,
        env: makeEnv(false),
        mediaDirs,
        fetchImpl: createRazorpayFetchMock(),
        getAuthUser: async () => ADMIN_USER,
      },
    );
    assert.equal(res.status, 423);
    const json = (await res.json()) as Record<string, unknown>;
    assert.equal(json["success"], false);
    assert.equal(json["deploymentBlocker"], true);
    assert.equal(pool.writeQueryCount, 0);
    assert.equal(pool.beginCount, 0);
  });

  it("Defaults dryRun to true when omitted, preserves exact Hindi UTF-8 metadata, orders Long before Short, and performs ZERO DB writes", async () => {
    const pool = new TransactionalFakeMysqlPool({
      users: createBaseUsers("FT483921"),
      uploaded_videos: createBaseEligibleVideos(),
    });

    // Send Short first, Long second to verify forced Long-then-Short ordering
    const res = await handleAdminRecoverPremiumPayment(
      buildRequest({ items: [SHORT_ITEM, LONG_ITEM] }),
      {
        pool: pool as unknown as Pool,
        env: makeEnv(false),
        mediaDirs,
        fetchImpl: createRazorpayFetchMock(),
        getAuthUser: async () => ADMIN_USER,
      },
    );
    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      success: boolean;
      dryRun: boolean;
      processedCount: number;
      results: Array<Record<string, unknown>>;
    };

    assert.equal(json.success, true);
    assert.equal(json.dryRun, true);
    assert.equal(json.processedCount, 2);
    assert.equal(pool.writeQueryCount, 0);
    assert.equal(pool.beginCount, 0);
    assert.equal(pool.state.payment_transactions.length, 0);
    assert.equal(pool.state.uploaded_videos.length, 2);

    const first = json.results[0]!;
    const second = json.results[1]!;
    assert.equal(first["contentType"], "long");
    assert.equal(first["paymentId"], LONG_ITEM.paymentId);
    assert.equal(first["title"], LONG_ITEM.title);
    assert.equal(first["category"], "Education / Science");
    assert.equal(first["description"], LONG_ITEM.description);
    assert.equal((first["accounting"] as Record<string, unknown>)["txNumber"], 1);

    assert.equal(second["contentType"], "short");
    assert.equal(second["paymentId"], SHORT_ITEM.paymentId);
    assert.equal(second["title"], SHORT_ITEM.title);
    assert.equal(second["category"], "Poetry / Shayari");
    assert.equal(second["description"], SHORT_ITEM.description);
    assert.equal((second["accounting"] as Record<string, unknown>)["txNumber"], 2);
  });

  it("Validates Razorpay credentials, order/payment mismatch, non-captured status, refunds, order notes, UUID, traversal, missing files, and chronological conflicts", async () => {
    const pool = new TransactionalFakeMysqlPool({ users: createBaseUsers() });

    // 1. Missing Razorpay credentials -> 503
    const res503 = await handleAdminRecoverPremiumPayment(buildRequest({ items: [LONG_ITEM] }), {
      pool: pool as unknown as Pool,
      env: {},
      mediaDirs,
      fetchImpl: createRazorpayFetchMock(),
      getAuthUser: async () => ADMIN_USER,
    });
    assert.equal(res503.status, 503);

    // 2. UUID mismatch -> 400
    const resUuid = await handleAdminRecoverPremiumPayment(
      buildRequest({ items: [{ ...LONG_ITEM, userUuid: "00000000-0000-0000-0000-000000000000" }] }),
      {
        pool: pool as unknown as Pool,
        env: makeEnv(),
        mediaDirs,
        fetchImpl: createRazorpayFetchMock(),
        getAuthUser: async () => ADMIN_USER,
      },
    );
    assert.equal(resUuid.status, 400);

    // 3. Path traversal in filename -> 400
    const resTraversal = await handleAdminRecoverPremiumPayment(
      buildRequest({ items: [{ ...LONG_ITEM, videoFilename: "../etc/passwd" }] }),
      {
        pool: pool as unknown as Pool,
        env: makeEnv(),
        mediaDirs,
        fetchImpl: createRazorpayFetchMock(),
        getAuthUser: async () => ADMIN_USER,
      },
    );
    assert.equal(resTraversal.status, 400);

    // 4. Missing file on disk -> 404
    const resMissingFile = await handleAdminRecoverPremiumPayment(
      buildRequest({ items: [{ ...LONG_ITEM, thumbnailFilename: "missing_thumb.jpg" }] }),
      {
        pool: pool as unknown as Pool,
        env: makeEnv(),
        mediaDirs,
        fetchImpl: createRazorpayFetchMock(),
        getAuthUser: async () => ADMIN_USER,
      },
    );
    assert.equal(resMissingFile.status, 404);

    // 5. Non-captured payment -> 400
    const resNotCaptured = await handleAdminRecoverPremiumPayment(
      buildRequest({ items: [LONG_ITEM] }),
      {
        pool: pool as unknown as Pool,
        env: makeEnv(),
        mediaDirs,
        fetchImpl: createRazorpayFetchMock({
          "/payments/pay_U13qWSXKobAy1G": {
            body: {
              id: "pay_U13qWSXKobAy1G",
              order_id: "order_U13qMEFDcwUk9g",
              status: "authorized",
              amount: 600,
              currency: "INR",
            },
          },
        }),
        getAuthUser: async () => ADMIN_USER,
      },
    );
    assert.equal(resNotCaptured.status, 400);

    // 6. Refunded payment -> 409
    const resRefunded = await handleAdminRecoverPremiumPayment(
      buildRequest({ items: [LONG_ITEM] }),
      {
        pool: pool as unknown as Pool,
        env: makeEnv(),
        mediaDirs,
        fetchImpl: createRazorpayFetchMock({
          "/payments/pay_U13qWSXKobAy1G": {
            body: {
              id: "pay_U13qWSXKobAy1G",
              order_id: "order_U13qMEFDcwUk9g",
              status: "captured",
              amount: 600,
              currency: "INR",
              amount_refunded: 600,
              refund_status: "full",
            },
          },
        }),
        getAuthUser: async () => ADMIN_USER,
      },
    );
    assert.equal(resRefunded.status, 409);

    // 7. Order notes userId mismatch -> 400
    const resWrongUserNote = await handleAdminRecoverPremiumPayment(
      buildRequest({ items: [LONG_ITEM] }),
      {
        pool: pool as unknown as Pool,
        env: makeEnv(),
        mediaDirs,
        fetchImpl: createRazorpayFetchMock({
          "/orders/order_U13qMEFDcwUk9g": {
            body: {
              id: "order_U13qMEFDcwUk9g",
              amount: 600,
              currency: "INR",
              notes: {
                purpose: "premium_video_upload",
                userId: "FT999999",
                videoId: LONG_ITEM.videoId,
                contentType: "long",
              },
            },
          },
        }),
        getAuthUser: async () => ADMIN_USER,
      },
    );
    assert.equal(resWrongUserNote.status, 400);

    // 8. Multiple captured payments on same order -> 409
    const resMultiCaptured = await handleAdminRecoverPremiumPayment(
      buildRequest({ items: [LONG_ITEM] }),
      {
        pool: pool as unknown as Pool,
        env: makeEnv(),
        mediaDirs,
        fetchImpl: createRazorpayFetchMock({
          "/orders/order_U13qMEFDcwUk9g/payments": {
            body: {
              items: [
                { id: "pay_U13qWSXKobAy1G", status: "captured" },
                { id: "pay_extra_duplicate", status: "captured" },
              ],
            },
          },
        }),
        getAuthUser: async () => ADMIN_USER,
      },
    );
    assert.equal(resMultiCaptured.status, 409);

    // 9. Chronological conflict (Short captured before Long) -> 409
    const resChrono = await handleAdminRecoverPremiumPayment(
      buildRequest({ items: [LONG_ITEM, SHORT_ITEM] }),
      {
        pool: pool as unknown as Pool,
        env: makeEnv(),
        mediaDirs,
        fetchImpl: createRazorpayFetchMock({
          "/payments/pay_U1FzvGe1eIom2G": {
            body: {
              id: "pay_U1FzvGe1eIom2G",
              order_id: "order_U1FziXEsFLM0M2",
              status: "captured",
              amount: 600,
              currency: "INR",
              amount_refunded: 0,
              refund_status: null,
              created_at: 1794878000,
            },
          },
        }),
        getAuthUser: async () => ADMIN_USER,
      },
    );
    assert.equal(resChrono.status, 409);
  });

  it("Executes sequential atomic recovery (Long first, Short second), applies exact accounting including 11th special rule, and preserves UTF-8", async () => {
    // Baseline 10 historical transactions -> Long becomes #11 (SPECIAL_GLOBAL_RULE), Short becomes #12 (NORMAL_PREMIUM)
    const existingPremTxs: FakePremiumTxRow[] = Array.from({ length: 10 }, (_, i) => ({
      id: `ptx-seed-${i + 1}`,
      tx_number: i + 1,
      payment_id: `pay_seed_${i + 1}`,
      order_id: `order_seed_${i + 1}`,
      video_id: `vid_seed_${i + 1}`,
      user_id: i % 2 === 0 ? "FT900431" : "FT483921",
      referrer_id: i % 2 === 0 ? "FT483921" : "FT102857",
      amount: 6,
      transaction_type: "premium_upload",
      is_special: 0,
      special_tag: "NORMAL_PREMIUM",
      referral_commission: 1,
      admin_allocation: 1,
      global_pool_allocation: 3,
    }));
    const existingPayTxs: FakePaymentTxRow[] = existingPremTxs.map((t, idx) => ({
      id: idx + 1,
      order_id: t.order_id,
      payment_id: t.payment_id,
      user_id: t.user_id,
      user_name: "Seed User",
      video_id: t.video_id,
      purpose: "premium_video_upload",
      amount: 6,
      tx_number: t.tx_number,
      is_special: 0,
      special_tag: "NORMAL_PREMIUM",
      referral_commission: 1,
      admin_allocation: 1,
      global_pool_allocation: 3,
    }));

    // Customer FT308128 has NO referrer -> unallocated ₹1 redirects to Admin
    const pool = new TransactionalFakeMysqlPool({
      users: createBaseUsers(null),
      uploaded_videos: createBaseEligibleVideos(),
      payment_transactions: existingPayTxs,
      premium_transactions: existingPremTxs,
      payment_orders: [
        {
          order_id: LONG_ITEM.orderId,
          user_id: "FT308128",
          user_name: "Khushnuma khatoon",
          video_id: LONG_ITEM.videoId,
          purpose: "premium_video_upload",
          plan_id: null,
          content_type: "long",
          amount: 6,
          currency: "INR",
          status: "created",
          payment_id: null,
        },
      ],
    });

    const res = await handleAdminRecoverPremiumPayment(
      buildRequest({ dryRun: false, items: [SHORT_ITEM, LONG_ITEM] }),
      {
        pool: pool as unknown as Pool,
        env: makeEnv(true),
        mediaDirs,
        fetchImpl: createRazorpayFetchMock(),
        getAuthUser: async () => ADMIN_USER,
      },
    );

    assert.equal(res.status, 200);
    const json = (await res.json()) as {
      success: boolean;
      dryRun: boolean;
      processedCount: number;
      results: Array<Record<string, unknown>>;
    };
    assert.equal(json.success, true);
    assert.equal(json.dryRun, false);
    assert.equal(json.processedCount, 2);

    // Separate atomic transactions for Long then Short under GET_LOCK
    assert.equal(pool.beginCount, 2);
    assert.equal(pool.commitCount, 2);
    assert.equal(pool.rollbackCount, 0);
    assert.deepEqual(pool.lockHistory, [
      "acquire:facetube_premium_tx_seq",
      "release:facetube_premium_tx_seq",
    ]);

    // Check Long (#11 Special, no referrer => Admin = ₹5.00, Global Pool = ₹0)
    const longPt = pool.state.payment_transactions.find(
      (t) => t.payment_id === LONG_ITEM.paymentId,
    )!;
    const longPrem = pool.state.premium_transactions.find(
      (t) => t.payment_id === LONG_ITEM.paymentId,
    )!;
    assert.equal(longPt.tx_number, 11);
    assert.equal(longPt.is_special, 1);
    assert.equal(longPt.special_tag, "SPECIAL_GLOBAL_RULE");
    assert.equal(longPt.referral_commission, 0);
    assert.equal(longPt.admin_allocation, 5);
    assert.equal(longPt.global_pool_allocation, 0);
    assert.equal(longPrem.tx_number, 11);
    assert.equal(longPrem.referrer_id, null);

    // Check Short (#12 Normal, no referrer => Admin = ₹2.00, Weighted Global Pool = ₹3.00 -> FT483921 ₹2 + FT900431 ₹1)
    const shortPt = pool.state.payment_transactions.find(
      (t) => t.payment_id === SHORT_ITEM.paymentId,
    )!;
    const shortPrem = pool.state.premium_transactions.find(
      (t) => t.payment_id === SHORT_ITEM.paymentId,
    )!;
    assert.equal(shortPt.tx_number, 12);
    assert.equal(shortPt.is_special, 0);
    assert.equal(shortPt.special_tag, "NORMAL_PREMIUM");
    assert.equal(shortPt.referral_commission, 0);
    assert.equal(shortPt.admin_allocation, 2);
    assert.equal(shortPt.global_pool_allocation, 3);
    assert.equal(shortPrem.tx_number, 12);

    // Verify wallets: Admin got 5 + 2 = 7, FT483921 got 2.00, FT900431 got 1.00, FT308128 got 0
    const adminWallet = pool.state.wallet_balances.find((w) => w.user_id === "FT102857")!;
    const creator1Wallet = pool.state.wallet_balances.find((w) => w.user_id === "FT483921")!;
    const creator2Wallet = pool.state.wallet_balances.find((w) => w.user_id === "FT900431")!;
    const uploaderWallet = pool.state.wallet_balances.find((w) => w.user_id === "FT308128");
    assert.equal(adminWallet.balance, 7);
    assert.equal(creator1Wallet.global_income, 2);
    assert.equal(creator2Wallet.global_income, 1);
    assert.equal(uploaderWallet, undefined);

    // Verify Hindi UTF-8 video records
    const longVid = pool.state.uploaded_videos.find((v) => v.id === LONG_ITEM.videoId)!;
    const shortVid = pool.state.uploaded_videos.find((v) => v.id === SHORT_ITEM.videoId)!;
    assert.equal(longVid.title, LONG_ITEM.title);
    assert.equal(longVid.category, "Education / Science");
    assert.equal(longVid.description, LONG_ITEM.description);
    assert.equal(longVid.content_type, "long");
    assert.equal(longVid.payment_status, "paid");
    assert.equal(shortVid.title, SHORT_ITEM.title);
    assert.equal(shortVid.category, "Poetry / Shayari");
    assert.equal(shortVid.description, SHORT_ITEM.description);
    assert.equal(shortVid.content_type, "short");
    assert.equal(shortVid.payment_status, "paid");

    // Verify payment_orders: existing 'created' updated & missing one inserted as 'paid'
    const poLong = pool.state.payment_orders.find((o) => o.order_id === LONG_ITEM.orderId)!;
    const poShort = pool.state.payment_orders.find((o) => o.order_id === SHORT_ITEM.orderId)!;
    assert.equal(poLong.status, "paid");
    assert.equal(poLong.payment_id, LONG_ITEM.paymentId);
    assert.equal(poShort.status, "paid");
    assert.equal(poShort.payment_id, SHORT_ITEM.paymentId);
  });

  it("Does NOT silently ignore premium_transactions insert failure and rolls back the failed payment transaction completely", async () => {
    const pool = new TransactionalFakeMysqlPool({
      users: createBaseUsers("FT483921"),
      uploaded_videos: createBaseEligibleVideos(),
    });
    // Fail on the second (Short) payment's INSERT INTO premium_transactions
    pool.failOnPremiumTxInsertForPaymentId = SHORT_ITEM.paymentId;

    const res = await handleAdminRecoverPremiumPayment(
      buildRequest({ dryRun: false, items: [LONG_ITEM, SHORT_ITEM] }),
      {
        pool: pool as unknown as Pool,
        env: makeEnv(true),
        mediaDirs,
        fetchImpl: createRazorpayFetchMock(),
        getAuthUser: async () => ADMIN_USER,
      },
    );

    assert.equal(res.status, 500);
    const json = (await res.json()) as {
      success: boolean;
      committedSoFar: Array<Record<string, unknown>>;
    };
    assert.equal(json.success, false);
    assert.equal(json.committedSoFar.length, 1);
    assert.equal(json.committedSoFar[0]!["paymentId"], LONG_ITEM.paymentId);
    assert.equal(pool.rollbackCount, 1);
    assert.equal(pool.commitCount, 1);

    // Long remained cleanly committed, Short left ZERO partial rows in ANY table
    assert.equal(pool.state.payment_transactions.length, 1);
    assert.equal(pool.state.premium_transactions.length, 1);
    assert.ok(!pool.state.payment_transactions.some((t) => t.payment_id === SHORT_ITEM.paymentId));
    assert.ok(!pool.state.uploaded_videos.some((v) => v.id === SHORT_ITEM.videoId));
    assert.ok(!pool.state.payment_orders.some((o) => o.order_id === SHORT_ITEM.orderId));
    assert.ok(
      !pool.state.income_ledger.some((l) => l.transaction_id.includes(SHORT_ITEM.paymentId)),
    );

    // Lock was still cleanly released
    assert.deepEqual(pool.lockHistory, [
      "acquire:facetube_premium_tx_seq",
      "release:facetube_premium_tx_seq",
    ]);
  });

  it("Enforces strict idempotency on repeat runs and rejects partial existing records with 409", async () => {
    const pool = new TransactionalFakeMysqlPool({
      users: createBaseUsers("FT483921"),
      uploaded_videos: createBaseEligibleVideos(),
    });

    // First live run succeeds
    const firstRes = await handleAdminRecoverPremiumPayment(
      buildRequest({ dryRun: false, items: [LONG_ITEM, SHORT_ITEM] }),
      {
        pool: pool as unknown as Pool,
        env: makeEnv(true),
        mediaDirs,
        fetchImpl: createRazorpayFetchMock(),
        getAuthUser: async () => ADMIN_USER,
      },
    );
    assert.equal(firstRes.status, 200);
    const adminBalanceAfterFirst = pool.state.wallet_balances.find(
      (w) => w.user_id === "FT102857",
    )!.balance;
    const refBalanceAfterFirst = pool.state.wallet_balances.find(
      (w) => w.user_id === "FT483921",
    )!.referral_income;

    // Second live run MUST reject with 409 and perform zero additional credits
    const secondRes = await handleAdminRecoverPremiumPayment(
      buildRequest({ dryRun: false, items: [LONG_ITEM, SHORT_ITEM] }),
      {
        pool: pool as unknown as Pool,
        env: makeEnv(true),
        mediaDirs,
        fetchImpl: createRazorpayFetchMock(),
        getAuthUser: async () => ADMIN_USER,
      },
    );
    assert.equal(secondRes.status, 409);
    assert.equal(
      pool.state.wallet_balances.find((w) => w.user_id === "FT102857")!.balance,
      adminBalanceAfterFirst,
    );
    assert.equal(
      pool.state.wallet_balances.find((w) => w.user_id === "FT483921")!.referral_income,
      refBalanceAfterFirst,
    );
    assert.equal(pool.state.payment_transactions.length, 2);
    assert.equal(pool.state.premium_transactions.length, 2);

    // Dry-run also detects duplicate conflicts with 409
    const dryDuplicateRes = await handleAdminRecoverPremiumPayment(
      buildRequest({ dryRun: true, items: [LONG_ITEM] }),
      {
        pool: pool as unknown as Pool,
        env: makeEnv(true),
        mediaDirs,
        fetchImpl: createRazorpayFetchMock(),
        getAuthUser: async () => ADMIN_USER,
      },
    );
    assert.equal(dryDuplicateRes.status, 409);

    // Partial-state conflict: pre-existing income_ledger row blocks recovery with 409
    const partialPool = new TransactionalFakeMysqlPool({
      users: createBaseUsers("FT483921"),
      income_ledger: [
        {
          id: "existing-adm-1",
          transaction_id: `TX_ADM_${LONG_ITEM.paymentId}`,
          user_id: "FT102857",
          source_user_id: "FT308128",
          source_user_name: "Khushnuma khatoon",
          video_id: LONG_ITEM.videoId,
          income_type: "admin_allocation",
          amount: 1,
          status: "settled",
          special_tag: "NORMAL_PREMIUM",
          description: "Pre-existing ledger entry",
        },
      ],
    });
    const partialRes = await handleAdminRecoverPremiumPayment(
      buildRequest({ dryRun: false, items: [LONG_ITEM] }),
      {
        pool: partialPool as unknown as Pool,
        env: makeEnv(true),
        mediaDirs,
        fetchImpl: createRazorpayFetchMock(),
        getAuthUser: async () => ADMIN_USER,
      },
    );
    assert.equal(partialRes.status, 409);
    assert.equal(partialPool.state.payment_transactions.length, 0);
  });
});
