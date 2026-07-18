(function () {
"use strict";

const C = globalThis.WCDV_CONTENT;
const F = globalThis.WCDV_CONTENT_FNS;
const {
  canonicalCourseStorageKey,
  itemHasVisitCountLink,
  normalizeItemHrefForDedupe,
  pickPrimaryContentLinkFromRow,
  resolveHref,
} = globalThis.WCDV_COURSE_DATA;

function isCourseHomePage() {
  return /^\/webclass\/course\.php\/[^/]+\/?$/.test(location.pathname);
}

function courseDomMatchesItemCourse(item) {
  if (!item || !item.coursePageUrl) return false;
  try {
    return (
      canonicalCourseStorageKey(location.href) ===
      canonicalCourseStorageKey(item.coursePageUrl)
    );
  } catch {
    return false;
  }
}

/** 教材一覧 DOM 上で正規化 href が一致する a（課題名・詳細どちらでも） */
function findNativeLinkInListDomByNormalizedHref(wantNorm) {
  if (!wantNorm) return null;
  const rows = document.querySelectorAll("section.cl-contentsList_listGroupItem");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.closest("#wcdv-root, #wcdv-course-list-panel-shell")) continue;
    const all = row.querySelectorAll("a[href]");
    for (let j = 0; j < all.length; j++) {
      const a = all[j];
      const abs = resolveHref(a.getAttribute("href") || "", location.href);
      if (normalizeItemHrefForDedupe(abs) === wantNorm) return a;
    }
  }
  return null;
}

/** 行内のいずれかの a で正規化 href が一致するもの（課題名／詳細のどちらでも可） */
function findNativeLinkMatchingHref(item, targetHref) {
  if (!targetHref || !courseDomMatchesItemCourse(item)) return null;
  return findNativeLinkInListDomByNormalizedHref(
    normalizeItemHrefForDedupe(targetHref)
  );
}

/**
 * コース一覧上で、目的のコース教材トップへ飛ぶ本物の a を click()。
 * 拡張パネル内のリンクは除外する。
 */
function clickCourseAnchorMatchingKey(wantCourseKey) {
  if (!wantCourseKey) return false;
  const anchors = document.querySelectorAll("a[href], area[href]");
  for (let j = 0; j < anchors.length; j++) {
    const a = anchors[j];
    if (a.closest("#wcdv-root, #wcdv-course-list-panel-shell")) continue;
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
    if (linkKey !== wantCourseKey) continue;
    a.click();
    return true;
  }
  return false;
}

function rememberWebclassCourseListUrl() {
  if (!F.isCourseListPage() || !F.isWebclassPathPage()) return;
  try {
    sessionStorage.setItem(C.WCDV_LAST_LIST_PAGE_URL_KEY, location.href.split("#")[0]);
  } catch {
    /* ignore */
  }
}

function getCourseListUrlForHumanNav() {
  try {
    const raw = sessionStorage.getItem(C.WCDV_LAST_LIST_PAGE_URL_KEY);
    if (raw) {
      const u = new URL(raw, location.origin);
      if (u.origin === location.origin) return raw;
    }
  } catch {
    /* ignore */
  }
  try {
    return `${location.origin}/webclass/`;
  } catch {
    return location.href.split("#")[0];
  }
}

function schedulePollCourseHomeThenConsumePending(wantCourse) {
  let n = 0;
  const iv = setInterval(() => {
    n++;
    let nowKey;
    try {
      nowKey = canonicalCourseStorageKey(location.href);
    } catch {
      clearInterval(iv);
      return;
    }
    if (nowKey === wantCourse) {
      clearInterval(iv);
      tryConsumePendingAssignmentNav();
      return;
    }
    if (n >= 100) {
      clearInterval(iv);
      tryConsumePendingAssignmentNav();
    }
  }, 100);
}

