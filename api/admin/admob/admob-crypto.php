<?php
/**
 * FaceTube - AdMob OAuth Cryptography & Token Protection Helper
 *
 * Implements:
 * 1. Cryptographically secure OAuth state generation & CSRF verification
 * 2. AES-256-GCM encryption & decryption for Google OAuth refresh tokens
 * 3. Configuration loaders for server-side OAuth credentials
 */

require_once __DIR__ . '/../../config/database.php';
require_once __DIR__ . '/../../response.php';

/**
 * Fail-closed production environment detection matching Node isFailClosedProductionEnv.
 */
function isAdmobProductionEnv() {
    $rawAppEnv = getenv('APP_ENV');
    if ($rawAppEnv === false) {
        $rawAppEnv = $_ENV['APP_ENV'] ?? ($_SERVER['APP_ENV'] ?? '');
    }
    $rawNodeEnv = getenv('NODE_ENV');
    if ($rawNodeEnv === false) {
        $rawNodeEnv = $_ENV['NODE_ENV'] ?? ($_SERVER['NODE_ENV'] ?? '');
    }
    $appEnv = strtolower(trim((string)$rawAppEnv));
    $nodeEnv = strtolower(trim((string)$rawNodeEnv));
    $nonProdEnvs = ['development', 'dev', 'local', 'test'];
    $presentEnvs = array_values(array_filter([$appEnv, $nodeEnv], static fn($v) => $v !== ''));

    return ($appEnv === 'production' || $nodeEnv === 'production')
        || count($presentEnvs) === 0
        || count(array_filter($presentEnvs, static fn($v) => !in_array($v, $nonProdEnvs, true))) > 0;
}

/**
 * Validates ADMOB_ENCRYPTION_KEY without ever logging or returning the actual secret.
 * Requires a minimum 32-byte key in production.
 */
function validateAdmobEncryptionKey($isProduction = null) {
    if ($isProduction === null) {
        $isProduction = isAdmobProductionEnv();
    }
    $rawKey = getenv('ADMOB_ENCRYPTION_KEY');
    if ($rawKey === false) {
        $rawKey = $_ENV['ADMOB_ENCRYPTION_KEY'] ?? ($_SERVER['ADMOB_ENCRYPTION_KEY'] ?? '');
    }
    $envKey = trim((string)$rawKey);

    if ($envKey === '') {
        return [
            'valid' => false,
            'key' => null,
            'reason' => 'missing',
            'error' => 'Google AdMob encryption key is not configured. Please define ADMOB_ENCRYPTION_KEY in your server environment.'
        ];
    }

    if ($isProduction && strlen($envKey) < 32) {
        return [
            'valid' => false,
            'key' => null,
            'reason' => 'too_short',
            'error' => 'Google AdMob encryption key (ADMOB_ENCRYPTION_KEY) must be at least 32 bytes in production.'
        ];
    }

    return [
        'valid' => true,
        'key' => $envKey,
        'reason' => 'ok',
        'error' => null
    ];
}

/**
 * Returns the server master encryption key for AES-256-GCM.
 * Strictly reads ADMOB_ENCRYPTION_KEY and fails closed (returns null) if missing or invalid.
 * Never defaults to insecure fallbacks (APP_KEY, JWT_SECRET, or DB credentials).
 */
function getAdmobEncryptionKey($isProduction = null) {
    $res = validateAdmobEncryptionKey($isProduction);
    return $res['valid'] ? $res['key'] : null;
}

/**
 * Validates ADMOB_OAUTH_REDIRECT_URI.
 * Never derives the production redirect URI from HTTP_HOST or X-Forwarded-Proto.
 * Uses the same canonical default as Node in non-production when unset.
 */
function validateAdmobRedirectUri($rawRedirectUri, $isProduction = null) {
    if ($isProduction === null) {
        $isProduction = isAdmobProductionEnv();
    }
    $canonicalDefault = 'https://facetube.online/api/admin/admob/oauth-callback';
    $trimmed = trim((string)$rawRedirectUri);

    if ($trimmed === '') {
        if ($isProduction) {
            return [
                'valid' => false,
                'redirectUri' => '',
                'error' => 'Google AdMob OAuth redirect URI (ADMOB_OAUTH_REDIRECT_URI) is not configured in production.'
            ];
        }
        return [
            'valid' => true,
            'redirectUri' => $canonicalDefault,
            'error' => null
        ];
    }

    $parts = parse_url($trimmed);
    if (!is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) {
        return [
            'valid' => false,
            'redirectUri' => '',
            'error' => 'Invalid ADMOB_OAUTH_REDIRECT_URI configuration.'
        ];
    }

    if (!empty($parts['user']) || !empty($parts['pass']) || isset($parts['fragment'])) {
        return [
            'valid' => false,
            'redirectUri' => '',
            'error' => 'Untrusted ADMOB_OAUTH_REDIRECT_URI configuration.'
        ];
    }

    $scheme = strtolower((string)$parts['scheme']);
    $host = strtolower((string)$parts['host']);
    $path = (string)($parts['path'] ?? '');

    if ($isProduction) {
        $trustedHosts = ['facetube.online', 'www.facetube.online', 'api.facetube.online'];
        $trustedPaths = ['/api/admin/admob/oauth-callback', '/api/admin/admob/oauth-callback.php'];
        if (
            $scheme !== 'https' ||
            isset($parts['query']) ||
            !in_array($host, $trustedHosts, true) ||
            !in_array($path, $trustedPaths, true)
        ) {
            return [
                'valid' => false,
                'redirectUri' => '',
                'error' => 'Untrusted ADMOB_OAUTH_REDIRECT_URI configuration for production environment.'
            ];
        }
    } elseif (!in_array($scheme, ['http', 'https'], true)) {
        return [
            'valid' => false,
            'redirectUri' => '',
            'error' => 'Invalid ADMOB_OAUTH_REDIRECT_URI scheme.'
        ];
    }

    return [
        'valid' => true,
        'redirectUri' => $trimmed,
        'error' => null
    ];
}

