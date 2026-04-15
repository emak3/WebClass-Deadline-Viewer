/* global chrome */

importScripts("../shared/constants.js");

const {
  STORAGE_KEY,
  CONNECT_NAME,
  STORAGE_ORIGINS,
  STORAGE_ENABLED,
  STORAGE_AUTO_BULK_HOURS,
  STORAGE_AUTO_BULK_ENABLED,
  ORIGINS_MIGRATED_KEY,
} = globalThis.WCDV_SHARED;

let bulkRunning = false;

function scriptIdFromOrigin(origin) {
  let h = 0;
  for (let i = 0; i < origin.length; i++) {
    h = (Math.imul(31, h) + origin.charCodeAt(i)) | 0;
  }
  const safe = origin.replace(/[^a-zA-Z0-9]/g, "_");
  return ("wcdv_cs_" + (h >>> 0).toString(16) + "_" + safe).slice(0, 200);
}

function matchesForOrigin(origin) {
  const base = origin.replace(/\/$/, "");
  return [
    `${base}/webclass/*`,
    `${base}/*/webclass/*`,
    `${base}/WebClass/*`,
    `${base}/*/WebClass/*`,
  ];
}

async function syncContentScriptsFromStorage() {
  let registered;
  try {
    registered = await chrome.scripting.getRegisteredContentScripts();
  } catch {
    return;
  }
  const wcdvIds = registered.filter((s) => s.id.indexOf("wcdv_cs_") === 0).map((s) => s.id);
  if (wcdvIds.length) {
    try {
      await chrome.scripting.unregisterContentScripts({ ids: wcdvIds });
    } catch {
      /* ignore */
    }
  }

  const data = await chrome.storage.local.get([STORAGE_ENABLED, STORAGE_ORIGINS]);
  const enabled = data[STORAGE_ENABLED] !== false;
  const origins = Array.isArray(data[STORAGE_ORIGINS]) ? data[STORAGE_ORIGINS] : [];

  if (!enabled) return;

  for (let i = 0; i < origins.length; i++) {
    const origin = origins[i];
    const ok = await new Promise((resolve) => {
      chrome.permissions.contains({ origins: [`${origin}/*`] }, resolve);
    });
    if (!ok) continue;
    try {
      await chrome.scripting.registerContentScripts([
        {
          id: scriptIdFromOrigin(origin),
          matches: matchesForOrigin(origin),
          js: ["src/shared/constants.js", "src/content/content.js"],
          css: ["src/shared/styles/base.css", "src/content/content.css"],
          runAt: "document_end",
          allFrames: false,
        },
      ]);
    } catch (e) {
      console.warn("[WCDV] registerContentScripts", origin, e);
    }
  }
}

async function migrateOriginsFromDeadlineIfNeeded() {
  const flag = await chrome.storage.local.get(ORIGINS_MIGRATED_KEY);
  if (flag[ORIGINS_MIGRATED_KEY]) return;
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const root = data[STORAGE_KEY];
  const fromDeadline = [];
  if (root && typeof root === "object" && !Array.isArray(root)) {
    Object.keys(root).forEach((k) => {
      if (/^https?:\/\//i.test(k)) {
        try {
          fromDeadline.push(new URL(k).origin);
        } catch {
          /* skip */
        }
      }
    });
  }
  const cur = await chrome.storage.local.get(STORAGE_ORIGINS);
  const existing = Array.isArray(cur[STORAGE_ORIGINS]) ? cur[STORAGE_ORIGINS] : [];
  const merged = [...new Set([...existing, ...fromDeadline])];
  await chrome.storage.local.set({
    [ORIGINS_MIGRATED_KEY]: true,
    [STORAGE_ORIGINS]: merged,
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function courseKeyFromUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/webclass\/course\.php\/([^/?#]+)/i);
    if (!m) return url.split("?")[0];
    return `${u.origin}/webclass/course.php/${m[1]}/`;
  } catch {
    return url;
  }
}

function normalizeItemHrefForDedupeBg(href) {
  if (!href) return "";
  try {
    const u = new URL(href);
    u.hash = "";
    if (/\/contents\//i.test(u.pathname)) {
      u.search = "";
      return u.href;
    }
    const sp = new URLSearchParams();
    const keys = [...u.searchParams.keys()].sort();
    for (const k of keys) {
      if (/^acs_?$/i.test(k)) continue;
      u.searchParams.getAll(k).forEach((v) => sp.append(k, v));
    }
    const q = sp.toString();
    u.search = q ? `?${q}` : "";
    return u.href;
  } catch {
    return String(href).trim();
  }
}

function dedupePlainItemsBg(items) {
  const map = new Map();
  for (const it of items) {
    const h = normalizeItemHrefForDedupeBg(it.href);
    const key = h
      ? `h:${h}:${it.startMs}:${it.endMs}`
      : `t:${it.folderTitle}:${it.titleText}:${it.raw}:${it.startMs}:${it.endMs}`;
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...it, wcNew: !!it.wcNew });
      continue;
    }
    map.set(key, {
      ...prev,
      ...it,
      wcNew: !!(prev.wcNew || it.wcNew),
      visitCountText:
        (it.visitCountText && String(it.visitCountText).trim()) ||
        (prev.visitCountText && String(prev.visitCountText).trim()) ||
        "",
      historyHref:
        (it.historyHref && String(it.historyHref).trim()) ||
        (prev.historyHref && String(prev.historyHref).trim()) ||
        "",
    });
  }
  return [...map.values()];
}

