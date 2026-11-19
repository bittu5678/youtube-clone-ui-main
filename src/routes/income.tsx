import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import {
  Wallet,
  DollarSign,
  ArrowRight,
  Globe2,
  Tv,
  Smartphone,
  Share2,
  ArrowDownToLine,
  AlertCircle,
  Lock,
} from "lucide-react";
import { VideoHubLayout } from "@/components/videohub/VideoHubLayout";
import { DashboardSummaryCards } from "@/components/videohub/DashboardSummaryCards";
import { useAuth } from "@/lib/auth-context";
import {
  getAuthoritativeUserWallet,
  calculateTotalAdEarning,
  type UserWallet,
} from "@/lib/ledger-service";

export const Route = createFileRoute("/income")({
  head: () => ({
    meta: [
      { title: "Income Section — FaceTube" },
      {
        name: "description",
        content:
          "Unified creator income hub on FaceTube: Referral Income, Global Pool, AdSense, AdMob, Total Ad Earning, Affiliate Sales, Wallet and Withdrawals.",
      },
    ],
  }),
  component: IncomePage,
});

const incomeStreams = [
  {
    id: "referral-income",
    title: "Referral Income",
    desc: "Direct referral commissions from creator subscriptions and invited members",
    badge: "Referral",
    icon: DollarSign,
    color: "text-emerald-400 bg-emerald-500/10",
    link: "/referral-income",
  },
  {
    id: "global-income",
    title: "Global Income",
    desc: "Worldwide platform revenue pool distribution for eligible creators",
    badge: "Global Pool",
    icon: Globe2,
    color: "text-cyan-400 bg-cyan-500/10",
    link: "/global-income",
  },
  {
    id: "adsense-income",
    title: "AdSense Income",
    desc: "70% video player pre-roll, mid-roll, and display ad revenue",
    badge: "70% Split",
    icon: Tv,
    color: "text-yellow-400 bg-yellow-500/10",
    link: "/adsense-income",
  },
  {
    id: "admob-income",
    title: "AdMob Income",
    desc: "Verified Google AdMob revenue from Android native banner, interstitial, and rewarded ads",
    badge: "Android App",
    icon: Smartphone,
    color: "text-blue-400 bg-blue-500/10",
    link: "/admob-income",
  },
  {
    id: "affiliate-income",
    title: "Affiliate Income",
    desc: "Product recommendations, gear commissions, and course referrals",
    badge: "Affiliate",
    icon: Share2,
    color: "text-indigo-400 bg-indigo-500/10",
    link: "/affiliate-income",
  },
  {
    id: "wallet-balance",
    title: "Wallet Balance",
    desc: "Current aggregated balance ready for immediate transfer or withdrawal",
    badge: "Available",
    icon: Wallet,
    color: "text-emerald-400 bg-emerald-500/10",
    link: "/wallet-balance",
  },
  {
    id: "withdrawal-balance",
    title: "Withdrawal Balance",
    desc: "History of completed bank, UPI, and payout disbursements",
    badge: "Processed",
    icon: ArrowDownToLine,
    color: "text-orange-400 bg-orange-500/10",
    link: "/withdrawal-balance",
  },
];

