<?php
/**
 * FaceTube - Protected Private Media Streaming API
 * GET /api/videos/media.php?id=<video_id>&kind=video|thumbnail[&exp=...&sig=...]
 *
 * Authorizes access via EITHER:
 * 1. Authenticated Bearer token belonging to video owner or admin, OR
 * 2. Valid short-lived HMAC signature issued by authenticated videos/get or owner videos/list.
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET' && $_SERVER['REQUEST_METHOD'] !== 'HEAD') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$id = trim((string)($_GET['id'] ?? ''));
$kind = strtolower(trim((string)($_GET['kind'] ?? 'video')));
if (!in_array($kind, ['video', 'thumbnail'], true)) {
    $kind = 'video';
}

if ($id === '') {
    jsonResponse(['success' => false, 'error' => 'Video ID is required.'], 400);
}

$pdo = getDatabaseConnection();
$stmt = $pdo->prepare('SELECT * FROM uploaded_videos WHERE id = ? LIMIT 1');
$stmt->execute([$id]);
$row = $stmt->fetch();

if (!$row) {
    jsonResponse(['success' => false, 'error' => 'Video not found.'], 404);
}

$visibility = normalizeVideoVisibility($row['visibility'] ?? null, 'public') ?? 'public';
$authUser = getAuthUser($pdo);
$isAdmin = $authUser && isset($authUser['role']) && strtolower((string)$authUser['role']) === 'admin';
$isOwner = $authUser && strcasecmp(trim((string)$row['user_id']), trim((string)$authUser['user_id'])) === 0;

if (!empty($row['is_blocked']) && !$isAdmin) {
    jsonResponse(['success' => false, 'error' => 'This video has been blocked by administrators.'], 403);
}

$expParam = $_GET['exp'] ?? null;
$sigParam = $_GET['sig'] ?? null;
$hasValidSig = verifyPrivateMediaSignature($id, $kind, $expParam, $sigParam);

if ($visibility === 'private') {
    if (!$isOwner && !$isAdmin && !$hasValidSig) {
        $statusCode = $authUser ? 403 : 401;
        jsonResponse([
            'success' => false,
            'error' => $authUser
                ? 'Forbidden: Private media is restricted to the video owner or an administrator.'
                : 'Authentication required to access private media.'
        ], $statusCode);
    }
}

$storedUrl = $kind === 'thumbnail' ? ($row['thumbnail_url'] ?? '') : ($row['video_url'] ?? '');
$diskPath = resolvePrivateMediaFilePath($storedUrl);
if (!$diskPath || !is_file($diskPath)) {
    jsonResponse(['success' => false, 'error' => 'Media file not found in protected storage.'], 404);
}

streamMediaFileWithRange($diskPath);
