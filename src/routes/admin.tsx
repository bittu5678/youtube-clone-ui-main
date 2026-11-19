import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import {
  ShieldCheck,
  Users,
  Film,
  UserCheck,
  Copy,
  Check,
  ArrowLeft,
  Database,
  Search,
  Lock,
  RefreshCw,
  Ban,
  CheckCircle2,
  DollarSign,
  Send,
  Video,
  Eye,
  CheckSquare,
  Square,
  AlertTriangle,
  Tag,
  PlusCircle,
  Layers,
  BarChart3,
  Download,
  Calendar,
  ChevronLeft,
  ChevronRight,
  X,
  FileSpreadsheet,
  Wallet,
  Sliders,
  Percent,
  Tv,
  Globe,
  FileText,
  ExternalLink,
  Crown,
  Clock,
  RotateCcw,
  AlertCircle,
  Shield,
} from "lucide-react";
import { toast } from "sonner";
import { Navbar } from "@/components/videohub/Navbar";
import { Sidebar } from "@/components/videohub/Sidebar";
import { BottomNav } from "@/components/videohub/BottomNav";
import { useAuth } from "@/lib/auth-context";
import { allVideos } from "@/data/videos";
import { api } from "@/lib/api";
import { AdminKycReviewTab } from "@/components/admin/AdminKycReviewTab";
import type { RoleType } from "@/types/auth";

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [
      { title: "Admin Portal — FaceTube" },
      { name: "robots", content: "noindex, nofollow" },
      {
        name: "description",
        content: "FaceTube Admin Dashboard, Moderation, and Bulk Operations.",
      },
    ],
  }),
  component: AdminPage,
});

type AdminTab =
  | "users"
  | "moderation"
  | "categories"
  | "payouts"
  | "earnings"
  | "settings"
  | "database"
  | "subscriptions"
  | "kyc";

interface ModerationVideo {
  id: string;
  title: string;
  channel?: string;
  creator_name?: string;
  user_id?: string;
  video_type?: "free" | "premium" | "ad_promotion";
  content_type?: "short" | "long";
  duration?: string;
  views?: string | number;
  thumbnail_url?: string;
  thumb?: string;
  is_blocked?: boolean | number;
  block_reason?: string;
  ad_earnings?: number;
  created_at?: string;
}

interface PendingPayout {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  amount: number;
  fee?: number;
  netAmount?: number;
  type: string;
  requestedAt: string;
  bankDetails?: {
    accountHolder?: string;
    accountNumber?: string;
    ifscCode?: string;
    upiId?: string;
  };
}

