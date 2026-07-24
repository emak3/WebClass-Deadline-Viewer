(function () {
  "use strict";

  const {
    STORAGE_KEY,
    STORAGE_ENABLED,
    STORAGE_ORIGINS,
    STORAGE_AUTO_BULK_HOURS,
    STORAGE_AUTO_BULK_ENABLED,
    STORAGE_COURSE_SETTINGS,
    STORAGE_EXCLUDE_NO_PERIOD_DEFAULT,
    STORAGE_WEEK_START_DAY,
  } =
    globalThis.WCDV_SHARED;

  const toggle = document.getElementById("toggleEnabled");
  const toggleAutoBulk = document.getElementById("toggleAutoBulk");
  const autoBulkHours = document.getElementById("autoBulkHours");
  const originInput = document.getElementById("originInput");
  const addOriginBtn = document.getElementById("addOriginBtn");
  const siteListEl = document.getElementById("siteList");
  const statusEl = document.getElementById("optionsStatus");
  const courseSettings = document.getElementById("courseSettings");
  const courseSettingsPanel = document.getElementById("courseSettingsPanel");
  const courseSettingsToggle = document.getElementById("courseSettingsToggle");
  const defaultExcludeNoPeriod = document.getElementById("defaultExcludeNoPeriod");
  const weekStartDay = document.getElementById("weekStartDay");
  const calendarSettingsText = document.getElementById("calendarSettingsText");
  const calendarSettingsStatus = document.getElementById("calendarSettingsStatus");
  const exportCalendarSettings = document.getElementById("exportCalendarSettings");
  const importCalendarSettings = document.getElementById("importCalendarSettings");
  let emptyOriginsPromptShown = false;
  const REMOVE_SVG =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M18 6L6 18M6 6l12 12"/></svg>';

  function storageGet(keys, cb) {
    chrome.storage.local.get(keys, cb);
  }

  function storageSet(obj, cb) {
    chrome.storage.local.set(obj, cb || function () {});
  }

  function canonicalCourseStorageKey(url) {
    try {
      const u = new URL(String(url));
      const m = u.pathname.match(/\/webclass\/course\.php\/([^/?#]+)/i);
      return m ? `${u.origin}/webclass/course.php/${m[1]}/` : String(url).split("#")[0].split("?")[0].trim();
    } catch {
      return String(url || "").trim();
    }
  }

  function deterministicCourseColor(key) {
    const palette = [
      "#4a6fa5", "#2f7d6d", "#8a5a9f", "#b05a47", "#5f7f3c",
      "#3e7f9d", "#9a6a2f", "#765a9f", "#487a55", "#a44f72",
    ];
    const source = String(key || "course");
    let hash = 0;
    for (let i = 0; i < source.length; i++) hash = (Math.imul(hash, 31) + source.charCodeAt(i)) | 0;
    return palette[Math.abs(hash) % palette.length];
  }

  function saveCourseSetting(origin, key, next) {
    storageGet([STORAGE_COURSE_SETTINGS], (result) => {
      const source = result[STORAGE_COURSE_SETTINGS];
      const all = source && typeof source === "object" ? { ...source } : {};
      const site = all[origin] && typeof all[origin] === "object" ? { ...all[origin] } : {};
      const setting = {
        name: String(next.name || "").trim(),
        color: /^#[0-9a-f]{6}$/i.test(next.color || "") ? next.color : "",
        hidden: next.hidden === true,
      };
      if (!setting.name && !setting.color && !setting.hidden) delete site[key];
      else site[key] = setting;
      all[origin] = site;
      storageSet({ [STORAGE_COURSE_SETTINGS]: all });
    });
  }

  function renderCourseSettings(deadlineRoot, settingRoot) {
    if (!courseSettings) return;
    courseSettings.innerHTML = "";
    const courses = [];
    Object.keys(deadlineRoot || {}).sort().forEach((origin) => {
      const byCourse = deadlineRoot[origin] && deadlineRoot[origin].byCourse;
      if (!byCourse || typeof byCourse !== "object") return;
      Object.keys(byCourse).forEach((rawKey) => {
        const course = byCourse[rawKey];
        if (!course) return;
        courses.push({
          origin,
          key: canonicalCourseStorageKey(course.coursePageUrl || rawKey),
          title: course.courseTitle || "コース",
        });
      });
    });
    courses.sort((a, b) => a.title.localeCompare(b.title, "ja"));
    if (!courses.length) {
      const empty = document.createElement("p");
      empty.className = "calendar-settings__empty";
      empty.textContent = "保存済みの教科はありません。一括取得後に設定できます。";
      courseSettings.appendChild(empty);
      return;
    }
    courses.forEach(({ origin, key, title }) => {
      const saved = settingRoot && settingRoot[origin] && settingRoot[origin][key]
        ? settingRoot[origin][key]
        : {};
      const row = document.createElement("div");
      row.className = "course-setting-row";
      const original = document.createElement("span");
      original.className = "course-setting-row__original";
      original.textContent = title;
      const name = document.createElement("input");
      name.type = "text";
      name.className = "course-setting-row__name";
      name.value = saved.name || "";
      name.placeholder = title;
      name.setAttribute("aria-label", `${title}の表示名`);
      const color = document.createElement("input");
      color.type = "color";
      color.className = "course-setting-row__color";
      color.value = /^#[0-9a-f]{6}$/i.test(saved.color || "")
        ? saved.color
        : deterministicCourseColor(key);
      let explicitColor = /^#[0-9a-f]{6}$/i.test(saved.color || "") ? saved.color : "";
      color.setAttribute("aria-label", `${title}の色`);
      const hiddenLabel = document.createElement("label");
      hiddenLabel.className = "course-setting-row__hidden";
      const hidden = document.createElement("input");
      hidden.type = "checkbox";
      hidden.checked = saved.hidden === true;
      const hiddenText = document.createElement("span");
      hiddenText.textContent = "非表示";
      hiddenLabel.append(hidden, hiddenText);
      const save = () => saveCourseSetting(origin, key, {
        name: name.value,
        color: explicitColor,
        hidden: hidden.checked,
      });
      name.addEventListener("change", save);
      color.addEventListener("change", () => {
        explicitColor = color.value;
        save();
      });
      hidden.addEventListener("change", save);
      row.append(original, name, color, hiddenLabel);
      courseSettings.appendChild(row);
    });
  }

  function loadCalendarSettings() {
    storageGet([STORAGE_KEY, STORAGE_COURSE_SETTINGS], (result) => {
      renderCourseSettings(result[STORAGE_KEY] || {}, result[STORAGE_COURSE_SETTINGS] || {});
    });
  }

  function setCalendarSettingsStatus(message, isError) {
    if (!calendarSettingsStatus) return;
    calendarSettingsStatus.textContent = message || "";
    calendarSettingsStatus.classList.toggle("settings-transfer__status--error", isError === true);
  }

  function exportCalendarSettingsFlow() {
    storageGet(
      [STORAGE_COURSE_SETTINGS, STORAGE_EXCLUDE_NO_PERIOD_DEFAULT, STORAGE_WEEK_START_DAY],
      (result) => {
        const payload = {
          version: 1,
          courseSettings: result[STORAGE_COURSE_SETTINGS] || {},
          excludeNoPeriodDefault: result[STORAGE_EXCLUDE_NO_PERIOD_DEFAULT] !== false,
          weekStartDay: Number.isInteger(Number(result[STORAGE_WEEK_START_DAY]))
            ? Number(result[STORAGE_WEEK_START_DAY])
            : 0,
        };
        calendarSettingsText.value = JSON.stringify(payload, null, 2);
        calendarSettingsText.focus();
        calendarSettingsText.select();
        setCalendarSettingsStatus("設定テキストを作成しました。コピーして保存してください。", false);
      }
    );
  }

  function importCalendarSettingsFlow() {
    let parsed;
    try {
      parsed = JSON.parse(calendarSettingsText.value);
    } catch {
      setCalendarSettingsStatus("設定テキストを読み取れません。JSON形式を確認してください。", true);
      return;
    }
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1) {
      setCalendarSettingsStatus("対応していない設定テキストです。", true);
      return;
    }
    const courseData = parsed.courseSettings && typeof parsed.courseSettings === "object"
      ? parsed.courseSettings
      : {};
    const importedWeekStart = Number(parsed.weekStartDay);
    const safeWeekStart = Number.isInteger(importedWeekStart) && importedWeekStart >= 0 && importedWeekStart <= 6
      ? importedWeekStart
      : 0;
    storageSet({
      [STORAGE_COURSE_SETTINGS]: courseData,
      [STORAGE_EXCLUDE_NO_PERIOD_DEFAULT]: parsed.excludeNoPeriodDefault !== false,
      [STORAGE_WEEK_START_DAY]: safeWeekStart,
    }, () => {
      defaultExcludeNoPeriod.checked = parsed.excludeNoPeriodDefault !== false;
      weekStartDay.value = String(safeWeekStart);
      loadCalendarSettings();
      setCalendarSettingsStatus("設定をインポートしました。WebClassの画面にも反映されます。", false);
    });
  }

  function normalizeOriginFromString(raw) {
    let s = (raw || "").trim();
    if (!s) return { error: "URL を入力してください。" };
    if (!/^https?:\/\//i.test(s)) {
      s = "https://" + s;
    }
    let u;
    try {
      u = new URL(s);
    } catch {
      return { error: "URL の形式が正しくありません。" };
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { error: "http または https のみ対応しています。" };
    }
    if (!u.hostname) {
      return { error: "ホスト名を含む URL を入力してください。" };
    }
    return { origin: u.origin };
  }

  function setStatus(msg) {
    statusEl.textContent = msg || "";
  }

  function setupContactLink() {
    const link = document.querySelector(".contact-link");
    if (!link) return;
    const product = "WebClass Deadline Viewer";
    const subject = "【Extension Support】" + product;
    const body = [
      "拡張機能名：" + product,
      "ブラウザ（Chrome / Edge）とバージョン：",
      "",
      "お問い合わせ内容：",
      "",
      "問題が発生した画面と操作内容(再現手順等)：",
      "",
      "表示されたエラー内容：",
      "",
      "※パスワード、Cookie、課題ファイルなどの機密情報は記載しないでください。"
    ].join("\n");
    link.href = "mailto:contact.ext@ouma3.org?subject=" + encodeURIComponent(subject) +
      "&body=" + encodeURIComponent(body);
  }

  function renderOrigins(origins) {
    siteListEl.innerHTML = "";
    if (!origins.length) {
      const p = document.createElement("p");
      p.className = "wc-sitelist__empty";
      p.textContent =
        "登録済みのサイトはありません。WebClass のベース URL（スキームとホスト名まで。例: https://lms.example.ac.jp）を追加し、ブラウザの許可ダイアログで承認してください。";
      siteListEl.appendChild(p);
      return;
    }
    origins.forEach((origin) => {
      const row = document.createElement("div");
      row.className = "wc-site";
      const url = document.createElement("span");
      url.className = "wc-site__url";
      url.textContent = origin;
      row.appendChild(url);
      chrome.permissions.contains({ origins: [origin + "/*"] }, (ok) => {
        if (!ok) {
          const w = document.createElement("span");
          w.className = "wc-site__warn";
          w.textContent = "未許可";
          row.appendChild(w);
          const grant = document.createElement("button");
          grant.type = "button";
          grant.className = "wc-btn wc-btn--primary";
          grant.textContent = "許可";
          grant.addEventListener("click", () => {
            chrome.permissions.request({ origins: [origin + "/*"] }, (granted) => {
              if (granted) {
                setStatus("許可しました。WebClass を再読み込みしてください。");
                loadOrigins();
              } else {
                setStatus("許可されませんでした。");
              }
            });
          });
          row.appendChild(grant);
        }
      });
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "site-remove";
      rm.title = "削除";
      rm.setAttribute("aria-label", origin + " を削除");
      rm.innerHTML = REMOVE_SVG;
      rm.addEventListener("click", () => {
        removeOrigin(origin);
      });
      row.appendChild(rm);
      siteListEl.appendChild(row);
    });
  }

  function loadOrigins() {
    storageGet([STORAGE_ORIGINS], (r) => {
      const origins = r[STORAGE_ORIGINS] || [];
      renderOrigins(origins);
      if (origins.length > 0) {
        emptyOriginsPromptShown = false;
        return;
      }
      if (emptyOriginsPromptShown) {
        return;
      }
      emptyOriginsPromptShown = true;
      setTimeout(() => {
        try {
          alert(
            "許可するサイト（オリジン）が未登録です。\n\n" +
              "入力欄に大学の WebClass のベース URL（https:// からホスト名まで。例: https://lms.example.ac.jp）を入力し、「追加」を選択したうえで、ブラウザの許可ダイアログで承認してください。"
          );
        } catch {
          /* ignore */
        }
        if (originInput) {
          try {
            originInput.focus();
            originInput.select();
          } catch {
            /* ignore */
          }
        }
      }, 0);
    });
  }

  function addOriginFlow(origin) {
    setStatus("");
    chrome.permissions.request({ origins: [origin + "/*"] }, (granted) => {
      if (!granted) {
        setStatus("ブラウザのダイアログで許可されませんでした。");
        return;
      }
      storageGet([STORAGE_ORIGINS], (r) => {
        const list = (r[STORAGE_ORIGINS] || []).slice();
        if (list.indexOf(origin) >= 0) {
          setStatus("すでにリストにあります。");
          return;
        }
        list.push(origin);
        storageSet({ [STORAGE_ORIGINS]: list }, () => {
          loadOrigins();
          setStatus("追加しました。WebClass のタブを再読み込みしてください。");
          originInput.value = "";
        });
      });
    });
  }

  function removeOrigin(origin) {
    setStatus("");
    chrome.permissions.remove({ origins: [origin + "/*"] }, () => {
      storageGet([STORAGE_ORIGINS], (r) => {
        const list = (r[STORAGE_ORIGINS] || []).filter((o) => o !== origin);
        storageSet({ [STORAGE_ORIGINS]: list }, () => {
          loadOrigins();
          setStatus("削除しました。");
        });
      });
    });
  }

  function syncAutoBulkHoursDisabled() {
    const on = toggleAutoBulk.checked;
    autoBulkHours.disabled = !on;
    autoBulkHours.setAttribute("aria-disabled", on ? "false" : "true");
  }

  storageGet([STORAGE_ENABLED, STORAGE_AUTO_BULK_HOURS, STORAGE_AUTO_BULK_ENABLED], (r) => {
    toggle.checked = r[STORAGE_ENABLED] !== false;
    toggleAutoBulk.checked = r[STORAGE_AUTO_BULK_ENABLED] !== false;
    let h = r[STORAGE_AUTO_BULK_HOURS];
    if (typeof h !== "number" || !Number.isFinite(h)) h = 6;
    h = Math.floor(h);
    if (h < 1) h = 1;
    if (h > 720) h = 720;
    autoBulkHours.value = String(h);
    syncAutoBulkHoursDisabled();
  });
  setupContactLink();
  loadOrigins();
  loadCalendarSettings();

  storageGet([STORAGE_EXCLUDE_NO_PERIOD_DEFAULT, STORAGE_WEEK_START_DAY], (result) => {
    defaultExcludeNoPeriod.checked = result[STORAGE_EXCLUDE_NO_PERIOD_DEFAULT] !== false;
    const savedWeekStart = Number(result[STORAGE_WEEK_START_DAY]);
    weekStartDay.value = String(
      Number.isInteger(savedWeekStart) && savedWeekStart >= 0 && savedWeekStart <= 6
        ? savedWeekStart
        : 0
    );
  });
  defaultExcludeNoPeriod.addEventListener("change", () => {
    storageSet({ [STORAGE_EXCLUDE_NO_PERIOD_DEFAULT]: defaultExcludeNoPeriod.checked });
  });
  weekStartDay.addEventListener("change", () => {
    const value = Number(weekStartDay.value);
    storageSet({
      [STORAGE_WEEK_START_DAY]: Number.isInteger(value) && value >= 0 && value <= 6 ? value : 0,
    });
  });
  courseSettingsToggle.addEventListener("click", () => {
    const expanded = courseSettingsToggle.getAttribute("aria-expanded") === "true";
    courseSettingsToggle.setAttribute("aria-expanded", expanded ? "false" : "true");
    courseSettingsToggle.title = expanded ? "教科設定を展開する" : "教科設定を折りたたむ";
    courseSettingsToggle.setAttribute("aria-label", expanded ? "教科名・色・表示を開く" : "教科名・色・表示を閉じる");
    courseSettingsPanel.hidden = expanded;
  });
  exportCalendarSettings.addEventListener("click", exportCalendarSettingsFlow);
  importCalendarSettings.addEventListener("click", importCalendarSettingsFlow);

  toggle.addEventListener("change", () => {
    storageSet({ [STORAGE_ENABLED]: toggle.checked });
  });

  toggleAutoBulk.addEventListener("change", () => {
    storageSet({ [STORAGE_AUTO_BULK_ENABLED]: toggleAutoBulk.checked });
    syncAutoBulkHoursDisabled();
  });

  function saveAutoBulkHoursFromInput() {
    if (autoBulkHours.disabled) return;
    let h = parseInt(autoBulkHours.value, 10);
    if (!Number.isFinite(h)) h = 6;
    h = Math.floor(h);
    if (h < 1) h = 1;
    if (h > 720) h = 720;
    autoBulkHours.value = String(h);
    storageSet({ [STORAGE_AUTO_BULK_HOURS]: h }, () => {
      setStatus(`自動一括取得のしきい値を ${h} 時間に保存しました。一覧タブを開き直すと反映されます。`);
    });
  }

  autoBulkHours.addEventListener("change", saveAutoBulkHoursFromInput);

  addOriginBtn.addEventListener("click", () => {
    const parsed = normalizeOriginFromString(originInput.value);
    if (parsed.error) {
      setStatus(parsed.error);
      return;
    }
    addOriginFlow(parsed.origin);
  });

  originInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addOriginBtn.click();
    }
  });
})();
