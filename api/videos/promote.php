<?php
/**
 * FaceTube - Promote Video API
 * POST /api/videos/promote.php
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$pdo = getDatabaseConnection();
$authUser = getAuthUser($pdo);
if (!$authUser) {
    jsonResponse([
        'success' => false,
        'error' => 'Authentication required. Please provide a valid Bearer session token.'
    ], 401);
}

$input = getRequestPayload();
$videoId = trim((string)($input['videoId'] ?? ($input['video_id'] ?? '')));
$planId = trim((string)($input['planId'] ?? ($input['plan_id'] ?? 'plan-monthly')));
$durationDays = max(1, intval($input['durationDays'] ?? ($input['duration_days'] ?? 30)));
$paymentId = trim((string)($input['paymentId'] ?? ($input['payment_id'] ?? '')));

if (empty($videoId)) {
    jsonResponse(['success' => false, 'error' => 'Video ID is required.'], 400);
}

$isAdmin = isset($authUser['role']) && strtolower((string)$authUser['role']) === 'admin';

try {
    $stmtLookup = $pdo->prepare('SELECT * FROM uploaded_videos WHERE id = ? LIMIT 1');
    $stmtLookup->execute([$videoId]);
    $videoRow = $stmtLookup->fetch();

    if (!$videoRow) {
        jsonResponse(['success' => false, 'error' => 'Video not found.'], 404);
    }

    if (strcasecmp((string)$videoRow['user_id'], (string)$authUser['user_id']) !== 0 && !$isAdmin) {
        jsonResponse(['success' => false, 'error' => 'Forbidden: You do not own this video.'], 403);
    }

    $visibility = normalizeVideoVisibility($videoRow['visibility'] ?? null, 'public') ?? 'public';
    if ($visibility !== 'public') {
        jsonResponse([
            'success' => false,
            'error' => 'Sponsored and Global Pool eligible videos must use \'public\' visibility. Only public videos can be promoted.'
        ], 400);
    }

    $expiresAt = date('Y-m-d H:i:s', strtotime("+{$durationDays} days"));
    $stmt = $pdo->prepare('
        UPDATE uploaded_videos 
        SET is_promoted = 1, promotion_plan = ?, promotion_expires_at = ?, updated_at = NOW()
        WHERE id = ?
    ');
    $stmt->execute([$planId, $expiresAt, $videoId]);

    jsonResponse([
        'success' => true,
        'message' => 'Video promoted successfully.',
        'promotionExpiresAt' => $expiresAt,
    ]);
} catch (PDOException $e) {
    jsonResponse(['success' => false, 'error' => 'Database error: ' . $e->getMessage()], 500);
}
