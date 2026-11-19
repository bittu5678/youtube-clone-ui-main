import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useRef, useEffect } from "react";
import {
  User,
  Settings,
  History,
  Clock,
  ThumbsUp,
  LogOut,
  TrendingUp,
  DollarSign,
  Eye,
  X,
  Landmark,
  Link2,
  Lock,
  Camera,
  Upload,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Logo } from "@/components/videohub/Logo";
import { ThemeToggle } from "@/components/videohub/ThemeToggle";
import { BottomNav } from "@/components/videohub/BottomNav";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { resolveVideoThumbnail, SVG_FALLBACK_THUMBNAIL } from "@/lib/thumbnail-service";
import {
  getAuthoritativeUserWallet,
  calculateTotalAdEarning,
  type UserWallet,
} from "@/lib/ledger-service";
import { PersonalKycTab } from "@/components/profile/PersonalKycTab";
import { BankKycTab } from "@/components/profile/BankKycTab";
import { ReferralLinkTab } from "@/components/profile/ReferralLinkTab";
import { ChangePasswordTab } from "@/components/profile/ChangePasswordTab";

export interface ProfileSearch {
  tab?: string | undefined;
}

export const Route = createFileRoute("/profile")({
  validateSearch: (search: Record<string, unknown>): ProfileSearch => ({
    tab: typeof search["tab"] === "string" ? search["tab"] : undefined,
  }),
  head: () => ({
    meta: [
      { title: "You — FaceTube" },
      {
        name: "description",
        content:
          "Your FaceTube channel profile, verified ad earnings, uploaded videos, and account settings.",
      },
    ],
  }),
  component: ProfilePage,
});

type ProfileTabType = "personal-kyc" | "bank-kyc" | "referral-link" | "change-password";

interface ChannelVideoItem {
  id: string;
  title: string;
  views: number;
  duration: string;
  thumb: string;
  contentType: "short" | "long";
  videoType: "free" | "premium";
  createdAt: string;
}

