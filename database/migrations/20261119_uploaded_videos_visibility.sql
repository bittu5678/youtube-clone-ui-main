-- ==============================================================================
-- FaceTube - Database Migration: Video Visibility (Public / Unlisted / Private)
-- Migration: 20261119_uploaded_videos_visibility.sql
-- Character Set: utf8mb4, Collation: utf8mb4_unicode_ci
-- Safe, additive, idempotent for MySQL 5.7+, 8.0+, 8.4 LTS, and MariaDB
-- ==============================================================================

SET @db := DATABASE();

-- 1. Conditionally add `visibility` column to `uploaded_videos` (existing rows default to 'public')
SET @col_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'uploaded_videos'
    AND COLUMN_NAME = 'visibility'
);

SET @sql_add_col := IF(
  @col_exists = 0,
  'ALTER TABLE `uploaded_videos` ADD COLUMN `visibility` ENUM(''public'', ''unlisted'', ''private'') NOT NULL DEFAULT ''public'' AFTER `is_promoted`',
  'SELECT ''Column visibility already exists in uploaded_videos'''
);

PREPARE stmt_add_col FROM @sql_add_col;
EXECUTE stmt_add_col;
DEALLOCATE PREPARE stmt_add_col;

-- 2. Conditionally add `idx_videos_visibility` index on `uploaded_videos`
SET @idx_exists := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'uploaded_videos'
    AND INDEX_NAME = 'idx_videos_visibility'
);

SET @sql_add_idx := IF(
  @idx_exists = 0,
  'CREATE INDEX `idx_videos_visibility` ON `uploaded_videos` (`visibility`)',
  'SELECT ''Index idx_videos_visibility already exists on uploaded_videos'''
);

PREPARE stmt_add_idx FROM @sql_add_idx;
EXECUTE stmt_add_idx;
DEALLOCATE PREPARE stmt_add_idx;
