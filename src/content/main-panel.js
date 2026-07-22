/* eslint-disable no-unused-vars -- shared content-script chunk */
(function () {
  "use strict";
  const {
    STORAGE_KEY,
    CONNECT_NAME,
    BULK_META_KEY,
    STORAGE_AUTO_BULK_HOURS,
    STORAGE_AUTO_BULK_ENABLED,
    AUTO_BULK_INTERVAL_HOURS_DEFAULT,
    BULK_SHORT_INTERVAL_WARN_MS,
    PANEL_COLLAPSED_KEY,
    STORAGE_SUBMITTED_ITEMS,
  } = globalThis.WCDV_SHARED;
  const C = globalThis.WCDV_CONTENT;

  const _f = globalThis.WCDV_CONTENT_FNS;
  const {
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
  } = globalThis.WCDV_COURSE_DATA;
  const {
    getAutoBulkStaleIntervalMs,
    getIsAutoBulkEnabled,
    getLastBulkStartedAt,
    getOriginMaxCourseUpdatedAt,
    loadSiteBucket,
    saveSiteBucket,
    setLastBulkStartedNow,
  } = globalThis.WCDV_STORAGE;
  const {
    bindWcdvCourseLinkHumanLike,
    bindWcdvItemLinkNativeNavigate,
    rememberWebclassCourseListUrl,
    startPendingAssignmentNavConsumer,
    tryAdvancePendingNavFromListPage,
  } = globalThis.WCDV_ITEM_NAVIGATION;
  const {
    LIST_SEARCH_INPUT_HELP_TITLE,
    applySearchTextFilter,
    configure: configureSearchPanel,
    setData: setSearchPanelData,
    updateSearchSuggestionsDom,
    wireListSearchUi,
  } = globalThis.WCDV_SEARCH_PANEL;

  configureSearchPanel({
    applyNonSearchListFilters,
    itemStorageFingerprint,
    refreshListPanel,
  });

  /** renderList 直後の候補用（検索入力のたびに storage を読み直さない） */

window.addEventListener("pagehide", (ev) => {
  if (!ev.persisted) return;
  if (C.wcdvBulkPort) {
    try {
      C.wcdvBulkPort.disconnect();
    } catch {
      /* ignore */
    }
    C.wcdvBulkPort = null;
  }
  C.wcdvBulkRunningLocal = false;
});

window.addEventListener("pageshow", (ev) => {
  if (!ev.persisted) return;
  C.wcdvAutoBulkStaleAttempted = false;
  const r = document.getElementById("wcdv-root");
  if (r && r.isConnected && _f.isCourseListPage() && _f.isWebclassPathPage()) {
    scheduleStaleAutoBulk(r);
  }
});
function isCourseHomePage() {
  return /^\/webclass\/course\.php\/[^/]+\/?$/.test(location.pathname);
}

/**
 * course.php 以降にパスが続く URL や Course.php など大文字表記もコース教材トップに正規化する。
 */
function normalizeCourseEntry(href) {
  try {
    const u = new URL(href, location.origin);
    const m = u.pathname.match(/\/webclass\/course\.php\/([^/?#]+)/i);
    if (!m) return null;
    const id = m[1];
    u.pathname = `/webclass/course.php/${id}/`;
    u.hash = "";
    const key = `${u.origin}/webclass/course.php/${id}/`;
    return { key, fetchUrl: u.toString() };
  } catch {
    return null;
  }
}

function mergeCourseTitleIntoMap(map, norm, titleSourceEl) {
  const rawTitle = titleSourceEl ? String(titleSourceEl.textContent || "") : "";
  const title = rawTitle
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^»\s*/, "")
    .trim();
  const cur = map.get(norm.key);
  if (!cur) {
    map.set(norm.key, {
      fetchUrl: norm.fetchUrl,
      title: title || norm.key,
    });
  } else if (title.length > cur.title.length) {
    cur.title = title;
  }
}

/**
 * コース一覧・時間割まわりのリンクを拾う（a / area、data-* に URL があるパターン）。
 * 一括取得では sortCoursesForBulk でコース名順に並べ替える。
 */
function discoverCourses() {
  const map = new Map();

  function considerRawHref(raw, titleEl) {
    if (raw == null || typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    let abs;
    try {
      abs = new URL(trimmed, location.origin).href;
    } catch {
      return;
    }
    const norm = normalizeCourseEntry(abs);
    if (!norm) return;
    mergeCourseTitleIntoMap(map, norm, titleEl);
  }

  document.querySelectorAll("a[href], area[href]").forEach((el) => {
    considerRawHref(el.getAttribute("href"), el);
  });

  const dataAttrs = ["data-href", "data-url", "data-link", "data-to", "data-uri"];
  document.querySelectorAll(dataAttrs.map((a) => `[${a}]`).join(",")).forEach((el) => {
    for (let i = 0; i < dataAttrs.length; i++) {
      const v = el.getAttribute(dataAttrs[i]);
      if (v && /course\.php\//i.test(v)) {
        considerRawHref(v, el);
        break;
      }
    }
  });

  document.querySelectorAll("[onclick]").forEach((el) => {
    const oc = el.getAttribute("onclick") || "";
    const re = /\/webclass\/course\.php\/[^'"?\s#)]+/gi;
    let m;
    const seen = new Set();
    while ((m = re.exec(oc)) !== null) {
      const frag = m[0];
      if (seen.has(frag)) continue;
      seen.add(frag);
      considerRawHref(frag, el);
    }
  });

  return [...map.values()];
}

/** 一括取得の遷移順を固定（表示名の日本語ロケール比較、同じなら URL） */
function sortCoursesForBulk(courses) {
  return courses.slice().sort((a, b) => {
    const t = a.title.localeCompare(b.title, "ja", { sensitivity: "base" });
    if (t !== 0) return t;
    return a.fetchUrl.localeCompare(b.fetchUrl);
  });
}

function formatBulkOrderPreview(courses, maxLines) {
  const n = typeof maxLines === "number" ? maxLines : 15;
  const lines = courses.slice(0, n).map((c, i) => `${i + 1}. ${c.title}`);
  const tail =
    courses.length > n ? `\n… 他 ${courses.length - n} コース（同じく名順の後ろ）` : "";
  return lines.join("\n") + tail;
}

function showCourseSaveToast(n) {
  let el = document.getElementById("wcdv-course-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "wcdv-course-toast";
    document.body.appendChild(el);
  }
  el.textContent =
    n > 0
      ? `このコースの利用可能期間（${n}件）を保存しました`
      : "このページに利用可能期間付きの教材はありませんでした（保存を更新）";
  el.classList.add("wcdv-toast-visible");
  if (C.saveToastTimer) clearTimeout(C.saveToastTimer);
  C.saveToastTimer = setTimeout(() => {
    el.classList.remove("wcdv-toast-visible");
  }, 4500);
}

function showBulkProgressToast(done, total, nItems) {
  let el = document.getElementById("wcdv-course-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "wcdv-course-toast";
    document.body.appendChild(el);
  }
  el.textContent = `一括取得 ${done}/${total} コース（この回 ${nItems} 件の期限を保存）`;
  el.classList.add("wcdv-toast-visible");
  if (C.saveToastTimer) clearTimeout(C.saveToastTimer);
  C.saveToastTimer = setTimeout(() => {
    el.classList.remove("wcdv-toast-visible");
  }, 3500);
}

function showBulkDoneToast(total) {
  let el = document.getElementById("wcdv-course-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "wcdv-course-toast";
    document.body.appendChild(el);
  }
  el.textContent = `一括取得が完了しました（${total} コース。バックグラウンドのタブは閉じます）`;
  el.classList.add("wcdv-toast-visible");
  if (C.saveToastTimer) clearTimeout(C.saveToastTimer);
  C.saveToastTimer = setTimeout(() => {
    el.classList.remove("wcdv-toast-visible");
  }, 5000);
}

async function saveCurrentCoursePage() {
  const coursePageUrl = getCoursePageUrl();
  const courseTitle = getCourseTitleFromDom();
  const items = extractPlainItems(coursePageUrl);
  const site = await loadSiteBucket();
  pruneAliasCourseKeys(site, coursePageUrl);
  site.byCourse[coursePageUrl] = {
    courseTitle,
    coursePageUrl,
    updatedAt: Date.now(),
    items,
  };
  await saveSiteBucket(site);
  showCourseSaveToast(items.length);
}

function runCoursePage() {
  startPendingAssignmentNavConsumer();

  let t = null;
  const schedule = () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      saveCurrentCoursePage();
    }, 900);
  };
  schedule();
  const target = document.getElementById("js-contents") || document.body;
  const obs = new MutationObserver(() => schedule());
  obs.observe(target, { childList: true, subtree: true });
}

function normalizeForDisplay(rows) {
  const now = Date.now();
  return rows
    .map((r) => {
      const period = {
        start: new Date(r.startMs),
        end: new Date(r.endMs),
        raw: r.raw,
      };
      let status = "open";
      if (now < r.startMs) status = "upcoming";
      else if (now > r.endMs) status = "ended";
      const open = status === "open";
      const primary = open && r.href ? String(r.href).trim() : "";
      const detailCol =
        open && r.hrefDetailColumn ? String(r.hrefDetailColumn).trim() : "";
      const hrefTitle = primary || detailCol;
      const hrefDetail = detailCol || primary;
      const dedupeHref = normalizeItemHrefForDedupe(String(r.href || "").trim());
      return {
        folderTitle: r.folderTitle,
        titleText: normalizeListItemTitleText(r.titleText),
        href: primary,
        hrefTitle,
        hrefDetail,
        dedupeHref,
        startMs: r.startMs,
        endMs: r.endMs,
        raw: r.raw,
        category: r.category,
        wcNew: r.wcNew === true,
        visitCountText:
          open && r.visitCountText ? String(r.visitCountText).trim() : "",
        historyHref: open && r.historyHref ? String(r.historyHref).trim() : "",
        resubmissionText: r.resubmissionText
          ? String(r.resubmissionText)
              .trim()
              .replace(/\s+(?=締め切り\s*[:：])/, "\n")
          : "",
        resubmissionDeadlineMs: Number(r.resubmissionDeadlineMs) || null,
        courseTitle: r.courseTitle,
        coursePageUrl: r.coursePageUrl,
        courseUpdatedAt: r.courseUpdatedAt || 0,
        period,
        status,
      };
    })
    .sort((a, b) => a.period.end - b.period.end);
}

async function flattenStoredItems() {
  const site = await loadSiteBucket();
  const flat = [];
  const by = site.byCourse || {};
  Object.keys(by).forEach((key) => {
    const block = by[key];
    if (!block || !Array.isArray(block.items)) return;
    const updatedAt = block.updatedAt || 0;
    dedupePlainItems(block.items).forEach((it) => {
      flat.push({
        ...it,
        courseTitle: block.courseTitle || "コース",
        coursePageUrl: block.coursePageUrl || key,
        courseUpdatedAt: updatedAt,
      });
    });
  });
  return normalizeForDisplay(flat);
}

function formatCountdownToEnd(endMs, isResubmissionDeadline = false) {
  const now = Date.now();
  if (now >= endMs) {
    return isResubmissionDeadline
      ? "再提出期限を過ぎています"
      : "締切（利用可能期間の終了）を過ぎています";
  }
  const diff = endMs - now;
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return `あと${d}日${h}時間${m}分`;
}
/** 受付中=緑・締切=赤・残り2時間未満=黄（行左アクセント用クラス） */
function deadlineRowUrgencyClass(item) {
  const now = Date.now();
  const endMs = item.period.end.getTime();
  if (item.status === "ended" || now >= endMs) return "wcdv-wc-item--deadline-ended";
  if (item.status === "upcoming") return "wcdv-wc-item--deadline-upcoming";
  const remain = endMs - now;
  if (remain > 0 && remain < C.WCDV_DEADLINE_SOON_MS) return "wcdv-wc-item--deadline-soon";
  return "wcdv-wc-item--deadline-open";
}

function getListFilterMode() {
  const fromHost = document.querySelector("#wcdv-panel-filters-host input[name=\"wcdv-filter\"]:checked");
  if (fromHost) return fromHost.value;
  const rootEl = document.getElementById("wcdv-root");
  const r = rootEl && rootEl.querySelector('input[name="wcdv-filter"]:checked');
  return r ? r.value : "week";
}

function isExcludeNoPeriod() {
  const c = document.getElementById("wcdv-exclude-noperiod");
  return !!(c && c.checked);
}

 /** 提出済みフラグの保存キー（dedupePlainItems と同じ安定性） */
function itemStorageFingerprint(item) {
  const courseKey = canonicalCourseStorageKey(item.coursePageUrl || "");
  const h = item.dedupeHref || normalizeItemHrefForDedupe(String(item.href || "").trim());
  if (h)
    return `${courseKey}|h:${h}:${item.startMs}:${item.endMs}`;
  return `${courseKey}|t:${item.folderTitle || ""}:${item.titleText || ""}:${item.raw || ""}:${item.startMs}:${item.endMs}`;
}

async function loadSubmittedKeySet() {
  try {
    const got = await chrome.storage.local.get(STORAGE_SUBMITTED_ITEMS);
    const bag = got[STORAGE_SUBMITTED_ITEMS];
    const arr =
      bag && typeof bag === "object" && Array.isArray(bag[C.ORIGIN]) ? bag[C.ORIGIN] : [];
    return new Set(arr.map((x) => String(x)));
  } catch {
    return new Set();
  }
}

async function saveSubmittedKeySet(set) {
  const got = await chrome.storage.local.get(STORAGE_SUBMITTED_ITEMS);
  const prev = got[STORAGE_SUBMITTED_ITEMS];
  const bag = prev && typeof prev === "object" ? { ...prev } : {};
  bag[C.ORIGIN] = [...set];
  await chrome.storage.local.set({ [STORAGE_SUBMITTED_ITEMS]: bag });
}

function applyNonSearchListFilters(items, submittedSet) {
  const mode = getListFilterMode();
  const now = Date.now();
  const weekMs = 7 * 86400000;
  let out = items.slice();
  const sub = submittedSet instanceof Set ? submittedSet : new Set();

  if (mode === "submitted") {
    out = out.filter((it) => sub.has(itemStorageFingerprint(it)));
  } else {
    out = out.filter((it) => !sub.has(itemStorageFingerprint(it)));
  }

  if (isExcludeNoPeriod()) {
    out = out.filter((it) => it.period && String(it.period.raw || "").trim().length > 0);
  }

  if (mode === "submitted") {
    /* 提出済みタブ: 受付中のみ（締切済み・未開始は対象外） */
    out = out.filter((it) => it.status === "open");
    return out;
  }

  if (mode === "week") {
    out = out.filter((it) => it.period.end.getTime() >= now && it.period.end.getTime() <= now + weekMs);
  } else if (mode === "active") {
    /* 「締切前すべて」: 受付中のみ。未開始は「すべて」で表示 */
    out = out.filter((it) => it.status === "open");
  } else if (mode === "ended") {
    out = out.filter((it) => it.status === "ended");
  }

  return out;
}

function applyListFilters(items, submittedSet) {
  return applySearchTextFilter(applyNonSearchListFilters(items, submittedSet));
}

function scheduleSubmittedListRefresh() {
  if (C.wcdvSubmittedListRefreshTimer != null) clearTimeout(C.wcdvSubmittedListRefreshTimer);
  C.wcdvSubmittedListRefreshTimer = setTimeout(() => {
    C.wcdvSubmittedListRefreshTimer = null;
    const r = document.getElementById("wcdv-root");
    if (r && r.isConnected) void refreshListPanel(r);
  }, C.WCDV_SUBMITTED_LIST_REFRESH_MS);
}

function bindSubmittedCheckboxInput(inp, fp) {
  inp.type = "checkbox";
  inp.className = "wcdv-wc-submit-cb";
  inp.addEventListener("change", () => {
    void (async () => {
      const set = await loadSubmittedKeySet();
      if (inp.checked) set.add(fp);
      else set.delete(fp);
      await saveSubmittedKeySet(set);
      scheduleSubmittedListRefresh();
    })();
  });
}

function itemShowsSubmittedCheckbox(item) {
  return item && item.status === "open";
}

/** WebClass スキン: 右列下端（締切まで行と同じ高さ帯・図の青枠付近） */
function appendSubmittedWcDetailFooter(detail, item, submittedSet) {
  const fp = itemStorageFingerprint(item);
  const foot = document.createElement("div");
  foot.className = "wcdv-wc-submit-detail-footer";
  const lab = document.createElement("label");
  lab.className = "wcdv-wc-submit-cb-label--detail-footer";
  const inp = document.createElement("input");
  bindSubmittedCheckboxInput(inp, fp);
  inp.checked = submittedSet.has(fp);
  lab.appendChild(inp);
  const t = document.createElement("span");
  t.className = "wcdv-wc-submit-cb-text";
  t.textContent = "提出済み";
  lab.appendChild(t);
  foot.appendChild(lab);
  detail.appendChild(foot);
}

/** プレーン行: 利用可能期間の下（チェック → 提出済みの順） */
function appendSubmittedPlainRow(row, item, submittedSet) {
  const fp = itemStorageFingerprint(item);
  const submitRow = document.createElement("div");
  submitRow.className = "wcdv-wc-period wcdv-wc-submit-plain-row";
  const lab = document.createElement("label");
  lab.className = "wcdv-wc-submit-cb-label--plain-inline";
  const inp = document.createElement("input");
  bindSubmittedCheckboxInput(inp, fp);
  inp.checked = submittedSet.has(fp);
  lab.appendChild(inp);
  const t = document.createElement("span");
  t.className = "wcdv-wc-submit-cb-text";
  t.textContent = "提出済み";
  lab.appendChild(t);
  submitRow.appendChild(lab);
  row.appendChild(submitRow);
}

/** パネル表示中のコース教材トップと item のコースが一致するとき true */
 async function renderList(root, allItems) {
  rememberWebclassCourseListUrl();
  tryAdvancePendingNavFromListPage();

  const badge = document.getElementById("wcdv-badge");
  const list = root.querySelector("#wcdv-list");
  const prog = root.querySelector("#wcdv-progress");
  const wcSkin = root.classList.contains("wcdv-wc-skin-wc");

  if (prog) prog.textContent = "";

  const submittedSet = await loadSubmittedKeySet();
  setSearchPanelData(allItems, submittedSet);
  const baseItems = applyNonSearchListFilters(allItems, submittedSet);
  const items = applySearchTextFilter(baseItems);
  if (badge) badge.textContent = `（${items.length}）`;

  if (list) {
    if (wcSkin) list.classList.add("list-group");
    else list.classList.remove("list-group");
  }

  list.innerHTML = "";

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "wcdv-wc-empty";
    const mode = getListFilterMode();
    if (mode === "submitted") {
      if (allItems.length === 0) {
        empty.textContent =
          "「一括取得」で全コースをまとめて取得するか、各コースを開いてデータを蓄積してください。表示は利用可能期間の終了が早い順です。";
      } else if (baseItems.length > 0 && getListSearchQuery()) {
        empty.textContent =
          "検索に一致する項目はありません。語句を変えるか検索窓を空にしてください。";
      } else if (submittedSet.size > 0) {
        empty.textContent =
          "このタブには、受付中かつ提出済みにチェックした項目だけが表示されます。締切済み・未開始の項目は出ません。「期間なしを除外」がオンで隠れている可能性もあります。";
      } else {
        empty.textContent =
          "受付中の行だけ「提出済み」にチェックできます。チェックした項目がこのタブに表示されます。";
      }
    } else if (allItems.length === 0) {
      empty.textContent =
        "「一括取得」で全コースをまとめて取得するか、各コースを開いてデータを蓄積してください。表示は利用可能期間の終了が早い順です。";
    } else if (baseItems.length > 0 && getListSearchQuery()) {
      empty.textContent =
        "検索に一致する項目はありません。語句を変えるか検索窓を空にしてください。";
    } else {
      empty.textContent = "この表示条件に該当する項目はありません。フィルタを変えてください。";
    }
    list.appendChild(empty);
    updateSearchSuggestionsDom(root);
    return;
  }

  items.forEach((item) => {
    const urgency = deadlineRowUrgencyClass(item);

    if (wcSkin) {
      const row = document.createElement("section");
      row.className =
        "list-group-item cl-contentsList_listGroupItem wcdv-wc-item wcdv-wc-item--wc";
      row.classList.add(urgency);

      const content = document.createElement("div");
      content.className = "cl-contentsList_content";

      const info = document.createElement("div");
      info.className = "cl-contentsList_contentInfo";

      const h4 = document.createElement("h4");
      h4.className = "cm-contentsList_contentName";
      if (item.wcNew) {
        const nw = document.createElement("span");
        nw.className = "cl-contentsList_new";
        nw.textContent = "New";
        h4.appendChild(nw);
      }
      if (item.hrefTitle) {
        const ta = document.createElement("a");
        ta.href = item.hrefTitle;
        ta.className = "wcdv-wc-title-a";
        ta.rel = "noopener noreferrer";
        ta.textContent = item.titleText || "（無題）";
        bindWcdvItemLinkNativeNavigate(ta, item, "title");
        h4.appendChild(ta);
      } else {
        const titleDiv = document.createElement("div");
        titleDiv.textContent = item.titleText || "（無題）";
        h4.appendChild(titleDiv);
      }
      info.appendChild(h4);

      const subCourse = document.createElement("div");
      subCourse.className = "wcdv-wc-card-subline";
      const ca = document.createElement("a");
      ca.href = item.coursePageUrl;
      ca.rel = "noopener noreferrer";
      ca.className = "course-name";
      ca.textContent = item.courseTitle || "コース";
      bindWcdvCourseLinkHumanLike(ca, item);
      subCourse.appendChild(ca);
      if (item.folderTitle) {
        subCourse.appendChild(document.createTextNode(" · "));
        const ft = document.createElement("span");
        ft.textContent = item.folderTitle;
        subCourse.appendChild(ft);
      }
      info.appendChild(subCourse);

      const cat = document.createElement("div");
      cat.className = "cl-contentsList_categoryLabel";
      const typeParts = [];
      if (item.category) typeParts.push(item.category);
      if (item.status === "open") typeParts.push("受付中");
      else if (item.status === "upcoming") typeParts.push("未開始");
      else typeParts.push("終了");
      cat.textContent = typeParts.filter(Boolean).join(" · ") || "教材";
      info.appendChild(cat);

      const periodItem = document.createElement("div");
      periodItem.className = "cm-contentsList_contentDetailListItem";
      const pLab = document.createElement("div");
      pLab.className = "cm-contentsList_contentDetailListItemLabel";
      pLab.textContent = C.LABEL_TEXT;
      const pData = document.createElement("div");
      pData.className = "cm-contentsList_contentDetailListItemData";
      pData.textContent = String(item.period.raw || "").trim();
      periodItem.appendChild(pLab);
      periodItem.appendChild(pData);
      info.appendChild(periodItem);

      const cdItem = document.createElement("div");
      cdItem.className = "cm-contentsList_contentDetailListItem";
      const cdLab = document.createElement("div");
      cdLab.className = "cm-contentsList_contentDetailListItemLabel";
      cdLab.textContent = item.resubmissionDeadlineMs ? "再提出期限まで" : "締切まで";
      const cdData = document.createElement("div");
      cdData.className = "cm-contentsList_contentDetailListItemData wcdv-wc-countdown";
      cdData.textContent = formatCountdownToEnd(
        item.period.end.getTime(),
        Boolean(item.resubmissionDeadlineMs)
      );
      cdItem.appendChild(cdLab);
      cdItem.appendChild(cdData);
      info.appendChild(cdItem);

      content.appendChild(info);

      const detail = document.createElement("div");
      detail.className = "cl-contentsList_contentDetail";
      const detailList = document.createElement("div");
      detailList.className = "cl-contentsList_contentDetailList";

      if (item.hrefDetail) {
        const r1 = document.createElement("div");
        r1.className = "cl-contentsList_contentDetailListItem";
        const d1 = document.createElement("div");
        d1.className = "cl-contentsList_contentDetailListItemData";
        const a1 = document.createElement("a");
        a1.href = item.hrefDetail;
        a1.rel = "noopener noreferrer";
        a1.textContent = "詳細";
        bindWcdvItemLinkNativeNavigate(a1, item, "detail");
        d1.appendChild(a1);
        r1.appendChild(d1);
        detailList.appendChild(r1);
      }

      if (itemHasVisitCountLink(item)) {
        const rVis = document.createElement("div");
        rVis.className = "cl-contentsList_contentDetailListItem";
        const dVis = document.createElement("div");
        dVis.className = "cl-contentsList_contentDetailListItemData";
        const aVis = document.createElement("a");
        aVis.href =
          (item.historyHref && String(item.historyHref).trim()) ||
          historyHrefFromContentHref(item.href) ||
          item.href ||
          item.coursePageUrl;
        aVis.rel = "noopener noreferrer";
        aVis.textContent = item.visitCountText || "利用回数";
        bindWcdvItemLinkNativeNavigate(aVis, item, "visit");
        dVis.appendChild(aVis);
        rVis.appendChild(dVis);
        detailList.appendChild(rVis);
      }

      if (item.resubmissionText) {
        const rResubmit = document.createElement("div");
        rResubmit.className = "cl-contentsList_contentDetailListItem";
        const dResubmit = document.createElement("div");
        dResubmit.className =
          "cl-contentsList_contentDetailListItemData wcdv-resubmission-required";
        dResubmit.textContent = item.resubmissionText;
        rResubmit.appendChild(dResubmit);
        detailList.appendChild(rResubmit);
      }

      detail.appendChild(detailList);
      if (itemShowsSubmittedCheckbox(item)) {
        appendSubmittedWcDetailFooter(detail, item, submittedSet);
      }
      content.appendChild(detail);
      row.appendChild(content);
      list.appendChild(row);
      return;
    }

    const row = document.createElement("div");
    row.className = "wcdv-wc-item";
    row.classList.add(urgency);

    const top = document.createElement("div");
    top.className = "wcdv-wc-item-top";

    const titleCol = document.createElement("div");
    titleCol.className = "wcdv-wc-title-col";

    const titleWrap = document.createElement("div");
    titleWrap.className = item.wcNew
      ? "wcdv-wc-title-line wcdv-wc-title-line--stack"
      : "wcdv-wc-title-line";
    if (item.wcNew) {
      const nw = document.createElement("span");
      nw.className = "cl-contentsList_new";
      nw.textContent = "New";
      titleWrap.appendChild(nw);
    }
    if (item.hrefTitle) {
      const ta = document.createElement("a");
      ta.href = item.hrefTitle;
      ta.className = "wcdv-wc-title-a";
      ta.rel = "noopener noreferrer";
      ta.textContent = item.titleText || "（無題）";
      bindWcdvItemLinkNativeNavigate(ta, item, "title");
      titleWrap.appendChild(ta);
    } else {
      const sp = document.createElement("span");
      sp.className = "wcdv-wc-title-plain";
      sp.textContent = item.titleText || "（無題）";
      titleWrap.appendChild(sp);
    }
    titleCol.appendChild(titleWrap);
    const subCourse = document.createElement("div");
    subCourse.className = "wcdv-wc-course-sub";
    const ca = document.createElement("a");
    ca.href = item.coursePageUrl;
    ca.rel = "noopener noreferrer";
    ca.textContent = item.courseTitle || "コース";
    bindWcdvCourseLinkHumanLike(ca, item);
    subCourse.appendChild(ca);
    if (item.folderTitle) {
      subCourse.appendChild(document.createTextNode(" · "));
      const ft = document.createElement("span");
      ft.textContent = item.folderTitle;
      subCourse.appendChild(ft);
    }
    titleCol.appendChild(subCourse);

    const linksCol = document.createElement("div");
    linksCol.className = "wcdv-wc-links-col";
    if (item.hrefDetail) {
      const d1 = document.createElement("a");
      d1.href = item.hrefDetail;
      d1.className = "wcdv-wc-side-a";
      d1.rel = "noopener noreferrer";
      d1.textContent = "詳細";
      bindWcdvItemLinkNativeNavigate(d1, item, "detail");
      linksCol.appendChild(d1);
    }
    if (itemHasVisitCountLink(item)) {
      const dv = document.createElement("a");
      dv.href =
        (item.historyHref && String(item.historyHref).trim()) ||
        historyHrefFromContentHref(item.href) ||
        item.href ||
        item.coursePageUrl;
      dv.className = "wcdv-wc-side-a";
      dv.rel = "noopener noreferrer";
      dv.textContent = item.visitCountText || "利用回数";
      bindWcdvItemLinkNativeNavigate(dv, item, "visit");
      linksCol.appendChild(dv);
    }
    if (item.resubmissionText) {
      const resubmit = document.createElement("span");
      resubmit.className = "wcdv-resubmission-required";
      resubmit.textContent = item.resubmissionText;
      linksCol.appendChild(resubmit);
    }

    top.appendChild(titleCol);
    top.appendChild(linksCol);
    row.appendChild(top);

    const cd = document.createElement("div");
    cd.className = "wcdv-wc-countdown";
    cd.textContent = formatCountdownToEnd(
      item.period.end.getTime(),
      Boolean(item.resubmissionDeadlineMs)
    );
    row.appendChild(cd);

    const typeRow = document.createElement("div");
    typeRow.className = "wcdv-wc-type";
    const typeParts = [];
    if (item.category) typeParts.push(item.category);
    if (item.status === "open") typeParts.push("受付中");
    else if (item.status === "upcoming") typeParts.push("未開始");
    else typeParts.push("終了");
    typeRow.textContent = typeParts.filter(Boolean).join(" · ") || "教材";
    row.appendChild(typeRow);

    const periodRow = document.createElement("div");
    periodRow.className = "wcdv-wc-period";
    periodRow.textContent = `利用可能期間 ${item.period.raw}`;
    row.appendChild(periodRow);

    if (itemShowsSubmittedCheckbox(item)) {
      appendSubmittedPlainRow(row, item, submittedSet);
    }
    list.appendChild(row);
  });
  updateSearchSuggestionsDom(root);
}

async function refreshListPanel(root) {
  if (!_f.extCtxOk()) return;
  if (C.wcdvSubmittedListRefreshTimer != null) {
    clearTimeout(C.wcdvSubmittedListRefreshTimer);
    C.wcdvSubmittedListRefreshTimer = null;
  }
  try {
    const items = await flattenStoredItems();
    if (!root || !root.isConnected) return;
    await renderList(root, items);
  } catch {
    /* 拡張の再読み込み・無効化など */
  }
}

async function clearStored(root) {
  const site = await loadSiteBucket();
  site.byCourse = {};
  await saveSiteBucket(site);
  await refreshListPanel(root);
}

function scheduleStaleAutoBulk(root) {
  if (!_f.isCourseListPage()) return;
  if (C.wcdvAutoBulkStaleTimer != null) clearTimeout(C.wcdvAutoBulkStaleTimer);
  C.wcdvAutoBulkStaleTimer = setTimeout(() => {
    C.wcdvAutoBulkStaleTimer = null;
    void maybeAutoBulkStale(root);
  }, 2800);
}

async function maybeAutoBulkStale(root) {
  const r =
    root && root.isConnected && root.id === "wcdv-root"
      ? root
      : document.getElementById("wcdv-root");
  if (!r || !r.isConnected) return;
  if (!_f.isCourseListPage() || !_f.isWebclassPathPage()) return;
  if (C.wcdvBulkRunningLocal) return;
  if (C.wcdvAutoBulkStaleAttempted) return;
  if (!(await getIsAutoBulkEnabled())) return;
  let maxU = 0;
  try {
    maxU = await getOriginMaxCourseUpdatedAt();
  } catch {
    return;
  }
  const staleMs = await getAutoBulkStaleIntervalMs();
  const staleHours = staleMs / 3600000;
  if (!maxU || Date.now() - maxU < staleMs) return;
  const courses = sortCoursesForBulk(discoverCourses());
  if (courses.length === 0) return;
  C.wcdvAutoBulkStaleAttempted = true;
  const progEl = r.querySelector("#wcdv-progress");
  if (progEl) {
    progEl.textContent = `保存データの最終更新から${staleHours}時間以上経過しているため、一括取得を自動で開始します…`;
  }
  const ok = await startBulkBackground(r, courses);
  if (!ok) {
    C.wcdvAutoBulkStaleAttempted = false;
    if (progEl) progEl.textContent = "";
  }
}

async function startBulkBackground(root, courses) {
  if (C.wcdvBulkRunningLocal || !root || !root.isConnected) return false;
  if (!_f.extCtxOk()) return false;
  const entries = courses.map((c) => ({ url: c.fetchUrl, title: c.title }));
  let port;
  try {
    port = chrome.runtime.connect({ name: CONNECT_NAME });
  } catch {
    if (_f.extCtxOk()) {
      try {
        alert(
          "拡張機能に接続できませんでした。拡張を再読み込みするか、manifest の background / permissions を確認してください。"
        );
      } catch {
        /* ignore */
      }
    }
    return false;
  }
  C.wcdvBulkPort = port;
  C.wcdvBulkRunningLocal = true;
  try {
    await setLastBulkStartedNow();
  } catch {
    C.wcdvBulkRunningLocal = false;
    C.wcdvBulkPort = null;
    try {
      port.disconnect();
    } catch {
      /* ignore */
    }
    return false;
  }
  const progEl = root.querySelector("#wcdv-progress");
  const onMsg = (msg) => {
    if (!msg || !msg.type) return;
    if (!_f.extCtxOk()) {
      C.wcdvBulkRunningLocal = false;
      C.wcdvBulkPort = null;
      return;
    }
    try {
      if (msg.type === "progress") {
        showBulkProgressToast(msg.done, msg.total, msg.nItems);
        if (progEl && root.isConnected) {
          progEl.textContent = `一括取得（バックグラウンド）: ${msg.done}/${msg.total} コース処理済み`;
        }
      } else if (msg.type === "done") {
        if (progEl && root.isConnected) {
          progEl.textContent = "一括取得が完了しました。再表示で最新の一覧を確認できます。";
        }
        showBulkDoneToast(msg.total != null ? msg.total : entries.length);
        try {
          port.onMessage.removeListener(onMsg);
        } catch {
          /* ignore */
        }
        C.wcdvBulkRunningLocal = false;
        C.wcdvBulkPort = null;
        try {
          port.disconnect();
        } catch {
          /* ignore */
        }
        void refreshListPanel(root);
      } else if (msg.type === "error") {
        if (_f.extCtxOk()) {
          try {
            alert(msg.message || "一括取得でエラーが発生しました。");
          } catch {
            /* ignore */
          }
        }
        if (progEl && root.isConnected) progEl.textContent = "";
        try {
          port.onMessage.removeListener(onMsg);
        } catch {
          /* ignore */
        }
        C.wcdvBulkRunningLocal = false;
        C.wcdvBulkPort = null;
        try {
          port.disconnect();
        } catch {
          /* ignore */
        }
      }
    } catch {
      C.wcdvBulkRunningLocal = false;
      C.wcdvBulkPort = null;
    }
  };
  port.onMessage.addListener(onMsg);
  port.onDisconnect.addListener(() => {
    _f.flushChromeRuntimeLastError();
    try {
      port.onMessage.removeListener(onMsg);
    } catch {
      /* ignore */
    }
    if (C.wcdvBulkPort === port) C.wcdvBulkPort = null;
    C.wcdvBulkRunningLocal = false;
  });
  try {
    port.postMessage({
      type: "start",
      origin: C.ORIGIN,
      listUrl: location.href,
      entries,
    });
    C.wcdvBulkRunningForOrigin = true;
  } catch {
    C.wcdvBulkRunningLocal = false;
    C.wcdvBulkPort = null;
    try {
      port.disconnect();
    } catch {
      /* ignore */
    }
    return false;
  }
  return true;
}

function ensureListUi() {
  if (!_f.isWebclassPathPage()) return null;
  if (!_f.isCourseListPage()) {
    _f.unmountWcdvListPanelUi();
    return null;
  }
  let root = document.getElementById("wcdv-root");
  if (root && root.isConnected) {
    _f.wirePanelCollapseButton(root);
    _f.syncWcdvToolbarPlacement(root);
    _f.syncWcdvFiltersPlacement(root);
    scheduleStaleAutoBulk(root);
    rememberWebclassCourseListUrl();
    tryAdvancePendingNavFromListPage();
    return root;
  }

  root = document.createElement("div");
  root.id = "wcdv-root";
  root.className = "wcdv-embedded";
  root.innerHTML = `
    <section class="wcdv-wc-card" aria-labelledby="wcdv-wc-heading">
      <div class="wcdv-wc-standalone-chrome">
        <h2 id="wcdv-wc-heading" class="wcdv-wc-standalone-title">
          <span class="wcdv-wc-head-visual-label">利用可能期間一覧</span>
          <span id="wcdv-badge" class="wcdv-wc-count">（0）</span>
        </h2>
        <div class="wcdv-wc-search-center">
          <div class="wcdv-wc-search-wrap">
            <span class="wcdv-wc-search-icon" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="2" />
                <path d="M20 20 15.2 15.2" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </span>
            <input
              type="search"
              id="wcdv-list-search"
              class="wcdv-wc-search-input"
              placeholder="教材・コース名で検索"
              maxlength="200"
              autocomplete="off"
              spellcheck="false"
              aria-autocomplete="list"
              aria-controls="wcdv-list-search-suggest"
              aria-expanded="false"
              enterkeyhint="search"
              aria-label="教材・コース名で検索"
                title="${LIST_SEARCH_INPUT_HELP_TITLE}"
            />
            <button
              type="button"
              id="wcdv-list-search-clear"
              class="wcdv-wc-search-clear"
              title="検索をクリア"
              aria-label="検索をクリア"
              hidden
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <path d="M6 6 18 18M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
            </button>
            <div id="wcdv-list-search-suggest" class="wcdv-wc-search-suggest" role="listbox" aria-label="検索候補" hidden></div>
          </div>
        </div>
        <div class="wcdv-wc-actions">
          <button type="button" id="wcdv-bulk" class="wcdv-wc-btn-primary">一括取得</button>
          <button type="button" id="wcdv-reload" class="wcdv-wc-btn-sub">再表示</button>
          <button type="button" id="wcdv-clear" class="wcdv-wc-btn-sub">消去</button>
          <button type="button" id="wcdv-panel-collapse" class="wcdv-wc-btn-sub wcdv-panel-collapse-in-actions" hidden aria-expanded="true" aria-controls="wcdv-panel-expanded" title="一覧パネルを折りたたみます">折りたたみ</button>
        </div>
      </div>
      <p id="wcdv-progress" class="wcdv-wc-progress"></p>
      <div class="wcdv-wc-filters" role="radiogroup" aria-label="表示の絞り込み">
        <label class="wcdv-wc-filter-label"><span class="wcdv-wc-filter-control"><input type="radio" name="wcdv-filter" value="week" checked /></span><span class="wcdv-wc-filter-text">7日以内に締切</span></label>
        <label class="wcdv-wc-filter-label"><span class="wcdv-wc-filter-control"><input type="radio" name="wcdv-filter" value="active" /></span><span class="wcdv-wc-filter-text">締切前すべて</span></label>
        <label class="wcdv-wc-filter-label"><span class="wcdv-wc-filter-control"><input type="radio" name="wcdv-filter" value="all" /></span><span class="wcdv-wc-filter-text">すべて</span></label>
        <label class="wcdv-wc-filter-label" title="終了した項目のみ表示"><span class="wcdv-wc-filter-control"><input type="radio" name="wcdv-filter" value="ended" /></span><span class="wcdv-wc-filter-text">締切後すべて</span></label>
        <label class="wcdv-wc-filter-label" title="受付中の項目のうち、提出済みにチェックしたもののみ"><span class="wcdv-wc-filter-control"><input type="radio" name="wcdv-filter" value="submitted" /></span><span class="wcdv-wc-filter-text">提出済み</span></label>
        <label class="wcdv-wc-filter-check"><span class="wcdv-wc-filter-control"><input type="checkbox" id="wcdv-exclude-noperiod" /></span><span class="wcdv-wc-filter-text">期間なしを除外</span></label>
      </div>
      <div id="wcdv-list" class="wcdv-wc-list"></div>
    </section>
  `;
  _f.mountListRootIntoPage(root);
  if (!root.isConnected) {
    try {
      root.remove();
    } catch {
      /* ignore */
    }
    return null;
  }
  _f.wirePanelCollapseButton(root);
  _f.syncWcdvToolbarPlacement(root);
  _f.syncWcdvFiltersPlacement(root);

  const onFilterChange = () => {
    void refreshListPanel(root);
  };
  document
    .querySelectorAll(
      '#wcdv-root input[name="wcdv-filter"], #wcdv-panel-filters-host input[name="wcdv-filter"]'
    )
    .forEach((inp) => {
      inp.addEventListener("change", onFilterChange);
    });
  const excl = document.getElementById("wcdv-exclude-noperiod");
  if (excl) excl.addEventListener("change", onFilterChange);

  wireListSearchUi(root);

  const bulkBtn = document.getElementById("wcdv-bulk");
  if (bulkBtn) {
    bulkBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const rawList = discoverCourses();
      const courses = sortCoursesForBulk(rawList);
      if (courses.length === 0) {
        alert("このページからコースリンクが見つかりません。");
        return;
      }
      const lastStart = await getLastBulkStartedAt();
      if (
        lastStart &&
        Date.now() - lastStart < BULK_SHORT_INTERVAL_WARN_MS &&
        !confirm(
          "このサイトで一括取得を開始してからまだ30分未満です。WebClass は、短い間隔で一覧やタブを大量に開く操作のあとにログアウトされることがあります。\n\n続行しますか？"
        )
      ) {
        return;
      }
      const orderText = formatBulkOrderPreview(courses, 12);
      if (
        !confirm(
          `【遷移の順】コース名の五十音順（同じ名前なら URL 順）で ${courses.length} コースを処理します。\n` +
            `${orderText}\n\n` +
            `【注意】取得中に WebClass 内の別ページへ移動すると、WebClass の仕様によりログアウトする可能性があります。`
        )
      ) {
        return;
      }
      await startBulkBackground(root, courses);
    });
  }

  const reloadBtn = document.getElementById("wcdv-reload");
  if (reloadBtn) {
    reloadBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      refreshListPanel(root);
    });
  }

  const clearBtn = document.getElementById("wcdv-clear");
  if (clearBtn) {
    clearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm("保存した全コースの期限データを消しますか？")) clearStored(root);
    });
  }

  if (!C.wcdvStorageListenerAttached) {
    C.wcdvStorageListenerAttached = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (!changes[STORAGE_KEY] && !changes[STORAGE_SUBMITTED_ITEMS]) return;
      if (!_f.extCtxOk() || !_f.isWebclassPathPage() || !_f.isCourseListPage()) return;
      const r = document.getElementById("wcdv-root");
      if (!r || !r.isConnected) return;
      if (changes[STORAGE_KEY]) void refreshListPanel(r);
      else if (changes[STORAGE_SUBMITTED_ITEMS]) scheduleSubmittedListRefresh();
    });
  }

  void refreshListPanel(root);
  scheduleStaleAutoBulk(root);

  return root;
}

