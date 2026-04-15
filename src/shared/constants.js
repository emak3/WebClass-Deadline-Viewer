/* 拡張全体で共有（service worker / content / options）。importScripts または先読みで読み込む。 */
(function (g) {
  "use strict";
  g.WCDV_SHARED = {
    STORAGE_KEY: "wcdv_deadlines_v1",
    CONNECT_NAME: "wcdv-bulk-bg",
    STORAGE_ORIGINS: "wcdv_allowed_origins_v1",
    STORAGE_ENABLED: "wcdv_viewer_enabled_v1",
    STORAGE_AUTO_BULK_HOURS: "wcdv_auto_bulk_interval_hours_v1",
    STORAGE_AUTO_BULK_ENABLED: "wcdv_auto_bulk_enabled_v1",
    BULK_META_KEY: "wcdv_bulk_meta_v1",
    PANEL_COLLAPSED_KEY: "wcdv_course_panel_collapsed_v1",
    ORIGINS_MIGRATED_KEY: "wcdv_origins_migrated_v1",
    STORAGE_SUBMITTED_ITEMS: "wcdv_submitted_items_v1",
    AUTO_BULK_INTERVAL_HOURS_DEFAULT: 6,
    BULK_SHORT_INTERVAL_WARN_MS: 30 * 60 * 1000,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
