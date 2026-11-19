import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertCircle, DollarSign, Lock, TrendingUp, Tv } from "lucide-react";
import { useEffect, useState } from "react";
import { VideoHubLayout } from "@/components/videohub/VideoHubLayout";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import {
  calculateTotalAdEarning,
  getAuthoritativeUserWallet,
  type UserWallet,
} from "@/lib/ledger-service";

export const Route = createFileRoute("/adsense-income")({
  head: () => ({
    meta: [
      { title: "AdSense Income — FaceTube" },
      {
        name: "description",
        content:
          "Track your video advertising revenue share, playback CPM, and monetized impressions on FaceTube.",
      },
    ],
  }),
  component: AdSenseIncomePage,
});

function AdSenseIncomePage() {
  const { user, profile, dbUser, isLoading: authLoading } = useAuth();
  const userId = profile?.user_id || dbUser?.user_id || (user as any)?.user_id || "";
  const [wallet, setWallet] = useState<UserWallet | null>(null);
  const [adsenseTransactions, setAdsenseTransactions] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!userId) {
      setWallet(null);
      setAdsenseTransactions([]);
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
          api.wallet.getTransactions(userId, 50),
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
            return type === "adsense_income";
          });
          setAdsenseTransactions(filtered);
        } else {
          setAdsenseTransactions([]);
          if (!walletRes.error) {
            setErrorMessage("Unable to load AdSense ledger transactions from server.");
          }
        }
      } catch (err) {
        console.error("Failed to load user AdSense data:", err);
        if (isMounted) {
          setWallet(null);
          setAdsenseTransactions([]);
          setErrorMessage(
            err instanceof Error ? err.message : "Failed to load AdSense income data.",
          );
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

  const adsenseRevenue = wallet ? Number(wallet.adsenseIncome ?? 0) : null;
  const admobRevenue = wallet ? Number(wallet.admobIncome ?? 0) : null;
  const totalAdEarning = wallet ? calculateTotalAdEarning(wallet) : null;
  const totalEarned = wallet ? Number(wallet.totalEarned ?? 0) : null;
  const walletBalance = wallet ? Number(wallet.balance ?? 0) : null;

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
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-yellow-500/10 text-yellow-400">
              <Tv className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl">
                Google AdSense Income
              </h1>
              <p className="text-sm text-muted-foreground">
                In-stream video ad revenue (70% creator share), skippable pre-rolls, and monetized
                display impressions backed by your genuine Hostinger ledger.
              </p>
            </div>
          </div>

          <Link
            to="/advertisement-videos"
            className="inline-flex items-center justify-center gap-2 rounded-full border border-border bg-secondary/80 px-4 py-2 text-xs font-bold text-foreground transition hover:bg-secondary active:scale-95"
          >
            Manage Ad Campaigns
          </Link>
        </div>

        {/* Auth or Server Unavailable Banner */}
        {!authLoading && !userId && (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 text-xs text-amber-200">
              <Lock className="h-4 w-4 text-amber-400 shrink-0" />
              <span>Sign in to view your authoritative AdSense income and ledger records.</span>
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

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">Total AdSense Revenue</span>
            <p className="text-2xl font-black text-yellow-400">{formatMetric(adsenseRevenue)}</p>
            <p className="text-[11px] text-emerald-400 font-semibold flex items-center gap-1">
              <TrendingUp className="h-3 w-3" /> Authoritative ledger total
            </p>
          </div>
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-1 shadow-card">
            <span className="text-xs text-emerald-400 font-semibold flex items-center gap-1">
              <DollarSign className="h-3.5 w-3.5" />
              Total Ad Earning
            </span>
            <p className="text-2xl font-black text-emerald-400">{formatMetric(totalAdEarning)}</p>
            <p className="text-[11px] text-muted-foreground">
              {wallet
                ? `AdSense ₹${(adsenseRevenue ?? 0).toFixed(2)} + AdMob ₹${(admobRevenue ?? 0).toFixed(2)}`
                : "Verified AdSense + AdMob only"}
            </p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">
              Available Wallet Balance
            </span>
            <p className="text-2xl font-black text-foreground">{formatMetric(walletBalance)}</p>
            <p className="text-[11px] text-muted-foreground">Ready for creator payout</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">Cumulative Earned</span>
            <p className="text-2xl font-black text-emerald-400">{formatMetric(totalEarned)}</p>
            <p className="text-[11px] text-muted-foreground">All income channels combined</p>
          </div>
          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">Creator Rev Share</span>
            <p className="text-2xl font-black text-emerald-400">70.0%</p>
            <p className="text-[11px] text-muted-foreground">Direct net earnings</p>
          </div>
        </div>

        {/* Ledger Transactions Table */}
        <div className="rounded-2xl border border-border bg-card overflow-hidden shadow-card">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-foreground">
                Authoritative AdSense Ledger Transactions
              </h3>
              <p className="text-xs text-muted-foreground">
                Settled in Hostinger MySQL{" "}
                <code className="font-mono text-brand">income_ledger</code>
              </p>
            </div>
            <span className="text-xs text-muted-foreground font-semibold">
              {adsenseTransactions.length} records
            </span>
          </div>

          {isLoading ? (
            <div className="py-12 flex flex-col items-center justify-center gap-2 text-muted-foreground">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
              <p className="text-xs">Loading ledger transactions...</p>
            </div>
          ) : adsenseTransactions.length === 0 ? (
            <div className="py-12 text-center text-xs text-muted-foreground space-y-2">
              <p>No settled AdSense transactions recorded yet for user account.</p>
              <p className="text-[11px]">
                Ad impressions and view-time monetization are settled directly to your wallet.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-border bg-secondary/40 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Transaction ID</th>
                    <th className="px-4 py-3">Source / Video</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3 text-right">Net Credit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {adsenseTransactions.map((tx: any) => (
                    <tr
                      key={tx.id || tx.transactionId || tx.transaction_id}
                      className="transition hover:bg-secondary/20"
                    >
                      <td className="px-4 py-3.5 text-muted-foreground">
                        {tx.created_at || tx.createdAt
                          ? new Date(tx.created_at || tx.createdAt).toLocaleDateString("en-IN", {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                            })
                          : "Settled"}
                      </td>
                      <td className="px-4 py-3.5 font-mono text-foreground font-bold">
                        {tx.transaction_id || tx.transactionId || tx.id}
                      </td>
                      <td className="px-4 py-3.5 text-muted-foreground">
                        {tx.description || tx.video_title || "Video Ad Impression Revenue"}
                      </td>
                      <td className="px-4 py-3.5">
                        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-400">
                          {tx.status || "settled"}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-right font-black text-yellow-400 text-sm font-mono">
                        +₹{Number(tx.amount || 0).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </VideoHubLayout>
  );
}