function ProfilePage() {
  const searchParams = Route.useSearch();
  const {
    user,
    profile,
    dbUser,
    isAdmin,
    isLoading: authLoading,
    signOut,
    refreshUsers,
  } = useAuth();

  const [profileTab, setProfileTab] = useState<ProfileTabType>(
    searchParams.tab === "change-password" ||
      searchParams.tab === "bank-kyc" ||
      searchParams.tab === "referral-link" ||
      searchParams.tab === "personal-kyc"
      ? searchParams.tab
      : "personal-kyc",
  );
  const [activeTab, setActiveTab] = useState<"videos" | "shorts" | "playlists">("videos");
  const [editProfileOpen, setEditProfileOpen] = useState(false);

  const userMeta = user?.user_metadata as Record<string, unknown> | undefined;
  const currentUserId =
    profile?.user_id ||
    dbUser?.user_id ||
    (typeof userMeta?.["user_id"] === "string" ? userMeta["user_id"] : "") ||
    "";
  const currentFullName =
    profile?.full_name ||
    profile?.name ||
    dbUser?.name ||
    (typeof userMeta?.["name"] === "string" ? userMeta["name"] : "") ||
    "";
  const currentMobile =
    profile?.mobile ||
    dbUser?.mobile ||
    (typeof userMeta?.["mobile"] === "string" ? userMeta["mobile"] : "") ||
    "";

  // Editable Profile State
  const [channelName, setChannelName] = useState(
    profile?.channel_name ||
      profile?.full_name ||
      profile?.name ||
      dbUser?.name ||
      "FaceTube Creator",
  );
  const [channelLogoUrl, setChannelLogoUrl] = useState(
    profile?.channel_logo_url || dbUser?.channel_logo_url || "",
  );
  const [channelHandle, setChannelHandle] = useState(
    profile?.username || (currentUserId ? currentUserId.toLowerCase() : "creator"),
  );
  const [channelBio, setChannelBio] = useState("Creator channel powered by FaceTube.");
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const resolvedName =
      profile?.channel_name ||
      profile?.full_name ||
      profile?.name ||
      dbUser?.name ||
      "FaceTube Creator";
    setChannelName(resolvedName);
    setChannelLogoUrl(profile?.channel_logo_url || dbUser?.channel_logo_url || "");
    setChannelHandle(
      profile?.username || (currentUserId ? currentUserId.toLowerCase() : "creator"),
    );
  }, [profile, dbUser, currentUserId]);

  // Authoritative Wallet, Videos & Subscriber State
  const [wallet, setWallet] = useState<UserWallet | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [isWalletLoading, setIsWalletLoading] = useState(false);

  const [channelVideos, setChannelVideos] = useState<ChannelVideoItem[] | null>(null);
  const [videosError, setVideosError] = useState<string | null>(null);
  const [isVideosLoading, setIsVideosLoading] = useState(false);

  const [subscriberCount, setSubscriberCount] = useState<number | null>(null);
  const [isSubLoading, setIsSubLoading] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!currentUserId) {
      setWallet(null);
      setWalletError(null);
      setChannelVideos(null);
      setVideosError(null);
      setSubscriberCount(null);
      setIsWalletLoading(false);
      setIsVideosLoading(false);
      setIsSubLoading(false);
      return;
    }

    let mounted = true;
    setIsWalletLoading(true);
    setIsVideosLoading(true);
    setIsSubLoading(true);
    setWalletError(null);
    setVideosError(null);

    getAuthoritativeUserWallet(currentUserId)
      .then((res) => {
        if (!mounted) return;
        if (res.wallet) {
          setWallet(res.wallet);
          setWalletError(null);
        } else {
          setWallet(null);
          setWalletError(res.error || "Unable to load authoritative wallet balance.");
        }
      })
      .catch((err) => {
        if (!mounted) return;
        setWallet(null);
        setWalletError(err instanceof Error ? err.message : "Failed to load wallet.");
      })
      .finally(() => {
        if (mounted) setIsWalletLoading(false);
      });

    api.videos
      .list({ userId: currentUserId, limit: 100 })
      .then((res) => {
        if (!mounted) return;
        if (res && res.success !== false && Array.isArray(res.videos)) {
          const mapped: ChannelVideoItem[] = res.videos.map((v: any) => ({
            id: String(v.id),
            title: v.title || "Untitled Video",
            views: Number(v.views) || 0,
            duration: v.duration || "0:00",
            thumb: resolveVideoThumbnail({
              thumbnailUrl: v.thumbnail_url || v.thumbnailUrl,
              category: v.category,
            }),
            contentType:
              String(v.content_type || v.contentType || "long").toLowerCase() === "short"
                ? "short"
                : "long",
            videoType:
              String(v.video_type || v.videoType || "free").toLowerCase() === "premium"
                ? "premium"
                : "free",
            createdAt: v.created_at || v.createdAt || "",
          }));
          setChannelVideos(mapped);
          setVideosError(null);
        } else {
          setChannelVideos(null);
          setVideosError("Unable to load channel videos.");
        }
      })
      .catch((err) => {
        if (!mounted) return;
        setChannelVideos(null);
        setVideosError(err instanceof Error ? err.message : "Unable to load channel videos.");
      })
      .finally(() => {
        if (mounted) setIsVideosLoading(false);
      });

    api.channel
      .getSubscriberCount(currentUserId)
      .then((res) => {
        if (!mounted) return;
        if (res && res.success) {
          setSubscriberCount(Number(res.subscriber_count) || 0);
        } else {
          setSubscriberCount(null);
        }
      })
      .catch(() => {
        if (mounted) setSubscriberCount(null);
      })
      .finally(() => {
        if (mounted) setIsSubLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [authLoading, currentUserId]);

  const longVideos = (channelVideos || []).filter((v) => v.contentType !== "short");
  const shortVideos = (channelVideos || []).filter((v) => v.contentType === "short");
  const totalViewsCount =
    channelVideos !== null ? channelVideos.reduce((sum, v) => sum + v.views, 0) : null;

  const adsenseIncome = wallet ? Number(wallet.adsenseIncome) || 0 : null;
  const admobIncome = wallet ? Number(wallet.admobIncome) || 0 : null;
  const totalAdEarning = wallet ? calculateTotalAdEarning(wallet) : null;

  const handleLogoFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !currentUserId) return;

    const validTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!validTypes.includes(file.type)) {
      toast.error("Please upload a JPG, PNG, or WEBP image for channel logo.");
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      toast.error("Image file size cannot exceed 10MB.");
      return;
    }

    setUploadingLogo(true);
    try {
      const uploadRes = await api.uploads.uploadImage(file);
      if (uploadRes && uploadRes.url) {
        setChannelLogoUrl(uploadRes.url);
        await api.users.updateChannelLogo({
          userId: currentUserId,
          channelLogoUrl: uploadRes.url,
          channelName,
        });
        await refreshUsers();
        toast.success("Channel logo updated successfully!");
      } else {
        toast.error("Failed to upload channel logo image.");
      }
    } catch (err: any) {
      toast.error(err?.message || "Failed to update channel logo.");
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUserId) return;
    try {
      await api.users.updateChannelLogo({
        userId: currentUserId,
        channelLogoUrl,
        channelName,
      });
      await refreshUsers();
      setEditProfileOpen(false);
      toast.success("Profile and channel branding updated successfully!");
    } catch {
      setEditProfileOpen(false);
      toast.error("Failed to sync profile update to server.");
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground antialiased selection:bg-brand selection:text-white pb-24 md:pb-28">
      {/* Hidden Channel Logo Input */}
      <input
        ref={logoInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={handleLogoFileSelect}
        className="hidden"
      />

      {/* Top Header */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Logo size={30} />
            <span className="rounded-full bg-brand/10 px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wider text-brand">
              You
            </span>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <ThemeToggle showLabelsOnWide={false} />
            <Link
              to="/settings"
              className="grid h-9 w-9 place-items-center rounded-full text-muted-foreground hover:bg-secondary hover:text-foreground transition"
              aria-label="Account settings"
              title="Account settings"
            >
              <Settings className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </header>

      {/* Main Profile Container */}
      <main className="mx-auto max-w-5xl px-4 sm:px-6 pt-6 space-y-8">
        {/* Unauthenticated Sign-In Prompt */}
        {!authLoading && !currentUserId && (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 text-xs text-amber-200">
              <Lock className="h-4 w-4 text-amber-400 shrink-0" />
              <span>
                Sign in with your FaceTube creator account to view your channel analytics, Total Ad
                Earning, and uploaded videos.
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

        {/* User Identity Banner Card */}
        <div className="relative overflow-hidden rounded-3xl border border-border bg-card p-6 shadow-sm">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-5">
            <div className="flex items-center gap-4">
              {/* Channel Logo Avatar with Camera Upload Trigger */}
              <div className="relative group shrink-0">
                {channelLogoUrl ? (
                  <img
                    src={channelLogoUrl}
                    alt={channelName}
                    className="h-20 w-20 shrink-0 rounded-full object-cover ring-4 ring-brand/20 shadow-md"
                  />
                ) : (
                  <div className="grid h-20 w-20 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand via-brand-dark to-black text-2xl font-bold text-white ring-4 ring-brand/20 shadow-md">
                    {(channelName || "F").charAt(0).toUpperCase()}
                  </div>
                )}
                {currentUserId && (
                  <button
                    type="button"
                    disabled={uploadingLogo}
                    onClick={() => logoInputRef.current?.click()}
                    className="absolute -bottom-1 -right-1 grid h-7 w-7 place-items-center rounded-full bg-brand text-white shadow-md hover:bg-brand-dark transition active:scale-95 border-2 border-card"
                    title="Upload Channel Logo"
                  >
                    <Camera className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-xl sm:text-2xl font-extrabold text-foreground">
                    {currentUserId ? channelName : "Guest Viewer"}
                  </h1>
                  {isAdmin && (
                    <span className="rounded-full bg-brand px-2.5 py-0.5 text-[10px] font-bold text-brand-foreground shadow-sm">
                      Admin
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1.5">
                  <span>
                    @{channelHandle}
                    {user?.email ? ` · ${user.email}` : ""}
                  </span>
                  {currentUserId && (
                    <span className="font-mono font-bold text-brand bg-brand/10 px-2 py-0.5 rounded-md border border-brand/20">
                      ID: {currentUserId}
                    </span>
                  )}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <span className="text-brand">
                    <strong className="text-brand">
                      {isSubLoading
                        ? "..."
                        : subscriberCount !== null
                          ? subscriberCount.toLocaleString()
                          : "—"}
                    </strong>{" "}
                    subscribers
                  </span>
                  <span>•</span>
                  <span>
                    <strong className="text-foreground">
                      {isVideosLoading
                        ? "..."
                        : totalViewsCount !== null
                          ? totalViewsCount.toLocaleString()
                          : "—"}
                    </strong>{" "}
                    total views
                  </span>
                  <span>•</span>
                  <span>
                    <strong className="text-foreground">
                      {isVideosLoading
                        ? "..."
                        : channelVideos !== null
                          ? channelVideos.length
                          : "—"}
                    </strong>{" "}
                    videos
                  </span>
                </div>
                <p className="mt-2 text-xs text-foreground/80 line-clamp-2 max-w-xl">
                  {channelBio}
                </p>
              </div>
            </div>

            {/* Actions: Edit Profile, Sign out / Sign in */}
            <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
              {currentUserId && (
                <button
                  type="button"
                  onClick={() => setEditProfileOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-xs font-bold text-white shadow-lift transition hover:bg-brand-dark active:scale-95"
                >
                  Edit Profile
                </button>
              )}

              {user ? (
                <button
                  type="button"
                  onClick={() => signOut()}
                  className="inline-flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/10 px-3.5 py-2 text-xs font-semibold text-red-500 transition hover:bg-red-500/20"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  Sign Out
                </button>
              ) : (
                <Link
                  to="/auth"
                  className="rounded-full bg-brand px-5 py-2 text-xs font-bold text-white shadow-sm transition hover:bg-brand-dark"
                >
                  Sign In
                </Link>
              )}
            </div>
          </div>
        </div>

        {/* Analytics Summary Card */}
        <section className="rounded-3xl border border-border bg-card p-5 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-brand" />
              Channel Analytics
            </h2>
            <Link to="/your-videos" className="text-xs font-semibold text-brand hover:underline">
              Full Studio
            </Link>
          </div>

          {currentUserId && walletError && !isWalletLoading && (
            <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 flex items-center gap-2 text-xs text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{walletError}</span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="rounded-2xl border border-border bg-secondary/40 p-4">
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="text-xs font-medium">Total Video Views</span>
                <Eye className="h-4 w-4 text-blue-500" />
              </div>
              <p className="mt-2 text-2xl font-black text-foreground">
                {isVideosLoading
                  ? "..."
                  : totalViewsCount !== null
                    ? totalViewsCount.toLocaleString()
                    : "Unavailable"}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {channelVideos !== null
                  ? `Across ${channelVideos.length} uploaded video${channelVideos.length === 1 ? "" : "s"}`
                  : "Requires authenticated channel video sync"}
              </p>
            </div>

            <div className="rounded-2xl border border-border bg-secondary/40 p-4">
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="text-xs font-medium">Watch Time</span>
                <Clock className="h-4 w-4 text-purple-500" />
              </div>
              <p className="mt-2 text-2xl font-black text-foreground">—</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Unavailable (no watch-duration telemetry API)
              </p>
            </div>

            <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-4">
              <div className="flex items-center justify-between text-emerald-400">
                <span className="text-xs font-bold">Total Ad Earning</span>
                <DollarSign className="h-4 w-4 text-emerald-500" />
              </div>
              <p className="mt-2 text-2xl font-black text-emerald-400 font-mono">
                {isWalletLoading
                  ? "..."
                  : totalAdEarning !== null
                    ? `₹${totalAdEarning.toFixed(2)}`
                    : "Unavailable"}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {adsenseIncome !== null && admobIncome !== null
                  ? `AdSense ₹${adsenseIncome.toFixed(2)} + AdMob ₹${admobIncome.toFixed(2)}`
                  : "Verified AdSense + AdMob only"}
              </p>
            </div>
          </div>
        </section>

        {/* Profile Tabs & Sections: Personal KYC, Bank KYC, Referral Link, Change Password */}
        {currentUserId && (
          <section className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border pb-3">
              <div className="flex items-center gap-2 overflow-x-auto no-scrollbar py-0.5 w-full sm:w-auto">
                {(
                  [
                    {
                      id: "personal-kyc" as const,
                      label: "Personal KYC",
                      icon: User,
                      emoji: "👤",
                    },
                    { id: "bank-kyc" as const, label: "Bank KYC", icon: Landmark, emoji: "🏦" },
                    {
                      id: "referral-link" as const,
                      label: "Referral Link",
                      icon: Link2,
                      emoji: "🔗",
                    },
                    {
                      id: "change-password" as const,
                      label: "Change Password",
                      icon: Lock,
                      emoji: "🔒",
                    },
                  ] as const
                ).map((tab) => {
                  const Icon = tab.icon;
                  const isActive = profileTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setProfileTab(tab.id)}
                      className={`relative flex items-center gap-2 px-4 py-2.5 rounded-2xl text-xs sm:text-sm font-bold transition whitespace-nowrap cursor-pointer ${
                        isActive
                          ? "bg-brand text-white shadow-lift ring-2 ring-brand/30"
                          : "bg-secondary/60 text-muted-foreground hover:text-foreground hover:bg-secondary"
                      }`}
                    >
                      <span>{tab.emoji}</span>
                      <Icon className="h-4 w-4" />
                      <span>{tab.label}</span>
                    </button>
                  );
                })}
              </div>

              <span className="text-[11px] text-muted-foreground font-medium hidden sm:inline">
                Account Management &amp; Verification
              </span>
            </div>

            {profileTab === "personal-kyc" && (
              <PersonalKycTab
                userId={currentUserId}
                defaultFullName={currentFullName}
                defaultMobile={currentMobile}
              />
            )}

            {profileTab === "bank-kyc" && (
              <BankKycTab userId={currentUserId} defaultFullName={currentFullName} />
            )}

            {profileTab === "referral-link" && (
              <ReferralLinkTab userId={currentUserId} userName={channelName} />
            )}

            {profileTab === "change-password" && <ChangePasswordTab />}
          </section>
        )}

        {/* Channel Content Library: Videos | Shorts | Playlists */}
        <section className="space-y-4 pt-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
              Channel Media &amp; Playlists
            </h2>
          </div>
          <div className="flex border-b border-border">
            {(
              [
                { id: "videos", label: "Videos", count: longVideos.length },
                { id: "shorts", label: "Shorts", count: shortVideos.length },
                { id: "playlists", label: "Playlists", count: 3 },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`relative flex items-center gap-2 px-5 py-3 text-sm font-semibold transition ${
                  activeTab === tab.id
                    ? "text-brand"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <span>{tab.label}</span>
                <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-bold text-muted-foreground">
                  {isVideosLoading && tab.id !== "playlists" ? "..." : tab.count}
                </span>
                {activeTab === tab.id && (
                  <span className="absolute bottom-0 inset-x-0 h-0.5 bg-brand rounded-full" />
                )}
              </button>
            ))}
          </div>

          {/* Tab 1: Long Videos Grid */}
          {activeTab === "videos" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  {isVideosLoading
                    ? "Loading uploaded videos..."
                    : videosError
                      ? videosError
                      : `Showing ${longVideos.length} uploaded videos`}
                </p>
                <Link
                  to="/upload"
                  className="rounded-full bg-brand px-4 py-1.5 text-xs font-bold text-white transition hover:bg-brand-dark shadow-sm"
                >
                  Upload New
                </Link>
              </div>

              {longVideos.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  {longVideos.map((v) => (
                    <div
                      key={v.id}
                      className="group relative rounded-2xl border border-border bg-card p-2.5 transition-all hover:border-brand/40 hover:shadow-md flex flex-col justify-between"
                    >
                      <div>
                        <Link to="/watch/$videoId" params={{ videoId: v.id }} className="block">
                          <div className="relative aspect-video rounded-xl overflow-hidden bg-black mb-2.5">
                            <img
                              src={v.thumb}
                              alt={v.title}
                              onError={(e) => {
                                const target = e.currentTarget;
                                if (target.src !== SVG_FALLBACK_THUMBNAIL) {
                                  target.src = SVG_FALLBACK_THUMBNAIL;
                                }
                              }}
                              className="h-full w-full object-cover transition duration-300 group-hover:scale-105 opacity-90"
                            />
                            <span className="absolute bottom-1.5 right-1.5 rounded-md bg-black/80 px-1.5 py-0.5 text-[10px] font-bold text-white">
                              {v.duration}
                            </span>
                          </div>
                          <h3 className="text-xs font-bold text-foreground line-clamp-2 group-hover:text-brand transition-colors">
                            {v.title}
                          </h3>
                        </Link>
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {v.views.toLocaleString()} views
                          {v.createdAt ? ` · ${new Date(v.createdAt).toLocaleDateString()}` : ""}
                        </p>
                      </div>

                      <div className="mt-3 flex items-center justify-between border-t border-border/50 pt-2">
                        <span className="rounded bg-brand/10 px-1.5 py-0.5 text-[10px] font-bold text-brand">
                          {v.videoType === "premium" ? "Sponsor" : "Free"}
                        </span>
                        <Link
                          to="/watch/$videoId"
                          params={{ videoId: v.id }}
                          className="text-[11px] font-semibold text-muted-foreground hover:text-foreground"
                        >
                          Watch
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {!isVideosLoading && longVideos.length === 0 && (
                <div className="py-12 text-center rounded-2xl border border-dashed border-border p-6">
                  <p className="text-sm font-semibold text-foreground">
                    {currentUserId
                      ? videosError
                        ? "Videos unavailable"
                        : "No videos uploaded yet"
                      : "Sign in to view your videos"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {videosError || "Upload your first video to grow your channel audience."}
                  </p>
                  <Link
                    to={currentUserId ? "/upload" : "/auth"}
                    className="mt-4 inline-block rounded-full bg-brand px-5 py-2 text-xs font-bold text-white"
                  >
                    {currentUserId ? "Upload Video" : "Sign In"}
                  </Link>
                </div>
              )}
            </div>
          )}

          {/* Tab 2: Real Channel Shorts Tab */}
          {activeTab === "shorts" && (
            <div>
              {shortVideos.length > 0 ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                  {shortVideos.map((short) => (
                    <Link
                      key={short.id}
                      to="/watch/$videoId"
                      params={{ videoId: short.id }}
                      className="group relative rounded-2xl overflow-hidden border border-border bg-black aspect-[9/16] shadow-sm transition hover:scale-[1.02]"
                    >
                      <img
                        src={short.thumb}
                        alt={short.title}
                        onError={(e) => {
                          const target = e.currentTarget;
                          if (target.src !== SVG_FALLBACK_THUMBNAIL) {
                            target.src = SVG_FALLBACK_THUMBNAIL;
                          }
                        }}
                        className="h-full w-full object-cover opacity-85 transition group-hover:opacity-100"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-transparent to-transparent" />
                      <div className="absolute bottom-3 left-3 right-3 text-white">
                        <p className="text-xs font-bold line-clamp-2">{short.title}</p>
                        <p className="mt-1 text-[10px] text-white/80">
                          {short.views.toLocaleString()} views
                        </p>
                      </div>
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="py-12 text-center rounded-2xl border border-dashed border-border p-6">
                  <p className="text-sm font-semibold text-foreground">
                    {isVideosLoading
                      ? "Loading shorts..."
                      : currentUserId
                        ? "No short videos uploaded yet"
                        : "Sign in to view your shorts"}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Tab 3: Playlists Tab */}
          {activeTab === "playlists" && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Link
                to="/watch-later"
                className="group rounded-2xl border border-border bg-card p-4 transition hover:border-brand/50 shadow-sm"
              >
                <div className="aspect-video rounded-xl bg-blue-500/10 flex flex-col items-center justify-center text-blue-500 mb-3 group-hover:bg-blue-500/20 transition">
                  <Clock className="h-8 w-8" />
                  <span className="mt-1 text-xs font-bold">Watch Later</span>
                </div>
                <h3 className="text-sm font-bold text-foreground group-hover:text-brand">
                  Watch Later
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">Saved queue · Private</p>
              </Link>

              <Link
                to="/liked-videos"
                className="group rounded-2xl border border-border bg-card p-4 transition hover:border-brand/50 shadow-sm"
              >
                <div className="aspect-video rounded-xl bg-amber-500/10 flex flex-col items-center justify-center text-amber-500 mb-3 group-hover:bg-amber-500/20 transition">
                  <ThumbsUp className="h-8 w-8" />
                  <span className="mt-1 text-xs font-bold">Liked Videos</span>
                </div>
                <h3 className="text-sm font-bold text-foreground group-hover:text-brand">
                  Liked Videos
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  All favorited videos · Private
                </p>
              </Link>

              <Link
                to="/history"
                className="group rounded-2xl border border-border bg-card p-4 transition hover:border-brand/50 shadow-sm"
              >
                <div className="aspect-video rounded-xl bg-brand/10 flex flex-col items-center justify-center text-brand mb-3 group-hover:bg-brand/20 transition">
                  <History className="h-8 w-8" />
                  <span className="mt-1 text-xs font-bold">Watch History</span>
                </div>
                <h3 className="text-sm font-bold text-foreground group-hover:text-brand">
                  Watch History
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5">Continuous stream · You only</p>
              </Link>
            </div>
          )}
        </section>
      </main>

      {/* Edit Profile Modal */}
      {editProfileOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-md rounded-3xl border border-border bg-card p-6 shadow-2xl animate-in zoom-in-95">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <h3 className="text-base font-bold text-foreground">Edit Channel Profile</h3>
              <button
                type="button"
                onClick={() => setEditProfileOpen(false)}
                className="rounded-full p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSaveProfile} className="mt-4 space-y-4">
              {/* Channel Logo Upload */}
              <div>
                <label className="text-xs font-semibold text-foreground">Channel Logo</label>
                <div className="mt-2 flex items-center gap-3">
                  {channelLogoUrl ? (
                    <img
                      src={channelLogoUrl}
                      alt={channelName}
                      className="h-12 w-12 rounded-full object-cover ring-2 ring-brand/30"
                    />
                  ) : (
                    <div className="grid h-12 w-12 place-items-center rounded-full bg-brand text-sm font-bold text-white">
                      {(channelName || "F").charAt(0).toUpperCase()}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => logoInputRef.current?.click()}
                    disabled={uploadingLogo}
                    className="rounded-xl border border-border bg-secondary/80 px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary flex items-center gap-1.5"
                  >
                    <Upload className="h-3.5 w-3.5" />
                    <span>{uploadingLogo ? "Uploading..." : "Upload New Logo"}</span>
                  </button>
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-foreground">Channel Name</label>
                <input
                  type="text"
                  value={channelName}
                  onChange={(e) => setChannelName(e.target.value)}
                  required
                  className="mt-1.5 w-full rounded-xl border border-border bg-secondary/60 px-3.5 py-2 text-xs text-foreground outline-none focus:border-brand"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-foreground">Handle</label>
                <div className="mt-1.5 flex items-center rounded-xl border border-border bg-secondary/60 px-3.5 py-2 text-xs text-foreground">
                  <span className="text-muted-foreground mr-1">@</span>
                  <input
                    type="text"
                    value={channelHandle}
                    onChange={(e) => setChannelHandle(e.target.value)}
                    required
                    className="w-full bg-transparent outline-none text-foreground text-xs"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-foreground">Channel Description</label>
                <textarea
                  rows={3}
                  value={channelBio}
                  onChange={(e) => setChannelBio(e.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-border bg-secondary/60 px-3.5 py-2 text-xs text-foreground outline-none focus:border-brand"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-border">
                <button
                  type="button"
                  onClick={() => setEditProfileOpen(false)}
                  className="rounded-full px-4 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-full bg-brand px-5 py-2 text-xs font-bold text-white shadow-lift hover:bg-brand-dark transition active:scale-95"
                >
                  Save Changes
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Fixed Bottom Navigation with 5 tabs */}
      <BottomNav />
    </div>
  );
}