/** コース表示後に課題 a を click() する（sessionStorage 経由） */
function tryConsumePendingAssignmentNav() {
  let raw;
  try {
    raw = sessionStorage.getItem(C.WCDV_PENDING_ASSIGN_NAV_KEY);
  } catch {
    return false;
  }
  if (!raw) return false;
  let p;
  try {
    p = JSON.parse(raw);
  } catch {
    try {
      sessionStorage.removeItem(C.WCDV_PENDING_ASSIGN_NAV_KEY);
    } catch {
      /* ignore */
    }
    return false;
  }
  if (!p || !p.courseKey) {
    try {
      sessionStorage.removeItem(C.WCDV_PENDING_ASSIGN_NAV_KEY);
    } catch {
      /* ignore */
    }
    return false;
  }
  if (Date.now() - (p.t || 0) > 90000) {
    try {
      sessionStorage.removeItem(C.WCDV_PENDING_ASSIGN_NAV_KEY);
    } catch {
      /* ignore */
    }
    return false;
  }
  if (!isCourseHomePage()) return false;
  let here;
  try {
    here = canonicalCourseStorageKey(location.href);
  } catch {
    return false;
  }
  if (here !== p.courseKey) return false;

  const kind = p.kind || "title";
  let el = null;
  if (kind === "visit") {
    if (!p.primaryNorm) {
      try {
        sessionStorage.removeItem(C.WCDV_PENDING_ASSIGN_NAV_KEY);
      } catch {
        /* ignore */
      }
      return false;
    }
    el = findNativeVisitAnchorByPrimaryNorm(p.primaryNorm);
  } else {
    if (!p.wantNorm) {
      try {
        sessionStorage.removeItem(C.WCDV_PENDING_ASSIGN_NAV_KEY);
      } catch {
        /* ignore */
      }
      return false;
    }
    el = findNativeLinkInListDomByNormalizedHref(p.wantNorm);
  }
  if (!el || typeof el.click !== "function") return false;
  try {
    sessionStorage.removeItem(C.WCDV_PENDING_ASSIGN_NAV_KEY);
  } catch {
    /* ignore */
  }
  el.click();
  return true;
}

/**
 * 一覧以外から来た保留ナビ: 一覧表示後にコース a を click() し、その後コース内リンクへ進める。
 */
function tryAdvancePendingNavFromListPage() {
  if (!F.isCourseListPage() || !F.isWebclassPathPage()) return;
  let raw;
  try {
    raw = sessionStorage.getItem(C.WCDV_PENDING_ASSIGN_NAV_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  let p;
  try {
    p = JSON.parse(raw);
  } catch {
    return;
  }
  if (!p || p.phase !== "awaitList" || !p.courseKey) return;
  if (Date.now() - (p.t || 0) > 90000) {
    try {
      sessionStorage.removeItem(C.WCDV_PENDING_ASSIGN_NAV_KEY);
    } catch {
      /* ignore */
    }
    return;
  }
  const clicked = clickCourseAnchorMatchingKey(p.courseKey);
  const next = { ...p };
  delete next.phase;
  try {
    sessionStorage.setItem(C.WCDV_PENDING_ASSIGN_NAV_KEY, JSON.stringify(next));
  } catch {
    return;
  }
  if (!clicked) {
    try {
      location.assign(p.courseKey);
    } catch {
      /* ignore */
    }
    return;
  }
  schedulePollCourseHomeThenConsumePending(p.courseKey);
}

function startPendingAssignmentNavConsumer() {
  if (!isCourseHomePage()) return;
  if (tryConsumePendingAssignmentNav()) return;
  const target = document.getElementById("js-contents") || document.body;
  let obs = null;
  const stop = () => {
    if (obs) {
      try {
        obs.disconnect();
      } catch {
        /* ignore */
      }
      obs = null;
    }
  };
  const tick = () => {
    if (tryConsumePendingAssignmentNav()) stop();
  };
  obs = new MutationObserver(() => {
    tick();
  });
  try {
    obs.observe(target, { childList: true, subtree: true });
  } catch {
    stop();
    return;
  }
  setTimeout(stop, 30000);
  [400, 1200, 3000].forEach((ms) => setTimeout(tick, ms));
}

/** 本体 URL（正規化）で行を特定し、その行の「利用回数」a を返す */
function findNativeVisitAnchorByPrimaryNorm(primaryNorm) {
  if (!primaryNorm) return null;
  const rows = document.querySelectorAll("section.cl-contentsList_listGroupItem");
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.closest("#wcdv-root, #wcdv-course-list-panel-shell")) continue;
    const contentLink = pickPrimaryContentLinkFromRow(row);
    if (!contentLink) continue;
    const abs = resolveHref(contentLink.getAttribute("href") || "", location.href);
    if (normalizeItemHrefForDedupe(abs) !== primaryNorm) continue;
    const detailRoot = row.querySelector(".cl-contentsList_contentDetail") || row;
    const candidates = detailRoot.querySelectorAll("a[href]");
    for (let j = 0; j < candidates.length; j++) {
      const a = candidates[j];
      if (contentLink && a === contentLink) continue;
      const raw = a.getAttribute("href") || "";
      const t = a.textContent.replace(/\s+/g, " ").trim();
      const isVisit =
        /利用回数/.test(t) ||
        /\/history(?:\?|\/|$)/i.test(raw) ||
        /\/history\?/i.test(raw);
      if (isVisit) return a;
    }
  }
  return null;
}

/**
 * 課題・詳細・利用回数: コース一覧→コース a→（該当 a を click）。同一コース内はその場で click。
 */
