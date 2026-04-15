(function () {
  "use strict";

  const { STORAGE_ENABLED, STORAGE_ORIGINS, STORAGE_AUTO_BULK_HOURS, STORAGE_AUTO_BULK_ENABLED } =
    globalThis.WCDV_SHARED;

  const toggle = document.getElementById("toggleEnabled");
  const toggleAutoBulk = document.getElementById("toggleAutoBulk");
  const autoBulkHours = document.getElementById("autoBulkHours");
  const originInput = document.getElementById("originInput");
  const addOriginBtn = document.getElementById("addOriginBtn");
  const siteListEl = document.getElementById("siteList");
  const statusEl = document.getElementById("optionsStatus");

  function storageGet(keys, cb) {
    chrome.storage.local.get(keys, cb);
  }

  function storageSet(obj, cb) {
    chrome.storage.local.set(obj, cb || function () {});
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

  function renderOrigins(origins) {
    siteListEl.innerHTML = "";
    if (!origins.length) {
      const p = document.createElement("p");
      p.className = "wc-sitelist__empty";
      p.textContent =
        "まだサイトがありません。WebClass の URL の https://〜ホスト 部分を追加し、ブラウザで許可してください。";
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
      rm.className = "wc-btn wc-btn--ghost";
      rm.textContent = "削除";
      rm.addEventListener("click", () => {
        removeOrigin(origin);
      });
      row.appendChild(rm);
      siteListEl.appendChild(row);
    });
  }

  function loadOrigins() {
    storageGet([STORAGE_ORIGINS], (r) => {
      renderOrigins(r[STORAGE_ORIGINS] || []);
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
  loadOrigins();

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
