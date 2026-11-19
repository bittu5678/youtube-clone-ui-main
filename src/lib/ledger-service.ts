import { api } from "./api";

export type IncomeType =
  | "referral_income"
  | "direct_commission"
  | "global_income"
  | "admin_allocation"
  | "withdrawal"
  | "ads_promotion_fee"
  | "adsense_income"
  | "admob_income"
  | "ad_boost_income"
  | "affiliate_income"
  | "marketing_income";

export interface LedgerTransaction {
  id: string;
  transactionId: string;
  userId: string;
  sourceUserId?: string | undefined;
  sourceUserName?: string | undefined;
  videoId?: string | undefined;
  incomeType: IncomeType;
  amount: number;
  fee?: number | undefined;
  netAmount?: number | undefined;
  status: "settled" | "pending" | "failed";
  specialTag?: "SPECIAL_GLOBAL_RULE" | "SPECIAL_TRANSACTION" | undefined;
  description: string;
  batchId?: string | undefined;
  batch_id?: string | undefined;
  payoutMethod?: string | undefined;
  payout_method?: string | undefined;
  beneficiaryDetails?: string | undefined;
  beneficiary_details?: string | undefined;
  createdAt: string;
  isStale?: boolean | undefined;
}

export interface UserWallet {
  userId: string;
  balance: number;
  totalEarned: number;
  totalWithdrawn: number;
  referralIncome: number;
  globalIncome: number;
  adsenseIncome: number;
  admobIncome?: number;
  affiliateIncome: number;
  updatedAt: string;
  isStale?: boolean | undefined;
}

/**
 * Computes Total Ad Earning strictly as verified AdSense income + verified AdMob income.
 * Does NOT include Ad Boost, Affiliate, Referral, or Global Pool income.
 */
export function calculateTotalAdEarning(
  wallet?: Pick<UserWallet, "adsenseIncome" | "admobIncome"> | null,
): number {
  const adsense = Number(wallet?.adsenseIncome) || 0;
  const admob = Number(wallet?.admobIncome) || 0;
  return Math.round((adsense + admob) * 100) / 100;
}

const LOCAL_STORAGE_LEDGER_KEY = "facetube_income_ledger_v3";
const LOCAL_STORAGE_WALLETS_KEY = "facetube_user_wallets_v3";

// Initial empty ledger and wallet storage (real earnings fetched from backend)
const INITIAL_SEED_LEDGER: LedgerTransaction[] = [];

const INITIAL_SEED_WALLETS: Record<string, UserWallet> = {};

export function getStoredLedger(): LedgerTransaction[] {
  if (typeof window === "undefined") return INITIAL_SEED_LEDGER;
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_LEDGER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
    localStorage.setItem(LOCAL_STORAGE_LEDGER_KEY, JSON.stringify(INITIAL_SEED_LEDGER));
    return INITIAL_SEED_LEDGER;
  } catch {
    return INITIAL_SEED_LEDGER;
  }
}

export function saveStoredLedger(transactions: LedgerTransaction[]): void {
  if (typeof window === "undefined") {
    INITIAL_SEED_LEDGER.length = 0;
    INITIAL_SEED_LEDGER.push(...transactions);
    return;
  }
  try {
    localStorage.setItem(LOCAL_STORAGE_LEDGER_KEY, JSON.stringify(transactions));
  } catch {
    // quota
  }
}

export function getStoredWallets(): Record<string, UserWallet> {
  if (typeof window === "undefined") return INITIAL_SEED_WALLETS;
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_WALLETS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) return parsed;
    }
    localStorage.setItem(LOCAL_STORAGE_WALLETS_KEY, JSON.stringify(INITIAL_SEED_WALLETS));
    return INITIAL_SEED_WALLETS;
  } catch {
    return INITIAL_SEED_WALLETS;
  }
}

export function saveStoredWallets(wallets: Record<string, UserWallet>): void {
  if (typeof window === "undefined") {
    for (const key of Object.keys(INITIAL_SEED_WALLETS)) {
      delete INITIAL_SEED_WALLETS[key];
    }
    Object.assign(INITIAL_SEED_WALLETS, wallets);
    return;
  }
  try {
    localStorage.setItem(LOCAL_STORAGE_WALLETS_KEY, JSON.stringify(wallets));
  } catch {
    // quota
  }
}