async function mergeCourseIntoStorage(origin, coursePageUrl, courseTitle, items) {
  const key = courseKeyFromUrl(coursePageUrl);
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const root = data[STORAGE_KEY] || {};
  let bucket = root[origin];
  if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) {
    bucket = { byCourse: {} };
  }
  if (!bucket.byCourse || typeof bucket.byCourse !== "object") {
    bucket.byCourse = {};
  }
  Object.keys(bucket.byCourse).forEach((k) => {
    if (k !== key && courseKeyFromUrl(k) === key) {
      delete bucket.byCourse[k];
    }
  });
  const raw = Array.isArray(items) ? items : [];
  bucket.byCourse[key] = {
    courseTitle: courseTitle || "コース",
    coursePageUrl: key,
    updatedAt: Date.now(),
    items: dedupePlainItemsBg(raw),
  };
  root[origin] = bucket;
  await chrome.storage.local.set({ [STORAGE_KEY]: root });
}

/**
 * コース一覧ページ上で、目的のコースへの本物の <a> を click()（無ければ location.assign）。
 * プログラムの tabs.update 直叩きより SSO サインアウトが起きにくいことがある。
 */
async function navigateToCourseFromListPageByClick(tabId, expectedCourseUrl) {
  let injected;
  try {
    [injected] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [expectedCourseUrl],
      func: (expectedCourseUrlArg) => {
        function courseKeyFromUrlPage(url) {
          try {
            const u = new URL(url, location.href);
            const m = u.pathname.match(/\/webclass\/course\.php\/([^/?#]+)/i);
            if (!m) return String(url).split("?")[0];
            return `${u.origin}/webclass/course.php/${m[1]}/`;
          } catch {
            return String(url);
          }
        }
        const wantKey = courseKeyFromUrlPage(expectedCourseUrlArg);
        const anchors = document.querySelectorAll("a[href], area[href]");
        for (let j = 0; j < anchors.length; j++) {
          const a = anchors[j];
          if (a.target && String(a.target).toLowerCase() === "_blank") continue;
          const raw = a.getAttribute("href");
          if (!raw) continue;
          let abs;
          try {
            abs = new URL(raw, location.origin).href;
          } catch {
            continue;
          }
          const m = abs.match(/\/webclass\/course\.php\/([^/?#]+)/i);
          if (!m) continue;
          const u = new URL(abs);
          u.pathname = `/webclass/course.php/${m[1]}/`;
          u.hash = "";
          const linkKey = `${u.origin}/webclass/course.php/${m[1]}/`;
          if (linkKey !== wantKey) continue;
          a.click();
          return { how: "click" };
        }
        location.assign(expectedCourseUrlArg);
        return { how: "assign" };
      },
    });
  } catch (e) {
    throw new Error(
      "コース一覧からの遷移に失敗しました: " + (e && e.message ? e.message : e)
    );
  }
  const how = injected && injected.result && injected.result.how;
  console.info("[WCDV bg] コース一覧→コース:", how || "?", expectedCourseUrl);
  return how || "assign";
}

function waitTabComplete(tabId) {
  return new Promise((resolve) => {
    let done = false;
    function finish() {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    function onUpdated(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        finish();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        finish();
        return;
      }
      if (tab && tab.status === "complete") {
        finish();
      }
    });
  });
}

/**
 * 教材一覧の行が出るか、「教材がありません」等で空と分かるまで待つ。
 */
async function waitForCourseMaterialsReady(tabId, timeoutMs) {
  const t0 = Date.now();
  let firstRowAt = null;
  while (Date.now() - t0 < timeoutMs) {
    let results;
    try {
      [results] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const path = location.pathname || "";
          const onLogin =
            path.includes("/webclass/login") ||
            path.includes("logout") ||
            /login\.php/i.test(path);
          const contents = document.getElementById("js-contents");
          const text = (contents && contents.innerText) || document.body.innerText || "";
          const emptyMaterials =
            /教材がありません/.test(text) ||
            /教材は登録されていません/.test(text) ||
            /コンテンツがありません/.test(text);
          const n = document.querySelectorAll("section.cl-contentsList_listGroupItem").length;
          return { n, emptyMaterials, onLogin };
        },
      });
    } catch {
      await sleep(400);
      continue;
    }
    const r = results && results.result;
    if (!r) {
      await sleep(320);
      continue;
    }
    if (r.onLogin) {
      const err = new Error("LOGIN");
      err.code = "LOGIN";
      throw err;
    }
    if (r.emptyMaterials) {
      await sleep(400);
      return;
    }
    if (r.n > 0) {
      if (firstRowAt === null) firstRowAt = Date.now();
      else if (Date.now() - firstRowAt >= 1500) return;
    } else {
      firstRowAt = null;
    }
    await sleep(320);
  }
}

