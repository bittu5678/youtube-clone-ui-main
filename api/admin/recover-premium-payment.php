<?php
/**
 * FaceTube - Admin Idempotent Premium Video Payment Recovery API
 * POST /api/admin/recover-premium-payment.php
 *
 * Strictly restricted to verified Administrators (role = 'admin').
 * Default mode is dryRun = true (read-only audit & accounting simulation; zero DB writes).
 *
 * ============================================================================
 * DEPLOYMENT BLOCKER — CONCURRENCY AGAINST api/payments/verify.php
 * ============================================================================
 * This recovery endpoint acquires MySQL session lock GET_LOCK('facetube_premium_tx_seq', 15)
 * before allocating tx_number values for premium_video_upload transactions.
 * However, api/payments/verify.php currently does NOT acquire that shared lock
 * (it only runs `SELECT COUNT(*) ... FOR UPDATE` on payment_transactions, which
 * does not prevent concurrent tx_number collisions or out-of-order sequences
 * against an independent recovery session, nor serialize an empty table).
 *
 * Because api/payments/verify.php is frozen in this phase, live recovery writes
 * (dryRun = false) are BLOCKED BY DEFAULT (HTTP 423 Locked) unless an operator
 * explicitly sets FACETUBE_ENABLE_PREMIUM_RECOVERY_LIVE_WRITES=true in a
 * controlled maintenance window or isolated test environment after a shared
 * locking strategy across verify.php and recovery is approved and deployed.
 * ============================================================================
 */

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../response.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

try {
    $pdo = getDatabaseConnection();
    $authUser = getAuthUser($pdo);
} catch (PDOException $e) {
    error_log('[recover-premium-payment.php] Auth/DB bootstrap error: ' . $e->getMessage());
    jsonResponse([
        'success' => false,
        'error' => 'Database error during authentication verification.',
    ], 500);
} catch (Throwable $e) {
    error_log('[recover-premium-payment.php] Unexpected auth/DB bootstrap error: ' . $e->getMessage());
    jsonResponse([
        'success' => false,
        'error' => 'Unexpected server error during authentication verification.',
    ], 500);
}

if (!$authUser) {
    jsonResponse([
        'success' => false,
        'error' => 'Authentication required. Please provide a valid Bearer session token.',
    ], 401);
}

if (strtolower((string)($authUser['role'] ?? '')) !== 'admin') {
    jsonResponse([
        'success' => false,
        'error' => 'Admin authorization required. Only verified administrators can run premium payment recovery.',
    ], 403);
}

$input = getRequestPayload();

/**
 * dryRun MUST default strictly to true. Only explicit boolean false, "false", 0, or "0" enables live mode.
 */
function parseDryRunFlag($rawValue) {
    if ($rawValue === false || $rawValue === 0 || $rawValue === '0') {
        return false;
    }
    if (is_string($rawValue) && strtolower(trim($rawValue)) === 'false') {
        return false;
    }
    return true;
}

$dryRun = array_key_exists('dryRun', $input)
    ? parseDryRunFlag($input['dryRun'])
    : (array_key_exists('dry_run', $input) ? parseDryRunFlag($input['dry_run']) : true);

if (!$dryRun) {
    $liveWritesFlag = strtolower(trim((string)(
        getenv('FACETUBE_ENABLE_PREMIUM_RECOVERY_LIVE_WRITES')
        ?: ($_ENV['FACETUBE_ENABLE_PREMIUM_RECOVERY_LIVE_WRITES']
        ?? ($_SERVER['FACETUBE_ENABLE_PREMIUM_RECOVERY_LIVE_WRITES'] ?? ''))
    )));

    if ($liveWritesFlag !== 'true') {
        jsonResponse([
            'success' => false,
            'dryRun' => false,
            'deploymentBlocker' => true,
            'error' => 'Deployment Blocker: Live premium payment recovery writes are disabled because api/payments/verify.php does not yet share the GET_LOCK("facetube_premium_tx_seq") concurrency lock. Run with dryRun=true or deploy the approved shared locking strategy in verify.php before enabling FACETUBE_ENABLE_PREMIUM_RECOVERY_LIVE_WRITES=true.',
        ], 423);
    }
}

function generateRecoveryUuid() {
    return sprintf(
        '%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
        mt_rand(0, 0xffff),
        mt_rand(0, 0xffff),
        mt_rand(0, 0xffff),
        mt_rand(0, 0x0fff) | 0x4000,
        mt_rand(0, 0x3fff) | 0x8000,
        mt_rand(0, 0xffff),
        mt_rand(0, 0xffff),
        mt_rand(0, 0xffff)
    );
}

function validateSafeMediaFilename($rawName, $label) {
    if (!is_string($rawName)) {
        return [false, "{$label} must be a string."];
    }
    $name = trim($rawName);
    if ($name === '') {
        return [false, "{$label} is required."];
    }
    if (
        str_contains($name, '/') ||
        str_contains($name, '\\') ||
        str_contains($name, '..') ||
        str_contains($name, "\0") ||
        !preg_match('/^[A-Za-z0-9._-]+$/', $name)
    ) {
        return [false, "{$label} must be a safe basename without path separators or traversal sequences."];
    }
    return [true, $name];
}

function resolveMediaFileOnDisk($subfolder, $filename) {
    $dirs = getMediaStorageDirectories($subfolder);
    foreach ($dirs as $dir) {
        $realDir = realpath($dir);
        if ($realDir === false || !is_dir($realDir)) {
            continue;
        }
        $candidate = $realDir . DIRECTORY_SEPARATOR . $filename;
        $realCandidate = realpath($candidate);
        if ($realCandidate === false || !is_file($realCandidate)) {
            continue;
        }
        if (strpos($realCandidate, $realDir . DIRECTORY_SEPARATOR) !== 0) {
            continue;
        }
        $size = @filesize($realCandidate);
        if ($size !== false && $size > 0) {
            return [
                'exists' => true,
                'path' => $realCandidate,
                'size' => (int)$size,
            ];
        }
    }
    return ['exists' => false, 'path' => null, 'size' => 0];
}

function fetchRazorpayJson($path, $keyId, $keySecret) {
    $url = 'https://api.razorpay.com/v1' . $path;
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_USERPWD => "{$keyId}:{$keySecret}",
        CURLOPT_TIMEOUT => 15,
        CURLOPT_HTTPHEADER => ['Accept: application/json'],
    ]);
    $body = curl_exec($ch);
    $httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr = curl_error($ch);
    curl_close($ch);

    if ($body === false || $curlErr !== '') {
        return [
            'ok' => false,
            'httpCode' => 502,
            'error' => "Razorpay gateway request failed for {$path}: {$curlErr}",
        ];
    }

    $decoded = json_decode($body, true);
    if (!is_array($decoded)) {
        return [
            'ok' => false,
            'httpCode' => 502,
            'error' => "Invalid JSON payload returned by Razorpay for {$path}.",
        ];
    }

    if ($httpCode < 200 || $httpCode >= 300) {
        $msg = $decoded['error']['description'] ?? ($decoded['error']['code'] ?? "HTTP {$httpCode}");
        return [
            'ok' => false,
            'httpCode' => ($httpCode >= 400 && $httpCode < 500) ? 400 : 502,
            'error' => "Razorpay verification failed for {$path}: {$msg}",
        ];
    }

    return [
        'ok' => true,
        'httpCode' => $httpCode,
        'data' => $decoded,
    ];
}

function isSequentialListArray($arr) {
    if (!is_array($arr)) {
        return false;
    }
    if ($arr === []) {
        return true;
    }
    return array_keys($arr) === range(0, count($arr) - 1);
}

