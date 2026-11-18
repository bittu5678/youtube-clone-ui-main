import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import {
  ArrowLeft,
  ThumbsUp,
  ThumbsDown,
  MessageSquare,
  Share2,
  Volume2,
  VolumeX,
  Play,
  Pause,
  Music2,
  ChevronUp,
  ChevronDown,
  Sparkles,
  Search,
  X,
  Send,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";
import { Logo } from "@/components/videohub/Logo";
import { ThemeToggle } from "@/components/videohub/ThemeToggle";
import { BottomNav } from "@/components/videohub/BottomNav";
import { SHORTS_LIST, type ShortItem } from "@/data/shorts";
import { useAuth } from "@/lib/auth-context";
import { fetchUploadedVideos, isShortVideo } from "@/lib/video-service";
import { resolveMediaUrl } from "@/lib/media-url";
import { useVideoOrientation } from "@/lib/video-orientation";
import { api } from "@/lib/api";

export interface ShortsSearch {
  id?: string | undefined;
}

export const Route = createFileRoute("/shorts")({
  validateSearch: (search: Record<string, unknown>): ShortsSearch => ({
    id: typeof search["id"] === "string" ? search["id"] : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Shorts — FaceTube" },
      {
        name: "description",
        content:
          "Watch trending short-form vertical videos, tutorials, and moments on FaceTube Shorts.",
      },
    ],
  }),
  component: ShortsPage,
});

