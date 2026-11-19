import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Globe2, TrendingUp, CheckCircle2, Wallet } from "lucide-react";
import { VideoHubLayout } from "@/components/videohub/VideoHubLayout";
import { useAuth } from "@/lib/auth-context";
import {
  SPONSOR_ALLOCATION_RULES,
  deriveGlobalIncomeDisplayState,
  getAuthoritativeUserLedger,
  getAuthoritativeUserWallet,
  getGlobalPoolSummary,
  type GlobalPoolSummary,
  type LedgerTransaction,
  type UserWallet,
} from "@/lib/ledger-service";

export const Route = createFileRoute("/global-income")({
  head: () => ({
    meta: [
      { title: "Global Income — FaceTube" },
      {
        name: "description",
        content:
          "Worldwide revenue share, database-driven Sponsor Video distributions, and automated creator earnings on FaceTube.",
      },
    ],
  }),
  component: GlobalIncomePage,
});

function GlobalIncomePage() {
  const { profile, dbUser, user, isLoading: authLoading } = useAuth();
  const userId = (
    profile?.user_id ||
    dbUser?.user_id ||
    user?.user_id ||
    user?.user_metadata?.user_id ||
    ""
  ).trim();

  const [wallet, setWallet] = useState<UserWallet | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [globalTransactions, setGlobalTransactions] = useState<LedgerTransaction[]>([]);
  const [ledgerError, setLedgerError] = useState<string | null>(null);
  const [poolSummary, setPoolSummary] = useState<GlobalPoolSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) {
      setLoading(true);
      return;
    }

    if (!userId) {
      setWallet(null);
      setWalletError(null);
      setGlobalTransactions([]);
      setLedgerError(null);
      setPoolSummary(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setWalletError(null);
    setLedgerError(null);
    Promise.all([
      getAuthoritativeUserWallet(userId),
      getAuthoritativeUserLedger(userId),
      getGlobalPoolSummary(userId),
    ])
      .then(([walletRes, ledgerRes, summary]) => {
        if (cancelled) return;
        if (walletRes.error || !walletRes.wallet || walletRes.wallet.isStale) {
          setWallet(null);
          setWalletError(walletRes.error || "Server balance unavailable");
        } else {
          setWallet(walletRes.wallet);
          setWalletError(null);
        }

        if (ledgerRes.error) {
          setGlobalTransactions([]);
          setLedgerError(ledgerRes.error);
        } else {
          setGlobalTransactions(
            ledgerRes.transactions.filter((t) => !t.isStale && t.incomeType === "global_income"),
          );
          setLedgerError(null);
        }

        setPoolSummary(summary);
      })
      .catch(() => {
        if (cancelled) return;
        setWallet(null);
        setWalletError("Server balance unavailable");
        setGlobalTransactions([]);
        setLedgerError("Server ledger unavailable");
        setPoolSummary(null);
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [authLoading, userId]);

  const viewState = deriveGlobalIncomeDisplayState({
    loading,
    userId,
    wallet,
    walletError,
    transactions: globalTransactions,
    ledgerError,
    poolSummary,
  });

  const normalBuckets = SPONSOR_ALLOCATION_RULES.normalWithReferrer;
  const noRefBuckets = SPONSOR_ALLOCATION_RULES.normalWithoutReferrer;
  const specialRules = SPONSOR_ALLOCATION_RULES.specialTransactions;

  return (
    <VideoHubLayout>
      <div className="px-4 py-6 sm:px-6 lg:px-8 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
          <div className="flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-cyan-500/10 text-cyan-400">
              <Globe2 className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl">
                  Global Income
                </h1>
                <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-0.5 text-[10px] font-bold text-cyan-400">
                  Automated Allocation
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                Automated platform revenue share distributed per eligible Premium Video from the ₹
                {normalBuckets.globalPool.toFixed(2)} Global Pool
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Link
              to="/wallet-balance"
              className="inline-flex items-center justify-center gap-2 rounded-full bg-brand px-4 py-2 text-xs font-bold text-white shadow-lift transition hover:bg-brand-dark active:scale-95"
            >
              <Wallet className="h-3.5 w-3.5" />
              Transfer to Wallet
            </Link>
          </div>
        </div>

        {/* ------------------------------------------------------------------ */}
        {/* SPONSOR VIDEO ₹6.00 ALLOCATION OVERVIEW (ALL 4 BUCKETS + RULES)     */}
        {/* ------------------------------------------------------------------ */}
        <div className="rounded-3xl border border-cyan-500/40 bg-gradient-to-br from-cyan-500/10 via-card to-card p-6 shadow-card space-y-5">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border/70 pb-4">
            <div>
              <span className="text-[11px] font-bold uppercase tracking-wider text-cyan-400">
                Database-Driven Rule · Normal ₹{normalBuckets.total.toFixed(2)} Breakdown (With
                Referrer)
              </span>
              <h2 className="text-xl font-black text-foreground mt-0.5">
                Sponsor Video Allocation Overview
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
              <span className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 font-bold text-cyan-300">
                Total: ₹{normalBuckets.total.toFixed(2)}
              </span>
              <span className="text-muted-foreground font-semibold">
                Server-authoritative calculation
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
            {/* ₹1 Direct Referral */}
            <div className="rounded-2xl border border-border bg-background/60 p-4 space-y-1">
              <span className="text-muted-foreground text-[11px] block">Direct Referral</span>
              <div className="text-xl font-black text-emerald-400">
                ₹{normalBuckets.directReferral.toFixed(2)}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Direct commission to verified frontline inviter
              </p>
            </div>

            {/* ₹1 Admin Allocation */}
            <div className="rounded-2xl border border-border bg-background/60 p-4 space-y-1">
              <span className="text-muted-foreground text-[11px] block">Admin Allocation</span>
              <div className="text-xl font-black text-foreground">
                ₹{normalBuckets.admin.toFixed(2)}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Platform operations &amp; infrastructure
              </p>
            </div>

            {/* ₹1 GST + Payment Gateway */}
            <div className="rounded-2xl border border-border bg-background/60 p-4 space-y-1">
              <span className="text-muted-foreground text-[11px] block">GST + Payment Gateway</span>
              <div className="text-xl font-black text-amber-300">
                ₹{normalBuckets.gstAndPg.toFixed(2)}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Statutory GST &amp; Razorpay processing share
              </p>
            </div>

            {/* ₹3 Global Income Pool */}
            <div className="rounded-2xl border border-cyan-500/30 bg-background/60 p-4 space-y-1">
              <span className="text-muted-foreground text-[11px] block">Global Income Pool</span>
              <div className="text-xl font-black text-cyan-400">
                ₹{normalBuckets.globalPool.toFixed(2)}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Shared across eligible Sponsor creator videos
              </p>
            </div>
          </div>

          {/* No-Referrer & Special Transaction Rules */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="rounded-2xl border border-border bg-background/50 p-4 space-y-1.5">
              <div className="font-bold text-foreground">Without Referrer Rule</div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                When a Sponsor upload has no verified referrer, no separate referral payout is made
                (Direct Referral:{" "}
                <span className="font-semibold text-foreground">
                  ₹{noRefBuckets.directReferral.toFixed(2)}
                </span>
                ). The unallocated ₹1.00 referral share goes under{" "}
                <span className="font-semibold text-foreground">
                  Admin (₹{noRefBuckets.admin.toFixed(2)})
                </span>
                , alongside GST + PG (₹{noRefBuckets.gstAndPg.toFixed(2)}) and Global Income Pool (₹
                {noRefBuckets.globalPool.toFixed(2)}) = ₹{noRefBuckets.total.toFixed(2)}.
              </p>
            </div>

            <div className="rounded-2xl border border-purple-500/30 bg-purple-500/5 p-4 space-y-1.5">
              <div className="font-bold text-purple-200">
                Special Transactions ({specialRules.sequencePattern})
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                On every 10th Sponsor transaction starting at #11: Global Pool is{" "}
                <span className="font-semibold text-foreground">
                  ₹{specialRules.globalPool.toFixed(2)}
                </span>
                , GST + PG is{" "}
                <span className="font-semibold text-foreground">
                  ₹{specialRules.gstAndPg.toFixed(2)}
                </span>
                , Admin is{" "}
                <span className="font-semibold text-foreground">
                  ₹{specialRules.withReferrer.admin.toFixed(2)}
                </span>{" "}
                with referrer (Direct Referral ₹
                {specialRules.withReferrer.directReferral.toFixed(2)}) or{" "}
                <span className="font-semibold text-foreground">
                  ₹{specialRules.withoutReferrer.admin.toFixed(2)}
                </span>{" "}
                without referrer (Direct Referral ₹
                {specialRules.withoutReferrer.directReferral.toFixed(2)}).
              </p>
            </div>
          </div>
        </div>

        {/* Financial Highlights */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">Your Global Income</span>
            <p className="text-2xl font-black text-cyan-400">{viewState.globalIncomeValue}</p>
            <p className="text-[11px] text-emerald-400 font-semibold flex items-center gap-1">
              <TrendingUp className="h-3 w-3" /> {viewState.globalIncomeCaption}
            </p>
          </div>

          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">
              Platform Eligible Videos
            </span>
            <p className="text-2xl font-black text-foreground">{viewState.eligibleVideosValue}</p>
            <p className="text-[11px] text-muted-foreground">{viewState.eligibleVideosCaption}</p>
          </div>

          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">Pool Allocation Basis</span>
            <p className="text-2xl font-black text-foreground">{viewState.sharePerVideoValue}</p>
            <p className="text-[11px] text-muted-foreground">{viewState.sharePerVideoCaption}</p>
          </div>

          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">Distribution Status</span>
            <p className="text-2xl font-black text-emerald-400">Automated</p>
            <p className="text-[11px] text-muted-foreground">
              {viewState.distributionStatusCaption}
            </p>
          </div>
        </div>

        {/* Separated Platform-Wide Pool Summary vs. Authenticated User's Eligible Videos */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-2xl border border-border bg-card p-5 space-y-3 shadow-card">
            <div className="flex items-center justify-between gap-2 border-b border-border pb-2.5">
              <div>
                <h3 className="text-sm font-bold text-foreground">
                  Platform-Wide Global Pool Statistics
                </h3>
                <p className="text-[11px] text-muted-foreground">
                  Aggregate totals across all eligible creators (including your eligible videos)
                </p>
              </div>
              <span className="rounded-full border border-border bg-secondary/40 px-2.5 py-0.5 text-[10px] font-bold text-foreground">
                {viewState.weightingModeLabel}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-3 text-xs">
              <div className="rounded-xl border border-border bg-background/50 p-3">
                <span className="text-[11px] text-muted-foreground block">Eligible Videos</span>
                <span className="text-lg font-black text-foreground">
                  {viewState.eligibleVideosValue}
                </span>
              </div>
              <div className="rounded-xl border border-border bg-background/50 p-3">
                <span className="text-[11px] text-muted-foreground block">Active Creators</span>
                <span className="text-lg font-black text-foreground">
                  {viewState.platformCreatorsValue}
                </span>
              </div>
              <div className="rounded-xl border border-border bg-background/50 p-3">
                <span className="text-[11px] text-muted-foreground block">
                  Platform Ad Earnings
                </span>
                <span className="text-lg font-black text-cyan-400">
                  {viewState.platformAdEarningsValue}
                </span>
              </div>
            </div>

            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {viewState.weightingModeDescription}
            </p>
          </div>

          <div className="rounded-2xl border border-border bg-card p-5 space-y-3 shadow-card">
            <div className="flex items-center justify-between gap-2 border-b border-border pb-2.5">
              <div>
                <h3 className="text-sm font-bold text-foreground">Your Eligible Sponsor Videos</h3>
                <p className="text-[11px] text-muted-foreground">
                  Metrics strictly scoped to your authenticated account
                </p>
              </div>
              <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2.5 py-0.5 text-[10px] font-bold text-cyan-400">
                Your Account
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="rounded-xl border border-border bg-background/50 p-3 space-y-1">
                <span className="text-[11px] text-muted-foreground block">
                  Your Eligible Videos
                </span>
                <span className="text-lg font-black text-foreground block">
                  {viewState.userEligibleVideosValue}
                </span>
                <span className="text-[11px] text-muted-foreground block">
                  {viewState.userEligibleVideosCaption}
                </span>
              </div>
              <div className="rounded-xl border border-border bg-background/50 p-3 space-y-1">
                <span className="text-[11px] text-muted-foreground block">
                  Your Eligible Ad Earnings
                </span>
                <span className="text-lg font-black text-emerald-400 block">
                  {viewState.userAdEarningsValue}
                </span>
                <span className="text-[11px] text-muted-foreground block">
                  {viewState.userAdEarningsCaption}
                </span>
              </div>
            </div>

            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Other creators&apos; individual earnings are never exposed. When you upload a new
              Sponsor video, your own videos are still excluded from paying yourself out of that
              same upload&apos;s ₹3.00 pool.
            </p>
          </div>
        </div>

        {/* Global Income Ledger Transactions */}
        <div className="rounded-2xl border border-border bg-card overflow-hidden shadow-card">
          <div className="p-4 border-b border-border flex items-center justify-between">
            <h3 className="text-sm font-bold text-foreground">Global Income Ledger Entries</h3>
            <span className="text-xs text-muted-foreground">{viewState.ledgerHeaderSubtitle}</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-border bg-secondary/40 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 whitespace-nowrap">Transaction ID</th>
                  <th className="px-4 py-3 whitespace-nowrap">Source Member</th>
                  <th className="px-4 py-3 whitespace-nowrap">Description</th>
                  <th className="px-4 py-3 whitespace-nowrap">Tag / Rule</th>
                  <th className="px-4 py-3 whitespace-nowrap">Amount</th>
                  <th className="px-4 py-3 text-right whitespace-nowrap">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border font-medium">
                {viewState.visibleTransactions.length > 0 ? (
                  viewState.visibleTransactions.map((tx) => (
                    <tr key={tx.id} className="transition hover:bg-secondary/20">
                      <td className="px-4 py-3 font-mono text-xs text-cyan-400">
                        {tx.transactionId}
                      </td>
                      <td className="px-4 py-3 text-foreground font-bold">
                        {tx.sourceUserName || tx.sourceUserId || "Global System"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground max-w-sm truncate">
                        {tx.description}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {tx.specialTag ? (
                          <span className="rounded-md bg-purple-500/20 px-2 py-0.5 text-[10px] font-bold text-purple-300 font-mono">
                            {tx.specialTag}
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-[11px]">
                            Normal Distribution
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs font-black text-cyan-400">
                        +₹{tx.amount.toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-bold text-emerald-400">
                          <CheckCircle2 className="h-3 w-3" />
                          Settled
                        </span>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                      {viewState.ledgerEmptyMessage}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </VideoHubLayout>
  );
}
