(function () {
"use strict";

const C = globalThis.WCDV_CONTENT;

function parsePeriod(text) {
  const m = String(text || "").trim().match(C.PERIOD_RE);
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

/** スクレイプで利用回数行が取れているときだけリンクを出す */
function itemHasVisitCountLink(item) {
  return Boolean(
    (item.visitCountText && String(item.visitCountText).trim()) ||
    (item.historyHref && String(item.historyHref).trim())
  );
}

/** 教材「詳細」URL から WebClass 標準の利用回数（履歴）URL を推測する */
function historyHrefFromContentHref(contentHref) {
  if (!contentHref) return "";
  try {
    const u = new URL(contentHref);
    let p = u.pathname.replace(/\/+$/, "");
    if (/\/history$/i.test(p)) return u.href;
    if (!/\/contents\/[^/]+$/i.test(p)) return "";
    u.pathname = `${p}/history`;
    return u.href;
  } catch {
    return "";
  }
}

/** ストレージの byCourse キー用（クエリ・ハッシュを除き course ID だけに揃える） */
function canonicalCourseStorageKey(url) {
  try {
    const u = new URL(String(url), location.origin);
    const m = u.pathname.match(/\/webclass\/course\.php\/([^/?#]+)/i);
    if (!m) return String(url).split("#")[0].split("?")[0].trim();
    return `${u.origin}/webclass/course.php/${m[1]}/`;
  } catch {
    return String(url || "").trim();
  }
}

function pruneAliasCourseKeys(site, canonicalUrl) {
  const canon = canonicalCourseStorageKey(canonicalUrl);
  const by = site.byCourse;
  if (!by || typeof by !== "object") return;
  Object.keys(by).forEach((k) => {
    if (k !== canon && canonicalCourseStorageKey(k) === canon) {
      delete by[k];
    }
  });
}

/** 同一コースが複数キーで保存されているとき 1 キーにまとめる（読み込み時に永続化） */
function collapseDuplicateCourseEntries(bucket) {
  const by = bucket.byCourse;
  if (!by || typeof by !== "object") return false;
  const keys = Object.keys(by);
  if (keys.length === 0) return false;
  const groups = new Map();
  for (const k of keys) {
    const c = canonicalCourseStorageKey(k);
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(k);
  }
  let needsRebuild = false;
  groups.forEach((keyList) => {
    if (keyList.length > 1) needsRebuild = true;
    else if (keyList[0] !== canonicalCourseStorageKey(keyList[0])) needsRebuild = true;
  });
  if (!needsRebuild) return false;
  const next = {};
  groups.forEach((keyList, canon) => {
    const blocks = keyList.map((k) => by[k]).filter(Boolean);
    if (!blocks.length) return;
    let best = blocks[0];
    for (let i = 1; i < blocks.length; i++) {
      const b = blocks[i];
      const ua = best.updatedAt || 0;
      const ub = b.updatedAt || 0;
      const la = Array.isArray(best.items) ? best.items.length : 0;
      const lb = Array.isArray(b.items) ? b.items.length : 0;
      if (ub > ua || (ub === ua && lb > la)) best = b;
    }
    const items = dedupePlainItems(
      blocks.flatMap((b) => (Array.isArray(b.items) ? b.items : []))
    );
    next[canon] = {
      courseTitle: best.courseTitle || "コース",
      coursePageUrl: canon,
      updatedAt: Math.max(...blocks.map((b) => b.updatedAt || 0)),
      items,
    };
  });
  bucket.byCourse = next;
  return true;
}

/** 同一教材が DOM 上に複数出る場合の重複除去用（ハッシュ除去・volatile クエリ除去・順序正規化） */
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
      resubmissionText:
        (it.resubmissionText && String(it.resubmissionText).trim()) ||
        (prev.resubmissionText && String(prev.resubmissionText).trim()) ||
        "",
      hrefDetailColumn:
        (it.hrefDetailColumn && String(it.hrefDetailColumn).trim()) ||
        (prev.hrefDetailColumn && String(prev.hrefDetailColumn).trim()) ||
        "",
    });
  }
  return [...map.values()];
}

/** WebClass の New バッジ相当（「New 」「New第…」・保存データ名残）をタイトル先頭から除く */
function normalizeListItemTitleText(text) {
  let t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  t = t.replace(/^NewNew+/i, "").trim();
  t = t.replace(/^New\s+/i, "").trim();
  t = t.replace(/^New(?=\S)/i, "").trim();
  return t;
}

/** 右欄の「詳細」ショートカット（教材本体リンクではない） */
function isDetailShortcutAnchor(a) {
  if (!a) return false;
  const t = a.textContent.replace(/\s+/g, " ").trim();
  return t === "詳細";
}

/** 「利用回数 N 回」等の履歴リンク（課題本体ではない） */
function isVisitCountShortcutAnchor(a) {
  if (!a) return false;
  const t = a.textContent.replace(/\s+/g, " ").trim();
  const raw = (a.getAttribute("href") || "").trim();
  if (/利用回数/.test(t)) return true;
  if (/\/history(?:\?|\/|$)/i.test(raw)) return true;
  return false;
}

/**
 * 一覧行から教材本体の a を選ぶ。フォールバックの a[href*="/contents/"] が
 * 右列の「詳細」だけを拾って課題扱いになるのを避ける。
 */
function pickPrimaryContentLinkFromRow(row) {
  const nameBlock = row.querySelector(".cm-contentsList_contentName");
  if (nameBlock) {
    const inName = nameBlock.querySelectorAll("a[href]");
    for (let i = 0; i < inName.length; i++) {
      const a = inName[i];
      if (isDetailShortcutAnchor(a)) continue;
      if (isVisitCountShortcutAnchor(a)) continue;
      if ((a.getAttribute("href") || "").trim()) return a;
    }
  }
  const doLinks = row.querySelectorAll('a[href*="do_contents.php"]');
  for (let i = 0; i < doLinks.length; i++) {
    const a = doLinks[i];
    if (isDetailShortcutAnchor(a)) continue;
    if (isVisitCountShortcutAnchor(a)) continue;
    if ((a.getAttribute("href") || "").trim()) return a;
  }
  const contentsLinks = row.querySelectorAll('a[href*="/contents/"]');
  for (let i = 0; i < contentsLinks.length; i++) {
    const a = contentsLinks[i];
    if (isDetailShortcutAnchor(a)) continue;
    if (isVisitCountShortcutAnchor(a)) continue;
    if ((a.getAttribute("href") || "").trim()) return a;
  }
  return null;
}

/** 右列など「詳細」文言の a（課題名リンクとは別 URL のことがある） */
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

/** WebClass の「New」表示（バッジ要素 or リンク文言先頭の New） */
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

/** 右列の「利用回数 N」リンク（履歴 URL）を拾う */
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

function extractResubmissionText(row) {
  const labels = row.querySelectorAll(".cm-contentsList_contentDetailListItemLabel");
  for (let i = 0; i < labels.length; i++) {
    const text = labels[i].textContent.replace(/\s+/g, " ").trim();
    if (/再提出が必要/.test(text)) return text;
  }
  return "";
}

function extractPlainItems(baseUrl) {
  const rows = document.querySelectorAll("section.cl-contentsList_listGroupItem");
  const out = [];
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    const labels = row.querySelectorAll(".cm-contentsList_contentDetailListItemLabel");
    let periodEl = null;
    for (const el of labels) {
      if (el.textContent.trim() === C.LABEL_TEXT) {
        periodEl = el.nextElementSibling;
        break;
      }
    }
    if (
      !periodEl ||
      !periodEl.classList.contains("cm-contentsList_contentDetailListItemData")
    ) {
      continue;
    }
    const parsed = parsePeriod(periodEl.textContent);
    if (!parsed) continue;

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
    const resubmissionText = extractResubmissionText(row);

    out.push({
      folderTitle,
      titleText,
      href,
      hrefDetailColumn,
      category,
      wcNew: rowHasWcNewBadge(row),
      visitCountText,
      historyHref,
      resubmissionText,
      startMs: parsed.startMs,
      endMs: parsed.endMs,
      raw: parsed.raw,
    });
  }
  out.sort((a, b) => a.endMs - b.endMs);
  return dedupePlainItems(out);
}

function getCoursePageUrl() {
  try {
    return canonicalCourseStorageKey(location.href);
  } catch {
    return String(location.href).split("#")[0];
  }
}

function getCourseTitleFromDom() {
  const a = document.querySelector("a.course-name");
  if (a && a.textContent.trim()) return a.textContent.trim();
  return document.title.replace(/\s*-\s*WebClass\s*$/i, "").trim() || "コース";
}

globalThis.WCDV_COURSE_DATA = Object.freeze({
  collapseDuplicateCourseEntries,
  dedupePlainItems,
  extractPlainItems,
  getCoursePageUrl,
  getCourseTitleFromDom,
  historyHrefFromContentHref,
  itemHasVisitCountLink,
  normalizeItemHrefForDedupe,
  normalizeListItemTitleText,
  canonicalCourseStorageKey,
  pickPrimaryContentLinkFromRow,
  pruneAliasCourseKeys,
  resolveHref,
});
})();
