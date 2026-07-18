(function () {
"use strict";

let flattenedItems = null;
let submittedItems = null;
let highlightedIndex = -1;
let hideTimer = null;
let hooks = null;

function configure(nextHooks) {
  hooks = nextHooks;
}

function setData(items, submitted) {
  flattenedItems = items;
  submittedItems = submitted;
}

function getListSearchQuery() {
  const inp = document.getElementById("wcdv-list-search");
  return inp ? String(inp.value || "").trim() : "";
}

function itemSearchHaystack(item) {
  const p = item && item.period;
  const parts = [
    item && item.titleText,
    item && item.courseTitle,
    item && item.folderTitle,
    item && item.category,
    p && p.raw,
    item && item.visitCountText,
    item && item.resubmissionText,
  ];
  return parts.map((x) => String(x || "")).join("\n");
}

/** 検索用に改行・連続空白を潰した1行（候補確定の「コース名 題名」と順序が違っても当てられる） */
function itemSearchHaystackFlat(item) {
  return itemSearchHaystack(item).replace(/\s+/g, " ").trim();
}

function itemMatchesSearch(item, q) {
  const needle = String(q || "").trim();
  if (!needle) return true;
  const hayLine = itemSearchHaystack(item);
  if (hayLine.includes(needle)) return true;
  const hayFlat = itemSearchHaystackFlat(item);
  const needleFlat = needle.replace(/\s+/g, " ").trim();
  if (hayFlat.includes(needleFlat)) return true;
  try {
    const hf = hayFlat.toLowerCase();
    const nf = needleFlat.toLowerCase();
    if (hf.includes(nf)) return true;
    const tokens = needleFlat.split(/\s+/).filter(Boolean);
    if (tokens.length < 2) return false;
    return tokens.every((tok) => hf.includes(tok.toLowerCase()));
  } catch {
    return false;
  }
}

function applySearchTextFilter(items) {
  const q = getListSearchQuery();
  if (!q) return items.slice();
  return items.filter((it) => itemMatchesSearch(it, q));
}

function suggestionFillValueForItem(item) {
  const t = item && String(item.titleText || "").trim();
  const c = item && String(item.courseTitle || "").trim();
  if (c && t) return `${c} ${t}`;
  return t || c || "";
}

const WCDV_SEARCH_SUGGEST_MAX = 12;

/** 検索欄が空のときの title（入力中は現在の検索語を title に出す） */
const WCDV_LIST_SEARCH_INPUT_HELP_TITLE =
  "教材タイトル・コース名・フォルダ・カテゴリ・利用可能期間の表記などに部分一致します";

function syncListSearchInputTitle(inp) {
  if (!inp) return;
  const v = String(inp.value || "").trim();
  inp.title = v ? String(inp.value || "") : WCDV_LIST_SEARCH_INPUT_HELP_TITLE;
}

function hideSearchSuggestDropdown() {
  const box = document.getElementById("wcdv-list-search-suggest");
  const inp = document.getElementById("wcdv-list-search");
  if (box) {
    box.hidden = true;
    box.innerHTML = "";
  }
  if (inp) inp.setAttribute("aria-expanded", "false");
  highlightedIndex = -1;
}

function syncSearchClearButtonVisibility() {
  const clearBtn = document.getElementById("wcdv-list-search-clear");
  const inp = document.getElementById("wcdv-list-search");
  if (!clearBtn || !inp) return;
  clearBtn.hidden = !String(inp.value || "").trim();
}

function paintSearchSuggestHighlight(box) {
  if (!box) return;
  const opts = box.querySelectorAll(".wcdv-wc-search-suggest__opt");
  opts.forEach((el, i) => {
    el.classList.toggle("wcdv-wc-search-suggest__opt--hi", i === highlightedIndex);
    el.setAttribute("aria-selected", i === highlightedIndex ? "true" : "false");
  });
}

function updateSearchSuggestionsDom(root) {
  const inp = document.getElementById("wcdv-list-search");
  const box = document.getElementById("wcdv-list-search-suggest");
  if (!inp || !box) return;
  const q = String(inp.value || "").trim();
  if (!q || !flattenedItems || !submittedItems || !hooks) {
    hideSearchSuggestDropdown();
    return;
  }
  const base = hooks.applyNonSearchListFilters(flattenedItems, submittedItems);
  const matches = [];
  const seen = new Set();
  for (let i = 0; i < base.length; i++) {
    const it = base[i];
    if (!itemMatchesSearch(it, q)) continue;
    const key = hooks.itemStorageFingerprint(it);
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ item: it });
    if (matches.length >= WCDV_SEARCH_SUGGEST_MAX) break;
  }
  if (matches.length === 0) {
    hideSearchSuggestDropdown();
    return;
  }
  box.innerHTML = "";
  highlightedIndex = -1;
  for (let j = 0; j < matches.length; j++) {
    const m = matches[j];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "wcdv-wc-search-suggest__opt";
    btn.setAttribute("role", "option");
    btn.dataset.wcdvFill = suggestionFillValueForItem(m.item);
    const cLab = String(m.item.courseTitle || "").trim() || "コース";
    const tLab = String(m.item.titleText || "").trim() || "（無題）";
    const sep = document.createElement("span");
    sep.className = "wcdv-wc-search-suggest__sep";
    sep.textContent = " › ";
    const courseSpan = document.createElement("span");
    courseSpan.className = "wcdv-wc-search-suggest__course";
    courseSpan.textContent = cLab;
    const titleSpan = document.createElement("span");
    titleSpan.className = "wcdv-wc-search-suggest__title";
    titleSpan.textContent = tLab;
    if (tLab && tLab !== "（無題）") titleSpan.classList.add("wcdv-wc-search-suggest__title--emph");
    btn.appendChild(courseSpan);
    btn.appendChild(sep);
    btn.appendChild(titleSpan);
    btn.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      inp.value = String(btn.dataset.wcdvFill || "").trim();
      syncSearchClearButtonVisibility();
      syncListSearchInputTitle(inp);
      hideSearchSuggestDropdown();
      if (root && root.isConnected) void hooks.refreshListPanel(root);
      inp.blur();
    });
    box.appendChild(btn);
  }
  box.hidden = false;
  inp.setAttribute("aria-expanded", "true");
  paintSearchSuggestHighlight(box);
}

