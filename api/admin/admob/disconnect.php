<?php
/**
 * FaceTube - Admin AdMob OAuth Disconnect & Token Revocation API
 * POST /api/admin/admob/disconnect.php
 *
 * Strictly restricted to verified Administrators.
 * Decrypts refresh token to invoke Google's token revocation endpoint,
 * then securely removes or deactivates stored credentials.
 */

require_once __DIR__ . '/admob-crypto.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$isProduction = isAdmobProductionEnv();
$pdo = getDatabaseConnection();
$authUser = requireAdmobAdminAuth($pdo);

$keyCheck = validateAdmobEncryptionKey($isProduction);
$secretKey = $keyCheck['key'];

try {
    $stmt = $pdo->query('
        SELECT id, publisher_id, encrypted_refresh_token, refresh_token_iv, refresh_token_tag
        FROM admob_oauth_credentials
        WHERE is_active = 1
        ORDER BY updated_at DESC
    ');
    $activeRows = $stmt ? $stmt->fetchAll() : [];

    $googleRevoked = false;
    $revocationStatus = 'no_active_credentials';
    $revocationWarning = null;

    if (count($activeRows) > 0) {
        if (!$keyCheck['valid'] || empty($secretKey)) {
            $revocationStatus = ($keyCheck['reason'] === 'too_short')
                ? 'invalid_encryption_key'
                : 'missing_encryption_key';
            $revocationWarning = 'Local AdMob credentials were deactivated, but Google token revocation could not be performed because ADMOB_ENCRYPTION_KEY is missing or invalid.';
        } else {
            $decryptFailedCount = 0;
            $realRevokedCount = 0;
            $upstreamFailedCount = 0;
            $seenTokens = [];

            foreach ($activeRows as $row) {
                $refreshToken = decryptSecret(
                    $row['encrypted_refresh_token'],
                    $row['refresh_token_iv'],
                    $row['refresh_token_tag'],
                    $secretKey
                );

                if ($refreshToken === false || $refreshToken === '') {
                    $decryptFailedCount++;
                    continue;
                }
                if (isset($seenTokens[$refreshToken])) {
                    continue;
                }
                $seenTokens[$refreshToken] = true;

                $ch = curl_init('https://oauth2.googleapis.com/revoke');
                curl_setopt_array($ch, [
                    CURLOPT_POST => true,
                    CURLOPT_POSTFIELDS => http_build_query(['token' => $refreshToken]),
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_HTTPHEADER => ['Content-Type: application/x-www-form-urlencoded'],
                    CURLOPT_TIMEOUT => 10,
                    CURLOPT_SSL_VERIFYPEER => true,
                    CURLOPT_SSL_VERIFYHOST => 2,
                ]);
                $revokeBody = curl_exec($ch);
                $revokeErrno = curl_errno($ch);
                $revokeStatusCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
                curl_close($ch);

                if ($revokeBody !== false && $revokeErrno === 0 && intval($revokeStatusCode) === 200) {
                    $realRevokedCount++;
                } else {
                    $upstreamFailedCount++;
                }
            }

            if ($upstreamFailedCount > 0) {
                $googleRevoked = false;
                $revocationStatus = 'upstream_revocation_failed';
                $revocationWarning = 'Local AdMob credentials were deactivated, but Google upstream token revocation failed or returned a non-200 response.';
            } elseif ($decryptFailedCount > 0 && $realRevokedCount === 0) {
                $googleRevoked = false;
                $revocationStatus = 'decryption_failed';
                $revocationWarning = 'Local AdMob credentials were deactivated, but stored refresh tokens could not be decrypted for Google revocation.';
            } elseif ($realRevokedCount > 0 && $decryptFailedCount === 0) {
                $googleRevoked = true;
                $revocationStatus = 'revoked';
            } elseif ($realRevokedCount > 0 && $decryptFailedCount > 0) {
                $googleRevoked = false;
                $revocationStatus = 'partial_revocation_decryption_failed';
                $revocationWarning = 'Local AdMob credentials were deactivated, but at least one stored refresh token could not be decrypted for Google revocation.';
            }
        }

        // Scrub all active stored credentials and mark inactive
        $stmtDeactivate = $pdo->prepare('
            UPDATE admob_oauth_credentials
            SET is_active = 0,
                encrypted_refresh_token = "",
                refresh_token_iv = "",
                refresh_token_tag = "",
                updated_at = NOW()
            WHERE is_active = 1
        ');
        $stmtDeactivate->execute();
    }

    $message = count($activeRows) === 0
        ? 'No active Google AdMob OAuth credentials were found.'
        : ($googleRevoked
            ? 'Google AdMob OAuth credentials disconnected and tokens revoked successfully.'
            : 'Local AdMob credentials deactivated, but Google token revocation was not confirmed.');

    $payload = [
        'success' => true,
        'connected' => false,
        'google_revoked' => $googleRevoked,
        'revocation_status' => $revocationStatus,
        'message' => $message,
    ];
    if ($revocationWarning !== null) {
        $payload['warning'] = $revocationWarning;
    }

    jsonResponse($payload, 200);
} catch (PDOException $e) {
    error_log('[AdMob OAuth] MySQL disconnect error: ' . $e->getMessage());
    jsonResponse([
        'success' => false,
        'error' => 'AdMob database table is uninitialized or inaccessible. Please run database migrations before connecting.'
    ], $isProduction ? 503 : 500);
} catch (Exception $e) {
    error_log('[AdMob OAuth] Disconnect unexpected error: ' . $e->getMessage());
    jsonResponse([
        'success' => false,
        'error' => 'Failed to disconnect AdMob OAuth credentials due to a server error.'
    ], 500);
}