function scrapeCoursePageInTab() {
  const LABEL_TEXT = "利用可能期間";
  const PERIOD_RE =
    /^\s*(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})\s*-\s*(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})\s*$/;

  function parsePeriod(text) {
    const m = String(text || "").trim().match(PERIOD_RE);
    if (!m) return null;
    const start = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0);
    const end = new Date(+m[6], +m[7] - 1, +m[8], +m[9], +m[10], 0, 0);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
    return { startMs: start.getTime(), endMs: end.getTime(), raw: text.trim() };
  }

  function resolveHref(href, baseUrl) {
    if (!href) return "";
    try {
      return new URL(href, baseUrl).href;
    } catch {
      return href;
    }
  }

  function normalizeItemHrefForDedupe(href) {
    if (!href) return "";
    try {
      const u = new URL(href);
      u.hash = "";
      if (/\/contents\//i.test(u.pathname)) {
        u.search = "";
        return u.href;
      }
      const sp = new URLSearchParams();
      const keys = [...u.searchParams.keys()].sort();
      for (const k of keys) {
        if (/^acs_?$/i.test(k)) continue;
        u.searchParams.getAll(k).forEach((v) => sp.append(k, v));
      }
      const q = sp.toString();
      u.search = q ? `?${q}` : "";
      return u.href;
    } catch {
      return String(href).trim();
    }
  }

  function dedupePlainItems(items) {
    const map = new Map();
    for (const it of items) {
      const h = normalizeItemHrefForDedupe(it.href);
      const key = h
        ? `h:${h}:${it.startMs}:${it.endMs}`
        : `t:${it.folderTitle}:${it.titleText}:${it.raw}:${it.startMs}:${it.endMs}`;
      const prev = map.get(key);
      if (!prev) {
        map.set(key, { ...it, wcNew: !!it.wcNew });
        continue;
      }
      map.set(key, {
        ...prev,
        ...it,
        wcNew: !!(prev.wcNew || it.wcNew),
        visitCountText:
          (it.visitCountText && String(it.visitCountText).trim()) ||
          (prev.visitCountText && String(prev.visitCountText).trim()) ||
          "",
        historyHref:
          (it.historyHref && String(it.historyHref).trim()) ||
          (prev.historyHref && String(prev.historyHref).trim()) ||
          "",
        hrefDetailColumn:
          (it.hrefDetailColumn && String(it.hrefDetailColumn).trim()) ||
          (prev.hrefDetailColumn && String(prev.hrefDetailColumn).trim()) ||
          "",
      });
    }
    return [...map.values()];
  }

  function getCoursePageUrl() {
    const u = new URL(location.href);
    const m = u.pathname.match(/\/webclass\/course\.php\/([^/]+)/);
    if (!m) return location.href;
    u.pathname = `/webclass/course.php/${m[1]}/`;
    u.hash = "";
    return u.toString();
  }

  function getCourseTitleFromDom() {
    const a = document.querySelector("a.course-name");
    if (a && a.textContent.trim()) return a.textContent.trim();
    return document.title.replace(/\s*-\s*WebClass\s*$/i, "").trim() || "コース";
  }

  function normalizeListItemTitleText(text) {
    let t = String(text || "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    t = t.replace(/^NewNew+/i, "").trim();
    t = t.replace(/^New\s+/i, "").trim();
    t = t.replace(/^New(?=\S)/i, "").trim();
    return t;
  }

  function isDetailShortcutAnchor(a) {
    if (!a) return false;
    const t = a.textContent.replace(/\s+/g, " ").trim();
    return t === "詳細";
  }

  function pickPrimaryContentLinkFromRow(row) {
    const nameBlock = row.querySelector(".cm-contentsList_contentName");
    if (nameBlock) {
      const inName = nameBlock.querySelectorAll("a[href]");
      for (let i = 0; i < inName.length; i++) {
        const a = inName[i];
        if (isDetailShortcutAnchor(a)) continue;
        if ((a.getAttribute("href") || "").trim()) return a;
      }
    }
    const doLinks = row.querySelectorAll('a[href*="do_contents.php"]');
    for (let i = 0; i < doLinks.length; i++) {
      const a = doLinks[i];
      if (isDetailShortcutAnchor(a)) continue;
      if ((a.getAttribute("href") || "").trim()) return a;
    }
    const contentsLinks = row.querySelectorAll('a[href*="/contents/"]');
    for (let i = 0; i < contentsLinks.length; i++) {
      const a = contentsLinks[i];
      if (isDetailShortcutAnchor(a)) continue;
      if ((a.getAttribute("href") || "").trim()) return a;
    }
    return null;
  }

  function pickDetailShortcutLinkFromRow(row) {
    const detailRoot = row.querySelector(".cl-contentsList_contentDetail") || row;
    const candidates = detailRoot.querySelectorAll("a[href]");
    for (let i = 0; i < candidates.length; i++) {
      const a = candidates[i];
      if (!isDetailShortcutAnchor(a)) continue;
      const h = (a.getAttribute("href") || "").trim();
      if (h) return a;
    }
    return null;
  }

  function rowHasWcNewBadge(row) {
    if (row.querySelector(".cl-contentsList_new")) return true;
    const linkEl = pickPrimaryContentLinkFromRow(row);
    if (!linkEl) return false;
    const raw = linkEl.textContent.replace(/\s+/g, " ").trim();
    if (!raw) return false;
    if (/^New(\s+|$)/i.test(raw)) return true;
    if (/^New(?=[0-9０-９第全前])/i.test(raw)) return true;
    return false;
  }

  /** WebClass の .cl-contentsList_new（「New」バッジ）をタイトルに含めない */
  function extractTitleTextFromListRow(row) {
    const nameBlock = row.querySelector(".cm-contentsList_contentName");
    const linkEl = pickPrimaryContentLinkFromRow(row);
    if (linkEl) {
      const t = linkEl.textContent.replace(/\s+/g, " ").trim();
      if (t) return normalizeListItemTitleText(t);
    }
    if (nameBlock) {
      const clone = nameBlock.cloneNode(true);
      clone.querySelectorAll(".cl-contentsList_new").forEach((el) => el.remove());
      return normalizeListItemTitleText(clone.textContent.replace(/\s+/g, " ").trim());
    }
    return "";
  }

  function extractVisitCountFromListRow(row, baseUrl) {
    const detailRoot = row.querySelector(".cl-contentsList_contentDetail") || row;
    const contentLink = pickPrimaryContentLinkFromRow(row);
    const candidates = detailRoot.querySelectorAll("a[href]");
    for (let i = 0; i < candidates.length; i++) {
      const a = candidates[i];
      if (contentLink && a === contentLink) continue;
      const raw = a.getAttribute("href") || "";
      const t = a.textContent.replace(/\s+/g, " ").trim();
      const isVisit =
        /利用回数/.test(t) ||
        /\/history(?:\?|\/|$)/i.test(raw) ||
        /\/history\?/i.test(raw);
      if (!isVisit) continue;
      return {
        visitCountText: t || "利用回数",
        historyHref: resolveHref(raw, baseUrl),
      };
    }
    return { visitCountText: "", historyHref: "" };
  }

  function extractPlainItems(baseUrl) {
    const rows = document.querySelectorAll("section.cl-contentsList_listGroupItem");
    const out = [];
    rows.forEach((row) => {
      const labels = row.querySelectorAll(".cm-contentsList_contentDetailListItemLabel");
      let periodEl = null;
      for (const el of labels) {
        if (el.textContent.trim() === LABEL_TEXT) {
          periodEl = el.nextElementSibling;
          break;
        }
      }
      if (
        !periodEl ||
        !periodEl.classList.contains("cm-contentsList_contentDetailListItemData")
      ) {
        return;
      }
      const parsed = parsePeriod(periodEl.textContent);
      if (!parsed) return;

      const folderSection = row.closest("section.cl-contentsList_folder");
      const panel = folderSection && folderSection.querySelector(".panel-title");
      const folderTitle = panel ? panel.textContent.trim() : "";

      const titleText = extractTitleTextFromListRow(row);

      const linkEl = pickPrimaryContentLinkFromRow(row);
      const href = resolveHref(
        linkEl ? linkEl.getAttribute("href") : "",
        baseUrl
      );
      const detailShortcutEl = pickDetailShortcutLinkFromRow(row);
      const hrefDetailColumn = resolveHref(
        detailShortcutEl ? detailShortcutEl.getAttribute("href") : "",
        baseUrl
      );

      const catEl = row.querySelector(".cl-contentsList_categoryLabel");
      const category = catEl ? catEl.textContent.trim() : "";

      const { visitCountText, historyHref } = extractVisitCountFromListRow(row, baseUrl);

      out.push({
        folderTitle,
        titleText,
        href,
        hrefDetailColumn,
        category,
        wcNew: rowHasWcNewBadge(row),
        visitCountText,
        historyHref,
        startMs: parsed.startMs,
        endMs: parsed.endMs,
        raw: parsed.raw,
      });
    });
    out.sort((a, b) => a.endMs - b.endMs);
    return dedupePlainItems(out);
  }

  const coursePageUrl = getCoursePageUrl();
  const courseTitle = getCourseTitleFromDom();
  const items = extractPlainItems(coursePageUrl);
  return { coursePageUrl, courseTitle, items };
}