/**
 * Retrieves the wallet for a user
 */
export async function getUserWallet(userId: string): Promise<UserWallet> {
  const norm = userId.trim().toUpperCase();

  try {
    const res = await api.wallet.getBalance(norm);
    if (res && res.wallet) {
      const data = res.wallet;
      const wallet: UserWallet = {
        userId: data.user_id || data.userId || norm,
        balance: Number(data.balance) || 0,
        totalEarned: Number(data.total_earned || data.totalEarned) || 0,
        totalWithdrawn: Number(data.total_withdrawn || data.totalWithdrawn) || 0,
        referralIncome: Number(data.referral_income || data.referralIncome) || 0,
        globalIncome: Number(data.global_income || data.globalIncome) || 0,
        adsenseIncome: Number(data.adsense_income || data.adsenseIncome) || 0,
        admobIncome: Number(data.admob_income || data.admobIncome) || 0,
        affiliateIncome: Number(data.affiliate_income || data.affiliateIncome) || 0,
        updatedAt: data.updated_at || data.updatedAt || new Date().toISOString(),
        isStale: false,
      };
      // Keep local cache synced with authoritative server wallet
      const wallets = getStoredWallets();
      wallets[norm] = wallet;
      saveStoredWallets(wallets);
      return wallet;
    }
  } catch (err) {
    console.warn("getUserWallet: failed to fetch live wallet from server:", err);
  }

  const wallets = getStoredWallets();
  if (wallets[norm]) {
    return {
      ...wallets[norm]!,
      admobIncome: Number(wallets[norm]!.admobIncome) || 0,
      isStale: true,
    };
  }

  // Create default unconfirmed wallet without overwriting stored storage
  const unconfirmedWallet: UserWallet = {
    userId: norm,
    balance: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
    referralIncome: 0,
    globalIncome: 0,
    adsenseIncome: 0,
    admobIncome: 0,
    affiliateIncome: 0,
    updatedAt: new Date().toISOString(),
    isStale: true,
  };
  return unconfirmedWallet;
}

/**
 * Gets ledger transactions for a user
 */
export async function getUserLedger(userId?: string): Promise<LedgerTransaction[]> {
  try {
    const res = await api.wallet.getTransactions(userId);
    if (res && Array.isArray(res.transactions)) {
      const mapped: LedgerTransaction[] = res.transactions.map((d: any) => ({
        id: String(d.id),
        transactionId: d.transaction_id || d.transactionId,
        userId: d.user_id || d.userId,
        sourceUserId: d.source_user_id || d.sourceUserId || undefined,
        sourceUserName: d.source_user_name || d.sourceUserName || undefined,
        videoId: d.video_id || d.videoId || undefined,
        incomeType: (d.income_type || d.incomeType) as IncomeType,
        amount: Number(d.amount) || 0,
        status: d.status || "settled",
        specialTag: d.special_tag || d.specialTag || undefined,
        description: d.description || "",
        batchId: d.batch_id || d.batchId || undefined,
        batch_id: d.batch_id || d.batchId || undefined,
        payoutMethod: d.payout_method || d.payoutMethod || undefined,
        payout_method: d.payout_method || d.payoutMethod || undefined,
        beneficiaryDetails: d.beneficiary_details || d.beneficiaryDetails || undefined,
        beneficiary_details: d.beneficiary_details || d.beneficiaryDetails || undefined,
        createdAt: d.created_at || d.createdAt,
        isStale: false,
      }));
      if (!userId) {
        saveStoredLedger(mapped);
      }
      return mapped;
    }
  } catch (err) {
    console.warn("getUserLedger: failed to fetch live transactions from server:", err);
  }

  const all = getStoredLedger();
  const markedStale = all.map((tx) => ({ ...tx, isStale: true }));
  if (userId) {
    const norm = userId.trim().toUpperCase();
    return markedStale.filter((tx) => tx.userId.trim().toUpperCase() === norm);
  }
  return markedStale;
}

