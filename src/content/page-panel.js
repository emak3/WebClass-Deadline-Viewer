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
  if (C.wcdvBulkPort) {
    try {
      C.wcdvBulkPort.disconnect();
    } catch {
      /* ignore */
    }
    C.wcdvBulkPort = null;
    C.wcdvBulkRunningLocal = false;
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

  globalThis.WCDV_CONTENT_FNS = Object.freeze({
    extCtxOk,
    flushChromeRuntimeLastError,
    isWebclassPathPage,
    isCourseListPage,
    findParticipatingCoursesAnchor,
    removeLegacyTabChrome,
    wcdvPanelChevronSvg,
    createListPanelShell,
    ensurePanelFiltersSlot,
    wirePanelCollapseButton,
    syncWcdvToolbarPlacement,
    syncWcdvFiltersPlacement,
    findListMountHost,
    mountListRootIntoPage,
    unmountWcdvListPanelUi,
  });

})();