function tryEnsureListUiMounted() {
  if (!_f.isWebclassPathPage() || !_f.isCourseListPage()) {
    _f.unmountWcdvListPanelUi();
    return false;
  }
  const existing = document.getElementById("wcdv-root");
  if (existing && existing.isConnected) return true;
  return !!ensureListUi();
}

/** SPA が掲載枠を差し替えたときなど、外れたら付け直す */
function startListMountWatchdog() {
  let raf = null;
  let debounceTimer = null;
  let rehostTimer = null;
  let lastPath = location.pathname + location.search;
  const pathChanged = () => {
    const now = location.pathname + location.search;
    if (now === lastPath) return false;
    lastPath = now;
    if (!_f.isWebclassPathPage() || !_f.isCourseListPage()) _f.unmountWcdvListPanelUi();
    return true;
  };
  const tick = () => {
    raf = null;
    pathChanged();
    if (!_f.isWebclassPathPage()) return;
    if (!_f.isCourseListPage()) {
      _f.unmountWcdvListPanelUi();
      return;
    }
    const root = document.getElementById("wcdv-root");
    const mainHost = _f.findListMountHost();
    if (!mainHost) return;
    if (!root || !root.isConnected) {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        ensureListUi();
      }, 200);
      return;
    }
    const anchor = _f.findParticipatingCoursesAnchor();
    const shell = document.getElementById("wcdv-course-list-panel-shell");
    let needsRehost = false;
    if (anchor && anchor.parentElement) {
      if (!shell || !shell.contains(root)) needsRehost = true;
      else if (shell.parentElement !== anchor.parentElement || shell.nextSibling !== anchor) {
        needsRehost = true;
      }
    } else {
      const inShell = root.closest("#wcdv-course-list-panel-shell");
      if (inShell) needsRehost = true;
      else if (!mainHost.contains(root)) needsRehost = true;
    }
    if (needsRehost) {
      if (rehostTimer) clearTimeout(rehostTimer);
      rehostTimer = setTimeout(() => {
        rehostTimer = null;
        _f.mountListRootIntoPage(root);
        if (root.isConnected) void refreshListPanel(root);
      }, 200);
    }
  };
  const schedule = () => {
    if (raf != null) return;
    raf = requestAnimationFrame(tick);
  };
  const obs = new MutationObserver(schedule);
  obs.observe(document.documentElement, { childList: true, subtree: true });
  schedule();
  window.addEventListener("popstate", schedule);
}

if (!_f.isWebclassPathPage()) {
  return;
}
globalThis.WCDV_NAVIGATION_GUARD.install();
if (_f.isCourseListPage()) {
  if (!tryEnsureListUiMounted()) {
    const iv = setInterval(() => {
      if (tryEnsureListUiMounted()) clearInterval(iv);
    }, 300);
    setTimeout(() => clearInterval(iv), 60000);
  }
  const anchorRetryDelays = [400, 1200, 3000, 8000, 15000];
  for (let ti = 0; ti < anchorRetryDelays.length; ti++) {
    setTimeout(() => {
      const r = document.getElementById("wcdv-root");
      if (!r || !r.isConnected) return;
      _f.mountListRootIntoPage(r);
      if (r.isConnected) void refreshListPanel(r);
    }, anchorRetryDelays[ti]);
  }
  startListMountWatchdog();
} else if (isCourseHomePage()) {
  runCoursePage();
}

})();