/**
 * Loads AdMob OAuth configuration strictly from server environment variables.
 * Never derives redirect_uri from HTTP_HOST or X-Forwarded-Proto.
 */
function getAdmobOAuthConfig($isProduction = null) {
    if ($isProduction === null) {
        $isProduction = isAdmobProductionEnv();
    }
    $clientId = getenv('ADMOB_OAUTH_CLIENT_ID') ?: ($_ENV['ADMOB_OAUTH_CLIENT_ID'] ?? ($_SERVER['ADMOB_OAUTH_CLIENT_ID'] ?? ''));
    $clientSecret = getenv('ADMOB_OAUTH_CLIENT_SECRET') ?: ($_ENV['ADMOB_OAUTH_CLIENT_SECRET'] ?? ($_SERVER['ADMOB_OAUTH_CLIENT_SECRET'] ?? ''));
    $rawRedirectUri = getenv('ADMOB_OAUTH_REDIRECT_URI');
    if ($rawRedirectUri === false) {
        $rawRedirectUri = $_ENV['ADMOB_OAUTH_REDIRECT_URI'] ?? ($_SERVER['ADMOB_OAUTH_REDIRECT_URI'] ?? '');
    }

    $redirectCheck = validateAdmobRedirectUri($rawRedirectUri, $isProduction);

    return [
        'clientId' => trim((string)$clientId),
        'clientSecret' => trim((string)$clientSecret),
        'redirectUri' => $redirectCheck['redirectUri'],
        'redirectUriValid' => $redirectCheck['valid'],
        'redirectUriError' => $redirectCheck['error'],
        'isConfigured' => !empty(trim((string)$clientId)) && !empty(trim((string)$clientSecret))
    ];
}

/**
 * Strict Admin authentication for AdMob OAuth endpoints.
 * Distinguishes missing/invalid sessions (401) and non-admin callers (403)
 * from database failures (503).
 */
