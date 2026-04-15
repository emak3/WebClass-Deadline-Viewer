/* global globalThis */
/**
 * コンテンツスクリプト全体で共有するミュータブル状態と不変のページ定数。
 * 各チャンクは globalThis.WCDV_CONTENT（C）および WCDV_CONTENT_FNS（page-panel が登録）を参照する。
 */
(function (g) {
  "use strict";
  g.WCDV_CONTENT = {
    wcdvStorageListenerAttached: false,
    wcdvBulkRunningLocal: false,
    wcdvAutoBulkStaleTimer: null,
    wcdvAutoBulkStaleAttempted: false,
    wcdvBulkPort: null,
    wcdvSubmittedListRefreshTimer: null,
    saveToastTimer: null,
    LABEL_TEXT: "利用可能期間",
    PERIOD_RE:
      /^\s*(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})\s*-\s*(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})\s*$/,
    WCDV_PENDING_ASSIGN_NAV_KEY: "wcdv_pending_assignment_nav_v1",
    WCDV_LAST_LIST_PAGE_URL_KEY: "wcdv_last_course_list_url_v1",
    WCDV_SUBMITTED_LIST_REFRESH_MS: 1000,
    WCDV_DEADLINE_SOON_MS: 2 * 3600000,
    ORIGIN: location.origin,
  };
  g.WCDV_CONTENT_FNS = {};
})(typeof globalThis !== "undefined" ? globalThis : this);