export interface GlobalPoolSummary {
  excludedUserId: string | null;
  poolAmount: number;
  poolPaise: number;
  eligibleVideoCount: number;
  distinctCreatorCount: number;
  estimatedEqualSharePerVideo: number;
  totalAdEarnings: number;
  weightingMode: "ad_earnings_weighted" | "equal_fallback";
  isStale?: boolean | undefined;
  error?: string | undefined;
}

/**
 * Fetches the authoritative Global Income Pool summary from the backend server.
 * Does NOT compute or fall back to localStorage video eligibility calculations.
 */
export async function getGlobalPoolSummary(excludeUserId?: string): Promise<GlobalPoolSummary> {
  const normExclude = excludeUserId?.trim().toUpperCase() || undefined;
  try {
    const res = await api.wallet.getGlobalPoolSummary(normExclude);
    if (res && res.success) {
      return {
        excludedUserId: res.excludedUserId ?? normExclude ?? null,
        poolAmount: Number(res.poolAmount ?? 3.0),
        poolPaise: Number(res.poolPaise ?? 300),
        eligibleVideoCount: Math.max(0, Number(res.eligibleVideoCount) || 0),
        distinctCreatorCount: Math.max(0, Number(res.distinctCreatorCount) || 0),
        estimatedEqualSharePerVideo: Math.max(0, Number(res.estimatedEqualSharePerVideo) || 0),
        totalAdEarnings: Math.max(0, Number(res.totalAdEarnings) || 0),
        weightingMode: res.weightingMode || "equal_fallback",
        isStale: false,
      };
    }
    throw new Error("Server returned an invalid global pool summary response.");
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? err.message : "Failed to fetch global pool summary from server.";
    console.warn("getGlobalPoolSummary: failed to fetch live pool summary from server:", err);
    return {
      excludedUserId: normExclude ?? null,
      poolAmount: 3.0,
      poolPaise: 300,
      eligibleVideoCount: 0,
      distinctCreatorCount: 0,
      estimatedEqualSharePerVideo: 0,
      totalAdEarnings: 0,
      weightingMode: "equal_fallback",
      isStale: true,
      error: msg,
    };
  }
}

export interface AuthoritativeWalletResult {
  wallet: UserWallet | null;
  error?: string | undefined;
}

export interface AuthoritativeLedgerResult {
  transactions: LedgerTransaction[];
  error?: string | undefined;
}

/**
 * Strictly fetches the authenticated user's wallet balance from the backend server.
 * Unlike getUserWallet(), this NEVER falls back to localStorage or synthesizes a ₹0.00 wallet.
 */
export async function getAuthoritativeUserWallet(
  userId: string,
): Promise<AuthoritativeWalletResult> {
  const norm = userId.trim().toUpperCase();
  if (!norm) {
    return { wallet: null, error: "Sign in required to load server balance." };
  }

  try {
    const res = await api.wallet.getBalance(norm);
    if (res && res.success !== false && res.wallet && typeof res.wallet === "object") {
      const data = res.wallet;
      const wallet: UserWallet = {
        userId: data.user_id || data.userId || norm,
        balance: Number(data.balance) || 0,
        totalEarned: Number(data.total_earned ?? data.totalEarned) || 0,
        totalWithdrawn: Number(data.total_withdrawn ?? data.totalWithdrawn) || 0,
        referralIncome: Number(data.referral_income ?? data.referralIncome) || 0,
        globalIncome: Number(data.global_income ?? data.globalIncome) || 0,
        adsenseIncome: Number(data.adsense_income ?? data.adsenseIncome) || 0,
        admobIncome: Number(data.admob_income ?? data.admobIncome) || 0,
        affiliateIncome: Number(data.affiliate_income ?? data.affiliateIncome) || 0,
        updatedAt: data.updated_at || data.updatedAt || new Date().toISOString(),
        isStale: false,
      };
      return { wallet };
    }
    throw new Error("Server returned an invalid wallet balance response.");
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? err.message : "Failed to fetch live wallet balance from server.";
    console.warn("getAuthoritativeUserWallet: failed to fetch live wallet from server:", err);
    return { wallet: null, error: msg };
  }
}

/**
 * Strictly fetches the authenticated user's ledger transactions from the backend server.
 * Unlike getUserLedger(), this NEVER falls back to localStorage cached transactions.
 */