function ShortsPage() {
  const router = useRouter();
  const searchParams = Route.useSearch();
  const { user, profile } = useAuth();

  const handleBack = useCallback(
    (e?: React.MouseEvent) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      const hasHistory =
        typeof window !== "undefined" &&
        ((window.history.state &&
          typeof window.history.state.idx === "number" &&
          window.history.state.idx > 0) ||
          (document.referrer && document.referrer.startsWith(window.location.origin)));

      if (hasHistory) {
        window.history.back();
      } else {
        router.navigate({ to: "/" });
      }
    },
    [router],
  );

  const [uploadedShorts, setUploadedShorts] = useState<ShortItem[]>([]);

  useEffect(() => {
    fetchUploadedVideos()
      .then((videos) => {
        const mapped = videos
          .filter((v) => isShortVideo({ contentType: v.contentType, duration: v.duration }))
          .map((v): ShortItem => ({
            id: v.id,
            title: v.title,
            creator: v.creatorName || "FaceTube Creator",
            creatorHandle: `@${(v.creatorName || "creator").toLowerCase().replace(/\s+/g, "")}`,
            initials: (v.creatorName || "FC").slice(0, 2).toUpperCase(),
            views: `${(v.views || 0).toLocaleString()} views`,
            likes: (v.likes || 0).toLocaleString(),
            comments: "0",
            shares: "0",
            soundTrack: `${v.creatorName || "FaceTube"} · Original Audio`,
            tags: [v.category?.toLowerCase() || "shorts", "facetube"],
            thumb: v.thumbnailUrl,
            aspectColor: "from-purple-900/60 to-brand/80",
            videoUrl: v.videoUrl,
            userId: v.userId || (v as any).user_id || "FT483921",
          }));
        if (mapped.length > 0) {
          setUploadedShorts(mapped);
        }
      })
      .catch((err) => console.warn("Could not fetch shorts from API:", err));
  }, []);

  const allShorts: ShortItem[] = useMemo(() => {
    const seen = new Set<string>();
    const list: ShortItem[] = [];
    for (const s of uploadedShorts) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        list.push(s);
      }
    }
    for (const s of SHORTS_LIST) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        list.push(s);
      }
    }
    return list.length > 0 ? list : SHORTS_LIST;
  }, [uploadedShorts]);

  const initialIndex = searchParams.id
    ? Math.max(
        0,
        allShorts.findIndex((s) => s.id === searchParams.id),
      )
    : 0;
  const [currentIndex, setCurrentIndex] = useState(initialIndex >= 0 ? initialIndex : 0);

  useEffect(() => {
    if (searchParams.id) {
      const idx = allShorts.findIndex((s) => s.id === searchParams.id);
      if (idx !== -1) {
        setCurrentIndex(idx);
      }
    }
  }, [searchParams.id, allShorts]);
  const [liked, setLiked] = useState<Record<string, boolean>>({});
  const [disliked, setDisliked] = useState<Record<string, boolean>>({});
  const [subscribedCreators, setSubscribedCreators] = useState<Record<string, boolean>>({});
  const [selfCreators, setSelfCreators] = useState<Record<string, boolean>>({});
  const [isSubscribing, setIsSubscribing] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [isPlaying, setIsPlaying] = useState(true);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [newComment, setNewComment] = useState("");
  const [shortComments, setShortComments] = useState<
    Record<string, Array<{ id: string; user: string; text: string; time: string }>>
  >({
    "s-1": [
      { id: "1", user: "Jordan Cole", text: "That transition at 0:05 was insane!", time: "2h ago" },
      { id: "2", user: "Sara Connor", text: "Which lens did you use for this?", time: "4h ago" },
    ],
  });

  const touchStartY = useRef<number | null>(null);
  const fallbackShort: ShortItem = SHORTS_LIST[0] as ShortItem;
  const activeShort: ShortItem = allShorts[currentIndex] ?? allShorts[0] ?? fallbackShort;

  // YouTube-style Pinch-to-Zoom & Pan state
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isZoomInteracting, setIsZoomInteracting] = useState(false);

  const cardRef = useRef<HTMLDivElement | null>(null);
  const activeVideoSrc = resolveMediaUrl(activeShort.videoUrl) || undefined;
  const { videoStyle: shortVideoStyle, handleLoadedMetadata: handleShortLoadedMetadata } =
    useVideoOrientation(activeVideoSrc, cardRef, "cover");
  const lastTouchPos = useRef<{ x: number; y: number } | null>(null);
  const pinchStartDist = useRef<number | null>(null);
  const pinchStartScale = useRef<number>(1);
  const pinchStartPan = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const lastTapTimeRef = useRef<number>(0);
  const tapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Automatically reset zoom when switching between shorts
  const resetZoom = useCallback(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
    setIsZoomInteracting(false);
  }, []);

  useEffect(() => {
    resetZoom();
  }, [currentIndex, activeShort.id, resetZoom]);

  // Clean up any pending single-tap timeout on unmount
  useEffect(() => {
    return () => {
      if (tapTimeoutRef.current) {
        clearTimeout(tapTimeoutRef.current);
      }
    };
  }, []);

  const handleNext = useCallback(() => {
    setCurrentIndex((prev) => (prev + 1) % allShorts.length);
  }, [allShorts.length]);

  const handlePrev = useCallback(() => {
    setCurrentIndex((prev) => (prev - 1 + allShorts.length) % allShorts.length);
  }, [allShorts.length]);

  // Keyboard navigation: ArrowUp, ArrowDown, Spacebar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        handleNext();
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        handlePrev();
      } else if (e.key === " ") {
        e.preventDefault();
        setIsPlaying((p) => !p);
      } else if (e.key === "m") {
        setIsMuted((m) => !m);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleNext, handlePrev]);

  // Touch gesture handling: Pinch to zoom (2 fingers), Pan/Move (1 finger when zoomed), Vertical swipe (1 finger when 1x)
  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      if (t1 && t2) {
        const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        pinchStartDist.current = dist;
        pinchStartScale.current = scale;
        pinchStartPan.current = { ...pan };
        setIsZoomInteracting(true);
        touchStartY.current = null;
        lastTouchPos.current = null;
      }
    } else if (e.touches.length === 1) {
      const touch = e.touches[0];
      if (!touch) return;
      if (scale > 1.05) {
        // When zoomed in, 1-finger drag pans the zoomed video
        setIsZoomInteracting(true);
        lastTouchPos.current = { x: touch.clientX, y: touch.clientY };
        touchStartY.current = null;
      } else {
        // At normal 1x scale, record vertical touch position for swipe navigation
        touchStartY.current = touch.clientY;
        lastTouchPos.current = null;
      }
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2 && pinchStartDist.current !== null) {
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      if (t1 && t2) {
        const currentDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        const ratio = currentDist / pinchStartDist.current;
        const targetScale = Math.min(4, Math.max(1, pinchStartScale.current * ratio));

        const rect = cardRef.current?.getBoundingClientRect();
        const width = rect?.width || 380;
        const height = rect?.height || 675;
        const maxPanX = Math.max(0, ((targetScale - 1) * width) / 2);
        const maxPanY = Math.max(0, ((targetScale - 1) * height) / 2);

        const clampedX = Math.max(-maxPanX, Math.min(maxPanX, pinchStartPan.current.x));
        const clampedY = Math.max(-maxPanY, Math.min(maxPanY, pinchStartPan.current.y));

        setScale(targetScale);
        setPan({ x: clampedX, y: clampedY });
      }
    } else if (e.touches.length === 1 && scale > 1.05 && lastTouchPos.current) {
      const touch = e.touches[0];
      if (!touch) return;
      const dx = touch.clientX - lastTouchPos.current.x;
      const dy = touch.clientY - lastTouchPos.current.y;
      lastTouchPos.current = { x: touch.clientX, y: touch.clientY };

      const rect = cardRef.current?.getBoundingClientRect();
      const width = rect?.width || 380;
      const height = rect?.height || 675;
      const maxPanX = Math.max(0, ((scale - 1) * width) / 2);
      const maxPanY = Math.max(0, ((scale - 1) * height) / 2);

      setPan((prev) => ({
        x: Math.max(-maxPanX, Math.min(maxPanX, prev.x + dx)),
        y: Math.max(-maxPanY, Math.min(maxPanY, prev.y + dy)),
      }));
    }
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length < 2) {
      pinchStartDist.current = null;
    }
    if (e.touches.length === 0) {
      setIsZoomInteracting(false);
      lastTouchPos.current = null;

      // Snap back if zoom level is near 1x
      if (scale < 1.08) {
        resetZoom();
      } else {
        const rect = cardRef.current?.getBoundingClientRect();
        const width = rect?.width || 380;
        const height = rect?.height || 675;
        const maxPanX = Math.max(0, ((scale - 1) * width) / 2);
        const maxPanY = Math.max(0, ((scale - 1) * height) / 2);
        setPan((prev) => ({
          x: Math.max(-maxPanX, Math.min(maxPanX, prev.x)),
          y: Math.max(-maxPanY, Math.min(maxPanY, prev.y)),
        }));
      }

      // Vertical swipe navigation active only when not zoomed in
      if (scale <= 1.05 && touchStartY.current !== null) {
        const firstTouch = e.changedTouches[0];
        if (firstTouch) {
          const deltaY = touchStartY.current - firstTouch.clientY;
          if (deltaY > 40) {
            handleNext();
          } else if (deltaY < -40) {
            handlePrev();
          }
        }
        touchStartY.current = null;
      }
    }
  };

  // Middle tap handler with double-tap zoom toggle
  const handleMiddleTap = () => {
    const now = Date.now();
    const timeSinceLastTap = now - lastTapTimeRef.current;

    if (timeSinceLastTap < 280) {
      // Double-tap detected: cancel pending play/pause toggle
      if (tapTimeoutRef.current) {
        clearTimeout(tapTimeoutRef.current);
        tapTimeoutRef.current = null;
      }
      lastTapTimeRef.current = 0;

      if (scale > 1.05) {
        resetZoom();
      } else {
        setScale(2.5);
        setPan({ x: 0, y: 0 });
      }
    } else {
      // Single tap: queue play/pause toggle
      lastTapTimeRef.current = now;
      if (tapTimeoutRef.current) {
        clearTimeout(tapTimeoutRef.current);
      }
      tapTimeoutRef.current = setTimeout(() => {
        setIsPlaying((p) => !p);
        tapTimeoutRef.current = null;
      }, 280);
    }
  };

  const toggleLike = (id: string) => {
    setLiked((prev) => {
      const next = !prev[id];
      if (next) toast.success("Added to Liked Videos");
      return { ...prev, [id]: next };
    });
    if (!liked[id] && disliked[id]) {
      setDisliked((prev) => ({ ...prev, [id]: false }));
    }
  };

  const toggleDislike = (id: string) => {
    setDisliked((prev) => ({ ...prev, [id]: !prev[id] }));
    if (!disliked[id] && liked[id]) {
      setLiked((prev) => ({ ...prev, [id]: false }));
    }
  };

  const activeCreatorUserId = useMemo(() => {
    return (
      activeShort.userId ||
      (activeShort as any).user_id ||
      (activeShort.creatorHandle ? activeShort.creatorHandle.replace(/^@/, "") : "FT483921")
    );
  }, [activeShort]);

  useEffect(() => {
    let mounted = true;
    if (!activeCreatorUserId) return;
    api.channel
      .getStatus(activeCreatorUserId)
      .then((res) => {
        if (mounted && res && res.success) {
          setSubscribedCreators((prev) => ({
            ...prev,
            [activeCreatorUserId]: Boolean(res.subscribed),
          }));
          if (res.is_self) {
            setSelfCreators((prev) => ({
              ...prev,
              [activeCreatorUserId]: true,
            }));
          }
        }
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [activeCreatorUserId, user]);

  const handleToggleSubscribe = async (creatorId: string, creatorName: string) => {
    if (selfCreators[creatorId]) {
      toast.error("You cannot subscribe to your own channel.");
      return;
    }
    if (isSubscribing) return;
    setIsSubscribing(true);
    const isCurrentlySubscribed = Boolean(subscribedCreators[creatorId]);
    try {
      if (isCurrentlySubscribed) {
        const res = await api.channel.unsubscribe(creatorId);
        if (res && res.success) {
          setSubscribedCreators((prev) => ({ ...prev, [creatorId]: false }));
          toast.success(`Unsubscribed from ${creatorName}.`);
        } else {
          toast.error(res?.error || "Could not unsubscribe.");
        }
      } else {
        const res = await api.channel.subscribe(creatorId);
        if (res && res.success) {
          setSubscribedCreators((prev) => ({ ...prev, [creatorId]: true }));
          toast.success(`Subscribed to ${creatorName}!`);
        } else {
          if (
            res?.error?.toLowerCase().includes("authentication") ||
            res?.error?.toLowerCase().includes("sign in")
          ) {
            toast.error("Please sign in to subscribe to channels.");
          } else {
            toast.error(res?.error || "Could not subscribe.");
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to update subscription.";
      toast.error(msg);
    } finally {
      setIsSubscribing(false);
    }
  };

  const handleAddComment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim()) return;
    const authorName = profile?.full_name || user?.email?.split("@")[0] || "You";
    const newEntry = {
      id: String(Date.now()),
      user: authorName,
      text: newComment.trim(),
      time: "Just now",
    };
    setShortComments((prev) => ({
      ...prev,
      [activeShort.id]: [newEntry, ...(prev[activeShort.id] || [])],
    }));
    setNewComment("");
    toast.success("Comment posted!");
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col antialiased selection:bg-brand selection:text-white">
      {/* Top Header */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-2 sm:gap-3">
            <button
              type="button"
              onClick={handleBack}
              className="group inline-flex h-9 w-9 items-center justify-center rounded-full text-foreground/80 transition-all hover:bg-secondary hover:text-foreground active:scale-95 cursor-pointer"
              aria-label="Back to previous page"
              title="Back to previous page"
            >
              <ArrowLeft className="h-5 w-5 transition-transform group-hover:-translate-x-0.5" />
            </button>
            <Logo size={30} />
            <span className="rounded-full bg-red-500/10 px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wider text-red-500">
              Shorts
            </span>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <Link
              to="/"
              className="grid h-9 w-9 place-items-center rounded-full text-muted-foreground transition hover:bg-secondary hover:text-foreground"
              aria-label="Search FaceTube"
            >
              <Search className="h-4 w-4" />
            </Link>
            <ThemeToggle showLabelsOnWide={false} />
          </div>
        </div>
      </header>

      {/* Main Shorts Theater with Touch Swipe */}
      <main className="flex-1 flex items-center justify-center p-2 sm:p-4 pb-24 md:pb-28">
        <div className="relative flex flex-col md:flex-row items-center gap-4 max-w-full">
          {/* Vertical Video Reel Card with YouTube-Style Pinch-to-Zoom */}
          <div
            ref={cardRef}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            style={{ touchAction: scale > 1.05 ? "none" : "pan-y" }}
            className="relative w-[340px] xs:w-[380px] sm:w-[420px] aspect-[9/16] max-h-[calc(100vh-160px)] rounded-3xl overflow-hidden bg-black shadow-2xl border border-border/70 flex flex-col justify-between select-none"
          >
            {/* Background Video / Thumbnail with Pinch Zoom & Pan */}
            <div className="absolute inset-0 z-0 overflow-hidden">
              <div
                style={{
                  transform: `translate3d(${pan.x}px, ${pan.y}px, 0px) scale(${scale})`,
                  transformOrigin: "center center",
                  transition: isZoomInteracting
                    ? "none"
                    : "transform 260ms cubic-bezier(0.25, 1, 0.5, 1)",
                  willChange: "transform",
                }}
                className="h-full w-full relative"
              >
                {activeVideoSrc ? (
                  <video
                    src={activeVideoSrc}
                    poster={activeShort.thumb}
                    autoPlay={isPlaying}
                    muted={isMuted}
                    loop
                    playsInline
                    onLoadedMetadata={(e) => handleShortLoadedMetadata(e.currentTarget)}
                    style={shortVideoStyle}
                    className="h-full w-full object-cover pointer-events-none"
                  />
                ) : (
                  <img
                    src={activeShort.thumb}
                    alt={activeShort.title}
                    className="h-full w-full object-cover opacity-80 pointer-events-none"
                  />
                )}
              </div>
              <div
                className={`absolute inset-0 bg-gradient-to-t ${activeShort.aspectColor} via-black/30 to-black/70 pointer-events-none`}
              />
            </div>

            {/* Quick Reset Zoom Badge when zoomed */}
            {scale > 1.05 && (
              <div className="absolute top-16 left-1/2 -translate-x-1/2 z-30 animate-in fade-in zoom-in-90 duration-200">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    resetZoom();
                  }}
                  className="inline-flex items-center gap-1.5 rounded-full bg-black/80 px-3 py-1 text-xs font-semibold text-white shadow-lg backdrop-blur-md border border-white/20 hover:bg-black transition active:scale-95 cursor-pointer"
                  title="Double-tap or click to reset zoom"
                >
                  <RotateCcw className="h-3 w-3 text-red-400" />
                  <span>{scale.toFixed(1)}x · Reset</span>
                </button>
              </div>
            )}

            {/* Top Bar on Video: Back Button, Sound, Status, Progress Bar */}
            <div className="relative z-10 flex items-center justify-between p-4">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleBack(e);
                  }}
                  className="grid h-9 w-9 place-items-center rounded-full bg-black/60 text-white backdrop-blur-md transition hover:bg-black/80 active:scale-95 cursor-pointer"
                  aria-label="Back to previous page"
                  title="Back to previous page"
                >
                  <ArrowLeft className="h-4 w-4" />
                </button>
                <span className="inline-flex items-center gap-1 rounded-full bg-black/60 px-2.5 py-1 text-xs font-semibold text-white backdrop-blur-md">
                  <Sparkles className="h-3 w-3 text-red-400" />
                  {currentIndex + 1} of {allShorts.length}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsMuted((m) => !m)}
                  className="grid h-9 w-9 place-items-center rounded-full bg-black/60 text-white backdrop-blur-md transition hover:bg-black/80 active:scale-95"
                  aria-label={isMuted ? "Unmute sound" : "Mute sound"}
                >
                  {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => setIsPlaying((p) => !p)}
                  className="grid h-9 w-9 place-items-center rounded-full bg-black/60 text-white backdrop-blur-md transition hover:bg-black/80 active:scale-95"
                  aria-label={isPlaying ? "Pause" : "Play"}
                >
                  {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {/* Middle tap area to Play/Pause (Single tap) and Zoom (Double tap) */}
            <div
              className="relative z-10 flex-1 cursor-pointer flex items-center justify-center"
              onClick={handleMiddleTap}
            >
              {!isPlaying && (
                <div className="grid h-16 w-16 place-items-center rounded-full bg-black/70 text-white shadow-2xl backdrop-blur-md animate-in fade-in zoom-in pointer-events-none">
                  <Play className="h-8 w-8 translate-x-0.5 fill-white" />
                </div>
              )}
            </div>

            {/* Bottom Meta & Creator Info */}
            <div className="relative z-10 p-4 pb-5 space-y-3 bg-gradient-to-t from-black/95 via-black/70 to-transparent">
              {/* Creator Row with Subscribe */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="grid h-10 w-10 place-items-center rounded-full bg-brand text-white font-bold text-xs ring-2 ring-white/50">
                    {activeShort.initials}
                  </div>
                  <div>
                    <p className="text-sm font-bold text-white drop-shadow-sm">
                      {activeShort.creator}
                    </p>
                    <p className="text-[11px] text-white/80">{activeShort.creatorHandle}</p>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={isSubscribing}
                  onClick={() => handleToggleSubscribe(activeCreatorUserId, activeShort.creator)}
                  className={`rounded-full px-4 py-1.5 text-xs font-bold transition-all shadow-md active:scale-95 ${
                    subscribedCreators[activeCreatorUserId]
                      ? "bg-white/20 text-white backdrop-blur-md"
                      : "bg-red-600 text-white hover:bg-red-700 disabled:opacity-60"
                  }`}
                >
                  {subscribedCreators[activeCreatorUserId] ? "Subscribed" : "Subscribe"}
                </button>
              </div>

              {/* Title & Caption */}
              <p className="text-sm font-medium text-white line-clamp-2 leading-snug drop-shadow-sm">
                {activeShort.title}
              </p>

              {/* Sound Track Badge */}
              <div className="flex items-center gap-2 text-xs text-white/85">
                <Music2 className="h-3.5 w-3.5 shrink-0 animate-bounce text-red-400" />
                <span className="truncate">{activeShort.soundTrack}</span>
              </div>
            </div>

            {/* Animated Playback Progress Bar */}
            <div className="absolute bottom-0 inset-x-0 h-1 bg-white/25 z-20">
              <div className="h-full bg-red-600 w-2/3 animate-pulse" />
            </div>
          </div>

          {/* Right Action Rail (YouTube Shorts Style) */}
          <div className="flex md:flex-col items-center justify-center gap-3 sm:gap-4 z-20">
            {/* Like */}
            <button
              type="button"
              onClick={() => toggleLike(activeShort.id)}
              className="flex flex-col items-center gap-1 group active:scale-90 transition"
              aria-label="Like this short"
            >
              <div
                className={`grid h-11 w-11 place-items-center rounded-full backdrop-blur-md transition ${
                  liked[activeShort.id]
                    ? "bg-red-600 text-white shadow-lg shadow-red-600/30"
                    : "bg-secondary/80 text-foreground hover:bg-secondary"
                }`}
              >
                <ThumbsUp className="h-5 w-5" />
              </div>
              <span className="text-[11px] font-semibold text-foreground">
                {liked[activeShort.id] ? "Liked" : activeShort.likes}
              </span>
            </button>

            {/* Dislike */}
            <button
              type="button"
              onClick={() => toggleDislike(activeShort.id)}
              className="flex flex-col items-center gap-1 group active:scale-90 transition"
              aria-label="Dislike this short"
            >
              <div
                className={`grid h-11 w-11 place-items-center rounded-full backdrop-blur-md transition ${
                  disliked[activeShort.id]
                    ? "bg-foreground text-background"
                    : "bg-secondary/80 text-foreground hover:bg-secondary"
                }`}
              >
                <ThumbsDown className="h-5 w-5" />
              </div>
              <span className="text-[11px] font-semibold text-foreground">Dislike</span>
            </button>

            {/* Comments */}
            <button
              type="button"
              onClick={() => setCommentsOpen((c) => !c)}
              className="flex flex-col items-center gap-1 group active:scale-90 transition"
              aria-label="View comments"
            >
              <div className="grid h-11 w-11 place-items-center rounded-full bg-secondary/80 text-foreground hover:bg-secondary backdrop-blur-md transition">
                <MessageSquare className="h-5 w-5" />
              </div>
              <span className="text-[11px] font-semibold text-foreground">
                {(shortComments[activeShort.id]?.length || 0) +
                  parseInt(activeShort.comments, 10) || activeShort.comments}
              </span>
            </button>

            {/* Share */}
            <button
              type="button"
              onClick={() => {
                if (navigator.share) {
                  navigator
                    .share({ title: activeShort.title, url: window.location.href })
                    .catch(() => {});
                } else {
                  navigator.clipboard.writeText(window.location.href);
                  toast.success("Short link copied to clipboard!");
                }
              }}
              className="flex flex-col items-center gap-1 group active:scale-90 transition"
              aria-label="Share short"
            >
              <div className="grid h-11 w-11 place-items-center rounded-full bg-secondary/80 text-foreground hover:bg-secondary backdrop-blur-md transition">
                <Share2 className="h-5 w-5" />
              </div>
              <span className="text-[11px] font-semibold text-foreground">
                {activeShort.shares}
              </span>
            </button>

            {/* Up / Down Navigation Controls for Desktop */}
            <div className="hidden md:flex flex-col gap-2 pt-2 border-t border-border/60">
              <button
                type="button"
                onClick={handlePrev}
                className="grid h-10 w-10 place-items-center rounded-full bg-secondary text-foreground hover:bg-brand hover:text-white transition active:scale-95 shadow-sm"
                aria-label="Previous short"
                title="Previous short (Up Arrow)"
              >
                <ChevronUp className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={handleNext}
                className="grid h-10 w-10 place-items-center rounded-full bg-secondary text-foreground hover:bg-brand hover:text-white transition active:scale-95 shadow-sm"
                aria-label="Next short"
                title="Next short (Down Arrow)"
              >
                <ChevronDown className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>

        {/* Interactive Comments Drawer / Modal */}
        {commentsOpen && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4 backdrop-blur-sm animate-in fade-in">
            <div className="relative w-full max-w-md rounded-t-3xl sm:rounded-3xl border border-border bg-card p-5 shadow-2xl animate-in slide-in-from-bottom">
              <div className="flex items-center justify-between border-b border-border/60 pb-3">
                <h3 className="text-base font-bold text-foreground">Comments</h3>
                <button
                  type="button"
                  onClick={() => setCommentsOpen(false)}
                  className="rounded-full p-1.5 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="my-4 max-h-60 overflow-y-auto space-y-3 pr-1">
                {(shortComments[activeShort.id] || []).map((c) => (
                  <div key={c.id} className="rounded-xl bg-secondary/50 p-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-foreground">{c.user}</span>
                      <span className="text-[10px] text-muted-foreground">{c.time}</span>
                    </div>
                    <p className="mt-1 text-xs text-foreground/90">{c.text}</p>
                  </div>
                ))}
                {!shortComments[activeShort.id]?.length && (
                  <p className="py-6 text-center text-xs text-muted-foreground">
                    Be the first to comment on this short!
                  </p>
                )}
              </div>

              <form
                onSubmit={handleAddComment}
                className="flex gap-2 border-t border-border/60 pt-3"
              >
                <input
                  type="text"
                  placeholder="Add a comment..."
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  className="flex-1 rounded-full border border-border bg-secondary/60 px-4 py-2 text-xs text-foreground outline-none focus:border-brand"
                />
                <button
                  type="submit"
                  className="grid h-9 w-9 place-items-center rounded-full bg-brand text-white transition hover:bg-brand-dark"
                >
                  <Send className="h-4 w-4" />
                </button>
              </form>
            </div>
          </div>
        )}
      </main>

      {/* Fixed Bottom Navigation with 5 tabs */}
      <BottomNav />
    </div>
  );
}
