# Generates src/content/page-panel.js and src/content/main-panel.js from the monolith snapshot.
# Source: tools/reference-content-monolith.js (update that file before re-running).
# Run from repo root: python tools/split_content_script.py

from __future__ import annotations

import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "tools" / "reference-content-monolith.js"
OUT = ROOT / "src" / "content"

HEADER = """/* eslint-disable no-unused-vars -- shared content-script chunk */
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

"""

MAIN_HEADER = (
    HEADER
    + """  const _f = globalThis.WCDV_CONTENT_FNS;

"""
)

FOOTER = "\n})();\n"

FNS_FOOTER_PAGE = """
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
"""

REPLACEMENTS: list[tuple[str, str]] = [
    (r"\bLABEL_TEXT\b", "C.LABEL_TEXT"),
    (r"\bPERIOD_RE\b", "C.PERIOD_RE"),
    (r"\bORIGIN\b", "C.ORIGIN"),
    (r"\bWCDV_PENDING_ASSIGN_NAV_KEY\b", "C.WCDV_PENDING_ASSIGN_NAV_KEY"),
    (r"\bWCDV_LAST_LIST_PAGE_URL_KEY\b", "C.WCDV_LAST_LIST_PAGE_URL_KEY"),
    (r"\bWCDV_SUBMITTED_LIST_REFRESH_MS\b", "C.WCDV_SUBMITTED_LIST_REFRESH_MS"),
    (r"\bWCDV_DEADLINE_SOON_MS\b", "C.WCDV_DEADLINE_SOON_MS"),
    (r"\bwcdvStorageListenerAttached\b", "C.wcdvStorageListenerAttached"),
    (r"\bwcdvBulkRunningLocal\b", "C.wcdvBulkRunningLocal"),
    (r"\bwcdvAutoBulkStaleTimer\b", "C.wcdvAutoBulkStaleTimer"),
    (r"\bwcdvAutoBulkStaleAttempted\b", "C.wcdvAutoBulkStaleAttempted"),
    (r"\bwcdvBulkPort\b", "C.wcdvBulkPort"),
    (r"\bwcdvSubmittedListRefreshTimer\b", "C.wcdvSubmittedListRefreshTimer"),
    (r"\bsaveToastTimer\b", "C.saveToastTimer"),
]

# main-panel calls page-panel through _f (same extension, prior script in tab)
FNS_NAMES = [
    "extCtxOk",
    "flushChromeRuntimeLastError",
    "isWebclassPathPage",
    "isCourseListPage",
    "findParticipatingCoursesAnchor",
    "wirePanelCollapseButton",
    "syncWcdvToolbarPlacement",
    "syncWcdvFiltersPlacement",
    "findListMountHost",
    "mountListRootIntoPage",
    "unmountWcdvListPanelUi",
]


def transform_body(text: str) -> str:
    for pat, repl in REPLACEMENTS:
        text = re.sub(pat, repl, text)
    return text


def extract_lines(lines: list[str], start: int, end: int) -> str:
    """1-based inclusive line numbers."""
    return "".join(lines[start - 1 : end])


def strip_leading_indent(text: str, spaces: int = 2) -> str:
    out = []
    for ln in text.splitlines(True):
        if ln.startswith(" " * spaces):
            out.append(ln[spaces:])
        else:
            out.append(ln)
    return "".join(out)


def prefix_panel_calls(text: str) -> str:
    for name in FNS_NAMES:
        text = re.sub(rf"\b{re.escape(name)}\b", f"_f.{name}", text)
    return text


def main() -> None:
    raw = SRC.read_text(encoding="utf-8")
    lines = raw.splitlines(keepends=True)
    assert lines[0].strip() == "(function () {", lines[0]
    assert lines[-1].strip() == "})();", lines[-1]

    pp = extract_lines(lines, 33, 48) + extract_lines(lines, 70, 403)
    pp = transform_body(strip_leading_indent(pp))
    (OUT / "page-panel.js").write_text(HEADER + pp + FNS_FOOTER_PAGE + FOOTER, encoding="utf-8")

    listeners = extract_lines(lines, 49, 69)
    main = extract_lines(lines, 405, 2551)
    merged = listeners + main
    merged = transform_body(strip_leading_indent(merged))
    merged = re.sub(
        r"^\s*const\s+C\.WCDV_DEADLINE_SOON_MS\s*=\s*2\s*\*\s*3600000;\s*\n",
        "",
        merged,
        flags=re.MULTILINE,
    )
    merged = re.sub(r"^\s*let\s+C\.saveToastTimer\s*=\s*null;\s*\n", "", merged, flags=re.MULTILINE)
    merged = prefix_panel_calls(merged)
    merged = merged.replace(
        "    if (badge) badge.textContent = `（${items.length}）`;\n\n    if (list) {",
        "    if (badge) badge.textContent = `（${items.length}）`;\n\n    if (!list) {\n      return;\n    }\n    if (list) {",
    )
    merged = merged.replace(
        "    if (!list) {\n      return;\n    }\n    if (list) {\n      if (wcSkin) list.classList.add(\"list-group\");\n      else list.classList.remove(\"list-group\");\n    }\n\n    list.innerHTML = \"\";",
        "    if (!list) {\n      return;\n    }\n    if (wcSkin) list.classList.add(\"list-group\");\n    else list.classList.remove(\"list-group\");\n\n    list.innerHTML = \"\";",
    )
    (OUT / "main-panel.js").write_text(MAIN_HEADER + merged + FOOTER, encoding="utf-8")

    print("Wrote page-panel.js, main-panel.js")


if __name__ == "__main__":
    main()
