<?php
/**
 * FaceTube - Create Uploaded Video API
 * POST /api/videos/create.php
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
$isAdmin = isset($authUser['role']) && strtolower((string)$authUser['role']) === 'admin';
$authUserId = trim((string)$authUser['user_id']);

$requestedUserId = trim((string)($input['user_id'] ?? ($input['userId'] ?? '')));
if ($requestedUserId === '') {
    $userId = $authUserId;
} elseif (strcasecmp($requestedUserId, $authUserId) === 0) {
    $userId = $authUserId;
} elseif ($isAdmin) {
    $userId = $requestedUserId;
} else {
    jsonResponse([
        'success' => false,
        'error' => 'Unauthorized: You can only create or update videos for your own account.'
    ], 403);
}

$id = trim((string)($input['id'] ?? ('vid_' . round(microtime(true) * 1000) . '_' . substr(md5(random_bytes(6)), 0, 6))));
$creatorName = trim((string)($input['creator_name'] ?? ($input['creatorName'] ?? '')));
if ($creatorName === '') {
    $creatorName = strcasecmp($userId, $authUserId) === 0 ? ($authUser['name'] ?: 'FaceTube Creator') : 'FaceTube Creator';
}
$title = trim((string)($input['title'] ?? ''));
$description = trim((string)($input['description'] ?? ''));
$videoUrl = trim((string)($input['video_url'] ?? ($input['videoUrl'] ?? '')));
$thumbnailUrl = trim((string)($input['thumbnail_url'] ?? ($input['thumbnailUrl'] ?? '')));

$rawVideoType = strtolower(trim((string)($input['video_type'] ?? ($input['videoType'] ?? 'free'))));
if (!in_array($rawVideoType, ['free', 'premium'], true)) {
    jsonResponse(['success' => false, 'error' => 'Invalid video_type. Allowed values are free or premium.'], 400);
}
$videoType = $rawVideoType;

$rawContentType = strtolower(trim((string)($input['content_type'] ?? ($input['contentType'] ?? 'long'))));
if (!in_array($rawContentType, ['short', 'long'], true)) {
    jsonResponse(['success' => false, 'error' => 'Invalid content_type. Allowed values are short or long.'], 400);
}
$contentType = $rawContentType;

$category = trim((string)($input['category'] ?? 'General'));
$duration = trim((string)($input['duration'] ?? '0:00'));

$rawPaymentStatus = $input['payment_status'] ?? ($input['paymentStatus'] ?? null);
if ($rawPaymentStatus === null || trim((string)$rawPaymentStatus) === '') {
    $paymentStatus = $videoType === 'premium' ? 'pending' : 'not_required';
} else {
    $paymentStatus = strtolower(trim((string)$rawPaymentStatus));
}
if (!in_array($paymentStatus, ['not_required', 'pending', 'paid', 'failed'], true)) {
    jsonResponse(['success' => false, 'error' => 'Invalid payment_status.'], 400);
}

$paymentId = !empty($input['payment_id']) ? trim((string)$input['payment_id']) : (!empty($input['paymentId']) ? trim((string)$input['paymentId']) : null);
$paymentAmount = floatval($input['payment_amount'] ?? ($input['paymentAmount'] ?? ($videoType === 'premium' ? 6.00 : 0.00)));

$rawVisibility = $input['visibility'] ?? null;
$visibility = normalizeVideoVisibility($rawVisibility, 'public');
if ($visibility === null) {
    jsonResponse([
        'success' => false,
        'error' => 'Invalid video visibility. Allowed values are public, unlisted, or private.'
    ], 400);
}

$isPromotedInput = !empty($input['is_promoted']) || !empty($input['isPromoted']);
$isSponsoredInput = !empty($input['is_sponsored']) || !empty($input['isSponsored']) || !empty($input['global_pool_eligible']) || !empty($input['globalPoolEligible']);

if (empty($title)) {
    jsonResponse(['success' => false, 'error' => 'Video title is required.'], 400);
}

if (empty($videoUrl)) {
    jsonResponse(['success' => false, 'error' => 'Video URL or file is required.'], 400);
}

// Check existing video row first to protect duplicate-ID ownership & promoted visibility lock
$existingRow = null;
try {
    $stmtExisting = $pdo->prepare('SELECT id, user_id, is_promoted, payment_status, video_url, thumbnail_url FROM uploaded_videos WHERE id = ? LIMIT 1');
    $stmtExisting->execute([$id]);
    $existingRow = $stmtExisting->fetch() ?: null;
} catch (PDOException $eEx) {
    jsonResponse(['success' => false, 'error' => 'Database error checking video record.'], 500);
}

if ($existingRow) {
    if (strcasecmp((string)$existingRow['user_id'], $userId) !== 0 && !$isAdmin) {
        jsonResponse([
            'success' => false,
            'error' => 'Forbidden: You do not own this video ID and cannot overwrite another user\'s video.'
        ], 403);
    }
    if (!empty($existingRow['is_promoted'])) {
        $isPromotedInput = true;
    }
}

// Enforce approved visibility rules (Free vs Paid Premium vs Sponsored/Global Pool)
$visibilityErr = validateVideoVisibilityRules(
    $visibility,
    $videoType,
    $paymentStatus,
    $isPromotedInput,
    $isSponsoredInput,
    !empty($input['global_pool_eligible']) || !empty($input['globalPoolEligible'])
);
if ($visibilityErr !== null) {
    jsonResponse(['success' => false, 'error' => $visibilityErr], 400);
}

// Prevent client from bypassing Ads Promotion payment via arbitrary is_promoted=true on create
if ($isPromotedInput && empty($existingRow['is_promoted']) && !$isAdmin) {
    $hasVerifiedPromo = false;
    if (!empty($paymentId)) {
        try {
            $stmtPromoPay = $pdo->prepare('SELECT payment_id FROM payment_transactions WHERE payment_id = ? AND purpose = "ads_promotion" AND UPPER(user_id) = UPPER(?) LIMIT 1');
            $stmtPromoPay->execute([$paymentId, $userId]);
            $hasVerifiedPromo = (bool)$stmtPromoPay->fetch();
        } catch (Exception $ePromo) {
            $hasVerifiedPromo = false;
        }
    }
    if (!$hasVerifiedPromo) {
        jsonResponse([
            'success' => false,
            'error' => 'Payment verification required: cannot enable promotion without a verified Ads Promotion payment.'
        ], 402);
    }
}

// Preserve payment verification integrity: reject spoofed payment_status='paid' without verified transaction
if ($paymentStatus === 'paid') {
    if (empty($paymentId)) {
        jsonResponse([
            'success' => false,
            'error' => 'Payment verification required: payment_id is required for paid videos.'
        ], 402);
    }
    $isPaymentVerified = false;
    try {
        $stmtPayTx = $pdo->prepare('SELECT payment_id, user_id, video_id FROM payment_transactions WHERE payment_id = ? LIMIT 1');
        $stmtPayTx->execute([$paymentId]);
        $payTxRow = $stmtPayTx->fetch();
        if ($payTxRow && (strcasecmp((string)$payTxRow['user_id'], $userId) === 0 || $isAdmin)) {
            if (empty($payTxRow['video_id']) || strcasecmp((string)$payTxRow['video_id'], $id) === 0) {
                $isPaymentVerified = true;
            }
        }
        if (!$isPaymentVerified) {
            $stmtPo = $pdo->prepare('SELECT payment_id, user_id, video_id FROM payment_orders WHERE payment_id = ? AND status = "paid" LIMIT 1');
            $stmtPo->execute([$paymentId]);
            $poRow = $stmtPo->fetch();
            if ($poRow && (strcasecmp((string)$poRow['user_id'], $userId) === 0 || $isAdmin)) {
                if (empty($poRow['video_id']) || strcasecmp((string)$poRow['video_id'], $id) === 0) {
                    $isPaymentVerified = true;
                }
            }
        }
    } catch (Exception $ePay) {
        $isPaymentVerified = false;
    }

    if (!$isPaymentVerified) {
        jsonResponse([
            'success' => false,
            'error' => 'Payment verification required: no verified payment transaction found for this payment_id.'
        ], 402);
    }
}

$hasVisibilityCol = hasUploadedVideosVisibilityColumn($pdo);
if (!$hasVisibilityCol && $visibility !== 'public') {
    jsonResponse([
        'success' => false,
        'error' => 'Database migration required: uploaded_videos.visibility column does not exist yet.'
    ], 500);
}

// Handle thumbnail persistence (private thumbnails stored outside public uploads/)
if (!empty($thumbnailUrl) && str_starts_with($thumbnailUrl, 'data:image/')) {
    $imgData = explode(',', $thumbnailUrl, 2);
    if (count($imgData) === 2) {
        $decoded = base64_decode($imgData[1]);
        if ($decoded !== false) {
            $imgExt = 'jpg';
            if (str_contains($imgData[0], 'png')) $imgExt = 'png';
            elseif (str_contains($imgData[0], 'webp')) $imgExt = 'webp';

            $safeVidId = preg_replace('/[^a-zA-Z0-9_-]/', '_', $id);
            $imgFileName = 'thumb_' . $safeVidId . '.' . $imgExt;

            if ($visibility === 'private') {
                $privImgDir = ensurePrivateMediaDir('images');
                if ($privImgDir && @file_put_contents($privImgDir . $imgFileName, $decoded)) {
                    $thumbnailUrl = 'private_media://images/' . $imgFileName;
                }
            } else {
                $imgUploadDir = ensureMediaStorageDir('images');
                if ($imgUploadDir) {
                    $imgPath = $imgUploadDir . $imgFileName;
                    if (@file_put_contents($imgPath, $decoded)) {
                        $allDirs = getMediaStorageDirectories('images');
                        foreach ($allDirs as $otherDir) {
                            if ($otherDir !== $imgUploadDir && is_dir($otherDir) && is_writable($otherDir)) {
                                @copy($imgPath, $otherDir . $imgFileName);
                            }
                        }
                        $thumbnailUrl = toAbsoluteMediaUrl('/uploads/images/' . $imgFileName, 'images');
                    }
                }
            }
        }
    }
}

// Fallback to category cover image if thumbnail is empty or overly long data URI
if (empty($thumbnailUrl) || strlen($thumbnailUrl) > 60000) {
    $categoryThumbnails = [
        'Cartoon' => 'https://images.unsplash.com/photo-1534447677768-be436bb09401?w=800&auto=format&fit=crop&q=80',
        'Agriculture' => 'https://images.unsplash.com/photo-1500937386664-56d1dfef3854?w=800&auto=format&fit=crop&q=80',
        'Coding' => 'https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=800&auto=format&fit=crop&q=80',
        'Motivational' => 'https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=800&auto=format&fit=crop&q=80',
        'Comedy' => 'https://images.unsplash.com/photo-1514306191717-452ec28c7814?w=800&auto=format&fit=crop&q=80',
        'Entertainment' => 'https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?w=800&auto=format&fit=crop&q=80',
        'Finance' => 'https://images.unsplash.com/photo-1579621970563-ebec7560ff3e?w=800&auto=format&fit=crop&q=80',
        'Share Market' => 'https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=800&auto=format&fit=crop&q=80',
        'General' => 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800&auto=format&fit=crop&q=60',
    ];
    $thumbnailUrl = $categoryThumbnails[$category] ?? $categoryThumbnails['General'];
} elseif ($visibility === 'private') {
    // Isolate any local /uploads/images/ thumbnail out of public uploads/
    $thumbnailUrl = moveLocalMediaToPrivate($thumbnailUrl, 'images');
    if (extractPrivateMediaRef($thumbnailUrl) === null && !preg_match('/^https?:\/\//i', $thumbnailUrl)) {
        $thumbnailUrl = toAbsoluteMediaUrl($thumbnailUrl, 'images');
    }
} else {
    if (extractPrivateMediaRef($thumbnailUrl) !== null) {
        $thumbnailUrl = restorePrivateMediaToPublic($thumbnailUrl);
    } else {
        $thumbnailUrl = toAbsoluteMediaUrl($thumbnailUrl, 'images');
    }
}

// Isolate or restore local video file according to visibility
if ($visibility === 'private') {
    $videoUrl = moveLocalMediaToPrivate($videoUrl, 'videos');
    if (extractPrivateMediaRef($videoUrl) === null && !preg_match('/^https?:\/\//i', $videoUrl)) {
        $videoUrl = toAbsoluteMediaUrl($videoUrl, 'videos');
    }
} else {
    if (extractPrivateMediaRef($videoUrl) !== null) {
        $videoUrl = restorePrivateMediaToPublic($videoUrl);
    } elseif ($existingRow && extractPrivateMediaRef($existingRow['video_url'] ?? '') !== null && extractLocalUploadRef($videoUrl) !== null) {
        restorePrivateMediaToPublic($existingRow['video_url']);
        $videoUrl = toAbsoluteMediaUrl($videoUrl, 'videos');
    } else {
        $videoUrl = toAbsoluteMediaUrl($videoUrl, 'videos');
    }
}

$isPromotedFinal = (!empty($existingRow['is_promoted']) || $isPromotedInput) ? 1 : 0;

try {
    if ($hasVisibilityCol) {
        $stmt = $pdo->prepare('
            INSERT INTO uploaded_videos (
                id, user_id, creator_name, title, description, video_url, thumbnail_url,
                video_type, content_type, category, duration, views, likes,
                payment_status, payment_id, payment_amount, is_promoted, visibility,
                created_at, updated_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, 0, 0,
                ?, ?, ?, ?, ?,
                NOW(), NOW()
            )
            ON DUPLICATE KEY UPDATE
                title = VALUES(title),
                description = VALUES(description),
                video_url = VALUES(video_url),
                thumbnail_url = VALUES(thumbnail_url),
                video_type = VALUES(video_type),
                content_type = VALUES(content_type),
                category = VALUES(category),
                duration = VALUES(duration),
                payment_status = VALUES(payment_status),
                payment_id = VALUES(payment_id),
                payment_amount = VALUES(payment_amount),
                visibility = VALUES(visibility),
                updated_at = NOW()
        ');

        $stmt->execute([
            $id,
            $userId,
            $creatorName,
            $title,
            $description,
            $videoUrl,
            $thumbnailUrl,
            $videoType,
            $contentType,
            $category,
            $duration,
            $paymentStatus,
            $paymentId,
            $paymentAmount,
            $isPromotedFinal,
            $visibility
        ]);
    } else {
        $stmt = $pdo->prepare('
            INSERT INTO uploaded_videos (
                id, user_id, creator_name, title, description, video_url, thumbnail_url,
                video_type, content_type, category, duration, views, likes,
                payment_status, payment_id, payment_amount, is_promoted,
                created_at, updated_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, 0, 0,
                ?, ?, ?, ?,
                NOW(), NOW()
            )
            ON DUPLICATE KEY UPDATE
                title = VALUES(title),
                description = VALUES(description),
                video_url = VALUES(video_url),
                thumbnail_url = VALUES(thumbnail_url),
                video_type = VALUES(video_type),
                content_type = VALUES(content_type),
                category = VALUES(category),
                duration = VALUES(duration),
                payment_status = VALUES(payment_status),
                payment_id = VALUES(payment_id),
                payment_amount = VALUES(payment_amount),
                updated_at = NOW()
        ');

        $stmt->execute([
            $id,
            $userId,
            $creatorName,
            $title,
            $description,
            $videoUrl,
            $thumbnailUrl,
            $videoType,
            $contentType,
            $category,
            $duration,
            $paymentStatus,
            $paymentId,
            $paymentAmount,
            $isPromotedFinal
        ]);
    }

    $outputVideoUrl = resolveVideoMediaOutputUrl($videoUrl, $id, $visibility, 'video', true);
    $outputThumbUrl = resolveVideoMediaOutputUrl($thumbnailUrl, $id, $visibility, 'thumbnail', true);

    jsonResponse([
        'success' => true,
        'video' => [
            'id' => $id,
            'userId' => $userId,
            'user_id' => $userId,
            'creatorName' => $creatorName,
            'creator_name' => $creatorName,
            'title' => $title,
            'description' => $description,
            'videoUrl' => $outputVideoUrl,
            'video_url' => $outputVideoUrl,
            'thumbnailUrl' => $outputThumbUrl,
            'thumbnail_url' => $outputThumbUrl,
            'videoType' => $videoType,
            'video_type' => $videoType,
            'contentType' => $contentType,
            'content_type' => $contentType,
            'category' => $category,
            'duration' => $duration,
            'paymentStatus' => $paymentStatus,
            'payment_status' => $paymentStatus,
            'paymentId' => $paymentId,
            'paymentAmount' => $paymentAmount,
            'isPromoted' => (bool)$isPromotedFinal,
            'visibility' => $visibility,
            'created_at' => date('c'),
        ]
    ], 201);
} catch (PDOException $e) {
    jsonResponse(['success' => false, 'error' => 'Database insert error: ' . $e->getMessage()], 500);
}
