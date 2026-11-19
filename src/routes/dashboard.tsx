import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import {
  LayoutDashboard,
  TrendingUp,
  Wallet,
  Video,
  Bell,
  Clapperboard,
  Clock,
  DollarSign,
  Zap,
  AlertCircle,
  Lock,
} from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { VideoHubLayout } from "@/components/videohub/VideoHubLayout";
import { DashboardSummaryCards } from "@/components/videohub/DashboardSummaryCards";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import type { VideoCategoryCounts } from "@/lib/video-service";
import {
  getAuthoritativeUserWallet,
  calculateTotalAdEarning,
  type UserWallet,
} from "@/lib/ledger-service";
import { getReferralDashboardData, type ReferralDashboardData } from "@/lib/referral-service";
import { calculateRankFromSubscribers } from "@/lib/certificate-service";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard Summary — FaceTube" },
      {
        name: "description",
        content:
          "Unified creator dashboard with database-driven video counts, subscriber analytics, and verified ad revenue streams on FaceTube.",
      },
    ],
  }),
  component: DashboardPage,
});

function DashboardPage() {
  const { user, profile, dbUser, isLoading: authLoading } = useAuth();
  const [filter, setFilter] = useState<"all" | "income" | "videos" | "network">("all");

  const [videoCounts, setVideoCounts] = useState<VideoCategoryCounts | null>(null);
  const [adVideoCount, setAdVideoCount] = useState<number | null>(null);
  const [liveVideoCount, setLiveVideoCount] = useState<number | null>(null);
  const [imagesUploadedCount, setImagesUploadedCount] = useState<number | null>(null);

  const [wallet, setWallet] = useState<UserWallet | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [referralData, setReferralData] = useState<ReferralDashboardData | null>(null);
  const [earningsPeriod, setEarningsPeriod] = useState<"7D" | "30D" | "90D" | "12M">("30D");
  const [earningsHistory, setEarningsHistory] = useState<
    Array<{
      day: string;
      revenue: number;
      date: string;
      referral: number;
      global: number;
      adsense: number;
      admob: number;
      total_ad_earning: number;
      affiliate: number;
      ad_boost: number;
      tx_count?: number;
    }>
  >([]);
  const [earningsSummary, setEarningsSummary] = useState<{
    total_revenue: number;
    referral: number;
    global: number;
    adsense: number;
    admob: number;
    total_ad_earning: number;
    affiliate: number;
    ad_boost: number;
  } | null>(null);
  const [earningsError, setEarningsError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isEarningsLoading, setIsEarningsLoading] = useState(false);

  const userId =
    profile?.user_id || dbUser?.user_id || (user?.email ? user.email.split("@")[0] : "") || "";

  const [subscriberCount, setSubscriberCount] = useState<number | null>(null);
  const [isSubscriberLoading, setIsSubscriberLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    if (!userId) {
      setWallet(null);
      setWalletError(null);
      setReferralData(null);
      setVideoCounts(null);
      setAdVideoCount(null);
      setLiveVideoCount(null);
      setImagesUploadedCount(null);
      setSubscriberCount(null);
      setIsLoading(false);
      setIsSubscriberLoading(false);
      return;
    }

    let mounted = true;
    setIsLoading(true);
    setIsSubscriberLoading(true);
    setWalletError(null);

    async function loadRealData() {
      try {
        const [videosRes, walletRes, refRes, subRes, liveRes, imagesRes] = await Promise.all([
          api.videos.list({ userId, limit: 200 }).catch(() => null),
          getAuthoritativeUserWallet(userId),
          getReferralDashboardData(userId).catch(() => null),
          api.channel.getSubscriberCount(userId).catch(() => null),
          api.live.listStreams().catch(() => null),
          api.images.list({ userId, limit: 200 }).catch(() => null),
        ]);

        if (!mounted) return;

        if (videosRes && videosRes.success !== false && Array.isArray(videosRes.videos)) {
          let freeShort = 0;
          let freeLong = 0;
          let premiumShort = 0;
          let premiumLong = 0;
          let promotedCount = 0;

          for (const v of videosRes.videos) {
            const vType = String(v.video_type || v.videoType || "free").toLowerCase();
            const cType = String(v.content_type || v.contentType || "long").toLowerCase();
            const pStatus = String(
              v.payment_status || v.paymentStatus || "not_required",
            ).toLowerCase();
            const isPromoted = Boolean(v.is_promoted ?? v.isPromoted);

            if (isPromoted) promotedCount++;

            if (vType === "free") {
              if (cType === "short") freeShort++;
              else freeLong++;
            } else if (vType === "premium" && (pStatus === "paid" || pStatus === "not_required")) {
              if (cType === "short") premiumShort++;
              else premiumLong++;
            }
          }

          const totalFree = freeShort + freeLong;
          const totalPremium = premiumShort + premiumLong;
          setVideoCounts({
            freeShort,
            freeLong,
            premiumShort,
            premiumLong,
            totalFree,
            totalPremium,
            totalUploaded: totalFree + totalPremium,
          });
          setAdVideoCount(promotedCount);
        } else {
          setVideoCounts(null);
          setAdVideoCount(null);
        }

        if (walletRes.wallet) {
          setWallet(walletRes.wallet);
          setWalletError(null);
        } else {
          setWallet(null);
          setWalletError(walletRes.error || "Unable to load authoritative wallet balance.");
        }

        setReferralData(refRes);

        if (subRes && subRes.success) {
          setSubscriberCount(Number(subRes.subscriber_count) || 0);
        } else {
          setSubscriberCount(null);
        }

        if (liveRes && liveRes.success !== false && Array.isArray(liveRes.streams)) {
          const ownStreams = liveRes.streams.filter(
            (s: any) =>
              String(s?.user_id || s?.userId || "")
                .trim()
                .toUpperCase() === userId.trim().toUpperCase(),
          );
          setLiveVideoCount(ownStreams.length);
        } else {
          setLiveVideoCount(null);
        }

        if (imagesRes && imagesRes.success !== false && Array.isArray(imagesRes.images)) {
          setImagesUploadedCount(imagesRes.images.length);
        } else {
          setImagesUploadedCount(null);
        }
      } catch (err) {
        console.error("Dashboard real data load error:", err);
        if (mounted) {
          setWallet(null);
          setWalletError("Failed to load live dashboard data from server.");
        }
      } finally {
        if (mounted) {
          setIsLoading(false);
          setIsSubscriberLoading(false);
        }
      }
    }

    loadRealData();
    return () => {
      mounted = false;
    };
  }, [authLoading, userId]);

  useEffect(() => {
    if (authLoading || !userId) {
      setEarningsHistory([]);
      setEarningsSummary(null);
      setEarningsError(null);
      setIsEarningsLoading(false);
      return;
    }

    let mounted = true;
    async function loadEarnings() {
      setIsEarningsLoading(true);
      setEarningsError(null);
      try {
        const res = await api.wallet.getEarningsHistory(userId, { period: earningsPeriod });
        if (!mounted) return;
        if (res && res.success !== false) {
          if (Array.isArray(res.history)) {
            setEarningsHistory(
              res.history.map((h) => {
                const adsense = Number(h.adsense ?? h.adsense_income) || 0;
                const admob = Number(h.admob ?? h.admob_income) || 0;
                const totalAdEarning =
                  h.total_ad_earning !== undefined && h.total_ad_earning !== null
                    ? Number(h.total_ad_earning) || 0
                    : Math.round((adsense + admob) * 100) / 100;
                return {
                  day: h.day,
                  revenue: Number(h.revenue) || 0,
                  date: h.date,
                  referral: Number(h.referral ?? h.referral_income) || 0,
                  global: Number(h.global ?? h.global_income) || 0,
                  adsense,
                  admob,
                  total_ad_earning: totalAdEarning,
                  affiliate: Number(h.affiliate ?? h.affiliate_income) || 0,
                  ad_boost: Number(h.ad_boost ?? h.ad_boost_income) || 0,
                  tx_count: h.tx_count,
                };
              }),
            );
          } else {
            setEarningsHistory([]);
          }
          if (res.summary) {
            const adsense = Number(res.summary.adsense) || 0;
            const admob = Number(res.summary.admob) || 0;
            const totalAdEarning =
              res.summary.total_ad_earning !== undefined && res.summary.total_ad_earning !== null
                ? Number(res.summary.total_ad_earning) || 0
                : Math.round((adsense + admob) * 100) / 100;
            setEarningsSummary({
              total_revenue: Number(res.summary.total_revenue) || 0,
              referral: Number(res.summary.referral) || 0,
              global: Number(res.summary.global) || 0,
              adsense,
              admob,
              total_ad_earning: totalAdEarning,
              affiliate: Number(res.summary.affiliate) || 0,
              ad_boost: Number(res.summary.ad_boost) || 0,
            });
          } else {
            setEarningsSummary(null);
          }
        }
      } catch (err: any) {
        console.error("Dashboard earnings history load error:", err);
        if (mounted) {
          setEarningsHistory([]);
          setEarningsSummary(null);
          setEarningsError(err?.message || "Unable to load verified earnings history.");
        }
      } finally {
        if (mounted) setIsEarningsLoading(false);
      }
    }

    loadEarnings();
    return () => {
      mounted = false;
    };
  }, [authLoading, userId, earningsPeriod]);

  const currentCreatorRank =
    subscriberCount !== null ? calculateRankFromSubscribers(subscriberCount) : null;

  const adsenseIncome = wallet ? Number(wallet.adsenseIncome) || 0 : null;
  const admobIncome = wallet ? Number(wallet.admobIncome) || 0 : null;
  const totalAdEarning = wallet ? calculateTotalAdEarning(wallet) : null;

  const unavailableLabel = isLoading ? "..." : "Unavailable";

  // Dynamic overrides mapped directly to the 18 summary cards
  const dynamicCardOverrides: Record<string, string> = {
    "free-videos": videoCounts ? String(videoCounts.totalFree) : isLoading ? "..." : "—",
    "premium-videos": videoCounts ? String(videoCounts.totalPremium) : isLoading ? "..." : "—",
    "short-videos": videoCounts
      ? String(videoCounts.freeShort + videoCounts.premiumShort)
      : isLoading
        ? "..."
        : "—",
    "live-videos": liveVideoCount !== null ? String(liveVideoCount) : isLoading ? "..." : "—",
    "advertisement-videos": adVideoCount !== null ? String(adVideoCount) : isLoading ? "..." : "—",
    "images-uploaded":
      imagesUploadedCount !== null ? String(imagesUploadedCount) : isLoading ? "..." : "—",
    "total-referrals": referralData
      ? String(referralData.directReferralsCount)
      : isLoading
        ? "..."
        : "—",
    "total-team": referralData ? String(referralData.teamMembersCount) : isLoading ? "..." : "—",
    "wallet-balance": wallet ? `₹${wallet.balance.toFixed(2)}` : unavailableLabel,
    "referral-income": referralData
      ? `₹${referralData.referralIncome.toFixed(2)}`
      : wallet
        ? `₹${wallet.referralIncome.toFixed(2)}`
        : unavailableLabel,
    "global-income": wallet ? `₹${wallet.globalIncome.toFixed(2)}` : unavailableLabel,
    "adsense-income": adsenseIncome !== null ? `₹${adsenseIncome.toFixed(2)}` : unavailableLabel,
    "admob-income": admobIncome !== null ? `₹${admobIncome.toFixed(2)}` : unavailableLabel,
    "total-ad-earning":
      totalAdEarning !== null ? `₹${totalAdEarning.toFixed(2)}` : unavailableLabel,
    "affiliate-income": wallet ? `₹${wallet.affiliateIncome.toFixed(2)}` : unavailableLabel,
    "withdrawal-balance": wallet ? `₹${wallet.totalWithdrawn.toFixed(2)}` : unavailableLabel,
    "current-rank": currentCreatorRank
      ? currentCreatorRank.awardName
      : isSubscriberLoading
        ? "..."
        : "—",
    "subscriber-count": isSubscriberLoading
      ? "..."
      : subscriberCount !== null
        ? subscriberCount.toLocaleString()
        : "—",
  };

  const trendOverrides: Record<string, string> = {
    "total-ad-earning":
      adsenseIncome !== null && admobIncome !== null
        ? `AdSense ₹${adsenseIncome.toFixed(2)} + AdMob ₹${admobIncome.toFixed(2)}`
        : unavailableLabel,
  };

  return (
    <VideoHubLayout>
      <div className="px-4 py-6 sm:px-6 lg:px-8 space-y-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-5">
          <div className="flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-brand/10 text-brand">
              <LayoutDashboard className="h-6 w-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl">
                  Dashboard
                </h1>
                {!userId ? (
                  <span className="rounded-full border border-border bg-secondary px-2.5 py-0.5 text-[10px] font-bold text-muted-foreground">
                    Sign In Required
                  </span>
                ) : walletError || !wallet ? (
                  <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-[10px] font-bold text-amber-400">
                    {isLoading ? "Syncing..." : "Server Unavailable"}
                  </span>
                ) : (
                  <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-bold text-emerald-400">
                    Real Database Live
                  </span>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {userId ? (
                  <>
                    All 18 performance metrics, dynamic video classifications, and income streams
                    for <strong>{userId}</strong>
                  </>
                ) : (
                  "Sign in to view your live creator metrics and verified ad earnings"
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Link
              to="/wallet-balance"
              className="inline-flex items-center justify-center gap-2 rounded-full border border-border bg-secondary/80 px-4 py-2 text-xs font-bold text-foreground transition hover:bg-secondary active:scale-95"
            >
              <Wallet className="h-3.5 w-3.5 text-emerald-400" />
              Wallet: {wallet ? `₹${wallet.balance.toFixed(2)}` : isLoading ? "..." : "Unavailable"}
            </Link>
            <Link
              to="/upload"
              className="inline-flex items-center justify-center gap-2 rounded-full bg-brand px-4 py-2 text-xs font-bold text-white shadow-lift transition hover:bg-brand-dark active:scale-95"
            >
              <Video className="h-3.5 w-3.5" />
              Upload Video
            </Link>
          </div>
        </div>

        {/* Auth or Authoritative Wallet Error Notice */}
        {!authLoading && !userId && (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 text-xs text-amber-200">
              <Lock className="h-4 w-4 text-amber-400 shrink-0" />
              <span>
                Sign in with your FaceTube creator account to load verified wallet balances and
                Total Ad Earning metrics.
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
              <strong>Wallet Unavailable:</strong> {walletError}
            </span>
          </div>
        )}

        {/* Dedicated Total Ad Earning Highlight Card (Verified AdSense + AdMob only) */}
        <div className="rounded-3xl border border-emerald-500/30 bg-gradient-to-r from-emerald-500/10 via-card to-card p-5 sm:p-6 shadow-card">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
                <DollarSign className="h-3.5 w-3.5" />
                Total Ad Earning (Verified AdSense + AdMob Only)
              </span>
              <div className="text-3xl font-black text-emerald-400 font-mono">
                {totalAdEarning !== null
                  ? `₹${totalAdEarning.toFixed(2)}`
                  : isLoading
                    ? "..."
                    : "Unavailable"}
              </div>
              <p className="text-xs text-muted-foreground">
                Excludes Referral, Affiliate, AdBoost, and Global Income Pool earnings
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:min-w-[300px]">
              <Link
                to="/adsense-income"
                className="rounded-2xl border border-border bg-card/80 p-3.5 hover:border-yellow-500/40 transition"
              >
                <span className="text-[10px] font-bold uppercase tracking-wider text-yellow-400 block">
                  Verified AdSense
                </span>
                <span className="text-lg font-black text-foreground font-mono mt-0.5 block">
                  {adsenseIncome !== null
                    ? `₹${adsenseIncome.toFixed(2)}`
                    : isLoading
                      ? "..."
                      : "Unavailable"}
                </span>
              </Link>
              <Link
                to="/admob-income"
                className="rounded-2xl border border-border bg-card/80 p-3.5 hover:border-blue-500/40 transition"
              >
                <span className="text-[10px] font-bold uppercase tracking-wider text-blue-400 block">
                  Verified AdMob
                </span>
                <span className="text-lg font-black text-foreground font-mono mt-0.5 block">
                  {admobIncome !== null
                    ? `₹${admobIncome.toFixed(2)}`
                    : isLoading
                      ? "..."
                      : "Unavailable"}
                </span>
              </Link>
            </div>
          </div>
        </div>

        {/* ------------------------------------------------------------------ */}
        {/* DEDICATED VIDEO COUNT SECTION                                      */}
        {/* ------------------------------------------------------------------ */}
        <div className="rounded-3xl border border-border bg-card p-6 sm:p-7 shadow-card space-y-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border/60 pb-4">
            <div>
              <div className="inline-flex items-center gap-1.5 rounded-md bg-brand/10 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-brand">
                <Video className="h-3.5 w-3.5" />
                Video Inventory Classification
              </div>
              <h2 className="mt-1 text-lg sm:text-xl font-black text-foreground">
                Uploaded Video Counts
              </h2>
              <p className="text-xs text-muted-foreground">
                {userId
                  ? `Dynamically calculated from real uploaded video records for User ${userId}.`
                  : "Sign in to load your uploaded video classification counts."}
              </p>
            </div>

            <div className="flex items-center gap-3 text-xs">
              <span className="font-semibold text-muted-foreground">
                Total Uploaded:{" "}
                <strong className="text-foreground">
                  {videoCounts
                    ? `${videoCounts.totalUploaded} Videos`
                    : isLoading
                      ? "..."
                      : "Unavailable"}
                </strong>
              </span>
              <Link
                to="/upload"
                className="inline-flex items-center gap-1 rounded-xl bg-secondary px-3 py-1.5 font-bold text-foreground hover:bg-secondary/80 transition"
              >
                <span>+ Upload New</span>
              </Link>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* 1. Free Short Video */}
            <div className="rounded-2xl border border-sky-500/30 bg-gradient-to-b from-sky-500/10 via-card to-card p-5 space-y-2 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-sky-400">
                  FREE · Short
                </span>
                <span className="grid h-8 w-8 place-items-center rounded-xl bg-sky-500/20 text-sky-400">
                  <Clapperboard className="h-4 w-4" />
                </span>
              </div>
              <div className="text-3xl font-black text-foreground tracking-tight">
                {videoCounts ? videoCounts.freeShort : isLoading ? "..." : "—"}
              </div>
              <div className="flex items-center justify-between pt-1 border-t border-sky-500/20 text-[11px]">
                <span className="font-semibold text-sky-300">1. Free Short Video</span>
                <span className="text-muted-foreground">9:16 Vertical</span>
              </div>
            </div>

            {/* 2. Free Long Video */}
            <div className="rounded-2xl border border-sky-500/30 bg-gradient-to-b from-sky-500/10 via-card to-card p-5 space-y-2 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-sky-400">
                  FREE · Long Form
                </span>
                <span className="grid h-8 w-8 place-items-center rounded-xl bg-sky-500/20 text-sky-400">
                  <Video className="h-4 w-4" />
                </span>
              </div>
              <div className="text-3xl font-black text-foreground tracking-tight">
                {videoCounts ? videoCounts.freeLong : isLoading ? "..." : "—"}
              </div>
              <div className="flex items-center justify-between pt-1 border-t border-sky-500/20 text-[11px]">
                <span className="font-semibold text-sky-300">2. Free Long Video</span>
                <span className="text-muted-foreground">Standard 16:9</span>
              </div>
            </div>

            {/* 3. Sponsor Short Video */}
            <div className="rounded-2xl border border-amber-500/40 bg-gradient-to-b from-amber-500/15 via-card to-card p-5 space-y-2 shadow-[0_0_20px_rgba(245,158,11,0.08)]">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-amber-400 flex items-center gap-1">
                  <Zap className="h-3 w-3 fill-amber-400" />
                  SPONSOR · Short
                </span>
                <span className="grid h-8 w-8 place-items-center rounded-xl bg-amber-400/20 text-amber-400 font-bold">
                  ⚡
                </span>
              </div>
              <div className="text-3xl font-black text-foreground tracking-tight">
                {videoCounts ? videoCounts.premiumShort : isLoading ? "..." : "—"}
              </div>
              <div className="flex items-center justify-between pt-1 border-t border-amber-500/20 text-[11px]">
                <span className="font-bold text-amber-300">3. Sponsor Short Video</span>
                <span className="text-amber-400/80 font-mono">Paid (₹6)</span>
              </div>
            </div>

            {/* 4. Sponsor Long Video */}
            <div className="rounded-2xl border border-amber-500/40 bg-gradient-to-b from-amber-500/15 via-card to-card p-5 space-y-2 shadow-[0_0_20px_rgba(245,158,11,0.08)]">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-amber-400 flex items-center gap-1">
                  <Zap className="h-3 w-3 fill-amber-400" />
                  SPONSOR · Long Form
                </span>
                <span className="grid h-8 w-8 place-items-center rounded-xl bg-amber-400/20 text-amber-400 font-bold">
                  ⚡
                </span>
              </div>
              <div className="text-3xl font-black text-foreground tracking-tight">
                {videoCounts ? videoCounts.premiumLong : isLoading ? "..." : "—"}
              </div>
              <div className="flex items-center justify-between pt-1 border-t border-amber-500/20 text-[11px]">
                <span className="font-bold text-amber-300">4. Sponsor Long Video</span>
                <span className="text-amber-400/80 font-mono">Paid (₹6)</span>
              </div>
            </div>
          </div>
        </div>

        {/* ------------------------------------------------------------------ */}
        {/* SUBSCRIBERS, WATCH TIME & EARNINGS GROWTH CHARTS                   */}
        {/* ------------------------------------------------------------------ */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Chart 1: Subscribers Chart Section */}
          <div className="rounded-3xl border border-border bg-card p-5 sm:p-6 shadow-card space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                  <Bell className="h-3.5 w-3.5 text-rose-400" />
                  Subscribers Growth
                </span>
                <div className="text-2xl font-black text-foreground mt-0.5">
                  {isSubscriberLoading
                    ? "..."
                    : subscriberCount !== null
                      ? subscriberCount.toLocaleString()
                      : "Unavailable"}
                </div>
              </div>
              <span className="text-[11px] font-bold text-rose-400 bg-rose-500/10 px-2.5 py-0.5 rounded-full flex items-center gap-1">
                <Bell className="h-3 w-3" /> Live Channel
              </span>
            </div>

            {isSubscriberLoading ? (
              <div className="h-44 w-full flex items-center justify-center rounded-2xl bg-secondary/20 animate-pulse">
                <span className="text-xs text-muted-foreground">
                  Loading channel subscribers...
                </span>
              </div>
            ) : subscriberCount === null ? (
              <div className="h-44 w-full flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/60 bg-secondary/10 p-6 text-center">
                <Bell className="h-8 w-8 text-muted-foreground/40 mb-2" />
                <p className="text-xs font-semibold text-muted-foreground">
                  Subscriber count unavailable
                </p>
                <p className="text-[11px] text-muted-foreground/70 mt-1 max-w-[220px]">
                  Sign in or reconnect to load real-time database subscriber counts
                </p>
              </div>
            ) : (
              <div className="h-44 w-full flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/60 bg-secondary/10 p-6 text-center">
                <Bell className="h-8 w-8 text-rose-400/50 mb-2" />
                <p className="text-xs font-semibold text-foreground">
                  {subscriberCount > 0
                    ? `${subscriberCount.toLocaleString()} Active Channel Follower${subscriberCount === 1 ? "" : "s"}`
                    : "No channel subscribers yet"}
                </p>
                <p className="text-[11px] text-muted-foreground/70 mt-1 max-w-[220px]">
                  Historical growth charts will plot as daily subscriber milestones accumulate
                </p>
              </div>
            )}
            <p className="text-[11px] text-muted-foreground text-center">
              Real-time creator channel subscriptions from database
            </p>
          </div>

          {/* Chart 2: Watch Time Section (Honest Unavailable State — no watch-duration API) */}
          <div className="rounded-3xl border border-border bg-card p-5 sm:p-6 shadow-card space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5 text-blue-400" />
                  Watch Time (Hours)
                </span>
                <div className="text-2xl font-black text-foreground mt-0.5">—</div>
              </div>
              <span className="text-[11px] font-bold text-muted-foreground bg-secondary px-2.5 py-0.5 rounded-full">
                Unavailable
              </span>
            </div>

            <div className="h-44 w-full flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/60 bg-secondary/10 p-6 text-center">
              <Clock className="h-8 w-8 text-blue-400/50 mb-2" />
              <p className="text-xs font-semibold text-foreground">
                Watch-time telemetry unavailable
              </p>
              <p className="text-[11px] text-muted-foreground/70 mt-1 max-w-[240px]">
                No server watch-duration API is available yet; metrics remain hidden rather than
                estimated.
              </p>
            </div>
            <p className="text-[11px] text-muted-foreground text-center">
              Average view duration: — (telemetry pending)
            </p>
          </div>

          {/* Chart 3: FaceTube Earnings Growth Graph Section */}
          <div className="rounded-3xl border border-border bg-card p-5 sm:p-6 shadow-card space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                  <DollarSign className="h-3.5 w-3.5 text-emerald-400" />
                  FaceTube Earnings Growth Graph
                </span>
                <div className="text-2xl font-black text-emerald-400 mt-0.5">
                  {isLoading ? (
                    <span className="text-sm font-normal text-muted-foreground">Loading...</span>
                  ) : wallet ? (
                    `₹${(wallet.totalEarned ?? wallet.balance ?? 0).toFixed(2)}`
                  ) : (
                    <span className="text-sm font-semibold text-amber-400">Unavailable</span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2">
                {/* Timeframe Filters (7D, 30D, 90D, 12M) */}
                <div className="flex items-center rounded-xl bg-secondary/60 p-1 border border-border/50">
                  {(["7D", "30D", "90D", "12M"] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setEarningsPeriod(p)}
                      className={`rounded-lg px-2.5 py-1 text-xs font-semibold transition ${
                        earningsPeriod === p
                          ? "bg-emerald-500 text-black shadow-sm font-bold"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>

                <span className="text-[11px] font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full flex items-center gap-0.5">
                  <TrendingUp className="h-3 w-3" /> Real Time
                </span>
              </div>
            </div>

            {/* Income Streams Breakdown (including period Total Ad Earning = AdSense + AdMob) */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1 pb-1">
              <div className="rounded-xl bg-emerald-500/10 p-2.5 border border-emerald-500/30 col-span-2 sm:col-span-3 flex items-center justify-between">
                <div>
                  <div className="text-[10px] uppercase font-bold text-emerald-400 tracking-wider">
                    Period Total Ad Earning (AdSense + AdMob)
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {earningsSummary
                      ? `AdSense ₹${earningsSummary.adsense.toFixed(2)} + AdMob ₹${earningsSummary.admob.toFixed(2)}`
                      : isEarningsLoading
                        ? "Calculating..."
                        : "Unavailable"}
                  </div>
                </div>
                <div className="text-base font-black text-emerald-400 font-mono">
                  {earningsSummary
                    ? `₹${earningsSummary.total_ad_earning.toFixed(2)}`
                    : isEarningsLoading
                      ? "..."
                      : "—"}
                </div>
              </div>
              <div className="rounded-xl bg-secondary/30 p-2.5 border border-border/40">
                <div className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider">
                  Referral
                </div>
                <div className="text-sm font-bold text-foreground">
                  {earningsSummary ? `₹${earningsSummary.referral.toFixed(2)}` : "—"}
                </div>
              </div>
              <div className="rounded-xl bg-secondary/30 p-2.5 border border-border/40">
                <div className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider">
                  Global Pool
                </div>
                <div className="text-sm font-bold text-foreground">
                  {earningsSummary ? `₹${earningsSummary.global.toFixed(2)}` : "—"}
                </div>
              </div>
              <div className="rounded-xl bg-secondary/30 p-2.5 border border-border/40">
                <div className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider">
                  AdSense
                </div>
                <div className="text-sm font-bold text-foreground">
                  {earningsSummary ? `₹${earningsSummary.adsense.toFixed(2)}` : "—"}
                </div>
              </div>
              <div className="rounded-xl bg-secondary/30 p-2.5 border border-border/40">
                <div className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider">
                  AdMob
                </div>
                <div className="text-sm font-bold text-foreground">
                  {earningsSummary ? `₹${earningsSummary.admob.toFixed(2)}` : "—"}
                </div>
              </div>
              <div className="rounded-xl bg-secondary/30 p-2.5 border border-border/40">
                <div className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider">
                  Affiliate
                </div>
                <div className="text-sm font-bold text-foreground">
                  {earningsSummary ? `₹${earningsSummary.affiliate.toFixed(2)}` : "—"}
                </div>
              </div>
              <div className="rounded-xl bg-secondary/30 p-2.5 border border-border/40">
                <div className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider">
                  Ad Boost
                </div>
                <div className="text-sm font-bold text-foreground">
                  {earningsSummary ? `₹${earningsSummary.ad_boost.toFixed(2)}` : "—"}
                </div>
              </div>
            </div>

            {/* Chart Area or Unavailable / Genuine Zero State */}
            {isEarningsLoading ? (
              <div className="h-44 w-full flex items-center justify-center rounded-2xl bg-secondary/20 animate-pulse">
                <span className="text-xs text-muted-foreground">Loading earnings ledger...</span>
              </div>
            ) : earningsError ? (
              <div className="h-44 w-full flex flex-col items-center justify-center rounded-2xl border border-dashed border-destructive/40 bg-destructive/5 p-6 text-center">
                <AlertCircle className="h-7 w-7 text-destructive/70 mb-2" />
                <p className="text-xs font-semibold text-destructive">
                  Earnings history unavailable
                </p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{earningsError}</p>
              </div>
            ) : earningsHistory.length === 0 ? (
              <div className="h-44 w-full flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/60 bg-secondary/10 p-6 text-center">
                <DollarSign className="h-8 w-8 text-muted-foreground/40 mb-2" />
                <p className="text-xs font-semibold text-muted-foreground">
                  No earnings recorded for this period
                </p>
                <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                  Real ledger records will plot as settled earnings are generated
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                <div className="h-44 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={earningsHistory}>
                      <defs>
                        <linearGradient id="revGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0.0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                      <XAxis dataKey="day" stroke="#71717a" fontSize={11} tickLine={false} />
                      <YAxis
                        stroke="#71717a"
                        fontSize={11}
                        tickLine={false}
                        tickFormatter={(v) => `₹${v}`}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "#18181b",
                          borderColor: "#27272a",
                          borderRadius: "12px",
                          fontSize: "12px",
                        }}
                        content={({ active, payload, label }) => {
                          if (active && payload && payload.length && payload[0]) {
                            const data = payload[0].payload;
                            return (
                              <div className="rounded-xl border border-border bg-popover/95 p-3 shadow-xl backdrop-blur-md text-xs space-y-1.5 min-w-[180px]">
                                <div className="font-bold text-foreground pb-1 border-b border-border/50 flex justify-between items-center">
                                  <span>{data.date || label}</span>
                                  <span className="text-emerald-400 font-extrabold">
                                    ₹{Number(data.revenue || 0).toFixed(2)}
                                  </span>
                                </div>
                                <div className="space-y-1 text-[11px] text-muted-foreground">
                                  <div className="flex justify-between">
                                    <span>Referral:</span>
                                    <span className="font-semibold text-foreground">
                                      ₹{Number(data.referral || 0).toFixed(2)}
                                    </span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span>Global Pool:</span>
                                    <span className="font-semibold text-foreground">
                                      ₹{Number(data.global || 0).toFixed(2)}
                                    </span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span>AdSense:</span>
                                    <span className="font-semibold text-foreground">
                                      ₹{Number(data.adsense || 0).toFixed(2)}
                                    </span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span>AdMob:</span>
                                    <span className="font-semibold text-foreground">
                                      ₹{Number(data.admob || 0).toFixed(2)}
                                    </span>
                                  </div>
                                  <div className="flex justify-between text-emerald-400 font-semibold">
                                    <span>Total Ad Earning:</span>
                                    <span>₹{Number(data.total_ad_earning || 0).toFixed(2)}</span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span>Affiliate:</span>
                                    <span className="font-semibold text-foreground">
                                      ₹{Number(data.affiliate || 0).toFixed(2)}
                                    </span>
                                  </div>
                                  <div className="flex justify-between">
                                    <span>Ad Boost:</span>
                                    <span className="font-semibold text-foreground">
                                      ₹{Number(data.ad_boost || 0).toFixed(2)}
                                    </span>
                                  </div>
                                  {data.tx_count !== undefined && (
                                    <div className="flex justify-between pt-1 border-t border-border/40 text-[10px]">
                                      <span>Transactions:</span>
                                      <span className="font-semibold text-foreground">
                                        {data.tx_count}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          }
                          return null;
                        }}
                      />
                      <Area
                        type="monotone"
                        dataKey="revenue"
                        stroke="#10b981"
                        strokeWidth={2.5}
                        fillOpacity={1}
                        fill="url(#revGradient)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                {(earningsSummary?.total_revenue ?? 0) === 0 && (
                  <p className="text-[11px] text-muted-foreground/70 text-center italic">
                    Zero settled earnings recorded during this period.
                  </p>
                )}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground text-center">
              Real-time settled ledger breakdown: Referral, Global Pool, AdSense, AdMob, Affiliate
              &amp; Ad Boost
            </p>
          </div>
        </div>

        {/* Filter Chips for Summary Cards */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          <button
            type="button"
            onClick={() => setFilter("all")}
            className={`rounded-full px-4 py-1.5 text-xs font-bold transition ${
              filter === "all"
                ? "bg-brand text-white shadow-sm"
                : "bg-secondary text-muted-foreground hover:text-foreground"
            }`}
          >
            All 18 Summary Cards
          </button>
          <button
            type="button"
            onClick={() => setFilter("income")}
            className={`rounded-full px-4 py-1.5 text-xs font-bold transition ${
              filter === "income"
                ? "bg-brand text-white shadow-sm"
                : "bg-secondary text-muted-foreground hover:text-foreground"
            }`}
          >
            Income Streams (8)
          </button>
          <button
            type="button"
            onClick={() => setFilter("videos")}
            className={`rounded-full px-4 py-1.5 text-xs font-bold transition ${
              filter === "videos"
                ? "bg-brand text-white shadow-sm"
                : "bg-secondary text-muted-foreground hover:text-foreground"
            }`}
          >
            Video Content (6)
          </button>
          <button
            type="button"
            onClick={() => setFilter("network")}
            className={`rounded-full px-4 py-1.5 text-xs font-bold transition ${
              filter === "network"
                ? "bg-brand text-white shadow-sm"
                : "bg-secondary text-muted-foreground hover:text-foreground"
            }`}
          >
            Team &amp; Subscribers (4)
          </button>
        </div>

        {/* 18 Summary Cards Grid with live overrides */}
        <DashboardSummaryCards
          filterCategory={filter}
          dynamicOverrides={dynamicCardOverrides}
          trendOverrides={trendOverrides}
        />
      </div>
    </VideoHubLayout>
  );
}
