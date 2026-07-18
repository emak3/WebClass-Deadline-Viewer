(function () {
  "use strict";

  const C = globalThis.WCDV_CONTENT;
  const F = globalThis.WCDV_CONTENT_FNS;
  const bypass = new WeakSet();
  let allowNextUnload = false;
  let allowNextUnloadTimer = null;

  function resolveWebclassUrl(rawHref) {
    if (!rawHref) return false;
    try {
      const url = new URL(rawHref, location.href);
      if (url.origin !== location.origin) return false;
      if (!/\/webclass(\/|$)/i.test(url.pathname)) return false;
      return url;
    } catch {
      return false;
    }
  }

  function getNavigationAnchor(event) {
    if (!(event.target instanceof Element)) return null;
    const anchor = event.target.closest("a[href], area[href]");
    if (!anchor) return null;
    const url = resolveWebclassUrl(anchor.getAttribute("href"));
    return url && url.href !== location.href ? anchor : null;
  }

  function confirmNavigation() {
    return confirm(
      "課題の一括取得中です。\n\n" +
        "取得中に WebClass 内の別ページへ移動すると、WebClass の仕様によりログアウトする可能性があります。取得が完了してから移動してください。\n\n" +
        "それでも移動しますか？"
    );
  }

  function allowUnload() {
    allowNextUnload = true;
    if (allowNextUnloadTimer != null) clearTimeout(allowNextUnloadTimer);
    allowNextUnloadTimer = setTimeout(() => {
      allowNextUnload = false;
      allowNextUnloadTimer = null;
    }, 0);
  }

  function requestBulkState() {
    return new Promise((resolve) => {
      const runtime = globalThis.chrome && chrome.runtime;
      if (!F.extCtxOk() || !runtime || typeof runtime.sendMessage !== "function") {
        resolve(false);
        return;
      }
      try {
        runtime.sendMessage(
          { type: "wcdv-get-bulk-state", origin: C.ORIGIN },
          (response) => {
            F.flushChromeRuntimeLastError();
            const running = Boolean(response && response.running);
            C.wcdvBulkRunningForOrigin = running;
            resolve(running);
          }
        );
      } catch {
        resolve(false);
      }
    });
  }

  function install() {
    if (C.wcdvNavigationGuardAttached) return;
    C.wcdvNavigationGuardAttached = true;

    chrome.runtime.onMessage.addListener((message) => {
      if (!message || message.type !== "wcdv-bulk-state" || message.origin !== C.ORIGIN) return;
      C.wcdvBulkRunningForOrigin = Boolean(message.running);
    });
    void requestBulkState();

    window.addEventListener("click", (event) => {
      const anchor = getNavigationAnchor(event);
      if (!anchor) return;
      if (bypass.has(anchor)) {
        bypass.delete(anchor);
        return;
      }
      if (C.wcdvBulkRunningForOrigin === false) return;
      if (C.wcdvBulkRunningForOrigin === true) {
        if (confirmNavigation()) {
          allowUnload();
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      void requestBulkState().then((running) => {
        if (running && !confirmNavigation()) return;
        if (!anchor.isConnected) return;
        if (running) allowUnload();
        bypass.add(anchor);
        anchor.click();
      });
    }, true);

    window.addEventListener("submit", (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      if (!resolveWebclassUrl(form.getAttribute("action") || location.href)) return;
      if (bypass.has(form)) {
        bypass.delete(form);
        return;
      }
      if (C.wcdvBulkRunningForOrigin === false) return;
      if (C.wcdvBulkRunningForOrigin === true) {
        if (confirmNavigation()) {
          allowUnload();
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      const submitter = event.submitter;
      void requestBulkState().then((running) => {
        if (running && !confirmNavigation()) return;
        if (!form.isConnected) return;
        if (running) allowUnload();
        bypass.add(form);
        try {
          form.requestSubmit(submitter || undefined);
        } catch {
          form.submit();
        }
      });
    }, true);

    window.addEventListener("beforeunload", (event) => {
      if (C.wcdvBulkRunningForOrigin !== true || allowNextUnload) return;
      event.preventDefault();
      event.returnValue = "";
    });
  }

  globalThis.WCDV_NAVIGATION_GUARD = Object.freeze({ install });
})();