function wireListSearchUi(root) {
  const inp = document.getElementById("wcdv-list-search");
  const box = document.getElementById("wcdv-list-search-suggest");
  const clearBtn = document.getElementById("wcdv-list-search-clear");
  if (!inp || !box || inp._wcdvSearchWired) return;
  inp._wcdvSearchWired = true;

  const schedHide = () => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hideTimer = null;
      const a = document.activeElement;
      if (a !== inp && !(a && box.contains(a))) hideSearchSuggestDropdown();
    }, 200);
  };

  inp.addEventListener("input", () => {
    syncSearchClearButtonVisibility();
    syncListSearchInputTitle(inp);
    void hooks.refreshListPanel(root);
  });
  syncSearchClearButtonVisibility();
  syncListSearchInputTitle(inp);
  if (clearBtn && !clearBtn._wcdvSearchClearWired) {
    clearBtn._wcdvSearchClearWired = true;
    clearBtn.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      inp.value = "";
      syncSearchClearButtonVisibility();
      syncListSearchInputTitle(inp);
      hideSearchSuggestDropdown();
      void hooks.refreshListPanel(root);
      inp.focus();
    });
  }
  inp.addEventListener("focus", () => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    updateSearchSuggestionsDom(root);
  });
  inp.addEventListener("blur", schedHide);
  box.addEventListener("focusout", schedHide);

  inp.addEventListener("keydown", (ev) => {
    if (box.hidden) return;
    const opts = box.querySelectorAll(".wcdv-wc-search-suggest__opt");
    if (opts.length === 0) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      hideSearchSuggestDropdown();
      return;
    }
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      highlightedIndex = Math.min(highlightedIndex + 1, opts.length - 1);
      if (highlightedIndex < 0) highlightedIndex = 0;
      paintSearchSuggestHighlight(box);
      opts[highlightedIndex].scrollIntoView({ block: "nearest" });
      return;
    }
    if (ev.key === "ArrowUp") {
      ev.preventDefault();
      highlightedIndex = Math.max(highlightedIndex - 1, -1);
      paintSearchSuggestHighlight(box);
      return;
    }
    if (ev.key === "Enter" && highlightedIndex >= 0) {
      ev.preventDefault();
      opts[highlightedIndex].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    }
  });
}

globalThis.WCDV_SEARCH_PANEL = Object.freeze({
  LIST_SEARCH_INPUT_HELP_TITLE: WCDV_LIST_SEARCH_INPUT_HELP_TITLE,
  applySearchTextFilter,
  configure,
  setData,
  updateSearchSuggestionsDom,
  wireListSearchUi,
});
})();
