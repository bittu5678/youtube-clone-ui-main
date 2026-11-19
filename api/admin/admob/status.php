<?php
/**
 * FaceTube - Admin AdMob OAuth Connection Status API
 * GET /api/admin/admob/status.php
 *
 * Strictly restricted to verified Administrators.
 * Returns public connection metadata (status, publisher ID, currency code).
 * Strict Zero-Exposure: Tokens and keys are NEVER returned in the response.
 */

require_once __DIR__ . '/admob-crypto.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['success' => false, 'error' => 'Method Not Allowed'], 405);
}

$isProduction = isAdmobProductionEnv();
$pdo = getDatabaseConnection();
$authUser = requireAdmobAdminAuth($pdo);

try {
    $stmt = $pdo->query('
        SELECT publisher_id, account_name, currency_code, is_active, connected_by, created_at, updated_at
        FROM admob_oauth_credentials
        WHERE is_active = 1
        ORDER BY updated_at DESC
        LIMIT 1
    ');
    $row = $stmt ? $stmt->fetch() : null;

    if ($row) {
        jsonResponse([
            'success' => true,
            'connected' => true,
            'publisher_id' => $row['publisher_id'],
            'account_name' => $row['account_name'],
            'currency_code' => $row['currency_code'],
            'connected_by' => $row['connected_by'],
            'connected_at' => $row['created_at'],
            'updated_at' => $row['updated_at'],
            'has_refresh_token' => true,
        ]);
    }
} catch (PDOException $e) {
    error_log('[AdMob OAuth] MySQL status query error: ' . $e->getMessage());
    jsonResponse([
        'success' => false,
        'error' => 'AdMob database table is uninitialized or inaccessible. Please run database migrations before connecting.'
    ], $isProduction ? 503 : 500);
}

jsonResponse([
    'success' => true,
    'connected' => false,
    'publisher_id' => null,
    'account_name' => null,
    'currency_code' => null,
    'has_refresh_token' => false,
]);
