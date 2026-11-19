<?php
/**
 * FaceTube - Admin Video Moderation API
 * GET /api/admin/videos.php  - List all videos with moderation status
 * POST /api/admin/videos.php - Block/Unblock a video
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

$pdo = getDatabaseConnection();
$authUser = getAuthUser($pdo);

if (!$authUser || strtolower($authUser['role'] ?? '') !== 'admin') {
    jsonResponse(['success' => false, 'error' => 'Admin authorization required'], 403);
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    try {
        $hasAdEarningsCol = false;
        try {
            $colStmt = $pdo->query("
                SELECT COUNT(*)
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME = 'uploaded_videos'
                  AND COLUMN_NAME = 'ad_earnings'
            ");
            $hasAdEarningsCol = $colStmt && intval($colStmt->fetchColumn()) > 0;
        } catch (Exception $eCol) {
            $hasAdEarningsCol = false;
        }
        $hasVisibilityCol = hasUploadedVideosVisibilityColumn($pdo);

        $adEarningsSelect = $hasAdEarningsCol ? ', COALESCE(ad_earnings, 0.00) AS ad_earnings' : '';
        $visibilitySelect = $hasVisibilityCol ? ", COALESCE(visibility, 'public') AS visibility" : ", 'public' AS visibility";
        $stmt = $pdo->query("
            SELECT id, user_id, creator_name, title, description, video_url, thumbnail_url,
                   video_type, content_type, category, duration, views, likes,
                   is_promoted, is_blocked, block_reason, blocked_at, created_at{$visibilitySelect}{$adEarningsSelect}
            FROM uploaded_videos
            ORDER BY created_at DESC
        ");
        $videos = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $videos = array_map(function ($v) use ($hasAdEarningsCol) {
            $v['visibility'] = normalizeVideoVisibility($v['visibility'] ?? null, 'public') ?? 'public';
            if ($hasAdEarningsCol) {
                $v['ad_earnings'] = round(floatval($v['ad_earnings'] ?? 0), 2);
            }
            return $v;
        }, $videos);

        jsonResponse([
            'success' => true,
            'videos' => $videos,
            'counts' => [
                'total' => count($videos),
                'blocked' => count(array_filter($videos, fn($v) => !empty($v['is_blocked']))),
                'shorts' => count(array_filter($videos, fn($v) => ($v['content_type'] ?? '') === 'short')),
                'long' => count(array_filter($videos, fn($v) => ($v['content_type'] ?? '') === 'long')),
            ]
        ]);
    } catch (PDOException $e) {
        jsonResponse(['success' => false, 'error' => 'Database error: ' . $e->getMessage()], 500);
    }
}

if ($method === 'POST') {
    $input = getRequestPayload();
    $videoId = trim($input['videoId'] ?? ($input['video_id'] ?? ''));
    $isBlocked = !empty($input['is_blocked']) || !empty($input['isBlocked']) || $input['action'] === 'block';
    $blockReason = trim($input['block_reason'] ?? ($input['reason'] ?? 'Content policy violation'));

    if (empty($videoId)) {
        jsonResponse(['success' => false, 'error' => 'Video ID is required'], 400);
    }

    try {
        $stmt = $pdo->prepare('
            UPDATE uploaded_videos
            SET is_blocked = ?,
                block_reason = ?,
                blocked_at = ?
            WHERE id = ?
        ');
        $blockedAt = $isBlocked ? date('Y-m-d H:i:s') : null;
        $stmt->execute([
            $isBlocked ? 1 : 0,
            $isBlocked ? $blockReason : null,
            $blockedAt,
            $videoId
        ]);

        jsonResponse([
            'success' => true,
            'message' => $isBlocked ? 'Video has been blocked' : 'Video has been unblocked',
            'video_id' => $videoId,
            'is_blocked' => $isBlocked,
        ]);
    } catch (PDOException $e) {
        jsonResponse(['success' => false, 'error' => 'Database error: ' . $e->getMessage()], 500);
    }
}

jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
