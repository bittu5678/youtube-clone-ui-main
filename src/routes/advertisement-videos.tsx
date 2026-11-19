import { createFileRoute, Link } from "@tanstack/react-router";
import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Tv,
  Plus,
  DollarSign,
  TrendingUp,
  Eye,
  CheckCircle2,
  Clock,
  AlertTriangle,
  RefreshCw,
  Play,
  Sparkles,
  ShieldCheck,
  Search,
  ExternalLink,
  Lock,
  Layers,
  Heart,
  Calendar,
} from "lucide-react";
import { VideoHubLayout } from "@/components/videohub/VideoHubLayout";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { resolveVideoThumbnail, SVG_FALLBACK_THUMBNAIL } from "@/lib/thumbnail-service";
import { resolveMediaUrl } from "@/lib/media-url";
import {
  calculateTotalAdEarning,
  getAuthoritativeUserWallet,
  type UserWallet,
} from "@/lib/ledger-service";

export const Route = createFileRoute("/advertisement-videos")({
  head: () => ({
    meta: [
      { title: "Ad Videos — Your Videos — FaceTube" },
      {
        name: "description",
        content:
          "Manage real sponsor spots, promotional ad video campaigns, and brand deal deliverables on FaceTube.",
      },
    ],
  }),
  component: AdvertisementVideosPage,
});

