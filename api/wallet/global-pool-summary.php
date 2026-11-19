<?php
/**
 * FaceTube - Global Income Pool Summary API
 * GET /api/wallet/global-pool-summary.php
 *
 * Read-only authoritative summary of eligible videos for the ₹3.00 Global Income Pool.
 * Uses identical video eligibility predicates as api/payments/verify.php:
 * - premium or paid videos: (video_type = 'premium' OR payment_status = 'paid')
 * - exclude blocked videos: (is_blocked = 0 OR is_blocked IS NULL)
 * - reports platform-wide aggregate counts (including the authenticated user's own eligible videos)
 *   separately from the authenticated user's own eligible-video counts and ad earnings
 * - never exposes other creators' individual videos or earnings
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$pdo = getDatabaseConnection();

$requestedUserId = trim(
    $_GET['userId'] ??
    ($_GET['user_id'] ?? ($_GET['excludeUserId'] ?? ($_GET['exclude_user_id'] ?? '')))
);

// Enforce same session authentication policy as all other /api/wallet/* endpoints
list($authUser, $effectiveUserId) = requireAuthUser($pdo, $requestedUserId ?: null);
$normalizedUserId = strtoupper(trim((string)$effectiveUserId));

$hasAdEarningsCol = false;
$hasIsBlockedCol = false;
try {
    $colStmt = $pdo->query("
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'uploaded_videos'
          AND COLUMN_NAME IN ('ad_earnings', 'is_blocked')
    ");
    if ($colStmt) {
        foreach ($colStmt->fetchAll(PDO::FETCH_COLUMN) as $colName) {
            $normalizedCol = strtolower((string)$colName);
            if ($normalizedCol === 'ad_earnings') {
                $hasAdEarningsCol = true;
            } elseif ($normalizedCol === 'is_blocked') {
                $hasIsBlockedCol = true;
            }
        }
    }
} catch (Exception $eColCheck) {
    // Keep safe defaults if INFORMATION_SCHEMA probe fails
}

try {
    $whereClauses = ["(video_type = 'premium' OR payment_status = 'paid')"];

    if ($hasIsBlockedCol) {
        $whereClauses[] = '(is_blocked = 0 OR is_blocked IS NULL)';
    }

    $whereSql = implode(' AND ', $whereClauses);
    $adEarningsExpr = $hasAdEarningsCol
        ? 'GREATEST(0, COALESCE(ad_earnings, 0))'
        : '0';

    $sql = "
        SELECT
            COUNT(*) AS eligible_video_count,
            COUNT(DISTINCT UPPER(TRIM(user_id))) AS distinct_creator_count,
            COALESCE(SUM({$adEarningsExpr}), 0) AS total_ad_earnings,
            COALESCE(SUM(CASE WHEN UPPER(user_id) = UPPER(?) THEN 1 ELSE 0 END), 0) AS user_eligible_video_count,
            COALESCE(SUM(CASE WHEN UPPER(user_id) = UPPER(?) THEN {$adEarningsExpr} ELSE 0 END), 0) AS user_total_ad_earnings
        FROM uploaded_videos
        WHERE {$whereSql}
    ";

    $stmt = $pdo->prepare($sql);
    $stmt->execute([$normalizedUserId, $normalizedUserId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: [];

    $platformEligibleVideoCount = max(0, intval($row['eligible_video_count'] ?? 0));
    $platformDistinctCreatorCount = max(0, intval($row['distinct_creator_count'] ?? 0));
    $platformTotalAdEarnings = round(floatval($row['total_ad_earnings'] ?? 0), 2);
    $userEligibleVideoCount = max(0, intval($row['user_eligible_video_count'] ?? 0));
    $userTotalAdEarnings = round(floatval($row['user_total_ad_earnings'] ?? 0), 2);

    $poolPaise = 300;
    $weightingMode = $platformTotalAdEarnings > 0 ? 'ad_earnings_weighted' : 'equal_fallback';
    $estimatedEqualSharePerVideo = $weightingMode === 'equal_fallback'
        ? ($platformEligibleVideoCount > 0 ? intdiv($poolPaise, $platformEligibleVideoCount) / 100 : 0.0)
        : null;

    jsonResponse([
        'success' => true,
        'userId' => $normalizedUserId !== '' ? $normalizedUserId : null,
        'excludedUserId' => null,
        'poolAmount' => 3.0,
        'poolPaise' => $poolPaise,
        'eligibleVideoCount' => $platformEligibleVideoCount,
        'platformEligibleVideoCount' => $platformEligibleVideoCount,
        'distinctCreatorCount' => $platformDistinctCreatorCount,
        'platformDistinctCreatorCount' => $platformDistinctCreatorCount,
        'totalAdEarnings' => $platformTotalAdEarnings,
        'platformTotalAdEarnings' => $platformTotalAdEarnings,
        'userEligibleVideoCount' => $userEligibleVideoCount,
        'userTotalAdEarnings' => $userTotalAdEarnings,
        'estimatedEqualSharePerVideo' => $estimatedEqualSharePerVideo,
        'weightingMode' => $weightingMode,
    ]);
} catch (PDOException $e) {
    error_log('[global-pool-summary.php] Database error: ' . $e->getMessage());
    jsonResponse(['success' => false, 'error' => 'Database error loading global pool summary.'], 500);
}
