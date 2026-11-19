<?php
/**
 * FaceTube - Admin AdMob OAuth Callback & Server-Side Token Exchange
 * GET / POST /api/admin/admob/oauth-callback.php
 *
 * Implements:
 * 1. Cryptographic state verification (anti-CSRF & replay protection)
 * 2. Server-side authorization code exchange with Google OAuth 2.0
 * 3. AES-256-GCM encryption of refresh token before database storage
 * 4. Account metadata lookup via AdMob API accounts.list
 * 5. Strict Zero-Exposure: Tokens and secrets are NEVER returned to the client
 */

require_once __DIR__ . '/admob-crypto.php';

$requestMethod = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if (!in_array($requestMethod, ['GET', 'POST'], true)) {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$isProduction = isAdmobProductionEnv();
$pdo = getDatabaseConnection();
$config = getAdmobOAuthConfig($isProduction);
$keyCheck = validateAdmobEncryptionKey($isProduction);
$secretKey = $keyCheck['key'];

$input = getRequestPayload();
$code = $_GET['code'] ?? ($input['code'] ?? '');
$state = $_GET['state'] ?? ($input['state'] ?? '');
$errorParam = $_GET['error'] ?? ($input['error'] ?? '');

$isBrowserGet = ($requestMethod === 'GET');

function clearBindingCookie() {
    $isHttps = isAdmobHttpsRequest();
    setcookie('facetube_admob_oauth_binding', '', [
        'expires' => time() - 3600,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Lax',
        'secure' => $isHttps,
    ]);
}

// Fix B: Fail closed if encryption key is missing or < 32 bytes in production
if (!$keyCheck['valid'] || empty($secretKey)) {
    clearBindingCookie();
    if ($isBrowserGet) {
        $msg = ($keyCheck['reason'] === 'too_short')
            ? 'Google AdMob encryption key does not meet minimum length requirements.'
            : 'Google AdMob encryption key is not configured.';
        header('Location: /admob-income?admob_error=' . urlencode($msg));
        exit;
    }
    jsonResponse([
        'success' => false,
        'error' => ($keyCheck['reason'] === 'too_short')
            ? $keyCheck['error']
            : 'Google AdMob encryption key is not configured. Server cannot securely store credentials.'
    ], 500);
}

// Fail closed if redirect URI is missing or untrusted in production
if (!$config['redirectUriValid']) {
    clearBindingCookie();
    if ($isBrowserGet) {
        header('Location: /admob-income?admob_error=invalid_redirect_uri');
        exit;
    }
    jsonResponse([
        'success' => false,
        'error' => $config['redirectUriError'] ?? 'Google AdMob OAuth redirect URI is missing or untrusted in production.'
    ], 500);
}

// Handle Google OAuth error responses (e.g. user denied consent)
if (!empty($errorParam)) {
    clearBindingCookie();
    if ($isBrowserGet) {
        header('Location: /admob-income?admob_error=' . urlencode($errorParam));
        exit;
    }
    jsonResponse([
        'success' => false,
        'error' => "Google OAuth returned error: {$errorParam}"
    ], 400);
}

// 1. Verify Cryptographic State Parameter (HMAC signature, format, timestamp TTL)
$stateCheck = verifyOAuthState($state, $secretKey);
if (!$stateCheck['valid']) {
    clearBindingCookie();
    if ($isBrowserGet) {
        header('Location: /admob-income?admob_error=' . urlencode($stateCheck['error']));
        exit;
    }
    jsonResponse([
        'success' => false,
        'error' => $stateCheck['error']
    ], 403);
}

$stateNonce = $stateCheck['nonce'] ?? '';
$stateUserId = $stateCheck['userId'] ?? '';
$stateHash = hash('sha256', $state);

// If caller supplied a Bearer token, reject non-admin callers immediately and fail closed on DB errors
$callerBearer = getBearerToken();
if (!empty($callerBearer)) {
    try {
        $stmtCaller = $pdo->prepare('
            SELECT u.role
            FROM sessions s
            INNER JOIN users u ON (s.user_id = u.id OR s.user_id = u.user_id)
            WHERE s.token = ? AND s.expires_at > NOW()
            LIMIT 1
        ');
        $stmtCaller->execute([trim((string)$callerBearer)]);
        $callerRow = $stmtCaller->fetch() ?: null;
        if ($callerRow && strtolower((string)($callerRow['role'] ?? '')) !== 'admin') {
            clearBindingCookie();
            if ($isBrowserGet) {
                header('Location: /admob-income?admob_error=not_an_administrator');
                exit;
            }
            jsonResponse([
                'success' => false,
                'error' => 'Admin authorization required: Caller is not an administrator.'
            ], 403);
        }
    } catch (PDOException $e) {
        error_log('[AdMob OAuth] Caller session check DB error: ' . $e->getMessage());
        clearBindingCookie();
        if ($isBrowserGet) {
            header('Location: /admob-income?admob_error=database_error');
            exit;
        }
        jsonResponse([
            'success' => false,
            'error' => 'Database connection unavailable while verifying session.'
        ], 503);
    }
}

// 2. Resolve Initiating Session Binding via Random binding_secret
// Production strictly requires HttpOnly cookie; test binding headers are permitted ONLY in explicit non-production
$cookieSecret = $_COOKIE['facetube_admob_oauth_binding'] ?? '';
$rawTestHeader = $_SERVER['HTTP_X_ADMOB_BINDING'] ?? ($_SERVER['HTTP_X_ADMOB_BINDING_SECRET'] ?? '');
if ($isProduction && empty($cookieSecret) && !empty($rawTestHeader)) {
    clearBindingCookie();
    if ($isBrowserGet) {
        header('Location: /admob-income?admob_error=missing_session_binding');
        exit;
    }
    jsonResponse([
        'success' => false,
        'error' => 'OAuth state rejected: binding header fallback is disabled in production; initiating session cookie is required.'
    ], 403);
}
$testHeaderSecret = !$isProduction ? $rawTestHeader : '';
$bindingSecret = !empty($cookieSecret) ? $cookieSecret : $testHeaderSecret;
if (empty($bindingSecret)) {
    clearBindingCookie();
    if ($isBrowserGet) {
        header('Location: /admob-income?admob_error=missing_session_binding');
        exit;
    }
    jsonResponse([
        'success' => false,
        'error' => 'OAuth state rejected: initiating session binding missing.'
    ], 403);
}
$callerSessionHash = hash('sha256', trim((string)$bindingSecret));

// Independently validate that the exact initiating Admin session still exists, is active, unexpired, and belongs to the same Admin user
try {
    $stmtAdminSession = $pdo->prepare('
        SELECT st.admin_session_hash, u.id, u.user_id, u.role
        FROM admob_oauth_states st
        INNER JOIN sessions s ON (SHA2(s.token, 256) = st.admin_session_hash AND s.expires_at > NOW())
        INNER JOIN users u ON ((s.user_id = u.id OR s.user_id = u.user_id) AND (u.user_id = st.user_id OR u.id = st.user_id))
        WHERE st.nonce = ?
          AND st.state_hash = ?
          AND st.user_id = ?
          AND st.session_hash = ?
          AND st.is_consumed = 0
          AND st.expires_at > NOW()
          AND LOWER(u.role) = "admin"
        LIMIT 1
    ');
    $stmtAdminSession->execute([$stateNonce, $stateHash, $stateUserId, $callerSessionHash]);
    $adminSessionRow = $stmtAdminSession->fetch();
} catch (PDOException $e) {
    error_log('[AdMob OAuth] MySQL session verification error: ' . $e->getMessage());
    clearBindingCookie();
    if ($isBrowserGet) {
        header('Location: /admob-income?admob_error=database_error');
        exit;
    }
    jsonResponse([
        'success' => false,
        'error' => 'AdMob database table is uninitialized or inaccessible. Please run database migrations before connecting.'
    ], $isProduction ? 503 : 500);
}

if (!$adminSessionRow) {
    clearBindingCookie();
    if ($isBrowserGet) {
        header('Location: /admob-income?admob_error=invalid_admin_session');
        exit;
    }
    jsonResponse([
        'success' => false,
        'error' => 'OAuth state rejected: initiating admin session is inactive, expired, or mismatch.'
    ], 403);
}

$expectedAdminSessionHash = $adminSessionRow['admin_session_hash'];

// If caller also sent a Bearer token, verify it matches the initiating admin session token hash
if (!empty($callerBearer)) {
    $callerBearerHash = hash('sha256', trim((string)$callerBearer));
    if ($callerBearerHash !== $expectedAdminSessionHash) {
        clearBindingCookie();
        if ($isBrowserGet) {
            header('Location: /admob-income?admob_error=admin_mismatch');
            exit;
        }
        jsonResponse([
            'success' => false,
            'error' => 'OAuth state rejected: initiating admin user mismatch.'
        ], 403);
    }
}

// 3. Strengthened Atomic Nonce Consumption with Live Session & Role Verification (Zero-TOCTOU):
try {
    $stmtConsume = $pdo->prepare('
        UPDATE admob_oauth_states st
        INNER JOIN sessions s ON (SHA2(s.token, 256) = st.admin_session_hash AND s.expires_at > NOW())
        INNER JOIN users u ON ((s.user_id = u.id OR s.user_id = u.user_id) AND (u.user_id = st.user_id OR u.id = st.user_id))
        SET st.is_consumed = 1, st.consumed_at = NOW()
        WHERE st.nonce = ?
          AND st.state_hash = ?
          AND st.user_id = ?
          AND st.session_hash = ?
          AND st.admin_session_hash = ?
          AND st.is_consumed = 0
          AND st.expires_at > NOW()
          AND LOWER(u.role) = "admin"
    ');
    $stmtConsume->execute([
        $stateNonce,
        $stateHash,
        $stateUserId,
        $callerSessionHash,
        $expectedAdminSessionHash
    ]);
} catch (PDOException $e) {
    error_log('[AdMob OAuth] MySQL state atomic update error: ' . $e->getMessage());
    clearBindingCookie();
    if ($isBrowserGet) {
        header('Location: /admob-income?admob_error=database_error');
        exit;
    }
    jsonResponse([
        'success' => false,
        'error' => 'AdMob database table is uninitialized or inaccessible. Please run database migrations before connecting.'
    ], $isProduction ? 503 : 500);
}

if ($stmtConsume->rowCount() !== 1) {
    clearBindingCookie();
    if ($isBrowserGet) {
        header('Location: /admob-income?admob_error=state_already_consumed');
        exit;
    }
    jsonResponse([
        'success' => false,
        'error' => 'OAuth state has already been consumed (replay attack detected).'
    ], 403);
}

// Clear binding cookie on success
clearBindingCookie();

$adminUserId = $stateUserId;

// 2. Validate Authorization Code & OAuth Client Credentials
if (empty($code)) {
    if ($isBrowserGet) {
        header('Location: /admob-income?admob_error=missing_code');
        exit;
    }
    jsonResponse([
        'success' => false,
        'error' => 'Missing Google authorization code in callback.'
    ], 400);
}

if (!$config['isConfigured'] || !$config['redirectUriValid']) {
    if ($isBrowserGet) {
        header('Location: /admob-income?admob_error=oauth_not_configured');
        exit;
    }
    jsonResponse([
        'success' => false,
        'error' => 'Google AdMob OAuth credentials or redirect URI are not configured.'
    ], 500);
}

// 3. Server-Side Token Exchange with Google OAuth 2.0
$tokenEndpoint = 'https://oauth2.googleapis.com/token';
$postData = http_build_query([
    'code' => $code,
    'client_id' => $config['clientId'],
    'client_secret' => $config['clientSecret'],
    'redirect_uri' => $config['redirectUri'],
    'grant_type' => 'authorization_code',
]);

$ch = curl_init($tokenEndpoint);
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $postData,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => ['Content-Type: application/x-www-form-urlencoded'],
    CURLOPT_TIMEOUT => 20,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => 2,
]);

$tokenRaw = curl_exec($ch);
$curlErrno = curl_errno($ch);
$httpStatus = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($tokenRaw === false || $curlErrno !== 0) {
    if ($isBrowserGet) {
        header('Location: /admob-income?admob_error=token_exchange_network_error');
        exit;
    }
    jsonResponse([
        'success' => false,
        'error' => 'Network error exchanging authorization code with Google.'
    ], 502);
}

$tokenJson = json_decode((string)$tokenRaw, true);

if ($httpStatus !== 200 || empty($tokenJson['access_token'])) {
    $errDetail = $tokenJson['error_description'] ?? ($tokenJson['error'] ?? 'Token exchange failed.');
    if ($isBrowserGet) {
        header('Location: /admob-income?admob_error=' . urlencode($errDetail));
        exit;
    }
    jsonResponse([
        'success' => false,
        'error' => "Failed to exchange authorization code with Google: {$errDetail}"
    ], 502);
}

$accessToken = $tokenJson['access_token'];
$refreshToken = $tokenJson['refresh_token'] ?? null;
$expiresIn = intval($tokenJson['expires_in'] ?? 3600);
$tokenExpiry = date('Y-m-d H:i:s', time() + $expiresIn);

// 4. Fetch Publisher Account Metadata via AdMob API accounts.list

$rawConfiguredPublisherId = getenv('ADMOB_PUBLISHER_ID');
if ($rawConfiguredPublisherId === false) {
    $rawConfiguredPublisherId = $_ENV['ADMOB_PUBLISHER_ID'] ?? ($_SERVER['ADMOB_PUBLISHER_ID'] ?? '');
}
$publisherId = trim((string)$rawConfiguredPublisherId);
$accountName = 'FaceTube Mobile App';
$currencyCode = 'INR';

$chAdmob = curl_init('https://admob.googleapis.com/v1/accounts');
curl_setopt_array($chAdmob, [
    CURLOPT_HTTPGET => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => [
        "Authorization: Bearer {$accessToken}",
        'Accept: application/json'
    ],
    CURLOPT_TIMEOUT => 15,
]);

$admobRaw = curl_exec($chAdmob);
$admobStatus = curl_getinfo($chAdmob, CURLINFO_HTTP_CODE);
$admobCurlErr = curl_error($chAdmob);
curl_close($chAdmob);

if ($admobStatus === 200) {
    $admobJson = json_decode($admobRaw, true);
    if (!empty($admobJson['account']) && is_array($admobJson['account']) && count($admobJson['account']) > 0) {
        $firstAccount = $admobJson['account'][0];
        // Resource format: accounts/pub-XXXXXXXXXXXXXXXX
        $accountResourceName = $firstAccount['name'] ?? '';
        if (preg_match('/accounts\/(pub-[a-zA-Z0-9]+)/', $accountResourceName, $m)) {
            $publisherId = $m[1];
        }
        $accountName = $firstAccount['title'] ?? 'FaceTube AdMob Publisher';
        $currencyCode = $firstAccount['currencyCode'] ?? 'INR';
    }
} else {
    error_log('[AdMob OAuth] Failed to fetch AdMob publisher account metadata (HTTP ' . intval($admobStatus) . ($admobCurlErr ? ', transport error' : '') . ').');
}

if ($isProduction && ($publisherId === '' || $publisherId === 'pub-3940256099942544' || !preg_match('/^pub-[a-zA-Z0-9]+$/', $publisherId))) {
    error_log('[AdMob OAuth] Production publisher ID missing, invalid, or matched test ID; failing closed.');
    if ($isBrowserGet) {
        header('Location: /admob-income?admob_error=missing_publisher_id');
        exit;
    }
    jsonResponse([
        'success' => false,
        'error' => 'AdMob publisher ID could not be discovered or configured in production.'
    ], 500);
}

if ($publisherId === '') {
    $publisherId = 'pub-3940256099942544';
}

// 5. Encrypt Refresh Token using AES-256-GCM
// No runtime DDL: relies on explicit database migration
if (empty($refreshToken)) {
    try {
        $stmtExisting = $pdo->prepare('
            SELECT encrypted_refresh_token, refresh_token_iv, refresh_token_tag 
            FROM admob_oauth_credentials 
            WHERE publisher_id = ? AND is_active = 1 
            LIMIT 1
        ');
        $stmtExisting->execute([$publisherId]);
        $existingRow = $stmtExisting->fetch();
    } catch (PDOException $e) {
        error_log('[AdMob OAuth] MySQL existing credentials lookup error: ' . $e->getMessage());
        if ($isBrowserGet) {
            header('Location: /admob-income?admob_error=database_error');
            exit;
        }
        jsonResponse([
            'success' => false,
            'error' => 'AdMob database table is uninitialized or inaccessible. Please run database migrations before connecting.'
        ], $isProduction ? 503 : 500);
    }

    if ($existingRow && !empty($existingRow['encrypted_refresh_token'])) {
        $encrypted = [
            'ciphertext' => $existingRow['encrypted_refresh_token'],
            'iv' => $existingRow['refresh_token_iv'],
            'tag' => $existingRow['refresh_token_tag'],
        ];
    } else {
        if ($isBrowserGet) {
            header('Location: /admob-income?admob_error=missing_refresh_token');
            exit;
        }
        jsonResponse([
            'success' => false,
            'error' => 'Google did not return a refresh_token. Please reconnect and ensure consent is granted.'
        ], 400);
    }
} else {
    $encrypted = encryptSecret($refreshToken, $secretKey);
}

// 6. Securely Store Encrypted Credentials in MySQL
try {
    $stmtUpsert = $pdo->prepare('
        INSERT INTO admob_oauth_credentials (
            publisher_id, account_name, currency_code,
            encrypted_refresh_token, refresh_token_iv, refresh_token_tag,
            token_expiry, is_active, connected_by, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NOW())
        ON DUPLICATE KEY UPDATE
            account_name = VALUES(account_name),
            currency_code = VALUES(currency_code),
            encrypted_refresh_token = VALUES(encrypted_refresh_token),
            refresh_token_iv = VALUES(refresh_token_iv),
            refresh_token_tag = VALUES(refresh_token_tag),
            token_expiry = VALUES(token_expiry),
            is_active = 1,
            connected_by = VALUES(connected_by),
            updated_at = NOW()
    ');

    $stmtUpsert->execute([
        $publisherId,
        $accountName,
        $currencyCode,
        $encrypted['ciphertext'],
        $encrypted['iv'],
        $encrypted['tag'],
        $tokenExpiry,
        $adminUserId,
    ]);
} catch (PDOException $e) {
    error_log('[AdMob OAuth] MySQL credential upsert error: ' . $e->getMessage());
    if ($isBrowserGet) {
        header('Location: /admob-income?admob_error=database_error');
        exit;
    }
    jsonResponse([
        'success' => false,
        'error' => 'Failed to persist AdMob credentials to database.'
    ], $isProduction ? 503 : 500);
}

// 7. Response: Redirect browser or return sanitized JSON (NO tokens exposed!)
if ($isBrowserGet) {
    header('Location: /admob-income?admob_connected=true&pub=' . urlencode($publisherId));
    exit;
}

jsonResponse([
    'success' => true,
    'message' => 'Google AdMob OAuth credentials securely saved.',
    'publisher_id' => $publisherId,
    'account_name' => $accountName,
    'currency_code' => $currencyCode,
    'connected_by' => $adminUserId,
    'is_active' => true,
], 200);
