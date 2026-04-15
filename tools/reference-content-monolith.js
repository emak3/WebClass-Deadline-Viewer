(function () {
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

  let wcdvStorageListenerAttached = false;
  let wcdvBulkRunningLocal = false;
  let wcdvAutoBulkStaleTimer = null;
  let wcdvAutoBulkStaleAttempted = false;
  /** 一括取得の runtime ポート（bfcache 時に明示 disconnect） */
  let wcdvBulkPort = null;
  /** 提出済みチェック後の一覧再描画を遅延させる（連続操作は最後から 1 秒） */
  let wcdvSubmittedListRefreshTimer = null;
  const WCDV_SUBMITTED_LIST_REFRESH_MS = 1000;
  const LABEL_TEXT = "利用可能期間";
  const PERIOD_RE =
    /^\s*(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})\s*-\s*(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})\s*$/;
  /** 一覧→コース→課題の 2 段クリック用（sessionStorage） */
  const WCDV_PENDING_ASSIGN_NAV_KEY = "wcdv_pending_assignment_nav_v1";
  /** 一覧以外から戻るときの遷移先（同一タブで記憶） */
  const WCDV_LAST_LIST_PAGE_URL_KEY = "wcdv_last_course_list_url_v1";

  const ORIGIN = location.origin;

  function extCtxOk() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function flushChromeRuntimeLastError() {
    try {
      void chrome.runtime.lastError;
    } catch {
      /* ignore */
    }
  }

  window.addEventListener("pagehide", (ev) => {
    if (!ev.persisted) return;
    if (wcdvBulkPort) {
      try {
        wcdvBulkPort.disconnect();
      } catch {
        /* ignore */
      }
      wcdvBulkPort = null;
    }
    wcdvBulkRunningLocal = false;
  });

  window.addEventListener("pageshow", (ev) => {
    if (!ev.persisted) return;
    wcdvAutoBulkStaleAttempted = false;
    const r = document.getElementById("wcdv-root");
    if (r && r.isConnected && isCourseListPage() && isWebclassPathPage()) {
      scheduleStaleAutoBulk(r);
    }
  });

  /** URL のパスに /webclass/ を含むときのみ拡張を有効にする（ドメインの TLD は問わない） */
  function isWebclassPathPage() {
    try {
      return (location.pathname || "").includes("/webclass/");
    } catch {
      return false;
    }
  }

  /**
   * 参加コースが並ぶ「コース一覧」相当のページのみ true。
   * course.php は教材コース内（トップ・contents 等）のため常に false（ここに一覧パネルを出さない）。
   */
  function isCourseListPage() {
    const path = location.pathname || "";
    const pl = path.toLowerCase();
    if (!/\/webclass(\/|$)/i.test(path)) return false;
    if (/^\/webclass\/course\.php\//i.test(path)) return false;
    if (pl.includes("user.php")) return false;
    if (pl.includes("msg_editor")) return false;
    if (pl.includes("do_contents.php")) return false;
    if (pl.includes("/contents/")) return false;
    /* ログイン・セッション周り（コース一覧ではない／別枠に出るのを防ぐ） */
    if (/\/webclass\/login\.php/i.test(pl)) return false;
    if (/\/webclass\/[^/]*logout[^/]*\.php/i.test(pl)) return false;
    if (/\/webclass\/(lost_password|forgot_password|password_reset|passwd)/i.test(pl)) return false;
    return true;
  }

  /**
   * 一覧パネルを載せる位置の唯一のアンカー:
   * <h3 class="page-header">参加しているコース</h3> のみ（他の見出しでは差し込まない）。
   */
  function findParticipatingCoursesAnchor() {
    let nodes;
    try {
      nodes = document.querySelectorAll("h3.page-header");
    } catch {
      return null;
    }
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (!(el instanceof HTMLElement)) continue;
      if (el.closest("#wcdv-course-list-panel-shell, #wcdv-root")) continue;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t !== "参加しているコース") continue;
      return el;
    }
    return null;
  }

  function removeLegacyTabChrome() {
    const ids = ["wcdv-top-tab-trigger", "wcdv-floating-tab-bar", "wcdv-tab-panel-host"];
    for (let i = 0; i < ids.length; i++) {
      const n = document.getElementById(ids[i]);
      if (n && n.parentNode) n.parentNode.removeChild(n);
    }
    document.querySelectorAll(".wcdv-top-tab-item").forEach((wrap) => {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    });
  }

  function wcdvPanelChevronSvg(down) {
    const cls = down ? "wcdv-panel-chevron wcdv-panel-chevron--down" : "wcdv-panel-chevron";
    return (
      '<svg class="' +
      cls +
      '" width="16" height="16" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
      '<path d="M3.5 9 7 5.5 10.5 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>"
    );
  }

  function createListPanelShell() {
    const shell = document.createElement("div");
    shell.id = "wcdv-course-list-panel-shell";
    shell.className = "wcdv-course-list-panel-shell";

    const reopen = document.createElement("button");
    reopen.type = "button";
    reopen.id = "wcdv-panel-reopen";
    reopen.className = "wcdv-panel-reopen-btn";
    reopen.setAttribute("aria-expanded", "false");
    reopen.setAttribute("aria-controls", "wcdv-panel-expanded");
    reopen.setAttribute("aria-label", "利用可能期間一覧を展開する");
    reopen.title = "一覧を展開（時間割など下のコンテンツへスクロールできます）";
    reopen.innerHTML =
      wcdvPanelChevronSvg(true) + '<span class="wcdv-panel-reopen-label">利用可能期間一覧</span>';

    const expanded = document.createElement("div");
    expanded.id = "wcdv-panel-expanded";
    expanded.className = "wcdv-panel-expanded";

    const menu = document.createElement("div");
    menu.className = "wcdv-panel-menu";
    menu.setAttribute("role", "toolbar");
    menu.setAttribute("aria-label", "利用可能期間一覧");

    const menuTitle = document.createElement("span");
    menuTitle.id = "wcdv-panel-menu-title";
    menuTitle.className = "wcdv-panel-menu-title";
    menuTitle.textContent = "利用可能期間一覧";
    menuTitle.title = "クリックで折りたたみ（または「折りたたみ」ボタン）";
    menuTitle.addEventListener("click", () => setCollapsed(true));

    const menuActionsHost = document.createElement("div");
    menuActionsHost.id = "wcdv-panel-menu-actions-host";
    menuActionsHost.className = "wcdv-panel-menu-actions";

    menu.appendChild(menuTitle);
    menu.appendChild(menuActionsHost);
    expanded.appendChild(menu);
    const filtersSlot = document.createElement("div");
    filtersSlot.id = "wcdv-panel-filters-host";
    filtersSlot.className = "wcdv-panel-filters-slot";
    expanded.appendChild(filtersSlot);
    shell.appendChild(reopen);
    shell.appendChild(expanded);

    const setCollapsed = (collapsed) => {
      shell.classList.toggle("wcdv-course-list-panel-shell--collapsed", collapsed);
      reopen.setAttribute("aria-expanded", collapsed ? "true" : "false");
      const actBtn = document.getElementById("wcdv-panel-collapse");
      if (actBtn) actBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
      try {
        sessionStorage.setItem(PANEL_COLLAPSED_KEY, collapsed ? "1" : "0");
      } catch {
        /* ignore */
      }
    };

    shell._wcdvSetCollapsed = setCollapsed;

    try {
      if (sessionStorage.getItem(PANEL_COLLAPSED_KEY) === "1") setCollapsed(true);
    } catch {
      /* ignore */
    }

    reopen.addEventListener("click", () => setCollapsed(false));

    return shell;
  }

  /** 旧シェルにフィルタ用スロットが無いときだけ差し込む（#wcdv-root の直前） */
  function ensurePanelFiltersSlot(shell) {
    if (document.getElementById("wcdv-panel-filters-host")) return;
    const exp = shell && shell.querySelector("#wcdv-panel-expanded");
    if (!exp) return;
    const slot = document.createElement("div");
    slot.id = "wcdv-panel-filters-host";
    slot.className = "wcdv-panel-filters-slot";
    const rootIn = exp.querySelector("#wcdv-root");
    if (rootIn) exp.insertBefore(slot, rootIn);
    else exp.appendChild(slot);
  }

  function wirePanelCollapseButton(root) {
    const btn = document.getElementById("wcdv-panel-collapse");
    const shell = document.getElementById("wcdv-course-list-panel-shell");
    if (!btn) return;
    const inShell = root.closest("#wcdv-course-list-panel-shell");
    if (!shell || !inShell || typeof shell._wcdvSetCollapsed !== "function") {
      if (btn._wcdvCollapseListener) {
        btn.removeEventListener("click", btn._wcdvCollapseListener);
        btn._wcdvCollapseListener = null;
        btn._wcdvCollapseShell = null;
      }
      btn.hidden = true;
      return;
    }
    btn.hidden = false;
    if (btn._wcdvCollapseShell === shell && btn._wcdvCollapseListener) return;
    if (btn._wcdvCollapseListener) {
      btn.removeEventListener("click", btn._wcdvCollapseListener);
    }
    const fn = (e) => {
      e.stopPropagation();
      if (typeof shell._wcdvSetCollapsed === "function") shell._wcdvSetCollapsed(true);
    };
    btn._wcdvCollapseListener = fn;
    btn._wcdvCollapseShell = shell;
    btn.addEventListener("click", fn);
  }

  /** シェル内では上部メニューに操作ボタン列を移し、カード内の見出しと重複させない（actions は root 外に出るため #wcdv-bulk で引く） */
  function syncWcdvToolbarPlacement(root) {
    const rootEl = root && root.id === "wcdv-root" ? root : document.getElementById("wcdv-root");
    if (!rootEl) return;
    const standaloneChrome = rootEl.querySelector(".wcdv-wc-standalone-chrome");
    const bulk = document.getElementById("wcdv-bulk");
    const actions = bulk && bulk.closest(".wcdv-wc-actions");
    const host = document.getElementById("wcdv-panel-menu-actions-host");
    const menuTitle = document.getElementById("wcdv-panel-menu-title");
    const badge = document.getElementById("wcdv-badge");
    const h2 = document.getElementById("wcdv-wc-heading");
    const label = h2 && h2.querySelector(".wcdv-wc-head-visual-label");
    const sec = rootEl.querySelector(".wcdv-wc-card");
    if (!actions || !standaloneChrome) return;
    const inShell = !!rootEl.closest("#wcdv-course-list-panel-shell");
    if (inShell && host && menuTitle) {
      if (actions.parentElement !== host) host.appendChild(actions);
      if (badge && badge.previousElementSibling !== menuTitle) {
        menuTitle.insertAdjacentElement("afterend", badge);
      }
      rootEl.classList.add("wcdv-toolbar-top");
      if (sec) sec.setAttribute("aria-labelledby", "wcdv-panel-menu-title");
    } else {
      if (actions.parentElement !== standaloneChrome) standaloneChrome.appendChild(actions);
      if (badge && label && badge.previousElementSibling !== label) {
        label.insertAdjacentElement("afterend", badge);
      }
      rootEl.classList.remove("wcdv-toolbar-top");
      if (sec) sec.setAttribute("aria-labelledby", "wcdv-wc-heading");
    }
  }

  /** シェル内ではタイトル行の直下にフィルタ（ラジオ）を置く */
  function syncWcdvFiltersPlacement(root) {
    const rootEl = root && root.id === "wcdv-root" ? root : document.getElementById("wcdv-root");
    if (!rootEl) return;
    const card = rootEl.querySelector(".wcdv-wc-card");
    const list = rootEl.querySelector("#wcdv-list");
    const filters =
      rootEl.querySelector(".wcdv-wc-filters") ||
      document.querySelector("#wcdv-panel-filters-host .wcdv-wc-filters");
    if (!filters || !card || !list) return;
    const host = document.getElementById("wcdv-panel-filters-host");
    const inShell = !!rootEl.closest("#wcdv-course-list-panel-shell");
    if (inShell && host) {
      if (filters.parentElement !== host) host.appendChild(filters);
      rootEl.classList.add("wcdv-filters-top");
    } else {
      if (filters.parentElement !== card) card.insertBefore(filters, list);
      rootEl.classList.remove("wcdv-filters-top");
    }
  }

  /** 大学ごとに違う掲載枠を順に試す（無ければ body 直下＝ページ最下部） */
  function findListMountHost() {
    const selectors = [
      "#js-contents",
      "#contents",
      "#main-contents",
      "#mainContent",
      "main[role='main']",
      "main.cl-contents",
      "main",
      ".cm-contents",
      ".cl-contents",
      "article.content",
      "#app",
    ];
    for (let i = 0; i < selectors.length; i++) {
      try {
        const el = document.querySelector(selectors[i]);
        if (el && el instanceof HTMLElement && el !== document.body) return el;
      } catch {
        /* ignore */
      }
    }
    return document.body;
  }

  /** 上記 h3.page-header の直前にシェル＋一覧を載せる（アンカー無しでは DOM に載せない） */
  function mountListRootIntoPage(root) {
    removeLegacyTabChrome();

    root.classList.remove(
      "wcdv-body-anchor",
      "wcdv-beside-timetable",
      "wcdv-in-left-slot",
      "wcdv-page-left-gutter",
      "wcdv-below-dashboard",
      "wcdv-in-list-table-grid",
      "wcdv-in-row-host",
      "wcdv-tab-panel-root"
    );

    const anchor = findParticipatingCoursesAnchor();
    if (anchor && anchor.parentElement) {
      const par = root.parentElement;
      if (par) par.removeChild(root);

      let shell = document.getElementById("wcdv-course-list-panel-shell");
      if (!(shell instanceof HTMLElement)) shell = createListPanelShell();
      else ensurePanelFiltersSlot(shell);
      const expanded = shell.querySelector("#wcdv-panel-expanded");
      if (expanded instanceof HTMLElement) expanded.appendChild(root);
      anchor.parentElement.insertBefore(shell, anchor);
      root.classList.add("wcdv-wc-skin-wc");
      wirePanelCollapseButton(root);
      syncWcdvToolbarPlacement(root);
      syncWcdvFiltersPlacement(root);
      return;
    }

    const shell = root.closest("#wcdv-course-list-panel-shell");
    if (shell && shell.isConnected) {
      return;
    }

    try {
      root.remove();
    } catch {
      /* ignore */
    }
    const looseShell = document.getElementById("wcdv-course-list-panel-shell");
    if (looseShell && looseShell.parentNode) {
      looseShell.parentNode.removeChild(looseShell);
    }
  }

  /** コース一覧以外へ遷移したとき等、利用可能期間一覧 UI を DOM から外す */
  function unmountWcdvListPanelUi() {
    if (wcdvBulkPort) {
      try {
        wcdvBulkPort.disconnect();
      } catch {
        /* ignore */
      }
      wcdvBulkPort = null;
      wcdvBulkRunningLocal = false;
    }
    const shell = document.getElementById("wcdv-course-list-panel-shell");
    if (shell && shell.parentNode) {
      shell.parentNode.removeChild(shell);
    }
    const root = document.getElementById("wcdv-root");
    if (root && root.parentNode) {
      root.parentNode.removeChild(root);
    }
  }

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

  function storageGetAll() {
    return new Promise((resolve) => {
      try {
        if (!extCtxOk()) {
          resolve({});
          return;
        }
        chrome.storage.local.get(STORAGE_KEY, (obj) => {
          flushChromeRuntimeLastError();
          if (!extCtxOk()) {
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
        if (!extCtxOk()) {
          resolve();
          return;
        }
        chrome.storage.local.set({ [STORAGE_KEY]: root }, () => {
          flushChromeRuntimeLastError();
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
    let bucket = root[ORIGIN];
    if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) {
      bucket = { byCourse: {} };
    }
    if (!bucket.byCourse || typeof bucket.byCourse !== "object") {
      bucket.byCourse = {};
    }
    root[ORIGIN] = bucket;
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
    root[ORIGIN] = site;
    await storageSetAll(root);
  }

  function storageGetBulkMetaRoot() {
    return new Promise((resolve) => {
      try {
        if (!extCtxOk()) {
          resolve({});
          return;
        }
        chrome.storage.local.get(BULK_META_KEY, (obj) => {
          flushChromeRuntimeLastError();
          if (!extCtxOk()) {
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
        if (!extCtxOk()) {
          resolve();
          return;
        }
        chrome.storage.local.set({ [BULK_META_KEY]: meta }, () => {
          flushChromeRuntimeLastError();
          resolve();
        });
      } catch {
        resolve();
      }
    });
  }

  async function getLastBulkStartedAt() {
    const meta = await storageGetBulkMetaRoot();
    const o = meta[ORIGIN];
    return o && typeof o.lastStartedAt === "number" ? o.lastStartedAt : 0;
  }

  async function setLastBulkStartedNow() {
    const meta = await storageGetBulkMetaRoot();
    if (!meta[ORIGIN] || typeof meta[ORIGIN] !== "object") meta[ORIGIN] = {};
    meta[ORIGIN].lastStartedAt = Date.now();
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
        if (!extCtxOk()) {
          resolve(true);
          return;
        }
        chrome.storage.local.get(STORAGE_AUTO_BULK_ENABLED, (obj) => {
          flushChromeRuntimeLastError();
          if (!extCtxOk()) {
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
        if (!extCtxOk()) {
          resolve(AUTO_BULK_INTERVAL_HOURS_DEFAULT * 3600000);
          return;
        }
        chrome.storage.local.get(STORAGE_AUTO_BULK_HOURS, (obj) => {
          flushChromeRuntimeLastError();
          if (!extCtxOk()) {
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

  let saveToastTimer = null;
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
    if (saveToastTimer) clearTimeout(saveToastTimer);
    saveToastTimer = setTimeout(() => {
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
    if (saveToastTimer) clearTimeout(saveToastTimer);
    saveToastTimer = setTimeout(() => {
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
    if (saveToastTimer) clearTimeout(saveToastTimer);
    saveToastTimer = setTimeout(() => {
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

  function formatCountdownToEnd(endMs) {
    const now = Date.now();
    if (now >= endMs) return "締切（利用可能期間の終了）を過ぎています";
    const diff = endMs - now;
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    return `あと${d}日${h}時間${m}分`;
  }

  const WCDV_DEADLINE_SOON_MS = 2 * 3600000;

  /** 受付中=緑・締切=赤・残り2時間未満=黄（行左アクセント用クラス） */
  function deadlineRowUrgencyClass(item) {
    const now = Date.now();
    const endMs = item.period.end.getTime();
    if (item.status === "ended" || now >= endMs) return "wcdv-wc-item--deadline-ended";
    if (item.status === "upcoming") return "wcdv-wc-item--deadline-upcoming";
    const remain = endMs - now;
    if (remain > 0 && remain < WCDV_DEADLINE_SOON_MS) return "wcdv-wc-item--deadline-soon";
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
        bag && typeof bag === "object" && Array.isArray(bag[ORIGIN]) ? bag[ORIGIN] : [];
      return new Set(arr.map((x) => String(x)));
    } catch {
      return new Set();
    }
  }

  async function saveSubmittedKeySet(set) {
    const got = await chrome.storage.local.get(STORAGE_SUBMITTED_ITEMS);
    const prev = got[STORAGE_SUBMITTED_ITEMS];
    const bag = prev && typeof prev === "object" ? { ...prev } : {};
    bag[ORIGIN] = [...set];
    await chrome.storage.local.set({ [STORAGE_SUBMITTED_ITEMS]: bag });
  }

  function applyListFilters(items, submittedSet) {
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
      return out;
    }

    if (mode === "week") {
      out = out.filter((it) => it.period.end.getTime() >= now && it.period.end.getTime() <= now + weekMs);
    } else if (mode === "active") {
      /* 期限内すべて = 受付中のみ（未開始は「すべて」側で見る） */
      out = out.filter((it) => it.status === "open");
    } else if (mode === "ended") {
      out = out.filter((it) => it.status === "ended");
    }

    return out;
  }

  function scheduleSubmittedListRefresh() {
    if (wcdvSubmittedListRefreshTimer != null) clearTimeout(wcdvSubmittedListRefreshTimer);
    wcdvSubmittedListRefreshTimer = setTimeout(() => {
      wcdvSubmittedListRefreshTimer = null;
      const r = document.getElementById("wcdv-root");
      if (r && r.isConnected) void refreshListPanel(r);
    }, WCDV_SUBMITTED_LIST_REFRESH_MS);
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
    if (!isCourseListPage() || !isWebclassPathPage()) return;
    try {
      sessionStorage.setItem(WCDV_LAST_LIST_PAGE_URL_KEY, location.href.split("#")[0]);
    } catch {
      /* ignore */
    }
  }

  function getCourseListUrlForHumanNav() {
    try {
      const raw = sessionStorage.getItem(WCDV_LAST_LIST_PAGE_URL_KEY);
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
      raw = sessionStorage.getItem(WCDV_PENDING_ASSIGN_NAV_KEY);
    } catch {
      return false;
    }
    if (!raw) return false;
    let p;
    try {
      p = JSON.parse(raw);
    } catch {
      try {
        sessionStorage.removeItem(WCDV_PENDING_ASSIGN_NAV_KEY);
      } catch {
        /* ignore */
      }
      return false;
    }
    if (!p || !p.courseKey) {
      try {
        sessionStorage.removeItem(WCDV_PENDING_ASSIGN_NAV_KEY);
      } catch {
        /* ignore */
      }
      return false;
    }
    if (Date.now() - (p.t || 0) > 90000) {
      try {
        sessionStorage.removeItem(WCDV_PENDING_ASSIGN_NAV_KEY);
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
          sessionStorage.removeItem(WCDV_PENDING_ASSIGN_NAV_KEY);
        } catch {
          /* ignore */
        }
        return false;
      }
      el = findNativeVisitAnchorByPrimaryNorm(p.primaryNorm);
    } else {
      if (!p.wantNorm) {
        try {
          sessionStorage.removeItem(WCDV_PENDING_ASSIGN_NAV_KEY);
        } catch {
          /* ignore */
        }
        return false;
      }
      el = findNativeLinkInListDomByNormalizedHref(p.wantNorm);
    }
    if (!el || typeof el.click !== "function") return false;
    try {
      sessionStorage.removeItem(WCDV_PENDING_ASSIGN_NAV_KEY);
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
    if (!isCourseListPage() || !isWebclassPathPage()) return;
    let raw;
    try {
      raw = sessionStorage.getItem(WCDV_PENDING_ASSIGN_NAV_KEY);
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
        sessionStorage.removeItem(WCDV_PENDING_ASSIGN_NAV_KEY);
      } catch {
        /* ignore */
      }
      return;
    }
    const clicked = clickCourseAnchorMatchingKey(p.courseKey);
    const next = { ...p };
    delete next.phase;
    try {
      sessionStorage.setItem(WCDV_PENDING_ASSIGN_NAV_KEY, JSON.stringify(next));
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
      sessionStorage.setItem(WCDV_PENDING_ASSIGN_NAV_KEY, JSON.stringify(pending));
    } catch {
      try {
        if (isCourseListPage()) {
          location.assign(item.coursePageUrl);
        } else {
          location.assign(getCourseListUrlForHumanNav());
        }
      } catch {
        /* ignore */
      }
      return;
    }

    if (isCourseListPage()) {
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
      sessionStorage.setItem(WCDV_PENDING_ASSIGN_NAV_KEY, JSON.stringify(pending));
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
        if (isCourseListPage()) {
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

  async function renderList(root, allItems) {
    rememberWebclassCourseListUrl();
    tryAdvancePendingNavFromListPage();

    const badge = document.getElementById("wcdv-badge");
    const list = root.querySelector("#wcdv-list");
    const prog = root.querySelector("#wcdv-progress");
    const wcSkin = root.classList.contains("wcdv-wc-skin-wc");

    if (prog) prog.textContent = "";

    const submittedSet = await loadSubmittedKeySet();
    const items = applyListFilters(allItems, submittedSet);
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
        } else if (submittedSet.size > 0) {
          empty.textContent =
            "提出済みに登録した項目は、この条件では表示されません（「期間なしを除外」がオンになっていないか確認してください）。";
        } else {
          empty.textContent =
            "各行の「提出済み」にチェックを入れた項目だけがこのタブに表示されます。チェックを外すと、もとのタブの条件に戻ります。";
        }
      } else if (allItems.length === 0) {
        empty.textContent =
          "「一括取得」で全コースをまとめて取得するか、各コースを開いてデータを蓄積してください。表示は利用可能期間の終了が早い順です。";
      } else {
        empty.textContent = "この表示条件に該当する項目はありません。フィルタを変えてください。";
      }
      list.appendChild(empty);
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
        pLab.textContent = LABEL_TEXT;
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
        cdLab.textContent = "締切まで";
        const cdData = document.createElement("div");
        cdData.className = "cm-contentsList_contentDetailListItemData wcdv-wc-countdown";
        cdData.textContent = formatCountdownToEnd(item.period.end.getTime());
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

        detail.appendChild(detailList);
        appendSubmittedWcDetailFooter(detail, item, submittedSet);
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

      top.appendChild(titleCol);
      top.appendChild(linksCol);
      row.appendChild(top);

      const cd = document.createElement("div");
      cd.className = "wcdv-wc-countdown";
      cd.textContent = formatCountdownToEnd(item.period.end.getTime());
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

      appendSubmittedPlainRow(row, item, submittedSet);
      list.appendChild(row);
    });
  }

  async function refreshListPanel(root) {
    if (!extCtxOk()) return;
    if (wcdvSubmittedListRefreshTimer != null) {
      clearTimeout(wcdvSubmittedListRefreshTimer);
      wcdvSubmittedListRefreshTimer = null;
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
    if (!isCourseListPage()) return;
    if (wcdvAutoBulkStaleTimer != null) clearTimeout(wcdvAutoBulkStaleTimer);
    wcdvAutoBulkStaleTimer = setTimeout(() => {
      wcdvAutoBulkStaleTimer = null;
      void maybeAutoBulkStale(root);
    }, 2800);
  }

  async function maybeAutoBulkStale(root) {
    const r =
      root && root.isConnected && root.id === "wcdv-root"
        ? root
        : document.getElementById("wcdv-root");
    if (!r || !r.isConnected) return;
    if (!isCourseListPage() || !isWebclassPathPage()) return;
    if (wcdvBulkRunningLocal) return;
    if (wcdvAutoBulkStaleAttempted) return;
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
    wcdvAutoBulkStaleAttempted = true;
    const progEl = r.querySelector("#wcdv-progress");
    if (progEl) {
      progEl.textContent = `保存データの最終更新から${staleHours}時間以上経過しているため、一括取得を自動で開始します…`;
    }
    const ok = await startBulkBackground(r, courses);
    if (!ok) {
      wcdvAutoBulkStaleAttempted = false;
      if (progEl) progEl.textContent = "";
    }
  }

  async function startBulkBackground(root, courses) {
    if (wcdvBulkRunningLocal || !root || !root.isConnected) return false;
    if (!extCtxOk()) return false;
    const entries = courses.map((c) => ({ url: c.fetchUrl, title: c.title }));
    let port;
    try {
      port = chrome.runtime.connect({ name: CONNECT_NAME });
    } catch {
      if (extCtxOk()) {
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
    wcdvBulkPort = port;
    wcdvBulkRunningLocal = true;
    try {
      await setLastBulkStartedNow();
    } catch {
      wcdvBulkRunningLocal = false;
      wcdvBulkPort = null;
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
      if (!extCtxOk()) {
        wcdvBulkRunningLocal = false;
        wcdvBulkPort = null;
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
          wcdvBulkRunningLocal = false;
          wcdvBulkPort = null;
          try {
            port.disconnect();
          } catch {
            /* ignore */
          }
          void refreshListPanel(root);
        } else if (msg.type === "error") {
          if (extCtxOk()) {
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
          wcdvBulkRunningLocal = false;
          wcdvBulkPort = null;
          try {
            port.disconnect();
          } catch {
            /* ignore */
          }
        }
      } catch {
        wcdvBulkRunningLocal = false;
        wcdvBulkPort = null;
      }
    };
    port.onMessage.addListener(onMsg);
    port.onDisconnect.addListener(() => {
      flushChromeRuntimeLastError();
      try {
        port.onMessage.removeListener(onMsg);
      } catch {
        /* ignore */
      }
      if (wcdvBulkPort === port) wcdvBulkPort = null;
      wcdvBulkRunningLocal = false;
    });
    try {
      port.postMessage({
        type: "start",
        origin: ORIGIN,
        listUrl: location.href,
        entries,
      });
    } catch {
      wcdvBulkRunningLocal = false;
      wcdvBulkPort = null;
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
    if (!isWebclassPathPage()) return null;
    if (!isCourseListPage()) {
      unmountWcdvListPanelUi();
      return null;
    }
    let root = document.getElementById("wcdv-root");
    if (root && root.isConnected) {
      wirePanelCollapseButton(root);
      syncWcdvToolbarPlacement(root);
      syncWcdvFiltersPlacement(root);
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
          <label class="wcdv-wc-filter-label" title="チェックした項目のみ"><span class="wcdv-wc-filter-control"><input type="radio" name="wcdv-filter" value="submitted" /></span><span class="wcdv-wc-filter-text">提出済み</span></label>
          <label class="wcdv-wc-filter-check"><span class="wcdv-wc-filter-control"><input type="checkbox" id="wcdv-exclude-noperiod" /></span><span class="wcdv-wc-filter-text">期間なしを除外</span></label>
        </div>
        <div id="wcdv-list" class="wcdv-wc-list"></div>
      </section>
    `;
    mountListRootIntoPage(root);
    if (!root.isConnected) {
      try {
        root.remove();
      } catch {
        /* ignore */
      }
      return null;
    }
    wirePanelCollapseButton(root);
    syncWcdvToolbarPlacement(root);
    syncWcdvFiltersPlacement(root);

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
              `【実行場所】非表示のバックグラウンドタブで、毎回コース一覧を開き直してからページ上の該当コース <a> を click() します（見つからないときだけ assign）。\n` +
              `教材ページが読み込まれたら保存します（教材がないコースはすぐに 0 件として保存）。この一覧はそのまま使えます。`
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

    if (!wcdvStorageListenerAttached) {
      wcdvStorageListenerAttached = true;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (!changes[STORAGE_KEY] && !changes[STORAGE_SUBMITTED_ITEMS]) return;
        if (!extCtxOk() || !isWebclassPathPage() || !isCourseListPage()) return;
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
    if (!isWebclassPathPage() || !isCourseListPage()) {
      unmountWcdvListPanelUi();
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
    const tick = () => {
      raf = null;
      if (!isWebclassPathPage()) return;
      if (!isCourseListPage()) {
        unmountWcdvListPanelUi();
        return;
      }
      const root = document.getElementById("wcdv-root");
      const mainHost = findListMountHost();
      if (!mainHost) return;
      if (!root || !root.isConnected) {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          ensureListUi();
        }, 200);
        return;
      }
      const anchor = findParticipatingCoursesAnchor();
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
          mountListRootIntoPage(root);
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

    let lastPath = location.pathname + location.search;
    const pathTick = () => {
      const now = location.pathname + location.search;
      if (now !== lastPath) {
        lastPath = now;
        if (!isWebclassPathPage() || !isCourseListPage()) unmountWcdvListPanelUi();
      }
    };
    window.addEventListener("popstate", pathTick);
    setInterval(pathTick, 700);
  }

  if (!isWebclassPathPage()) {
    return;
  }
  if (isCourseListPage()) {
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
        mountListRootIntoPage(r);
        if (r.isConnected) void refreshListPanel(r);
      }, anchorRetryDelays[ti]);
    }
    startListMountWatchdog();
  } else if (isCourseHomePage()) {
    runCoursePage();
  }
})();