function readStrictStringField($item, $keys, $fieldLabel, $idx, $required, $default = '') {
    $found = false;
    $selectedValue = null;

    foreach ($keys as $key) {
        if (array_key_exists($key, $item)) {
            if (!is_string($item[$key])) {
                jsonResponse([
                    'success' => false,
                    'error' => "Item {$idx}: {$fieldLabel} must be a string.",
                ], 400);
            }
            if (!$found) {
                $found = true;
                $selectedValue = $item[$key];
            }
        }
    }

    if (!$found) {
        if ($required) {
            jsonResponse([
                'success' => false,
                'error' => "Item {$idx}: {$fieldLabel} is required and must be a string.",
            ], 400);
        }
        return $default;
    }

    return trim($selectedValue);
}

function readStrictRawMediaField($item, $keys, $fieldLabel, $idx) {
    $found = false;
    $selectedValue = null;

    foreach ($keys as $key) {
        if (array_key_exists($key, $item)) {
            if (!is_string($item[$key])) {
                jsonResponse([
                    'success' => false,
                    'error' => "Item {$idx}: {$fieldLabel} must be a string.",
                ], 400);
            }
            if (!$found) {
                $found = true;
                $selectedValue = $item[$key];
            }
        }
    }

    if (!$found) {
        return '';
    }

    return $selectedValue;
}

function normalizeAndValidateItems($input) {
    if (!is_array($input) || ($input !== [] && isSequentialListArray($input))) {
        jsonResponse(['success' => false, 'error' => 'Invalid JSON request payload. Expected a JSON object.'], 400);
    }

    $rawItems = null;
    if (array_key_exists('items', $input)) {
        if (!is_array($input['items']) || count($input['items']) === 0 || !isSequentialListArray($input['items'])) {
            jsonResponse(['success' => false, 'error' => 'items must be a non-empty array of payment recovery objects.'], 400);
        }
        $rawItems = $input['items'];
    } else {
        $rawItems = [$input];
    }

    $normalized = [];
    $seenPaymentIds = [];
    $seenOrderIds = [];
    $seenVideoIds = [];
    $seenVideoFiles = [];
    $seenThumbFiles = [];

    foreach ($rawItems as $idx => $item) {
        if (!is_array($item) || $item === [] || isSequentialListArray($item)) {
            jsonResponse(['success' => false, 'error' => "Recovery item at index {$idx} must be an object."], 400);
        }

        $userId = readStrictStringField($item, ['userId', 'user_id'], 'userId', $idx, true);
        $userUuid = readStrictStringField($item, ['userUuid', 'user_uuid'], 'userUuid', $idx, false, '');
        $paymentId = readStrictStringField($item, ['paymentId', 'payment_id'], 'paymentId', $idx, true);
        $orderId = readStrictStringField($item, ['orderId', 'order_id'], 'orderId', $idx, true);
        $videoId = readStrictStringField($item, ['videoId', 'video_id'], 'videoId', $idx, true);
        $contentType = strtolower(readStrictStringField($item, ['contentType', 'content_type'], 'contentType', $idx, true));
        $title = readStrictStringField($item, ['title'], 'title', $idx, true);
        $category = readStrictStringField($item, ['category'], 'category', $idx, true);
        $description = readStrictStringField($item, ['description'], 'description', $idx, false, '');
        $duration = readStrictStringField($item, ['duration'], 'duration', $idx, false, '0:00');
        if ($duration === '') {
            $duration = '0:00';
        }

        $rawVideoFile = readStrictRawMediaField($item, ['videoFilename', 'video_filename', 'videoFile', 'video_file'], 'videoFilename', $idx);
        $rawThumbFile = readStrictRawMediaField($item, ['thumbnailFilename', 'thumbnail_filename', 'thumbnailFile', 'thumbnail_file'], 'thumbnailFilename', $idx);

        if ($userId === '' || $paymentId === '' || $orderId === '' || $videoId === '') {
            jsonResponse([
                'success' => false,
                'error' => "Item {$idx}: userId, paymentId, orderId, and videoId are all required.",
            ], 400);
        }

        if (!in_array($contentType, ['long', 'short'], true)) {
            jsonResponse([
                'success' => false,
                'error' => "Item {$idx}: contentType must be strictly 'long' or 'short'.",
            ], 400);
        }

        if ($title === '' || $category === '') {
            jsonResponse([
                'success' => false,
                'error' => "Item {$idx}: title and category must be non-empty UTF-8 strings.",
            ], 400);
        }

        if (mb_strlen($title, 'UTF-8') > 500 || mb_strlen($category, 'UTF-8') > 100 || mb_strlen($duration, 'UTF-8') > 50) {
            jsonResponse([
                'success' => false,
                'error' => "Item {$idx}: title, category, or duration exceeds database column limits.",
            ], 400);
        }

        if (!preg_match('//u', $title) || !preg_match('//u', $category) || !preg_match('//u', $description) || !preg_match('//u', $duration)) {
            jsonResponse([
                'success' => false,
                'error' => "Item {$idx}: title, category, description, and duration must be valid UTF-8 strings.",
            ], 400);
        }

        [$vOk, $videoFilename] = validateSafeMediaFilename($rawVideoFile, "Item {$idx} videoFilename");
        if (!$vOk) {
            jsonResponse(['success' => false, 'error' => $videoFilename], 400);
        }

        [$tOk, $thumbnailFilename] = validateSafeMediaFilename($rawThumbFile, "Item {$idx} thumbnailFilename");
        if (!$tOk) {
            jsonResponse(['success' => false, 'error' => $thumbnailFilename], 400);
        }

        if (array_key_exists('expectedAmountPaise', $item)) {
            $rawExpectedPaise = $item['expectedAmountPaise'];
            $isValidPaise = (is_int($rawExpectedPaise) && $rawExpectedPaise === 600)
                || (is_float($rawExpectedPaise) && $rawExpectedPaise === 600.0)
                || (is_string($rawExpectedPaise) && trim($rawExpectedPaise) === '600');
            if (!$isValidPaise) {
                jsonResponse(['success' => false, 'error' => "Item {$idx}: premium_video_upload amount must be strictly 600 paise (₹6.00)."], 400);
            }
        }

        $pKey = strtolower($paymentId);
        $oKey = strtolower($orderId);
        $vKey = strtolower($videoId);
        if (isset($seenPaymentIds[$pKey]) || isset($seenOrderIds[$oKey]) || isset($seenVideoIds[$vKey]) || isset($seenVideoFiles[$videoFilename]) || isset($seenThumbFiles[$thumbnailFilename])) {
            jsonResponse([
                'success' => false,
                'error' => "Duplicate recovery target detected in request batch (paymentId={$paymentId}, orderId={$orderId}, videoId={$videoId}).",
            ], 400);
        }

        $seenPaymentIds[$pKey] = true;
        $seenOrderIds[$oKey] = true;
        $seenVideoIds[$vKey] = true;
        $seenVideoFiles[$videoFilename] = true;
        $seenThumbFiles[$thumbnailFilename] = true;

        $normalized[] = [
            'userId' => $userId,
            'userUuid' => $userUuid,
            'paymentId' => $paymentId,
            'orderId' => $orderId,
            'videoId' => $videoId,
            'contentType' => $contentType,
            'title' => $title,
            'category' => $category,
            'description' => $description,
            'duration' => $duration,
            'videoFilename' => $videoFilename,
            'thumbnailFilename' => $thumbnailFilename,
            'amount' => 6.00,
            'amountPaise' => 600,
        ];
    }

    return $normalized;
}

$items = normalizeAndValidateItems($input);

// Verify Razorpay configuration (Fail-Closed)
$rzpConfig = getRazorpayConfig();
$keyId = $rzpConfig['keyId'] ?? '';
$keySecret = $rzpConfig['keySecret'] ?? '';
if ($keyId === '' || $keySecret === '') {
    jsonResponse([
        'success' => false,
        'error' => 'Razorpay credentials (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET) are not configured on the server.',
    ], 503);
}

