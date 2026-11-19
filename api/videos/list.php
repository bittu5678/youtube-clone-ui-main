<?php
/**
 * FaceTube - List Videos API
 * GET /api/videos/list.php
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

$pdo = getDatabaseConnection();
$authUser = getAuthUser($pdo);
$isAdmin = $authUser && isset($authUser['role']) && strtolower((string)$authUser['role']) === 'admin';
$authUserId = $authUser ? trim((string)$authUser['user_id']) : '';

$userId = trim((string)($_GET['userId'] ?? ($_GET['user_id'] ?? '')));
$videoType = trim((string)($_GET['videoType'] ?? ($_GET['video_type'] ?? '')));
$contentType = trim((string)($_GET['contentType'] ?? ($_GET['content_type'] ?? '')));
$category = trim((string)($_GET['category'] ?? ''));
$search = trim((string)($_GET['search'] ?? ($_GET['q'] ?? '')));
$limit = max(1, min(100, intval($_GET['limit'] ?? 50)));
$offset = max(0, intval($_GET['offset'] ?? 0));

$includeBlockedRequested = !empty($_GET['include_blocked']) || !empty($_GET['includeBlocked']);
$includeNonPublicRequested = !empty($_GET['include_non_public']) || !empty($_GET['includeNonPublic']) || !empty($_GET['include_private']) || !empty($_GET['includePrivate']);

$isOwnerRequest = $authUser && $userId !== '' && strcasecmp($authUserId, $userId) === 0;
$canViewOwnerNonPublic = ($userId !== '' && ($isOwnerRequest || $isAdmin))
    || ($userId === '' && $isAdmin && ($includeBlockedRequested || $includeNonPublicRequested));

$hasVisibilityCol = hasUploadedVideosVisibilityColumn($pdo);

$where = [];
$params = [];

if (!($includeBlockedRequested && $isAdmin)) {
    $where[] = 'COALESCE(is_blocked, 0) = 0';
}

if ($userId !== '') {
    $where[] = 'UPPER(user_id) = UPPER(?)';
    $params[] = $userId;
}

if (!$canViewOwnerNonPublic) {
    if ($hasVisibilityCol) {
        $where[] = "COALESCE(visibility, 'public') = 'public'";
    }
    // Prevent unpaid/pending/failed premium videos from leaking into public feeds
    $where[] = "(video_type != 'premium' OR payment_status IN ('paid', 'not_required'))";
}

if (!empty($videoType) && in_array($videoType, ['free', 'premium'], true)) {
    $where[] = 'video_type = ?';
    $params[] = $videoType;
}

if (!empty($contentType) && in_array($contentType, ['short', 'long'], true)) {
    $where[] = 'content_type = ?';
    $params[] = $contentType;
}

if (!empty($category) && strcasecmp($category, 'All') !== 0) {
    $where[] = 'LOWER(category) = LOWER(?)';
    $params[] = $category;
}

if (!empty($search)) {
    $where[] = '(title LIKE ? OR description LIKE ? OR creator_name LIKE ?)';
    $like = "%{$search}%";
    $params[] = $like;
    $params[] = $like;
    $params[] = $like;
}

$whereSql = !empty($where) ? 'WHERE ' . implode(' AND ', $where) : '';
$visibilitySelect = $hasVisibilityCol ? "COALESCE(visibility, 'public') AS visibility" : "'public' AS visibility";

try {
    $sql = "
        SELECT 
            id, user_id, creator_name, title, description, video_url, thumbnail_url,
            video_type, content_type, category, duration, views, likes,
            payment_status, payment_id, payment_amount, is_promoted, {$visibilitySelect},
            promotion_plan, promotion_expires_at, created_at, updated_at,
            (is_promoted = 1 AND promotion_expires_at IS NOT NULL AND promotion_expires_at > NOW()) AS is_active_promoted
        FROM uploaded_videos
        {$whereSql}
        ORDER BY is_active_promoted DESC, created_at DESC
        LIMIT {$limit} OFFSET {$offset}
    ";

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll();

    $videos = array_map(function ($row) use ($authUserId, $isAdmin) {
        $expiryTime = !empty($row['promotion_expires_at']) ? strtotime($row['promotion_expires_at']) : false;
        $isActivePromoted = !empty($row['is_promoted']) && $expiryTime !== false && $expiryTime > time();
        $visibility = normalizeVideoVisibility($row['visibility'] ?? null, 'public') ?? 'public';
        $isOwner = $authUserId !== '' && strcasecmp((string)$row['user_id'], $authUserId) === 0;
        $canAccessPrivate = ($isOwner || $isAdmin);

        $videoUrl = resolveVideoMediaOutputUrl($row['video_url'] ?? '', (string)$row['id'], $visibility, 'video', $canAccessPrivate);
        $thumbUrl = resolveVideoMediaOutputUrl($row['thumbnail_url'] ?? '', (string)$row['id'], $visibility, 'thumbnail', $canAccessPrivate);

        return [
            'id' => $row['id'],
            'userId' => $row['user_id'],
            'user_id' => $row['user_id'],
            'creatorName' => $row['creator_name'],
            'creator_name' => $row['creator_name'],
            'title' => $row['title'],
            'description' => $row['description'] ?? '',
            'videoUrl' => $videoUrl,
            'video_url' => $videoUrl,
            'thumbnailUrl' => $thumbUrl,
            'thumbnail_url' => $thumbUrl,
            'videoType' => $row['video_type'],
            'video_type' => $row['video_type'],
            'contentType' => $row['content_type'],
            'content_type' => $row['content_type'],
            'category' => $row['category'] ?? 'General',
            'duration' => $row['duration'] ?? '0:00',
            'views' => (int)$row['views'],
            'likes' => (int)$row['likes'],
            'paymentStatus' => $row['payment_status'],
            'payment_status' => $row['payment_status'],
            'paymentId' => $row['payment_id'],
            'payment_id' => $row['payment_id'],
            'paymentAmount' => (float)$row['payment_amount'],
            'payment_amount' => (float)$row['payment_amount'],
            'isPromoted' => (bool)$isActivePromoted,
            'is_promoted' => (bool)$isActivePromoted,
            'isActivePromoted' => (bool)$isActivePromoted,
            'is_active_promoted' => (bool)$isActivePromoted,
            'rawIsPromoted' => (bool)$row['is_promoted'],
            'raw_is_promoted' => (bool)$row['is_promoted'],
            'visibility' => $visibility,
            'promotionPlan' => $row['promotion_plan'],
            'promotionExpiresAt' => $row['promotion_expires_at'],
            'createdAt' => $row['created_at'],
            'created_at' => $row['created_at'],
            'updatedAt' => $row['updated_at'],
            'updated_at' => $row['updated_at'],
        ];
    }, $rows);

    jsonResponse(['success' => true, 'videos' => $videos, 'total' => count($videos)]);
} catch (PDOException $e) {
    jsonResponse(['success' => false, 'error' => 'Database error: ' . $e->getMessage()], 500);
}