export async function getAuthoritativeUserLedger(
  userId: string,
): Promise<AuthoritativeLedgerResult> {
  const norm = userId.trim().toUpperCase();
  if (!norm) {
    return { transactions: [], error: "Sign in required to load server ledger." };
  }

  try {
    const res = await api.wallet.getTransactions(norm);
    if (res && res.success !== false && Array.isArray(res.transactions)) {
      const mapped: LedgerTransaction[] = res.transactions.map((d: any) => ({
        id: String(d.id),
        transactionId: d.transaction_id || d.transactionId,
        userId: d.user_id || d.userId,
        sourceUserId: d.source_user_id || d.sourceUserId || undefined,
        sourceUserName: d.source_user_name || d.sourceUserName || undefined,
        videoId: d.video_id || d.videoId || undefined,
        incomeType: (d.income_type || d.incomeType) as IncomeType,
        amount: Number(d.amount) || 0,
        status: d.status || "settled",
        specialTag: d.special_tag || d.specialTag || undefined,
        description: d.description || "",
        batchId: d.batch_id || d.batchId || undefined,
        batch_id: d.batch_id || d.batchId || undefined,
        payoutMethod: d.payout_method || d.payoutMethod || undefined,
        payout_method: d.payout_method || d.payoutMethod || undefined,
        beneficiaryDetails: d.beneficiary_details || d.beneficiaryDetails || undefined,
        beneficiary_details: d.beneficiary_details || d.beneficiaryDetails || undefined,
        createdAt: d.created_at || d.createdAt,
        isStale: false,
      }));
      return { transactions: mapped };
    }
    throw new Error("Server returned an invalid ledger response.");
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? err.message : "Failed to fetch live transactions from server.";
    console.warn("getAuthoritativeUserLedger: failed to fetch live transactions from server:", err);
    return { transactions: [], error: msg };
  }
}

export interface GlobalIncomeDisplayState {
  walletAvailable: boolean;
  poolAvailable: boolean;
  ledgerAvailable: boolean;
  hasAnyServerError: boolean;
  globalIncomeValue: string;
  globalIncomeCaption: string;
  eligibleVideosValue: string | number;
  eligibleVideosCaption: string;
  sharePerVideoValue: string;
  sharePerVideoCaption: string;
  distributionStatusCaption: string;
  ledgerHeaderSubtitle: string;
  visibleTransactions: LedgerTransaction[];
  ledgerEmptyMessage: string;
}

/**
 * Computes strictly server-authoritative display strings for the Global Income page.
 * Rejects stale/cached entries and ensures any failed required server request yields
 * explicit unavailable captions and "Awaiting server sync" status.
 */
