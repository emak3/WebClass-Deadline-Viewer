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

  /** WebClass が再提出対象の行に表示する個別の締め切りを解析する。 */
  function parseResubmissionDeadline(text) {
    const m = String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .match(/締め切り\s*[:：]\s*(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
    if (!m) return null;
    const deadline = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0);
    return isNaN(deadline.getTime()) ? null : deadline.getTime();
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
        resubmissionText:
          (it.resubmissionText && String(it.resubmissionText).trim()) ||
          (prev.resubmissionText && String(prev.resubmissionText).trim()) ||
          "",
        resubmissionDeadlineMs:
          Number(it.resubmissionDeadlineMs) || Number(prev.resubmissionDeadlineMs) || null,
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

  function isVisitCountShortcutAnchor(a) {
    if (!a) return false;
    const t = a.textContent.replace(/\s+/g, " ").trim();
    const raw = (a.getAttribute("href") || "").trim();
    if (/利用回数/.test(t)) return true;
    if (/\/history(?:\?|\/|$)/i.test(raw)) return true;
    return false;
  }

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

  function extractResubmission(row) {
    const labels = row.querySelectorAll(".cm-contentsList_contentDetailListItemLabel");
    for (let i = 0; i < labels.length; i++) {
      const labelText = labels[i].textContent.replace(/\s+/g, " ").trim();
      if (!/再提出が必要/.test(labelText)) continue;
      const dataEl = labels[i].nextElementSibling;
      const deadlineText =
        dataEl && dataEl.classList.contains("cm-contentsList_contentDetailListItemData")
          ? dataEl.textContent.replace(/\s+/g, " ").trim()
          : "";
      return {
        text: [labelText, deadlineText].filter(Boolean).join("\n"),
        deadlineMs: parseResubmissionDeadline(deadlineText),
      };
    }
    return { text: "", deadlineMs: null };
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
      const resubmission = extractResubmission(row);
      const effectiveResubmissionDeadlineMs =
        resubmission.deadlineMs && resubmission.deadlineMs > parsed.endMs
          ? resubmission.deadlineMs
          : null;
      const effectiveEndMs = effectiveResubmissionDeadlineMs || parsed.endMs;

      out.push({
        folderTitle,
        titleText,
        href,
        hrefDetailColumn,
        category,
        wcNew: rowHasWcNewBadge(row),
        visitCountText,
        historyHref,
        resubmissionText: resubmission.text,
        resubmissionDeadlineMs: effectiveResubmissionDeadlineMs,
        startMs: parsed.startMs,
        endMs: effectiveEndMs,
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