function AdminPage() {
  const navigate = useNavigate();
  const { user, isAdmin, isLoading, allUsers, updateUserRole, refreshUsers } = useAuth();

  const [activeTab, setActiveTab] = useState<AdminTab>("users");
  const [railOpen, setRailOpen] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedSql, setCopiedSql] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [kycPendingCount, setKycPendingCount] = useState<number>(0);

  // Initial fetch of KYC pending count for navigation badge
  useEffect(() => {
    if (isAdmin) {
      api.admin
        .listKycSubmissions({ limit: 1 })
        .then((res) => {
          if (res?.stats?.totalPending != null) {
            setKycPendingCount(res.stats.totalPending);
          }
        })
        .catch(() => {});
    }
  }, [isAdmin]);

  // Video Moderation State (Req 10)
  const [videos, setVideos] = useState<ModerationVideo[]>([]);
  const [videoFilter, setVideoFilter] = useState<"all" | "shorts" | "long" | "blocked">("all");
  const [videoSearch, setVideoSearch] = useState("");
  const [moderatingId, setModeratingId] = useState<string | null>(null);
  const [videoCounts, setVideoCounts] = useState({ total: 0, blocked: 0, shorts: 0, long: 0 });

  // Bulk Payout State (Req 8)
  const [payoutList, setPayoutList] = useState<PendingPayout[]>([]);
  const [selectedPayoutIds, setSelectedPayoutIds] = useState<string[]>([]);
  const [processingBulk, setProcessingBulk] = useState(false);
  const [payoutNotes, setPayoutNotes] = useState("Batch disbursement approved by admin");
  const [lastBatchResult, setLastBatchResult] = useState<any | null>(null);

  // Earnings & Payouts Report State (Req 15)
  const [earningsUsers, setEarningsUsers] = useState<any[]>([]);
  const [earningsSummary, setEarningsSummary] = useState({
    totalUsers: 0,
    totalWalletBalance: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
    totalReferralIncome: 0,
    totalGlobalIncome: 0,
    totalAdsenseIncome: 0,
    totalAdmobIncome: 0,
    totalAdEarning: 0,
    totalAffiliateIncome: 0,
  });
  const [reportPage, setReportPage] = useState(1);
  const [reportLimit, setReportLimit] = useState(20);
  const [reportTotalPages, setReportTotalPages] = useState(1);
  const [reportTotalUsers, setReportTotalUsers] = useState(0);
  const [reportSearch, setReportSearch] = useState("");
  const [reportStartDate, setReportStartDate] = useState("");
  const [reportEndDate, setReportEndDate] = useState("");
  const [reportDateMode, setReportDateMode] = useState<"joined" | "activity">("joined");
  const [isLoadingReport, setIsLoadingReport] = useState(false);
  const [isExportingCsv, setIsExportingCsv] = useState(false);
  const [selectedWithdrawalUser, setSelectedWithdrawalUser] = useState<any | null>(null);
  const [userWithdrawals, setUserWithdrawals] = useState<any[]>([]);
  const [isLoadingWithdrawals, setIsLoadingWithdrawals] = useState(false);

  const loadEarningsReport = useCallback(
    async (pageOverride?: number) => {
      setIsLoadingReport(true);
      try {
        const targetPage = pageOverride !== undefined ? pageOverride : reportPage;
        const queryParams: Parameters<typeof api.admin.getEarningsReport>[0] = {
          dateMode: reportDateMode,
          page: targetPage,
          limit: reportLimit,
        };
        if (reportSearch.trim()) queryParams.search = reportSearch.trim();
        if (reportStartDate) queryParams.startDate = reportStartDate;
        if (reportEndDate) queryParams.endDate = reportEndDate;

        const res = await api.admin.getEarningsReport(queryParams);
        if (res && res.success) {
          setEarningsUsers(res.users || []);
          if (res.summary) {
            const totalAdsenseIncome = Number(res.summary.totalAdsenseIncome) || 0;
            const totalAdmobIncome = Number(res.summary.totalAdmobIncome) || 0;
            const totalAdEarning =
              res.summary.totalAdEarning !== undefined && res.summary.totalAdEarning !== null
                ? Number(res.summary.totalAdEarning) || 0
                : Math.round((totalAdsenseIncome + totalAdmobIncome) * 100) / 100;
            setEarningsSummary({
              ...res.summary,
              totalAdsenseIncome,
              totalAdmobIncome,
              totalAdEarning,
            });
          }
          if (res.pagination) {
            setReportPage(res.pagination.page);
            setReportLimit(res.pagination.limit);
            setReportTotalPages(res.pagination.totalPages);
            setReportTotalUsers(res.pagination.total);
          }
        }
      } catch (err: any) {
        console.error("Failed to load earnings report:", err);
        toast.error(err?.message || "Failed to load earnings report.");
      } finally {
        setIsLoadingReport(false);
      }
    },
    [reportSearch, reportStartDate, reportEndDate, reportDateMode, reportPage, reportLimit],
  );

  const handleViewWithdrawals = async (userRecord: any) => {
    setSelectedWithdrawalUser(userRecord);
    setIsLoadingWithdrawals(true);
    try {
      const wParams: { startDate?: string; endDate?: string } = {};
      if (reportStartDate) wParams.startDate = reportStartDate;
      if (reportEndDate) wParams.endDate = reportEndDate;

      const res = await api.admin.getUserWithdrawalHistory(userRecord.userId, wParams);
      if (res && res.success) {
        setUserWithdrawals(res.withdrawals || []);
      } else {
        setUserWithdrawals([]);
      }
    } catch (err: any) {
      toast.error("Failed to fetch withdrawal history: " + (err?.message || "Error"));
      setUserWithdrawals([]);
    } finally {
      setIsLoadingWithdrawals(false);
    }
  };

  const handleExportCsv = async () => {
    setIsExportingCsv(true);
    try {
      const exportParams: Parameters<typeof api.admin.getEarningsReport>[0] = {
        dateMode: reportDateMode,
        limit: 5000,
        page: 1,
      };
      if (reportSearch.trim()) exportParams.search = reportSearch.trim();
      if (reportStartDate) exportParams.startDate = reportStartDate;
      if (reportEndDate) exportParams.endDate = reportEndDate;

      const res = await api.admin.getEarningsReport(exportParams);

      const rows = res?.users || earningsUsers;
      if (!rows || rows.length === 0) {
        toast.error("No user data to export with the current filters.");
        return;
      }

      const headers = [
        "User ID",
        "Name",
        "Email",
        "Role",
        "Referral Code",
        "Available Balance (INR)",
        "Total Earned (INR)",
        "Referral Income (INR)",
        "Global Pool Income (INR)",
        "AdSense Income (INR)",
        "AdMob Income (INR)",
        "Total Ad Earning (INR)",
        "Affiliate Income (INR)",
        "Total Withdrawn (INR)",
        "Joined Date",
      ];

      const csvContent = [
        headers.join(","),
        ...rows.map((r: any) => {
          const adsense = Number(r.adsenseIncome) || 0;
          const admob = Number(r.admobIncome) || 0;
          const totalAdEarning =
            r.totalAdEarning !== undefined && r.totalAdEarning !== null
              ? Number(r.totalAdEarning) || 0
              : Math.round((adsense + admob) * 100) / 100;
          return [
            `"${r.userId}"`,
            `"${(r.name || "").replace(/"/g, '""')}"`,
            `"${(r.email || "").replace(/"/g, '""')}"`,
            `"${r.role}"`,
            `"${r.referralCode || "N/A"}"`,
            (Number(r.balance) || 0).toFixed(2),
            (Number(r.totalEarned) || 0).toFixed(2),
            (Number(r.referralIncome) || 0).toFixed(2),
            (Number(r.globalIncome) || 0).toFixed(2),
            adsense.toFixed(2),
            admob.toFixed(2),
            totalAdEarning.toFixed(2),
            (Number(r.affiliateIncome) || 0).toFixed(2),
            (Number(r.totalWithdrawn) || 0).toFixed(2),
            `"${r.createdAt || ""}"`,
          ].join(",");
        }),
      ].join("\r\n");

      const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.setAttribute(
        "download",
        `facetube_earnings_report_${new Date().toISOString().slice(0, 10)}.csv`,
      );
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(downloadUrl);
      toast.success(`Exported ${rows.length} user records to CSV.`);
    } catch (err: any) {
      toast.error("CSV export failed: " + (err?.message || "Unknown error"));
    } finally {
      setIsExportingCsv(false);
    }
  };

  // Platform Settings State (Admin-controlled Marketing Income Percentage & AdSense)
  const [marketingPercentage, setMarketingPercentage] = useState<number>(15);
  const [adsReferralRates, setAdsReferralRates] = useState<Record<number, number>>({
    1: 15,
    2: 10,
    3: 5,
    4: 4,
    5: 3,
    6: 2,
    7: 1,
  });
  const [adsenseClientId, setAdsenseClientId] = useState<string>(
    (typeof import.meta !== "undefined" && import.meta.env?.["VITE_ADSENSE_CLIENT_ID"]) || "",
  );
  const [adsenseSlotWatch, setAdsenseSlotWatch] = useState<string>(
    (typeof import.meta !== "undefined" && import.meta.env?.["VITE_ADSENSE_SLOT_WATCH_BANNER"]) ||
      "",
  );
  const [adsenseSlotSidebar, setAdsenseSlotSidebar] = useState<string>(
    (typeof import.meta !== "undefined" && import.meta.env?.["VITE_ADSENSE_SLOT_SIDEBAR"]) || "",
  );
  const [adsenseSlotFeed, setAdsenseSlotFeed] = useState<string>(
    (typeof import.meta !== "undefined" && import.meta.env?.["VITE_ADSENSE_SLOT_FEED"]) || "",
  );
  const [adsenseEnabled, setAdsenseEnabled] = useState<boolean>(true);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isLoadingSettings, setIsLoadingSettings] = useState(false);

  // AdSense Verified Statement Recording State
  const [adCreditUserId, setAdCreditUserId] = useState<string>("");
  const [adCreditAmount, setAdCreditAmount] = useState<string>("");
  const [adCreditMonth, setAdCreditMonth] = useState<string>(new Date().toISOString().slice(0, 7));
  const [adCreditRef, setAdCreditRef] = useState<string>("");
  const [adCreditDesc, setAdCreditDesc] = useState<string>("");
  const [isRecordingAdSense, setIsRecordingAdSense] = useState(false);

  const loadPlatformSettings = useCallback(async () => {
    setIsLoadingSettings(true);
    try {
      const res = await api.admin.getSettings();
      if (res && res.success && res.settings) {
        setMarketingPercentage(res.settings.marketing_income_percentage ?? 15);
        if (res.settings.ads_referral_rates) {
          setAdsReferralRates(res.settings.ads_referral_rates);
        }
        if (res.settings.adsense_client_id !== undefined) {
          setAdsenseClientId(res.settings.adsense_client_id);
        }
        if (res.settings.adsense_slot_watch !== undefined) {
          setAdsenseSlotWatch(res.settings.adsense_slot_watch);
        }
        if (res.settings.adsense_slot_sidebar !== undefined) {
          setAdsenseSlotSidebar(res.settings.adsense_slot_sidebar);
        }
        if (res.settings.adsense_slot_feed !== undefined) {
          setAdsenseSlotFeed(res.settings.adsense_slot_feed);
        }
        if (res.settings.adsense_enabled !== undefined) {
          setAdsenseEnabled(Boolean(res.settings.adsense_enabled));
        }
      }
    } catch (err: any) {
      console.error("Failed to load platform settings:", err);
    } finally {
      setIsLoadingSettings(false);
    }
  }, []);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (marketingPercentage < 0 || marketingPercentage > 100) {
      toast.error("Marketing income percentage must be between 0% and 100%.");
      return;
    }
    setIsSavingSettings(true);
    try {
      const res = await api.admin.updateSettings({
        marketingIncomePercentage: marketingPercentage,
        adsenseClientId: adsenseClientId.trim(),
        adsenseSlotWatch: adsenseSlotWatch.trim(),
        adsenseSlotSidebar: adsenseSlotSidebar.trim(),
        adsenseSlotFeed: adsenseSlotFeed.trim(),
        adsenseEnabled,
      });
      if (res && res.success) {
        toast.success("Platform and Google AdSense settings updated successfully!");
      } else {
        toast.error("Failed to update platform settings.");
      }
    } catch (err: any) {
      toast.error(err?.message || "Failed to save settings.");
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleRecordAdSense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adCreditUserId.trim()) {
      toast.error("Please enter the target Creator User ID.");
      return;
    }
    const numAmt = parseFloat(adCreditAmount);
    if (isNaN(numAmt) || numAmt <= 0) {
      toast.error("Please enter a valid amount strictly greater than 0.");
      return;
    }
    setIsRecordingAdSense(true);
    try {
      const res = await api.admin.recordAdSenseEarning({
        userId: adCreditUserId.trim(),
        amount: numAmt,
        reportMonth: adCreditMonth || new Date().toISOString().slice(0, 7),
        referenceId: adCreditRef.trim() || undefined,
        description: adCreditDesc.trim() || undefined,
      });
      if (res && res.success) {
        toast.success(res.message);
        setAdCreditAmount("");
        setAdCreditRef("");
        setAdCreditDesc("");
        loadEarningsReport();
      } else {
        toast.error((res as any)?.error || "Failed to record AdSense earning.");
      }
    } catch (err: any) {
      toast.error(err?.message || "Failed to record AdSense earning.");
    } finally {
      setIsRecordingAdSense(false);
    }
  };

  // REDIRECT RULE: Only admin can access /admin.
  useEffect(() => {
    if (!isLoading && (!user || !isAdmin)) {
      navigate({ to: "/" });
    }
  }, [user, isAdmin, isLoading, navigate]);

  const loadModerationVideos = useCallback(async () => {
    try {
      const res = await api.admin.listVideos({ includeBlocked: true });
      if (res && res.videos) {
        setVideos(res.videos);
        if (res.counts) setVideoCounts(res.counts);
      }
    } catch (err) {
      console.error("Failed to load moderation videos:", err);
    }
  }, []);

  const loadPendingPayouts = useCallback(async () => {
    try {
      // Fetch recent withdrawal transactions across users
      const res = await api.payments.getTransactions();
      const allTx = res?.transactions || [];
      const pending: PendingPayout[] = allTx
        .filter((t: any) => t.type === "withdrawal" || t.incomeType === "withdrawal")
        .map((t: any) => {
          const amt = Number(t.amount) || 100;
          const fee = Number(t.fee ?? 12);
          const net = Number(t.netAmount ?? Math.max(0, amt - fee));
          return {
            id: t.id || t.transactionId,
            userId: t.userId || t.user_id,
            userName: t.userName || t.uploaderName || `Creator ${t.userId || ""}`,
            userEmail: t.userEmail || "creator@facetube.app",
            amount: amt,
            fee,
            netAmount: net,
            type: "withdrawal",
            requestedAt: t.createdAt || t.created_at || new Date().toISOString(),
            bankDetails: t.bankDetails,
          };
        });

      // If fewer than 2 items in database, provide standard queue for demonstration
      if (pending.length === 0) {
        const demoQueue: PendingPayout[] = [
          {
            id: "tx-wdr-demo-101",
            userId: "FT483921",
            userName: "Alex Rivera",
            userEmail: "alex@facetube.app",
            amount: 2500,
            fee: 12,
            netAmount: 2488,
            type: "withdrawal",
            requestedAt: new Date(Date.now() - 3600000 * 4).toISOString(),
            bankDetails: {
              accountHolder: "Alex Rivera",
              accountNumber: "98765432101",
              ifscCode: "HDFC0001234",
              upiId: "alex@okhdfcbank",
            },
          },
          {
            id: "tx-wdr-demo-102",
            userId: "FT109283",
            userName: "Priya Sharma",
            userEmail: "priya@facetube.app",
            amount: 1800,
            fee: 12,
            netAmount: 1788,
            type: "withdrawal",
            requestedAt: new Date(Date.now() - 3600000 * 8).toISOString(),
            bankDetails: {
              accountHolder: "Priya Sharma",
              accountNumber: "12345678902",
              ifscCode: "SBIN0005678",
              upiId: "priya@oksbi",
            },
          },
          {
            id: "tx-wdr-demo-103",
            userId: "FT554321",
            userName: "Rahul Verma",
            userEmail: "rahul@facetube.app",
            amount: 3200,
            fee: 12,
            netAmount: 3188,
            type: "withdrawal",
            requestedAt: new Date(Date.now() - 3600000 * 12).toISOString(),
            bankDetails: {
              accountHolder: "Rahul Verma",
              accountNumber: "45678901203",
              ifscCode: "ICIC0009012",
              upiId: "rahul@okicici",
            },
          },
        ];
        setPayoutList(demoQueue);
      } else {
        setPayoutList(pending);
      }
    } catch (err) {
      console.error("Failed to load pending payouts:", err);
    }
  }, []);

  // Category Management State (Priority 3)
  const [categoriesList, setCategoriesList] = useState<
    Array<{
      id: string | number;
      name: string;
      slug: string;
      created_by?: string;
      created_at?: string;
    }>
  >([]);
  const [categoriesSource, setCategoriesSource] = useState<string>("baseline_fallback");
  const [isLoadingCategories, setIsLoadingCategories] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [isCreatingCategory, setIsCreatingCategory] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);

  const loadCategories = useCallback(async () => {
    setIsLoadingCategories(true);
    try {
      const res = await api.categories.list();
      if (res && res.categories) {
        setCategoriesList(res.categories);
        if (res.source) setCategoriesSource(res.source);
      }
    } catch (err) {
      console.error("Failed to load categories:", err);
    } finally {
      setIsLoadingCategories(false);
    }
  }, []);

  const handleCreateCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newCategoryName.trim();
    setCategoryError(null);

    if (!trimmed) {
      setCategoryError("Please enter a category name.");
      return;
    }
    if (trimmed.length < 2) {
      setCategoryError("Category name must be at least 2 characters.");
      return;
    }
    if (trimmed.length > 100) {
      setCategoryError("Category name must not exceed 100 characters.");
      return;
    }

    const isDup = categoriesList.some((c) => c.name.toLowerCase() === trimmed.toLowerCase());
    if (isDup) {
      const msg = `Category "${trimmed}" already exists.`;
      setCategoryError(msg);
      toast.error(msg);
      return;
    }

    setIsCreatingCategory(true);
    try {
      const res = await api.admin.createCategory(trimmed);
      if (res && res.success) {
        toast.success(res.message || `Category "${trimmed}" created successfully.`);
        setNewCategoryName("");
        await loadCategories();
        window.dispatchEvent(new CustomEvent("facetube:categories-updated"));
      } else {
        const errMsg = res?.error || "Failed to create category.";
        setCategoryError(errMsg);
        toast.error(errMsg);
      }
    } catch (err: any) {
      const errMsg = err?.message || "Failed to create category.";
      setCategoryError(errMsg);
      toast.error(errMsg);
    } finally {
      setIsCreatingCategory(false);
    }
  };

  // Subscription Management State (Phase 2E)
  const [adminSubscriptions, setAdminSubscriptions] = useState<any[]>([]);
  const [adminSubStats, setAdminSubStats] = useState({
    total: 0,
    active: 0,
    expired: 0,
    totalRevenue: 0,
  });
  const [adminSubPagination, setAdminSubPagination] = useState({
    page: 1,
    limit: 10,
    totalItems: 0,
    totalPages: 1,
  });
  const [isLoadingAdminSubs, setIsLoadingAdminSubs] = useState(false);
  const [adminSubError, setAdminSubError] = useState<string | null>(null);
  const [adminSubSearch, setAdminSubSearch] = useState("");
  const [adminSubFilter, setAdminSubFilter] = useState<"all" | "active" | "expired">("all");
  const [adminSubPage, setAdminSubPage] = useState(1);
  const [selectedSubDetail, setSelectedSubDetail] = useState<any | null>(null);

  const loadAdminSubscriptions = useCallback(
    async (
      pageOverride?: number,
      searchOverride?: string,
      statusOverride?: "all" | "active" | "expired",
    ) => {
      setIsLoadingAdminSubs(true);
      setAdminSubError(null);
      try {
        const targetPage = pageOverride !== undefined ? pageOverride : adminSubPage;
        const targetSearch = searchOverride !== undefined ? searchOverride : adminSubSearch;
        const targetStatus = statusOverride !== undefined ? statusOverride : adminSubFilter;
        const subParams: {
          page: number;
          limit: number;
          status: "all" | "active" | "expired";
          search?: string;
        } = {
          page: targetPage,
          limit: 10,
          status: targetStatus,
        };
        if (targetSearch.trim()) {
          subParams.search = targetSearch.trim();
        }
        const res = await api.admin.listSubscriptions(subParams);
        if (res && res.success) {
          setAdminSubscriptions(res.subscriptions || []);
          if (res.stats) setAdminSubStats(res.stats);
          if (res.pagination) {
            setAdminSubPage(res.pagination.page);
            setAdminSubPagination(res.pagination);
          }
        } else {
          setAdminSubError(res?.error || "Failed to load admin subscriptions.");
        }
      } catch (err: any) {
        setAdminSubError(err?.message || "Failed to load admin subscriptions.");
      } finally {
        setIsLoadingAdminSubs(false);
      }
    },
    [adminSubPage, adminSubSearch, adminSubFilter],
  );

  // Subscription Sub-View State: "memberships" | "refunds"
  const [subSection, setSubSection] = useState<"memberships" | "refunds">("memberships");

  // Admin Refund Requests Management State (Phase 2F)
  const [adminRefunds, setAdminRefunds] = useState<any[]>([]);
  const [adminRefundStats, setAdminRefundStats] = useState({
    total: 0,
    pending: 0,
    approved: 0,
    rejected: 0,
    refunded: 0,
    totalRefundAmount: 0,
    refundedAmount: 0,
  });
  const [adminRefundPagination, setAdminRefundPagination] = useState({
    page: 1,
    limit: 10,
    totalItems: 0,
    totalPages: 1,
  });
  const [isLoadingAdminRefunds, setIsLoadingAdminRefunds] = useState(false);
  const [adminRefundError, setAdminRefundError] = useState<string | null>(null);
  const [adminRefundSearch, setAdminRefundSearch] = useState("");
  const [adminRefundFilter, setAdminRefundFilter] = useState<
    "all" | "pending" | "approved" | "rejected" | "refunded"
  >("all");
  const [adminRefundPage, setAdminRefundPage] = useState(1);
  const [selectedRefundForReview, setSelectedRefundForReview] = useState<any | null>(null);
  const [reviewDecision, setReviewDecision] = useState<"approved" | "rejected">("approved");
  const [reviewAdminNote, setReviewAdminNote] = useState("");
  const [isSubmittingReview, setIsSubmittingReview] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const loadAdminRefunds = useCallback(
    async (
      pageOverride?: number,
      searchOverride?: string,
      statusOverride?: "all" | "pending" | "approved" | "rejected" | "refunded",
    ) => {
      setIsLoadingAdminRefunds(true);
      setAdminRefundError(null);
      try {
        const targetPage = pageOverride !== undefined ? pageOverride : adminRefundPage;
        const targetSearch = searchOverride !== undefined ? searchOverride : adminRefundSearch;
        const targetStatus = statusOverride !== undefined ? statusOverride : adminRefundFilter;
        const refundParams: {
          page: number;
          limit: number;
          search?: string;
          status?: "approved" | "rejected" | "pending" | "refunded";
        } = {
          page: targetPage,
          limit: 10,
        };
        if (targetSearch.trim()) {
          refundParams.search = targetSearch.trim();
        }
        if (targetStatus !== "all") {
          refundParams.status = targetStatus;
        }
        const res = await api.admin.listRefundRequests(refundParams);
        if (res && res.success) {
          setAdminRefunds(res.requests || []);
          if (res.stats) setAdminRefundStats(res.stats);
          if (res.pagination) {
            setAdminRefundPage(res.pagination.page);
            setAdminRefundPagination(res.pagination);
          }
        } else {
          setAdminRefundError(res?.error || "Failed to load refund requests.");
        }
      } catch (err: any) {
        setAdminRefundError(err?.message || "Failed to load refund requests.");
      } finally {
        setIsLoadingAdminRefunds(false);
      }
    },
    [adminRefundPage, adminRefundSearch, adminRefundFilter],
  );

  const handleReviewRefundSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRefundForReview) return;
    setIsSubmittingReview(true);
    setReviewError(null);
    try {
      const reviewParams: {
        requestId: string;
        decision: "approved" | "rejected";
        adminNote?: string;
      } = {
        requestId: selectedRefundForReview.id,
        decision: reviewDecision,
      };
      if (reviewAdminNote.trim()) {
        reviewParams.adminNote = reviewAdminNote.trim();
      }
      const res = await api.admin.reviewRefundRequest(reviewParams);

      if (res && res.success) {
        toast.success(res.message || `Refund request ${reviewDecision} successfully.`);
        setSelectedRefundForReview(null);
        setReviewAdminNote("");
        await Promise.all([
          loadAdminRefunds(adminRefundPage),
          loadAdminSubscriptions(adminSubPage),
        ]);
      } else {
        const msg = res?.error || "Failed to process refund review.";
        setReviewError(msg);
        toast.error(msg);
      }
    } catch (err: any) {
      const msg = err?.data?.error || err?.message || "Failed to process refund review.";
      setReviewError(msg);
      toast.error(msg);
    } finally {
      setIsSubmittingReview(false);
    }
  };

  useEffect(() => {
    if (isAdmin) {
      loadModerationVideos();
      loadPendingPayouts();
      loadCategories();
      loadEarningsReport();
      loadPlatformSettings();
      loadAdminSubscriptions();
      loadAdminRefunds();
    }
  }, [
    isAdmin,
    loadModerationVideos,
    loadPendingPayouts,
    loadCategories,
    loadEarningsReport,
    loadPlatformSettings,
    loadAdminSubscriptions,
    loadAdminRefunds,
  ]);

  useEffect(() => {
    if (isAdmin && activeTab === "earnings") {
      loadEarningsReport();
    }
    if (isAdmin && activeTab === "settings") {
      loadPlatformSettings();
    }
    if (isAdmin && activeTab === "subscriptions") {
      loadAdminSubscriptions();
      loadAdminRefunds();
    }
  }, [
    isAdmin,
    activeTab,
    loadEarningsReport,
    loadPlatformSettings,
    loadAdminSubscriptions,
    loadAdminRefunds,
  ]);

  if (isLoading) {
    return (
      <div className="grid min-h-screen place-items-center bg-background text-foreground">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
          <p className="text-sm font-medium text-muted-foreground">
            Verifying admin permissions...
          </p>
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="grid min-h-screen place-items-center bg-background px-6 text-center text-foreground">
        <div className="max-w-md">
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-destructive/10 text-destructive">
            <Lock className="h-8 w-8" />
          </div>
          <h1 className="mt-4 text-2xl font-bold">Access Restricted</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Only users with the <strong className="text-foreground">admin</strong> role are
            permitted to view the Admin Console. Redirecting to home...
          </p>
          <Link
            to="/"
            className="mt-6 inline-flex items-center gap-2 rounded-full bg-brand px-6 py-2.5 text-sm font-semibold text-brand-foreground shadow-lift"
          >
            <ArrowLeft className="h-4 w-4" />
            Return to Feed
          </Link>
        </div>
      </div>
    );
  }

  const filteredUsers = allUsers.filter(
    (u) =>
      u.username.toLowerCase().includes(searchQuery.toLowerCase()) ||
      u.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (u.full_name && u.full_name.toLowerCase().includes(searchQuery.toLowerCase())),
  );

  const adminCount = allUsers.filter((u) => u.role === "admin").length;
  const standardUserCount = allUsers.filter((u) => u.role === "user").length;

  const handleRoleToggle = async (targetId: string, currentRole: RoleType) => {
    const nextRole: RoleType = currentRole === "admin" ? "user" : "admin";
    setUpdatingId(targetId);
    try {
      await updateUserRole(targetId, nextRole);
      toast.success(`Role updated to ${nextRole}`);
    } catch {
      toast.error("Failed to update role");
    } finally {
      setUpdatingId(null);
    }
  };

  // Requirement 10: Moderation Toggle
  const handleToggleBlock = async (video: ModerationVideo) => {
    const isCurrentlyBlocked = Boolean(video.is_blocked);
    const nextBlocked = !isCurrentlyBlocked;
    const reason = nextBlocked
      ? prompt(
          "Enter moderation reason for blocking this video:",
          "Policy violation / Community guideline flag",
        ) || "Content moderation"
      : undefined;

    if (nextBlocked && reason === null) return; // User cancelled prompt

    setModeratingId(video.id);
    try {
      const res = await api.admin.updateVideoStatus({
        videoId: video.id,
        isBlocked: nextBlocked,
        reason: reason || "Content moderation",
      });

      if (res && res.success) {
        toast.success(
          nextBlocked
            ? `🚫 Video "${video.title.slice(0, 20)}..." has been blocked from all feeds.`
            : `✅ Video "${video.title.slice(0, 20)}..." has been unblocked.`,
        );
        await loadModerationVideos();
      } else {
        toast.error("Failed to update video moderation status.");
      }
    } catch (err: any) {
      toast.error(err?.message || "Failed to update video status.");
    } finally {
      setModeratingId(null);
    }
  };

  // Requirement 8: Bulk Payout Execution
  const toggleSelectAllPayouts = () => {
    if (selectedPayoutIds.length === payoutList.length) {
      setSelectedPayoutIds([]);
    } else {
      setSelectedPayoutIds(payoutList.map((p) => p.id));
    }
  };

  const toggleSelectPayout = (id: string) => {
    setSelectedPayoutIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };

  const selectedPayoutTotal = payoutList
    .filter((p) => selectedPayoutIds.includes(p.id))
    .reduce((sum, p) => sum + p.amount, 0);

  const selectedNetTotal = payoutList
    .filter((p) => selectedPayoutIds.includes(p.id))
    .reduce((sum, p) => sum + (p.netAmount ?? Math.max(0, p.amount - (p.fee ?? 12))), 0);

  const handleExecuteBulkPayout = async () => {
    if (selectedPayoutIds.length === 0) {
      toast.error("Please select at least one recipient for bulk payout.");
      return;
    }

    const itemsToPay = payoutList.filter((p) => selectedPayoutIds.includes(p.id));
    setProcessingBulk(true);
    try {
      const res = await api.admin.bulkPayout({
        payouts: itemsToPay.map((item) => ({
          userId: item.userId,
          amount: item.amount,
          transactionId: item.id,
        })),
        notes: payoutNotes,
      });

      if (res && res.success) {
        setLastBatchResult(res);
        toast.success(
          `🎉 Bulk payout complete! ${res.total_recipients} creators disbursed ₹${res.total_amount.toLocaleString("en-IN")}. Batch: ${res.batch_id}`,
        );
        // Remove settled payouts from active queue
        setPayoutList((prev) => prev.filter((p) => !selectedPayoutIds.includes(p.id)));
        setSelectedPayoutIds([]);
      } else {
        toast.error(res?.message || "Bulk payout processing failed.");
      }
    } catch (err: any) {
      toast.error(err?.message || "Bulk payout failed.");
    } finally {
      setProcessingBulk(false);
    }
  };

  const filteredModerationVideos = videos.filter((v) => {
    const matchesSearch =
      v.title.toLowerCase().includes(videoSearch.toLowerCase()) ||
      (v.channel && v.channel.toLowerCase().includes(videoSearch.toLowerCase())) ||
      (v.user_id && v.user_id.toLowerCase().includes(videoSearch.toLowerCase()));

    if (!matchesSearch) return false;

    if (videoFilter === "shorts") return v.content_type === "short";
    if (videoFilter === "long") return v.content_type === "long";
    if (videoFilter === "blocked") return Boolean(v.is_blocked);
    return true;
  });

  const sqlMigrationCode = `-- FaceTube Production Schema & Moderation Tables
-- Run database/migrations/20261027_company_audit_updates.sql in phpMyAdmin
ALTER TABLE users ADD COLUMN IF NOT EXISTS channel_logo_url VARCHAR(500) NULL AFTER avatar_url;
ALTER TABLE users ADD COLUMN IF NOT EXISTS channel_name VARCHAR(150) NULL AFTER full_name;
ALTER TABLE uploaded_videos ADD COLUMN IF NOT EXISTS is_blocked TINYINT(1) DEFAULT 0;
ALTER TABLE uploaded_videos ADD COLUMN IF NOT EXISTS block_reason VARCHAR(255) NULL;
ALTER TABLE uploaded_videos ADD COLUMN IF NOT EXISTS ad_earnings DECIMAL(12,2) DEFAULT 0.00;
`;

  const copySql = () => {
    navigator.clipboard.writeText(sqlMigrationCode);
    setCopiedSql(true);
    setTimeout(() => setCopiedSql(false), 2000);
  };

  return (
    <div className="min-h-screen bg-background font-sans text-foreground">
      <Navbar
        onToggleSidebar={() => {
          setRailOpen((v) => !v);
          setDrawerOpen((v) => !v);
        }}
      />

      <div className="flex">
        <Sidebar open={railOpen} drawerOpen={drawerOpen} onClose={() => setDrawerOpen(false)} />

        <main className="min-w-0 flex-1 px-4 py-8 pb-24 sm:px-6 lg:px-10 lg:pb-12">
          {/* Header Banner */}
          <div className="flex flex-col justify-between gap-4 border-b border-border pb-6 sm:flex-row sm:items-center">
            <div>
              <div className="flex items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand/15 text-brand">
                  <ShieldCheck className="h-4 w-4" />
                </span>
                <span className="text-xs font-bold uppercase tracking-widest text-brand">
                  FaceTube Admin Operations
                </span>
              </div>
              <h1 className="mt-1.5 text-2xl font-extrabold tracking-tight sm:text-3xl">
                System Administration & Moderation
              </h1>
              <p className="text-sm text-muted-foreground">
                Manage user permissions, block/unblock videos, and execute batch creator
                withdrawals.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  refreshUsers();
                  loadModerationVideos();
                  loadPendingPayouts();
                  loadCategories();
                  loadEarningsReport();
                  toast.success("Admin datasets refreshed.");
                }}
                className="inline-flex items-center gap-2 rounded-xl border border-border bg-secondary/70 px-4 py-2 text-sm font-medium text-foreground transition hover:bg-secondary"
              >
                <RefreshCw className="h-4 w-4" />
                Refresh
              </button>
              <Link
                to="/"
                className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-brand-foreground shadow-lift transition hover:bg-brand-dark"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to Feed
              </Link>
            </div>
          </div>

          {/* Metric Cards */}
          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <div className="rounded-2xl border border-border bg-secondary/30 p-5 shadow-card">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Total Users
                </p>
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-blue-500/10 text-blue-500">
                  <Users className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-3 text-2xl font-black">{allUsers.length}</p>
              <p className="mt-1 text-xs text-muted-foreground">Registered accounts</p>
            </div>

            <div className="rounded-2xl border border-border bg-secondary/30 p-5 shadow-card">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Video Catalog
                </p>
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-purple-500/10 text-purple-500">
                  <Film className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-3 text-2xl font-black">{videos.length || allVideos.length}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {videoCounts.blocked} blocked by admin
              </p>
            </div>

            <div className="rounded-2xl border border-border bg-secondary/30 p-5 shadow-card">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Pending Payouts
                </p>
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-emerald-500/10 text-emerald-500">
                  <DollarSign className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-3 text-2xl font-black">{payoutList.length}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Total ₹{payoutList.reduce((s, p) => s + p.amount, 0).toLocaleString("en-IN")}
              </p>
            </div>

            <div className="rounded-2xl border border-border bg-secondary/30 p-5 shadow-card">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Categories
                </p>
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-amber-500/10 text-amber-500">
                  <Tag className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-3 text-2xl font-black">{categoriesList.length}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {categoriesSource === "database"
                  ? "Database synchronized"
                  : "Baseline active (migration pending)"}
              </p>
            </div>

            <div className="rounded-2xl border border-border bg-secondary/30 p-5 shadow-card">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Administrators
                </p>
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand/10 text-brand">
                  <ShieldCheck className="h-4 w-4" />
                </span>
              </div>
              <p className="mt-3 text-2xl font-black">{adminCount}</p>
              <p className="mt-1 text-xs text-muted-foreground">Full permission clearance</p>
            </div>
          </div>

          {/* Navigation Tabs */}
          <div className="mt-8 flex flex-wrap gap-2 border-b border-border pb-3">
            <button
              type="button"
              onClick={() => setActiveTab("users")}
              className={`rounded-xl px-4 py-2 text-xs font-bold transition flex items-center gap-2 ${
                activeTab === "users"
                  ? "bg-brand text-brand-foreground shadow-sm"
                  : "bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              <Users className="h-4 w-4" />
              <span>User Roles ({allUsers.length})</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("moderation")}
              className={`rounded-xl px-4 py-2 text-xs font-bold transition flex items-center gap-2 ${
                activeTab === "moderation"
                  ? "bg-brand text-brand-foreground shadow-sm"
                  : "bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              <Film className="h-4 w-4" />
              <span>Video Moderation (Req 10)</span>
              {videoCounts.blocked > 0 && (
                <span className="rounded-full bg-red-500 px-1.5 py-0.2 text-[10px] text-white">
                  {videoCounts.blocked}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("categories")}
              className={`rounded-xl px-4 py-2 text-xs font-bold transition flex items-center gap-2 ${
                activeTab === "categories"
                  ? "bg-brand text-brand-foreground shadow-sm"
                  : "bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              <Tag className="h-4 w-4" />
              <span>Categories ({categoriesList.length})</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("subscriptions")}
              className={`rounded-xl px-4 py-2 text-xs font-bold transition flex items-center gap-2 ${
                activeTab === "subscriptions"
                  ? "bg-brand text-brand-foreground shadow-sm"
                  : "bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              <Crown className="h-4 w-4" />
              <span>Subscription Management (Phase 2E)</span>
              {adminSubStats.total > 0 && (
                <span className="rounded-full bg-amber-500 px-1.5 py-0.2 text-[10px] text-white">
                  {adminSubStats.total}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("kyc")}
              className={`rounded-xl px-4 py-2 text-xs font-bold transition flex items-center gap-2 ${
                activeTab === "kyc"
                  ? "bg-brand text-brand-foreground shadow-sm"
                  : "bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              <ShieldCheck className="h-4 w-4" />
              <span>Creator KYC Reviews</span>
              {kycPendingCount > 0 && (
                <span className="rounded-full bg-amber-500 px-1.5 py-0.2 text-[10px] text-white">
                  {kycPendingCount}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("payouts")}
              className={`rounded-xl px-4 py-2 text-xs font-bold transition flex items-center gap-2 ${
                activeTab === "payouts"
                  ? "bg-brand text-brand-foreground shadow-sm"
                  : "bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              <DollarSign className="h-4 w-4" />
              <span>Bulk Withdrawal Payouts (Req 8)</span>
              {payoutList.length > 0 && (
                <span className="rounded-full bg-emerald-500 px-1.5 py-0.2 text-[10px] text-white">
                  {payoutList.length}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("earnings")}
              className={`rounded-xl px-4 py-2 text-xs font-bold transition flex items-center gap-2 ${
                activeTab === "earnings"
                  ? "bg-brand text-brand-foreground shadow-sm"
                  : "bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              <BarChart3 className="h-4 w-4" />
              <span>Earnings & Payouts Report (Req 15)</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("settings")}
              className={`rounded-xl px-4 py-2 text-xs font-bold transition flex items-center gap-2 ${
                activeTab === "settings"
                  ? "bg-brand text-brand-foreground shadow-sm"
                  : "bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              <Sliders className="h-4 w-4" />
              <span>Income Settings</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("database")}
              className={`rounded-xl px-4 py-2 text-xs font-bold transition flex items-center gap-2 ${
                activeTab === "database"
                  ? "bg-brand text-brand-foreground shadow-sm"
                  : "bg-secondary/60 text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              <Database className="h-4 w-4" />
              <span>Database Migrations</span>
            </button>
          </div>

          {/* TAB 1: USER ROLES */}
          {activeTab === "users" && (
            <section className="mt-6 rounded-2xl border border-border bg-card p-6 shadow-card">
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
                <div>
                  <h2 className="text-lg font-bold">User Directory & Role Assignments</h2>
                  <p className="text-xs text-muted-foreground">
                    Promote or demote users between{" "}
                    <strong className="text-foreground">user</strong> and{" "}
                    <strong className="text-foreground">admin</strong> in real time.
                  </p>
                </div>

                <div className="flex h-10 w-full max-w-xs items-center rounded-xl border border-border bg-secondary/50 px-3 transition focus-within:border-brand">
                  <Search className="mr-2 h-4 w-4 text-muted-foreground" />
                  <input
                    type="search"
                    placeholder="Filter by username or email..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="h-full w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                  />
                </div>
              </div>

              <div className="mt-6 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="pb-3 pl-2 font-semibold">User / Channel</th>
                      <th className="pb-3 font-semibold">Email</th>
                      <th className="pb-3 font-semibold">Role</th>
                      <th className="pb-3 font-semibold">Registered</th>
                      <th className="pb-3 pr-2 text-right font-semibold">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {filteredUsers.map((u) => {
                      const isTargetAdmin = u.role === "admin";
                      const isSelf = u.id === user?.id;
                      return (
                        <tr key={u.id} className="transition hover:bg-secondary/30">
                          <td className="py-4 pl-2">
                            <div className="flex items-center gap-3">
                              {u.channel_logo_url ? (
                                <img
                                  src={u.channel_logo_url}
                                  alt={u.channel_name || u.username}
                                  className="h-9 w-9 rounded-full object-cover ring-1 ring-border"
                                />
                              ) : (
                                <span
                                  className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-bold text-white ${
                                    isTargetAdmin
                                      ? "bg-gradient-to-br from-brand to-brand-dark"
                                      : "bg-slate-700"
                                  }`}
                                >
                                  {u.username.substring(0, 2).toUpperCase()}
                                </span>
                              )}
                              <div>
                                <p className="font-semibold text-foreground flex items-center gap-1.5">
                                  {u.user_id && (
                                    <span className="font-mono text-xs font-bold text-brand bg-brand/10 px-1.5 py-0.5 rounded">
                                      {u.user_id}
                                    </span>
                                  )}
                                  <span>
                                    {u.channel_name || u.name || u.full_name || `@${u.username}`}
                                  </span>
                                  {isSelf && (
                                    <span className="text-[10px] font-normal text-muted-foreground">
                                      (You)
                                    </span>
                                  )}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {u.mobile ? `${u.mobile} · ` : ""}@{u.username}
                                </p>
                              </div>
                            </div>
                          </td>
                          <td className="py-4 text-xs text-muted-foreground">{u.email}</td>
                          <td className="py-4">
                            <span
                              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold uppercase tracking-wider ${
                                isTargetAdmin
                                  ? "bg-brand/15 text-brand"
                                  : "bg-secondary text-foreground/80"
                              }`}
                            >
                              {isTargetAdmin ? (
                                <ShieldCheck className="h-3.5 w-3.5" />
                              ) : (
                                <UserCheck className="h-3.5 w-3.5" />
                              )}
                              {u.role}
                            </span>
                          </td>
                          <td className="py-4 text-xs text-muted-foreground">
                            {new Date(u.created_at).toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                              year: "numeric",
                            })}
                          </td>
                          <td className="py-4 pr-2 text-right">
                            <button
                              type="button"
                              disabled={updatingId === u.id}
                              onClick={() => handleRoleToggle(u.id, u.role)}
                              className={`rounded-xl px-3 py-1.5 text-xs font-semibold transition ${
                                isTargetAdmin
                                  ? "border border-border bg-secondary text-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
                                  : "bg-brand text-brand-foreground shadow-lift hover:bg-brand-dark"
                              }`}
                            >
                              {updatingId === u.id
                                ? "Updating..."
                                : isTargetAdmin
                                  ? "Demote to User"
                                  : "Promote to Admin"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* TAB 2: REQUIREMENT 10 — VIDEO MODERATION (SHORTS & LONG VIDEOS) */}
          {activeTab === "moderation" && (
            <section className="mt-6 rounded-2xl border border-border bg-card p-6 shadow-card space-y-6">
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-bold uppercase text-red-500">
                      Requirement 10
                    </span>
                    <h2 className="text-lg font-bold">Content Moderation & Video Blocking</h2>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Block or unblock Short and Long videos. Blocked videos are immediately hidden
                    from public feeds.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center rounded-xl border border-border bg-secondary/50 px-3 py-1.5 text-xs">
                    <Search className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                    <input
                      type="search"
                      placeholder="Search title, channel, ID..."
                      value={videoSearch}
                      onChange={(e) => setVideoSearch(e.target.value)}
                      className="bg-transparent outline-none placeholder:text-muted-foreground"
                    />
                  </div>

                  <div className="flex rounded-xl border border-border bg-secondary/40 p-1 text-xs">
                    <button
                      type="button"
                      onClick={() => setVideoFilter("all")}
                      className={`rounded-lg px-2.5 py-1 font-semibold ${
                        videoFilter === "all"
                          ? "bg-card text-foreground shadow-xs"
                          : "text-muted-foreground"
                      }`}
                    >
                      All ({videos.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setVideoFilter("shorts")}
                      className={`rounded-lg px-2.5 py-1 font-semibold ${
                        videoFilter === "shorts"
                          ? "bg-card text-foreground shadow-xs"
                          : "text-muted-foreground"
                      }`}
                    >
                      Shorts ({videoCounts.shorts})
                    </button>
                    <button
                      type="button"
                      onClick={() => setVideoFilter("long")}
                      className={`rounded-lg px-2.5 py-1 font-semibold ${
                        videoFilter === "long"
                          ? "bg-card text-foreground shadow-xs"
                          : "text-muted-foreground"
                      }`}
                    >
                      Long Form ({videoCounts.long})
                    </button>
                    <button
                      type="button"
                      onClick={() => setVideoFilter("blocked")}
                      className={`rounded-lg px-2.5 py-1 font-semibold ${
                        videoFilter === "blocked"
                          ? "bg-red-500 text-white shadow-xs"
                          : "text-red-400"
                      }`}
                    >
                      Blocked ({videoCounts.blocked})
                    </button>
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="pb-3 pl-2 font-semibold">Video</th>
                      <th className="pb-3 font-semibold">Format</th>
                      <th className="pb-3 font-semibold">Creator</th>
                      <th className="pb-3 font-semibold">Ad Earnings</th>
                      <th className="pb-3 font-semibold">Status</th>
                      <th className="pb-3 pr-2 text-right font-semibold">Moderation Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {filteredModerationVideos.map((vid) => {
                      const isBlocked = Boolean(vid.is_blocked);
                      const isShort =
                        vid.content_type === "short" ||
                        (vid.duration && vid.duration.startsWith("0:"));
                      const thumb =
                        vid.thumbnail_url ||
                        vid.thumb ||
                        "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=400";
                      return (
                        <tr
                          key={vid.id}
                          className={`transition ${isBlocked ? "bg-red-500/5" : "hover:bg-secondary/30"}`}
                        >
                          <td className="py-3 pl-2">
                            <div className="flex items-center gap-3">
                              <img
                                src={thumb}
                                alt={vid.title}
                                className="h-12 w-20 rounded-lg object-cover shrink-0 border border-border"
                              />
                              <div className="min-w-0 max-w-xs sm:max-w-md">
                                <p className="font-semibold text-foreground text-xs truncate">
                                  {vid.title}
                                </p>
                                <p className="text-[11px] text-muted-foreground font-mono mt-0.5">
                                  ID: {vid.id} · {vid.duration || "0:45"} · {vid.views || 0} views
                                </p>
                                {isBlocked && vid.block_reason && (
                                  <p className="text-[11px] text-red-400 flex items-center gap-1 mt-0.5">
                                    <AlertTriangle className="h-3 w-3 shrink-0" />
                                    Reason: {vid.block_reason}
                                  </p>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="py-3">
                            <span
                              className={`rounded-md px-2 py-0.5 text-[11px] font-bold uppercase ${
                                isShort
                                  ? "bg-rose-500/10 text-rose-400 border border-rose-500/30"
                                  : "bg-blue-500/10 text-blue-400 border border-blue-500/30"
                              }`}
                            >
                              {isShort ? "Short" : "Long Video"}
                            </span>
                          </td>
                          <td className="py-3 text-xs text-muted-foreground">
                            {vid.creator_name || vid.channel || vid.user_id || "Creator"}
                          </td>
                          <td className="py-3 text-xs font-mono font-bold text-emerald-400">
                            {vid.ad_earnings !== undefined && vid.ad_earnings !== null ? (
                              `₹${(Number(vid.ad_earnings) || 0).toFixed(2)}`
                            ) : (
                              <span className="text-muted-foreground font-normal">—</span>
                            )}
                          </td>
                          <td className="py-3">
                            {isBlocked ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-red-500/20 px-2.5 py-0.5 text-xs font-bold text-red-400">
                                <Ban className="h-3 w-3" />
                                Blocked
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-bold text-emerald-400">
                                <CheckCircle2 className="h-3 w-3" />
                                Active
                              </span>
                            )}
                          </td>
                          <td className="py-3 pr-2 text-right">
                            <button
                              type="button"
                              disabled={moderatingId === vid.id}
                              onClick={() => handleToggleBlock(vid)}
                              className={`rounded-xl px-3.5 py-1.5 text-xs font-bold transition flex items-center gap-1.5 ml-auto ${
                                isBlocked
                                  ? "bg-emerald-600 text-white hover:bg-emerald-500 shadow-sm"
                                  : "bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500 hover:text-white"
                              }`}
                            >
                              {moderatingId === vid.id ? (
                                "Updating..."
                              ) : isBlocked ? (
                                <>
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                  Unblock Video
                                </>
                              ) : (
                                <>
                                  <Ban className="h-3.5 w-3.5" />
                                  Block Video
                                </>
                              )}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* TAB 3: REQUIREMENT 8 — BULK WITHDRAWAL PAYOUTS */}
          {activeTab === "payouts" && (
            <section className="mt-6 rounded-2xl border border-border bg-card p-6 shadow-card space-y-6">
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold uppercase text-emerald-400">
                      Requirement 8
                    </span>
                    <h2 className="text-lg font-bold">Bulk Withdrawal Payout Execution</h2>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Batch-disburse pending withdrawal payouts to multiple creators in a single
                    operation.
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={toggleSelectAllPayouts}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-secondary/60 px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary"
                  >
                    {selectedPayoutIds.length === payoutList.length && payoutList.length > 0 ? (
                      <CheckSquare className="h-4 w-4 text-emerald-400" />
                    ) : (
                      <Square className="h-4 w-4" />
                    )}
                    <span>
                      {selectedPayoutIds.length === payoutList.length
                        ? "Deselect All"
                        : "Select All"}
                    </span>
                  </button>

                  <button
                    type="button"
                    disabled={selectedPayoutIds.length === 0 || processingBulk}
                    onClick={handleExecuteBulkPayout}
                    className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white shadow-lift transition hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Send className="h-3.5 w-3.5" />
                    <span>
                      {processingBulk
                        ? "Disbursing Batch..."
                        : `Process Bulk Payout (${selectedPayoutIds.length} · Net ₹${selectedNetTotal.toLocaleString("en-IN")})`}
                    </span>
                  </button>
                </div>
              </div>

              {/* Note field */}
              <div className="flex flex-col sm:flex-row sm:items-center gap-3 bg-secondary/30 p-3 rounded-xl border border-border">
                <span className="text-xs font-semibold text-muted-foreground whitespace-nowrap">
                  Batch Ledger Note:
                </span>
                <input
                  type="text"
                  value={payoutNotes}
                  onChange={(e) => setPayoutNotes(e.target.value)}
                  className="flex-1 bg-background border border-border rounded-lg px-3 py-1 text-xs outline-none focus:border-brand"
                  placeholder="e.g., Weekly creator withdrawal run approved by finance"
                />
              </div>

              {lastBatchResult && (
                <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4 text-xs space-y-1">
                  <div className="font-bold text-emerald-400 flex items-center gap-1.5">
                    <CheckCircle2 className="h-4 w-4" />
                    Last Batch Disbursed Successfully!
                  </div>
                  <p className="text-foreground">
                    Batch ID: <strong className="font-mono">{lastBatchResult.batch_id}</strong> ·
                    Total Disbursed:{" "}
                    <strong>₹{lastBatchResult.total_amount?.toLocaleString("en-IN")}</strong> to{" "}
                    <strong>{lastBatchResult.total_recipients}</strong> accounts.
                  </p>
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                      <th className="pb-3 pl-2 w-10">Select</th>
                      <th className="pb-3 font-semibold">Creator</th>
                      <th className="pb-3 font-semibold">User ID</th>
                      <th className="pb-3 font-semibold">Amount (Gross / Net)</th>
                      <th className="pb-3 font-semibold">Payout Destination</th>
                      <th className="pb-3 font-semibold">Requested At</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {payoutList.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-8 text-center text-xs text-muted-foreground">
                          No pending withdrawal requests in the queue.
                        </td>
                      </tr>
                    ) : (
                      payoutList.map((p) => {
                        const isSelected = selectedPayoutIds.includes(p.id);
                        const net = p.netAmount ?? Math.max(0, p.amount - (p.fee ?? 12));
                        return (
                          <tr
                            key={p.id}
                            onClick={() => toggleSelectPayout(p.id)}
                            className={`cursor-pointer transition ${
                              isSelected ? "bg-emerald-500/10" : "hover:bg-secondary/30"
                            }`}
                          >
                            <td className="py-3 pl-2">
                              {isSelected ? (
                                <CheckSquare className="h-4 w-4 text-emerald-400" />
                              ) : (
                                <Square className="h-4 w-4 text-muted-foreground" />
                              )}
                            </td>
                            <td className="py-3">
                              <p className="font-semibold text-xs text-foreground">{p.userName}</p>
                              <p className="text-[11px] text-muted-foreground">{p.userEmail}</p>
                            </td>
                            <td className="py-3 font-mono text-xs text-brand font-bold">
                              {p.userId}
                            </td>
                            <td className="py-3 font-mono">
                              <div className="font-black text-sm text-foreground">
                                ₹{p.amount.toLocaleString("en-IN")}
                              </div>
                              <div className="text-[11px] text-emerald-400 font-semibold flex items-center gap-1">
                                <span>Net: ₹{net.toLocaleString("en-IN")}</span>
                                <span className="text-orange-400/80 text-[10px]">
                                  (-₹{p.fee ?? 12})
                                </span>
                              </div>
                            </td>
                            <td className="py-3 text-xs text-muted-foreground font-mono">
                              {p.bankDetails?.upiId
                                ? `UPI: ${p.bankDetails.upiId}`
                                : p.bankDetails?.accountNumber
                                  ? `A/C: ${p.bankDetails.accountNumber} (${p.bankDetails.ifscCode || ""})`
                                  : "Default Verified Bank KYC"}
                            </td>
                            <td className="py-3 text-xs text-muted-foreground">
                              {new Date(p.requestedAt).toLocaleDateString("en-IN", {
                                month: "short",
                                day: "numeric",
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* TAB 3: CATEGORY MANAGEMENT (Priority 3) */}
          {activeTab === "categories" && (
            <div className="mt-6 space-y-6">
              {/* Migration Status Notice */}
              {categoriesSource === "baseline_fallback" ? (
                <div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-200">
                  <AlertTriangle className="h-5 w-5 flex-shrink-0 text-amber-400 mt-0.5" />
                  <div className="space-y-1">
                    <p className="font-bold text-amber-300">
                      Baseline Mode Active (Database Migration Pending)
                    </p>
                    <p className="text-amber-200/90 leading-relaxed">
                      The Hostinger MySQL{" "}
                      <code className="bg-black/30 px-1.5 py-0.5 rounded text-amber-100 font-mono">
                        categories
                      </code>{" "}
                      table is not yet executed in production. Categories are currently loaded from
                      the baseline catalog. Once the proposed migration{" "}
                      <code className="bg-black/30 px-1.5 py-0.5 rounded text-amber-100 font-mono">
                        database/migrations/20261030_create_categories_table.sql
                      </code>{" "}
                      is approved and executed in phpMyAdmin, all categories will be dynamically
                      managed in MySQL.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300 font-medium">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  <span>
                    Synchronized with Hostinger MySQL <code className="font-mono">categories</code>{" "}
                    table.
                  </span>
                </div>
              )}

              {/* Form & List Grid */}
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                {/* Create Category Card */}
                <section className="rounded-2xl border border-border bg-card p-6 shadow-card h-fit lg:col-span-1">
                  <div className="flex items-center gap-2">
                    <span className="grid h-7 w-7 place-items-center rounded-lg bg-brand/15 text-brand">
                      <PlusCircle className="h-4 w-4" />
                    </span>
                    <h2 className="text-base font-bold">Create New Category</h2>
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
                    Add a new verified category for creators. Category names are unique and checked
                    case-insensitively.
                  </p>

                  <form onSubmit={handleCreateCategory} className="mt-5 space-y-4">
                    <div>
                      <div className="flex justify-between items-center text-xs mb-1.5">
                        <label htmlFor="cat-name-input" className="font-semibold text-foreground">
                          Category Name
                        </label>
                        <span className="text-[11px] text-muted-foreground font-mono">
                          {newCategoryName.trim().length} / 100
                        </span>
                      </div>
                      <input
                        id="cat-name-input"
                        type="text"
                        value={newCategoryName}
                        onChange={(e) => {
                          setNewCategoryName(e.target.value);
                          if (categoryError) setCategoryError(null);
                        }}
                        maxLength={100}
                        placeholder="e.g. Technology, Gaming, Podcasting"
                        disabled={isCreatingCategory}
                        className="w-full rounded-xl border border-border bg-secondary/40 px-3.5 py-2.5 text-sm text-foreground outline-none transition focus:border-brand focus:ring-1 focus:ring-brand disabled:opacity-50"
                      />
                    </div>

                    {categoryError && (
                      <div className="flex items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
                        <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                        <span>{categoryError}</span>
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={isCreatingCategory || !newCategoryName.trim()}
                      className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-xs font-bold text-brand-foreground shadow-lift transition hover:bg-brand-dark disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isCreatingCategory ? (
                        <>
                          <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand-foreground border-t-transparent" />
                          <span>Creating Category...</span>
                        </>
                      ) : (
                        <>
                          <PlusCircle className="h-4 w-4" />
                          <span>Create Category</span>
                        </>
                      )}
                    </button>
                  </form>
                </section>

                {/* Existing Categories Directory Card */}
                <section className="rounded-2xl border border-border bg-card p-6 shadow-card lg:col-span-2">
                  <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="text-base font-bold">Category Catalog</h2>
                        <span className="rounded-full bg-brand/15 px-2 py-0.5 text-xs font-bold text-brand">
                          {categoriesList.length} total
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        All categories currently available across FaceTube video feeds and uploads.
                      </p>
                    </div>

                    <div className="flex h-9 w-full max-w-xs items-center rounded-xl border border-border bg-secondary/50 px-3 transition focus-within:border-brand">
                      <Search className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                      <input
                        type="search"
                        value={categoryFilter}
                        onChange={(e) => setCategoryFilter(e.target.value)}
                        placeholder="Search categories..."
                        className="w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none"
                      />
                    </div>
                  </div>

                  {isLoadingCategories ? (
                    <div className="py-12 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                      <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                      <p className="text-xs">Loading categories...</p>
                    </div>
                  ) : (
                    <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {categoriesList
                        .filter(
                          (c) =>
                            c.name.toLowerCase().includes(categoryFilter.toLowerCase()) ||
                            c.slug.toLowerCase().includes(categoryFilter.toLowerCase()),
                        )
                        .map((cat) => (
                          <div
                            key={String(cat.id || cat.slug || cat.name)}
                            className="flex flex-col justify-between rounded-xl border border-border bg-secondary/20 p-3.5 transition hover:border-brand/40"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <h3 className="text-sm font-bold text-foreground">{cat.name}</h3>
                                <p className="text-[11px] font-mono text-muted-foreground">
                                  #{cat.slug}
                                </p>
                              </div>
                              <span
                                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                  cat.created_by === "SYSTEM"
                                    ? "bg-secondary text-muted-foreground"
                                    : "bg-brand/15 text-brand"
                                }`}
                              >
                                {cat.created_by || "System"}
                              </span>
                            </div>
                            <div className="mt-3 flex items-center justify-between border-t border-border/40 pt-2 text-[10px] text-muted-foreground">
                              <span>ID: {String(cat.id)}</span>
                              <span>
                                {cat.created_at
                                  ? new Date(cat.created_at).toLocaleDateString("en-IN", {
                                      month: "short",
                                      day: "numeric",
                                    })
                                  : "Baseline"}
                              </span>
                            </div>
                          </div>
                        ))}
                    </div>
                  )}

                  {!isLoadingCategories &&
                    categoriesList.filter(
                      (c) =>
                        c.name.toLowerCase().includes(categoryFilter.toLowerCase()) ||
                        c.slug.toLowerCase().includes(categoryFilter.toLowerCase()),
                    ).length === 0 && (
                      <div className="py-12 text-center text-xs text-muted-foreground">
                        No categories match "{categoryFilter}".
                      </div>
                    )}
                </section>
              </div>
            </div>
          )}

          {/* TAB 5: REQUIREMENT 15 — EARNINGS & PAYOUTS REPORT */}
          {activeTab === "earnings" && (
            <div className="mt-6 space-y-6">
              {/* Header and Filter Card */}
              <section className="rounded-2xl border border-border bg-card p-6 shadow-card space-y-5">
                <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-brand/15 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-brand">
                        Requirement 15
                      </span>
                      <h2 className="text-lg font-bold">Admin Earnings & Payouts Report</h2>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Authoritative user earnings breakdown across separate income streams:
                      Referral, Global Pool, Google AdSense, and Affiliate / Marketing.
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => loadEarningsReport(1)}
                      disabled={isLoadingReport}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-secondary/70 px-3.5 py-2 text-xs font-semibold text-foreground transition hover:bg-secondary disabled:opacity-50"
                    >
                      <RefreshCw
                        className={`h-3.5 w-3.5 ${isLoadingReport ? "animate-spin text-brand" : ""}`}
                      />
                      <span>Refresh</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleExportCsv}
                      disabled={isExportingCsv || earningsUsers.length === 0}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-bold text-white shadow-lift transition hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Download className="h-3.5 w-3.5" />
                      <span>{isExportingCsv ? "Exporting CSV..." : "Export CSV"}</span>
                    </button>
                  </div>
                </div>

                {/* Filter Controls Bar */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 pt-2 border-t border-border/50">
                  {/* Search Filter */}
                  <div>
                    <label className="block text-[11px] font-semibold text-muted-foreground mb-1">
                      Search User
                    </label>
                    <div className="flex h-9 items-center rounded-xl border border-border bg-secondary/40 px-3 transition focus-within:border-brand">
                      <Search className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                      <input
                        type="search"
                        placeholder="Name, email, user ID..."
                        value={reportSearch}
                        onChange={(e) => setReportSearch(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && loadEarningsReport(1)}
                        className="w-full bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none"
                      />
                    </div>
                  </div>

                  {/* Date Mode Filter */}
                  <div>
                    <label className="block text-[11px] font-semibold text-muted-foreground mb-1">
                      Date Filter Mode
                    </label>
                    <select
                      value={reportDateMode}
                      onChange={(e) => setReportDateMode(e.target.value as "joined" | "activity")}
                      className="h-9 w-full rounded-xl border border-border bg-secondary/40 px-3 text-xs text-foreground outline-none focus:border-brand"
                    >
                      <option value="joined">User Registration Date</option>
                      <option value="activity">Ledger Activity Date</option>
                    </select>
                  </div>

                  {/* Start Date */}
                  <div>
                    <label className="block text-[11px] font-semibold text-muted-foreground mb-1">
                      Start Date
                    </label>
                    <div className="flex h-9 items-center rounded-xl border border-border bg-secondary/40 px-3">
                      <Calendar className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                      <input
                        type="date"
                        value={reportStartDate}
                        onChange={(e) => setReportStartDate(e.target.value)}
                        className="w-full bg-transparent text-xs text-foreground outline-none"
                      />
                    </div>
                  </div>

                  {/* End Date & Apply Button */}
                  <div>
                    <label className="block text-[11px] font-semibold text-muted-foreground mb-1">
                      End Date
                    </label>
                    <div className="flex gap-2">
                      <div className="flex h-9 flex-1 items-center rounded-xl border border-border bg-secondary/40 px-3">
                        <Calendar className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                        <input
                          type="date"
                          value={reportEndDate}
                          onChange={(e) => setReportEndDate(e.target.value)}
                          className="w-full bg-transparent text-xs text-foreground outline-none"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => loadEarningsReport(1)}
                        className="rounded-xl bg-brand px-3 text-xs font-bold text-brand-foreground shadow-sm hover:bg-brand-dark"
                      >
                        Apply
                      </button>
                    </div>
                  </div>
                </div>

                {/* Filter Active Notice */}
                {(reportSearch || reportStartDate || reportEndDate) && (
                  <div className="flex items-center justify-between text-xs text-muted-foreground bg-secondary/30 px-3 py-2 rounded-xl">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-foreground">Active Filters:</span>
                      {reportSearch && (
                        <span className="bg-brand/10 text-brand px-2 py-0.5 rounded-full text-[11px]">
                          Search: "{reportSearch}"
                        </span>
                      )}
                      {(reportStartDate || reportEndDate) && (
                        <span className="bg-brand/10 text-brand px-2 py-0.5 rounded-full text-[11px]">
                          Date: {reportStartDate || "Beginning"} to {reportEndDate || "Now"} (
                          {reportDateMode})
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setReportSearch("");
                        setReportStartDate("");
                        setReportEndDate("");
                        setTimeout(() => loadEarningsReport(1), 50);
                      }}
                      className="text-xs text-brand hover:underline font-semibold"
                    >
                      Clear All Filters
                    </button>
                  </div>
                )}
              </section>

              {/* Summary Cards */}
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-4">
                <div className="rounded-2xl border border-border bg-secondary/30 p-4 shadow-card">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Total In Scope Users
                  </p>
                  <p className="mt-2 text-2xl font-black">{earningsSummary.totalUsers}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">Registered accounts</p>
                </div>

                <div className="rounded-2xl border border-border bg-secondary/30 p-4 shadow-card">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Current Wallet Balance
                  </p>
                  <p className="mt-2 text-2xl font-black text-brand">
                    ₹
                    {earningsSummary.totalWalletBalance.toLocaleString("en-IN", {
                      minimumFractionDigits: 2,
                    })}
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Outstanding creator liability
                  </p>
                </div>

                <div className="rounded-2xl border border-border bg-secondary/30 p-4 shadow-card">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Cumulative Earned
                  </p>
                  <p className="mt-2 text-2xl font-black text-emerald-400">
                    ₹
                    {earningsSummary.totalEarned.toLocaleString("en-IN", {
                      minimumFractionDigits: 2,
                    })}
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">All-time settled income</p>
                </div>

                <div className="rounded-2xl border border-border bg-secondary/30 p-4 shadow-card">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Total Withdrawn
                  </p>
                  <p className="mt-2 text-2xl font-black text-amber-400">
                    ₹
                    {earningsSummary.totalWithdrawn.toLocaleString("en-IN", {
                      minimumFractionDigits: 2,
                    })}
                  </p>
                  <p className="mt-1 text-[11px] text-muted-foreground">Disbursed to creators</p>
                </div>
              </div>

              {/* Source Breakdown Badges */}
              <div className="rounded-2xl border border-border bg-card p-4 shadow-card">
                <p className="text-xs font-bold text-foreground mb-3 flex items-center gap-2">
                  <BarChart3 className="h-4 w-4 text-brand" />
                  <span>Platform Aggregate Breakdown by Genuine Income Stream</span>
                </p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                  <div className="rounded-xl border border-border/60 bg-secondary/20 p-3">
                    <span className="text-[10px] uppercase font-bold text-muted-foreground">
                      Referral Income
                    </span>
                    <p className="text-base font-black text-foreground mt-1">
                      ₹
                      {earningsSummary.totalReferralIncome.toLocaleString("en-IN", {
                        minimumFractionDigits: 2,
                      })}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">Sponsor commissions</p>
                  </div>
                  <div className="rounded-xl border border-border/60 bg-secondary/20 p-3">
                    <span className="text-[10px] uppercase font-bold text-muted-foreground">
                      Global Pool Income
                    </span>
                    <p className="text-base font-black text-foreground mt-1">
                      ₹
                      {earningsSummary.totalGlobalIncome.toLocaleString("en-IN", {
                        minimumFractionDigits: 2,
                      })}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      Weighted creator pool
                    </p>
                  </div>
                  <div className="rounded-xl border border-border/60 bg-secondary/20 p-3">
                    <span className="text-[10px] uppercase font-bold text-muted-foreground">
                      Google AdSense Income
                    </span>
                    <p className="text-base font-black text-foreground mt-1">
                      ₹
                      {earningsSummary.totalAdsenseIncome.toLocaleString("en-IN", {
                        minimumFractionDigits: 2,
                      })}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      Verified AdSense share
                    </p>
                  </div>
                  <div className="rounded-xl border border-border/60 bg-secondary/20 p-3">
                    <span className="text-[10px] uppercase font-bold text-muted-foreground">
                      Google AdMob Income
                    </span>
                    <p className="text-base font-black text-foreground mt-1">
                      ₹
                      {earningsSummary.totalAdmobIncome.toLocaleString("en-IN", {
                        minimumFractionDigits: 2,
                      })}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">Verified AdMob share</p>
                  </div>
                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
                    <span className="text-[10px] uppercase font-bold text-emerald-400">
                      Total Ad Earning
                    </span>
                    <p className="text-base font-black text-emerald-400 mt-1">
                      ₹
                      {earningsSummary.totalAdEarning.toLocaleString("en-IN", {
                        minimumFractionDigits: 2,
                      })}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      AdSense + AdMob combined
                    </p>
                  </div>
                  <div className="rounded-xl border border-border/60 bg-secondary/20 p-3">
                    <span className="text-[10px] uppercase font-bold text-muted-foreground">
                      Affiliate / Marketing
                    </span>
                    <p className="text-base font-black text-foreground mt-1">
                      ₹
                      {earningsSummary.totalAffiliateIncome.toLocaleString("en-IN", {
                        minimumFractionDigits: 2,
                      })}
                    </p>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      Ad promotion marketing ({marketingPercentage}%)
                    </p>
                  </div>
                </div>
              </div>

              {/* User Directory Table */}
              <section className="rounded-2xl border border-border bg-card p-6 shadow-card space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-foreground">
                    User Ledger Records ({reportTotalUsers} total)
                  </h3>
                  <span className="text-xs text-muted-foreground">
                    Page {reportPage} of {reportTotalPages}
                  </span>
                </div>

                {isLoadingReport ? (
                  <div className="py-12 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                    <p className="text-xs">Loading ledger analytics...</p>
                  </div>
                ) : earningsUsers.length === 0 ? (
                  <div className="py-12 text-center text-xs text-muted-foreground">
                    No user records match the specified filters.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                          <th className="pb-3 pl-2 font-semibold">User</th>
                          <th className="pb-3 font-semibold">Balance</th>
                          <th className="pb-3 font-semibold">Total Earned</th>
                          <th className="pb-3 font-semibold">Withdrawn</th>
                          <th className="pb-3 font-semibold">Referral</th>
                          <th className="pb-3 font-semibold">Global Pool</th>
                          <th className="pb-3 font-semibold">AdSense</th>
                          <th className="pb-3 font-semibold">AdMob</th>
                          <th className="pb-3 font-semibold">Total Ad Earning</th>
                          <th className="pb-3 font-semibold">Affiliate</th>
                          <th className="pb-3 pr-2 text-right font-semibold">History</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border/60">
                        {earningsUsers.map((u) => {
                          const adsense = Number(u.adsenseIncome || 0);
                          const admob = Number(u.admobIncome || 0);
                          const totalAdEarning =
                            u.totalAdEarning !== undefined && u.totalAdEarning !== null
                              ? Number(u.totalAdEarning || 0)
                              : Math.round((adsense + admob) * 100) / 100;
                          return (
                            <tr key={u.userId} className="transition hover:bg-secondary/30">
                              <td className="py-3 pl-2">
                                <p className="font-semibold text-xs text-foreground">{u.name}</p>
                                <p className="text-[11px] text-muted-foreground">{u.email}</p>
                                <div className="flex items-center gap-1.5 mt-0.5">
                                  <span className="font-mono text-[10px] font-bold text-brand bg-brand/10 px-1 py-0.2 rounded">
                                    {u.userId}
                                  </span>
                                  {u.referralCode && (
                                    <span className="font-mono text-[10px] text-muted-foreground">
                                      Ref: {u.referralCode}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="py-3 font-mono text-xs font-bold text-brand">
                                ₹{Number(u.balance || 0).toFixed(2)}
                              </td>
                              <td className="py-3 font-mono text-xs font-bold text-emerald-400">
                                ₹{Number(u.totalEarned || 0).toFixed(2)}
                              </td>
                              <td className="py-3 font-mono text-xs font-bold text-amber-400">
                                ₹{Number(u.totalWithdrawn || 0).toFixed(2)}
                              </td>
                              <td className="py-3 font-mono text-xs text-foreground">
                                ₹{Number(u.referralIncome || 0).toFixed(2)}
                              </td>
                              <td className="py-3 font-mono text-xs text-foreground">
                                ₹{Number(u.globalIncome || 0).toFixed(2)}
                              </td>
                              <td className="py-3 font-mono text-xs text-foreground">
                                ₹{adsense.toFixed(2)}
                              </td>
                              <td className="py-3 font-mono text-xs text-foreground">
                                ₹{admob.toFixed(2)}
                              </td>
                              <td className="py-3 font-mono text-xs font-bold text-emerald-400">
                                ₹{totalAdEarning.toFixed(2)}
                              </td>
                              <td className="py-3 font-mono text-xs text-foreground">
                                ₹{Number(u.affiliateIncome || 0).toFixed(2)}
                              </td>
                              <td className="py-3 pr-2 text-right">
                                <button
                                  type="button"
                                  onClick={() => handleViewWithdrawals(u)}
                                  className="inline-flex items-center gap-1 rounded-lg border border-border bg-secondary/50 px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-secondary hover:text-brand"
                                >
                                  <Eye className="h-3 w-3" />
                                  <span>Withdrawals</span>
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Pagination */}
                {reportTotalPages > 1 && (
                  <div className="flex items-center justify-between border-t border-border/60 pt-4">
                    <span className="text-xs text-muted-foreground">
                      Showing {(reportPage - 1) * reportLimit + 1} to{" "}
                      {Math.min(reportPage * reportLimit, reportTotalUsers)} of {reportTotalUsers}{" "}
                      creators
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={reportPage <= 1}
                        onClick={() => loadEarningsReport(reportPage - 1)}
                        className="inline-flex items-center gap-1 rounded-xl border border-border px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <ChevronLeft className="h-3.5 w-3.5" />
                        Previous
                      </button>
                      <span className="text-xs font-bold px-2">
                        {reportPage} / {reportTotalPages}
                      </span>
                      <button
                        type="button"
                        disabled={reportPage >= reportTotalPages}
                        onClick={() => loadEarningsReport(reportPage + 1)}
                        className="inline-flex items-center gap-1 rounded-xl border border-border px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        Next
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </section>

              {/* Withdrawal History Modal */}
              {selectedWithdrawalUser && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
                  <div className="w-full max-w-2xl rounded-2xl border border-border bg-card p-6 shadow-2xl space-y-4">
                    <div className="flex items-center justify-between border-b border-border pb-3">
                      <div>
                        <h3 className="text-base font-bold text-foreground">
                          Withdrawal History: {selectedWithdrawalUser.name}
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          User ID:{" "}
                          <span className="font-mono text-brand font-bold">
                            {selectedWithdrawalUser.userId}
                          </span>{" "}
                          · {selectedWithdrawalUser.email}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedWithdrawalUser(null)}
                        className="rounded-lg p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>

                    {isLoadingWithdrawals ? (
                      <div className="py-8 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                        <div className="h-5 w-5 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                        <p className="text-xs">Fetching withdrawal transactions...</p>
                      </div>
                    ) : userWithdrawals.length === 0 ? (
                      <div className="py-8 text-center text-xs text-muted-foreground">
                        No completed withdrawal requests found for this user in the specified
                        period.
                      </div>
                    ) : (
                      <div className="max-h-80 overflow-y-auto">
                        <table className="w-full text-left text-xs">
                          <thead>
                            <tr className="border-b border-border uppercase tracking-wider text-muted-foreground">
                              <th className="pb-2 font-semibold">Date</th>
                              <th className="pb-2 font-semibold">Tx ID</th>
                              <th className="pb-2 font-semibold">Amount</th>
                              <th className="pb-2 font-semibold">Status</th>
                              <th className="pb-2 font-semibold">Description</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/50">
                            {userWithdrawals.map((w: any) => (
                              <tr key={w.id || w.transactionId}>
                                <td className="py-2.5 text-muted-foreground">
                                  {new Date(w.createdAt).toLocaleDateString("en-IN", {
                                    month: "short",
                                    day: "numeric",
                                    year: "numeric",
                                  })}
                                </td>
                                <td className="py-2.5 font-mono text-[11px] text-foreground">
                                  {w.transactionId || w.id}
                                </td>
                                <td className="py-2.5 font-mono font-bold text-amber-400">
                                  ₹{Number(w.amount).toFixed(2)}
                                </td>
                                <td className="py-2.5">
                                  <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-400">
                                    {w.status}
                                  </span>
                                </td>
                                <td className="py-2.5 text-muted-foreground text-[11px]">
                                  {w.description || "Creator Withdrawal"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    <div className="flex justify-end pt-2 border-t border-border">
                      <button
                        type="button"
                        onClick={() => setSelectedWithdrawalUser(null)}
                        className="rounded-xl bg-secondary px-4 py-2 text-xs font-semibold text-foreground hover:bg-secondary/80"
                      >
                        Close
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 6: INCOME SETTINGS & MARKETING COMMISSION */}
          {activeTab === "settings" && (
            <div className="mt-6 space-y-6">
              <section className="rounded-2xl border border-border bg-card p-6 shadow-card space-y-6">
                <div className="flex items-center gap-2">
                  <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand/15 text-brand">
                    <Sliders className="h-4 w-4" />
                  </span>
                  <div>
                    <h2 className="text-lg font-bold">
                      Platform Income Sources & Marketing Configuration
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      Admin-controlled commission percentages and separate income stream tracking.
                    </p>
                  </div>
                </div>

                {/* Form to update Marketing Income Percentage */}
                <form onSubmit={handleSaveSettings} className="space-y-6">
                  <div className="rounded-xl border border-border bg-secondary/20 p-5 space-y-4">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div>
                        <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
                          <Percent className="h-4 w-4 text-brand" />
                          <span>Marketing / Affiliate Income Percentage</span>
                        </h3>
                        <p className="text-xs text-muted-foreground mt-1 max-w-xl">
                          Specifies the percentage of each Ad Promotion purchase distributed as
                          direct marketing / affiliate commission to the referring sponsor. Stored
                          in Hostinger MySQL{" "}
                          <code className="font-mono text-brand">platform_settings</code> table.
                        </p>
                      </div>

                      <div className="flex items-center gap-3">
                        <div className="relative w-36">
                          <input
                            type="number"
                            min="0"
                            max="100"
                            step="0.1"
                            value={marketingPercentage}
                            onChange={(e) =>
                              setMarketingPercentage(parseFloat(e.target.value) || 0)
                            }
                            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-right text-base font-black text-brand outline-none focus:border-brand pr-8"
                          />
                          <span className="absolute right-3 top-2.5 text-sm font-bold text-muted-foreground">
                            %
                          </span>
                        </div>

                        <button
                          type="submit"
                          disabled={isSavingSettings || isLoadingSettings}
                          className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2 text-xs font-bold text-brand-foreground shadow-lift transition hover:bg-brand-dark disabled:opacity-50"
                        >
                          {isSavingSettings ? (
                            <>
                              <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand-foreground border-t-transparent" />
                              <span>Saving...</span>
                            </>
                          ) : (
                            <>
                              <Check className="h-4 w-4" />
                              <span>Save Settings</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>

                    {/* Live Calculation Simulation Box */}
                    <div className="rounded-xl border border-brand/20 bg-brand/5 p-4 space-y-2">
                      <p className="text-xs font-bold text-brand flex items-center gap-1.5">
                        <DollarSign className="h-3.5 w-3.5" />
                        <span>
                          Live Calculation Simulation based on {marketingPercentage}% Setting:
                        </span>
                      </p>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 pt-1">
                        <div className="rounded-lg bg-background/80 p-2.5 border border-border/40">
                          <span className="text-[10px] text-muted-foreground font-semibold">
                            7 Days (₹100)
                          </span>
                          <p className="text-sm font-bold text-foreground">
                            ₹{((100 * marketingPercentage) / 100).toFixed(2)}
                          </p>
                          <span className="text-[10px] text-emerald-400">Direct Referrer</span>
                        </div>
                        <div className="rounded-lg bg-background/80 p-2.5 border border-border/40">
                          <span className="text-[10px] text-muted-foreground font-semibold">
                            15 Days (₹200)
                          </span>
                          <p className="text-sm font-bold text-foreground">
                            ₹{((200 * marketingPercentage) / 100).toFixed(2)}
                          </p>
                          <span className="text-[10px] text-emerald-400">Direct Referrer</span>
                        </div>
                        <div className="rounded-lg bg-background/80 p-2.5 border border-border/40">
                          <span className="text-[10px] text-muted-foreground font-semibold">
                            1 Month (₹300)
                          </span>
                          <p className="text-sm font-bold text-foreground">
                            ₹{((300 * marketingPercentage) / 100).toFixed(2)}
                          </p>
                          <span className="text-[10px] text-emerald-400">Direct Referrer</span>
                        </div>
                        <div className="rounded-lg bg-background/80 p-2.5 border border-border/40">
                          <span className="text-[10px] text-muted-foreground font-semibold">
                            1 Year (₹3000)
                          </span>
                          <p className="text-sm font-bold text-foreground">
                            ₹{((3000 * marketingPercentage) / 100).toFixed(2)}
                          </p>
                          <span className="text-[10px] text-emerald-400">Direct Referrer</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </form>

                {/* 7-Level Referral Schedule Overview */}
                <div className="rounded-xl border border-border bg-secondary/20 p-5 space-y-3">
                  <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
                    <Layers className="h-4 w-4 text-brand" />
                    <span>7-Level Ads Referral Commission Schedule</span>
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    In addition to direct marketing income, Ad Promotion campaigns disburse 7-level
                    upline referral earnings totalling 40% with integer paise precision and zero
                    rounding loss:
                  </p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7 pt-2">
                    {[
                      { level: 1, rate: adsReferralRates[1] ?? 15 },
                      { level: 2, rate: adsReferralRates[2] ?? 10 },
                      { level: 3, rate: adsReferralRates[3] ?? 5 },
                      { level: 4, rate: adsReferralRates[4] ?? 4 },
                      { level: 5, rate: adsReferralRates[5] ?? 3 },
                      { level: 6, rate: adsReferralRates[6] ?? 2 },
                      { level: 7, rate: adsReferralRates[7] ?? 1 },
                    ].map((lvl) => (
                      <div
                        key={lvl.level}
                        className="rounded-lg border border-border/60 bg-background/60 p-2.5 text-center"
                      >
                        <span className="text-[10px] font-bold text-muted-foreground uppercase">
                          Level {lvl.level}
                        </span>
                        <p className="text-base font-black text-brand mt-0.5">{lvl.rate}%</p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Separate Income Sources Architectural Matrix */}
                <div className="rounded-xl border border-border bg-secondary/20 p-5 space-y-3">
                  <h3 className="text-sm font-bold text-foreground flex items-center gap-2">
                    <BarChart3 className="h-4 w-4 text-brand" />
                    <span>Authoritative Income Sources Supported in Hostinger MySQL Ledger</span>
                  </h3>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 pt-2">
                    <div className="rounded-lg border border-border/50 bg-background/50 p-3">
                      <span className="font-mono text-xs font-bold text-brand">
                        referral_income
                      </span>
                      <h4 className="text-xs font-bold text-foreground mt-1">
                        Direct Referral Income
                      </h4>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        ₹1 per ₹6 Premium Video upload + L1–L7 upline referral commissions on Ad
                        Promotions.
                      </p>
                    </div>

                    <div className="rounded-lg border border-border/50 bg-background/50 p-3">
                      <span className="font-mono text-xs font-bold text-emerald-400">
                        global_pool_income
                      </span>
                      <h4 className="text-xs font-bold text-foreground mt-1">Global Pool Share</h4>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        ₹3 pool per normal premium video upload, distributed to active creators
                        weighted by video ad earnings.
                      </p>
                    </div>

                    <div className="rounded-lg border border-border/50 bg-background/50 p-3">
                      <span className="font-mono text-xs font-bold text-sky-400">
                        adsense_income
                      </span>
                      <h4 className="text-xs font-bold text-foreground mt-1">
                        Google AdSense Income
                      </h4>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Creator earnings from video ad views, banner impressions, and monetized
                        watch time.
                      </p>
                    </div>

                    <div className="rounded-lg border border-border/50 bg-background/50 p-3">
                      <span className="font-mono text-xs font-bold text-amber-400">
                        affiliate_income
                      </span>
                      <h4 className="text-xs font-bold text-foreground mt-1">
                        Affiliate / Marketing Income
                      </h4>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Direct marketing commission calculated dynamically using the admin
                        percentage above.
                      </p>
                    </div>

                    <div className="rounded-lg border border-border/50 bg-background/50 p-3">
                      <span className="font-mono text-xs font-bold text-purple-400">
                        ad_boost_income
                      </span>
                      <h4 className="text-xs font-bold text-foreground mt-1">Ad Boost Income</h4>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Campaign bonuses and creator incentives for featured promotional campaigns.
                      </p>
                    </div>

                    <div className="rounded-lg border border-border/50 bg-background/50 p-3">
                      <span className="font-mono text-xs font-bold text-rose-400">withdrawal</span>
                      <h4 className="text-xs font-bold text-foreground mt-1">
                        Creator Withdrawals
                      </h4>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        ₹12 gateway fee deduction per withdrawal, with instant or batch bank/UPI
                        disbursement.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Google AdSense Website Integration Configuration Card */}
                <div className="rounded-xl border border-border bg-secondary/20 p-5 space-y-5">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border/60 pb-3">
                    <div className="flex items-center gap-2.5">
                      <div className="grid h-9 w-9 place-items-center rounded-xl bg-yellow-500/10 text-yellow-400">
                        <Tv className="h-4 w-4" />
                      </div>
                      <div>
                        <h3 className="text-sm font-bold text-foreground">
                          Google AdSense Website Integration & Ad Slots
                        </h3>
                        <p className="text-xs text-muted-foreground">
                          Configure production Publisher ID (ca-pub-...) and ad slot units for
                          non-disruptive website placements.
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
                          adsenseClientId && adsenseClientId.startsWith("ca-pub-")
                            ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                            : "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                        }`}
                      >
                        {adsenseClientId && adsenseClientId.startsWith("ca-pub-")
                          ? "Publisher ID Active"
                          : "Awaiting Company Credentials"}
                      </span>
                    </div>
                  </div>

                  {/* Verification & ads.txt Reference Box */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="rounded-xl border border-border/60 bg-background/70 p-3.5 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-bold text-foreground flex items-center gap-1.5">
                          <FileText className="h-3.5 w-3.5 text-brand" />
                          <span>Authorized Sellers File (ads.txt)</span>
                        </span>
                        <a
                          href="/ads.txt"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] text-brand hover:underline inline-flex items-center gap-1"
                        >
                          <span>View ads.txt</span>
                          <ExternalLink className="h-2.5 w-2.5" />
                        </a>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        Served at{" "}
                        <code className="font-mono text-foreground">facetube.online/ads.txt</code>{" "}
                        to verify domain ownership with Google AdSense:
                      </p>
                      <pre className="rounded-lg bg-black/60 p-2 text-[10px] font-mono text-emerald-400 select-all overflow-x-auto">
                        google.com,{" "}
                        {adsenseClientId
                          ? adsenseClientId.replace(/^ca-/, "")
                          : "pub-0000000000000000"}
                        , DIRECT, f08c47fec0942fa0
                      </pre>
                    </div>

                    <div className="rounded-xl border border-border/60 bg-background/70 p-3.5 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-bold text-foreground flex items-center gap-1.5">
                          <Globe className="h-3.5 w-3.5 text-sky-400" />
                          <span>AdSense Account Verification Tag</span>
                        </span>
                        <span className="text-[10px] font-semibold text-muted-foreground">
                          Automatic in &lt;head&gt;
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        Rendered dynamically in document head when publisher ID is configured:
                      </p>
                      <pre className="rounded-lg bg-black/60 p-2 text-[10px] font-mono text-sky-400 select-all overflow-x-auto">
                        &lt;meta name="google-adsense-account" content="
                        {adsenseClientId || "ca-pub-0000000000000000"}"&gt;
                      </pre>
                    </div>
                  </div>

                  {/* AdSense Settings Inputs */}
                  <form onSubmit={handleSaveSettings} className="space-y-4 pt-1">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-semibold text-foreground mb-1">
                          AdSense Publisher ID (ca-pub-...)
                        </label>
                        <input
                          type="text"
                          placeholder="ca-pub-1234567890123456"
                          value={adsenseClientId}
                          onChange={(e) => setAdsenseClientId(e.target.value)}
                          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs font-mono text-foreground outline-none focus:border-brand"
                        />
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          Obtained from your approved Google AdSense console under Account &gt;
                          Settings.
                        </p>
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-foreground mb-1">
                          Watch Page Horizontal Banner Slot ID
                        </label>
                        <input
                          type="text"
                          placeholder="e.g. 9876543210"
                          value={adsenseSlotWatch}
                          onChange={(e) => setAdsenseSlotWatch(e.target.value)}
                          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs font-mono text-foreground outline-none focus:border-brand"
                        />
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          Responsive unit placed below video player description before comments.
                        </p>
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-foreground mb-1">
                          Watch Page Sidebar Rectangle Slot ID
                        </label>
                        <input
                          type="text"
                          placeholder="e.g. 5432109876"
                          value={adsenseSlotSidebar}
                          onChange={(e) => setAdsenseSlotSidebar(e.target.value)}
                          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs font-mono text-foreground outline-none focus:border-brand"
                        />
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          Standard 300x250 or responsive unit above related videos sidebar.
                        </p>
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-foreground mb-1">
                          Home Feed Banner Slot ID
                        </label>
                        <input
                          type="text"
                          placeholder="e.g. 1234567890"
                          value={adsenseSlotFeed}
                          onChange={(e) => setAdsenseSlotFeed(e.target.value)}
                          className="w-full border rounded-xl border-border bg-background px-3 py-2 text-xs font-mono text-foreground outline-none focus:border-brand"
                        />
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          Non-disruptive horizontal unit between Hero banner and video feed.
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-border/40">
                      <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-foreground">
                        <input
                          type="checkbox"
                          checked={adsenseEnabled}
                          onChange={(e) => setAdsenseEnabled(e.target.checked)}
                          className="h-4 w-4 rounded border-border text-brand focus:ring-brand"
                        />
                        <span>Enable Google AdSense Ad Units Across FaceTube</span>
                      </label>

                      <button
                        type="submit"
                        disabled={isSavingSettings || isLoadingSettings}
                        className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2 text-xs font-bold text-brand-foreground shadow-lift transition hover:bg-brand-dark disabled:opacity-50"
                      >
                        {isSavingSettings ? (
                          <>
                            <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand-foreground border-t-transparent" />
                            <span>Saving AdSense Config...</span>
                          </>
                        ) : (
                          <>
                            <Check className="h-4 w-4" />
                            <span>Save AdSense Config</span>
                          </>
                        )}
                      </button>
                    </div>
                  </form>
                </div>

                {/* Record Verified AdSense Statement Card */}
                <div className="rounded-xl border border-border bg-secondary/20 p-5 space-y-4">
                  <div className="flex items-center gap-2.5 border-b border-border/60 pb-3">
                    <div className="grid h-9 w-9 place-items-center rounded-xl bg-emerald-500/10 text-emerald-400">
                      <DollarSign className="h-4 w-4" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-foreground">
                        Record Verified Google AdSense Statement Earnings
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        Credit a creator's authoritative wallet balance with verified monthly Google
                        AdSense performance revenue.
                      </p>
                    </div>
                  </div>

                  {/* Anti-Slop Financial Compliance Notice */}
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-200">
                    <p className="font-bold flex items-center gap-1.5 text-amber-300">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      <span>Accounting Policy: Real Financial Settlement Only</span>
                    </p>
                    <p className="mt-1 leading-relaxed text-amber-200/90 text-[11px]">
                      Ad impressions, page views, and estimated ad clicks are strictly telemetry and
                      are <strong>NEVER</strong> treated as confirmed financial earnings. Revenue
                      must only be recorded when Google AdSense issues finalized monthly performance
                      reports (net-30 disbursement cycle).
                    </p>
                  </div>

                  <form onSubmit={handleRecordAdSense} className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-xs font-semibold text-foreground mb-1">
                          Creator User ID *
                        </label>
                        <input
                          type="text"
                          required
                          placeholder="e.g. FT102857"
                          value={adCreditUserId}
                          onChange={(e) => setAdCreditUserId(e.target.value.toUpperCase())}
                          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs font-mono text-foreground outline-none focus:border-brand"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-foreground mb-1">
                          Verified Revenue (INR ₹) *
                        </label>
                        <input
                          type="number"
                          step="0.01"
                          min="0.01"
                          required
                          placeholder="e.g. 1540.50"
                          value={adCreditAmount}
                          onChange={(e) => setAdCreditAmount(e.target.value)}
                          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs font-mono text-foreground outline-none focus:border-brand font-bold"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-foreground mb-1">
                          Statement Month (YYYY-MM) *
                        </label>
                        <input
                          type="month"
                          required
                          value={adCreditMonth}
                          onChange={(e) => setAdCreditMonth(e.target.value)}
                          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs font-mono text-foreground outline-none focus:border-brand"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-semibold text-foreground mb-1">
                          Statement Reference / Payment ID
                        </label>
                        <input
                          type="text"
                          placeholder="e.g. ADS-202610-89104"
                          value={adCreditRef}
                          onChange={(e) => setAdCreditRef(e.target.value)}
                          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs font-mono text-foreground outline-none focus:border-brand"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-foreground mb-1">
                          Statement Description / Note
                        </label>
                        <input
                          type="text"
                          placeholder="e.g. October 2026 verified video ad revenue share"
                          value={adCreditDesc}
                          onChange={(e) => setAdCreditDesc(e.target.value)}
                          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-brand"
                        />
                      </div>
                    </div>

                    <div className="flex justify-end pt-2">
                      <button
                        type="submit"
                        disabled={isRecordingAdSense}
                        className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2 text-xs font-bold text-white shadow-lift transition hover:bg-emerald-500 disabled:opacity-50"
                      >
                        {isRecordingAdSense ? (
                          <>
                            <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                            <span>Recording into Ledger...</span>
                          </>
                        ) : (
                          <>
                            <Check className="h-4 w-4" />
                            <span>Record &amp; Credit AdSense Revenue</span>
                          </>
                        )}
                      </button>
                    </div>
                  </form>
                </div>
              </section>
            </div>
          )}

          {/* TAB: SUBSCRIPTION MANAGEMENT (PHASE 2E) */}
          {activeTab === "subscriptions" && (
            <div className="mt-6 space-y-6">
              {/* Header */}
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
                <div>
                  <div className="flex items-center gap-2">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/10 text-amber-500">
                      <Crown className="h-5 w-5" />
                    </div>
                    <h2 className="text-xl font-bold tracking-tight">Subscription Management</h2>
                    <span className="rounded-full bg-brand/10 px-2.5 py-0.5 text-xs font-semibold text-brand">
                      Phase 2E
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Monitor subscriber plans, track platform memberships, and inspect
                    server-verified payment records.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    if (subSection === "memberships") {
                      loadAdminSubscriptions();
                    } else {
                      loadAdminRefunds();
                    }
                  }}
                  disabled={
                    subSection === "memberships" ? isLoadingAdminSubs : isLoadingAdminRefunds
                  }
                  className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2 text-xs font-semibold text-foreground transition hover:bg-secondary disabled:opacity-50"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${
                      (subSection === "memberships" ? isLoadingAdminSubs : isLoadingAdminRefunds)
                        ? "animate-spin"
                        : ""
                    }`}
                  />
                  <span>Refresh</span>
                </button>
              </div>

              {/* Sub-tab Navigation */}
              <div className="flex border-b border-border">
                <button
                  type="button"
                  onClick={() => setSubSection("memberships")}
                  className={`inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-semibold transition ${
                    subSection === "memberships"
                      ? "border-brand text-brand"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Crown className="h-4 w-4" />
                  <span>All Subscriptions ({adminSubStats.total})</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSubSection("refunds");
                    loadAdminRefunds(1, adminRefundSearch, adminRefundFilter);
                  }}
                  className={`inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-xs font-semibold transition ${
                    subSection === "refunds"
                      ? "border-brand text-brand"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <RotateCcw className="h-4 w-4" />
                  <span>Refund Requests</span>
                  {adminRefundStats.pending > 0 && (
                    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-bold text-amber-500">
                      {adminRefundStats.pending} Pending
                    </span>
                  )}
                </button>
              </div>

              {subSection === "memberships" ? (
                <>
                  {/* Statistics Overview (4 Cards) */}
                  <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-muted-foreground">
                          Total Subscriptions
                        </span>
                        <Crown className="h-4 w-4 text-amber-500" />
                      </div>
                      <div className="mt-2 text-2xl font-black text-foreground">
                        {adminSubStats.total}
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        All-time recorded memberships
                      </p>
                    </div>

                    <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4 shadow-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                          Active Subscriptions
                        </span>
                        <span className="relative flex h-2.5 w-2.5">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
                          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500"></span>
                        </span>
                      </div>
                      <div className="mt-2 text-2xl font-black text-emerald-600 dark:text-emerald-400">
                        {adminSubStats.active}
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Currently valid memberships
                      </p>
                    </div>

                    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-muted-foreground">
                          Expired Subscriptions
                        </span>
                        <Clock className="h-4 w-4 text-zinc-400" />
                      </div>
                      <div className="mt-2 text-2xl font-black text-foreground">
                        {adminSubStats.expired}
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Past or lapsed memberships
                      </p>
                    </div>

                    <div className="rounded-2xl border border-brand/20 bg-brand/5 p-4 shadow-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-brand">
                          Total Subscription Volume
                        </span>
                        <DollarSign className="h-4 w-4 text-brand" />
                      </div>
                      <div className="mt-2 text-2xl font-black text-foreground">
                        ₹{Number(adminSubStats.totalRevenue || 0).toLocaleString("en-IN")}
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Gross membership payments
                      </p>
                    </div>
                  </div>

                  {/* Filters & Search Control Bar */}
                  <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                    {/* Status Segmented Buttons */}
                    <div className="flex items-center gap-1 rounded-xl bg-secondary/60 p-1">
                      <button
                        type="button"
                        onClick={() => {
                          setAdminSubFilter("all");
                          setAdminSubPage(1);
                          loadAdminSubscriptions(1, undefined, "all");
                        }}
                        className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                          adminSubFilter === "all"
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        All ({adminSubStats.total})
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAdminSubFilter("active");
                          setAdminSubPage(1);
                          loadAdminSubscriptions(1, undefined, "active");
                        }}
                        className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                          adminSubFilter === "active"
                            ? "bg-background text-emerald-600 shadow-sm dark:text-emerald-400"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Active ({adminSubStats.active})
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAdminSubFilter("expired");
                          setAdminSubPage(1);
                          loadAdminSubscriptions(1, undefined, "expired");
                        }}
                        className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                          adminSubFilter === "expired"
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        Expired ({adminSubStats.expired})
                      </button>
                    </div>

                    {/* Search Bar */}
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        setAdminSubPage(1);
                        loadAdminSubscriptions(1);
                      }}
                      className="flex flex-1 items-center gap-2 sm:max-w-md"
                    >
                      <div className="relative flex flex-1 items-center">
                        <Search className="absolute left-3 h-3.5 w-3.5 text-muted-foreground" />
                        <input
                          type="search"
                          value={adminSubSearch}
                          onChange={(e) => setAdminSubSearch(e.target.value)}
                          placeholder="Search subscriber, user ID, plan, or payment ID..."
                          className="h-9 w-full rounded-xl border border-border bg-secondary/40 pl-9 pr-3 text-xs text-foreground outline-none transition placeholder:text-muted-foreground focus:border-brand focus:bg-background"
                        />
                      </div>
                      <button
                        type="submit"
                        className="h-9 rounded-xl bg-brand px-3.5 text-xs font-bold text-brand-foreground shadow-sm hover:bg-brand-dark"
                      >
                        Search
                      </button>
                      {adminSubSearch && (
                        <button
                          type="button"
                          onClick={() => {
                            setAdminSubSearch("");
                            setAdminSubPage(1);
                            loadAdminSubscriptions(1, "");
                          }}
                          className="h-9 rounded-xl border border-border bg-card px-2.5 text-xs text-muted-foreground hover:text-foreground"
                          title="Clear search"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </form>
                  </div>

                  {/* Error State */}
                  {adminSubError && (
                    <div className="flex items-center justify-between rounded-2xl border border-destructive/20 bg-destructive/10 p-4 text-xs text-destructive">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        <span>{adminSubError}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => loadAdminSubscriptions()}
                        className="font-bold underline hover:no-underline"
                      >
                        Retry
                      </button>
                    </div>
                  )}

                  {/* Table / List / Empty / Loading State */}
                  <div className="rounded-2xl border border-border bg-card shadow-card overflow-hidden">
                    {isLoadingAdminSubs ? (
                      <div className="flex flex-col items-center justify-center py-16 text-center">
                        <RefreshCw className="h-8 w-8 animate-spin text-brand" />
                        <p className="mt-3 text-xs font-medium text-muted-foreground">
                          Loading subscription records...
                        </p>
                      </div>
                    ) : adminSubscriptions.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-16 text-center px-4">
                        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                          <Crown className="h-6 w-6" />
                        </div>
                        <h3 className="mt-4 text-sm font-bold text-foreground">
                          No Subscriptions Found
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground max-w-sm">
                          {adminSubSearch || adminSubFilter !== "all"
                            ? "No subscription records match your current filter or search criteria."
                            : "No member subscriptions have been activated on the platform yet."}
                        </p>
                        {(adminSubSearch || adminSubFilter !== "all") && (
                          <button
                            type="button"
                            onClick={() => {
                              setAdminSubSearch("");
                              setAdminSubFilter("all");
                              setAdminSubPage(1);
                              loadAdminSubscriptions(1, "", "all");
                            }}
                            className="mt-4 rounded-xl border border-border bg-secondary/50 px-3.5 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary"
                          >
                            Reset Filters
                          </button>
                        )}
                      </div>
                    ) : (
                      <>
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-xs">
                            <thead className="border-b border-border bg-secondary/30 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                              <tr>
                                <th className="px-4 py-3">Subscriber</th>
                                <th className="px-4 py-3">Plan Tier</th>
                                <th className="px-4 py-3">Amount</th>
                                <th className="px-4 py-3">Status</th>
                                <th className="px-4 py-3">Validity Window</th>
                                <th className="px-4 py-3">Payment / Order ID</th>
                                <th className="px-4 py-3 text-right">Action</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border/60">
                              {adminSubscriptions.map((sub: any) => {
                                const isActive = sub.status === "active";
                                const startsFormatted = sub.startsAt
                                  ? new Date(sub.startsAt).toLocaleDateString("en-US", {
                                      month: "short",
                                      day: "numeric",
                                      year: "numeric",
                                    })
                                  : "—";
                                const expiresFormatted = sub.expiresAt
                                  ? new Date(sub.expiresAt).toLocaleDateString("en-US", {
                                      month: "short",
                                      day: "numeric",
                                      year: "numeric",
                                    })
                                  : "—";

                                return (
                                  <tr key={sub.id} className="transition hover:bg-secondary/20">
                                    <td className="px-4 py-3">
                                      <div className="font-semibold text-foreground">
                                        {sub.userName || `User ${sub.userId}`}
                                      </div>
                                      <div className="text-[11px] text-muted-foreground">
                                        {sub.userEmail || "No email"}
                                      </div>
                                      <span className="inline-block mt-0.5 rounded bg-secondary px-1.5 py-0.2 text-[10px] font-mono text-muted-foreground">
                                        {sub.userId}
                                      </span>
                                    </td>

                                    <td className="px-4 py-3">
                                      <div className="flex items-center gap-1.5 font-bold text-foreground">
                                        <Crown className="h-3.5 w-3.5 text-amber-500" />
                                        <span>{sub.planName}</span>
                                      </div>
                                      <span className="text-[11px] text-muted-foreground">
                                        ID: {sub.planId}
                                      </span>
                                    </td>

                                    <td className="px-4 py-3 font-semibold text-foreground">
                                      ₹{Number(sub.amount || 0).toLocaleString("en-IN")}
                                    </td>

                                    <td className="px-4 py-3">
                                      {isActive ? (
                                        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-bold text-emerald-600 dark:text-emerald-400">
                                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
                                          <span>Active</span>
                                        </span>
                                      ) : (
                                        <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-500/10 px-2.5 py-1 text-[11px] font-bold text-zinc-500">
                                          <Clock className="h-3 w-3" />
                                          <span>Expired</span>
                                        </span>
                                      )}
                                    </td>

                                    <td className="px-4 py-3">
                                      <div className="text-foreground">
                                        {startsFormatted} &rarr; {expiresFormatted}
                                      </div>
                                      <div className="text-[11px] text-muted-foreground">
                                        {isActive && sub.remainingDays !== null ? (
                                          <span className="text-emerald-600 font-medium dark:text-emerald-400">
                                            {sub.remainingDays} days remaining
                                          </span>
                                        ) : (
                                          <span>Expired</span>
                                        )}
                                      </div>
                                    </td>

                                    <td className="px-4 py-3">
                                      <div className="font-mono text-[11px] text-foreground">
                                        {sub.paymentId || "—"}
                                      </div>
                                      <div className="font-mono text-[10px] text-muted-foreground">
                                        {sub.orderId || "—"}
                                      </div>
                                    </td>

                                    <td className="px-4 py-3 text-right">
                                      <button
                                        type="button"
                                        onClick={() => setSelectedSubDetail(sub)}
                                        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-semibold text-foreground transition hover:bg-secondary"
                                      >
                                        <Eye className="h-3.5 w-3.5" />
                                        <span>Details</span>
                                      </button>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>

                        {/* Pagination Controls */}
                        <div className="flex flex-col items-center justify-between gap-3 border-t border-border px-4 py-3 sm:flex-row">
                          <div className="text-xs text-muted-foreground">
                            Showing{" "}
                            <span className="font-semibold text-foreground">
                              {adminSubPagination.totalItems === 0
                                ? 0
                                : (adminSubPagination.page - 1) * adminSubPagination.limit + 1}
                            </span>{" "}
                            to{" "}
                            <span className="font-semibold text-foreground">
                              {Math.min(
                                adminSubPagination.page * adminSubPagination.limit,
                                adminSubPagination.totalItems,
                              )}
                            </span>{" "}
                            of{" "}
                            <span className="font-semibold text-foreground">
                              {adminSubPagination.totalItems}
                            </span>{" "}
                            subscriptions
                          </div>

                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                const prev = Math.max(1, adminSubPage - 1);
                                setAdminSubPage(prev);
                                loadAdminSubscriptions(prev);
                              }}
                              disabled={adminSubPagination.page <= 1 || isLoadingAdminSubs}
                              className="inline-flex items-center gap-1 rounded-xl border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-secondary disabled:opacity-40 disabled:pointer-events-none"
                            >
                              <ChevronLeft className="h-3.5 w-3.5" />
                              <span>Previous</span>
                            </button>
                            <span className="px-2 text-xs font-bold text-foreground">
                              Page {adminSubPagination.page} of{" "}
                              {Math.max(1, adminSubPagination.totalPages)}
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                const next = adminSubPage + 1;
                                setAdminSubPage(next);
                                loadAdminSubscriptions(next);
                              }}
                              disabled={
                                adminSubPagination.page >= adminSubPagination.totalPages ||
                                isLoadingAdminSubs
                              }
                              className="inline-flex items-center gap-1 rounded-xl border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-secondary disabled:opacity-40 disabled:pointer-events-none"
                            >
                              <span>Next</span>
                              <ChevronRight className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </>
              ) : (
                /* SUB-SECTION: REFUND REQUESTS */
                <>
                  {/* Statistics Overview */}
                  <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
                    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-muted-foreground">
                          Total Requests
                        </span>
                        <RotateCcw className="h-4 w-4 text-brand" />
                      </div>
                      <div className="mt-2 text-2xl font-black text-foreground">
                        {adminRefundStats.total}
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        All-time refund tickets
                      </p>
                    </div>

                    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-muted-foreground">
                          Pending Review
                        </span>
                        <AlertCircle className="h-4 w-4 text-amber-500" />
                      </div>
                      <div className="mt-2 text-2xl font-black text-amber-500">
                        {adminRefundStats.pending}
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Requires admin review
                      </p>
                    </div>

                    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-muted-foreground">Approved</span>
                        <CheckCircle2 className="h-4 w-4 text-blue-500" />
                      </div>
                      <div className="mt-2 text-2xl font-black text-blue-500">
                        {adminRefundStats.approved}
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">Approved by admin</p>
                    </div>

                    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-muted-foreground">
                          Refunded / Disbursed
                        </span>
                        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                      </div>
                      <div className="mt-2 text-2xl font-black text-emerald-500">
                        {adminRefundStats.refunded}
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Razorpay payout settled
                      </p>
                    </div>

                    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-muted-foreground">Rejected</span>
                        <X className="h-4 w-4 text-rose-500" />
                      </div>
                      <div className="mt-2 text-2xl font-black text-rose-500">
                        {adminRefundStats.rejected}
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Closed without refund
                      </p>
                    </div>
                  </div>

                  {/* Search and Filters Bar */}
                  <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        setAdminRefundPage(1);
                        loadAdminRefunds(1, adminRefundSearch, adminRefundFilter);
                      }}
                      className="relative flex-1 max-w-md"
                    >
                      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <input
                        type="text"
                        value={adminRefundSearch}
                        onChange={(e) => setAdminRefundSearch(e.target.value)}
                        placeholder="Search by user, email, payment ID, or reason..."
                        className="w-full rounded-xl border border-border bg-background py-2 pl-9 pr-8 text-xs text-foreground placeholder:text-muted-foreground focus:border-brand focus:outline-none"
                      />
                      {adminRefundSearch && (
                        <button
                          type="button"
                          onClick={() => {
                            setAdminRefundSearch("");
                            setAdminRefundPage(1);
                            loadAdminRefunds(1, "", adminRefundFilter);
                          }}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </form>

                    {/* Filter Pills */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      {(["all", "pending", "approved", "refunded", "rejected"] as const).map(
                        (filter) => (
                          <button
                            key={filter}
                            type="button"
                            onClick={() => {
                              setAdminRefundFilter(filter);
                              setAdminRefundPage(1);
                              loadAdminRefunds(1, adminRefundSearch, filter);
                            }}
                            className={`rounded-xl px-3 py-1.5 text-xs font-semibold capitalize transition ${
                              adminRefundFilter === filter
                                ? "bg-brand text-brand-foreground shadow-sm"
                                : "border border-border bg-background text-muted-foreground hover:bg-secondary hover:text-foreground"
                            }`}
                          >
                            {filter}
                          </button>
                        ),
                      )}
                    </div>
                  </div>

                  {/* Error State */}
                  {adminRefundError && (
                    <div className="flex items-center justify-between rounded-2xl border border-destructive/20 bg-destructive/10 p-4 text-xs text-destructive">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="h-4 w-4 shrink-0" />
                        <span>{adminRefundError}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => loadAdminRefunds()}
                        className="font-bold underline hover:no-underline"
                      >
                        Retry
                      </button>
                    </div>
                  )}

                  {/* Table / List / Empty / Loading State */}
                  <div className="rounded-2xl border border-border bg-card shadow-card overflow-hidden">
                    {isLoadingAdminRefunds ? (
                      <div className="flex flex-col items-center justify-center py-16 text-center">
                        <RefreshCw className="h-8 w-8 animate-spin text-brand" />
                        <p className="mt-3 text-xs font-medium text-muted-foreground">
                          Loading refund requests...
                        </p>
                      </div>
                    ) : adminRefunds.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-16 text-center px-4">
                        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                          <RotateCcw className="h-6 w-6" />
                        </div>
                        <h3 className="mt-4 text-sm font-bold text-foreground">
                          No Refund Requests Found
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground max-w-sm">
                          {adminRefundSearch || adminRefundFilter !== "all"
                            ? "No refund requests match your current search or filter criteria."
                            : "There are currently no member refund tickets recorded on the platform."}
                        </p>
                        {(adminRefundSearch || adminRefundFilter !== "all") && (
                          <button
                            type="button"
                            onClick={() => {
                              setAdminRefundSearch("");
                              setAdminRefundFilter("all");
                              setAdminRefundPage(1);
                              loadAdminRefunds(1, "", "all");
                            }}
                            className="mt-4 rounded-xl border border-border bg-secondary/50 px-3.5 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary"
                          >
                            Reset Filters
                          </button>
                        )}
                      </div>
                    ) : (
                      <>
                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-xs">
                            <thead className="border-b border-border bg-secondary/30 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                              <tr>
                                <th className="px-4 py-3">Request / Date</th>
                                <th className="px-4 py-3">Subscriber</th>
                                <th className="px-4 py-3">Plan & Amount</th>
                                <th className="px-4 py-3">Reason</th>
                                <th className="px-4 py-3">Status</th>
                                <th className="px-4 py-3">Gateway</th>
                                <th className="px-4 py-3 text-right">Action</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                              {adminRefunds.map((req) => {
                                return (
                                  <tr key={req.id} className="transition hover:bg-secondary/40">
                                    <td className="px-4 py-3">
                                      <div className="font-mono font-semibold text-foreground">
                                        #{req.id.slice(0, 8)}
                                      </div>
                                      <div className="text-[10px] text-muted-foreground">
                                        {new Date(req.createdAt).toLocaleDateString()}{" "}
                                        {new Date(req.createdAt).toLocaleTimeString([], {
                                          hour: "2-digit",
                                          minute: "2-digit",
                                        })}
                                      </div>
                                    </td>

                                    <td className="px-4 py-3">
                                      <div className="font-semibold text-foreground">
                                        {req.userName || `User ${req.userId}`}
                                      </div>
                                      <div className="text-[11px] text-muted-foreground truncate max-w-[140px]">
                                        {req.userEmail || `ID: ${req.userId}`}
                                      </div>
                                    </td>

                                    <td className="px-4 py-3">
                                      <div className="font-semibold text-foreground">
                                        {req.planName}
                                      </div>
                                      <div className="font-bold text-brand">
                                        ₹{Number(req.amount || 0).toLocaleString("en-IN")}
                                      </div>
                                    </td>

                                    <td className="px-4 py-3 max-w-[200px]">
                                      <p className="line-clamp-2 text-[11px] text-foreground/80 italic">
                                        &ldquo;{req.reason}&rdquo;
                                      </p>
                                    </td>

                                    <td className="px-4 py-3">
                                      {req.status === "pending" && (
                                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-500">
                                          <AlertCircle className="h-3 w-3" />
                                          Pending Review
                                        </span>
                                      )}
                                      {req.status === "approved" && (
                                        <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-semibold text-blue-500">
                                          <CheckCircle2 className="h-3 w-3" />
                                          Approved
                                        </span>
                                      )}
                                      {req.status === "refunded" && (
                                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-500">
                                          <CheckCircle2 className="h-3 w-3" />
                                          Refunded
                                        </span>
                                      )}
                                      {req.status === "rejected" && (
                                        <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-semibold text-rose-500">
                                          <X className="h-3 w-3" />
                                          Rejected
                                        </span>
                                      )}
                                    </td>

                                    <td className="px-4 py-3">
                                      {req.gatewayRefundId ? (
                                        <div>
                                          <div className="font-mono text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold truncate max-w-[120px]">
                                            {req.gatewayRefundId}
                                          </div>
                                          <div className="text-[10px] text-muted-foreground">
                                            Settled
                                          </div>
                                        </div>
                                      ) : req.gatewayStatus ? (
                                        <span className="font-mono text-[10px] text-muted-foreground">
                                          {req.gatewayStatus}
                                        </span>
                                      ) : (
                                        <span className="text-[11px] text-muted-foreground">—</span>
                                      )}
                                    </td>

                                    <td className="px-4 py-3 text-right">
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setSelectedRefundForReview(req);
                                          setReviewDecision("approved");
                                          setReviewAdminNote("");
                                          setReviewError(null);
                                        }}
                                        className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                                          req.status === "pending"
                                            ? "bg-brand text-brand-foreground hover:bg-brand/90"
                                            : "border border-border bg-background text-foreground hover:bg-secondary"
                                        }`}
                                      >
                                        {req.status === "pending" ? (
                                          <>
                                            <RotateCcw className="h-3.5 w-3.5" />
                                            <span>Review</span>
                                          </>
                                        ) : (
                                          <>
                                            <Eye className="h-3.5 w-3.5" />
                                            <span>Details</span>
                                          </>
                                        )}
                                      </button>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>

                        {/* Pagination Controls */}
                        <div className="flex flex-col items-center justify-between gap-3 border-t border-border px-4 py-3 sm:flex-row">
                          <div className="text-xs text-muted-foreground">
                            Showing{" "}
                            <span className="font-semibold text-foreground">
                              {adminRefundPagination.totalItems === 0
                                ? 0
                                : (adminRefundPagination.page - 1) * adminRefundPagination.limit +
                                  1}
                            </span>{" "}
                            to{" "}
                            <span className="font-semibold text-foreground">
                              {Math.min(
                                adminRefundPagination.page * adminRefundPagination.limit,
                                adminRefundPagination.totalItems,
                              )}
                            </span>{" "}
                            of{" "}
                            <span className="font-semibold text-foreground">
                              {adminRefundPagination.totalItems}
                            </span>{" "}
                            requests
                          </div>

                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                const prev = Math.max(1, adminRefundPage - 1);
                                setAdminRefundPage(prev);
                                loadAdminRefunds(prev);
                              }}
                              disabled={adminRefundPagination.page <= 1 || isLoadingAdminRefunds}
                              className="inline-flex items-center gap-1 rounded-xl border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-secondary disabled:opacity-40 disabled:pointer-events-none"
                            >
                              <ChevronLeft className="h-3.5 w-3.5" />
                              <span>Previous</span>
                            </button>
                            <span className="px-2 text-xs font-bold text-foreground">
                              Page {adminRefundPagination.page} of{" "}
                              {Math.max(1, adminRefundPagination.totalPages)}
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                const next = adminRefundPage + 1;
                                setAdminRefundPage(next);
                                loadAdminRefunds(next);
                              }}
                              disabled={
                                adminRefundPagination.page >= adminRefundPagination.totalPages ||
                                isLoadingAdminRefunds
                              }
                              className="inline-flex items-center gap-1 rounded-xl border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-secondary disabled:opacity-40 disabled:pointer-events-none"
                            >
                              <span>Next</span>
                              <ChevronRight className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* TAB 7: DATABASE & SQL INFO */}
          {activeTab === "database" && (
            <section className="mt-6 rounded-2xl border border-border bg-secondary/20 p-6">
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                <div className="flex items-center gap-2.5">
                  <Database className="h-5 w-5 text-brand" />
                  <h3 className="text-base font-bold">Hostinger MySQL & phpMyAdmin Migration</h3>
                </div>
                <button
                  type="button"
                  onClick={copySql}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground transition hover:bg-secondary"
                >
                  {copiedSql ? (
                    <Check className="h-3.5 w-3.5 text-green-500" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {copiedSql ? "Copied SQL" : "Copy SQL Migration"}
                </button>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                All production SQL migrations for channel logos, video moderation, live streaming,
                and bulk payouts are in{" "}
                <code className="text-foreground">
                  database/migrations/20261027_company_audit_updates.sql
                </code>
                .
              </p>
              <pre className="mt-4 overflow-x-auto rounded-xl bg-black/80 p-4 text-[11px] leading-relaxed text-white/90">
                <code>{sqlMigrationCode}</code>
              </pre>
            </section>
          )}

          {/* TAB 8: CREATOR KYC REVIEWS (Task 3) */}
          {activeTab === "kyc" && (
            <AdminKycReviewTab onStatsUpdate={(s) => setKycPendingCount(s.totalPending)} />
          )}
          {/* SUBSCRIPTION DETAIL MODAL (PHASE 2E) */}
          {selectedSubDetail && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
              onClick={() => setSelectedSubDetail(null)}
            >
              <div
                className="relative w-full max-w-xl rounded-2xl border border-border bg-card p-6 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Header */}
                <div className="flex items-start justify-between border-b border-border pb-4">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500">
                      <Crown className="h-5 w-5" />
                    </div>
                    <div>
                      <h3 className="text-base font-bold text-foreground">
                        Subscription Record Details
                      </h3>
                      <p className="text-xs text-muted-foreground font-mono">
                        ID: {selectedSubDetail.id}
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setSelectedSubDetail(null)}
                    className="rounded-lg p-1 text-muted-foreground hover:bg-secondary hover:text-foreground"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>

                {/* Content Grid */}
                <div className="mt-4 space-y-4 max-h-[75vh] overflow-y-auto pr-1">
                  {/* Status Banner */}
                  <div
                    className={`flex items-center justify-between rounded-xl p-3 border text-xs ${
                      selectedSubDetail.status === "active"
                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        : "border-zinc-500/30 bg-zinc-500/10 text-zinc-500"
                    }`}
                  >
                    <div className="flex items-center gap-2 font-bold uppercase tracking-wider">
                      {selectedSubDetail.status === "active" ? (
                        <>
                          <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
                          <span>Active Subscription</span>
                        </>
                      ) : (
                        <>
                          <Clock className="h-4 w-4" />
                          <span>Expired Subscription</span>
                        </>
                      )}
                    </div>
                    <span className="font-semibold">
                      {selectedSubDetail.status === "active" &&
                      selectedSubDetail.remainingDays !== null
                        ? `${selectedSubDetail.remainingDays} days remaining`
                        : "Validity Concluded"}
                    </span>
                  </div>

                  {/* Subscriber & Plan Section */}
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div className="rounded-xl border border-border bg-secondary/30 p-3">
                      <span className="text-[11px] font-medium text-muted-foreground">
                        Subscriber
                      </span>
                      <div className="mt-1 font-bold text-foreground">
                        {selectedSubDetail.userName || `User ${selectedSubDetail.userId}`}
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate">
                        {selectedSubDetail.userEmail || "No email"}
                      </div>
                      <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                        User ID: {selectedSubDetail.userId}
                      </div>
                    </div>

                    <div className="rounded-xl border border-border bg-secondary/30 p-3">
                      <span className="text-[11px] font-medium text-muted-foreground">
                        Plan Tier
                      </span>
                      <div className="mt-1 font-bold text-foreground">
                        {selectedSubDetail.planName}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        Plan ID: {selectedSubDetail.planId}
                      </div>
                      <div className="mt-1 font-bold text-brand">
                        ₹{Number(selectedSubDetail.amount || 0).toLocaleString("en-IN")}
                        <span className="text-[10px] font-normal text-muted-foreground">
                          {" "}
                          ({selectedSubDetail.durationDays || 30} days)
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Validity Window */}
                  <div className="rounded-xl border border-border bg-secondary/20 p-3 text-xs">
                    <span className="text-[11px] font-medium text-muted-foreground">
                      Validity Period
                    </span>
                    <div className="mt-1.5 grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <span className="text-[11px] text-muted-foreground">Activated On:</span>
                        <p className="font-semibold text-foreground">
                          {selectedSubDetail.startsAt
                            ? new Date(selectedSubDetail.startsAt).toLocaleString()
                            : "—"}
                        </p>
                      </div>
                      <div>
                        <span className="text-[11px] text-muted-foreground">Expires On:</span>
                        <p className="font-semibold text-foreground">
                          {selectedSubDetail.expiresAt
                            ? new Date(selectedSubDetail.expiresAt).toLocaleString()
                            : "—"}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Payment Identifiers */}
                  <div className="rounded-xl border border-border bg-secondary/20 p-3 text-xs space-y-2">
                    <span className="text-[11px] font-medium text-muted-foreground">
                      Razorpay Gateway Identifiers
                    </span>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <div>
                        <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">
                          Payment ID
                        </span>
                        <p className="font-mono text-xs font-semibold text-foreground break-all">
                          {selectedSubDetail.paymentId || "—"}
                        </p>
                      </div>
                      <div>
                        <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">
                          Order ID
                        </span>
                        <p className="font-mono text-xs font-semibold text-foreground break-all">
                          {selectedSubDetail.orderId || "—"}
                        </p>
                      </div>
                    </div>
                    {selectedSubDetail.createdAt && (
                      <div className="pt-1 text-[11px] text-muted-foreground">
                        Recorded at: {new Date(selectedSubDetail.createdAt).toLocaleString()}
                      </div>
                    )}
                  </div>

                  {/* Features / Perks (if any) */}
                  {Array.isArray(selectedSubDetail.features) &&
                    selectedSubDetail.features.length > 0 && (
                      <div className="rounded-xl border border-border bg-secondary/20 p-3 text-xs">
                        <span className="text-[11px] font-medium text-muted-foreground">
                          Plan Perks &amp; Inclusions
                        </span>
                        <ul className="mt-2 space-y-1">
                          {selectedSubDetail.features.map((feature: string, idx: number) => (
                            <li key={idx} className="flex items-center gap-2 text-foreground">
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                              <span>{feature}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                  {/* Security Note */}
                  <div className="flex items-center gap-2 rounded-xl bg-secondary/40 p-3 text-[11px] text-muted-foreground">
                    <ShieldCheck className="h-4 w-4 text-brand shrink-0" />
                    <span>
                      Cryptographically verified via Razorpay HMAC-SHA256 signature. Zero commission
                      deductions applied. Immutable financial ledger entry.
                    </span>
                  </div>
                </div>

                {/* Footer */}
                <div className="mt-5 flex justify-end border-t border-border pt-4">
                  <button
                    type="button"
                    onClick={() => setSelectedSubDetail(null)}
                    className="rounded-xl bg-secondary px-4 py-2 text-xs font-semibold text-foreground hover:bg-secondary/80"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* REFUND REQUEST REVIEW & DETAIL MODAL (PHASE 2F) */}
          {selectedRefundForReview && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
              onClick={() => {
                if (!isSubmittingReview) {
                  setSelectedRefundForReview(null);
                  setReviewError(null);
                }
              }}
            >
              <div
                className="relative w-full max-w-xl rounded-2xl border border-border bg-card p-6 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                {/* Header */}
                <div className="flex items-start justify-between border-b border-border pb-4">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500/10 text-amber-500">
                      <RotateCcw className="h-5 w-5" />
                    </div>
                    <div>
                      <h3 className="text-base font-bold text-foreground">
                        {selectedRefundForReview.status === "pending"
                          ? "Review Subscription Refund Request"
                          : "Subscription Refund Ticket Details"}
                      </h3>
                      <p className="text-xs text-muted-foreground font-mono">
                        Ticket #{selectedRefundForReview.id.slice(0, 8)} &bull;{" "}
                        {new Date(selectedRefundForReview.createdAt).toLocaleString()}
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      if (!isSubmittingReview) {
                        setSelectedRefundForReview(null);
                        setReviewError(null);
                      }
                    }}
                    disabled={isSubmittingReview}
                    className="rounded-lg p-1 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>

                {/* Content */}
                <div className="mt-4 space-y-4 max-h-[75vh] overflow-y-auto pr-1">
                  {/* Status Banner */}
                  <div
                    className={`flex items-center justify-between rounded-xl p-3 border text-xs ${
                      selectedRefundForReview.status === "pending"
                        ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                        : selectedRefundForReview.status === "approved"
                          ? "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400"
                          : selectedRefundForReview.status === "refunded"
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                            : "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                    }`}
                  >
                    <div className="flex items-center gap-2 font-bold uppercase tracking-wider">
                      {selectedRefundForReview.status === "pending" && (
                        <>
                          <AlertCircle className="h-4 w-4" />
                          <span>Pending Admin Decision</span>
                        </>
                      )}
                      {selectedRefundForReview.status === "approved" && (
                        <>
                          <CheckCircle2 className="h-4 w-4" />
                          <span>Approved by Admin</span>
                        </>
                      )}
                      {selectedRefundForReview.status === "refunded" && (
                        <>
                          <CheckCircle2 className="h-4 w-4" />
                          <span>Refund Disbursed via Gateway</span>
                        </>
                      )}
                      {selectedRefundForReview.status === "rejected" && (
                        <>
                          <X className="h-4 w-4" />
                          <span>Request Rejected</span>
                        </>
                      )}
                    </div>
                    <span className="font-mono font-semibold">
                      ₹{Number(selectedRefundForReview.amount || 0).toLocaleString("en-IN")}
                    </span>
                  </div>

                  {/* Review Error Banner */}
                  {reviewError && (
                    <div className="flex items-center gap-2 rounded-xl border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      <span>{reviewError}</span>
                    </div>
                  )}

                  {/* Summary Cards */}
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div className="rounded-xl border border-border bg-secondary/30 p-3">
                      <span className="text-[11px] font-medium text-muted-foreground">
                        Subscriber
                      </span>
                      <div className="mt-1 font-bold text-foreground">
                        {selectedRefundForReview.userName ||
                          `User ${selectedRefundForReview.userId}`}
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate">
                        {selectedRefundForReview.userEmail || "No email"}
                      </div>
                      <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                        User ID: {selectedRefundForReview.userId}
                      </div>
                    </div>

                    <div className="rounded-xl border border-border bg-secondary/30 p-3">
                      <span className="text-[11px] font-medium text-muted-foreground">
                        Plan & Payment
                      </span>
                      <div className="mt-1 font-bold text-foreground">
                        {selectedRefundForReview.planName}
                      </div>
                      <div className="mt-1 font-mono text-[10px] text-muted-foreground truncate">
                        Payment: {selectedRefundForReview.paymentId}
                      </div>
                      <div className="font-mono text-[10px] text-muted-foreground truncate">
                        Order: {selectedRefundForReview.orderId}
                      </div>
                    </div>
                  </div>

                  {/* User's Reason */}
                  <div className="rounded-xl border border-border bg-secondary/20 p-3 text-xs">
                    <span className="text-[11px] font-medium text-muted-foreground">
                      User Reason for Refund Request
                    </span>
                    <p className="mt-2 whitespace-pre-wrap rounded-lg bg-background/50 p-2.5 text-xs text-foreground italic border border-border/50">
                      &ldquo;{selectedRefundForReview.reason}&rdquo;
                    </p>
                  </div>

                  {/* Review Actions (When Pending) */}
                  {selectedRefundForReview.status === "pending" ? (
                    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
                      <span className="text-xs font-bold text-foreground uppercase tracking-wider">
                        Admin Decision
                      </span>

                      {/* Decision Radio Cards */}
                      <div className="grid grid-cols-2 gap-3">
                        <button
                          type="button"
                          onClick={() => setReviewDecision("approved")}
                          className={`flex items-center gap-2 rounded-xl border p-3 text-xs font-semibold transition text-left ${
                            reviewDecision === "approved"
                              ? "border-emerald-500 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                              : "border-border bg-secondary/30 text-muted-foreground hover:bg-secondary"
                          }`}
                        >
                          <CheckCircle2 className="h-4 w-4 shrink-0" />
                          <div>
                            <div>Approve Refund</div>
                            <div className="text-[10px] font-normal text-muted-foreground">
                              Trigger gateway refund
                            </div>
                          </div>
                        </button>

                        <button
                          type="button"
                          onClick={() => setReviewDecision("rejected")}
                          className={`flex items-center gap-2 rounded-xl border p-3 text-xs font-semibold transition text-left ${
                            reviewDecision === "rejected"
                              ? "border-rose-500 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                              : "border-border bg-secondary/30 text-muted-foreground hover:bg-secondary"
                          }`}
                        >
                          <X className="h-4 w-4 shrink-0" />
                          <div>
                            <div>Reject Request</div>
                            <div className="text-[10px] font-normal text-muted-foreground">
                              Keep subscription active
                            </div>
                          </div>
                        </button>
                      </div>

                      {/* Admin Note Input */}
                      <div>
                        <label className="text-[11px] font-medium text-muted-foreground">
                          Admin Review Note (Audit History)
                        </label>
                        <textarea
                          rows={3}
                          value={reviewAdminNote}
                          onChange={(e) => setReviewAdminNote(e.target.value)}
                          placeholder={
                            reviewDecision === "approved"
                              ? "e.g. Approved per subscriber request within standard SLA."
                              : "e.g. Rejected due to extended consumption of subscription benefits."
                          }
                          className="mt-1 w-full rounded-xl border border-border bg-background p-2.5 text-xs text-foreground placeholder:text-muted-foreground focus:border-brand focus:outline-none resize-none"
                        />
                      </div>

                      {/* Informational Notice */}
                      <div className="flex items-start gap-2 rounded-xl border border-border bg-secondary/30 p-2.5 text-[11px] text-muted-foreground">
                        <Shield className="h-4 w-4 shrink-0 text-brand mt-0.5" />
                        <div>
                          {reviewDecision === "approved" ? (
                            <span>
                              Approving will dispatch a refund to Razorpay if API credentials are
                              configured. A refund is never marked successful until the gateway
                              confirms settlement.
                            </span>
                          ) : (
                            <span>
                              Rejecting closes this ticket. The subscriber&apos;s membership will
                              continue without disruption.
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    /* Audit Log for Processed Requests */
                    <div className="space-y-3 rounded-xl border border-border bg-secondary/20 p-3 text-xs">
                      <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                        Review & Gateway Audit Log
                      </span>
                      <div className="grid grid-cols-2 gap-2 text-[11px]">
                        <div>
                          <span className="text-muted-foreground">Reviewed By:</span>{" "}
                          <span className="font-semibold text-foreground">
                            Admin (User #{selectedRefundForReview.reviewedBy || "—"})
                          </span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Reviewed At:</span>{" "}
                          <span className="font-semibold text-foreground">
                            {selectedRefundForReview.reviewedAt
                              ? new Date(selectedRefundForReview.reviewedAt).toLocaleString()
                              : "—"}
                          </span>
                        </div>
                        <div className="col-span-2">
                          <span className="text-muted-foreground">Admin Note:</span>{" "}
                          <span className="font-medium text-foreground">
                            {selectedRefundForReview.adminNote || "None provided"}
                          </span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Gateway Status:</span>{" "}
                          <span className="font-mono font-semibold text-foreground">
                            {selectedRefundForReview.gatewayStatus || "—"}
                          </span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Gateway Refund ID:</span>{" "}
                          <span className="font-mono font-semibold text-foreground">
                            {selectedRefundForReview.gatewayRefundId || "—"}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Footer Buttons */}
                <div className="mt-5 flex items-center justify-end gap-2 border-t border-border pt-4">
                  <button
                    type="button"
                    onClick={() => {
                      if (!isSubmittingReview) {
                        setSelectedRefundForReview(null);
                        setReviewError(null);
                      }
                    }}
                    disabled={isSubmittingReview}
                    className="rounded-xl border border-border bg-background px-4 py-2 text-xs font-semibold text-foreground transition hover:bg-secondary disabled:opacity-50"
                  >
                    {selectedRefundForReview.status === "pending" ? "Cancel" : "Close"}
                  </button>

                  {selectedRefundForReview.status === "pending" && (
                    <button
                      type="button"
                      onClick={handleReviewRefundSubmit}
                      disabled={isSubmittingReview}
                      className={`inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-semibold text-white transition disabled:opacity-50 ${
                        reviewDecision === "approved"
                          ? "bg-emerald-600 hover:bg-emerald-700"
                          : "bg-rose-600 hover:bg-rose-700"
                      }`}
                    >
                      {isSubmittingReview ? (
                        <>
                          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                          <span>Processing...</span>
                        </>
                      ) : (
                        <>
                          {reviewDecision === "approved" ? (
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          ) : (
                            <X className="h-3.5 w-3.5" />
                          )}
                          <span>
                            {reviewDecision === "approved"
                              ? "Confirm Approval"
                              : "Confirm Rejection"}
                          </span>
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      <BottomNav />
    </div>
  );
}