// Verify every item against users table, filesystem media, and Razorpay API BEFORE any DB writes
$verifiedItems = [];
foreach ($items as $item) {
    // 1. Customer verification in users table
    try {
        $stmtUser = $pdo->prepare('SELECT id, user_id, name, referral_code FROM users WHERE UPPER(user_id) = UPPER(?) LIMIT 1');
        $stmtUser->execute([$item['userId']]);
        $userRow = $stmtUser->fetch(PDO::FETCH_ASSOC);
    } catch (PDOException $e) {
        error_log('[recover-premium-payment.php] Pre-flight customer lookup DB error: ' . $e->getMessage());
        jsonResponse([
            'success' => false,
            'dryRun' => $dryRun,
            'error' => 'Database error during pre-flight customer verification. Zero database writes were executed.',
        ], 500);
    } catch (Throwable $e) {
        error_log('[recover-premium-payment.php] Pre-flight customer lookup error: ' . $e->getMessage());
        jsonResponse([
            'success' => false,
            'dryRun' => $dryRun,
            'error' => 'Unexpected server error during pre-flight customer verification. Zero database writes were executed.',
        ], 500);
    }
    if (!$userRow) {
        jsonResponse([
            'success' => false,
            'error' => "Customer '{$item['userId']}' not found in users table.",
        ], 404);
    }

    if ($item['userUuid'] !== '' && strcasecmp((string)$userRow['id'], $item['userUuid']) !== 0) {
        jsonResponse([
            'success' => false,
            'error' => "Customer UUID mismatch for {$item['userId']}: expected {$userRow['id']}, got {$item['userUuid']}.",
        ], 400);
    }

    $canonicalUserId = (string)$userRow['user_id'];
    $creatorName = trim((string)($userRow['name'] ?? '')) !== '' ? (string)$userRow['name'] : 'Creator';

    // 2. Physical media file verification (videos + images)
    $videoFileCheck = resolveMediaFileOnDisk('videos', $item['videoFilename']);
    if (!$videoFileCheck['exists']) {
        jsonResponse([
            'success' => false,
            'error' => "Missing or empty video file '{$item['videoFilename']}' in uploads/videos storage.",
        ], 404);
    }

    $thumbFileCheck = resolveMediaFileOnDisk('images', $item['thumbnailFilename']);
    if (!$thumbFileCheck['exists']) {
        jsonResponse([
            'success' => false,
            'error' => "Missing or empty thumbnail file '{$item['thumbnailFilename']}' in uploads/images storage.",
        ], 404);
    }

    // 3. Independent Razorpay verification: Order, Payment, and Order->Payments list
    $orderRes = fetchRazorpayJson('/orders/' . rawurlencode($item['orderId']), $keyId, $keySecret);
    if (!$orderRes['ok']) {
        jsonResponse(['success' => false, 'error' => $orderRes['error']], $orderRes['httpCode']);
    }
    $rzpOrder = $orderRes['data'];

    $paymentRes = fetchRazorpayJson('/payments/' . rawurlencode($item['paymentId']), $keyId, $keySecret);
    if (!$paymentRes['ok']) {
        jsonResponse(['success' => false, 'error' => $paymentRes['error']], $paymentRes['httpCode']);
    }
    $rzpPayment = $paymentRes['data'];

    $orderPaymentsRes = fetchRazorpayJson('/orders/' . rawurlencode($item['orderId']) . '/payments', $keyId, $keySecret);
    if (!$orderPaymentsRes['ok']) {
        jsonResponse(['success' => false, 'error' => $orderPaymentsRes['error']], $orderPaymentsRes['httpCode']);
    }
    $rzpOrderPayments = $orderPaymentsRes['data'];

    // Validate Order entity
    if (($rzpOrder['id'] ?? '') !== $item['orderId']) {
        jsonResponse(['success' => false, 'error' => "Razorpay order ID mismatch for {$item['orderId']}."], 400);
    }
    if ((int)($rzpOrder['amount'] ?? 0) !== 600 || strtoupper((string)($rzpOrder['currency'] ?? '')) !== 'INR') {
        jsonResponse([
            'success' => false,
            'error' => "Razorpay order {$item['orderId']} amount/currency mismatch (expected 600 INR).",
        ], 400);
    }

    $orderNotes = is_array($rzpOrder['notes'] ?? null) ? $rzpOrder['notes'] : [];
    $notePurpose = trim((string)($orderNotes['purpose'] ?? ''));
    $noteUserId = trim((string)($orderNotes['userId'] ?? ($orderNotes['user_id'] ?? '')));
    $noteVideoId = trim((string)($orderNotes['videoId'] ?? ($orderNotes['video_id'] ?? '')));
    $noteContentType = strtolower(trim((string)($orderNotes['contentType'] ?? ($orderNotes['content_type'] ?? ''))));

    if ($notePurpose !== 'premium_video_upload') {
        jsonResponse([
            'success' => false,
            'error' => "Razorpay order {$item['orderId']} notes.purpose mismatch (expected 'premium_video_upload', got '{$notePurpose}').",
        ], 400);
    }
    if ($noteUserId === '' || strcasecmp($noteUserId, $canonicalUserId) !== 0) {
        jsonResponse([
            'success' => false,
            'error' => "Razorpay order {$item['orderId']} notes.userId mismatch (expected '{$canonicalUserId}', got '{$noteUserId}').",
        ], 400);
    }
    if ($noteVideoId === '' || $noteVideoId !== $item['videoId']) {
        jsonResponse([
            'success' => false,
            'error' => "Razorpay order {$item['orderId']} notes.videoId mismatch (expected '{$item['videoId']}', got '{$noteVideoId}').",
        ], 400);
    }
    if ($noteContentType !== '' && $noteContentType !== $item['contentType']) {
        jsonResponse([
            'success' => false,
            'error' => "Razorpay order {$item['orderId']} notes.contentType mismatch (expected '{$item['contentType']}', got '{$noteContentType}').",
        ], 400);
    }

    // Validate Payment entity
    if (($rzpPayment['id'] ?? '') !== $item['paymentId']) {
        jsonResponse(['success' => false, 'error' => "Razorpay payment ID mismatch for {$item['paymentId']}."], 400);
    }
    if (($rzpPayment['order_id'] ?? '') !== $item['orderId']) {
        jsonResponse([
            'success' => false,
            'error' => "Razorpay payment {$item['paymentId']} does not belong to order {$item['orderId']}.",
        ], 400);
    }
    if (($rzpPayment['status'] ?? '') !== 'captured') {
        jsonResponse([
            'success' => false,
            'error' => "Razorpay payment {$item['paymentId']} is not captured (status: " . ($rzpPayment['status'] ?? 'unknown') . ').',
        ], 400);
    }
    if ((int)($rzpPayment['amount'] ?? 0) !== 600 || strtoupper((string)($rzpPayment['currency'] ?? '')) !== 'INR') {
        jsonResponse([
            'success' => false,
            'error' => "Razorpay payment {$item['paymentId']} amount/currency mismatch (expected 600 INR).",
        ], 400);
    }
    if ((int)($rzpPayment['amount_refunded'] ?? 0) > 0 || !empty($rzpPayment['refund_status'])) {
        jsonResponse([
            'success' => false,
            'error' => "Razorpay payment {$item['paymentId']} has refund activity (refund_status=" . ($rzpPayment['refund_status'] ?? '') . ').',
        ], 409);
    }

    $paymentNotes = is_array($rzpPayment['notes'] ?? null) ? $rzpPayment['notes'] : [];
    $pNoteUser = trim((string)($paymentNotes['userId'] ?? ($paymentNotes['user_id'] ?? '')));
    $pNoteVideo = trim((string)($paymentNotes['videoId'] ?? ($paymentNotes['video_id'] ?? '')));
    $pNotePurpose = trim((string)($paymentNotes['purpose'] ?? ''));
    $pNoteContentType = strtolower(trim((string)($paymentNotes['contentType'] ?? ($paymentNotes['content_type'] ?? ''))));
    if (
        ($pNoteUser !== '' && strcasecmp($pNoteUser, $canonicalUserId) !== 0) ||
        ($pNoteVideo !== '' && $pNoteVideo !== $item['videoId']) ||
        ($pNotePurpose !== '' && $pNotePurpose !== 'premium_video_upload') ||
        ($pNoteContentType !== '' && $pNoteContentType !== $item['contentType'])
    ) {
        jsonResponse([
            'success' => false,
            'error' => "Razorpay payment {$item['paymentId']} notes conflict with order/recovery item metadata.",
        ], 400);
    }

    // Validate Order->Payments collection (confirm target captured & no duplicate captured payments on same order)
    $orderPaymentItems = is_array($rzpOrderPayments['items'] ?? null) ? $rzpOrderPayments['items'] : [];
    $capturedIds = [];
    foreach ($orderPaymentItems as $op) {
        if (is_array($op) && ($op['status'] ?? '') === 'captured' && !empty($op['id'])) {
            $capturedIds[] = (string)$op['id'];
        }
    }
    if (!in_array($item['paymentId'], $capturedIds, true)) {
        jsonResponse([
            'success' => false,
            'error' => "Razorpay order {$item['orderId']} payments list does not show {$item['paymentId']} as captured.",
        ], 400);
    }
    if (count(array_unique($capturedIds)) > 1) {
        jsonResponse([
            'success' => false,
            'error' => "Razorpay order {$item['orderId']} has multiple captured payments (" . implode(', ', $capturedIds) . '); manual review required.',
        ], 409);
    }

    $paymentCreatedAt = (int)($rzpPayment['created_at'] ?? 0);
    $orderCreatedAt = (int)($rzpOrder['created_at'] ?? 0);

    $verifiedItems[] = array_merge($item, [
        'canonicalUserId' => $canonicalUserId,
        'creatorName' => $creatorName,
        'userUuidVerified' => (string)$userRow['id'],
        'referralCode' => trim((string)($userRow['referral_code'] ?? '')),
        'videoUrl' => toAbsoluteMediaUrl('/uploads/videos/' . $item['videoFilename'], 'videos'),
        'thumbnailUrl' => toAbsoluteMediaUrl('/uploads/images/' . $item['thumbnailFilename'], 'images'),
        'videoFileBytes' => $videoFileCheck['size'],
        'thumbnailFileBytes' => $thumbFileCheck['size'],
        'razorpayPaymentCreatedAt' => $paymentCreatedAt,
        'razorpayOrderCreatedAt' => $orderCreatedAt,
    ]);
}