export function deriveGlobalIncomeDisplayState(params: {
  loading: boolean;
  userId: string;
  wallet: UserWallet | null;
  walletError: string | null;
  transactions: LedgerTransaction[];
  ledgerError: string | null;
  poolSummary: GlobalPoolSummary | null;
}): GlobalIncomeDisplayState {
  const { loading, userId, wallet, walletError, transactions, ledgerError, poolSummary } = params;
  const hasUser = Boolean(userId.trim());

  const walletAvailable = Boolean(hasUser && !walletError && wallet && !wallet.isStale);
  const poolAvailable = Boolean(
    hasUser && poolSummary && !poolSummary.error && !poolSummary.isStale,
  );
  const hasStaleLedger = transactions.some((t) => Boolean(t.isStale));
  const liveGlobalTransactions =
    ledgerError || hasStaleLedger
      ? []
      : transactions.filter((t) => !t.isStale && t.incomeType === "global_income");
  const ledgerAvailable = Boolean(hasUser && !ledgerError && !hasStaleLedger);
  const hasAnyServerError = Boolean(
    hasUser && !loading && (!walletAvailable || !poolAvailable || !ledgerAvailable),
  );

  const globalIncomeValue = loading
    ? "…"
    : walletAvailable && wallet
      ? `₹${wallet.globalIncome.toFixed(2)}`
      : "—";

  const globalIncomeCaption =
    !loading && !hasUser
      ? "Sign in required"
      : !loading && !walletAvailable
        ? "Server balance unavailable"
        : "Eligible video share";

  const eligibleVideosValue = loading
    ? "…"
    : poolAvailable && poolSummary
      ? poolSummary.eligibleVideoCount
      : "—";

  const eligibleVideosCaption =
    !loading && !hasUser
      ? "Sign in to view pool"
      : !loading && !poolAvailable
        ? "Server summary unavailable"
        : poolSummary
          ? `${poolSummary.distinctCreatorCount} creator${poolSummary.distinctCreatorCount === 1 ? "" : "s"} · Sponsor uploads`
          : "Sponsor uploads only";

  const sharePerVideoValue = loading
    ? "…"
    : poolAvailable && poolSummary
      ? `₹${poolSummary.estimatedEqualSharePerVideo.toFixed(2)}`
      : "—";

  const sharePerVideoCaption =
    !loading && !hasUser
      ? "Sign in required"
      : !loading && !poolAvailable
        ? "Live pool data required"
        : poolSummary?.weightingMode === "ad_earnings_weighted"
          ? "Weighted by Ad Earnings (equal est.)"
          : "Equal floor share per video";

  const distributionStatusCaption =
    !loading && !hasUser
      ? "Awaiting sign-in"
      : hasAnyServerError
        ? "Awaiting server sync"
        : "Server ledger synced";

  const ledgerHeaderSubtitle =
    !loading && hasUser && !ledgerAvailable
      ? "Server ledger unavailable"
      : "Live database ledger records";

  const ledgerEmptyMessage = loading
    ? "Loading live database ledger records…"
    : !hasUser
      ? "Please sign in to view your Global Income balance, eligible video count, and ledger entries."
      : !ledgerAvailable
        ? "Server ledger unavailable. Live Global Income entries could not be verified from the server."
        : "No global income distributions found for this account. Distributions occur automatically when users upload Sponsor Videos.";

  return {
    walletAvailable,
    poolAvailable,
    ledgerAvailable,
    hasAnyServerError,
    globalIncomeValue,
    globalIncomeCaption,
    eligibleVideosValue,
    eligibleVideosCaption,
    sharePerVideoValue,
    sharePerVideoCaption,
    distributionStatusCaption,
    ledgerHeaderSubtitle,
    visibleTransactions: !loading && ledgerAvailable ? liveGlobalTransactions : [],
    ledgerEmptyMessage,
  };
}

/**
 * Checks if a premium transaction sequence number is a Special Transaction:
 * 11th, 21st, 31st, 41st, 51st... and every 10th transaction after 11th.
 * Formula: transactionNumber >= 11 AND (transactionNumber - 11) % 10 === 0
 */
export function isSpecialGlobalTransaction(txNumber: number): boolean {
  if (txNumber < 11) return false;
  return (txNumber - 11) % 10 === 0;
}

/**
 * WITHDRAWAL LIMITS & RULES
 * - Minimum withdrawal amount: ₹100
 * - Maximum withdrawal amount: ₹10,000 per day
 * - Deductions: 18% GST + 2% PG fee = 20% Total Deduction
 * - Net Payout: 80%
 * - If daily withdrawal total reaches ₹10,000, further withdrawals are blocked until next day
 */
export const WITHDRAWAL_RULES = {
  MIN_AMOUNT: 100, // ₹100 minimum
  MAX_DAILY_LIMIT: 10000, // ₹10,000 per day maximum
} as const;

export const WITHDRAWAL_CHARGES = {
  GST_RATE: 0.18, // 18% GST on full withdrawal amount
  PG_FEE_RATE: 0.02, // 2% PG fee on full withdrawal amount
  TOTAL_DEDUCTION_RATE: 0.2, // 20% total deduction
  NET_PAYOUT_RATE: 0.8, // 80% net payout
} as const;

export interface WithdrawalChargesBreakdown {
  grossAmount: number;
  gstRatePercent: number;
  gstAmount: number;
  pgFeePercent: number;
  pgFeeAmount: number;
  totalDeductionPercent: number;
  totalCharge: number;
  netPayable: number;
  baseProcessing?: number;
  adminAllocation?: number;
}