function IncomePage() {
  const { profile, dbUser, user, isLoading: authLoading } = useAuth();
  const userId =
    profile?.user_id || dbUser?.user_id || (user?.email ? user.email.split("@")[0] : "") || "";
  const [wallet, setWallet] = useState<UserWallet | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [walletError, setWalletError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!userId) {
      setWallet(null);
      setWalletError(null);
      setIsLoading(false);
      return;
    }

    let mounted = true;
    setIsLoading(true);
    setWalletError(null);

    getAuthoritativeUserWallet(userId)
      .then((res) => {
        if (!mounted) return;
        if (res.wallet) {
          setWallet(res.wallet);
          setWalletError(null);
        } else {
          setWallet(null);
          setWalletError(res.error || "Unable to load authoritative wallet balance from server.");
        }
      })
      .catch((err) => {
        if (!mounted) return;
        setWallet(null);
        setWalletError(err instanceof Error ? err.message : "Failed to load wallet data.");
      })
      .finally(() => {
        if (mounted) setIsLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [authLoading, userId]);

  const unavailableLabel = isLoading ? "..." : "Unavailable";
  const adsenseIncome = wallet ? Number(wallet.adsenseIncome) || 0 : null;
  const admobIncome = wallet ? Number(wallet.admobIncome) || 0 : null;
  const totalAdEarning = wallet ? calculateTotalAdEarning(wallet) : null;

  const formatMoney = (amount: number | null) =>
    amount !== null ? `₹${amount.toFixed(2)}` : unavailableLabel;

  const streamsWithRealValues = incomeStreams.map((s) => {
    if (s.id === "referral-income") {
      return { ...s, balance: formatMoney(wallet ? wallet.referralIncome : null) };
    }
    if (s.id === "global-income") {
      return { ...s, balance: formatMoney(wallet ? wallet.globalIncome : null) };
    }
    if (s.id === "adsense-income") {
      return { ...s, balance: formatMoney(adsenseIncome) };
    }
    if (s.id === "admob-income") {
      return { ...s, balance: formatMoney(admobIncome) };
    }
    if (s.id === "affiliate-income") {
      return { ...s, balance: formatMoney(wallet ? wallet.affiliateIncome : null) };
    }
    if (s.id === "wallet-balance") {
      return { ...s, balance: formatMoney(wallet ? wallet.balance : null) };
    }
    if (s.id === "withdrawal-balance") {
      return { ...s, balance: formatMoney(wallet ? wallet.totalWithdrawn : null) };
    }
    return { ...s, balance: unavailableLabel };
  });

  return (
    <VideoHubLayout>
      <div className="px-4 py-6 sm:px-6 lg:px-8 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
          <div className="flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-brand/10 text-brand">
              <Wallet className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl">
                  Income Section
                </h1>
                {wallet?.isStale && (
                  <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-[10px] font-bold text-amber-400">
                    Offline / Stale Cache
                  </span>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                Manage all creator revenue streams, check balances, and withdraw earnings
              </p>
            </div>
          </div>

          <Link
            to="/wallet-balance"
            className="inline-flex items-center justify-center gap-2 rounded-full bg-brand px-4 py-2 text-xs font-bold text-white shadow-lift transition hover:bg-brand-dark active:scale-95"
          >
            <Wallet className="h-3.5 w-3.5" />
            Withdrawal Balance
          </Link>
        </div>

        {/* Sign-in required or authoritative server unavailable states */}
        {!authLoading && !userId && (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 text-xs text-amber-200">
              <Lock className="h-4 w-4 text-amber-400 shrink-0" />
              <span>
                Sign in with your FaceTube creator account to view your authoritative wallet and
                Total Ad Earning breakdown.
              </span>
            </div>
            <Link
              to="/auth"
              className="inline-flex items-center justify-center rounded-full bg-amber-500 px-4 py-1.5 text-xs font-bold text-black hover:bg-amber-400 shrink-0"
            >
              Sign In
            </Link>
          </div>
        )}

        {userId && walletError && !isLoading && (
          <div className="rounded-2xl border border-destructive/40 bg-destructive/10 p-4 flex items-center gap-2.5 text-xs text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>
              <strong>Server Balance Unavailable:</strong> {walletError}
            </span>
          </div>
        )}

        {/* Total Ad Earning Summary Card (Verified AdSense + AdMob only) */}
        <div className="rounded-2xl border border-emerald-500/30 bg-gradient-to-r from-emerald-500/10 via-card to-card p-5 shadow-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
                <DollarSign className="h-3.5 w-3.5" />
                Total Ad Earning (Verified AdSense + AdMob)
              </span>
              <div className="text-3xl font-black text-emerald-400 font-mono">
                {formatMoney(totalAdEarning)}
              </div>
              <p className="text-xs text-muted-foreground">
                Strictly combines verified AdSense and AdMob income only (excludes Referral,
                Affiliate, AdBoost, and Global Income Pool).
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:min-w-[280px]">
              <div className="rounded-xl border border-border bg-card/80 p-3">
                <span className="text-[10px] font-bold uppercase tracking-wider text-yellow-400 block">
                  AdSense Income
                </span>
                <span className="text-base font-black text-foreground font-mono">
                  {formatMoney(adsenseIncome)}
                </span>
              </div>
              <div className="rounded-xl border border-border bg-card/80 p-3">
                <span className="text-[10px] font-bold uppercase tracking-wider text-blue-400 block">
                  AdMob Income
                </span>
                <span className="text-base font-black text-foreground font-mono">
                  {formatMoney(admobIncome)}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Income Summary Cards */}
        <DashboardSummaryCards
          filterCategory="income"
          dynamicOverrides={{
            "referral-income": formatMoney(wallet ? wallet.referralIncome : null),
            "global-income": formatMoney(wallet ? wallet.globalIncome : null),
            "wallet-balance": formatMoney(wallet ? wallet.balance : null),
            "adsense-income": formatMoney(adsenseIncome),
            "admob-income": formatMoney(admobIncome),
            "total-ad-earning": formatMoney(totalAdEarning),
            "affiliate-income": formatMoney(wallet ? wallet.affiliateIncome : null),
            "withdrawal-balance": formatMoney(wallet ? wallet.totalWithdrawn : null),
          }}
          trendOverrides={{
            "total-ad-earning":
              adsenseIncome !== null && admobIncome !== null
                ? `AdSense ₹${adsenseIncome.toFixed(2)} + AdMob ₹${admobIncome.toFixed(2)}`
                : unavailableLabel,
          }}
        />

        {/* Income Stream Cards */}
        <div className="space-y-3 pt-2">
          <h2 className="text-base font-extrabold text-foreground">
            Revenue Streams &amp; Payouts
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {streamsWithRealValues.map((stream) => {
              const Icon = stream.icon;
              return (
                <Link
                  key={stream.id}
                  to={stream.link}
                  className="group block rounded-2xl border border-border bg-card p-5 shadow-card transition-all duration-200 hover:-translate-y-1 hover:border-brand/40 hover:shadow-lift"
                >
                  <div className="flex items-center justify-between mb-3">
                    <div
                      className={`grid h-11 w-11 place-items-center rounded-xl transition-transform group-hover:scale-105 ${stream.color}`}
                    >
                      <Icon className="h-5 w-5" />
                    </div>
                    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2.5 py-0.5 text-[11px] font-bold text-foreground">
                      {stream.badge}
                      <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </div>

                  <h3 className="text-base font-extrabold text-foreground group-hover:text-brand transition-colors">
                    {stream.title}
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1 mb-3 leading-relaxed line-clamp-2">
                    {stream.desc}
                  </p>

                  <div className="flex items-center justify-between border-t border-border/60 pt-3 text-xs font-semibold">
                    <span className="text-muted-foreground">Balance / Volume:</span>
                    <span className="text-foreground font-black text-sm">{stream.balance}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </VideoHubLayout>
  );
}
