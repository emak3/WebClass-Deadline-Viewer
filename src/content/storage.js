(function () {
"use strict";

const {
  STORAGE_KEY,
  BULK_META_KEY,
  STORAGE_AUTO_BULK_HOURS,
  STORAGE_AUTO_BULK_ENABLED,
  AUTO_BULK_INTERVAL_HOURS_DEFAULT,
} = globalThis.WCDV_SHARED;
const C = globalThis.WCDV_CONTENT;
const F = globalThis.WCDV_CONTENT_FNS;
const { collapseDuplicateCourseEntries } = globalThis.WCDV_COURSE_DATA;

function storageGetAll() {
  return new Promise((resolve) => {
    try {
      if (!F.extCtxOk()) {
        resolve({});
        return;
      }
      chrome.storage.local.get(STORAGE_KEY, (obj) => {
        F.flushChromeRuntimeLastError();
        if (!F.extCtxOk()) {
          resolve({});
          return;
        }
        try {
          resolve(obj[STORAGE_KEY] || {});
        } catch {
          resolve({});
        }
      });
    } catch {
      resolve({});
    }
  });
}

function storageSetAll(root) {
  return new Promise((resolve) => {
    try {
      if (!F.extCtxOk()) {
        resolve();
        return;
      }
      chrome.storage.local.set({ [STORAGE_KEY]: root }, () => {
        F.flushChromeRuntimeLastError();
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

/** この origin 用の { byCourse: { [coursePageUrl]: {...} } } を返す（ストレージ全体ではない） */
async function loadSiteBucket() {
  const root = await storageGetAll();
  let bucket = root[C.ORIGIN];
  if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) {
    bucket = { byCourse: {} };
  }
  if (!bucket.byCourse || typeof bucket.byCourse !== "object") {
    bucket.byCourse = {};
  }
  root[C.ORIGIN] = bucket;
  if (collapseDuplicateCourseEntries(bucket)) {
    await storageSetAll(root);
  }
  return bucket;
}

async function saveSiteBucket(site) {
  const root = await storageGetAll();
  if (!site.byCourse || typeof site.byCourse !== "object") {
    site.byCourse = {};
  }
  root[C.ORIGIN] = site;
  await storageSetAll(root);
}

function storageGetBulkMetaRoot() {
  return new Promise((resolve) => {
    try {
      if (!F.extCtxOk()) {
        resolve({});
        return;
      }
      chrome.storage.local.get(BULK_META_KEY, (obj) => {
        F.flushChromeRuntimeLastError();
        if (!F.extCtxOk()) {
          resolve({});
          return;
        }
        try {
          const m = obj[BULK_META_KEY];
          resolve(m && typeof m === "object" && !Array.isArray(m) ? m : {});
        } catch {
          resolve({});
        }
      });
    } catch {
      resolve({});
    }
  });
}

function storageSetBulkMetaRoot(meta) {
  return new Promise((resolve) => {
    try {
      if (!F.extCtxOk()) {
        resolve();
        return;
      }
      chrome.storage.local.set({ [BULK_META_KEY]: meta }, () => {
        F.flushChromeRuntimeLastError();
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

async function getLastBulkStartedAt() {
  const meta = await storageGetBulkMetaRoot();
  const o = meta[C.ORIGIN];
  return o && typeof o.lastStartedAt === "number" ? o.lastStartedAt : 0;
}

async function setLastBulkStartedNow() {
  const meta = await storageGetBulkMetaRoot();
  if (!meta[C.ORIGIN] || typeof meta[C.ORIGIN] !== "object") meta[C.ORIGIN] = {};
  meta[C.ORIGIN].lastStartedAt = Date.now();
  await storageSetBulkMetaRoot(meta);
}

/** このサイトで保存されているコースのうち、最も新しい updatedAt（ミリ秒）。無ければ 0 */
async function getOriginMaxCourseUpdatedAt() {
  const site = await loadSiteBucket();
  const by = site.byCourse || {};
  let max = 0;
  Object.keys(by).forEach((k) => {
    const b = by[k];
    if (b && typeof b.updatedAt === "number") max = Math.max(max, b.updatedAt);
  });
  return max;
}

async function getIsAutoBulkEnabled() {
  return new Promise((resolve) => {
    try {
      if (!F.extCtxOk()) {
        resolve(true);
        return;
      }
      chrome.storage.local.get(STORAGE_AUTO_BULK_ENABLED, (obj) => {
        F.flushChromeRuntimeLastError();
        if (!F.extCtxOk()) {
          resolve(true);
          return;
        }
        try {
          resolve(obj[STORAGE_AUTO_BULK_ENABLED] !== false);
        } catch {
          resolve(true);
        }
      });
    } catch {
      resolve(true);
    }
  });
}

/** 設定の「時間」に応じたミリ秒（1〜720 時間に丸め） */
async function getAutoBulkStaleIntervalMs() {
  return new Promise((resolve) => {
    try {
      if (!F.extCtxOk()) {
        resolve(AUTO_BULK_INTERVAL_HOURS_DEFAULT * 3600000);
        return;
      }
      chrome.storage.local.get(STORAGE_AUTO_BULK_HOURS, (obj) => {
        F.flushChromeRuntimeLastError();
        if (!F.extCtxOk()) {
          resolve(AUTO_BULK_INTERVAL_HOURS_DEFAULT * 3600000);
          return;
        }
        try {
          let h = obj[STORAGE_AUTO_BULK_HOURS];
          if (typeof h !== "number" || !Number.isFinite(h)) {
            h = AUTO_BULK_INTERVAL_HOURS_DEFAULT;
          }
          h = Math.floor(h);
          if (h < 1) h = 1;
          if (h > 720) h = 720;
          resolve(h * 3600000);
        } catch {
          resolve(AUTO_BULK_INTERVAL_HOURS_DEFAULT * 3600000);
        }
      });
    } catch {
      resolve(AUTO_BULK_INTERVAL_HOURS_DEFAULT * 3600000);
    }
  });
}

globalThis.WCDV_STORAGE = Object.freeze({
  getAutoBulkStaleIntervalMs,
  getIsAutoBulkEnabled,
  getLastBulkStartedAt,
  getOriginMaxCourseUpdatedAt,
  loadSiteBucket,
  saveSiteBucket,
  setLastBulkStartedNow,
});
})();
