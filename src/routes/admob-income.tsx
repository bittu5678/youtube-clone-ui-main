import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Smartphone,
  DollarSign,
  BarChart3,
  ShieldCheck,
  ArrowRight,
  Layers,
  Award,
  AlertCircle,
  Lock,
} from "lucide-react";
import { VideoHubLayout } from "@/components/videohub/VideoHubLayout";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { isNativeAndroid } from "@/lib/admob-service";
import {
  calculateTotalAdEarning,
  getAuthoritativeUserWallet,
  type UserWallet,
} from "@/lib/ledger-service";

export const Route = createFileRoute("/admob-income")({
  head: () => ({
    meta: [
      { title: "AdMob Income — FaceTube Android App" },
      {
        name: "description",
        content:
          "Track verified Google AdMob earnings, Android app impressions, eCPM, and monthly finalized statement payouts on FaceTube.",
      },
    ],
  }),
  component: AdMobIncomePage,
});

function AdMobIncomePage() {
  const { user, profile, dbUser, isLoading: authLoading } = useAuth();
  const userId = profile?.user_id || dbUser?.user_id || (user as any)?.user_id || "";
  const [wallet, setWallet] = useState<UserWallet | null>(null);
  const [admobTransactions, setAdmobTransactions] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isAndroid, setIsAndroid] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setIsAndroid(isNativeAndroid());
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!userId) {
      setWallet(null);
      setAdmobTransactions([]);
      setErrorMessage(null);
      setIsLoading(false);
      return;
    }

    let isMounted = true;
    async function loadData() {
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const [walletRes, txRes] = await Promise.all([
          getAuthoritativeUserWallet(userId),
          api.wallet.getTransactions(userId, 100),
        ]);
        if (!isMounted) return;

        if (walletRes.wallet) {
          setWallet(walletRes.wallet);
        } else {
          setWallet(null);
          setErrorMessage(
            walletRes.error || "Unable to load authoritative wallet balance from server.",
          );
        }

        if (txRes && txRes.success && Array.isArray(txRes.transactions)) {
          const filtered = txRes.transactions.filter((t: any) => {
            const type = String(t.income_type || t.incomeType || t.purpose || "")
              .trim()
              .toLowerCase();
            return type === "admob_income";
          });
          setAdmobTransactions(filtered);
        } else {
          setAdmobTransactions([]);
          if (!walletRes.error) {
            setErrorMessage("Unable to load AdMob statement transactions from server.");
          }
        }
      } catch (err) {
        console.error("Failed to load user AdMob data:", err);
        if (isMounted) {
          setWallet(null);
          setAdmobTransactions([]);
          setErrorMessage(err instanceof Error ? err.message : "Failed to load AdMob income data.");
        }
      } finally {
        if (isMounted) setIsLoading(false);
      }
    }
    loadData();
    return () => {
      isMounted = false;
    };
  }, [authLoading, userId]);

  const admobRevenue = wallet ? Number(wallet.admobIncome ?? 0) : null;
  const adsenseRevenue = wallet ? Number(wallet.adsenseIncome ?? 0) : null;
  const totalAdEarning = wallet ? calculateTotalAdEarning(wallet) : null;

  // Group verified transactions by month
  const monthlyEarningsMap: Record<string, number> = {};
  for (const tx of admobTransactions) {
    const date = new Date(tx.created_at || tx.createdAt || Date.now());
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const amount = Number(tx.amount || tx.netAmount || 0);
    monthlyEarningsMap[monthKey] = (monthlyEarningsMap[monthKey] || 0) + amount;
  }
  const currentMonthKey = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
  const currentMonthEarnings = wallet ? monthlyEarningsMap[currentMonthKey] || 0 : null;

  // Approximate metrics derived only from genuine recorded statements
  const totalStatements = admobTransactions.length;

  const formatMetric = (value: number | null) => {
    if (isLoading) return "...";
    if (value === null) return "Unavailable";
    return `₹${value.toFixed(2)}`;
  };

  return (
    <VideoHubLayout>
      <div className="px-4 py-6 sm:px-6 lg:px-8 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
          <div className="flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-blue-500/10 text-blue-400">
              <Smartphone className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl">
                  Google AdMob Income
                </h1>
                <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2.5 py-0.5 text-[11px] font-bold text-blue-400">
                  Android Native
                </span>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Monetization from FaceTube Android native Banner, Interstitial, and Rewarded ads.
                Finalized statement earnings credited directly to your wallet.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Link
              to="/wallet-balance"
              className="inline-flex items-center justify-center gap-2 rounded-full bg-brand px-4 py-2 text-xs font-bold text-white shadow-lift transition hover:bg-brand-dark active:scale-95"
            >
              Withdraw Earnings
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>

        {!authLoading && !userId && (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 text-xs text-amber-200">
              <Lock className="h-4 w-4 text-amber-400 shrink-0" />
              <span>Sign in to view your authoritative AdMob earnings and statement history.</span>
            </div>
            <Link
              to="/login"
              className="inline-flex items-center justify-center rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-bold text-black hover:bg-amber-400"
            >
              Sign In
            </Link>
          </div>
        )}

        {errorMessage && (
          <div className="rounded-2xl border border-destructive/40 bg-destructive/10 p-4 flex items-center gap-2.5 text-xs text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Runtime Environment Banner */}
        <div className="rounded-2xl border border-border/80 bg-card p-4 sm:p-5 shadow-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-secondary text-foreground">
                <ShieldCheck className="h-5 w-5 text-emerald-400" />
              </div>
              <div>
                <div className="text-sm font-bold text-foreground">
                  AdMob Policy & Integrity Architecture
                </div>
                <div className="text-xs text-muted-foreground">
                  {isAndroid
                    ? "Active Android Native Container detected. AdMob SDK is operational."
                    : "Browsing in Web / Desktop mode. AdMob ads display exclusively in the native Android application."}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-400">
                <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                Verified Statements Only
              </span>
            </div>
          </div>
        </div>

        {/* Summary Stat Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          {/* Card 1: Total Finalized Earnings */}
          <div className="rounded-2xl border border-border bg-card p-5 shadow-card">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Finalized AdMob Balance
              </span>
              <div className="grid h-8 w-8 place-items-center rounded-lg bg-blue-500/10 text-blue-400">
                <DollarSign className="h-4 w-4" />
              </div>
            </div>
            <div className="text-2xl font-black text-foreground font-mono">
              {formatMetric(admobRevenue)}
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              Credited to wallet from verified Google statements
            </p>
          </div>

          {/* Card 2: Total Ad Earning (AdSense + AdMob) */}
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-5 shadow-card">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">
                Total Ad Earning
              </span>
              <div className="grid h-8 w-8 place-items-center rounded-lg bg-emerald-500/15 text-emerald-400">
                <DollarSign className="h-4 w-4" />
              </div>
            </div>
            <div className="text-2xl font-black text-emerald-400 font-mono">
              {formatMetric(totalAdEarning)}
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              {wallet
                ? `AdSense ₹${(adsenseRevenue ?? 0).toFixed(2)} + AdMob ₹${(admobRevenue ?? 0).toFixed(2)}`
                : "Verified AdSense + AdMob only"}
            </p>
          </div>

          {/* Card 3: Current Month Earnings */}
          <div className="rounded-2xl border border-border bg-card p-5 shadow-card">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                This Month's Statement
              </span>
              <div className="grid h-8 w-8 place-items-center rounded-lg bg-emerald-500/10 text-emerald-400">
                <BarChart3 className="h-4 w-4" />
              </div>
            </div>
            <div className="text-2xl font-black text-emerald-400 font-mono">
              {formatMetric(currentMonthEarnings)}
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              Cycle: {currentMonthKey} (Finalized)
            </p>
          </div>

          {/* Card 4: Ad Formats Integrated */}
          <div className="rounded-2xl border border-border bg-card p-5 shadow-card">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Ad Formats Active
              </span>
              <div className="grid h-8 w-8 place-items-center rounded-lg bg-purple-500/10 text-purple-400">
                <Layers className="h-4 w-4" />
              </div>
            </div>
            <div className="text-2xl font-black text-foreground font-mono">3 Units</div>
            <p className="text-[11px] text-muted-foreground mt-1">
              Banner, Interstitial & Rewarded
            </p>
          </div>

          {/* Card 5: Statements Processed */}
          <div className="rounded-2xl border border-border bg-card p-5 shadow-card">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Statements Credited
              </span>
              <div className="grid h-8 w-8 place-items-center rounded-lg bg-amber-500/10 text-amber-400">
                <Award className="h-4 w-4" />
              </div>
            </div>
            <div className="text-2xl font-black text-foreground font-mono">
              {isLoading ? "..." : !userId || wallet === null ? "—" : totalStatements}
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">Monthly audit transactions</p>
          </div>
        </div>

        {/* AdMob Supported Formats Overview */}
        <div className="rounded-2xl border border-border bg-card p-5 shadow-card space-y-3">
          <h2 className="text-base font-extrabold text-foreground">
            Android Ad Placement Pathways
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-1">
            <div className="rounded-xl border border-border/60 bg-secondary/30 p-4">
              <div className="text-xs font-bold text-foreground flex items-center justify-between">
                <span>1. Bottom Banner Ads</span>
                <span className="text-[10px] text-blue-400 font-bold uppercase">Passive</span>
              </div>
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                Rendered at the bottom margin of mobile screens on Home feed & Explore page without
                overlapping navigation.
              </p>
            </div>
            <div className="rounded-xl border border-border/60 bg-secondary/30 p-4">
              <div className="text-xs font-bold text-foreground flex items-center justify-between">
                <span>2. Interstitial Ads</span>
                <span className="text-[10px] text-purple-400 font-bold uppercase">Transition</span>
              </div>
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                Appears exclusively during natural view transitions. Strictly policy-protected to
                never interrupt active video playback.
              </p>
            </div>
            <div className="rounded-xl border border-border/60 bg-secondary/30 p-4">
              <div className="text-xs font-bold text-foreground flex items-center justify-between">
                <span>3. Rewarded Video Ads</span>
                <span className="text-[10px] text-emerald-400 font-bold uppercase">Opt-In</span>
              </div>
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                User-initiated rewarded ads allowing creators and viewers to earn promotional
                discounts or booster visibility credits.
              </p>
            </div>
          </div>
        </div>

        {/* Verified Earnings History */}
        <div className="rounded-2xl border border-border bg-card p-5 shadow-card space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-extrabold text-foreground">
                Verified Statement Earnings History
              </h2>
              <p className="text-xs text-muted-foreground">
                Idempotent monthly finalized performance statements recorded into your ledger
              </p>
            </div>
            <span className="text-xs font-semibold text-muted-foreground">
              {admobTransactions.length} records
            </span>
          </div>

          {isLoading ? (
            <div className="py-8 text-center text-xs text-muted-foreground animate-pulse">
              Loading verified statement history...
            </div>
          ) : admobTransactions.length === 0 ? (
            <div className="py-12 text-center rounded-xl border border-dashed border-border/80 p-6">
              <Smartphone className="h-10 w-10 mx-auto text-muted-foreground/40 mb-3" />
              <h3 className="text-sm font-bold text-foreground">No Finalized Statements Yet</h3>
              <p className="text-xs text-muted-foreground max-w-md mx-auto mt-1">
                Google AdMob finalizes monthly performance earnings at the end of each billing
                cycle. Once finalized, verified earnings will automatically reflect here and in your
                wallet balance.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {admobTransactions.map((tx: any) => (
                <div
                  key={tx.id || tx.transaction_id || tx.transactionId}
                  className="py-3 flex items-center justify-between"
                >
                  <div>
                    <div className="text-xs font-bold text-foreground">
                      {tx.description || "Google AdMob Monthly Statement"}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {new Date(tx.created_at || tx.createdAt).toLocaleDateString()} · ID:{" "}
                      {tx.transaction_id || tx.transactionId || tx.id}
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-sm font-black text-emerald-400 font-mono">
                      +₹{Number(tx.amount || tx.netAmount || 0).toFixed(2)}
                    </span>
                    <span className="text-[10px] text-muted-foreground block uppercase">
                      {tx.status || "settled"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </VideoHubLayout>
  );
}
