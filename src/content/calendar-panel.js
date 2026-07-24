/* eslint-disable no-unused-vars -- shared content-script chunk */
(function () {
  "use strict";

  const { STORAGE_WEEK_START_DAY } = globalThis.WCDV_SHARED;
  const C = globalThis.WCDV_CONTENT;
  let bindItemLink = null;

  function configure(opts) {
    bindItemLink = opts.bindItemLink;
  }

  function startOfDay(value) {
    const d = new Date(value);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function addDays(value, amount) {
    const d = new Date(value);
    d.setDate(d.getDate() + amount);
    return d;
  }

  function startOfWeek(value, weekStartDay) {
    const d = startOfDay(value);
    const startDay = Number.isInteger(weekStartDay) ? weekStartDay : 0;
    d.setDate(d.getDate() - ((d.getDay() - startDay + 7) % 7));
    return d;
  }

  function getVisibleRange(mode, anchorMs, weekStartDay) {
    const anchor = startOfDay(anchorMs || Date.now());
    if (mode === "month") {
      const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
      const start = startOfWeek(first, weekStartDay);
      const end = addDays(startOfWeek(last, weekStartDay), 7);
      return { start, end, label: `${anchor.getFullYear()}年${anchor.getMonth() + 1}月` };
    }
    const start = startOfWeek(anchor, weekStartDay);
    const days = mode === "fortnight" ? 14 : 7;
    const end = addDays(start, days);
    const last = addDays(end, -1);
    const label =
      start.getFullYear() === last.getFullYear()
        ? `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日〜${last.getMonth() + 1}月${last.getDate()}日`
        : `${start.getFullYear()}年${start.getMonth() + 1}月${start.getDate()}日〜${last.getFullYear()}年${last.getMonth() + 1}月${last.getDate()}日`;
    return { start, end, label };
  }

  async function loadWeekStartDay() {
    try {
      const result = await chrome.storage.local.get(STORAGE_WEEK_START_DAY);
      const value = Number(result[STORAGE_WEEK_START_DAY]);
      return Number.isInteger(value) && value >= 0 && value <= 6 ? value : 0;
    } catch {
      return 0;
    }
  }

  function formatTime(value) {
    const d = new Date(value);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  function formatDeadline(value) {
    const d = new Date(value);
    return `${d.getMonth() + 1}/${d.getDate()} ${formatTime(value)}`;
  }

  function fractionOfDay(value) {
    const d = new Date(value);
    const elapsedSeconds = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
    return Math.max(0, Math.min(1, elapsedSeconds / 86400));
  }

  function deterministicCourseColor(item) {
    const palette = [
      "#4a6fa5", "#2f7d6d", "#8a5a9f", "#b05a47", "#5f7f3c",
      "#3e7f9d", "#9a6a2f", "#765a9f", "#487a55", "#a44f72",
    ];
    const source = String(item.coursePageUrl || item.courseTitle || item.titleText || "course");
    let hash = 0;
    for (let i = 0; i < source.length; i++) hash = (Math.imul(hash, 31) + source.charCodeAt(i)) | 0;
    return palette[Math.abs(hash) % palette.length];
  }

  function makeEvent(doc, item, mode, segment) {
    const a = doc.createElement("a");
    a.className = "wcdv-calendar-event";
    const color = item.calendarCourseColor || deterministicCourseColor(item);
    a.style.setProperty("--wcdv-event-color", color);
    a.style.gridColumn = `${segment.start + 1} / span ${segment.span}`;
    a.style.gridRow = String(segment.row + 2);
    if (segment.endsHere) {
      const occupiedDays = segment.span - 1 + segment.endDayFraction;
      const widthPercent = Math.max(0, Math.min(100, (occupiedDays / segment.span) * 100));
      a.style.justifySelf = "start";
      a.style.width = `max(6px, calc(${widthPercent.toFixed(4)}% - 6px))`;
    }
    if (!segment.startsHere) a.classList.add("wcdv-calendar-event--continues-before");
    if (!segment.endsHere) a.classList.add("wcdv-calendar-event--continues-after");
    const title = item.titleText || "（無題）";
    a.href = item.calendarHref || item.hrefTitle || item.coursePageUrl;
    a.rel = "noopener noreferrer";
    a.title = `${title}\n${item.courseTitle || "コース"}\n利用可能期間: ${item.period.raw}`;
    const titleEl = doc.createElement("span");
    titleEl.className = "wcdv-calendar-event__title";
    titleEl.textContent = title;
    a.appendChild(titleEl);
    const courseEl = doc.createElement("span");
    courseEl.className = "wcdv-calendar-event__course";
    courseEl.textContent = item.courseTitle || "コース";
    a.appendChild(courseEl);
    const timeEl = doc.createElement("time");
    timeEl.className = "wcdv-calendar-event__time";
    timeEl.dateTime = new Date(item.endMs).toISOString();
    timeEl.textContent = `締切 ${formatDeadline(item.endMs)}`;
    a.appendChild(timeEl);
    if (bindItemLink && (item.calendarHref || item.hrefTitle)) {
      bindItemLink(a, { ...item, hrefTitle: item.calendarHref || item.hrefTitle }, "title");
    }
    return a;
  }

  function createWeek(doc, weekStart, mode, items) {
    const week = doc.createElement("div");
    week.className = "wcdv-calendar-week";
    const weekEnd = addDays(weekStart, 7);
    const segments = items
      .filter((item) => item.startMs < weekEnd.getTime() && item.endMs >= weekStart.getTime())
      .map((item) => {
        const visibleStart = Math.max(startOfDay(item.startMs).getTime(), weekStart.getTime());
        const visibleEnd = Math.min(startOfDay(item.endMs).getTime(), addDays(weekStart, 6).getTime());
        const start = Math.max(0, Math.round((visibleStart - weekStart.getTime()) / 86400000));
        const end = Math.min(6, Math.round((visibleEnd - weekStart.getTime()) / 86400000));
        return {
          item,
          start,
          end,
          span: end - start + 1,
          startsHere: startOfDay(item.startMs).getTime() >= weekStart.getTime(),
          endsHere: startOfDay(item.endMs).getTime() < weekEnd.getTime(),
          endDayFraction: fractionOfDay(item.endMs),
          row: 0,
        };
      })
      .sort((a, b) => a.start - b.start || b.span - a.span || a.item.endMs - b.item.endMs);

    const occupiedUntil = [];
    segments.forEach((segment) => {
      let row = 0;
      while (occupiedUntil[row] != null && occupiedUntil[row] >= segment.start) row++;
      segment.row = row;
      occupiedUntil[row] = segment.end;
    });
    const eventRows = Math.max(1, occupiedUntil.length);

    for (let i = 0; i < 7; i++) {
      const date = addDays(weekStart, i);
      const cell = doc.createElement("div");
      cell.className = "wcdv-calendar-day";
      cell.style.gridColumn = String(i + 1);
      cell.style.gridRow = `1 / span ${eventRows + 1}`;
      if (date.getMonth() !== new Date(C.wcdvCalendarAnchorMs || Date.now()).getMonth() && mode === "month") {
        cell.classList.add("wcdv-calendar-day--outside");
      }
      if (startOfDay(date).getTime() === startOfDay(Date.now()).getTime()) {
        cell.classList.add("wcdv-calendar-day--today");
      }
      const head = doc.createElement("div");
      head.className = "wcdv-calendar-day__head";
      const dayName = ["日", "月", "火", "水", "木", "金", "土"][date.getDay()];
      head.textContent = `${date.getMonth() + 1}/${date.getDate()} (${dayName})`;
      cell.appendChild(head);
      week.appendChild(cell);
    }
    segments.forEach((segment) => {
      week.appendChild(makeEvent(doc, segment.item, mode, segment));
    });
    return week;
  }

  async function render(root, allItems, options) {
    const list = root.querySelector("#wcdv-list");
    if (!list) return;
    const doc = root.ownerDocument || document;
    const opts = options || {};
    list.innerHTML = "";
    list.classList.remove("list-group");
    list.classList.add("wcdv-calendar-host");
    const mode = opts.mode || "month";
    if (!C.wcdvCalendarAnchorMs) C.wcdvCalendarAnchorMs = Date.now();
    const weekStartDay = Number.isInteger(opts.weekStartDay) ? opts.weekStartDay : 0;
    const range = getVisibleRange(mode, C.wcdvCalendarAnchorMs, weekStartDay);
    const exclude = doc.getElementById("wcdv-exclude-noperiod");
    const items = allItems.filter((item) => {
      const shouldExclude = opts.excludeNoPeriod === true || (exclude && exclude.checked);
      if (shouldExclude && (!item.period || !String(item.period.raw || "").trim())) return false;
      return item.period && item.startMs < range.end.getTime() && item.endMs >= range.start.getTime();
    });

    const toolbar = doc.createElement("div");
    toolbar.className = "wcdv-calendar-toolbar";
    toolbar.innerHTML = `
      <div class="wcdv-calendar-nav">
        <button type="button" class="wcdv-calendar-nav-btn" data-direction="prev" aria-label="前の期間" title="前の期間">‹</button>
        <button type="button" class="wcdv-calendar-today">今日</button>
        <button type="button" class="wcdv-calendar-nav-btn" data-direction="next" aria-label="次の期間" title="次の期間">›</button>
      </div>
      <strong class="wcdv-calendar-range-label"></strong>`;
    toolbar.querySelector(".wcdv-calendar-range-label").textContent = range.label;
    toolbar.querySelector(".wcdv-calendar-today").addEventListener("click", () => {
      C.wcdvCalendarAnchorMs = Date.now();
      void render(root, allItems, opts);
    });
    toolbar.querySelectorAll("[data-direction]").forEach((button) => {
      button.addEventListener("click", () => {
        const amount = button.dataset.direction === "prev" ? -1 : 1;
        const anchor = new Date(C.wcdvCalendarAnchorMs);
        if (mode === "month") anchor.setMonth(anchor.getMonth() + amount);
        else anchor.setDate(anchor.getDate() + amount * (mode === "fortnight" ? 14 : 7));
        C.wcdvCalendarAnchorMs = anchor.getTime();
        void render(root, allItems, opts);
      });
    });
    list.appendChild(toolbar);

    const grid = doc.createElement("div");
    grid.className = `wcdv-calendar-grid wcdv-calendar-grid--${mode}`;
    for (let cursor = new Date(range.start); cursor < range.end; cursor = addDays(cursor, 7)) {
      grid.appendChild(createWeek(doc, new Date(cursor), mode, items));
    }
    list.appendChild(grid);

    if (opts.focusToday) {
      const todayCell = grid.querySelector(".wcdv-calendar-day--today");
      if (todayCell) {
        const view = doc.defaultView;
        const revealToday = () => todayCell.scrollIntoView({ block: "center", inline: "nearest" });
        if (view && typeof view.requestAnimationFrame === "function") view.requestAnimationFrame(revealToday);
        else revealToday();
      }
    }

    if (items.length === 0) {
      const empty = doc.createElement("p");
      empty.className = "wcdv-calendar-empty";
      empty.textContent = "この期間に利用可能な課題はありません。";
      list.appendChild(empty);
    }
    const badge = doc.getElementById("wcdv-badge");
    if (badge) badge.textContent = `（${items.length}）`;
  }

  const POPUP_STYLES = `
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 100%; min-width: 720px; min-height: 100%; background: #fff; color: #25364b; }
    body { padding: 0; }
    .wcdv-popup-shell { min-height: 100vh; overflow: hidden; border: none; border-radius: 0; background: #fff; box-shadow: none; }
    .wcdv-popup-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; border-bottom: 1px solid #dce3eb; background: #eef2f7; }
    .wcdv-popup-title { margin: 0; font-size: 13px; font-weight: 650; }
    #wcdv-badge { color: #5c6b78; font-size: 11px; }
    .wcdv-wc-list { overflow: auto; background: #fff; }
    .wcdv-calendar-toolbar { position: sticky; left: 0; z-index: 4; display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; padding: 6px 8px; border-bottom: 1px solid #dce3eb; background: #fff; }
    .wcdv-calendar-nav { display: flex; gap: 4px; }
    .wcdv-calendar-nav-btn, .wcdv-calendar-today { height: 24px; min-width: 26px; margin: 0; padding: 0 7px; border: 1px solid #c5d0dc; border-radius: 3px; background: #fff; color: #334155; font: 11px inherit; cursor: pointer; }
    .wcdv-calendar-nav-btn { font-size: 17px; }
    .wcdv-calendar-range-label { font-size: 12px; }
    .wcdv-calendar-grid { min-width: 700px; border-left: 1px solid #e1e7ee; }
    .wcdv-calendar-week { position: relative; display: grid; grid-template-columns: repeat(7, minmax(96px, 1fr)); grid-template-rows: 24px; grid-auto-rows: 23px; min-height: 82px; border-bottom: 1px solid #e1e7ee; }
    .wcdv-calendar-day { z-index: 0; min-width: 0; min-height: 100%; padding: 0; border-right: 1px solid #e1e7ee; background: #fff; }
    .wcdv-calendar-day--outside { background: #f7f9fb; }
    .wcdv-calendar-day--today { position: relative; z-index: 1; background: #fff5f5; box-shadow: inset 0 0 0 2px #fff5f5; }
    .wcdv-calendar-day__head { height: 24px; padding: 4px 5px 3px; border-bottom: 1px solid #edf1f5; color: #64748b; font-size: 9px; font-weight: 600; text-align: right; }
    .wcdv-calendar-day--today .wcdv-calendar-day__head { color: #b4232b; background: #ffe8ea; }
    .wcdv-calendar-event { z-index: 2; align-self: start; display: flex; align-items: center; gap: 4px; min-width: 0; height: 19px; margin: 2px 3px; padding: 1px 5px 1px 6px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--wcdv-event-color) 38%, white); border-left: 3px solid var(--wcdv-event-color); border-radius: 3px; background: color-mix(in srgb, var(--wcdv-event-color) 10%, white); color: #243142; font-size: 9px; line-height: 15px; text-decoration: none; white-space: nowrap; }
    .wcdv-calendar-event:hover { background: color-mix(in srgb, var(--wcdv-event-color) 18%, white); }
    .wcdv-calendar-event__title, .wcdv-calendar-event__course, .wcdv-calendar-event__time { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .wcdv-calendar-event__title { flex: 1 1 auto; font-weight: 700; }
    .wcdv-calendar-event__course { flex: 0 1 auto; color: #526174; }
    .wcdv-calendar-event__course::before { content: "· "; }
    .wcdv-calendar-event__time { flex: 0 0 auto; color: #5f6f82; }
    .wcdv-calendar-event--continues-before { margin-left: 0; border-left-width: 1px; border-radius: 0 3px 3px 0; }
    .wcdv-calendar-event--continues-after { margin-right: 0; border-radius: 3px 0 0 3px; }
    .wcdv-calendar-event--continues-before.wcdv-calendar-event--continues-after { border-radius: 0; }
    .wcdv-calendar-empty { padding: 14px; color: #64748b; font-size: 11px; text-align: center; }
  `;

  function openMonthWindow(allItems, options) {
    let popup;
    try {
      popup = window.open("", "wcdv-calendar-window", "popup=yes,width=920,height=680,resizable=yes,scrollbars=yes");
    } catch {
      return false;
    }
    if (!popup) return false;
    C.wcdvCalendarAnchorMs = Date.now();
    const doc = popup.document;
    doc.open();
    doc.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WebClass 締切カレンダー</title><style>${POPUP_STYLES}</style></head><body><main class="wcdv-popup-shell"><header class="wcdv-popup-head"><h1 class="wcdv-popup-title">締切カレンダー</h1><span id="wcdv-badge">（0）</span></header><div id="wcdv-root"><div id="wcdv-list" class="wcdv-wc-list"></div></div></main></body></html>`);
    doc.close();
    const root = doc.getElementById("wcdv-root");
    popup.focus();
    void loadWeekStartDay().then((weekStartDay) => {
      void render(root, allItems, { ...(options || {}), mode: "month", weekStartDay, focusToday: true });
    });
    return true;
  }

  globalThis.WCDV_CALENDAR_PANEL = Object.freeze({ configure, openMonthWindow, render });
})();