export function calculateWithdrawalBreakdown(amount: number): WithdrawalChargesBreakdown {
  const grossAmount = Math.max(0, Number(amount) || 0);
  const gstAmount = Math.round(grossAmount * WITHDRAWAL_CHARGES.GST_RATE * 100) / 100;
  const pgFeeAmount = Math.round(grossAmount * WITHDRAWAL_CHARGES.PG_FEE_RATE * 100) / 100;
  const totalCharge = Math.round((gstAmount + pgFeeAmount) * 100) / 100;
  const netPayable = Math.max(0, Math.round((grossAmount - totalCharge) * 100) / 100);
  return {
    grossAmount,
    gstRatePercent: 18,
    gstAmount,
    pgFeePercent: 2,
    pgFeeAmount,
    totalDeductionPercent: 20,
    totalCharge,
    netPayable,
    baseProcessing: 0,
    adminAllocation: 0,
  };
}

export async function getDailyWithdrawnAmount(userId: string, dateStr?: string): Promise<number> {
  const norm = userId.trim().toUpperCase();
  const targetDate = dateStr || new Date().toISOString().split("T")[0];
  const allTxs = await getUserLedger(norm);
  const dailyWithdrawals = allTxs.filter((tx) => {
    if (tx.incomeType !== "withdrawal") return false;
    const txDate = tx.createdAt.split("T")[0];
    return txDate === targetDate && tx.status !== "failed";
  });
  return dailyWithdrawals.reduce((sum, tx) => sum + Math.abs(tx.amount), 0);
}

export interface WithdrawalValidationResult {
  valid: boolean;
  error?: string | undefined;
  alreadyWithdrawnToday: number;
  remainingDailyLimit: number;
  currentBalance: number;
  breakdown?: WithdrawalChargesBreakdown | undefined;
}

export async function validateWithdrawalRequest(
  userId: string,
  amount: number,
): Promise<WithdrawalValidationResult> {
  const norm = userId.trim().toUpperCase();
  const wallet = await getUserWallet(norm);
  const alreadyWithdrawnToday = await getDailyWithdrawnAmount(norm);
  const remainingDailyLimit = Math.max(0, WITHDRAWAL_RULES.MAX_DAILY_LIMIT - alreadyWithdrawnToday);
  const breakdown = calculateWithdrawalBreakdown(amount);

  if (isNaN(amount) || amount <= 0) {
    return {
      valid: false,
      error: "Please enter a valid withdrawal amount.",
      alreadyWithdrawnToday,
      remainingDailyLimit,
      currentBalance: wallet.balance,
      breakdown,
    };
  }

  // Minimum withdrawal amount check: ₹100
  if (amount < WITHDRAWAL_RULES.MIN_AMOUNT) {
    return {
      valid: false,
      error: `Minimum withdrawal amount is ₹${WITHDRAWAL_RULES.MIN_AMOUNT.toLocaleString("en-IN")}. You cannot withdraw less than ₹100.`,
      alreadyWithdrawnToday,
      remainingDailyLimit,
      currentBalance: wallet.balance,
      breakdown,
    };
  }

  // Check if daily total already reached ₹10,000
  if (alreadyWithdrawnToday >= WITHDRAWAL_RULES.MAX_DAILY_LIMIT) {
    return {
      valid: false,
      error: `Daily withdrawal limit of ₹${WITHDRAWAL_RULES.MAX_DAILY_LIMIT.toLocaleString("en-IN")} reached. Further withdrawals are blocked until tomorrow.`,
      alreadyWithdrawnToday,
      remainingDailyLimit: 0,
      currentBalance: wallet.balance,
    };
  }

  // Check if adding this amount exceeds daily ₹10,000 limit
  if (alreadyWithdrawnToday + amount > WITHDRAWAL_RULES.MAX_DAILY_LIMIT) {
    return {
      valid: false,
      error: `Daily limit exceeded. You have already withdrawn ₹${alreadyWithdrawnToday.toLocaleString("en-IN")} today. You can withdraw at most ₹${remainingDailyLimit.toLocaleString("en-IN")} more today.`,
      alreadyWithdrawnToday,
      remainingDailyLimit,
      currentBalance: wallet.balance,
    };
  }

  // Check insufficient balance
  if (wallet.balance < amount) {
    return {
      valid: false,
      error: `Insufficient wallet balance. Your available balance is ₹${wallet.balance.toFixed(2)}, which is less than requested ₹${amount.toLocaleString("en-IN")}.`,
      alreadyWithdrawnToday,
      remainingDailyLimit,
      currentBalance: wallet.balance,
    };
  }

  return {
    valid: true,
    alreadyWithdrawnToday,
    remainingDailyLimit: remainingDailyLimit - amount,
    currentBalance: wallet.balance,
  };
}

