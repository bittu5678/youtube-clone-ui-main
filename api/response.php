<?php
/**
 * FaceTube - Universal JSON Response & Helper Functions
 * Standardized response envelope, CORS handling, and Bearer token parsing
 */

// Enable CORS restricted to approved FaceTube frontend origins
function handleCors() {
    $allowedOrigins = [
        'https://facetube.online',
        'https://www.facetube.online',
    ];

    // Allow local development origins only when an explicit development environment is set
    $appEnv = strtolower(trim((string)(getenv('APP_ENV') ?: ($_ENV['APP_ENV'] ?? ($_SERVER['APP_ENV'] ?? '')))));
    if (in_array($appEnv, ['development', 'dev', 'local', 'test'], true)) {
        $allowedOrigins[] = 'http://localhost:3000';
        $allowedOrigins[] = 'http://127.0.0.1:3000';
    }

    $origin = trim($_SERVER['HTTP_ORIGIN'] ?? '');
    $isOptions = isset($_SERVER['REQUEST_METHOD']) && $_SERVER['REQUEST_METHOD'] === 'OPTIONS';

    // 1. If Origin header is present, enforce strict origin matching
    if (!empty($origin)) {
        $normalizedOrigin = strtolower($origin);
        if (in_array($normalizedOrigin, $allowedOrigins, true)) {
            // Approved origin: emit standard CORS headers
            header("Access-Control-Allow-Origin: {$origin}");
            header('Vary: Origin');
            header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
            header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Authorization, x-authorization, X-Requested-With, Accept, Origin');
            header('Access-Control-Allow-Credentials: true');
            header('Access-Control-Max-Age: 86400');

            if ($isOptions) {
                http_response_code(204);
                exit;
            }
        } else {
            // Unapproved origin: cleanly omit Access-Control-Allow-Origin
            header('Vary: Origin');
            if ($isOptions) {
                http_response_code(403);
                header('Content-Type: application/json; charset=utf-8');
                echo json_encode([
                    'success' => false,
                    'error' => 'CORS origin denied by policy.'
                ], JSON_UNESCAPED_SLASHES);
                exit;
            }
        }
    } else {
        // 2. Request without Origin header (server-to-server, mobile app, cURL, or same-origin)
        if ($isOptions) {
            header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
            header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Authorization, x-authorization, X-Requested-With, Accept, Origin');
            http_response_code(204);
            exit;
        }
    }
}

handleCors();