function assertWebclassPathBulkUrls(origin, listUrl, entries) {
  const pathOk = (u) => {
    try {
      return new URL(u).pathname.includes("/webclass/");
    } catch {
      return false;
    }
  };
  let listParsed;
  try {
    listParsed = new URL(listUrl);
  } catch {
    throw new Error("一覧ページの URL が不正です。");
  }
  if (!pathOk(listUrl)) {
    throw new Error("一覧ページのパスに /webclass/ を含めてください。");
  }
  let originParsed;
  try {
    originParsed = new URL(origin);
  } catch {
    throw new Error("保存先オリジンが不正です。");
  }
  if (originParsed.origin !== listParsed.origin) {
    throw new Error("保存先と一覧ページのオリジンが一致しません。");
  }
  for (let i = 0; i < entries.length; i++) {
    const u = entries[i] && entries[i].url;
    if (!u || !pathOk(u)) {
      throw new Error(`コース ${i + 1} の URL のパスに /webclass/ を含めてください。`);
    }
  }
}

function safePortPost(port, msg) {
  try {
    port.postMessage(msg);
    return true;
  } catch {
    return false;
  } finally {
    try {
      void chrome.runtime.lastError;
    } catch {
      /* ignore */
    }
  }
}

async function runBulkInBackground(port, payload) {
  const { origin, listUrl, entries } = payload;
  if (!origin || !listUrl || !Array.isArray(entries) || entries.length === 0) {
    safePortPost(port, { type: "error", message: "一括取得の引数が不正です。" });
    return;
  }
  try {
    assertWebclassPathBulkUrls(origin, listUrl, entries);
  } catch (e) {
    safePortPost(port, { type: "error", message: e && e.message ? e.message : String(e) });
    return;
  }

  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: listUrl, active: false });
    tabId = tab.id;
    await waitTabComplete(tabId);
    await sleep(900);

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const targetUrl = entry.url;

      if (i > 0) {
        await chrome.tabs.update(tabId, { url: listUrl, active: false });
        await waitTabComplete(tabId);
        await sleep(1200);
      }

      await navigateToCourseFromListPageByClick(tabId, targetUrl);
      await waitTabComplete(tabId);

      let exists = true;
      try {
        await chrome.tabs.get(tabId);
      } catch {
        exists = false;
      }
      if (!exists) {
        safePortPost(port, {
          type: "error",
          message: "バックグラウンドのタブが閉じられたため一括取得を中止しました。",
        });
        return;
      }

      await waitForCourseMaterialsReady(tabId, 32000);
      await sleep(900);

      let scrapeResult;
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: scrapeCoursePageInTab,
        });
        scrapeResult = result;
      } catch (e) {
        safePortPost(port, {
          type: "error",
          message: "ページからの読み取りに失敗しました: " + (e && e.message ? e.message : e),
        });
        return;
      }

      if (!scrapeResult || !scrapeResult.coursePageUrl) {
        safePortPost(port, { type: "error", message: "コース情報を取得できませんでした。" });
        return;
      }

      const gotKey = courseKeyFromUrl(scrapeResult.coursePageUrl);
      const expKey = courseKeyFromUrl(targetUrl);
      if (gotKey !== expKey) {
        safePortPost(port, {
          type: "error",
          message:
            "想定と違うページに遷移しました（ログイン画面など）。コースリストからやり直してください。",
        });
        return;
      }

      const title = scrapeResult.courseTitle || entry.title || "コース";
      const items = scrapeResult.items || [];
      await mergeCourseIntoStorage(origin, scrapeResult.coursePageUrl, title, items);

      if (!safePortPost(port, {
        type: "progress",
        done: i + 1,
        total: entries.length,
        nItems: items.length,
      })) {
        return;
      }
    }

    safePortPost(port, { type: "done", total: entries.length });
  } catch (e) {
    if (e && e.code === "LOGIN") {
      safePortPost(port, {
        type: "error",
        message:
          "ログイン画面に遷移したため一括取得を中止しました。WebClass にログインしたうえでやり直してください。",
      });
    } else {
      safePortPost(port, {
        type: "error",
        message: e && e.message ? e.message : String(e),
      });
    }
  } finally {
    if (tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        /* ignore */
      }
    }
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CONNECT_NAME) return;

  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "start") return;
    if (bulkRunning) {
      safePortPost(port, { type: "error", message: "すでに一括取得が実行中です。" });
      return;
    }
    bulkRunning = true;
    void (async () => {
      try {
        await runBulkInBackground(port, msg);
      } finally {
        bulkRunning = false;
      }
    })();
  });
});

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    if (details.reason === "install") {
      await chrome.storage.local.set({
        [STORAGE_ENABLED]: true,
        [STORAGE_ORIGINS]: [],
        [STORAGE_AUTO_BULK_HOURS]: 6,
        [STORAGE_AUTO_BULK_ENABLED]: true,
      });
      await chrome.runtime.openOptionsPage();
    }
    if (details.reason === "update") {
      await migrateOriginsFromDeadlineIfNeeded();
    }
    await syncContentScriptsFromStorage();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void syncContentScriptsFromStorage();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STORAGE_ORIGINS] || changes[STORAGE_ENABLED]) {
    void syncContentScriptsFromStorage();
  }
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});