export interface AdVideoItem {
  id: string;
  userId: string;
  creatorName: string;
  title: string;
  description: string;
  videoUrl: string;
  thumbnailUrl: string;
  videoType: "free" | "premium";
  contentType: "short" | "long";
  category: string;
  duration: string;
  views: number;
  likes: number;
  paymentStatus: string;
  paymentId?: string;
  paymentAmount: number;
  isPromoted: boolean;
  isActivePromoted?: boolean;
  rawIsPromoted?: boolean;
  promotionPlan?: string;
  promotionExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

const AD_PLAN_PRESETS: Record<
  string,
  { name: string; duration: string; price: number; label: string }
> = {
  "plan-7-days": {
    name: "7-Day Sprint",
    duration: "7 Days",
    price: 100,
    label: "7-Day Sprint Boost",
  },
  "plan-15-days": {
    name: "15-Day Booster",
    duration: "15 Days",
    price: 200,
    label: "15-Day Mid-Roll Placement",
  },
  "plan-monthly": {
    name: "Monthly Pro",
    duration: "30 Days",
    price: 300,
    label: "30-Day Monthly Pro Campaign",
  },
  "plan-yearly": {
    name: "Annual Authority",
    duration: "365 Days",
    price: 3000,
    label: "365-Day Annual Sponsorship",
  },
};

function formatCompactNumber(num: number): string {
  if (num >= 1_000_000) {
    return (num / 1_000_000).toFixed(1) + "M";
  }
  if (num >= 1_000) {
    return (num / 1_000).toFixed(1) + "K";
  }
  return num.toLocaleString();
}

function getRemainingDays(expiresAt?: string | null): number | null {
  if (!expiresAt) return null;
  const exp = new Date(expiresAt).getTime();
  if (Number.isNaN(exp)) return null;
  const diff = exp - Date.now();
  if (diff <= 0) return 0;
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function AdvertisementVideosPage() {
  const { user, dbUser, role, isAdmin, isLoading: authLoading } = useAuth();

  const currentUserId =
    dbUser?.user_id ||
    (user as any)?.user_id ||
    user?.user_metadata?.user_id ||
    (user as any)?.userId ||
    user?.id ||
    "";

  // Admin audit scope toggle: 'my' (own videos) or 'all' (all platform creators)
  const [adminScope, setAdminScope] = useState<"my" | "all">("my");
  const [filterTab, setFilterTab] = useState<
    "active" | "all_promoted" | "completed" | "all_uploads"
  >("active");
  const [searchQuery, setSearchQuery] = useState("");

  const [videos, setVideos] = useState<AdVideoItem[]>([]);
  const [wallet, setWallet] = useState<UserWallet | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!currentUserId && !isAdmin) {
      setWallet(null);
      setWalletError(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);
    setWalletError(null);

    try {
      const isTargetingAll = isAdmin && adminScope === "all";
      const targetUserId = isTargetingAll ? undefined : currentUserId;

      // 1. Fetch real uploaded videos from backend API
      const videoParams: { userId?: string; limit?: number } = { limit: 100 };
      if (targetUserId) {
        videoParams.userId = targetUserId;
      }

      const [res, walletRes] = await Promise.all([
        api.videos.list(videoParams),
        currentUserId ? getAuthoritativeUserWallet(currentUserId) : Promise.resolve(null),
      ]);
      const rawVideos: any[] = res?.videos || [];

      const mappedVideos: AdVideoItem[] = rawVideos.map((v: any) => {
        // Evaluate active promotion status accurately against expiry
        const isMarked = Boolean(v.isPromoted ?? v.is_promoted);
        const expiryRaw = v.promotionExpiresAt || v.promotion_expires_at;
        const expiryTime = expiryRaw ? new Date(expiryRaw).getTime() : NaN;
        const isActive = isMarked && !Number.isNaN(expiryTime) && expiryTime > Date.now();

        return {
          id: String(v.id),
          userId: v.userId || v.user_id || "",
          creatorName: v.creatorName || v.creator_name || "Creator",
          title: v.title || "Untitled Video",
          description: v.description || "",
          videoUrl: resolveMediaUrl(v.videoUrl || v.video_url || ""),
          thumbnailUrl: resolveVideoThumbnail({
            thumbnailUrl: v.thumbnailUrl || v.thumbnail_url,
            category: v.category,
          }),
          videoType: (v.videoType || v.video_type || "free") as "free" | "premium",
          contentType: (v.contentType || v.content_type || "long") as "short" | "long",
          category: v.category || "General",
          duration: v.duration || "0:00",
          views: Number(v.views) || 0,
          likes: Number(v.likes) || 0,
          paymentStatus: v.paymentStatus || v.payment_status || "not_required",
          paymentId: v.paymentId || v.payment_id,
          paymentAmount: Number(v.paymentAmount || v.payment_amount) || 0,
          isPromoted: isActive,
          isActivePromoted: isActive,
          rawIsPromoted: Boolean(v.rawIsPromoted || v.raw_is_promoted || isMarked),
          promotionPlan: v.promotionPlan || v.promotion_plan,
          promotionExpiresAt: expiryRaw,
          createdAt: v.createdAt || v.created_at || new Date().toISOString(),
          updatedAt: v.updatedAt || v.updated_at || new Date().toISOString(),
        };
      });

      setVideos(mappedVideos);

      // 2. Apply authoritative wallet response cleanly (without swallowing failures)
      if (currentUserId && walletRes) {
        if (walletRes.wallet) {
          setWallet(walletRes.wallet);
          setWalletError(null);
        } else {
          setWallet(null);
          setWalletError(
            walletRes.error || "Unable to load authoritative ad revenue balance from server.",
          );
        }
      } else {
        setWallet(null);
      }
    } catch (err: any) {
      console.error("Failed to load advertisement videos:", err);
      setErrorMessage(
        err?.message || "Unable to load advertisement videos from backend. Please retry.",
      );
    } finally {
      setIsLoading(false);
    }
  }, [currentUserId, isAdmin, adminScope]);

  useEffect(() => {
    if (!authLoading) {
      loadData();
    }
  }, [authLoading, loadData]);

  // Calculations across all real campaign items
  const activePromotedList = useMemo(() => videos.filter((v) => v.isPromoted), [videos]);

  const allPromotedList = useMemo(
    () => videos.filter((v) => v.isPromoted || v.rawIsPromoted || Boolean(v.promotionPlan)),
    [videos],
  );

  const completedList = useMemo(
    () => videos.filter((v) => (v.rawIsPromoted || Boolean(v.promotionPlan)) && !v.isPromoted),
    [videos],
  );

