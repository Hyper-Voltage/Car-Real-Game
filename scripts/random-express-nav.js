(() => {
  "use strict";
  const kidsPage = document.querySelector('meta[name="rex-kids-page"]') !== null;
  // Pages with only the shared header also get in-game sharing. Refresh a cached older analytics client once.
  if (!kidsPage && !/^\/(admin|api|account)(\/|$)/.test(location.pathname)) {
    const loadSharing = () => {
      if (window.RandomExpressSharing || document.querySelector("script[data-rex-sharing-loader]")) return;
      const script = document.createElement("script");
      script.src = "/assets/random-express-analytics.js?v=20261102-ingame1";
      script.dataset.rexSharingLoader = "true";
      document.head.append(script);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", loadSharing, {once: true});
    else loadSharing();
  }
  const activityVersion='20261124-wishbone1';
  const loadActivity=()=>window.__rexActivityPromise ||= import('/assets/random-express-activity.mjs?v='+activityVersion).catch(error=>{window.__rexActivityPromise=null;throw error;});
  if(!kidsPage&&!/^\/(admin|api|account)(\/|$)/.test(location.pathname)){window.__rexActivityLoading=true;const load=()=>loadActivity().catch(()=>{});if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',load,{once:true});else load();}


  let accountPromise = null;
  const loadAccount = () => {
    if (window.RandomExpressAccount) return Promise.resolve(window.RandomExpressAccount);
    const version = document.querySelector('meta[name="rex-kids-save-project"]') ? '20261118-kidsacct1' : '20261118-acct1';
    return accountPromise ||= import('/assets/random-express-account.js?v=' + version)
      .then(() => {
        if (!window.RandomExpressAccount) throw new Error('Account client did not initialize.');
        return window.RandomExpressAccount;
      })
      .catch(error => { accountPromise = null; throw error; });
  };

  // Bug reports attach the page's recent errors and warnings. Capture has to stay cheap on every page:
  // a short ring of trimmed strings, a per-second cap, and objects summarized instead of serialized.
  const BUG_LOG_LIMIT = 150;
  const BUG_LOG_PER_SECOND = 20;
  const bugLog = window.__rexBugLog ||= { entries: [], dropped: 0, second: -1, count: 0, installed: false };
  const brief = (value, depth = 0) => {
    if (typeof value === "string") return value;
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return String(value);
    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
    if (typeof value === "function") return `[function ${value.name || "anonymous"}]`;
    if (typeof Element !== "undefined" && value instanceof Element) return `<${value.localName}${value.id ? "#" + value.id : ""}>`;
    if (depth > 1) return Array.isArray(value) ? `[${value.length} items]` : "{...}";
    try {
      if (Array.isArray(value)) return `[${value.slice(0, 8).map((item) => brief(item, depth + 1)).join(", ")}${value.length > 8 ? ", ..." : ""}]`;
      const keys = Object.keys(value);
      return `{${keys.slice(0, 8).map((key) => `${key}: ${brief(value[key], depth + 1)}`).join(", ")}${keys.length > 8 ? ", ..." : ""}}`;
    } catch {
      return Object.prototype.toString.call(value);
    }
  };
  const bugRecord = (level, parts) => {
    const now = performance.now();
    const second = Math.floor(now / 1000);
    if (second !== bugLog.second) { bugLog.second = second; bugLog.count = 0; }
    if (++bugLog.count > BUG_LOG_PER_SECOND) { bugLog.dropped++; return; }
    let text = "";
    for (const part of parts) {
      text += (text ? " " : "") + brief(part);
      if (text.length > 1000) break;
    }
    bugLog.entries.push({ t: Math.round(now), level, text: text.slice(0, 1000) });
    if (bugLog.entries.length > BUG_LOG_LIMIT) bugLog.entries.shift();
  };
  if (!bugLog.installed) {
    bugLog.installed = true;
    for (const level of ["error", "warn"]) {
      const original = console[level];
      if (typeof original !== "function") continue;
      console[level] = function (...parts) {
        try { bugRecord(level, parts); } catch {}
        return original.apply(this, parts);
      };
    }
    window.addEventListener("error", (event) => {
      const target = event.target;
      if (target && target !== window && target.localName) bugRecord("error", [`Failed to load <${target.localName}> ${target.currentSrc || target.src || target.href || ""}`]);
      else bugRecord("error", [event.error || event.message, event.filename ? `(${event.filename.replace(location.origin, "")}:${event.lineno}:${event.colno})` : ""]);
    }, true);
    window.addEventListener("unhandledrejection", (event) => bugRecord("error", ["Unhandled promise rejection:", event.reason]));
    // Registered before experience scripts, so even capture-phase game controls never see typing in the bug form.
    for (const type of ["keydown", "keyup", "keypress"]) {
      window.addEventListener(type, (event) => {
        if (event.target?.localName === "random-express-bug-report" || event.target?.localName === "random-express-feedback") event.stopImmediatePropagation();
      }, true);
    }
  }
  const loadFeedback = () => window.__rexFeedbackPromise ||= import("/assets/random-express-feedback-boot.mjs?v=20261124-rating-tags")
    .catch((error) => { window.__rexFeedbackPromise = null; throw error; });
  const loadBugReport = () => window.__rexBugReportPromise ||= import("/assets/random-express-bug-report.mjs?v=20261123-follow")
    .catch((error) => { window.__rexBugReportPromise = null; throw error; });
  // Experiences can add their own log lines, or open the form from their own UI.
  window.RandomExpressBugReport ||= Object.freeze({
    log: (...parts) => bugRecord("info", parts),
    open: (options = {}) => loadBugReport().then((module) => module.openBugReport({ project: document.querySelector("random-express-nav")?.getAttribute("current") || "site", ...options })),
  });

  // Game health: uncaught errors, failed same-site loads and stalled starts are sent to /api/health.php for the
  // admin Health page. Issues are grouped per page view, so an error thrown every frame costs one Map lookup.
  const HEALTH_BOOT_MS = 15000;
  const HEALTH_MAX_ISSUES = 15;
  const HEALTH_MAX_BODY = 16384;
  // Usually three five-event requests; byte-heavy reports may need one request per issue.
  const HEALTH_MAX_BEACONS = HEALTH_MAX_ISSUES;
  const health = window.__rexHealth ||= { issues: new Map(), queue: [], beacons: 0, timer: 0, interacted: false, ready: false, stalled: false, installed: false, start: performance.now() };
  const healthEnabled = (() => {
    if (kidsPage) return false;
    if (/(?:^|;\s*)rx_no_analytics=1(?:;|$)/.test(document.cookie)) return false;
    try { if (localStorage.getItem("rex:health-debug") === "1") return true; } catch {}
    const host = location.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost") || /^\/(admin|api)(\/|$)/.test(location.pathname)) return false;
    return !navigator.webdriver && !/bot|crawler|spider|slurp|headless|phantom|selenium|playwright|puppeteer|lighthouse/i.test(navigator.userAgent);
  })();
  const healthPath = (value) => String(value || "").split(location.origin).join("");
  const healthFlush = (drain = false) => {
    clearTimeout(health.timer); health.timer = 0;
    if (!health.queue.length || health.beacons >= HEALTH_MAX_BEACONS) return;
    const project = (document.querySelector("random-express-nav")?.getAttribute("current") || location.pathname.split("/")[1] || "site").slice(0, 80);
    const envelope = { project, url: location.pathname.slice(0, 200), viewport: [innerWidth, innerHeight] };
    const events = [];
    let payload = "";
    while (health.queue.length && events.length < 5) {
      const { key, ...event } = health.queue[0];
      const candidate = JSON.stringify({ ...envelope, events: [...events, event] });
      // Blob measures encoded UTF-8, including JSON escapes, before the event leaves the queue.
      if (new Blob([candidate]).size > HEALTH_MAX_BODY) break;
      events.push(event); health.queue.shift(); payload = candidate;
    }
    if (!events.length) return;
    health.beacons++;
    try {
      if (!navigator.sendBeacon?.("/api/health.php", new Blob([payload], { type: "application/json" }))) {
        fetch("/api/health.php", { method: "POST", credentials: "same-origin", keepalive: true, headers: { "Content-Type": "application/json" }, body: payload }).catch(() => {});
      }
    } catch {}
    if (health.queue.length) {
      if (drain && health.beacons < HEALTH_MAX_BEACONS) healthFlush(true);
      else health.timer = setTimeout(healthFlush, 1500);
    }
  };
  const healthNote = (kind, message, source = "", line = 0, column = 0, stack = "", resourceResponse = null) => {
    if (!healthEnabled) return;
    message = String(message || "");
    source = healthPath(source).slice(0, 300);
    const key = `${kind}|${message.slice(0, 160)}|${source}|${line}`;
    const known = health.issues.get(key);
    if (known) { known.count++; return known; }
    if (health.issues.size >= HEALTH_MAX_ISSUES) return;
    const event = { key, kind, message: message.slice(0, 400), source, line, column, stack: healthPath(stack).slice(0, 1500), boot: !health.interacted && performance.now() - health.start < HEALTH_BOOT_MS, count: 1 };
    if (resourceResponse) event.resourceResponse = resourceResponse;
    event.context = { online: navigator.onLine !== false, visibility: document.visibilityState,
      ready: health.ready, interacted: health.interacted, pageAgeMs: Math.round(performance.now() - health.start) };
    health.issues.set(key, event);
    health.queue.push(event);
    health.timer ||= setTimeout(healthFlush, 1500);
    return event;
  };
  // Experiences that put <meta name="rex-health-ready" content="15"> in their page call RandomExpressHealth.ready()
  // once playable. If that never happens within those seconds of visible time, the page counts as a stalled start.
  const healthWatchReady = (seconds) => {
    if (!healthEnabled || health.ready || health.watching || !(seconds > 0)) return;
    health.watching = true;
    let visible = 0;
    const tick = setInterval(() => {
      if (health.ready) { clearInterval(tick); return; }
      if (document.visibilityState === "visible") visible++;
      if (visible < seconds) return;
      clearInterval(tick);
      health.stalled = true;
      const recent = bugLog.entries.filter((entry) => entry.level === "error").slice(-3).map((entry) => entry.text).join("\n");
      healthNote("stall", `Not ready after ${seconds}s of visible time`, "", 0, 0, recent);
      healthFlush();
    }, 1000);
  };
  if (!health.installed) {
    health.installed = true;
    const sameSiteSeen = new Map();
    const sameSite = (url) => {
      let same = sameSiteSeen.get(url);
      if (same === undefined) {
        try { same = new URL(url, location.href).origin === location.origin; } catch { same = false; }
        if (sameSiteSeen.size < 100) sameSiteSeen.set(url, same);
      }
      return same;
    };
    // A same-site image that fails once is nearly always a dropped connection or an interrupted lazy load, so it
    // gets one more try (after the connection is back) and is reported only if that fails too. WebP in a browser
    // that cannot decode it (Safari before macOS 11) is a browser limit, not a site fault, so it is not reported.
    const imageRetried = new WeakSet(), stylesheetRetried = new WeakSet();
    let webpDecodes = null;
    const decodesWebp = () => webpDecodes ||= new Promise((resolve) => {
      const probe = new Image();
      probe.onload = () => resolve(probe.width === 1);
      probe.onerror = () => resolve(false);
      probe.src = "data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";
    });
    const retryImage = (image) => {
      imageRetried.add(image);
      const reload = () => setTimeout(() => {
        for (const name of ["srcset", "src"]) if (image.hasAttribute(name)) image.setAttribute(name, image.getAttribute(name));
      }, 1500);
      if (navigator.onLine === false) window.addEventListener("online", reload, { once: true });
      else reload();
    };
    // Keep only a cache version, never arbitrary query data, credentials or fragments.
    const resourcePath = (value) => {
      try {
        const url = new URL(value, location.href);
        if (url.origin !== location.origin) return "";
        const version = url.searchParams.get("v");
        return url.pathname.slice(0, 180) + (version && /^[a-z0-9_.-]{1,60}$/i.test(version) ? "?v=" + version : "");
      } catch { return ""; }
    };
    const resourceDiagnostics = (url, target) => {
      const failures = (performance.getEntriesByType?.("resource") || []).filter(entry =>
        (entry.responseStatus === 0 || entry.responseStatus >= 400)
        && resourcePath(entry.name)).slice(-3).map(entry => ({path: resourcePath(entry.name), status: entry.responseStatus}));
      return { request: resourcePath(url), scriptType: target.localName === "script" ? (target.type === "module" ? "module" : "classic") : "",
        failedResources: failures };
    };
    const readResourceResponse = (url) => {
      // Look up the original request (including its cache version). The report still strips query strings.
      const entries = performance.getEntriesByName?.(new URL(url, location.href).href.split("#")[0], "resource");
      const entry = entries?.[entries.length - 1];
      if (!entry) return null;
      const response = {};
      if (entry.responseStatus > 0) response.status = entry.responseStatus;
      if (entry.contentType) response.contentType = entry.contentType.split(";")[0].trim().slice(0, 100);
      return Object.keys(response).length ? response : null;
    };
    // Only these reviewed entry modules can prevent their experience from starting. Optional shared scripts
    // and runtime exceptions must never trigger a page reload. A new document also clears a failed module graph.
    const startupEntries = new Set([
      "/traffic-light-simulator/js/app.js", "/fish-tank/js/app.js", "/pressure-washing-simulator/js/main.js",
      "/peg-drop/js/app.mjs", "/loader-simulator/js/app.mjs", "/halloween-yard-decorator/js/app.js"
    ]);
    let startupFailure = false;
    const recoverStartup = (target, url) => {
      if (startupFailure || target.localName !== "script" || target.type !== "module") return;
      const path = new URL(url, location.href).pathname;
      const route = "/" + path.split("/")[1] + "/";
      if (!startupEntries.has(path) || ![route, route.slice(0, -1)].includes(location.pathname)) return;
      startupFailure = true;
      const show = () => {
        if (!document.body) { document.addEventListener("DOMContentLoaded", show, {once: true}); return; }
        const panel = document.createElement("section");
        panel.id = "rex-startup-failure"; panel.setAttribute("role", "alertdialog");
        panel.setAttribute("aria-modal", "true"); panel.setAttribute("aria-labelledby", "rex-startup-failure-title");
        panel.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:safe center;gap:16px;padding:24px;box-sizing:border-box;background:#11232b;color:#fff;font:16px/1.5 system-ui;text-align:center;overflow:auto";
        const title = document.createElement("h1"); title.id = "rex-startup-failure-title"; title.textContent = "This page couldn't finish loading";
        title.style.cssText = "font-size:28px;line-height:1.2;max-width:30ch;margin:0";
        const text = document.createElement("p"); text.textContent = "Check your connection, then try again."; text.style.cssText = "max-width:40ch;margin:0";
        const retry = document.createElement("button"); retry.type = "button"; retry.textContent = "Try again";
        retry.addEventListener("click", () => { healthFlush(true); location.reload(); });
        const browse = document.createElement("a"); browse.href = "/"; browse.textContent = "Browse experiences";
        for (const action of [retry, browse]) action.style.cssText = "display:inline-flex;align-items:center;justify-content:center;min-height:48px;width:220px;max-width:100%;box-sizing:border-box;flex-shrink:0;padding:10px 16px;border:1px solid #acd9d2;border-radius:8px;background:#244b4b;color:#fff;font:600 16px system-ui;text-decoration:none;cursor:pointer";
        panel.append(title, text, retry, browse); document.body.append(panel);
        // Keep keyboard focus on the recovery actions while the unusable experience is covered.
        panel.addEventListener("keydown", event => {
          if (event.key !== "Tab") return;
          if (event.shiftKey && document.activeElement === retry) { event.preventDefault(); browse.focus(); }
          else if (!event.shiftKey && document.activeElement === browse) { event.preventDefault(); retry.focus(); }
        });
        retry.focus({preventScroll:true});
      };
      show();
      // Storage denial falls back to the explicit button. Measure the limit at the actual reload,
      // so a long wait offline/in the background cannot age out the limit before the first attempt.
      if (health.interacted || health.ready) return;
      let retryTimer = 0;
      const stopWaiting = () => {
        document.removeEventListener("visibilitychange", retryWhenVisible);
        window.removeEventListener("online", retryWhenVisible);
      };
      const retryWhenVisible = () => {
        if (retryTimer || document.visibilityState !== "visible" || navigator.onLine === false) return;
        retryTimer = setTimeout(() => {
          retryTimer = 0;
          if (health.interacted || health.ready) { stopWaiting(); return; }
          if (document.visibilityState !== "visible" || navigator.onLine === false) return;
          stopWaiting();
          try {
            const key = "rex:startup-retry:20261107-1:" + location.pathname;
            const previous = Number(sessionStorage.getItem(key));
            if (previous && Date.now() - previous <= 60000) return;
            sessionStorage.setItem(key, String(Date.now()));
          } catch { return; }
          healthFlush(true); location.reload();
        }, 750);
      };
      document.addEventListener("visibilitychange", retryWhenVisible);
      window.addEventListener("online", retryWhenVisible);
      retryWhenVisible();
    };
    window.addEventListener("error", (event) => {
      // Script-created events are not browser failures. Explicit app reports use RandomExpressHealth.report().
      if (event.isTrusted === false) return;
      const target = event.target;
      if (target && target !== window && target.localName) {
        const resourceUrl = target.currentSrc || target.src || target.href || "";
        const url = typeof resourceUrl === "string" ? resourceUrl : resourceUrl?.baseVal || "";
        if (!url || !sameSite(url)) return;
        recoverStartup(target, url);
        const source = url.split("?")[0];
        if (target.localName === "link" && target.relList.contains("stylesheet") && !stylesheetRetried.has(target)) {
          stylesheetRetried.add(target);
          const retry = () => setTimeout(() => {
            if (!target.isConnected) return;
            const fresh = new URL(url); fresh.searchParams.set("rex-retry", "1");
            target.href = fresh.href;
          }, 1500);
          if (navigator.onLine === false) window.addEventListener("online", retry, {once:true});
          else retry();
          return;
        }
        if (target.localName === "img" && !imageRetried.has(target)) { retryImage(target); return; }
        const response = healthEnabled ? readResourceResponse(url) : null;
        const noteFailure = () => {
          const recorded = healthNote("resource", `Failed to load <${target.localName}>`, source, 0, 0, "", response);
          if (recorded) Object.assign(recorded.context, resourceDiagnostics(url, target));
        };
        if (target.localName === "img" && /\.webp$/i.test(source)) {
          decodesWebp().then((ok) => { if (ok) noteFailure(); });
        } else noteFailure();
        return;
      }
      // Cross-origin scripts only report an opaque "Script error." with no file, which nobody here can fix.
      if (!event.filename || !sameSite(event.filename)) return;
      healthNote("error", event.error?.message ? `${event.error.name || "Error"}: ${event.error.message}` : event.message, event.filename.split("?")[0], event.lineno || 0, event.colno || 0, event.error?.stack || "");
    }, true);
    window.addEventListener("unhandledrejection", (event) => {
      if (event.isTrusted === false) return;
      const reason = event.reason;
      // Blocked autoplay and cancelled requests are expected on every page.
      if (reason && (reason.name === "NotAllowedError" || reason.name === "AbortError")) return;
      const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : brief(reason);
      const frame = reason instanceof Error ? (reason.stack || "").match(/(?:https?:)?\/\/[^\s)]+?:(\d+):(\d+)/) : null;
      const source = frame ? frame[0].replace(/:\d+:\d+$/, "") : "";
      if (source && !sameSite(source)) return;
      healthNote("rejection", message, source.split("?")[0], frame ? Number(frame[1]) : 0, frame ? Number(frame[2]) : 0, reason instanceof Error ? reason.stack || "" : "");
    });
    for (const type of ["pointerdown", "keydown"]) window.addEventListener(type, () => { health.interacted = true; }, { capture: true, once: true, passive: true });
    // A leaving/hidden page cannot rely on another timer to send the rest of a cascade.
    window.addEventListener("pagehide", () => healthFlush(true));
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") healthFlush(true); });
    const readMeta = () => healthWatchReady(Number(document.querySelector('meta[name="rex-health-ready"]')?.content || 0));
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", readMeta, { once: true }); else readMeta();
  }
  window.RandomExpressHealth ||= Object.freeze({
    // Call once the experience is playable; pairs with <meta name="rex-health-ready">.
    ready: () => { health.ready = true; },
    // Start the stalled-start watch from code instead of the meta tag.
    expectReady: (seconds = 15) => healthWatchReady(Number(seconds)),
    // Report an error the experience caught itself (WebGL context lost, a save that failed to load).
    report: (error, options = {}) => {
      const event = healthNote("error", error instanceof Error ? `${error.name}: ${error.message}` : brief(error), options.source || "", 0, 0, error instanceof Error ? error.stack || "" : "");
      if (event && options.context) {
        for (const key of ["stage", "outcome", "build", "request", "failure", "status", "contentType"]) {
          if (options.context[key] !== undefined) event.context[key] = options.context[key];
        }
      }
      return event;
    },
  });

  const fallbackCatalog = { categories: [], creations: [] };

  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  // Players pick how much room the site header takes inside an experience; Notch is the default.
  const HEADER_STYLES = [["notch", "Notch"], ["pill", "Pill"], ["launcher", "Corner"], ["micro", "Slim bar"], ["rail", "Side rail"], ["classic", "Classic"]];
  const HEADER_STYLE_KEY = "rex:header-style";
  // Owner keeps these experiences on the classic header.
  const HEADER_STYLE_EXEMPT = new Set(["fake-work-screen"]);
  const readHeaderStyle = () => {
    try {
      const saved = localStorage.getItem(HEADER_STYLE_KEY);
      return HEADER_STYLES.some(([id]) => id === saved) ? saved : "notch";
    } catch {
      return "notch";
    }
  };
  const LOGO = '<img src="/assets/favicon.svg?v=20260928-rocket" width="36" height="36" alt="">';
  const svg = (paths) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
  const ICONS = {
    share: svg('<circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><path d="m8.7 10.6 6.6-3.9M8.7 13.4l6.6 3.9"></path>'),
    browse: svg('<rect width="7" height="7" x="3" y="3" rx="1"></rect><rect width="7" height="7" x="14" y="3" rx="1"></rect><rect width="7" height="7" x="14" y="14" rx="1"></rect><rect width="7" height="7" x="3" y="14" rx="1"></rect>'),
    account: svg('<circle cx="12" cy="8" r="4"></circle><path d="M20 21a8 8 0 0 0-16 0"></path>'),
    contract: svg('<path d="M3 8h5V3m13 5h-5V3M3 16h5v5m13-5h-5v5"></path>'),
    fullscreen: svg('<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"></path>'),
    random: svg('<path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"></path><path d="m18 2 4 4-4 4"></path><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"></path><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"></path><path d="m18 14 4 4-4 4"></path>'),
    home: svg('<path d="M3 10.5 12 3l9 7.5"></path><path d="M5 9.5V21h14V9.5"></path>'),
    down: svg('<path d="m6 9 6 6 6-6"></path>'),
    up: svg('<path d="m18 15-6-6-6 6"></path>'),
    close: svg('<path d="M18 6 6 18M6 6l12 12"></path>'),
    thumb: svg('<path d="M7 10v12"></path><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"></path>'),
    bug: svg('<rect width="8" height="12" x="8" y="8" rx="4"></rect><path d="M9.5 6.5 8 4M14.5 6.5 16 4M8 12H4M20 12h-4M8 16.5l-3.5 2M16 16.5l3.5 2M12 8v12"></path>')
  };
  let pageStyleInjected = false;

  class RandomExpressNav extends HTMLElement {
    static get observedAttributes() {
      return ["mode", "current", "theme"];
    }

    constructor() {
      super();
      this.attachShadow({ mode: "open" });
      for (const type of ["keyup", "click"]) this.shadowRoot.addEventListener(type, event => event.stopPropagation());
      this.catalog = fallbackCatalog;
      this.menuOpen = false;
      this.lastTrigger = null;
      this.shareResetTimer = null;
      this.accountState = { authenticated: false, user: null };
      this.headerStyle = readHeaderStyle();
      this.quickOpen = false;
      this.notchOpen = false;
      this.notchTimer = null;
      this.onAccountState = this.onAccountState.bind(this);
      this.saveStatus = null;
      this.onSaveStatus = this.onSaveStatus.bind(this);
      this.onModeChange = this.onModeChange.bind(this);
      this.onDocumentPointerDown = this.onDocumentPointerDown.bind(this);
      this.onDockClick = this.onDockClick.bind(this);
      this.onShadowKeyDown = this.onShadowKeyDown.bind(this);
      this.expandedMode = "";
      this.expansionPending = false;
      this.onFullscreenChange = this.onFullscreenChange.bind(this);
      this.onExpansionKeyDown = this.onExpansionKeyDown.bind(this);
    }

    connectedCallback() {
      this.accountState = window.RandomExpressAccount?.state || this.accountState;
      this.render();
      window.addEventListener("random-express:navigation-mode", this.onModeChange);
      window.addEventListener("random-express:account-state", this.onAccountState);
      window.addEventListener("random-express:progress-status", this.onSaveStatus);
      const saved = window.RandomExpressProgress?.state?.status;
      if (saved?.label) this.onSaveStatus({ detail: saved });
      document.addEventListener("pointerdown", this.onDocumentPointerDown);
      document.addEventListener("click", this.onDockClick);
      if (this.hasAttribute("expand-experience")) {
        document.addEventListener("fullscreenchange", this.onFullscreenChange);
        window.addEventListener("keydown", this.onExpansionKeyDown, true);
      }
      if (this.hasAttribute("notch-dock")) {
        // The floating tab stays hidden only while the page's docked button can really be tapped; a start card,
        // modal sheet or hidden HUD over it brings the tab back so the menu is always reachable.
        this.dockTimer = setInterval(() => this.checkDock(), 700);
        requestAnimationFrame(() => this.checkDock());
      }
      this.loadCatalog().finally(() => this.startFeedback());
      // Existing deferred clients initialize first; pages without one load the shared workflow.
      const initializeAccount = () => loadAccount()
        .then(account => this.onAccountState({ detail: account.state }))
        .catch(() => {});
      // Deferred scripts after this one (the page's own account client) have not run yet while the document is
      // still "interactive"; wait for them so phones don't download the client twice.
      const pageClient = !window.RandomExpressAccount && document.readyState !== 'complete' && document.querySelector('script[src*="/random-express-account.js"]');
      if (document.readyState === 'loading' || pageClient) {
        let started = false;
        const once = () => { if (!started) { started = true; initializeAccount(); } };
        document.addEventListener('DOMContentLoaded', once, { once: true });
        window.addEventListener('load', once, { once: true });
      } else initializeAccount();
    }

    disconnectedCallback() {
      window.removeEventListener("random-express:navigation-mode", this.onModeChange);
      window.removeEventListener("random-express:account-state", this.onAccountState);
      window.removeEventListener("random-express:progress-status", this.onSaveStatus);
      document.removeEventListener("pointerdown", this.onDocumentPointerDown);
      document.removeEventListener("click", this.onDockClick);
      document.removeEventListener("fullscreenchange", this.onFullscreenChange);
      window.removeEventListener("keydown", this.onExpansionKeyDown, true);
      if (this.expandedMode) {
        if (this.expandedMode === "native" && document.fullscreenElement === document.documentElement) {
          document.exitFullscreen?.().catch(() => {});
        }
        this.expandedMode = "";
        this.syncPage(this.activeHeaderStyle());
      }
      clearInterval(this.dockTimer);
      clearTimeout(this.shareResetTimer);
      clearTimeout(this.notchTimer);
    }

    attributeChangedCallback() {
      if (this.isConnected) {
        this.menuOpen = false;
        this.render();
      }
    }

    async loadCatalog() {
      const source = this.getAttribute("catalog-src") || "/api/catalog.php";
      if (source === "none") return;
      try {
        const response = await fetch(source, { credentials: "same-origin", cache: "no-cache" });
        if (!response.ok) return;
        const catalog = await response.json();
        if (Array.isArray(catalog.categories) && Array.isArray(catalog.creations)) {
          this.catalog = catalog;
          this.render();
        }
      } catch {
        // The embedded catalog keeps navigation available offline and in local previews.
      }
    }

    // Save status lives in the header, never over the experience. Pages opt in with <random-express-nav save-status>;
    // the shared progress module reports each change through "random-express:progress-status".
    saveChip() {
      return this.hasAttribute("save-status") ? `<button class="csave" type="button" data-save-status hidden><span class="csave-dot" aria-hidden="true"></span><span class="csave-label"></span></button>` : "";
    }

    onSaveStatus(event) {
      const detail = event.detail || {};
      if (!detail.label) return;
      this.saveStatus = { label: String(detail.label), error: !!detail.error };
      this.updateSaveStatus();
    }

    updateSaveStatus() {
      if (!this.isConnected || !this.hasAttribute("save-status")) return;
      const status = this.saveStatus;
      const full = status?.label || "";
      const state = !status ? "" : status.error ? "error" : /waiting|pending|choose|confirm/i.test(full) ? "pending" : "ok";
      const short = /choose/i.test(full) ? "Choose save" : status?.error ? "Not saved" : /confirm email/i.test(full) ? "Confirm email"
        : /waiting|pending/i.test(full) ? "Syncing" : /this device/i.test(full) ? "Saved on device" : /saved|ready/i.test(full) ? "Saved" : full;
      this.shadowRoot.querySelectorAll("[data-save-status]").forEach((chip) => {
        chip.hidden = !status;
        chip.dataset.state = state;
        chip.querySelector(".csave-label").textContent = short;
        chip.title = `${full}. Tap to save now.`;
        chip.setAttribute("aria-label", `${full}. Save now`);
      });
      this.shadowRoot.querySelectorAll("[data-save-dot]").forEach((dot) => { dot.hidden = !status; dot.dataset.state = state; });
      document.querySelectorAll("[data-rex-save-dot]").forEach((dot) => { dot.hidden = !status; dot.dataset.state = state; });
    }

    onModeChange(event) {
      const detail = event.detail || {};
      if (!detail.mode || !["catalog", "creation", "immersive", "utility"].includes(detail.mode)) return;
      if (detail.current && detail.current !== this.getAttribute("current")) return;
      this.setAttribute("mode", detail.mode);
    }

    onAccountState(event) {
      this.accountState = event.detail || { authenticated: false, user: null };
      const label = this.accountState.authenticated ? 'Account' : 'Sign in';
      if (this.isConnected) this.shadowRoot.querySelectorAll('[data-account]').forEach(button => {
        // Compact headers keep their icons; only the label or accessible name changes.
        if (button.dataset.account === 'icon') { button.setAttribute('aria-label', label); button.classList.toggle('on', !!this.accountState.authenticated); }
        else if (button.dataset.account === 'item') button.querySelector('.lbl').textContent = label;
        else button.textContent = label;
      });
    }

    supportsHeaderStyles() {
      const current = this.getAttribute("current") || "";
      return (this.getAttribute("mode") || "creation") === "creation" && current !== "" && !HEADER_STYLE_EXEMPT.has(current);
    }

    activeHeaderStyle() {
      return this.supportsHeaderStyles() ? this.headerStyle : "classic";
    }

    setHeaderStyle(style) {
      this.headerStyle = style;
      try { localStorage.setItem(HEADER_STYLE_KEY, style); } catch {}
      this.quickOpen = false;
      this.notchOpen = false;
      this.render();
      this.shadowRoot.querySelector(`[data-header-style="${style}"]`)?.focus();
      window.dispatchEvent(new CustomEvent("random-express:header-style", { detail: { style } }));
    }

    // Pages read these to reclaim the freed rows: --rex-nav-h (top space the header takes),
    // --rex-nav-inset-left/right (corners an overlay covers). Side rail shifts the body instead.
    syncPage(style) {
      const root = document.documentElement;
      if (!pageStyleInjected) {
        pageStyleInjected = true;
        const sheet = document.createElement("style");
        // Page styles that pin the header to 56px would otherwise leave an empty band above compact styles.
        sheet.textContent = ':root[data-rex-header="rail"] body{padding-left:48px;box-sizing:border-box}'
          + ':root[data-rex-header] random-express-nav[header-style]:not([header-style="classic"]){min-height:var(--rex-nav-h)!important;height:var(--rex-nav-h)!important}'
          + ':root[data-rex-expanded] body{box-sizing:border-box;padding-inline:env(safe-area-inset-left, 0px) env(safe-area-inset-right, 0px)}'
          + ':root[data-rex-expanded] random-express-nav[expand-experience]{height:0;min-height:0}'
          + ':root[data-rex-expanded] [data-rex-expand-stage]{height:100dvh}'
          + ':root[data-rex-expanded] [data-rex-notch]{display:none}';
        document.head.append(sheet);
      }
      const before = root.dataset.rexHeader || "classic";
      const previousExpansion = root.dataset.rexExpanded || "";
      if (this.expandedMode) {
        root.dataset.rexExpanded = this.expandedMode;
        root.style.setProperty("--rex-nav-h", "0px");
        root.style.setProperty("--rex-nav-inset-left", "0px");
        root.style.setProperty("--rex-nav-inset-right", "0px");
      } else {
        delete root.dataset.rexExpanded;
      }
      if (!this.expandedMode && style === "classic") {
        delete root.dataset.rexHeader;
        for (const name of ["--rex-nav-h", "--rex-nav-inset-left", "--rex-nav-inset-right"]) root.style.removeProperty(name);
      } else if (!this.expandedMode) {
        root.dataset.rexHeader = style;
        const microHeight = this.hasAttribute("expand-experience") ? "44px" : "32px";
        root.style.setProperty("--rex-nav-h", style === "micro" ? microHeight : "0px");
        root.style.setProperty("--rex-nav-inset-right", style === "launcher" ? "60px" : "0px");
        const pill = this.shadowRoot.querySelector(".pill");
        root.style.setProperty("--rex-nav-inset-left", pill ? `${Math.ceil(pill.getBoundingClientRect().right) + 8}px` : "0px");
      }
      if (before !== style || previousExpansion !== this.expandedMode) {
        requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
      }
    }

    randomPool() {
      const current = (this.getAttribute("current") || location.pathname).replace(/^\/+|\/+$/g, "");
      const { creations, settings } = this.catalog;
      const currentEntry = creations.find((item) => item.id === current)
        || creations.find((item) => item.href?.replace(/^\/+|\/+$/g, "") === current);
      const isKids = (item) => item?.category === "kids" || (Array.isArray(item?.categories) && item.categories.includes("kids"));
      // Settings also cover games that can still be opened directly after being hidden from discovery.
      const kidsPool = isKids(currentEntry || settings?.[current]);
      return creations.filter((item) => item.href && item.visible !== false && item !== currentEntry && isKids(item) === kidsPool);
    }

    goRandom() {
      const pool = this.randomPool();
      if (pool.length) location.assign(pool[Math.floor(Math.random() * pool.length)].href);
    }

    toggleFullscreen() {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else document.documentElement.requestFullscreen?.().catch(() => {});
    }

    async expandExperience() {
      if (this.expansionPending || this.expandedMode) return;
      this.expansionPending = true;
      const root = document.documentElement;
      let mode = "fallback";
      try {
        if (document.fullscreenEnabled && typeof root.requestFullscreen === "function") {
          await root.requestFullscreen({ navigationUI: "hide" });
          if (document.fullscreenElement === root) mode = "native";
        }
      } catch {
        // A denied request still leaves the in-page option available.
      } finally {
        this.expansionPending = false;
      }
      if (this.isConnected) this.setExpandedMode(mode);
    }

    async exitExpandedExperience() {
      if (this.expandedMode === "native" && document.fullscreenElement === document.documentElement) {
        try { await document.exitFullscreen(); } catch { return; }
      }
      if (this.expandedMode) this.setExpandedMode("");
    }

    onFullscreenChange() {
      if (this.expandedMode === "native" && document.fullscreenElement !== document.documentElement) {
        this.setExpandedMode("");
      }
    }

    onExpansionKeyDown(event) {
      if (event.key !== "Escape" || event.defaultPrevented || this.expandedMode !== "fallback") return;
      if (event.target?.closest?.('dialog[open], [role="dialog"], [aria-modal="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      this.exitExpandedExperience();
    }

    setExpandedMode(mode) {
      this.expandedMode = mode;
      this.quickOpen = false;
      this.notchOpen = false;
      this.syncPage(this.activeHeaderStyle());
      this.render();
      if (mode) this.shadowRoot.querySelector("[data-exit-expand]")?.focus({ preventScroll: true });
      else this.focusExpandLauncher();
    }

    focusExpandLauncher() {
      const style = this.activeHeaderStyle();
      if (style === "notch") {
        this.checkDock();
        const dock = this.hasAttribute("dock-live") && document.querySelector("[data-rex-notch]");
        (dock || this.shadowRoot.querySelector("[data-notch]"))?.focus({ preventScroll: true });
        return;
      }
      this.shadowRoot.querySelector("[data-quick], [data-expand-experience]")?.focus({ preventScroll: true });
    }

    expandControl(className, { showLabel = false, menuItem = false } = {}) {
      if (!this.hasAttribute("expand-experience")) return "";
      return `<button class="${className}" type="button" data-expand-experience aria-label="Expand" title="Expand"${menuItem ? ' role="menuitem"' : ""}>${ICONS.fullscreen}${showLabel ? "<span>Expand</span>" : ""}</button>`;
    }

    expandedHeader() {
      const label = this.expandedMode === "native" ? "Exit fullscreen" : "Exit expanded view";
      return `<button class="expanded-exit" type="button" data-exit-expand aria-label="${label}" title="${label}">${ICONS.contract}</button>`;
    }

    bindExpandedExit(button) {
      let touch;
      let pending;
      button.addEventListener("pointerdown", event => {
        if (event.pointerType === "touch" && event.isPrimary) touch = event;
      });
      button.addEventListener("pointercancel", () => { touch = null; });
      button.addEventListener("pointerup", event => {
        if (event.pointerId !== touch?.pointerId) return;
        const moved = Math.hypot(event.clientX - touch.clientX, event.clientY - touch.clientY);
        touch = null;
        const { left, right, top, bottom } = button.getBoundingClientRect();
        if (moved > 10 || event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) return;
        // A preceding canvas gesture can suppress the browser's synthesized click on a valid tap.
        clearTimeout(pending);
        pending = setTimeout(() => {
          if (button.isConnected) this.exitExpandedExperience();
        }, 180);
      });
      button.addEventListener("click", () => {
        clearTimeout(pending);
        this.exitExpandedExperience();
      });
    }

    setQuick(open) {
      this.quickOpen = open;
      const panel = this.shadowRoot.getElementById("quick");
      if (panel) panel.hidden = !open;
      this.shadowRoot.querySelectorAll("[data-quick]").forEach((button) => button.setAttribute("aria-expanded", String(open)));
    }

    setNotch(open) {
      this.notchOpen = open;
      clearTimeout(this.notchTimer);
      const bar = this.shadowRoot.getElementById("notch-bar");
      const tab = this.shadowRoot.querySelector("[data-notch]");
      if (bar) bar.hidden = !open;
      if (tab) {
        tab.hidden = open;
        tab.setAttribute("aria-expanded", String(open));
      }
      document.querySelectorAll("[data-rex-notch]").forEach((dock) => dock.setAttribute("aria-expanded", String(open)));
      if (open) this.armNotchTimer(5000);
    }

    armNotchTimer(delay) {
      clearTimeout(this.notchTimer);
      this.notchTimer = setTimeout(() => {
        const bar = this.shadowRoot.getElementById("notch-bar");
        if (this.menuOpen || bar?.matches(":hover") || bar?.contains(this.shadowRoot.activeElement)) return this.armNotchTimer(2500);
        this.setNotch(false);
      }, delay);
    }

    compactActions(style) {
      const current = this.getAttribute("current") || "";
      const title = escapeHtml(this.catalog.creations.find((item) => item.id === current)?.title || "this project");
      const account = this.accountState?.authenticated ? "Account" : "Sign in";
      const random = this.randomPool().length > 0;
      const fullscreen = document.fullscreenEnabled && !this.hasAttribute("expand-experience");
      return `${this.saveChip()}${random ? `<button class="cbtn accent" type="button" data-random aria-label="Random experience">${ICONS.random}<span class="cbtn-label">Random</span></button>` : ""}
        <button class="cbtn" type="button" data-share aria-label="Share ${title}">${ICONS.share}</button>
        <button class="cbtn" type="button" data-account="icon" aria-label="${account}">${ICONS.account}</button>
        <button class="cbtn" type="button" data-browse-trigger aria-label="Browse Random.Express" aria-expanded="false" aria-controls="browse-panel">${ICONS.browse}</button>
        ${this.expandControl("cbtn") || (fullscreen ? `<button class="cbtn" type="button" data-fullscreen aria-label="Fullscreen">${ICONS.fullscreen}</button>` : "")}
        ${style === "notch" ? `<button class="cbtn" type="button" data-notch-close aria-label="Hide bar">${ICONS.up}</button>` : ""}`;
    }

    compactHeader(style, currentTitle) {
      const title = escapeHtml(currentTitle);
      const account = this.accountState?.authenticated ? "Account" : "Sign in";
      const random = this.randomPool().length > 0;
      const brand = `<a class="cbrand" href="/" aria-label="Random Express home"><span class="clogo" aria-hidden="true">${LOGO}</span><span class="cname">Random<span class="brand-dot">.</span>Express</span></a>${title ? `<span class="ctitle">${title}</span>` : ""}`;
      const quick = `<div class="quick q-${style}" id="quick" role="menu" aria-label="Random.Express" hidden>
          ${style === "launcher" ? `<div class="quick-head"><div><strong>${title || "Random.Express"}</strong><small>on Random.Express</small></div><button class="cbtn" type="button" data-quick-close aria-label="Close">${ICONS.close}</button></div>` : ""}
          ${random ? `<button class="quick-random" type="button" role="menuitem" data-random>${ICONS.random}<span>Next random experience</span></button>` : ""}
          <div class="quick-items">
            <button class="qi" type="button" role="menuitem" data-browse-trigger aria-controls="browse-panel">${ICONS.browse}<span>Browse</span></button>
            <button class="qi" type="button" role="menuitem" data-share>${ICONS.share}<span class="share-label">Share</span></button>
            <button class="qi" type="button" role="menuitem" data-account="item">${ICONS.account}<span class="lbl">${account}</span></button>
            ${this.expandControl("qi", { showLabel: true, menuItem: true }) || (document.fullscreenEnabled ? `<button class="qi" type="button" role="menuitem" data-fullscreen>${ICONS.fullscreen}<span>Fullscreen</span></button>` : "")}
            ${this.feedbackProject() ? `<button class="qi" type="button" role="menuitem" data-feedback aria-haspopup="dialog">${ICONS.thumb}<span>Rate this experience</span></button>` : ""}
            ${this.getAttribute('current') === 'squisharium' ? '' : `<button class="qi" type="button" role="menuitem" data-bug-report aria-haspopup="dialog">${ICONS.bug}<span>Report a bug</span></button>`}
            <a class="qi" href="/" role="menuitem">${ICONS.home}<span>Home</span></a>
          </div>
        </div>`;
      if (style === "micro") return `<div class="cbar micro">${brand}<span class="cspace"></span>${this.compactActions(style)}</div>`;
      if (style === "notch") return `<button class="notch" type="button" data-notch aria-label="Show Random.Express bar" aria-expanded="false" aria-controls="notch-bar"><span class="notch-tab"><span class="clogo" aria-hidden="true">${LOGO}</span>${this.hasAttribute("save-status") ? `<span class="notch-save" data-save-dot hidden></span>` : ""}${ICONS.down}</span></button>
        <div class="cbar overlay" id="notch-bar" hidden>${brand}<span class="cspace"></span>${this.compactActions(style)}</div>`;
      if (style === "pill") return `<div class="pill"><a class="pill-home" href="/" aria-label="Random Express home"><span class="clogo" aria-hidden="true">${LOGO}</span></a><button class="pill-title" type="button" data-quick aria-expanded="false" aria-controls="quick"><span>${title || "Random.Express"}</span>${ICONS.down}</button></div>${quick}`;
      if (style === "launcher") return `<button class="launch" type="button" data-quick aria-label="Random.Express menu" aria-expanded="false" aria-controls="quick"><span class="clogo" aria-hidden="true">${LOGO}</span></button>${quick}`;
      return `<nav class="rail" aria-label="Random.Express">
          <a class="cbtn rail-home" href="/" aria-label="Random Express home"><span class="clogo" aria-hidden="true">${LOGO}</span></a>
          ${this.compactActions(style).replace(/<span class="cbtn-label">Random<\/span>/, "")}
          <span class="rail-title">${title}</span>
        </nav>`;
    }

    styleMenu(active) {
      return `<section class="menu-group style-menu" aria-labelledby="header-style-title">
          <p class="category-link" id="header-style-title"><span>Header style</span></p>
          <div class="style-grid" role="radiogroup" aria-labelledby="header-style-title">
            ${HEADER_STYLES.map(([id, label]) => `<button class="style-option" type="button" role="radio" aria-checked="${id === active}" data-header-style="${id}"><span class="sp sp-${id}" aria-hidden="true"><i></i></span><span>${label}</span></button>`).join("")}
          </div>
        </section>`;
    }

    async openAccount(trigger) {
      if (this.accountOpening) return;
      this.accountOpening = true;
      const returnFocus = this.menuOpen ? this.lastTrigger : trigger;
      this.closeMenu();
      if (document.querySelector('meta[name="rex-squisharium-privacy"]')) {
        window.dispatchEvent(new Event('rex-squisharium-save-controls'));
        this.accountOpening = false;
        return;
      }
      try {
        const account = await loadAccount();
        await account.open({ mode: account.state.authenticated ? 'account' : 'login', trigger: returnFocus });
      } catch {
        const back = /^\/[a-z0-9][a-z0-9/-]*\/?$/.test(location.pathname) && !/^\/(account|admin|api|kids-save)(\/|$)/.test(location.pathname) ? '?return=' + encodeURIComponent(location.pathname) : '';
        location.assign('/account/' + back);
      } finally {
        this.accountOpening = false;
      }
    }

    // <random-express-nav notch-dock> lets an experience put the Notch inside its own button row: any page
    // element with data-rex-notch opens the same bar, the floating tab hides, and [data-rex-save-dot] mirrors the save dot.
    onDockClick(event) {
      const dock = event.target?.closest?.("[data-rex-notch]");
      if (!dock || this.expandedMode || this.activeHeaderStyle() !== "notch") return;
      event.preventDefault();
      this.setNotch(!this.notchOpen);
      if (this.notchOpen) this.shadowRoot.querySelector("#notch-bar .cbrand")?.focus({ preventScroll: true });
    }

    checkDock() {
      if (this.expandedMode || this.notchOpen || document.hidden) return;
      let live = false;
      for (const dock of document.querySelectorAll("[data-rex-notch]")) {
        const box = dock.getBoundingClientRect();
        if (box.width < 8 || box.height < 8 || box.bottom <= 0 || box.top >= innerHeight) continue;
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        if (!hit || !(hit === dock || dock.contains(hit))) continue;
        // Faded-out HUDs (opacity 0, children still taking taps) count as covered: the tab must stay visible.
        let shown = true;
        for (let el = dock; el && el !== document.body; el = el.parentElement) {
          const style = getComputedStyle(el);
          if (Number(style.opacity) < 0.2 || style.visibility === "hidden") { shown = false; break; }
        }
        if (shown) { live = true; break; }
      }
      this.toggleAttribute("dock-live", live);
    }

    onDocumentPointerDown(event) {
      if (event.composedPath().includes(this)) return;
      if (event.target?.closest?.("[data-rex-notch]")) return;
      if (this.quickOpen) this.setQuick(false);
      if (this.notchOpen && !this.menuOpen) this.setNotch(false);
      if (this.menuOpen) this.closeMenu();
    }

    onShadowKeyDown(event) {
      // Events are retargeted to the host outside shadow DOM; isolate every header control from game shortcuts.
      event.stopPropagation();
      if (this.expandedMode) return;
      if (event.key === "Escape" && this.menuOpen) {
        event.preventDefault();
        this.closeMenu({ restoreFocus: true });
        return;
      }
      if (event.key === "Escape" && (this.quickOpen || this.notchOpen)) {
        event.preventDefault();
        this.setQuick(false);
        this.setNotch(false);
        this.shadowRoot.querySelector("[data-quick], [data-notch]")?.focus();
        return;
      }
      if (event.key !== "Tab" || !this.menuOpen) return;
      const panel = this.shadowRoot.getElementById("browse-panel");
      const focusable = [...panel.querySelectorAll("a[href], button:not([disabled])")]
        .filter((element) => !element.hidden);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && this.shadowRoot.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && this.shadowRoot.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    openMenu(trigger) {
      if (this.quickOpen) {
        this.setQuick(false);
        trigger = this.shadowRoot.querySelector("[data-quick]") || trigger;
      }
      this.menuOpen = true;
      this.lastTrigger = trigger;
      this.syncMenuState();
      requestAnimationFrame(() => this.shadowRoot.getElementById("close-menu")?.focus());
    }

    closeMenu(options = {}) {
      this.menuOpen = false;
      this.syncMenuState();
      if (options.restoreFocus) this.lastTrigger?.focus();
    }

    syncMenuState() {
      const panel = this.shadowRoot.getElementById("browse-panel");
      const backdrop = this.shadowRoot.getElementById("menu-backdrop");
      const triggers = this.shadowRoot.querySelectorAll("[data-browse-trigger]");
      if (panel) {
        panel.hidden = !this.menuOpen;
        if (panel.showPopover) {
          if (this.menuOpen && !panel.matches(':popover-open')) panel.showPopover();
          if (!this.menuOpen && panel.matches(':popover-open')) panel.hidePopover();
        }
      }
      if (backdrop) backdrop.hidden = !this.menuOpen;
      triggers.forEach((trigger) => trigger.setAttribute("aria-expanded", String(this.menuOpen)));
      this.toggleAttribute("menu-open", this.menuOpen);
    }

    async openActivity() {
      this.closeMenu({ restoreFocus: true });
      try {
        await loadActivity();
        window.RandomExpressActivity?.open(this.lastTrigger);
      } catch {
        this.shadowRoot.getElementById('share-status').textContent = 'Activity is unavailable. Please try again.';
      }
    }

    // The catalog id this page rates, or "" on hubs, guides and other pages that aren't experiences.
    feedbackProject() {
      const current = this.getAttribute("current") || "";
      if (!current || current === 'squisharium') return "";
      return this.catalog.creations.find((item) => item.id === current || (item.href || "").replace(/^\/|\/$/g, "") === current)?.id || "";
    }

    feedbackTitle() {
      const current = this.getAttribute("current") || "";
      return this.catalog.creations.find((item) => item.id === current || (item.href || "").replace(/^\/|\/$/g, "") === current)?.title || document.title.split("|")[0].trim();
    }

    async openFeedback(trigger) {
      const returnFocus = this.menuOpen ? this.lastTrigger : trigger;
      const options = { project: this.feedbackProject(), title: this.feedbackTitle(), trigger: returnFocus };
      this.closeMenu();
      if (this.quickOpen) this.setQuick(false);
      try {
        const module = await loadFeedback();
        await module.openFeedback(options);
      } catch {
        location.assign("/contact/");
      }
    }

    startFeedback() {
      if (this.feedbackStarted || !this.feedbackProject()) return;
      this.feedbackStarted = true;
      loadFeedback().then((module) => module.startFeedback({ project: this.feedbackProject(), title: this.feedbackTitle() })).catch(() => {});
    }

    async openBugReport(trigger) {
      if (this.getAttribute('current') === 'squisharium') return;
      const returnFocus = this.menuOpen ? this.lastTrigger : trigger;
      const current = this.getAttribute("current") || "";
      const title = this.catalog.creations.find((item) => item.id === current)?.title || document.title.split("|")[0].trim();
      this.closeMenu();
      if (this.quickOpen) this.setQuick(false);
      try {
        const module = await loadBugReport();
        module.openBugReport({ project: current || "site", title, headerStyle: this.supportsHeaderStyles() ? this.activeHeaderStyle() : "classic", trigger: returnFocus });
      } catch {
        location.assign("/contact/");
      }
    }

    shareUrl() {
      const url = new URL(window.location.href);
      url.searchParams.delete("release");
      url.searchParams.set("rx_share", "header");
      url.searchParams.set("utm_source", "random_express");
      url.searchParams.set("utm_medium", "share");
      url.searchParams.set("utm_campaign", "header_share");
      return url.toString();
    }

    setShareFeedback(message) {
      clearTimeout(this.shareResetTimer);
      const status = this.shadowRoot.getElementById("share-status");
      if (status) status.textContent = message;
      this.shadowRoot.querySelectorAll("[data-share]").forEach((button) => {
        const label = button.querySelector(".share-label");
        if (label) label.textContent = message || "Share";
      });
      if (!message) return;
      this.shareResetTimer = setTimeout(() => this.setShareFeedback(""), 2200);
    }

    async copyShareUrl(url) {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        return;
      }
      const textarea = document.createElement("textarea");
      textarea.value = url;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      if (!copied) throw new Error("Copy unavailable");
    }

    async shareCurrent(trigger) {
      if (trigger.disabled) return;
      this.trackShare("share_click");
      const current = this.getAttribute("current") || "";
      const currentEntry = this.catalog.creations.find((item) => item.id === current);
      const title = currentEntry?.title || document.title.split("|")[0].trim() || "Random.Express";
      const url = this.shareUrl();
      trigger.disabled = true;
      try {
        if (typeof navigator.share === "function") {
          await navigator.share({ title, url });
          this.setShareFeedback("Shared");
        } else {
          await this.copyShareUrl(url);
          this.setShareFeedback("Link copied");
        }
        this.trackShare();
      } catch (error) {
        if (error?.name !== "AbortError") this.setShareFeedback("Could not share");
      } finally {
        trigger.disabled = false;
      }
    }

    // Clicks are counted before the OS dialog/clipboard result; legacy completed shares stay separate.
    trackShare(event = "share") {
      if (kidsPage) return;
      const host = location.hostname.toLowerCase();
      if (host === "localhost" || host === "127.0.0.1" || host === "::1" || location.pathname.startsWith("/admin")) return;
      if (navigator.webdriver || navigator.doNotTrack === "1" || window.doNotTrack === "1" || navigator.globalPrivacyControl === true) return;
      if (/bot|crawler|spider|slurp|headless|phantom|selenium|playwright|puppeteer|lighthouse|codex|openai|chatgpt/.test(navigator.userAgent.toLowerCase())) return;
      const eventId = window.crypto?.randomUUID?.() || Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
      const payload = JSON.stringify({ human: true, event, eventId, path: location.pathname, source: "header" });
      try {
        if (!navigator.sendBeacon?.("/api/analytics.php", new Blob([payload], { type: "application/json" }))) {
          fetch("/api/analytics.php", { method: "POST", credentials: "same-origin", keepalive: true, headers: { "Content-Type": "application/json" }, body: payload }).catch(() => {});
        }
      } catch {}
    }

    hubMenu() {
      const hubs = [["Games", "/games/"], ["Kids", "/kids/"], ["Learning", "/learning/"], ["Science", "/science/"], ["Simulators", "/simulators/"], ["Creative", "/creative-tools/"], ["Music", "/music/"], ["Relaxing", "/relaxing/"], ["Random Tools", "/random-tools/"]];
      return `<section class="menu-group hub-menu" aria-labelledby="topic-hubs"><a class="category-link" id="topic-hubs" href="/games/"><span>Browse by topic</span><span aria-hidden="true">&#8599;</span></a><div class="creation-links">${hubs.map(([title, href]) => `<a class="creation-link" href="${href}"><span class="creation-dot" style="--item-accent:var(--rex-accent)"></span><span>${title}</span><span aria-hidden="true">&#8594;</span></a>`).join("")}</div></section>`;
    }

    catalogMenu() {
      const current = this.getAttribute("current") || "";
      return this.catalog.categories.map((category) => {
        const creations = this.catalog.creations.filter((item) => item.category === category.id);
        return `
          <section class="menu-group" aria-labelledby="category-${escapeHtml(category.id)}">
            <a class="category-link" id="category-${escapeHtml(category.id)}" href="${escapeHtml(category.href)}">
              <span>${escapeHtml(category.title)}</span><span aria-hidden="true">&#8599;</span>
            </a>
            <div class="creation-links">
              ${creations.map((item) => `
                <a class="creation-link" href="${escapeHtml(item.href)}" ${item.id === current ? 'aria-current="page"' : ""}>
                  <span class="creation-dot" style="--item-accent:${escapeHtml(item.accent)}"></span>
                  <span>${escapeHtml(item.title)}</span>
                  ${item.id === current ? '<small>Current</small>' : '<span aria-hidden="true">&#8594;</span>'}
                </a>`).join("")}
            </div>
          </section>`;
      }).join("");
    }

    render() {
      const mode = ["catalog", "creation", "immersive", "utility"].includes(this.getAttribute("mode"))
        ? this.getAttribute("mode")
        : "creation";
      const theme = this.getAttribute("theme") === "dark" ? "dark" : "light";
      const current = this.getAttribute("current") || "";
      const currentEntry = this.catalog.creations.find((item) => item.id === current);
      const currentTitle = currentEntry?.title || "";
      const accountLabel = this.accountState?.authenticated ? "Account" : "Sign in";
      const headerStyle = this.activeHeaderStyle();
      const compact = headerStyle !== "classic";
      if (this.getAttribute("header-style") !== headerStyle) this.setAttribute("header-style", headerStyle);

      const restoreExitFocus = this.shadowRoot.activeElement?.hasAttribute("data-exit-expand");
      this.shadowRoot.innerHTML = `
        <style>
          :host {
            --rex-paper: #f6f2e8;
            --rex-ink: #172522;
            --rex-muted: #65706a;
            --rex-line: rgba(23, 37, 34, .18);
            --rex-accent: #f2ca62;
            display: block;
            position: relative;
            color: var(--rex-ink);
            font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            line-height: 1.2;
            isolation: isolate;
            z-index: 10000;
          }
          :host([theme="dark"]) {
            --rex-paper: #0b1424;
            --rex-ink: #f7fbff;
            --rex-muted: #aab7ca;
            --rex-line: rgba(255, 255, 255, .16);
            --rex-accent: #f2ca62;
          }
          :host([mode="catalog"]) { min-height: 88px; }
          :host([mode="creation"]) { min-height: 56px; }
          :host([mode="immersive"]) { min-height: 0; }
          *, *::before, *::after { box-sizing: border-box; }
          a, button { font: inherit; }
          a { color: inherit; }
          button { color: inherit; }
          .bar {
            width: 100%;
            min-height: 56px;
            background: color-mix(in srgb, var(--rex-paper) 94%, transparent);
            border-bottom: 1px solid var(--rex-line);
            backdrop-filter: blur(16px);
          }
          .inner {
            width: min(1180px, calc(100% - 3rem));
            min-height: inherit;
            margin: 0 auto;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 1rem;
          }
          :host([current="cat-tv"]) .inner { flex-wrap: wrap; }
          .creation .inner { flex-wrap: wrap; gap: .25rem 1rem; padding-block: 5px; }
          .creation .brand-row { flex: 1 1 auto; }
          .creation .brand { min-height: 44px; white-space: normal; }
          .creation .brand > span:last-child { min-width: 0; overflow-wrap: anywhere; }
          .creation .standard-actions { flex: 0 1 auto; min-width: 0; flex-wrap: wrap; }
          .catalog .bar { min-height: 88px; background: transparent; backdrop-filter: none; }
          .brand-row { min-width: 0; display: flex; align-items: center; gap: .7rem; }
          .brand {
            min-height: 44px;
            display: inline-flex;
            align-items: center;
            gap: .65rem;
            color: var(--rex-ink);
            text-decoration: none;
            font-size: .96rem;
            font-weight: 850;
            letter-spacing: -.035em;
            white-space: nowrap;
          }
          .brand-dot { color: #de5d45; }
          .brand-mark {
            width: 36px;
            height: 36px;
            flex: 0 0 auto;
            display: grid;
            place-items: center;
            border: 1px solid currentColor;
            border-radius: 50%;
            background: var(--rex-accent);
            color: #172522;
          }
          .brand-mark svg { width: 23px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
          .crumb { min-width: 0; display: flex; align-items: center; gap: .7rem; color: var(--rex-muted); font-size: .78rem; font-weight: 750; }
          .crumb::before { content: "/"; opacity: .55; }
          .crumb span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .actions { display: flex; align-items: center; gap: .25rem; }
          .nav-link, .browse-button, .share-button {
            min-height: 46px;
            padding: 0 .85rem;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: .45rem;
            border: 0;
            border-radius: 999px;
            background: transparent;
            color: var(--rex-muted);
            text-decoration: none;
            font-size: .76rem;
            font-weight: 800;
            cursor: pointer;
          }
          .nav-link:hover, .browse-button:hover, .share-button:hover, .nav-link:focus-visible, .browse-button:focus-visible, .share-button:focus-visible { color: var(--rex-ink); background: color-mix(in srgb, var(--rex-ink) 8%, transparent); outline: none; }
          .browse-button { border: 1px solid var(--rex-line); color: var(--rex-ink); }
          .share-button { border: 0; min-width: 44px; flex-shrink: 0; }
          .acct-icon { display: none; flex: 0 0 44px; width: 44px; height: 44px; padding: 0; align-items: center; justify-content: center; border: 0; border-radius: 999px; background: transparent; color: var(--rex-muted); cursor: pointer; }
          .acct-icon svg { width: 21px; height: 21px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
          .acct-icon.on { color: var(--rex-ink); background: color-mix(in srgb, var(--rex-ink) 10%, transparent); }
          .acct-icon:focus-visible { outline: 3px solid currentColor; outline-offset: 2px; }
          .share-icon { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
          .share-status { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
          .catalog-links { display: flex; align-items: center; gap: 1rem; }
          .catalog-menu-button { display: none; }
          .immersive .bar {
            position: fixed;
            top: max(12px, env(safe-area-inset-top));
            left: max(12px, env(safe-area-inset-left));
            width: auto;
            min-height: 0;
            border: 0;
            background: transparent;
            backdrop-filter: none;
          }
          /* Rowan has its own full-width header; reserve a row instead of covering it. */
          :host([current="rowans-flag-quest"][mode="immersive"]) { position: sticky; top: 0; min-height: 64px; }
          :host([current="rowans-flag-quest"]) .immersive .bar { position: static; width: 100%; padding: 8px 12px; }
          .immersive .inner { width: auto; min-height: 0; }
          :host([current="rowans-flag-quest"]) .immersive .inner { justify-content: flex-start; }
          .immersive .brand-row, .immersive .standard-actions { display: none; }
          .immersive .browse-button, .immersive .share-button {
            width: 48px;
            height: 48px;
            min-height: 48px;
            padding: 0;
            border-color: color-mix(in srgb, var(--rex-ink) 26%, transparent);
            background: color-mix(in srgb, var(--rex-paper) 88%, transparent);
            box-shadow: 0 10px 32px rgba(0, 0, 0, .22);
            backdrop-filter: blur(16px);
          }
          .immersive .browse-button .menu-label, .immersive .share-button .share-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
          .mini-mark { display: none; }
          .immersive .mini-mark { display: grid; }
          .menu-icon { width: 16px; height: 12px; display: grid; align-content: space-between; }
          .menu-icon i { display: block; height: 1.5px; border-radius: 2px; background: currentColor; }
          .menu-backdrop {
            position: fixed;
            inset: 0;
            z-index: 1;
            border: 0;
            background: rgba(5, 10, 14, .44);
            backdrop-filter: blur(3px);
            cursor: default;
          }
          .menu-panel {
            margin: 0;
            left: auto;
            bottom: auto;
            position: fixed;
            z-index: 2;
            top: max(12px, env(safe-area-inset-top));
            right: max(12px, env(safe-area-inset-right));
            width: min(420px, calc(100vw - 24px));
            max-height: calc(100vh - 24px - env(safe-area-inset-top) - env(safe-area-inset-bottom));
            display: flex;
            flex-direction: column;
            overflow: hidden;
            padding: 1rem;
            border: 1px solid var(--rex-line);
            border-radius: 22px;
            background: var(--rex-paper);
            color: var(--rex-ink);
            box-shadow: 0 28px 90px rgba(0, 0, 0, .3);
          }
          [hidden] { display: none !important; }
          .menu-body { min-height: 0; overflow: auto; overscroll-behavior-y: contain; }
          .menu-head { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .25rem .25rem 1rem; border-bottom: 1px solid var(--rex-line); }
          .menu-kicker { margin: 0 0 .2rem; color: var(--rex-muted); font-size: .62rem; font-weight: 850; letter-spacing: .14em; text-transform: uppercase; }
          .menu-head strong { font-family: Georgia, "Times New Roman", serif; font-size: 1.55rem; font-weight: 400; letter-spacing: -.035em; }
          button.menu-home-link { width:calc(100% - .5rem); font:inherit; text-align:left; cursor:pointer; }
          .menu-home-link {
            min-height: 76px;
            margin: 1rem .25rem .35rem;
            padding: .8rem .9rem;
            display: grid;
            grid-template-columns: auto 1fr auto;
            align-items: center;
            gap: .8rem;
            border: 1px solid color-mix(in srgb, var(--rex-ink) 24%, transparent);
            border-radius: 16px;
            background: var(--rex-accent);
            color: #172522;
            text-decoration: none;
            box-shadow: 4px 5px 0 color-mix(in srgb, var(--rex-ink) 12%, transparent);
          }
          .menu-home-link:hover, .menu-home-link:focus-visible {
            transform: translateY(-2px);
            box-shadow: 6px 8px 0 color-mix(in srgb, var(--rex-ink) 14%, transparent);
            outline: 3px solid color-mix(in srgb, var(--rex-ink) 30%, transparent);
            outline-offset: 2px;
          }
          .menu-home-icon {
            width: 42px;
            height: 42px;
            display: grid;
            place-items: center;
            border: 1px solid rgba(23, 37, 34, .4);
            border-radius: 50%;
            background: rgba(255, 255, 255, .32);
          }
          .menu-home-icon svg { width: 23px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
          .menu-home-copy { min-width: 0; display: grid; gap: .16rem; }
          .menu-home-copy strong { font-size: .88rem; font-weight: 900; }
          .menu-home-copy small { color: rgba(23, 37, 34, .72); font-size: .68rem; font-weight: 700; }
          .menu-home-arrow { font-size: 1.1rem; font-weight: 900; }
          .close-button { width: 46px; height: 46px; flex: 0 0 auto; border: 1px solid var(--rex-line); border-radius: 50%; background: transparent; color: var(--rex-ink); font-size: 1.3rem; cursor: pointer; }
          .close-button:hover, .close-button:focus-visible { background: color-mix(in srgb, var(--rex-ink) 8%, transparent); outline: none; }
          .menu-group { padding: 1rem .25rem .2rem; }
          .menu-group + .menu-group { border-top: 1px solid var(--rex-line); }
          .category-link { min-height: 46px; display: flex; align-items: center; justify-content: space-between; color: var(--rex-muted); text-decoration: none; font-size: .67rem; font-weight: 900; letter-spacing: .11em; text-transform: uppercase; }
          .creation-links { display: grid; gap: .35rem; }
          .creation-link { min-height: 48px; padding: .55rem .65rem; display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: .7rem; border-radius: 12px; color: var(--rex-ink); text-decoration: none; font-size: .86rem; font-weight: 760; }
          .creation-link:hover, .creation-link:focus-visible { background: color-mix(in srgb, var(--rex-ink) 8%, transparent); outline: none; }
          .creation-link[aria-current="page"] { background: color-mix(in srgb, var(--rex-ink) 10%, transparent); }
          .creation-link small { color: var(--rex-muted); font-size: .6rem; letter-spacing: .08em; text-transform: uppercase; }
          .creation-dot { width: 12px; height: 12px; border: 1px solid color-mix(in srgb, var(--rex-ink) 45%, transparent); border-radius: 50%; background: var(--item-accent); }
          .menu-footer { margin: 1rem .25rem .25rem; padding-top: 1rem; border-top: 1px solid var(--rex-line); display: flex; justify-content: space-between; gap: 1rem; color: var(--rex-muted); font-size: .7rem; }
          .menu-footer a, .menu-footer button { min-height: 46px; display: inline-flex; align-items: center; border: 0; background: transparent; color: var(--rex-ink); font: inherit; font-weight: 800; text-decoration: none; cursor: pointer; }
          @media (max-width: 640px) {
            :host([mode="catalog"]) { min-height: 74px; }
            .inner { width: min(100% - 1.5rem, 1180px); }
            .catalog .bar { min-height: 74px; }
            .catalog-links { gap: .15rem; }
            .immersive .browse-button, .immersive .share-button { backdrop-filter: none; }
            .catalog-links .nav-link { display: none; }
            .catalog-links .catalog-menu-button { min-height: 46px; display: inline-flex; padding: 0 .8rem; }
            .brand { font-size: .88rem; }
            .brand-mark { width: 34px; height: 34px; }
            .crumb { display: none; }
            .standard-actions .nav-link { display: none; }
            .acct-icon { display: inline-flex; }
            .share-button, .browse-button { padding: 0 .72rem; }
            .menu-panel { top: auto; bottom: max(8px, env(safe-area-inset-bottom)); max-height: min(78vh, 660px); border-radius: 22px 22px 14px 14px; }
          }
          @media (max-width: 440px) {
            .standard-actions .share-label { display: none; }
            .standard-actions .share-button { padding: 0; width: 44px; }
          }
          @media (max-width: 360px) {
            .standard-actions .menu-label { display: none; }
            .standard-actions .browse-button { width: 46px; padding: 0; }
            /* Creation headers reflow with readable labels, including narrow zoom viewports. */
            .catalog .brand > span:last-child { display: none; }
            .catalog .catalog-menu-button { width: 46px; padding: 0; }
            .catalog .catalog-menu-button .menu-label { display: none; }
          }
          @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; }
          }
          @media (max-width:340px) {
            :host([current="cash-register-simulator"]) .creation .inner { width:calc(100% - 16px); }
            :host([current="cash-register-simulator"]) .creation .standard-actions { max-width:100%; }
          }
          @media (min-width:341px) and (max-width:380px) {
            :host([current="cash-register-simulator"]) .creation .inner { width:calc(100% - 16px);flex-wrap:nowrap;gap:4px; }
            :host([current="cash-register-simulator"]) .creation .standard-actions { flex-wrap:nowrap; }
            :host([current="cash-register-simulator"]) .share-button { padding:0 8px; }
            :host([current="cash-register-simulator"]) .share-label { display:none; }
          }
          :host([mode="utility"]) { display:block; min-height:52px; flex:0 0 auto; width:100%; }
          .utility .bar { min-height:52px; }
          .utility .inner { width:calc(100% - 16px); justify-content:flex-end; gap:4px; }
          .utility .brand-row { display:none; }
          .utility .standard-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; }
          .utility .standard-actions .nav-link { display:inline-flex; }
          .utility .nav-link,.utility .share-button,.utility .browse-button { min-width:44px; padding:0 10px; }
          .brand-mark,.menu-home-icon{background:transparent;border:0}.brand-mark img,.menu-home-icon img{display:block;width:100%;height:100%;object-fit:contain}
          /* Compact header styles (player setting). */
          :host([header-style="micro"]) { min-height: 32px; }
          :host([header-style="notch"]), :host([header-style="pill"]), :host([header-style="launcher"]), :host([header-style="rail"]) { min-height: 0; height: 0; }
          .ico { width: 18px; height: 18px; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
          .clogo { width: 22px; height: 22px; flex: 0 0 auto; display: block; }
          .clogo img { display: block; width: 100%; height: 100%; }
          .cbar { display: flex; align-items: center; gap: 4px; padding: 0 4px 0 10px; background: #11151b; color: #eef2f6; }
          .cbar.micro { height: 32px; border-bottom: 1px solid rgba(255, 255, 255, .08); }
          :host([theme="light"]) .cbar.micro { background: var(--rex-paper); color: var(--rex-ink); border-bottom-color: var(--rex-line); }
          .cbar.overlay { position: fixed; z-index: 1; top: 0; left: 0; right: 0; height: calc(48px + env(safe-area-inset-top)); padding-top: env(safe-area-inset-top); background: rgba(17, 21, 27, .92); backdrop-filter: blur(14px); box-shadow: 0 8px 24px rgba(0, 0, 0, .25); }
          .cbrand { min-height: 32px; display: inline-flex; align-items: center; gap: 8px; text-decoration: none; font-size: 13px; font-weight: 850; letter-spacing: -.02em; white-space: nowrap; border-radius: 8px; }
          .cbrand:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
          .ctitle { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; opacity: .75; }
          .ctitle::before { content: "/"; margin: 0 8px 0 4px; opacity: .5; }
          .cspace { flex: 1 1 auto; }
          .csave { height: 32px; padding: 0 10px; display: inline-flex; align-items: center; gap: 6px; flex: none; border: 0; border-radius: 999px; background: color-mix(in srgb, currentColor 10%, transparent); color: inherit; font: inherit; font-size: 12px; font-weight: 700; white-space: nowrap; cursor: pointer; }
          .csave[hidden], .notch-save[hidden] { display: none; }
          .csave:hover, .csave:focus-visible { background: color-mix(in srgb, currentColor 18%, transparent); outline: none; }
          .csave-dot, .notch-save { width: 8px; height: 8px; flex: none; border-radius: 50%; background: #4cc38a; }
          .notch-save { display: inline-block; }
          .csave[data-state="pending"] .csave-dot, .notch-save[data-state="pending"] { background: #f5b84a; }
          .csave[data-state="error"] .csave-dot, .notch-save[data-state="error"] { background: #ef5b5b; }
          .rail .csave .csave-label { display: none; }
          @media (max-width: 420px) { .cbar .csave .csave-label { display: none; } .cbar .csave { padding: 0 11px; } }
          /* 360px Android phones: the open bar pushed Hide bar off screen. Tighten spacing, then drop the page name. */

          .cbtn { min-width: 40px; height: 32px; padding: 0 8px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: 0; border-radius: 8px; background: transparent; color: inherit; opacity: .86; font-size: 12px; font-weight: 800; text-decoration: none; cursor: pointer; flex: 0 0 auto; }
          .cbtn:hover, .cbtn:focus-visible { opacity: 1; background: color-mix(in srgb, currentColor 13%, transparent); outline: none; }
          .cbtn.accent { margin-right: 4px; opacity: 1; background: #de5d45; color: #fff; }
          .cbtn.accent:hover, .cbtn.accent:focus-visible { background: #c4472f; }
          .micro .cbtn .ico { width: 16px; height: 16px; }
          .micro .cbtn.accent { height: 24px; }
          .micro .cbtn { position: relative; }
          .micro .cbtn::after { content: ""; position: absolute; inset: -4px 0 -8px; }
          .overlay .cbtn { min-width: 44px; height: 44px; }
          .overlay .cbrand { min-height: 44px; min-width: 44px; justify-content: center; }
          /* 360px Android phones: the open bar pushed Hide bar off screen. Narrower buttons keep every control on screen. */
          @media (max-width: 380px) { .cbar { gap: 2px; padding-left: 8px; } .overlay .cbtn, .cbar .cbtn { min-width: 40px; padding: 0 4px; } }
          @media (max-width: 340px) { .cbar { gap: 1px; padding-left: 4px; } .overlay .cbtn, .cbar .cbtn { min-width: 36px; } .overlay .cbrand { min-width: 36px; } .cbar .csave { padding: 0 9px; } }
          /* Only the visible tab takes clicks, so page controls beside and below it stay reachable. */
          .notch { position: fixed; top: 0; left: 50%; transform: translateX(-50%); width: 88px; height: 44px; padding: 0; display: flex; align-items: flex-start; justify-content: center; border: 0; background: transparent; color: #fff; cursor: pointer; pointer-events: none; }
          .notch-tab { pointer-events: auto; width: 88px; height: 24px; display: flex; align-items: center; justify-content: center; gap: 6px; border-radius: 0 0 12px 12px; background: rgba(17, 21, 27, .82); backdrop-filter: blur(10px); box-shadow: 0 4px 14px rgba(0, 0, 0, .2); transition: height .15s ease; }
          .notch .clogo { width: 16px; height: 16px; }
          .notch .ico { width: 14px; height: 14px; opacity: .8; }
          .notch:focus-visible { outline: none; }
          :host([notch-dock][dock-live]) .notch { display: none; }
          .notch:hover .notch-tab, .notch:focus-visible .notch-tab { height: 30px; background: rgba(17, 21, 27, .95); }
          .notch:focus-visible .notch-tab { outline: 2px solid #fff; outline-offset: -2px; }
          .pill { position: fixed; top: max(12px, env(safe-area-inset-top)); left: max(12px, env(safe-area-inset-left)); max-width: calc(100vw - 24px); height: 44px; padding: 0 2px; display: flex; align-items: center; gap: 2px; border-radius: 13px; background: rgba(17, 21, 27, .86); backdrop-filter: blur(10px); color: #fff; box-shadow: 0 4px 16px rgba(0, 0, 0, .2); }
          .pill-home { width: 40px; height: 40px; display: grid; place-items: center; border-radius: 11px; }
          .pill-home .clogo { width: 26px; height: 26px; }
          .pill-title { height: 40px; min-width: 0; padding: 0 8px 0 6px; display: flex; align-items: center; gap: 6px; border: 0; border-radius: 11px; background: transparent; color: inherit; font-size: 13px; font-weight: 750; cursor: pointer; }
          .pill-title span { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .pill-title .ico { width: 15px; height: 15px; opacity: .7; }
          .pill-home:hover, .pill-title:hover, .pill-home:focus-visible, .pill-title:focus-visible { background: rgba(255, 255, 255, .1); outline: none; }
          .launch { position: fixed; top: max(12px, env(safe-area-inset-top)); right: max(12px, env(safe-area-inset-right)); width: 44px; height: 44px; padding: 0; display: grid; place-items: center; border: 0; border-radius: 13px; background: rgba(17, 21, 27, .86); backdrop-filter: blur(10px); box-shadow: 0 4px 16px rgba(0, 0, 0, .22); cursor: pointer; }
          .launch .clogo { width: 28px; height: 28px; }
          .launch:hover, .launch:focus-visible { background: rgba(17, 21, 27, .97); outline: 2px solid rgba(255, 255, 255, .5); }
          .quick { position: fixed; z-index: 1; top: calc(max(12px, env(safe-area-inset-top)) + 52px); width: min(280px, calc(100vw - 24px)); max-height: calc(100vh - 88px); overflow: auto; padding: 6px; display: grid; gap: 6px; border-radius: 16px; background: rgba(17, 21, 27, .96); backdrop-filter: blur(14px); color: #eef2f6; box-shadow: 0 18px 44px rgba(0, 0, 0, .32); }
          .quick.q-pill { left: max(12px, env(safe-area-inset-left)); }
          .quick.q-launcher { right: max(12px, env(safe-area-inset-right)); width: min(300px, calc(100vw - 24px)); padding: 12px; gap: 10px; }
          .quick-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
          .quick-head div { min-width: 0; display: grid; gap: 2px; }
          .quick-head strong { font-size: 15px; font-weight: 850; }
          .quick-head small { color: #9aa4b1; font-size: 12px; }
          .quick-head .cbtn { height: 40px; }
          .quick-random { min-height: 46px; display: flex; align-items: center; justify-content: center; gap: 8px; border: 0; border-radius: 12px; background: #de5d45; color: #fff; font-size: 14px; font-weight: 850; cursor: pointer; }
          .quick-random:hover, .quick-random:focus-visible { background: #c4472f; outline: none; }
          .quick-items { display: grid; gap: 2px; }
          .qi { min-height: 44px; padding: 0 12px; display: flex; align-items: center; gap: 12px; border: 0; border-radius: 10px; background: transparent; color: inherit; font-size: 13px; font-weight: 650; text-align: left; text-decoration: none; cursor: pointer; }
          .qi:hover, .qi:focus-visible { background: rgba(255, 255, 255, .09); outline: none; }
          .quick.q-launcher .quick-items { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
          .quick.q-launcher .qi { min-height: 64px; padding: 0 4px; flex-direction: column; justify-content: center; gap: 6px; border-radius: 12px; background: rgba(255, 255, 255, .06); font-size: 12px; text-align: center; }
          .quick.q-launcher .qi:hover, .quick.q-launcher .qi:focus-visible { background: rgba(255, 255, 255, .13); }
          .rail { position: fixed; top: 0; bottom: 0; left: 0; width: 48px; padding: max(8px, env(safe-area-inset-top)) 0 8px; display: flex; flex-direction: column; align-items: center; gap: 4px; background: #11151b; color: #eef2f6; border-right: 1px solid rgba(255, 255, 255, .08); }
          .rail .cbtn { width: 40px; height: 40px; min-width: 0; padding: 0; }
          .rail .cbtn.accent { margin: 0; }
          .rail-home { margin-bottom: 6px; }
          .rail-home .clogo { width: 30px; height: 30px; }
          .rail-title { flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; align-items: center; writing-mode: vertical-rl; transform: rotate(180deg); color: #7f8995; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; white-space: nowrap; }
          :host([header-style]:not([header-style="classic"])) .share-status:not(:empty) { position: fixed; z-index: 4; top: 60px; left: 50%; width: auto; height: auto; margin: 0; padding: 8px 14px; overflow: visible; clip-path: none; transform: translateX(-50%); border-radius: 999px; background: rgba(17, 21, 27, .94); color: #fff; font-size: 13px; font-weight: 700; }
          .style-menu .category-link { margin: 0; }
          .style-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .4rem; }
          .style-option { min-height: 72px; padding: .5rem .25rem; display: grid; justify-items: center; align-content: center; gap: .4rem; border: 1px solid var(--rex-line); border-radius: 12px; background: transparent; color: var(--rex-ink); font-size: .74rem; font-weight: 800; cursor: pointer; }
          .style-option:hover, .style-option:focus-visible { background: color-mix(in srgb, var(--rex-ink) 8%, transparent); outline: none; }
          .style-option[aria-checked="true"] { border: 2px solid var(--rex-ink); background: color-mix(in srgb, var(--rex-accent) 45%, transparent); }
          .sp { position: relative; width: 44px; height: 28px; overflow: hidden; border: 1.5px solid currentColor; border-radius: 5px; opacity: .8; }
          .sp i { position: absolute; background: currentColor; }
          .sp-notch i { left: 14px; top: 0; width: 14px; height: 5px; border-radius: 0 0 3px 3px; }
          .sp-pill i { left: 3px; top: 3px; width: 18px; height: 6px; border-radius: 3px; }
          .sp-launcher i { right: 3px; top: 3px; width: 7px; height: 7px; border-radius: 2px; }
          .sp-micro i { left: 0; right: 0; top: 0; height: 4px; }
          .sp-rail i { left: 0; top: 0; bottom: 0; width: 6px; }
          .sp-classic i { left: 0; right: 0; top: 0; height: 9px; }
          button[data-expand-experience] { min-height: 44px; }
          .cbtn[data-expand-experience] { min-width: 44px; }
          .expand-classic, [data-exit-expand] {
            display: inline-flex; align-items: center; justify-content: center; gap: 6px;
            min-width: 44px; min-height: 44px; padding: 0 10px; border: 0; border-radius: 8px;
            color: var(--rex-ink); background: transparent; font-size: .85rem; font-weight: 750; cursor: pointer;
          }
          .expand-classic:hover, [data-exit-expand]:hover { background: var(--rex-line); }
          .expand-classic .ico, [data-exit-expand] .ico { width: 18px; height: 18px; flex: none; }
          :host([expand-experience]) .cbar.micro { height: 44px; border-bottom: 0; box-shadow: inset 0 -1px var(--rex-line); }
          :host([expand-experience]) .notch { pointer-events: auto; }
          :host([expand-experience]) .cbar.overlay {
            padding-inline: max(10px, env(safe-area-inset-left, 0px)) max(4px, env(safe-area-inset-right, 0px));
          }
          [data-exit-expand].expanded-exit {
            position: fixed;
            top: calc(env(safe-area-inset-top, 0px) + 4px);
            right: calc(env(safe-area-inset-right, 0px) + 6px);
            width: 44px; height: 44px; padding: 0; border: 1px solid rgba(255,255,255,.28);
            border-radius: 50%; color: #fff; background: rgba(12,18,31,.86);
            touch-action: manipulation;
          }
          [data-exit-expand].expanded-exit:hover { background: #243043; }
          [data-exit-expand].expanded-exit:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
          :host([expand-exit="left"]) .expanded-exit {
            left: calc(env(safe-area-inset-left, 0px) + 8px); right: auto;
          }
          :host([expand-exit="center"]) .expanded-exit {
            left: 50%; right: auto; transform: translateX(-50%);
          }
          :host([expand-exit="toolbar"]) .expanded-exit { top: env(safe-area-inset-top, 0px); }
          @media (max-height: 500px) and (min-aspect-ratio: 3/2) {
            :host([expand-exit="center"]) .expanded-exit {
              top: auto; left: auto;
              right: calc(env(safe-area-inset-right, 0px) + 6px);
              bottom: calc(env(safe-area-inset-bottom, 0px) + 6px);
              transform: none;
            }
          }
          @media (max-width: 440px) { .expand-classic span { display: none; } }
          @media (max-width: 560px) {
            .cname, .cbtn-label { display: none; }
            .ctitle::before { display: none; }
            .cbtn.accent { padding: 0; }
            .pill-title span { max-width: 46vw; }
          }
        </style>
        <div class="${mode}">
          ${this.expandedMode ? this.expandedHeader() : compact ? this.compactHeader(headerStyle, currentTitle || document.title.split("|")[0].split(/\s[-–—]\s/)[0].trim()) : `<div class="bar">
            <div class="inner">
              <div class="brand-row">
                <a class="brand" href="/" aria-label="Random Express home">
                  <span class="brand-mark" aria-hidden="true">
                    <img src="/assets/favicon.svg?v=20260928-rocket" width="36" height="36" alt="">
                  </span>
                  <span>Random<span class="brand-dot">.</span>Express</span>
                </a>
                ${mode !== "catalog" && currentTitle ? `<div class="crumb"><span>${escapeHtml(currentTitle)}</span></div>` : ""}
              </div>
              ${mode === "catalog" ? `
                <nav class="catalog-links" aria-label="Primary navigation">
                  <a class="nav-link" href="#collection">Browse projects</a>
                  <a class="nav-link" href="/games/">Categories</a>
                  <a class="nav-link" href="/about/">About</a>
                  <button class="nav-link" type="button" data-account>${accountLabel}</button>
                  <button class="acct-icon${this.accountState?.authenticated ? " on" : ""}" type="button" data-account="icon" aria-label="${accountLabel}">${ICONS.account}</button>
                  <button class="browse-button catalog-menu-button" type="button" data-browse-trigger aria-label="Open Random.Express navigation" aria-expanded="false" aria-controls="browse-panel">
                    <span class="menu-icon" aria-hidden="true"><i></i><i></i><i></i></span><span class="menu-label">Browse</span>
                  </button>
                </nav>` : `
                <div class="actions standard-actions">
                  ${this.saveChip()}
                  ${this.expandControl("expand-classic", { showLabel: true })}
                  <a class="nav-link" href="/">Home</a>
                  <button class="nav-link" type="button" data-account>${accountLabel}</button>
                  <button class="acct-icon${this.accountState?.authenticated ? " on" : ""}" type="button" data-account="icon" aria-label="${accountLabel}">${ICONS.account}</button>
                  <button class="share-button" type="button" data-share aria-label="Share ${escapeHtml(currentTitle || "this project")}">
                    <svg class="share-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><path d="m8.7 10.6 6.6-3.9M8.7 13.4l6.6 3.9"></path></svg><span class="share-label">Share</span>
                  </button>
                  <button class="browse-button" type="button" data-browse-trigger aria-expanded="false" aria-controls="browse-panel">
                    <span class="menu-icon" aria-hidden="true"><i></i><i></i><i></i></span><span class="menu-label">Browse</span>
                  </button>
                </div>`}
              ${mode === "immersive" ? `
                <div class="actions immersive-actions">
                  ${this.saveChip()}
                  ${this.expandControl("expand-classic", { showLabel: true })}
                  <button class="share-button" type="button" data-share data-share-immersive aria-label="Share ${escapeHtml(currentTitle || "this project")}">
                    <svg class="share-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><path d="m8.7 10.6 6.6-3.9M8.7 13.4l6.6 3.9"></path></svg><span class="share-label">Share</span>
                  </button>
                  <button class="browse-button" type="button" data-browse-trigger aria-label="Open Random.Express navigation" aria-expanded="false" aria-controls="browse-panel">
                    <span class="brand-mark mini-mark" aria-hidden="true">
                      <img src="/assets/favicon.svg?v=20260928-rocket" width="36" height="36" alt="">
                    </span><span class="menu-label">Browse</span>
                  </button>
                </div>` : ""}
            </div>
          </div>`}
          <span class="share-status" id="share-status" role="status" aria-live="polite"></span>
          <button class="menu-backdrop" id="menu-backdrop" type="button" aria-label="Close navigation" hidden></button>
          <div class="menu-panel" id="browse-panel" popover="manual" role="dialog" aria-modal="true" aria-label="Browse Random.Express" hidden>
            <div class="menu-head">
              <div><p class="menu-kicker">The collection</p><strong>Where to next?</strong></div>
              <button class="close-button" id="close-menu" type="button" aria-label="Close navigation">&#215;</button>
            </div>
            <div class="menu-body">
            <a class="menu-home-link" href="/">
              <span class="menu-home-icon" aria-hidden="true">
                <img src="/assets/favicon.svg?v=20260928-rocket" width="36" height="36" alt="">
              </span>
              <span class="menu-home-copy"><strong>Random.Express home</strong><small>Browse the full collection</small></span>
              <span class="menu-home-arrow" aria-hidden="true">&#8594;</span>
            </a>
            ${kidsPage ? '' : '<button class="menu-home-link" type="button" data-activity aria-haspopup="dialog"><span class="menu-home-copy"><strong>Your activity</strong><small>Stats, achievements and your visit receipt</small></span><span class="menu-home-arrow" aria-hidden="true">&#8594;</span></button>'}
            ${this.feedbackProject() ? `<button class="menu-home-link" type="button" data-feedback aria-haspopup="dialog"><span class="menu-home-copy"><strong>Rate this experience</strong><small>Was ${escapeHtml(currentTitle || "it")} fun? Tell us</small></span><span class="menu-home-arrow" aria-hidden="true">&#8594;</span></button>` : ""}
            ${this.getAttribute('current') === 'squisharium' ? '' : `<button class="menu-home-link" type="button" data-bug-report aria-haspopup="dialog"><span class="menu-home-copy"><strong>Report a bug</strong><small>Something broken or weird${currentTitle ? ` in ${escapeHtml(currentTitle)}` : ""}? Tell us</small></span><span class="menu-home-arrow" aria-hidden="true">&#8594;</span></button>`}
            ${this.supportsHeaderStyles() ? this.styleMenu(headerStyle) : ""}
            ${this.hubMenu()}
            ${this.catalogMenu()}
            <div class="menu-footer"><a href="/about/">About</a><a href="/contact/">Contact</a><button type="button" data-account>${accountLabel}</button></div>
            </div>
          </div>
        </div>`;

      this.shadowRoot.removeEventListener("keydown", this.onShadowKeyDown);
      this.shadowRoot.addEventListener("keydown", this.onShadowKeyDown);

      this.shadowRoot.querySelectorAll("[data-browse-trigger]").forEach((trigger) => {
        trigger.addEventListener("click", () => this.menuOpen ? this.closeMenu({ restoreFocus: true }) : this.openMenu(trigger));
      });
      this.shadowRoot.querySelectorAll("[data-share]").forEach((button) => {
        button.addEventListener("click", () => this.shareCurrent(button));
      });
      this.shadowRoot.querySelectorAll("[data-account]").forEach((button) => {
        button.addEventListener("click", () => this.openAccount(button));
      });
      this.shadowRoot.querySelector("[data-activity]")?.addEventListener("click", () => this.openActivity());
      this.shadowRoot.querySelectorAll("[data-save-status]").forEach((chip) => chip.addEventListener("click", () => window.RandomExpressProgress?.saveNow?.({ openAccount: true })));
      this.updateSaveStatus();
      this.shadowRoot.querySelectorAll("[data-bug-report]").forEach((button) => button.addEventListener("click", () => this.openBugReport(button)));
      this.shadowRoot.querySelectorAll("[data-feedback]").forEach((button) => button.addEventListener("click", () => this.openFeedback(button)));
      this.shadowRoot.getElementById("close-menu")?.addEventListener("click", () => this.closeMenu({ restoreFocus: true }));
      this.shadowRoot.getElementById("menu-backdrop")?.addEventListener("click", () => this.closeMenu({ restoreFocus: true }));
      this.shadowRoot.querySelectorAll(".menu-panel a").forEach((link) => link.addEventListener("click", () => this.closeMenu()));
      this.shadowRoot.querySelectorAll("[data-header-style]").forEach((button) => {
        button.addEventListener("click", () => this.setHeaderStyle(button.dataset.headerStyle));
      });
      this.shadowRoot.querySelectorAll("[data-random]").forEach((button) => button.addEventListener("click", () => this.goRandom()));
      this.shadowRoot.querySelectorAll("[data-fullscreen]").forEach((button) => button.addEventListener("click", () => this.toggleFullscreen()));
      this.shadowRoot.querySelectorAll("[data-expand-experience]").forEach((button) => {
        button.addEventListener("click", () => this.expandExperience());
      });
      const exitExpand = this.shadowRoot.querySelector("[data-exit-expand]");
      if (exitExpand) this.bindExpandedExit(exitExpand);
      if (restoreExitFocus) exitExpand?.focus({ preventScroll: true });
      this.shadowRoot.querySelectorAll("[data-quick]").forEach((button) => button.addEventListener("click", () => this.setQuick(!this.quickOpen)));
      this.shadowRoot.querySelector("[data-quick-close]")?.addEventListener("click", () => {
        this.setQuick(false);
        this.shadowRoot.querySelector("[data-quick]")?.focus();
      });
      this.shadowRoot.querySelector("[data-notch]")?.addEventListener("click", () => {
        this.setNotch(true);
        this.shadowRoot.querySelector("#notch-bar .cbrand")?.focus();
      });
      this.shadowRoot.querySelector("[data-notch-close]")?.addEventListener("click", () => {
        this.setNotch(false);
        (this.hasAttribute("notch-dock") ? document.querySelector("[data-rex-notch]") : this.shadowRoot.querySelector("[data-notch]"))?.focus({ preventScroll: true });
      });
      this.shadowRoot.getElementById("notch-bar")?.addEventListener("pointerleave", () => this.armNotchTimer(2500));
      this.setQuick(this.quickOpen);
      if (compact) this.setNotch(this.notchOpen);
      this.syncMenuState();
      if (this.supportsHeaderStyles() || this.hasAttribute("expand-experience")) {
        requestAnimationFrame(() => {
          if (this.isConnected) this.syncPage(this.activeHeaderStyle());
        });
      }
    }
  }

  if (!customElements.get("random-express-nav")) {
    customElements.define("random-express-nav", RandomExpressNav);
  }
})();