function handleWcdvPanelLinkHumanLike(ev, item, linkKind) {
  if (!item || !item.coursePageUrl) return;
  if (linkKind === "title" && !item.hrefTitle) return;
  if (linkKind === "detail" && !item.hrefDetail) return;
  if (linkKind === "visit" && (!itemHasVisitCountLink(item) || !item.href)) return;

  const wantCourse = canonicalCourseStorageKey(item.coursePageUrl);
  let here;
  try {
    here = canonicalCourseStorageKey(location.href);
  } catch {
    return;
  }

  const sameCourseClick = () => {
    if (linkKind === "title") return findNativeLinkMatchingHref(item, item.hrefTitle);
    if (linkKind === "detail") return findNativeLinkMatchingHref(item, item.hrefDetail);
    return findNativeVisitAnchorForItem(item);
  };

  if (here === wantCourse) {
    const native = sameCourseClick();
    if (native && typeof native.click === "function") {
      ev.preventDefault();
      ev.stopPropagation();
      native.click();
    }
    return;
  }

  ev.preventDefault();
  ev.stopPropagation();

  const pending =
    linkKind === "visit"
      ? {
          kind: "visit",
          courseKey: wantCourse,
          primaryNorm: normalizeItemHrefForDedupe(item.href),
          t: Date.now(),
        }
      : {
          kind: linkKind,
          courseKey: wantCourse,
          wantNorm: normalizeItemHrefForDedupe(
            linkKind === "detail" ? item.hrefDetail : item.hrefTitle
          ),
          t: Date.now(),
        };

  try {
    sessionStorage.setItem(C.WCDV_PENDING_ASSIGN_NAV_KEY, JSON.stringify(pending));
  } catch {
    try {
      if (F.isCourseListPage()) {
        location.assign(item.coursePageUrl);
      } else {
        location.assign(getCourseListUrlForHumanNav());
      }
    } catch {
      /* ignore */
    }
    return;
  }

  if (F.isCourseListPage()) {
    const clicked = clickCourseAnchorMatchingKey(wantCourse);
    if (!clicked) {
      try {
        location.assign(item.coursePageUrl);
      } catch {
        /* ignore */
      }
      return;
    }
    schedulePollCourseHomeThenConsumePending(wantCourse);
    return;
  }

  pending.phase = "awaitList";
  try {
    sessionStorage.setItem(C.WCDV_PENDING_ASSIGN_NAV_KEY, JSON.stringify(pending));
  } catch {
    /* ignore */
  }
  try {
    location.assign(getCourseListUrlForHumanNav());
  } catch {
    /* ignore */
  }
}

/** 同一行の「利用回数」a（ページ上の最新 href） */
function findNativeVisitAnchorForItem(item) {
  if (!item.href || !courseDomMatchesItemCourse(item)) return null;
  if (!itemHasVisitCountLink(item)) return null;
  return findNativeVisitAnchorByPrimaryNorm(normalizeItemHrefForDedupe(item.href));
}

/**
 * 課題リンク: 同一コースページ上ではページ内の本物の a を click()（acs 等の最新 URL）。
 * 修飾キー・中クリックは通常の href 動作のまま。
 */
function bindWcdvItemLinkNativeNavigate(anchor, item, kind) {
  anchor.addEventListener(
    "click",
    (ev) => {
      if (ev.defaultPrevented) return;
      if (ev.button !== 0) return;
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      if (kind === "title" || kind === "detail" || kind === "visit") {
        handleWcdvPanelLinkHumanLike(ev, item, kind);
      }
    },
    true
  );
}

/** コース名: 一覧上のコース a を click()（直 URL ではなく人間と同じ順） */
function bindWcdvCourseLinkHumanLike(anchor, item) {
  anchor.addEventListener(
    "click",
    (ev) => {
      if (ev.defaultPrevented) return;
      if (ev.button !== 0) return;
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      if (!item || !item.coursePageUrl) return;
      const wantCourse = canonicalCourseStorageKey(item.coursePageUrl);
      let here;
      try {
        here = canonicalCourseStorageKey(location.href);
      } catch {
        return;
      }
      if (here === wantCourse) {
        return;
      }
      if (F.isCourseListPage()) {
        ev.preventDefault();
        ev.stopPropagation();
        if (!clickCourseAnchorMatchingKey(wantCourse)) {
          try {
            location.assign(item.coursePageUrl);
          } catch {
            /* ignore */
          }
        }
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      try {
        location.assign(getCourseListUrlForHumanNav());
      } catch {
        try {
          location.assign(item.coursePageUrl);
        } catch {
          /* ignore */
        }
      }
    },
    true
  );
}

globalThis.WCDV_ITEM_NAVIGATION = Object.freeze({
  bindWcdvCourseLinkHumanLike,
  bindWcdvItemLinkNativeNavigate,
  rememberWebclassCourseListUrl,
  startPendingAssignmentNavConsumer,
  tryAdvancePendingNavFromListPage,
});
})();