  // Filtered list based on active tab and search query
  const displayedVideos = useMemo(() => {
    let baseList: AdVideoItem[];
    if (filterTab === "active") {
      baseList = activePromotedList;
    } else if (filterTab === "all_promoted") {
      baseList = allPromotedList;
    } else if (filterTab === "completed") {
      baseList = completedList;
    } else {
      baseList = videos;
    }

    if (!searchQuery.trim()) return baseList;

    const q = searchQuery.toLowerCase().trim();
    return baseList.filter(
      (v) =>
        v.title.toLowerCase().includes(q) ||
        v.category.toLowerCase().includes(q) ||
        v.creatorName.toLowerCase().includes(q) ||
        (v.promotionPlan && v.promotionPlan.toLowerCase().includes(q)),
    );
  }, [filterTab, activePromotedList, allPromotedList, completedList, videos, searchQuery]);

  // Aggregate KPI metrics from real backend data
  const totalActiveAds = activePromotedList.length;
  const totalPromotions = allPromotedList.length;

  // Real views and likes across all promoted campaigns
  const totalCampaignViews = useMemo(() => {
    const listToSum = allPromotedList.length > 0 ? allPromotedList : videos;
    return listToSum.reduce((acc, v) => acc + v.views, 0);
  }, [allPromotedList, videos]);

  const totalCampaignLikes = useMemo(() => {
    const listToSum = allPromotedList.length > 0 ? allPromotedList : videos;
    return listToSum.reduce((acc, v) => acc + v.likes, 0);
  }, [allPromotedList, videos]);

  const averageEngagementRate = useMemo(() => {
    if (totalCampaignViews === 0) return "0.00%";
    return ((totalCampaignLikes / totalCampaignViews) * 100).toFixed(2) + "%";
  }, [totalCampaignLikes, totalCampaignViews]);