// Enforce Long-first, then Short, and check Razorpay chronological order consistency
$maxLongTs = null;
$minShortTs = null;
foreach ($verifiedItems as $vi) {
    $ts = $vi['razorpayPaymentCreatedAt'];
    if ($ts > 0) {
        if ($vi['contentType'] === 'long') {
            $maxLongTs = ($maxLongTs === null) ? $ts : max($maxLongTs, $ts);
        } elseif ($vi['contentType'] === 'short') {
            $minShortTs = ($minShortTs === null) ? $ts : min($minShortTs, $ts);
        }
    }
}
if ($maxLongTs !== null && $minShortTs !== null && $minShortTs < $maxLongTs) {
    jsonResponse([
        'success' => false,
        'error' => "Chronological conflict: Short payment timestamp ({$minShortTs}) is earlier than Long payment timestamp ({$maxLongTs}).",
    ], 409);
}

usort($verifiedItems, static function ($a, $b) {
    $rankA = ($a['contentType'] === 'long') ? 0 : 1;
    $rankB = ($b['contentType'] === 'long') ? 0 : 1;
    if ($rankA !== $rankB) {
        return $rankA <=> $rankB;
    }
    return $a['razorpayPaymentCreatedAt'] <=> $b['razorpayPaymentCreatedAt'];
});

// Detect optional uploaded_videos columns via INFORMATION_SCHEMA (mirrors verify.php)
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
} catch (Throwable $eColCheck) {
    // Safe fallback if metadata query fails
}

