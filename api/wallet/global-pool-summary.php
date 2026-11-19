<?php
/**
 * FaceTube - Global Income Pool Summary API
 * GET /api/wallet/global-pool-summary.php
 *
 * Read-only authoritative summary of eligible videos for the ₹3.00 Global Income Pool.
 * Uses identical eligibility rules as api/payments/verify.php:
 * - premium or paid videos: (video_type = 'premium' OR payment_status = 'paid')
 * - exclude blocked videos: (is_blocked = 0 OR is_blocked IS NULL)
 * - exclude the current uploader/viewer when excludeUserId/userId is specified
 * - counts eligible video rows independently (not distinct creators)
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$pdo = getDatabaseConnection();

$requestedExcludeId = trim(
    $_GET['excludeUserId'] ??
    ($_GET['exclude_user_id'] ?? ($_GET['userId'] ?? ($_GET['user_id'] ?? '')))
);

// Enforce same session authentication policy as all other /api/wallet/* endpoints
list($authUser, $excludeUserId) = requireAuthUser($pdo, $requestedExcludeId ?: null);

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
    $params = [];

    if ($hasIsBlockedCol) {
        $whereClauses[] = '(is_blocked = 0 OR is_blocked IS NULL)';
    }

    if ($excludeUserId !== '') {
        $whereClauses[] = 'UPPER(user_id) != UPPER(?)';
        $params[] = $excludeUserId;
    }

    $whereSql = implode(' AND ', $whereClauses);
    $adEarningsSumExpr = $hasAdEarningsCol
        ? 'COALESCE(SUM(GREATEST(0, COALESCE(ad_earnings, 0))), 0)'
        : '0';

    $sql = "
        SELECT
            COUNT(*) AS eligible_video_count,
            COUNT(DISTINCT UPPER(TRIM(user_id))) AS distinct_creator_count,
            {$adEarningsSumExpr} AS total_ad_earnings
        FROM uploaded_videos
        WHERE {$whereSql}
    ";

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: [];

    $eligibleVideoCount = max(0, intval($row['eligible_video_count'] ?? 0));
    $distinctCreatorCount = max(0, intval($row['distinct_creator_count'] ?? 0));
    $totalAdEarnings = round(floatval($row['total_ad_earnings'] ?? 0), 2);
    $poolPaise = 300;
    $estimatedEqualSharePerVideo = $eligibleVideoCount > 0
        ? intdiv($poolPaise, $eligibleVideoCount) / 100
        : 0.0;

    jsonResponse([
        'success' => true,
        'excludedUserId' => $excludeUserId !== '' ? strtoupper($excludeUserId) : null,
        'poolAmount' => 3.0,
        'poolPaise' => $poolPaise,
        'eligibleVideoCount' => $eligibleVideoCount,
        'distinctCreatorCount' => $distinctCreatorCount,
        'estimatedEqualSharePerVideo' => $estimatedEqualSharePerVideo,
        'totalAdEarnings' => $totalAdEarnings,
        'weightingMode' => $totalAdEarnings > 0 ? 'ad_earnings_weighted' : 'equal_fallback',
    ]);
} catch (PDOException $e) {
    error_log('[global-pool-summary.php] Database error: ' . $e->getMessage());
    jsonResponse(['success' => false, 'error' => 'Database error loading global pool summary.'], 500);
}