function requireAdmobAdminAuth($pdo) {
    $token = getBearerToken();
    if (empty($token)) {
        jsonResponse([
            'success' => false,
            'error' => 'Authentication required. Please provide a valid Bearer session token.'
        ], 401);
    }

    try {
        $stmt = $pdo->prepare('
            SELECT u.id, u.user_id, u.name, u.mobile, u.email, u.role, u.referral_code, u.avatar_url, u.created_at
            FROM sessions s
            INNER JOIN users u ON (s.user_id = u.id OR s.user_id = u.user_id)
            WHERE s.token = ? AND s.expires_at > NOW()
            LIMIT 1
        ');
        $stmt->execute([trim((string)$token)]);
        $authUser = $stmt->fetch() ?: null;
    } catch (PDOException $e) {
        error_log('[AdMob OAuth] Session verification database error: ' . $e->getMessage());
        jsonResponse([
            'success' => false,
            'error' => 'Database connection unavailable while verifying session.'
        ], 503);
    }

    if (!$authUser) {
        jsonResponse([
            'success' => false,
            'error' => 'Authentication required. Please provide a valid Bearer session token.'
        ], 401);
    }

    if (strtolower((string)($authUser['role'] ?? '')) !== 'admin') {
        jsonResponse([
            'success' => false,
            'error' => 'Admin authorization required.'
        ], 403);
    }

    return $authUser;
}

/**
 * Encrypts plaintext using AES-256-GCM.
 * Returns hexadecimal strings for ciphertext, IV (12 bytes), and GCM tag (16 bytes).
 */
function encryptSecret($plaintext, $secretKey) {
    if (empty($secretKey)) {
        throw new InvalidArgumentException('AdMob encryption key is required but missing.');
    }
    $key = hash('sha256', $secretKey, true); // exactly 32 bytes
    $iv = random_bytes(12); // Standard 12-byte IV for GCM
    $tag = '';
    $ciphertext = openssl_encrypt(
        $plaintext,
        'aes-256-gcm',
        $key,
        OPENSSL_RAW_DATA,
        $iv,
        $tag,
        '',
        16
    );

    if ($ciphertext === false) {
        throw new RuntimeException('AES-256-GCM encryption failed.');
    }

    return [
        'ciphertext' => bin2hex($ciphertext),
        'iv' => bin2hex($iv),
        'tag' => bin2hex($tag)
    ];
}

/**
 * Decrypts AES-256-GCM ciphertext using IV and authentication tag.
 * Returns decrypted plaintext or false if authentication fails or key is missing.
 */
function decryptSecret($ciphertextHex, $ivHex, $tagHex, $secretKey) {
    if (empty($secretKey)) {
        return false;
    }
    $key = hash('sha256', $secretKey, true);
    $ciphertext = hex2bin($ciphertextHex);
    $iv = hex2bin($ivHex);
    $tag = hex2bin($tagHex);

    if ($ciphertext === false || $iv === false || $tag === false) {
        return false;
    }

    return openssl_decrypt(
        $ciphertext,
        'aes-256-gcm',
        $key,
        OPENSSL_RAW_DATA,
        $iv,
        $tag
    );
}

function base64UrlEncode($data) {
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

function base64UrlDecode($data) {
    return base64_decode(strtr($data, '-_', '+/'));
}

/**
 * Generates a signed, tamper-proof OAuth state parameter with a 10-minute expiry.
 */
function generateOAuthState($userId, $nonce, $secretKey) {
    if (empty($secretKey)) {
        throw new InvalidArgumentException('AdMob encryption/signing key is required.');
    }
    $timestamp = time() * 1000;
    $payload = json_encode([
        'uid' => (string)$userId,
        'ts' => $timestamp,
        'n' => (string)$nonce
    ], JSON_UNESCAPED_SLASHES);

    $payloadB64 = base64UrlEncode($payload);
    $signature = base64UrlEncode(hash_hmac('sha256', $payloadB64, $secretKey, true));
    return "{$payloadB64}.{$signature}";
}

/**
 * Validates the OAuth state parameter against CSRF, expiration, and signature tampering.
 */
function verifyOAuthState($state, $secretKey) {
    if (empty($secretKey)) {
        return ['valid' => false, 'error' => 'Google AdMob encryption key is not configured.'];
    }
    if (empty($state) || !is_string($state) || strpos($state, '.') === false) {
        return ['valid' => false, 'error' => 'Malformed OAuth state parameter.'];
    }

    $parts = explode('.', $state, 2);
    $payloadB64 = $parts[0];
    $providedSig = $parts[1];

    $expectedSig = base64UrlEncode(hash_hmac('sha256', $payloadB64, $secretKey, true));
    if (!hash_equals($expectedSig, $providedSig)) {
        return ['valid' => false, 'error' => 'Invalid OAuth state signature (CSRF detection).'];
    }

    $raw = base64UrlDecode($payloadB64);
    $parsed = json_decode($raw, true);

    if (!is_array($parsed) || empty($parsed['uid']) || empty($parsed['ts']) || empty($parsed['n'])) {
        return ['valid' => false, 'error' => 'State payload missing required security claims.'];
    }

    $age = (time() * 1000) - intval($parsed['ts']);
    if ($age < 0 || $age > (10 * 60 * 1000)) { // 10 minutes maximum TTL
        return ['valid' => false, 'error' => 'OAuth state expired. Please re-initiate connection.'];
    }

    return [
        'valid' => true,
        'userId' => (string)$parsed['uid'],
        'nonce' => (string)$parsed['n'],
        'timestamp' => intval($parsed['ts'])
    ];
}

/**
 * Accurately detects whether the current request is over HTTPS.
 * Inspects native HTTPS flags and trusted reverse proxy headers.
 * Never blindly trusts X-Forwarded-Proto from untrusted public clients.
 */
function isAdmobHttpsRequest() {
    if (!empty($_SERVER['HTTPS']) && strtolower($_SERVER['HTTPS']) !== 'off') {
        return true;
    }
    if (isset($_SERVER['SERVER_PORT']) && (int)$_SERVER['SERVER_PORT'] === 443) {
        return true;
    }
    // Reverse proxy detection: Only trust X-Forwarded-Proto if request came from trusted proxy
    $remoteAddr = $_SERVER['REMOTE_ADDR'] ?? '';
    $isTrustedProxy = in_array($remoteAddr, ['127.0.0.1', '::1'], true) ||
                      preg_match('/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/', $remoteAddr) ||
                      !empty($_SERVER['HTTP_CF_CONNECTING_IP']);
    if ($isTrustedProxy && !empty($_SERVER['HTTP_X_FORWARDED_PROTO'])) {
        return strtolower($_SERVER['HTTP_X_FORWARDED_PROTO']) === 'https';
    }
    return false;
}