function resolveAccountingForItem($pdo, $item, $txNumber, $hasAdEarningsCol, $hasIsBlockedCol, $simulatedExtraVideos = []) {
    $userId = $item['canonicalUserId'];
    $isSpecial = ($txNumber >= 11 && ($txNumber - 11) % 10 === 0);
    $specialTag = $isSpecial ? 'SPECIAL_GLOBAL_RULE' : 'NORMAL_PREMIUM';

    // Direct sponsor resolution (mirrors verify.php:373-391)
    $verifiedReferrerId = null;
    $refCode = $item['referralCode'];
    if ($refCode !== '') {
        $stmtRef = $pdo->prepare('
            SELECT user_id FROM users
            WHERE (UPPER(user_id) = UPPER(?) OR UPPER(referral_code) = UPPER(?))
              AND UPPER(user_id) != UPPER(?)
            LIMIT 1
        ');
        $stmtRef->execute([$refCode, $refCode, $userId]);
        $refMatch = $stmtRef->fetch(PDO::FETCH_ASSOC);
        if ($refMatch) {
            $verifiedReferrerId = (string)$refMatch['user_id'];
        }
    }

    // Admin user resolution (mirrors verify.php:394-396)
    $stmtAdmin = $pdo->query("SELECT user_id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1");
    $adminRow = $stmtAdmin ? $stmtAdmin->fetch(PDO::FETCH_ASSOC) : null;
    $adminUserId = ($adminRow && !empty($adminRow['user_id'])) ? (string)$adminRow['user_id'] : 'FT102857';

    $hasReferrer = !empty($verifiedReferrerId);
    $referralCommission = $hasReferrer ? 1.00 : 0.00;
    $unallocatedReferrerPaise = $hasReferrer ? 0 : 100;
    $creatorPayouts = [];

    if ($isSpecial) {
        $adminAllocation = $hasReferrer ? 4.00 : 5.00;
        $globalPoolAllocation = 0.00;
        $eligibleVideoCount = 0;
    } else {
        $baseAdminPaise = 100 + $unallocatedReferrerPaise;
        $adEarningsExpr = $hasAdEarningsCol ? 'COALESCE(ad_earnings, 0.00) AS ad_earnings' : '0.00 AS ad_earnings';
        $blockedFilter = $hasIsBlockedCol ? "\n                  AND (is_blocked = 0 OR is_blocked IS NULL)" : '';
        $stmtEligibleVideos = $pdo->prepare('
            SELECT id AS video_id, user_id, ' . $adEarningsExpr . '
            FROM uploaded_videos
            WHERE (video_type = "premium" OR payment_status = "paid")
              AND UPPER(user_id) != UPPER(?)' . $blockedFilter . '
            ORDER BY created_at ASC, id ASC
        ');
        $stmtEligibleVideos->execute([$userId]);
        $eligibleVideos = $stmtEligibleVideos->fetchAll(PDO::FETCH_ASSOC);

        foreach ($simulatedExtraVideos as $simVid) {
            if (strcasecmp((string)$simVid['user_id'], $userId) !== 0) {
                $eligibleVideos[] = $simVid;
            }
        }

        $eligibleVideoCount = count($eligibleVideos);
        if ($eligibleVideoCount === 0) {
            $adminPaise = $baseAdminPaise + 300;
            $adminAllocation = $adminPaise / 100;
            $globalPoolAllocation = 0.00;
        } else {
            $poolPaise = 300;
            $totalAdEarnings = 0.0;
            foreach ($eligibleVideos as $ev) {
                $totalAdEarnings += max(0.0, floatval($ev['ad_earnings'] ?? 0));
            }

            if ($totalAdEarnings > 0) {
                $allocatedPaise = 0;
                foreach ($eligibleVideos as $ev) {
                    $vEarnings = max(0.0, floatval($ev['ad_earnings'] ?? 0));
                    $weight = $vEarnings / $totalAdEarnings;
                    $amountPaise = intval(floor($weight * $poolPaise));
                    $allocatedPaise += $amountPaise;

                    $creatorPayouts[] = [
                        'userId' => (string)$ev['user_id'],
                        'videoId' => (string)$ev['video_id'],
                        'amount' => $amountPaise / 100,
                        'amountPaise' => $amountPaise,
                        'weight' => $weight,
                        'adEarnings' => $vEarnings,
                    ];
                }
                $residualPaise = max(0, $poolPaise - $allocatedPaise);
                $adminPaise = $baseAdminPaise + $residualPaise;
                $adminAllocation = $adminPaise / 100;
                $globalPoolAllocation = $allocatedPaise / 100;
            } else {
                $perVideoPaise = intdiv($poolPaise, $eligibleVideoCount);
                $distributedPaise = $perVideoPaise * $eligibleVideoCount;
                $residualPaise = $poolPaise - $distributedPaise;

                $adminPaise = $baseAdminPaise + $residualPaise;
                $adminAllocation = $adminPaise / 100;
                $globalPoolAllocation = $distributedPaise / 100;

                foreach ($eligibleVideos as $ev) {
                    $creatorPayouts[] = [
                        'userId' => (string)$ev['user_id'],
                        'videoId' => (string)$ev['video_id'],
                        'amount' => $perVideoPaise / 100,
                        'amountPaise' => $perVideoPaise,
                        'weight' => 1 / $eligibleVideoCount,
                        'adEarnings' => 0.0,
                    ];
                }
            }
        }
    }

    return [
        'txNumber' => $txNumber,
        'isSpecial' => $isSpecial,
        'specialTag' => $specialTag,
        'referrerId' => $verifiedReferrerId,
        'adminUserId' => $adminUserId,
        'referralCommission' => $referralCommission,
        'adminAllocation' => $adminAllocation,
        'globalPoolAllocation' => $globalPoolAllocation,
        'eligibleVideosCount' => $eligibleVideoCount,
        'creatorPayouts' => $creatorPayouts,
    ];
}

function inspectItemConflicts($pdo, $item, $forUpdate) {
    $lockSuffix = $forUpdate ? ' FOR UPDATE' : '';
    $conflicts = [];

    $stmtPo = $pdo->prepare('SELECT order_id, user_id, video_id, purpose, status, payment_id FROM payment_orders WHERE order_id = ?' . $lockSuffix);
    $stmtPo->execute([$item['orderId']]);
    $poRow = $stmtPo->fetch(PDO::FETCH_ASSOC);
    if ($poRow) {
        $poStatus = strtolower((string)($poRow['status'] ?? ''));
        $poPaymentId = trim((string)($poRow['payment_id'] ?? ''));
        if ($poStatus === 'paid' || ($poPaymentId !== '' && $poPaymentId !== $item['paymentId'])) {
            $conflicts[] = "payment_orders already has order {$item['orderId']} (status={$poStatus}, payment_id={$poPaymentId})";
        } elseif ($poStatus !== 'created') {
            $conflicts[] = "payment_orders has non-recoverable status '{$poStatus}' for order {$item['orderId']}";
        } elseif (
            strcasecmp((string)$poRow['user_id'], $item['canonicalUserId']) !== 0 ||
            (!empty($poRow['video_id']) && (string)$poRow['video_id'] !== $item['videoId']) ||
            ($poRow['purpose'] !== 'premium_video_upload')
        ) {
            $conflicts[] = "payment_orders row for {$item['orderId']} does not match customer/video/purpose";
        }
    }

    $stmtPt = $pdo->prepare('SELECT payment_id, order_id FROM payment_transactions WHERE payment_id = ? OR order_id = ?' . $lockSuffix);
    $stmtPt->execute([$item['paymentId'], $item['orderId']]);
    $ptRow = $stmtPt->fetch(PDO::FETCH_ASSOC);
    if ($ptRow) {
        $conflicts[] = "payment_transactions already contains payment_id={$ptRow['payment_id']} / order_id={$ptRow['order_id']}";
    }

    $stmtPrem = $pdo->prepare('SELECT id, tx_number, payment_id, order_id FROM premium_transactions WHERE payment_id = ? OR order_id = ?' . $lockSuffix);
    $stmtPrem->execute([$item['paymentId'], $item['orderId']]);
    $premRow = $stmtPrem->fetch(PDO::FETCH_ASSOC);
    if ($premRow) {
        $conflicts[] = "premium_transactions already contains payment_id={$premRow['payment_id']} / order_id={$premRow['order_id']} (tx_number={$premRow['tx_number']})";
    }

    $stmtVid = $pdo->prepare('SELECT id, payment_id, payment_status FROM uploaded_videos WHERE id = ? OR payment_id = ?' . $lockSuffix);
    $stmtVid->execute([$item['videoId'], $item['paymentId']]);
    $vidRow = $stmtVid->fetch(PDO::FETCH_ASSOC);
    if ($vidRow) {
        $conflicts[] = "uploaded_videos already contains id={$vidRow['id']} / payment_id={$vidRow['payment_id']}";
    }

    $stmtLed = $pdo->prepare('
        SELECT transaction_id
        FROM income_ledger
        WHERE transaction_id IN (?, ?) OR transaction_id LIKE ?
        ' . ($forUpdate ? 'FOR UPDATE' : '')
    );
    $stmtLed->execute([
        'TX_REF_' . $item['paymentId'],
        'TX_ADM_' . $item['paymentId'],
        'TX_GLB_' . $item['paymentId'] . '_%',
    ]);
    $ledRow = $stmtLed->fetch(PDO::FETCH_ASSOC);
    if ($ledRow) {
        $conflicts[] = "income_ledger already contains transaction_id={$ledRow['transaction_id']}";
    }

    return [
        'conflicts' => $conflicts,
        'existingOrderRow' => $poRow ?: null,
    ];
}

function resolveNextPremiumTxSequence($pdo, $forUpdate) {
    $lockSuffix = $forUpdate ? ' FOR UPDATE' : '';
    $stmtPtSeq = $pdo->query(
        "SELECT COUNT(*) AS total_tx, COUNT(DISTINCT tx_number) AS distinct_tx, COALESCE(MIN(tx_number), 0) AS min_tx, COALESCE(MAX(tx_number), 0) AS max_tx FROM payment_transactions WHERE purpose = 'premium_video_upload'" . $lockSuffix
    );
    $ptSeq = $stmtPtSeq ? $stmtPtSeq->fetch(PDO::FETCH_ASSOC) : ['total_tx' => 0, 'distinct_tx' => 0, 'min_tx' => 0, 'max_tx' => 0];

    $stmtPremSeq = $pdo->query(
        "SELECT COUNT(*) AS total_pt_tx, COALESCE(MIN(tx_number), 0) AS min_pt_tx, COALESCE(MAX(tx_number), 0) AS max_pt_tx, COALESCE(SUM(CASE WHEN id LIKE 'ptx-seed-%' OR payment_id LIKE 'pay_seed_hist_%' THEN 1 ELSE 0 END), 0) AS seed_row_count FROM premium_transactions" . $lockSuffix
    );
    $premSeq = $stmtPremSeq ? $stmtPremSeq->fetch(PDO::FETCH_ASSOC) : ['total_pt_tx' => 0, 'min_pt_tx' => 0, 'max_pt_tx' => 0, 'seed_row_count' => 0];

    $totalTx = (int)($ptSeq['total_tx'] ?? 0);
    $distinctTx = (int)($ptSeq['distinct_tx'] ?? 0);
    $minTx = (int)($ptSeq['min_tx'] ?? 0);
    $maxTx = (int)($ptSeq['max_tx'] ?? 0);

    $totalPtTx = (int)($premSeq['total_pt_tx'] ?? 0);
    $minPtTx = (int)($premSeq['min_pt_tx'] ?? 0);
    $maxPtTx = (int)($premSeq['max_pt_tx'] ?? 0);
    $seedRowCount = (int)($premSeq['seed_row_count'] ?? 0);

    $verifyExpectedNextTx = $totalTx + 1;
    $diagnostics = [
        'paymentTransactionsCount' => $totalTx,
        'paymentTransactionsDistinctTxCount' => $distinctTx,
        'paymentTransactionsMinTx' => $minTx,
        'paymentTransactionsMaxTx' => $maxTx,
        'verifyExpectedNextTxNumber' => $verifyExpectedNextTx,
        'premiumTransactionsCount' => $totalPtTx,
        'premiumTransactionsMinTx' => $minPtTx,
        'premiumTransactionsMaxTx' => $maxPtTx,
        'premiumTransactionsSeedRowCount' => $seedRowCount,
    ];

    if ($totalTx > 0 && ($distinctTx !== $totalTx || $minTx !== 1 || $maxTx !== $totalTx)) {
        return [
            'ok' => false,
            'status' => 409,
            'error' => "Transaction sequence conflict: payment_transactions has non-contiguous or duplicate tx_number values (count={$totalTx}, distinct={$distinctTx}, min={$minTx}, max={$maxTx}). Manual sequence review is required before recovery.",
            'diagnostics' => $diagnostics,
        ];
    }

    if ($maxPtTx > $maxTx) {
        $seedNotice = $seedRowCount > 0
            ? "including {$seedRowCount} seeded baseline row(s) up to tx_number {$maxPtTx}"
            : "with max tx_number {$maxPtTx}";
        return [
            'ok' => false,
            'status' => 409,
            'error' => "Transaction sequence conflict: premium_transactions has rows ahead of payment_transactions ({$seedNotice}), while payment_transactions has {$totalTx} premium_video_upload row(s) (verify.php next tx_number = {$verifyExpectedNextTx}). Recovery will not silently jump to tx_number " . ($maxPtTx + 1) . ' or invent a sequence number; manual review is required.',
            'diagnostics' => $diagnostics,
        ];
    }

    return [
        'ok' => true,
        'nextTxNumber' => $verifyExpectedNextTx,
        'diagnostics' => $diagnostics,
    ];
}

// -----------------------------------------------------------------------------
// DRY-RUN MODE (Default = true): Zero writes, full simulation & conflict audit
// -----------------------------------------------------------------------------
if ($dryRun) {
    try {
        $seqRes = resolveNextPremiumTxSequence($pdo, false);
        if (!$seqRes['ok']) {
            jsonResponse([
                'success' => false,
                'dryRun' => true,
                'manualReviewRequired' => true,
                'sequenceConflict' => true,
                'deploymentBlockerNotice' => 'Live writes remain disabled by default until verify.php shares GET_LOCK("facetube_premium_tx_seq").',
                'error' => $seqRes['error'],
                'sequenceDiagnostics' => $seqRes['diagnostics'],
            ], 409);
        }

        $baseNextTx = (int)$seqRes['nextTxNumber'];
        $simulatedExtraVideos = [];
        $results = [];
        $allConflicts = [];

        foreach ($verifiedItems as $idx => $item) {
            $simTxNumber = $baseNextTx + $idx;
            $check = inspectItemConflicts($pdo, $item, false);

            // Ensure simulated txNumber does not already exist in either table
            $stmtDupTxPt = $pdo->prepare('SELECT id FROM payment_transactions WHERE tx_number = ? AND purpose = "premium_video_upload" LIMIT 1');
            $stmtDupTxPt->execute([$simTxNumber]);
            $stmtDupTxPrem = $pdo->prepare('SELECT id FROM premium_transactions WHERE tx_number = ? LIMIT 1');
            $stmtDupTxPrem->execute([$simTxNumber]);
            if ($stmtDupTxPt->fetch() || $stmtDupTxPrem->fetch()) {
                $check['conflicts'][] = "tx_number {$simTxNumber} already exists";
            }

            $accounting = resolveAccountingForItem($pdo, $item, $simTxNumber, $hasAdEarningsCol, $hasIsBlockedCol, $simulatedExtraVideos);
            $simulatedExtraVideos[] = [
                'video_id' => $item['videoId'],
                'user_id' => $item['canonicalUserId'],
                'ad_earnings' => 0.0,
            ];

            if (!empty($check['conflicts'])) {
                foreach ($check['conflicts'] as $c) {
                    $allConflicts[] = "{$item['paymentId']}: {$c}";
                }
            }

            $results[] = [
                'status' => empty($check['conflicts']) ? 'dry_run_ready' : 'conflict',
                'orderSequence' => $idx + 1,
                'paymentId' => $item['paymentId'],
                'orderId' => $item['orderId'],
                'videoId' => $item['videoId'],
                'contentType' => $item['contentType'],
                'userId' => $item['canonicalUserId'],
                'userUuid' => $item['userUuidVerified'],
                'creatorName' => $item['creatorName'],
                'title' => $item['title'],
                'category' => $item['category'],
                'description' => $item['description'],
                'duration' => $item['duration'],
                'videoUrl' => $item['videoUrl'],
                'thumbnailUrl' => $item['thumbnailUrl'],
                'videoFileBytes' => $item['videoFileBytes'],
                'thumbnailFileBytes' => $item['thumbnailFileBytes'],
                'razorpayPaymentCreatedAt' => $item['razorpayPaymentCreatedAt'],
                'accounting' => $accounting,
                'conflicts' => $check['conflicts'],
            ];
        }

        if (!empty($allConflicts)) {
            jsonResponse([
                'success' => false,
                'dryRun' => true,
                'deploymentBlockerNotice' => 'Live writes remain disabled by default until verify.php shares GET_LOCK("facetube_premium_tx_seq").',
                'error' => 'Duplicate or partial recovery conflicts detected: ' . implode('; ', $allConflicts),
                'results' => $results,
            ], 409);
        }

        jsonResponse([
            'success' => true,
            'dryRun' => true,
            'deploymentBlockerNotice' => 'Live writes remain disabled by default until verify.php shares GET_LOCK("facetube_premium_tx_seq").',
            'message' => 'Dry-run verification and accounting simulation succeeded. Zero database writes were executed.',
            'processedCount' => count($results),
            'results' => $results,
        ], 200);
    } catch (PDOException $e) {
        error_log('[recover-premium-payment.php] Dry-run DB error: ' . $e->getMessage());
        jsonResponse([
            'success' => false,
            'dryRun' => true,
            'error' => 'Database error while running dry-run recovery checks. Zero database writes were executed.',
        ], 500);
    } catch (Throwable $e) {
        error_log('[recover-premium-payment.php] Dry-run unexpected error: ' . $e->getMessage());
        jsonResponse([
            'success' => false,
            'dryRun' => true,
            'error' => 'Unexpected server error while running dry-run recovery checks. Zero database writes were executed.',
        ], 500);
    }
}

// -----------------------------------------------------------------------------
// LIVE RECOVERY MODE (Only reachable when dryRun=false AND deployment blocker gate enabled)
// Acquires session-level GET_LOCK and processes Long first, then Short, in
// separate atomic transactions.
// -----------------------------------------------------------------------------
$lockName = 'facetube_premium_tx_seq';
try {
    $stmtAcquire = $pdo->prepare('SELECT GET_LOCK(?, 15) AS acquired');
    $stmtAcquire->execute([$lockName]);
    $lockRow = $stmtAcquire->fetch(PDO::FETCH_ASSOC);
} catch (PDOException $e) {
    error_log('[recover-premium-payment.php] GET_LOCK DB error: ' . $e->getMessage());
    jsonResponse([
        'success' => false,
        'dryRun' => false,
        'error' => 'Database error while acquiring premium transaction recovery lock. Zero database writes were executed.',
    ], 500);
} catch (Throwable $e) {
    error_log('[recover-premium-payment.php] GET_LOCK unexpected error: ' . $e->getMessage());
    jsonResponse([
        'success' => false,
        'dryRun' => false,
        'error' => 'Unexpected server error while acquiring premium transaction recovery lock. Zero database writes were executed.',
    ], 500);
}

if ((int)($lockRow['acquired'] ?? 0) !== 1) {
    jsonResponse([
        'success' => false,
        'dryRun' => false,
        'error' => 'Could not acquire premium transaction recovery lock. Another recovery or sequence operation is currently running.',
    ], 409);
}

$results = [];
$finalPayload = null;
$finalStatus = 200;

try {
    foreach ($verifiedItems as $idx => $item) {
        try {
            $pdo->beginTransaction();

            // 1. Acquire locks and verify idempotency across all 5 tables
            $check = inspectItemConflicts($pdo, $item, true);
            if (!empty($check['conflicts'])) {
                $pdo->rollBack();
                $finalStatus = 409;
                $finalPayload = [
                    'success' => false,
                    'dryRun' => false,
                    'error' => "Idempotency / duplicate conflict for {$item['paymentId']}: " . implode('; ', $check['conflicts']),
                    'committedSoFar' => $results,
                ];
                break;
            }

            // 2. Determine authoritative sequential tx_number under lock without inventing/skipping seeded gaps
            $seqRes = resolveNextPremiumTxSequence($pdo, true);
            if (!$seqRes['ok']) {
                $pdo->rollBack();
                $finalStatus = 409;
                $finalPayload = [
                    'success' => false,
                    'dryRun' => false,
                    'manualReviewRequired' => true,
                    'sequenceConflict' => true,
                    'error' => $seqRes['error'],
                    'sequenceDiagnostics' => $seqRes['diagnostics'],
                    'committedSoFar' => $results,
                ];
                break;
            }

            $txNumber = (int)$seqRes['nextTxNumber'];
            $stmtTxCheckPt = $pdo->prepare("SELECT id FROM payment_transactions WHERE tx_number = ? AND purpose = 'premium_video_upload' FOR UPDATE");
            $stmtTxCheckPt->execute([$txNumber]);
            $stmtTxCheckPrem = $pdo->prepare('SELECT id FROM premium_transactions WHERE tx_number = ? FOR UPDATE');
            $stmtTxCheckPrem->execute([$txNumber]);
            if ($stmtTxCheckPt->fetch() || $stmtTxCheckPrem->fetch()) {
                $pdo->rollBack();
                $finalStatus = 409;
                $finalPayload = [
                    'success' => false,
                    'dryRun' => false,
                    'manualReviewRequired' => true,
                    'sequenceConflict' => true,
                    'error' => "Transaction sequence conflict: tx_number {$txNumber} already exists.",
                    'committedSoFar' => $results,
                ];
                break;
            }

            // 3. Compute deterministic accounting matching verify.php
            $accounting = resolveAccountingForItem($pdo, $item, $txNumber, $hasAdEarningsCol, $hasIsBlockedCol);
            $isSpecial = $accounting['isSpecial'];
            $specialTag = $accounting['specialTag'];
            $verifiedReferrerId = $accounting['referrerId'];
            $adminUserId = $accounting['adminUserId'];
            $referralCommission = $accounting['referralCommission'];
            $adminAllocation = $accounting['adminAllocation'];
            $globalPoolAllocation = $accounting['globalPoolAllocation'];
            $creatorPayouts = $accounting['creatorPayouts'];

            $userId = $item['canonicalUserId'];
            $userName = $item['creatorName'];
            $videoId = $item['videoId'];
            $paymentId = $item['paymentId'];
            $orderId = $item['orderId'];
            $amount = $item['amount'];

            // 4. Insert into payment_transactions
            $stmtTx = $pdo->prepare('
                INSERT INTO payment_transactions (
                    order_id, payment_id, user_id, user_name, video_id, purpose, amount,
                    tx_number, is_special, special_tag, referral_commission, admin_allocation, global_pool_allocation,
                    created_at
                ) VALUES (
                    ?, ?, ?, ?, ?, "premium_video_upload", ?,
                    ?, ?, ?, ?, ?, ?,
                    NOW()
                )
            ');
            $stmtTx->execute([
                $orderId,
                $paymentId,
                $userId,
                $userName,
                $videoId,
                $amount,
                $txNumber,
                $isSpecial ? 1 : 0,
                $specialTag,
                $referralCommission,
                $adminAllocation,
                $globalPoolAllocation,
            ]);

            // 5. Insert into premium_transactions — DO NOT silently ignore errors (must propagate & rollback)
            $ptId = generateRecoveryUuid();
            $stmtPt = $pdo->prepare('
                INSERT INTO premium_transactions (
                    id, tx_number, payment_id, order_id, video_id, user_id, referrer_id,
                    amount, transaction_type, is_special, special_tag, referral_commission,
                    admin_allocation, global_pool_allocation, created_at
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?,
                    ?, "premium_upload", ?, ?, ?,
                    ?, ?, NOW()
                )
            ');
            $stmtPt->execute([
                $ptId,
                $txNumber,
                $paymentId,
                $orderId,
                $videoId,
                $userId,
                $verifiedReferrerId,
                $amount,
                $isSpecial ? 1 : 0,
                $specialTag,
                $referralCommission,
                $adminAllocation,
                $globalPoolAllocation,
            ]);

            // 6. Credit direct referral commission (₹1.00) if valid sponsor exists
            if (!empty($verifiedReferrerId) && $referralCommission > 0) {
                $txRefId = 'TX_REF_' . $paymentId;
                $ledgerUuid = generateRecoveryUuid();

                $stmtLedger = $pdo->prepare('
                    INSERT INTO income_ledger (
                        id, transaction_id, user_id, source_user_id, source_user_name, video_id,
                        income_type, amount, status, special_tag, description, created_at
                    ) VALUES (
                        ?, ?, ?, ?, ?, ?,
                        "referral_income", 1.0000, "settled", ?, ?, NOW()
                    )
                ');
                $stmtLedger->execute([
                    $ledgerUuid,
                    $txRefId,
                    $verifiedReferrerId,
                    $userId,
                    $userName,
                    $videoId,
                    $specialTag,
                    "Direct referral commission (₹1.00) for eligible Premium Video upload by {$userName} ({$userId})",
                ]);

                $stmtCredit = $pdo->prepare('
                    INSERT INTO wallet_balances (user_id, balance, total_earned, total_withdrawn, referral_income, global_income, adsense_income, affiliate_income, updated_at)
                    VALUES (?, 1.00, 1.00, 0.00, 1.00, 0.00, 0.00, 0.00, NOW())
                    ON DUPLICATE KEY UPDATE
                        balance = balance + 1.00,
                        total_earned = total_earned + 1.00,
                        referral_income = referral_income + 1.00,
                        updated_at = NOW()
                ');
                $stmtCredit->execute([$verifiedReferrerId]);
            }

            // 7. Credit Admin allocation
            if ($adminAllocation > 0) {
                $txAdmId = 'TX_ADM_' . $paymentId;
                $admLedgerUuid = generateRecoveryUuid();
                $admDesc = $isSpecial
                    ? "Admin Allocation (₹{$adminAllocation}) for Special Premium Video #{$txNumber} upload by {$userName} ({$userId})"
                    : "Admin Allocation (₹{$adminAllocation}) for Premium Video #{$txNumber} upload by {$userName} ({$userId})";

                $stmtAdmLedger = $pdo->prepare('
                    INSERT INTO income_ledger (
                        id, transaction_id, user_id, source_user_id, source_user_name, video_id,
                        income_type, amount, status, special_tag, description, created_at
                    ) VALUES (
                        ?, ?, ?, ?, ?, ?,
                        "admin_allocation", ?, "settled", ?, ?, NOW()
                    )
                ');
                $stmtAdmLedger->execute([
                    $admLedgerUuid,
                    $txAdmId,
                    $adminUserId,
                    $userId,
                    $userName,
                    $videoId,
                    $adminAllocation,
                    $specialTag,
                    $admDesc,
                ]);

                $stmtCreditAdmin = $pdo->prepare('
                    INSERT INTO wallet_balances (user_id, balance, total_earned, total_withdrawn, referral_income, global_income, adsense_income, affiliate_income, updated_at)
                    VALUES (?, ?, ?, 0.00, 0.00, 0.00, 0.00, 0.00, NOW())
                    ON DUPLICATE KEY UPDATE
                        balance = balance + VALUES(balance),
                        total_earned = total_earned + VALUES(total_earned),
                        updated_at = NOW()
                ');
                $stmtCreditAdmin->execute([$adminUserId, $adminAllocation, $adminAllocation]);
            }

            // 8. Credit Global Pool creators
            if (!empty($creatorPayouts)) {
                $stmtGlbLedger = $pdo->prepare('
                    INSERT INTO income_ledger (
                        id, transaction_id, user_id, source_user_id, source_user_name, video_id,
                        income_type, amount, status, special_tag, description, created_at
                    ) VALUES (
                        ?, ?, ?, ?, ?, ?,
                        "global_income", ?, "settled", ?, ?, NOW()
                    )
                ');
                $stmtCreditCreator = $pdo->prepare('
                    INSERT INTO wallet_balances (user_id, balance, total_earned, total_withdrawn, referral_income, global_income, adsense_income, affiliate_income, updated_at)
                    VALUES (?, ?, ?, 0.00, 0.00, ?, 0.00, 0.00, NOW())
                    ON DUPLICATE KEY UPDATE
                        balance = balance + VALUES(balance),
                        total_earned = total_earned + VALUES(total_earned),
                        global_income = global_income + VALUES(global_income),
                        updated_at = NOW()
                ');

                foreach ($creatorPayouts as $payout) {
                    if ($payout['amount'] <= 0) {
                        continue;
                    }
                    $txGlbId = "TX_GLB_{$paymentId}_{$payout['videoId']}";
                    $glbUuid = generateRecoveryUuid();
                    $glbDesc = "Per-Video Ads Earnings Share for video #{$payout['videoId']} (₹{$payout['amount']} share of ₹3 pool for Premium Video #{$txNumber})";

                    $stmtGlbLedger->execute([
                        $glbUuid,
                        $txGlbId,
                        $payout['userId'],
                        $userId,
                        $userName,
                        $payout['videoId'],
                        $payout['amount'],
                        $specialTag,
                        $glbDesc,
                    ]);

                    $stmtCreditCreator->execute([
                        $payout['userId'],
                        $payout['amount'],
                        $payout['amount'],
                        $payout['amount'],
                    ]);
                }
            }

            // 9. Insert recovered video into uploaded_videos
            $stmtVideo = $pdo->prepare('
                INSERT INTO uploaded_videos (
                    id, user_id, creator_name, title, description, video_url, thumbnail_url,
                    video_type, content_type, category, duration, views, likes,
                    payment_status, payment_id, payment_amount, is_promoted,
                    created_at, updated_at
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?,
                    "premium", ?, ?, ?, 0, 0,
                    "paid", ?, ?, 0,
                    NOW(), NOW()
                )
            ');
            $stmtVideo->execute([
                $videoId,
                $userId,
                $userName,
                $item['title'],
                $item['description'],
                $item['videoUrl'],
                $item['thumbnailUrl'],
                $item['contentType'],
                $item['category'],
                $item['duration'],
                $paymentId,
                $amount,
            ]);

            // 10. Upsert / mark payment_orders as paid
            if (!empty($check['existingOrderRow'])) {
                $stmtPoUpdate = $pdo->prepare('
                    UPDATE payment_orders
                    SET status = "paid", payment_id = ?, updated_at = NOW()
                    WHERE order_id = ?
                ');
                $stmtPoUpdate->execute([$paymentId, $orderId]);
            } else {
                $stmtPoInsert = $pdo->prepare('
                    INSERT INTO payment_orders (
                        order_id, user_id, user_name, video_id, purpose, plan_id,
                        content_type, amount, currency, status, payment_id,
                        created_at, updated_at
                    ) VALUES (
                        ?, ?, ?, ?, "premium_video_upload", NULL,
                        ?, ?, "INR", "paid", ?,
                        NOW(), NOW()
                    )
                ');
                $stmtPoInsert->execute([
                    $orderId,
                    $userId,
                    $userName,
                    $videoId,
                    $item['contentType'],
                    $amount,
                    $paymentId,
                ]);
            }

            $pdo->commit();

            $results[] = [
                'status' => 'recovered',
                'orderSequence' => $idx + 1,
                'paymentId' => $paymentId,
                'orderId' => $orderId,
                'videoId' => $videoId,
                'contentType' => $item['contentType'],
                'userId' => $userId,
                'title' => $item['title'],
                'category' => $item['category'],
                'accounting' => $accounting,
            ];
        } catch (PDOException $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            $isDup = ($e->getCode() === '23000' || str_contains($e->getMessage(), '1062') || str_contains($e->getMessage(), 'Duplicate entry'));
            $finalStatus = $isDup ? 409 : 500;
            error_log('[recover-premium-payment.php] DB error for ' . $item['paymentId'] . ': ' . $e->getMessage());
            $finalPayload = [
                'success' => false,
                'dryRun' => false,
                'error' => $isDup
                    ? "Duplicate key conflict during recovery for {$item['paymentId']}. Transaction rolled back cleanly."
                    : "Database error during recovery for {$item['paymentId']}. Transaction rolled back cleanly.",
                'committedSoFar' => $results,
            ];
            break;
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            error_log('[recover-premium-payment.php] Error for ' . $item['paymentId'] . ': ' . $e->getMessage());
            $finalStatus = 500;
            $finalPayload = [
                'success' => false,
                'dryRun' => false,
                'error' => "Recovery failed for {$item['paymentId']}. Transaction rolled back cleanly.",
                'committedSoFar' => $results,
            ];
            break;
        }
    }

    if ($finalPayload === null) {
        $finalStatus = 200;
        $finalPayload = [
            'success' => true,
            'dryRun' => false,
            'message' => 'Premium video payments recovered sequentially and atomically.',
            'processedCount' => count($results),
            'results' => $results,
        ];
    }
} finally {
    try {
        $stmtRel = $pdo->prepare('DO RELEASE_LOCK(?)');
        $stmtRel->execute([$lockName]);
    } catch (Throwable $eRel) {
        // Ignore cleanup failure
    }
}

jsonResponse($finalPayload, $finalStatus);
