<?php
/**
 * FaceTube - Get Single Video API
 * GET /api/videos/get.php
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

$id = trim((string)($_GET['id'] ?? ''));

if (empty($id)) {
    jsonResponse(['success' => false, 'error' => 'Video ID is required.'], 400);
}

$pdo = getDatabaseConnection();
$authUser = getAuthUser($pdo);
$isAdmin = $authUser && isset($authUser['role']) && strtolower((string)$authUser['role']) === 'admin';
$authUserId = $authUser ? trim((string)$authUser['user_id']) : '';

try {
    $stmt = $pdo->prepare('SELECT * FROM uploaded_videos WHERE id = ? LIMIT 1');
    $stmt->execute([$id]);
    $row = $stmt->fetch();

    if (!$row) {
        jsonResponse(['success' => false, 'error' => 'Video not found.'], 404);
    }

    if (!empty($row['is_blocked'])) {
        jsonResponse([
            'success' => false,
            'error' => 'This video has been blocked by administrators for content moderation.',
            'is_blocked' => true,
            'block_reason' => $row['block_reason'] ?? 'Content moderation',
        ], 403);
    }

    $visibility = normalizeVideoVisibility($row['visibility'] ?? null, 'public') ?? 'public';
    $isOwner = $authUserId !== '' && strcasecmp((string)$row['user_id'], $authUserId) === 0;
    $canAccessOwnerOrAdmin = ($isOwner || $isAdmin);

    if ($visibility === 'private' && !$canAccessOwnerOrAdmin) {
        jsonResponse([
            'success' => false,
            'error' => 'Forbidden: This video is private. Only the video owner or an administrator can access it.'
        ], 403);
    }

    $videoType = strtolower((string)($row['video_type'] ?? 'free'));
    $paymentStatus = strtolower((string)($row['payment_status'] ?? 'not_required'));
    if ($videoType === 'premium' && in_array($paymentStatus, ['pending', 'failed'], true) && !$canAccessOwnerOrAdmin) {
        jsonResponse([
            'success' => false,
            'error' => 'Forbidden: This premium video is awaiting payment confirmation.'
        ], 403);
    }

    // Increment views counter ONLY after authorization checks succeed
    $pdo->prepare('UPDATE uploaded_videos SET views = views + 1 WHERE id = ?')->execute([$id]);

    $expiryTime = !empty($row['promotion_expires_at']) ? strtotime($row['promotion_expires_at']) : false;
    $isActivePromoted = !empty($row['is_promoted']) && $expiryTime !== false && $expiryTime > time();

    $videoUrl = resolveVideoMediaOutputUrl($row['video_url'] ?? '', (string)$row['id'], $visibility, 'video', $canAccessOwnerOrAdmin);
    $thumbUrl = resolveVideoMediaOutputUrl($row['thumbnail_url'] ?? '', (string)$row['id'], $visibility, 'thumbnail', $canAccessOwnerOrAdmin);

    $video = [
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
        'views' => (int)$row['views'] + 1,
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

    jsonResponse(['success' => true, 'video' => $video]);
} catch (PDOException $e) {
    jsonResponse(['success' => false, 'error' => 'Database error: ' . $e->getMessage()], 500);
}