  return (
    <VideoHubLayout>
      <div className="px-4 py-6 sm:px-6 lg:px-8 space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
          <div className="flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-purple-500/10 text-purple-400">
              <Tv className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl">
                Ad Videos
              </h1>
              <p className="text-sm text-muted-foreground">
                Sponsor campaigns, pre-roll advert placements, and direct brand partner deliveries
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5 flex-wrap">
            {isAdmin && (
              <div className="inline-flex rounded-full border border-border bg-card p-1 text-xs">
                <button
                  type="button"
                  onClick={() => setAdminScope("my")}
                  className={`rounded-full px-3 py-1 font-semibold transition ${
                    adminScope === "my"
                      ? "bg-brand text-white shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  My Campaigns
                </button>
                <button
                  type="button"
                  onClick={() => setAdminScope("all")}
                  className={`rounded-full px-3 py-1 font-semibold transition ${
                    adminScope === "all"
                      ? "bg-brand text-white shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  All Creators (Admin)
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={loadData}
              disabled={isLoading}
              title="Refresh Campaigns"
              className="inline-flex items-center justify-center rounded-full border border-border bg-card p-2 text-muted-foreground transition hover:text-foreground hover:bg-secondary disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            </button>

            <Link
              to="/ads-promotions"
              className="inline-flex items-center justify-center gap-2 rounded-full bg-brand px-4 py-2 text-xs font-bold text-white shadow-lift transition hover:bg-brand-dark active:scale-95"
            >
              <Plus className="h-4 w-4" />
              Create Ad Campaign
            </Link>
          </div>
        </div>

        {/* Authentication Notice if not logged in */}
        {!authLoading && !currentUserId && !isAdmin && (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-5 text-amber-200 space-y-3">
            <div className="flex items-center gap-2 font-bold text-sm">
              <Lock className="h-4 w-4 text-amber-400" />
              Creator Authentication Required
            </div>
            <p className="text-xs text-amber-300/90 leading-relaxed">
              Please sign in with your FaceTube creator account to view your dynamic sponsor
              campaign analytics, active ad spots, and authoritative ledger payouts.
            </p>
            <div>
              <Link
                to="/login"
                className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-3.5 py-1.5 text-xs font-bold text-black hover:bg-amber-400"
              >
                Sign In to FaceTube
              </Link>
            </div>
          </div>
        )}

        {/* Error State Banner */}
        {errorMessage && (
          <div className="rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-destructive flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
            <button
              type="button"
              onClick={loadData}
              className="rounded-lg bg-destructive px-3 py-1 text-xs font-bold text-white hover:opacity-90"
            >
              Retry
            </button>
          </div>
        )}

        {walletError && (
          <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-amber-200 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
              <span>{walletError}</span>
            </div>
            <button
              type="button"
              onClick={loadData}
              className="rounded-lg bg-amber-500 px-3 py-1 text-xs font-bold text-black hover:bg-amber-400"
            >
              Retry
            </button>
          </div>
        )}

        {/* KPI Summary Stats Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {/* Card 1: Active Ad Videos */}
          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">Active Ad Videos</span>
            {isLoading ? (
              <Skeleton className="h-8 w-16 my-1" />
            ) : (
              <p className="text-2xl font-black text-purple-400">{totalActiveAds}</p>
            )}
            <p className="text-[11px] text-muted-foreground">
              {isLoading ? "Calculating..." : `${totalPromotions} total launched`}
            </p>
          </div>

          {/* Card 2: AdSense Video Revenue (distinct from combined Total Ad Earning) */}
          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">AdSense Video Revenue</span>
            {isLoading ? (
              <Skeleton className="h-8 w-24 my-1" />
            ) : wallet ? (
              <p className="text-2xl font-black text-emerald-400">
                ₹
                {Number(wallet.adsenseIncome ?? 0).toLocaleString("en-IN", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </p>
            ) : (
              <p className="text-2xl font-black text-muted-foreground">Unavailable</p>
            )}
            <p className="text-[11px] text-emerald-400 font-semibold flex items-center gap-1">
              <TrendingUp className="h-3 w-3 shrink-0" />
              {wallet
                ? `Total Ad Earning (AdSense + AdMob): ₹${calculateTotalAdEarning(wallet).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : "Authoritative ledger unavailable"}
            </p>
          </div>

          {/* Card 3: Total Ad Views */}
          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">Total Ad Views</span>
            {isLoading ? (
              <Skeleton className="h-8 w-20 my-1" />
            ) : (
              <p className="text-2xl font-black text-foreground">
                {formatCompactNumber(totalCampaignViews)}
              </p>
            )}
            <p className="text-[11px] text-muted-foreground">Across verified video deliverables</p>
          </div>

          {/* Card 4: Verified Engagement */}
          <div className="rounded-2xl border border-border bg-card p-4 space-y-1 shadow-card">
            <span className="text-xs text-muted-foreground font-medium">Viewer Engagement</span>
            {isLoading ? (
              <Skeleton className="h-8 w-16 my-1" />
            ) : (
              <p className="text-2xl font-black text-foreground">{averageEngagementRate}</p>
            )}
            <p className="text-[11px] text-muted-foreground">
              {isLoading
                ? "Calculating..."
                : `${totalCampaignLikes.toLocaleString()} verified likes`}
            </p>
          </div>
        </div>

        {/* Filter Tabs & Search Bar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2">
          <div className="flex items-center gap-1.5 flex-wrap border-b border-border/60 sm:border-0 pb-2 sm:pb-0">
            <button
              type="button"
              onClick={() => setFilterTab("active")}
              className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition ${
                filterTab === "active"
                  ? "bg-purple-500/20 text-purple-300 border border-purple-500/30"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/60"
              }`}
            >
              Active Spots ({activePromotedList.length})
            </button>
            <button
              type="button"
              onClick={() => setFilterTab("all_promoted")}
              className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition ${
                filterTab === "all_promoted"
                  ? "bg-brand/20 text-brand border border-brand/30"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/60"
              }`}
            >
              All Campaigns ({allPromotedList.length})
            </button>
            <button
              type="button"
              onClick={() => setFilterTab("completed")}
              className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition ${
                filterTab === "completed"
                  ? "bg-secondary text-foreground border border-border"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/60"
              }`}
            >
              Completed ({completedList.length})
            </button>
            <button
              type="button"
              onClick={() => setFilterTab("all_uploads")}
              className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition ${
                filterTab === "all_uploads"
                  ? "bg-secondary text-foreground border border-border"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/60"
              }`}
            >
              All Channel Uploads ({videos.length})
            </button>
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search campaigns, titles..."
              className="w-full rounded-full border border-border bg-card pl-9 pr-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-brand"
            />
          </div>
        </div>

        {/* Campaign Deliverables Grid */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-extrabold text-foreground">
              {filterTab === "active" && "Active Sponsor Deliverables"}
              {filterTab === "all_promoted" && "All Sponsor Campaigns"}
              {filterTab === "completed" && "Completed / Expired Deliverables"}
              {filterTab === "all_uploads" && "All Channel Video Inventory"}
            </h2>
            <span className="text-xs text-muted-foreground">
              {displayedVideos.length}{" "}
              {displayedVideos.length === 1 ? "deliverable" : "deliverables"}
            </span>
          </div>

          {/* Loading Skeleton */}
          {isLoading && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              {[1, 2, 3].map((idx) => (
                <div
                  key={idx}
                  className="overflow-hidden rounded-2xl border border-border bg-card p-0 shadow-card"
                >
                  <Skeleton className="aspect-video w-full" />
                  <div className="p-4 space-y-2.5">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                    <div className="pt-2 border-t border-border/60 flex justify-between">
                      <Skeleton className="h-3 w-20" />
                      <Skeleton className="h-3 w-24" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Empty State */}
          {!isLoading && displayedVideos.length === 0 && (
            <div className="rounded-2xl border border-dashed border-border bg-card/60 p-10 text-center space-y-3">
              <div className="grid h-12 w-12 place-items-center rounded-2xl bg-purple-500/10 text-purple-400 mx-auto">
                <Tv className="h-6 w-6" />
              </div>
              <h3 className="text-sm font-bold text-foreground">No Ad Campaigns Found</h3>
              <p className="text-xs text-muted-foreground max-w-md mx-auto leading-relaxed">
                {filterTab === "active"
                  ? "You do not have any actively running sponsor video campaigns at the moment. Boost any of your channel videos to start featuring here."
                  : "No video deliverables matched your filter or search query."}
              </p>
              <div className="pt-2 flex items-center justify-center gap-3">
                <Link
                  to="/ads-promotions"
                  className="inline-flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-xs font-bold text-white shadow-lift transition hover:bg-brand-dark"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Launch Ad Campaign
                </Link>
                {filterTab !== "all_uploads" && (
                  <button
                    type="button"
                    onClick={() => setFilterTab("all_uploads")}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-4 py-2 text-xs font-semibold text-foreground hover:bg-secondary"
                  >
                    View All Videos
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Dynamic Video Deliverables Cards */}
          {!isLoading && displayedVideos.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {displayedVideos.map((ad) => {
                const planPreset = ad.promotionPlan ? AD_PLAN_PRESETS[ad.promotionPlan] : null;
                const remainingDays = getRemainingDays(ad.promotionExpiresAt);

                // Slot type display
                const slotTypeLabel =
                  planPreset?.label ||
                  (ad.promotionPlan
                    ? `Campaign (${ad.promotionPlan})`
                    : "Standard Video Deliverable");

                // Budget or deliverable price
                const budgetLabel =
                  planPreset?.price !== undefined
                    ? `₹${planPreset.price.toFixed(2)}`
                    : ad.paymentAmount > 0
                      ? `₹${ad.paymentAmount.toFixed(2)}`
                      : "Standard Spot";

                // Engagement rate
                const engagementPercent =
                  ad.views > 0 ? ((ad.likes / ad.views) * 100).toFixed(2) + "%" : "0.00%";

                return (
                  <div
                    key={ad.id}
                    className="group overflow-hidden rounded-2xl border border-border bg-card shadow-card transition duration-200 hover:-translate-y-1 hover:shadow-lift flex flex-col justify-between"
                  >
                    <div>
                      {/* Thumbnail Container */}
                      <div className="relative aspect-video w-full overflow-hidden bg-secondary">
                        <img
                          src={ad.thumbnailUrl || SVG_FALLBACK_THUMBNAIL}
                          alt={ad.title}
                          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                          referrerPolicy="no-referrer"
                          onError={(e) => {
                            (e.target as HTMLImageElement).src = SVG_FALLBACK_THUMBNAIL;
                          }}
                        />

                        {/* Status Badge */}
                        <div className="absolute top-2 left-2 flex items-center gap-1.5 flex-wrap">
                          {ad.isPromoted ? (
                            <span className="rounded-md bg-emerald-500 text-white px-2 py-0.5 text-[10px] font-bold shadow-sm flex items-center gap-1">
                              <CheckCircle2 className="h-2.5 w-2.5" />
                              Active{remainingDays !== null ? ` · ${remainingDays}d left` : ""}
                            </span>
                          ) : ad.rawIsPromoted ? (
                            <span className="rounded-md bg-secondary/90 text-foreground px-2 py-0.5 text-[10px] font-bold shadow-sm flex items-center gap-1">
                              <Clock className="h-2.5 w-2.5" /> Completed
                            </span>
                          ) : (
                            <span className="rounded-md bg-secondary/80 text-muted-foreground px-2 py-0.5 text-[10px] font-medium shadow-sm">
                              Standard Upload
                            </span>
                          )}

                          <span className="rounded-md bg-black/70 backdrop-blur-xs text-white/90 px-1.5 py-0.5 text-[9px] font-semibold uppercase">
                            {ad.contentType}
                          </span>
                        </div>

                        {/* Budget Tag */}
                        <span className="absolute bottom-2 right-2 rounded-md bg-black/80 backdrop-blur-xs px-2 py-0.5 text-[10px] font-mono font-bold text-emerald-400">
                          {budgetLabel}
                        </span>
                      </div>

                      {/* Card Content */}
                      <div className="p-4 space-y-2">
                        <h3 className="line-clamp-1 text-xs font-bold text-foreground leading-snug group-hover:text-brand transition-colors">
                          {ad.title}
                        </h3>

                        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                          <span className="truncate">{slotTypeLabel}</span>
                          <span className="shrink-0 text-[10px] rounded px-1.5 py-0.2 bg-secondary text-secondary-foreground font-medium">
                            {ad.category}
                          </span>
                        </div>

                        {/* Admin Scope Creator attribution */}
                        {isAdmin && adminScope === "all" && (
                          <p className="text-[10px] text-muted-foreground truncate border-t border-border/40 pt-1">
                            Creator:{" "}
                            <span className="font-semibold text-foreground">
                              {ad.creatorName} ({ad.userId})
                            </span>
                          </p>
                        )}

                        {/* Metrics Row */}
                        <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-2 border-t border-border/60">
                          <span className="flex items-center gap-1">
                            <Eye className="h-3 w-3 text-muted-foreground" />
                            {ad.views.toLocaleString()} Views
                          </span>
                          <span className="font-semibold text-foreground flex items-center gap-1">
                            <Heart className="h-3 w-3 text-rose-400" />
                            {ad.likes.toLocaleString()} ({engagementPercent} eng)
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Card Actions Footer */}
                    <div className="px-4 pb-3.5 pt-1 flex items-center justify-between gap-2 border-t border-border/40 text-[11px]">
                      <Link
                        to="/watch/$videoId"
                        params={{ videoId: ad.id }}
                        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground font-medium transition-colors"
                      >
                        <Play className="h-3 w-3 text-brand" /> Watch Video
                      </Link>

                      <Link
                        to="/ads-promotions"
                        className="inline-flex items-center gap-1 font-bold text-brand hover:text-brand-dark transition-colors"
                      >
                        <Sparkles className="h-3 w-3" />
                        {ad.isPromoted ? "Extend Plan" : "Promote Video"}
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </VideoHubLayout>
  );
}