function jsonResponse($data, $statusCode = 200) {
    http_response_code($statusCode);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function getRequestPayload() {
    $raw = file_get_contents('php://input');
    if (!empty($raw)) {
        $json = json_decode($raw, true);
        if (json_last_error() === JSON_ERROR_NONE && is_array($json)) {
            return $json;
        }
    }
    return $_POST ?: [];
}

function getBearerToken() {
    $headerCandidates = [
        $_SERVER['HTTP_AUTHORIZATION'] ?? null,
        $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? null,
        $_SERVER['REDIRECT_REDIRECT_HTTP_AUTHORIZATION'] ?? null,
        $_SERVER['Authorization'] ?? null,
        $_SERVER['HTTP_X_AUTHORIZATION'] ?? null,
        $_SERVER['REDIRECT_HTTP_X_AUTHORIZATION'] ?? null,
        $_SERVER['X-Authorization'] ?? null,
    ];

    foreach ($headerCandidates as $candidate) {
        if (!empty($candidate)) {
            $trimmed = trim((string)$candidate);
            if (preg_match('/Bearer\s+(\S+)/i', $trimmed, $matches)) {
                return $matches[1];
            }
        }
    }

    // Inspect headers via getallheaders() or apache_request_headers() case-insensitively
    $requestHeaders = [];
    if (function_exists('getallheaders')) {
        $requestHeaders = getallheaders() ?: [];
    } elseif (function_exists('apache_request_headers')) {
        $requestHeaders = apache_request_headers() ?: [];
    }

    if (!empty($requestHeaders) && is_array($requestHeaders)) {
        foreach ($requestHeaders as $key => $val) {
            if (strcasecmp($key, 'Authorization') === 0 || strcasecmp($key, 'X-Authorization') === 0) {
                $trimmed = trim((string)$val);
                if (preg_match('/Bearer\s+(\S+)/i', $trimmed, $matches)) {
                    return $matches[1];
                }
            }
        }
    }

    // Fallback check on getenv for direct FastCGI process environment variables
    $envAuth = getenv('HTTP_AUTHORIZATION') ?: (getenv('REDIRECT_HTTP_AUTHORIZATION') ?: getenv('HTTP_X_AUTHORIZATION'));
    if (!empty($envAuth)) {
        $trimmed = trim((string)$envAuth);
        if (preg_match('/Bearer\s+(\S+)/i', $trimmed, $matches)) {
            return $matches[1];
        }
    }

    return null;
}

function getAuthUser($pdo) {
    $token = getBearerToken();
    if (!$token) {
        return null;
    }

    try {
        $stmt = $pdo->prepare('
            SELECT u.id, u.user_id, u.name, u.mobile, u.email, u.role, u.referral_code, u.avatar_url, u.created_at
            FROM sessions s
            INNER JOIN users u ON (s.user_id = u.id OR s.user_id = u.user_id)
            WHERE s.token = ? AND s.expires_at > NOW()
            LIMIT 1
        ');
        $stmt->execute([trim($token)]);
        return $stmt->fetch() ?: null;
    } catch (Exception $e) {
        return null;
    }
}

/**
 * Enforces session authentication and authorization.
 * Returns authenticated user array and resolved target user_id.
 * If targetUserId is requested:
 * - If target matches the auth user, returns target.
 * - If auth user is role='admin', permits cross-user access to target.
 * - Otherwise rejects with 403 Forbidden.
 */
function requireAuthUser($pdo, $requestedUserId = null) {
    $authUser = getAuthUser($pdo);
    if (!$authUser) {
        jsonResponse([
            'success' => false,
            'error' => 'Authentication required. Please provide a valid Bearer session token.'
        ], 401);
    }

    $effectiveUserId = $authUser['user_id'];

    if (!empty($requestedUserId)) {
        $req = trim($requestedUserId);
        if (strcasecmp($req, $authUser['user_id']) === 0) {
            $effectiveUserId = $authUser['user_id'];
        } else {
            // Cross-user requested: strictly require admin role
            $isAdmin = isset($authUser['role']) && strtolower($authUser['role']) === 'admin';
            if (!$isAdmin) {
                jsonResponse([
                    'success' => false,
                    'error' => 'Unauthorized: Cross-user access is restricted to verified administrators.'
                ], 403);
            }
            $effectiveUserId = $req;
        }
    }

    return [$authUser, $effectiveUserId];
}

/**
 * Returns the public base URL for the FaceTube API / Media server.
 * Uses environment variables, incoming request headers, or falls back to production domain.
 */
function getApiBaseUrl() {
    $envBase = getenv('FACETUBE_API_BASE_URL') ?: (getenv('API_BASE_URL') ?: ($_ENV['FACETUBE_API_BASE_URL'] ?? ($_ENV['API_BASE_URL'] ?? null)));
    if (!empty($envBase)) {
        return rtrim($envBase, '/');
    }

    $host = $_SERVER['HTTP_HOST'] ?? ($_SERVER['SERVER_NAME'] ?? '');
    if (!empty($host)) {
        $protocol = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (isset($_SERVER['SERVER_PORT']) && $_SERVER['SERVER_PORT'] == 443) ? 'https://' : 'http://';
        if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && strtolower($_SERVER['HTTP_X_FORWARDED_PROTO']) === 'https') {
            $protocol = 'https://';
        }
        return rtrim($protocol . $host, '/');
    }

    return 'https://api.facetube.online';
}

/**
 * Converts any relative media path (e.g. /uploads/videos/vid_123.mp4)
 * to an absolute public URL on the API / Media server domain.
 * Guards against duplicated domains, handles data URIs, and preserves external links.
 */
function toAbsoluteMediaUrl($path, $subfolder = 'videos') {
    if (empty($path) || !is_string($path)) {
        return '';
    }
    $path = trim($path);
    if ($path === '' || $path === 'null' || $path === 'undefined') {
        return '';
    }

    // Already a data URL, blob, or asset
    if (preg_match('/^(data:|blob:)/i', $path)) {
        return $path;
    }

    // Fix accidental double domain prefix: https://api.facetube.onlinehttps://api.facetube.online/...
    if (preg_match('/^(https?:\/\/[^\/]+)(https?:\/\/.+)$/i', $path, $matches)) {
        return toAbsoluteMediaUrl($matches[2], $subfolder);
    }

    // Already an absolute HTTP(S) URL
    if (preg_match('/^https?:\/\//i', $path)) {
        return $path;
    }

    $baseUrl = getApiBaseUrl();
    $cleanPath = ltrim($path, '/');

    if (str_starts_with($cleanPath, 'uploads/')) {
        return $baseUrl . '/' . $cleanPath;
    }

    return $baseUrl . '/uploads/' . $subfolder . '/' . $cleanPath;
}

/**
 * Returns an array of physical storage directories for uploaded media.
 * The first entry is the primary web-accessible location on Hostinger/cPanel.
 * Other entries serve as mirrors to keep the dev environment and docroots in sync.
 */
function getMediaStorageDirectories($subfolder = 'videos') {
    $dirs = [];

    // 1. Hostinger subdomain docroot: api/uploads/$subfolder/
    // Since __DIR__ is the api/ directory, __DIR__ . '/uploads/' . $subfolder . '/' is inside docroot.
    $apiUploadsDir = __DIR__ . '/uploads/' . $subfolder . '/';
    $dirs[] = $apiUploadsDir;

    // 2. Document root from server if defined
    if (!empty($_SERVER['DOCUMENT_ROOT'])) {
        $docRoot = rtrim($_SERVER['DOCUMENT_ROOT'], '/\\');
        $docUploadsDir = $docRoot . '/uploads/' . $subfolder . '/';
        if (!in_array($docUploadsDir, $dirs, true)) {
            $dirs[] = $docUploadsDir;
        }
    }

    // 3. Project root uploads/ directory (for local dev server / monorepo layout)
    $rootUploadsDir = dirname(__DIR__) . '/uploads/' . $subfolder . '/';
    if (!in_array($rootUploadsDir, $dirs, true)) {
        $dirs[] = $rootUploadsDir;
    }

    return $dirs;
}

/**
 * Ensures media storage directories exist with safe permissions (0755).
 * Returns the primary writable directory, or false if creation failed.
 */
function ensureMediaStorageDir($subfolder = 'videos') {
    $dirs = getMediaStorageDirectories($subfolder);
    $primaryDir = $dirs[0];

    foreach ($dirs as $dir) {
        if (!is_dir($dir)) {
            @mkdir($dir, 0755, true);
        }
    }

    if (!is_dir($primaryDir) || !is_writable($primaryDir)) {
        // Fallback to any writable directory in the list
        foreach ($dirs as $dir) {
            if (is_dir($dir) && is_writable($dir)) {
                return $dir;
            }
        }
        return false;
    }

    return $primaryDir;
}

/**
 * Normalizes and validates video visibility ('public' | 'unlisted' | 'private').
 * Returns null if an invalid non-empty value is supplied.
 */
function normalizeVideoVisibility($raw, $default = 'public') {
    if ($raw === null) {
        return $default;
    }
    $val = strtolower(trim((string)$raw));
    if ($val === '') {
        return $default;
    }
    if (in_array($val, ['public', 'unlisted', 'private'], true)) {
        return $val;
    }
    return null;
}

/**
 * Enforces approved FaceTube company visibility rules:
 * 1. Free videos: public, unlisted, private
 * 2. Paid Premium videos: public, unlisted only
 * 3. Sponsored / Global Pool eligible videos: public only
 */
function validateVideoVisibilityRules($visibility, $videoType, $paymentStatus, $isPromoted = false, $isSponsored = false, $globalPoolEligible = false) {
    if ($isPromoted || $isSponsored || $globalPoolEligible) {
        if ($visibility !== 'public') {
            return 'Sponsored and Global Pool eligible videos must use \'public\' visibility.';
        }
        return null;
    }

    if ($videoType === 'premium' || $paymentStatus === 'paid') {
        if ($visibility === 'private') {
            return 'Paid Premium videos can only use \'public\' or \'unlisted\' visibility.';
        }
        return null;
    }

    return null;
}

/**
 * Checks whether uploaded_videos.visibility exists in the active schema.
 */
function hasUploadedVideosVisibilityColumn($pdo) {
    static $cached = null;
    if ($cached !== null) {
        return $cached;
    }
    try {
        $stmt = $pdo->query("
            SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'uploaded_videos'
              AND COLUMN_NAME = 'visibility'
        ");
        $cached = ($stmt && $stmt->fetchColumn() !== false);
    } catch (Exception $e) {
        $cached = false;
    }
    return $cached;
}

function getPrivateStorageRoot() {
    return __DIR__ . '/storage/';
}

function ensurePrivateStorageHtaccess() {
    $root = getPrivateStorageRoot();
    if (!is_dir($root)) {
        @mkdir($root, 0755, true);
    }
    $htaccessPath = $root . '.htaccess';
    if (!file_exists($htaccessPath)) {
        $rules = "<IfModule mod_authz_core.c>\n    Require all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\n    Order allow,deny\n    Deny from all\n</IfModule>\nOptions -Indexes\n";
        @file_put_contents($htaccessPath, $rules);
    }
}

function ensurePrivateMediaDir($subfolder = 'videos') {
    ensurePrivateStorageHtaccess();
    $dir = getPrivateStorageRoot() . 'private_' . $subfolder . '/';
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
    return (is_dir($dir) && is_writable($dir)) ? $dir : false;
}

function getMediaSigningSecret() {
    foreach (['FACETUBE_MEDIA_SECRET', 'ADMOB_ENCRYPTION_KEY', 'RAZORPAY_KEY_SECRET'] as $envKey) {
        $val = getenv($envKey) ?: ($_ENV[$envKey] ?? ($_SERVER[$envKey] ?? ''));
        if (is_string($val) && strlen(trim($val)) >= 16) {
            return trim($val);
        }
    }
    ensurePrivateStorageHtaccess();
    $keyFile = getPrivateStorageRoot() . '.media_signing_key';
    if (file_exists($keyFile) && is_readable($keyFile)) {
        $existing = trim((string)@file_get_contents($keyFile));
        if (strlen($existing) >= 32) {
            return $existing;
        }
    }
    $generated = bin2hex(random_bytes(32));
    @file_put_contents($keyFile, $generated);
    @chmod($keyFile, 0600);
    return $generated;
}

function signPrivateMediaUrl($videoId, $kind = 'video', $ttlSeconds = 600) {
    $exp = time() + max(60, intval($ttlSeconds));
    $sig = hash_hmac('sha256', "media:{$videoId}:{$kind}:{$exp}", getMediaSigningSecret());
    $baseUrl = getApiBaseUrl();
    $apiPrefix = str_ends_with(strtolower($baseUrl), '/api') ? $baseUrl : $baseUrl . '/api';
    if (str_contains(strtolower($baseUrl), 'api.facetube.online') && !str_ends_with(strtolower($baseUrl), '/api')) {
        $apiPrefix = $baseUrl;
    }
    return $apiPrefix . '/videos/media.php?id=' . rawurlencode((string)$videoId) . '&kind=' . rawurlencode($kind) . '&exp=' . $exp . '&sig=' . $sig;
}

function verifyPrivateMediaSignature($videoId, $kind, $expRaw, $sigRaw) {
    if ($expRaw === null || $sigRaw === null || $expRaw === '' || $sigRaw === '') {
        return false;
    }
    if (!ctype_digit((string)$expRaw)) {
        return false;
    }
    $exp = intval($expRaw);
    if ($exp <= time()) {
        return false;
    }
    $expected = hash_hmac('sha256', "media:{$videoId}:{$kind}:{$exp}", getMediaSigningSecret());
    return hash_equals($expected, trim((string)$sigRaw));
}

function extractLocalUploadRef($url) {
    if (empty($url) || !is_string($url)) {
        return null;
    }
    $trimmed = trim($url);
    $path = $trimmed;
    if (preg_match('/^https?:\/\//i', $trimmed)) {
        $parts = @parse_url($trimmed);
        $host = strtolower((string)($parts['host'] ?? ''));
        $isAllowedHost = in_array($host, ['localhost', '127.0.0.1', 'facetube.online', 'www.facetube.online', 'api.facetube.online'], true)
            || str_ends_with($host, '.facetube.online');
        if (!$isAllowedHost) {
            return null;
        }
        $path = (string)($parts['path'] ?? '');
    }
    $path = str_replace('\\', '/', $path);
    if (preg_match('/^\/?(?:api\/)?uploads\/(videos|images)\/([^\/?#]+)$/i', $path, $m)) {
        $fileName = basename(rawurldecode($m[2]));
        if ($fileName === '' || $fileName === '.' || $fileName === '..' || str_contains($fileName, '..')) {
            return null;
        }
        return ['subfolder' => strtolower($m[1]), 'fileName' => $fileName];
    }
    return null;
}

function extractPrivateMediaRef($url) {
    if (empty($url) || !is_string($url)) {
        return null;
    }
    $trimmed = trim($url);
    if (!str_starts_with($trimmed, 'private_media://')) {
        return null;
    }
    $rel = substr($trimmed, strlen('private_media://'));
    if (preg_match('/^(videos|images)\/([^\/?#]+)$/i', $rel, $m)) {
        $fileName = basename($m[2]);
        if ($fileName === '' || $fileName === '.' || $fileName === '..' || str_contains($fileName, '..')) {
            return null;
        }
        return ['subfolder' => strtolower($m[1]), 'fileName' => $fileName];
    }
    return null;
}

function moveLocalMediaToPrivate($url, $expectedSubfolder = 'videos') {
    if (extractPrivateMediaRef($url) !== null) {
        return trim((string)$url);
    }
    $ref = extractLocalUploadRef($url);
    if ($ref === null) {
        return $url;
    }
    $subfolder = $ref['subfolder'] ?: $expectedSubfolder;
    $fileName = $ref['fileName'];
    $privateDir = ensurePrivateMediaDir($subfolder);
    if ($privateDir) {
        $privatePath = $privateDir . $fileName;
        $publicDirs = getMediaStorageDirectories($subfolder);
        $copied = file_exists($privatePath);
        foreach ($publicDirs as $pubDir) {
            $pubFile = $pubDir . $fileName;
            if (is_file($pubFile)) {
                if (!$copied) {
                    if (@rename($pubFile, $privatePath)) {
                        $copied = true;
                        continue;
                    }
                    if (@copy($pubFile, $privatePath)) {
                        $copied = true;
                    }
                }
                @unlink($pubFile);
            }
        }
    }
    return 'private_media://' . $subfolder . '/' . $fileName;
}

function restorePrivateMediaToPublic($privateRef) {
    $ref = extractPrivateMediaRef($privateRef);
    if ($ref === null) {
        return $privateRef;
    }
    $subfolder = $ref['subfolder'];
    $fileName = $ref['fileName'];
    $privatePath = getPrivateStorageRoot() . 'private_' . $subfolder . '/' . $fileName;
    $publicDir = ensureMediaStorageDir($subfolder);
    if ($publicDir && is_file($privatePath)) {
        $target = $publicDir . $fileName;
        if (!@rename($privatePath, $target)) {
            if (@copy($privatePath, $target)) {
                @unlink($privatePath);
            }
        }
        $allDirs = getMediaStorageDirectories($subfolder);
        foreach ($allDirs as $otherDir) {
            if ($otherDir !== $publicDir && is_dir($otherDir) && is_writable($otherDir) && is_file($target)) {
                @copy($target, $otherDir . $fileName);
            }
        }
    }
    return toAbsoluteMediaUrl('/uploads/' . $subfolder . '/' . $fileName, $subfolder);
}

function resolveVideoMediaOutputUrl($storedUrl, $videoId, $visibility, $kind, $canAccessPrivate) {
    $raw = trim((string)($storedUrl ?? ''));
    if ($raw === '') {
        return '';
    }
    if (extractPrivateMediaRef($raw) !== null) {
        if (!$canAccessPrivate) {
            return '';
        }
        return signPrivateMediaUrl($videoId, $kind);
    }
    if ($visibility === 'private' && !$canAccessPrivate) {
        return '';
    }
    return toAbsoluteMediaUrl($raw, $kind === 'thumbnail' ? 'images' : 'videos');
}

function resolvePrivateMediaFilePath($storedUrl) {
    $ref = extractPrivateMediaRef($storedUrl);
    if ($ref === null) {
        $ref = extractLocalUploadRef($storedUrl);
    }
    if ($ref === null) {
        return null;
    }
    $subfolder = $ref['subfolder'];
    $fileName = $ref['fileName'];
    $privCandidate = getPrivateStorageRoot() . 'private_' . $subfolder . '/' . $fileName;
    if (is_file($privCandidate)) {
        return $privCandidate;
    }
    foreach (getMediaStorageDirectories($subfolder) as $pubDir) {
        $pubCandidate = $pubDir . $fileName;
        if (is_file($pubCandidate)) {
            return $pubCandidate;
        }
    }
    return null;
}

function streamMediaFileWithRange($filePath) {
    $fileSize = filesize($filePath);
    $ext = strtolower(pathinfo($filePath, PATHINFO_EXTENSION));
    $mimeMap = [
        'mp4' => 'video/mp4',
        'm4v' => 'video/mp4',
        'webm' => 'video/webm',
        'ogg' => 'video/ogg',
        'ogv' => 'video/ogg',
        'mov' => 'video/quicktime',
        'mkv' => 'video/x-matroska',
        'jpg' => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'png' => 'image/png',
        'webp' => 'image/webp',
        'gif' => 'image/gif',
    ];
    $contentType = $mimeMap[$ext] ?? 'application/octet-stream';

    header('Accept-Ranges: bytes');
    header('Cache-Control: private, no-store, no-cache, must-revalidate');
    header('X-Content-Type-Options: nosniff');
    header('Content-Type: ' . $contentType);

    $rangeHeader = $_SERVER['HTTP_RANGE'] ?? '';
    $start = 0;
    $end = $fileSize - 1;
    $status = 200;

    if (!empty($rangeHeader) && preg_match('/bytes=(\d*)-(\d*)/i', $rangeHeader, $m)) {
        $start = $m[1] !== '' ? intval($m[1]) : 0;
        $end = $m[2] !== '' ? intval($m[2]) : ($fileSize - 1);
        if ($end >= $fileSize) {
            $end = $fileSize - 1;
        }
        if ($start > $end || $start >= $fileSize) {
            http_response_code(416);
            header("Content-Range: bytes */{$fileSize}");
            exit;
        }
        $status = 206;
        header("Content-Range: bytes {$start}-{$end}/{$fileSize}");
    }

    $length = $end - $start + 1;
    http_response_code($status);
    header('Content-Length: ' . $length);

    $fp = @fopen($filePath, 'rb');
    if (!$fp) {
        http_response_code(500);
        exit;
    }
    if ($start > 0) {
        fseek($fp, $start);
    }
    $remaining = $length;
    while ($remaining > 0 && !feof($fp)) {
        $chunkSize = min(65536, $remaining);
        $buffer = fread($fp, $chunkSize);
        if ($buffer === false) {
            break;
        }
        echo $buffer;
        $remaining -= strlen($buffer);
    }
    fclose($fp);
    exit;
}


