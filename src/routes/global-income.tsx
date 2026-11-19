import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Globe2, TrendingUp, CheckCircle2, Wallet } from "lucide-react";
import { VideoHubLayout } from "@/components/videohub/VideoHubLayout";
import { useAuth } from "@/lib/auth-context";
import {
  getUserLedger,
  getUserWallet,
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
  const [globalTransactions, setGlobalTransactions] = useState<LedgerTransaction[]>([]);
  const [poolSummary, setPoolSummary] = useState<GlobalPoolSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) {
      setLoading(true);
      return;
    }

    if (!userId) {
      setWallet(null);
      setGlobalTransactions([]);
      setPoolSummary(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    Promise.all([getUserWallet(userId), getUserLedger(userId), getGlobalPoolSummary(userId)])
      .then(([w, ledger, summary]) => {
        if (cancelled) return;
        setWallet(w);
        setGlobalTransactions(ledger.filter((t) => t.incomeType === "global_income"));
        setPoolSummary(summary);
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
                Automated platform revenue share distributed per eligible Premium Video from the
                ₹3.00 Global Pool
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
        {/* REQUIREMENT 8: SPONSOR VIDEO ALLOCATION OVERVIEW                  */}
        {/* ------------------------------------------------------------------ */}
        <div className="rounded-3xl border border-cyan-500/40 bg-gradient-to-br from-cyan-500/10 via-card to-card p-6 shadow-card space-y-5">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border/70 pb-4">
            <div>
              <span className="text-[11px] font-bold uppercase tracking-wider text-cyan-400">
                Database-Driven Rule
              </span>
              <h2 className="text-xl font-black text-foreground mt-0.5">
                Sponsor Video Allocation Overview
              </h2>
            </div>
            <span className="text-xs font-semibold text-muted-foreground font-mono">
              Server-authoritative calculation
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            {/* ₹1 Direct Referrer */}
            <div className="rounded-2xl border border-border bg-background/60 p-4 space-y-1">
              <span className="text-muted-foreground text-[11px] block">Direct Referrer</span>
              <div className="text-xl font-black text-emerald-400">₹1.00</div>
              <p className="text-[11px] text-muted-foreground">
                Direct commission to frontline inviter
              </p>
            </div>

            {/* ₹1 Admin Allocation */}
            <div className="rounded-2xl border border-border bg-background/60 p-4 space-y-1">
              <span className="text-muted-foreground text-[11px] block">Admin Allocation</span>
              <div className="text-xl font-black text-foreground">₹1.00</div>
              <p className="text-[11px] text-muted-foreground">Company infrastructure & servers</p>
            </div>
          </div>
        </div>

        {/* Financial Highlights */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">Your Global Income</span>
            <p className="text-2xl font-black text-cyan-400">
              {loading ? "…" : !userId ? "—" : `₹${(wallet?.globalIncome ?? 0).toFixed(2)}`}
            </p>
            <p className="text-[11px] text-emerald-400 font-semibold flex items-center gap-1">
              <TrendingUp className="h-3 w-3" />{" "}
              {!loading && !userId
                ? "Sign in required"
                : wallet?.isStale
                  ? "Cached server balance"
                  : "Eligible video share"}
            </p>
          </div>

          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">Eligible Videos</span>
            <p className="text-2xl font-black text-foreground">
              {loading
                ? "…"
                : poolSummary && !poolSummary.error
                  ? poolSummary.eligibleVideoCount
                  : "—"}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {!loading && !userId
                ? "Sign in to view pool"
                : poolSummary?.error
                  ? "Server summary unavailable"
                  : poolSummary
                    ? `${poolSummary.distinctCreatorCount} creator${poolSummary.distinctCreatorCount === 1 ? "" : "s"} · Sponsor uploads`
                    : "Sponsor uploads only"}
            </p>
          </div>

          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">Share Per Video</span>
            <p className="text-2xl font-black text-foreground">
              {loading
                ? "…"
                : poolSummary && !poolSummary.error
                  ? `₹${poolSummary.estimatedEqualSharePerVideo.toFixed(2)}`
                  : "—"}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {!loading && !userId
                ? "Sign in required"
                : poolSummary?.error
                  ? "Live pool data required"
                  : poolSummary?.weightingMode === "ad_earnings_weighted"
                    ? "Weighted by Ad Earnings (equal est.)"
                    : "Equal floor share per video"}
            </p>
          </div>

          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">Distribution Status</span>
            <p className="text-2xl font-black text-emerald-400">Automated</p>
            <p className="text-[11px] text-muted-foreground">
              {!loading && !userId
                ? "Awaiting sign-in"
                : poolSummary?.error
                  ? "Awaiting server sync"
                  : "Server ledger synced"}
            </p>
          </div>
        </div>

        {/* Global Income Ledger Transactions */}
        <div className="rounded-2xl border border-border bg-card overflow-hidden shadow-card">
          <div className="p-4 border-b border-border flex items-center justify-between">
            <h3 className="text-sm font-bold text-foreground">Global Income Ledger Entries</h3>
            <span className="text-xs text-muted-foreground">Live database ledger records</span>
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
                {globalTransactions.length > 0 ? (
                  globalTransactions.map((tx) => (
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
                      {!loading && !userId
                        ? "Please sign in to view your Global Income balance, eligible video count, and ledger entries."
                        : "No global income distributions found for this account. Distributions occur automatically when users upload Sponsor Videos."}
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