export interface ProcessWithdrawalResult {
  success: boolean;
  error?: string | undefined;
  transaction?: LedgerTransaction | undefined;
  updatedWallet?: UserWallet | undefined;
}

export async function processWithdrawal(
  userId: string,
  amount: number,
  bankDetails?: {
    accountHolder?: string;
    accountNumber?: string;
    ifscCode?: string;
    upiId?: string;
    bankName?: string;
  },
  options?: { signal?: AbortSignal },
): Promise<ProcessWithdrawalResult> {
  const norm = userId.trim().toUpperCase();
  const validation = await validateWithdrawalRequest(norm, amount);
  if (!validation.valid) {
    return {
      success: false,
      error: validation.error || "Withdrawal validation failed",
    };
  }

  // 1. Prepare bank payload
  let withdrawBankPayload:
    | {
        accountHolder?: string;
        accountNumber?: string;
        ifscCode?: string;
        upiId?: string;
        bankName?: string;
      }
    | undefined = undefined;

  if (bankDetails) {
    const payload: {
      accountHolder?: string;
      accountNumber?: string;
      ifscCode?: string;
      upiId?: string;
      bankName?: string;
    } = {};
    if (bankDetails.accountHolder !== undefined && bankDetails.accountHolder !== "") {
      payload.accountHolder = bankDetails.accountHolder;
    }
    if (bankDetails.accountNumber !== undefined && bankDetails.accountNumber !== "") {
      payload.accountNumber = bankDetails.accountNumber;
    }
    if (bankDetails.ifscCode !== undefined && bankDetails.ifscCode !== "") {
      payload.ifscCode = bankDetails.ifscCode;
    }
    if (bankDetails.upiId !== undefined && bankDetails.upiId !== "") {
      payload.upiId = bankDetails.upiId;
    }
    if (bankDetails.bankName !== undefined && bankDetails.bankName !== "") {
      payload.bankName = bankDetails.bankName;
    }
    if (Object.keys(payload).length > 0) {
      withdrawBankPayload = payload;
    }
  }

  // 2. Authoritative Server Call: Submit withdrawal to the Hostinger / MySQL backend
  let res: {
    success: boolean;
    error?: string;
    message?: string;
    transaction?: any;
    updatedWallet?: any;
  };

  try {
    res = await api.wallet.withdraw(
      {
        userId: norm,
        amount,
        ...(withdrawBankPayload !== undefined ? { bankDetails: withdrawBankPayload } : {}),
      },
      options?.signal ? { signal: options.signal } : undefined,
    );
  } catch (err: unknown) {
    const errorMsg =
      err instanceof Error ? err.message : "Server connection failed or response was invalid.";
    const isAbortOrTimeout =
      err instanceof Error &&
      (err.name === "AbortError" ||
        err.name === "TimeoutError" ||
        err.message.toLowerCase().includes("aborted") ||
        err.message.toLowerCase().includes("timeout") ||
        err.message.toLowerCase().includes("timed out"));

    const isNetworkError =
      err instanceof Error &&
      (err.name === "TypeError" ||
        err.message.toLowerCase().includes("fetch") ||
        err.message.toLowerCase().includes("network") ||
        err.message.toLowerCase().includes("econnrefused") ||
        err.message.toLowerCase().includes("enotfound"));

    console.error("[Withdrawal Service Error] API withdrawal failed:", err);

    let specificError: string;
    if (isAbortOrTimeout) {
      specificError =
        "Withdrawal request timed out or was aborted before confirmation. The server might have processed the withdrawal. Please check your transaction history before trying again to avoid duplicate withdrawals.";
    } else if (isNetworkError) {
      specificError = `Withdrawal status could not be confirmed due to a network connection failure (${errorMsg}). The server might have processed the withdrawal. Please check your transaction history before trying again.`;
    } else {
      specificError = `Withdrawal status could not be verified by server: ${errorMsg}. The server might have processed the withdrawal. Please check your transaction history before trying again.`;
    }

    return {
      success: false,
      error: specificError,
    };
  }

  // 3. Strict verification: Never treat unconfirmed or failed responses as successful
  if (!res || !res.success) {
    const errorMsg =
      res?.error ||
      res?.message ||
      "Withdrawal was declined by server. No funds were deducted from your wallet.";
    return {
      success: false,
      error: errorMsg,
    };
  }

  // 4. Server confirmed: apply confirmed deductions and ledger record
  const breakdown = calculateWithdrawalBreakdown(amount);
  const destinationDesc = bankDetails?.upiId
    ? `UPI: ${bankDetails.upiId}`
    : bankDetails?.accountNumber
      ? `Bank: ${bankDetails.bankName || "Account"} (****${bankDetails.accountNumber.slice(-4)})`
      : "Direct Bank Settlement";

  const confirmedTxId =
    res.transaction?.transaction_id ||
    res.transaction?.id ||
    `TX_WD_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

  const tx: LedgerTransaction = {
    id: `wd-tx-${Date.now()}`,
    transactionId: confirmedTxId,
    userId: norm,
    incomeType: "withdrawal",
    amount: -amount,
    fee: breakdown.totalCharge,
    netAmount: breakdown.netPayable,
    status: "settled",
    description: `Withdrawal payout to ${destinationDesc} - Requested: ₹${amount.toLocaleString("en-IN")}, Admin/GST Charges: ₹${breakdown.totalCharge}, Net Payable: ₹${breakdown.netPayable.toLocaleString("en-IN")}`,
    createdAt: new Date().toISOString(),
    isStale: false,
  };

  const ledger = getStoredLedger();
  ledger.unshift(tx);
  saveStoredLedger(ledger);

  const wallets = getStoredWallets();
  const currentWallet = wallets[norm] || (await getUserWallet(norm));

  let updatedWallet: UserWallet;
  if (res.updatedWallet) {
    const rawAdmobIncome =
      res.updatedWallet.admob_income !== undefined && res.updatedWallet.admob_income !== null
        ? res.updatedWallet.admob_income
        : res.updatedWallet.admobIncome !== undefined && res.updatedWallet.admobIncome !== null
          ? res.updatedWallet.admobIncome
          : undefined;
    const resolvedAdmobIncome =
      rawAdmobIncome !== undefined
        ? Number(rawAdmobIncome) || 0
        : Number(currentWallet.admobIncome) || 0;

    updatedWallet = {
      userId: norm,
      balance: Number(res.updatedWallet.balance) || 0,
      totalEarned:
        Number(res.updatedWallet.total_earned || res.updatedWallet.totalEarned) ||
        currentWallet.totalEarned,
      totalWithdrawn:
        Number(res.updatedWallet.total_withdrawn || res.updatedWallet.totalWithdrawn) ||
        currentWallet.totalWithdrawn + amount,
      referralIncome:
        Number(res.updatedWallet.referral_income || res.updatedWallet.referralIncome) ||
        currentWallet.referralIncome,
      globalIncome:
        Number(res.updatedWallet.global_income || res.updatedWallet.globalIncome) ||
        currentWallet.globalIncome,
      adsenseIncome:
        Number(res.updatedWallet.adsense_income || res.updatedWallet.adsenseIncome) ||
        currentWallet.adsenseIncome,
      admobIncome: resolvedAdmobIncome,
      affiliateIncome:
        Number(res.updatedWallet.affiliate_income || res.updatedWallet.affiliateIncome) ||
        currentWallet.affiliateIncome,
      updatedAt:
        res.updatedWallet.updated_at || res.updatedWallet.updatedAt || new Date().toISOString(),
      isStale: false,
    };
  } else {
    updatedWallet = {
      ...currentWallet,
      admobIncome: Number(currentWallet.admobIncome) || 0,
      balance: Math.max(0, currentWallet.balance - amount),
      totalWithdrawn: currentWallet.totalWithdrawn + amount,
      updatedAt: new Date().toISOString(),
      isStale: false,
    };
  }

  wallets[norm] = updatedWallet;
  saveStoredWallets(wallets);

  return { success: true, transaction: tx, updatedWallet };
}
