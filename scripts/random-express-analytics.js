(() => {
  "use strict";
  // Share controls stay functional even when analytics is opted out.
  // Only an explicit sharing action scopes clipboard/prompt changes; unrelated copying is untouched.
  function installSharing() {
    if (window.RandomExpressSharing || /^\/(admin|api|account)(\/|$)/.test(location.pathname)) return;
    let intent = null;
    const currentIntent = () => intent && intent.until > Date.now() ? intent : null;
    const localHost = location.hostname.toLowerCase();
    const eligible = () => !["localhost", "127.0.0.1", "::1"].includes(localHost)
      && !navigator.webdriver && navigator.doNotTrack !== "1" && window.doNotTrack !== "1"
      && navigator.globalPrivacyControl !== true
      && !/bot|crawler|spider|slurp|headless|phantom|selenium|playwright|puppeteer|lighthouse|codex|openai|chatgpt/.test(navigator.userAgent.toLowerCase());
    function sendClick(event = "share_click", details = {source: "ingame"}) {
      if (!eligible()) return;
      try {
        const eventId = window.crypto?.randomUUID?.() || Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
        const body = JSON.stringify({human: true, event, eventId, path: location.pathname, ...details});
        if (!navigator.sendBeacon?.("/api/analytics.php", new Blob([body], {type: "application/json"}))) {
          fetch("/api/analytics.php", {method: "POST", credentials: "same-origin", keepalive: true, headers: {"Content-Type": "application/json"}, body}).catch(() => {});
        }
      } catch {}
    }
    function trackSocialClick(event) {
      if (!event.isTrusted || event.defaultPrevented || event.button !== (event.type === "auxclick" ? 1 : 0)) return;
      const link = event.target.closest?.("a[data-social][href]");
      if (!link) return;
      const platform = link.dataset.social;
      if (!["tiktok", "instagram", "x", "facebook"].includes(platform)) return;
      const footer = link.closest("random-express-footer .rxf-social");
      const homepage = location.pathname === "/" && link.closest("#cookie-social-strip, #home-socials");
      if (footer || homepage) sendClick("social_click", {source: footer ? "footer" : "homepage", platform});
    }
    document.addEventListener("click", trackSocialClick);
    document.addEventListener("auxclick", trackSocialClick);
    function tagUrl(value, source = "ingame") {
      if (typeof value !== "string" || !value.trim() || /^(?:blob|data|javascript|mailto):/i.test(value)) return value;
      try {
        const url = new URL(value, location.href);
        const own = url.origin === location.origin || (url.protocol === "https:" && /^(www\.)?random\.express$/i.test(url.hostname));
        if (!own || url.username || url.password || /^\/(admin|api|account|\.data)(\/|$)/.test(url.pathname)) return value;
        url.searchParams.delete("release");
        url.searchParams.delete("rx_share_via");
        const tag = source === "header" || source === "feedback" ? source : "ingame";
        url.searchParams.set("rx_share", tag);
        url.searchParams.set("utm_source", "random_express");
        url.searchParams.set("utm_medium", "share");
        url.searchParams.set("utm_campaign", tag + "_share");
        return url.href;
      } catch { return value; }
    }
    function tagText(value, source = "ingame", appendLink = false) {
      if (typeof value !== "string") return value;
      let linked = false, hasUrl = false;
      const tagged = value.replace(/https?:\/\/[^\s<>"']+/gi, match => {
        hasUrl = true;
        // Sentence punctuation is not part of a pasted URL.
        let bare = match;
        if (value.trim() !== match && (match.match(/\)/g) || []).length > (match.match(/\(/g) || []).length) bare = match.replace(/\)$/, "");
        const suffix = match.slice(bare.length);
        const next = tagUrl(bare, source);
        if (next !== bare) linked = true;
        return next + suffix;
      });
      return appendLink && !linked && !hasUrl ? tagged + "\n" + tagUrl(location.href, source) : tagged;
    }
    function replaceMethod(target, name, transform) {
      const original = target?.[name];
      if (typeof original !== "function") return;
      try {
        Object.defineProperty(target, name, {configurable: true, writable: true, value: function (...args) {
          try { args = transform(args); } catch {}
          // Invoke synchronously to preserve transient user activation and the original return/rejection.
          return Reflect.apply(original, this, args);
        }});
      } catch {}
    }
    replaceMethod(navigator, "share", args => {
      const data = args[0];
      if (!data || typeof data !== "object") return args;
      const tagged = typeof data.url === "string" ? new URL(data.url, location.href).searchParams.get("rx_share") : "";
      const source = currentIntent()?.source || (tagged === "header" || tagged === "feedback" ? tagged : "ingame");
      const next = {...data};
      if (typeof next.text === "string") next.text = tagText(next.text, source);
      if (typeof next.url === "string" && next.url) next.url = tagUrl(next.url, source);
      else if (typeof next.text !== "string" || !/https?:\/\//i.test(next.text)) next.url = tagUrl(location.href, source);
      return [next, ...args.slice(1)];
    });
    replaceMethod(navigator.clipboard, "writeText", args => {
      const scope = currentIntent();
      return scope ? [tagText(args[0], scope.source, true), ...args.slice(1)] : args;
    });
    function shareField(field) {
      if (!field?.matches?.("input,textarea")) return false;
      return /(?:share|invite).*(?:url|link)|(?:url|link).*(?:share|invite)/i.test((field.id || "") + " " + (field.getAttribute("aria-label") || ""))
        || field.matches("[data-share-link],.share-link");
    }
    function tagField(field, source = "ingame") {
      if (!field?.matches?.("input,textarea") || typeof field.value !== "string" || !/^https?:\/\//i.test(field.value)) return;
      const next = tagUrl(field.value, source);
      if (next !== field.value) field.value = next;
    }
    function prepareFields() {
      const scope = currentIntent();
      if (!scope) return;
      for (const field of document.querySelectorAll?.('input[id*="share"],textarea[id*="share"],input[id*="invite"],textarea[id*="invite"],[data-share-link],.share-link') || []) {
        if (shareField(field)) tagField(field, scope.source);
      }
    }
    replaceMethod(document, "execCommand", args => {
      const scope = currentIntent(), field = document.activeElement;
      if (String(args[0]).toLowerCase() === "copy" && (scope || shareField(field))) {
        if (field?.matches?.("input,textarea")) {
          const start = field.selectionStart, end = field.selectionEnd;
          if (Number.isInteger(start) && end > start) {
            const selected = field.value.slice(start, end), next = tagText(selected, scope?.source || "ingame", !!scope);
            if (next !== selected) {
              field.value = field.value.slice(0, start) + next + field.value.slice(end);
              field.setSelectionRange(start, start + next.length);
            }
          }
        }
      }
      return args;
    });
    replaceMethod(window, "prompt", args => {
      const scope = currentIntent();
      return scope && typeof args[1] === "string" && (/copy.*(?:link|url|result|score|challenge|invite)/i.test(String(args[0])) || /^https?:/i.test(args[1])) ? [args[0], tagText(args[1], scope.source, true), ...args.slice(2)] : args;
    });
    function isShareControl(button) {
      const id = button.id || "", name = button.className?.baseVal ?? button.className ?? "";
      const label = [button.getAttribute("aria-label"), button.getAttribute("title"), button.textContent].filter(Boolean).join(" ").trim();
      const action = ["data-action", "data-act", "data-h", "data-do", "data-tool"].map(key => button.getAttribute(key) || "").join(" ");
      if (/^(?:close|cancel|download|save (?:image|photo|png)|revoke|dismiss)\b/i.test(label)) return false;
      if (button.hasAttribute("data-close") || /(?:^|[-_\s])(?:close|cancel|revoke|download|dismiss)(?:$|[-_\s])/i.test(id + " " + action)) return false;
      if (/share/i.test(id + " " + name) || button.hasAttribute("data-share") || button.hasAttribute("data-rally") || /\bshare\b/i.test(action)) return true;
      if (location.pathname === "/dream-generator/" && (id === "copy-dream" || button.getAttribute("data-action") === "copy" && button.closest(".saved-actions"))) return true;
      if (/copy.*(?:link|invite|result|score|challenge)|(?:link|invite|result|score|challenge).*copy/i.test(id + " " + action)) return true;
      if (/^(?:share\b|copy (?:this )?(?:link|invite|result|score|challenge)|invite (?:a )?friend|challenge a friend|create (?:a )?share link)/i.test(label)) return true;
      return /^copy$/i.test(label) && !!button.closest('[id*="share"],[id*="invite"],[data-share-dialog],.share-dialog');
    }
    document.addEventListener("click", event => {
      if (event.isTrusted === false || (typeof event.button === "number" && event.button !== 0)) return;
      const path = event.composedPath?.() || [event.target];
      const button = path.find(node => node?.matches?.('button,a,[role="button"],input[type="button"],input[type="submit"]'));
      intent = null;
      if (!button || button.matches(":disabled") || button.getAttribute("aria-disabled") === "true") return;
      const header = path.some(node => node?.localName === "random-express-nav");
      if (header) {
        if (button.hasAttribute("data-share")) intent = {source: "header", until: Date.now() + 30000};
        return; // The header already logs its own press.
      }
      // The thumbs-up Share in the feedback strip logs its own press too.
      if (path.some(node => node?.localName === "random-express-feedback")) {
        if (button.hasAttribute("data-share")) intent = {source: "feedback", until: Date.now() + 30000};
        return;
      }
      if (!isShareControl(button)) return;
      intent = {source: "ingame", until: Date.now() + 30000};
      sendClick();
      // Share dialogs commonly set their link value in the button's own handler.
      Promise.resolve().then(prepareFields);
      if (button.matches("a[href]")) {
        const href = button.getAttribute("href");
        if (/^https?:\/\//i.test(href || "")) {
          const url = new URL(href, location.href);
          if (/^(?:www\.)?(?:facebook\.com|twitter\.com|x\.com|wa\.me|api\.whatsapp\.com|t\.me|reddit\.com|linkedin\.com)$/i.test(url.hostname)) {
            for (const key of ["url", "u", "text"]) if (url.searchParams.has(key)) url.searchParams.set(key, tagText(url.searchParams.get(key), "ingame"));
            button.href = url.href;
          }
        }
      }
    }, true);
    document.addEventListener("focusin", event => {
      if (shareField(event.target)) tagField(event.target, currentIntent()?.source || "ingame");
    }, true);
    document.addEventListener("select", event => {
      const field = event.target, scope = currentIntent();
      if (!field?.matches?.("input,textarea") || (!shareField(field) && !(scope && field.readOnly))) return;
      const value = field.value, next = tagText(value, scope?.source || "ingame");
      if (next !== value) {
        const selectedAll = field.selectionStart === 0 && field.selectionEnd === value.length;
        field.value = next;
        if (selectedAll) field.setSelectionRange(0, next.length);
      }
    }, true);
    document.addEventListener("copy", event => {
      const scope = currentIntent(), field = document.activeElement;
      if (!event.clipboardData || (!scope && !shareField(field))) return;
      const selected = field?.matches?.("input,textarea") && Number.isInteger(field.selectionStart)
        ? field.value.slice(field.selectionStart, field.selectionEnd) : document.getSelection?.()?.toString() || "";
      const next = tagText(selected, scope?.source || "ingame");
      if (selected && next !== selected) { event.clipboardData.setData("text/plain", next); event.preventDefault(); }
    }, true);
    window.RandomExpressSharing = Object.freeze({version: "20261102-ingame1", feedback: true, url: tagUrl, text: tagText});
  }
  installSharing();
  if (window.__randomExpressEngagementLoaded) return;
  window.__randomExpressEngagementLoaded = true;
  const shouldSendView = window.__randomExpressAnalyticsVersion !== "20261102-ingame1";
  window.__randomExpressAnalyticsVersion = "20261102-ingame1";
  window.__randomExpressAnalyticsLoaded = true;

  const host = location.hostname.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return;
  if (location.pathname.startsWith("/admin")) return;
  if (navigator.webdriver || navigator.doNotTrack === "1" || window.doNotTrack === "1" || navigator.globalPrivacyControl === true) return;
  if (/bot|crawler|spider|slurp|headless|phantom|selenium|playwright|puppeteer|lighthouse|codex|openai|chatgpt/.test(userAgent)) return;

  function postAnalytics(payload) {
    const body = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon?.("/api/analytics.php", new Blob([body], { type: "application/json" }))) return;
    } catch {}
    fetch("/api/analytics.php", { method: "POST", credentials: "same-origin", keepalive: true, headers: { "Content-Type": "application/json" }, body }).catch(() => {});
  }

  function trackEngagement(path, device) {
    const reportInterval = 60000;
    const idleLimit = 300000;
    let visitId, started, elapsed, reported;
    let sampledAt = null, activeUntil = 0, timer;

    function newVisit() {
      visitId = window.crypto?.randomUUID?.() || Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
      started = Math.floor(Date.now() / 1000);
      elapsed = reported = 0;
    }

    function sample(now) {
      if (sampledAt !== null) elapsed += Math.max(0, Math.min(now, activeUntil) - sampledAt);
      sampledAt = now;
    }

    function report() {
      const milliseconds = Math.floor(elapsed);
      if (milliseconds >= 1000 && milliseconds > reported) {
        postAnalytics({ human: true, event: "engagement", path, device, visitId, started, elapsed: milliseconds });
        reported = milliseconds;
      }
      // Keep very long-lived pages within the server's bounded retry history.
      if (Date.now() / 1000 - started >= 23 * 3600) newVisit();
    }

    function schedule(now) {
      if (timer !== undefined || now >= activeUntil) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (document.visibilityState !== "visible" || sampledAt === null) return;
        const tick = performance.now();
        sample(tick);
        report();
        schedule(tick);
      }, Math.min(reportInterval, activeUntil - now));
    }

    function markActivity(event) {
      if (document.visibilityState !== "visible" || event?.isTrusted === false) return;
      const now = performance.now();
      if (activeUntil - now > idleLimit - 1000) return;
      if (sampledAt === null || now >= activeUntil) {
        sample(now);
        report();
      }
      activeUntil = now + idleLimit;
      schedule(now);
    }

    function stop() {
      if (sampledAt === null) return;
      sample(performance.now());
      report();
      sampledAt = null;
      activeUntil = 0;
      clearTimeout(timer);
      timer = undefined;
    }

    newVisit();
    markActivity();
    for (const event of ["pointerdown", "pointermove", "keydown", "wheel"]) {
      document.addEventListener(event, markActivity, { capture: true, passive: true });
    }
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") markActivity();
      else stop();
    });
    window.addEventListener("pagehide", stop);
    window.addEventListener("pageshow", markActivity);
  }

  let sent = false;
  function sendView() {
    if (sent || document.visibilityState !== "visible") return;
    sent = true;
    document.removeEventListener("visibilitychange", sendView);
    let referrer = "direct";
    try {
      if (document.referrer) {
        const source = new URL(document.referrer);
        if (source.hostname === location.hostname) {
          const incoming = new URLSearchParams(location.search);
          const forwarded = location.pathname === "/world-rumble/" && source.pathname === "/world-rumble/share.php"
            && incoming.get("rx_share_via") === "world-rumble"
            && ["header", "ingame"].includes(incoming.get("rx_share"))
            && source.searchParams.get("rx_share") === incoming.get("rx_share");
          referrer = forwarded ? "shared" : "internal";
        } else referrer = source.hostname;
      }
    } catch {}
    const width = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
    const shareSource = ["header", "ingame", "feedback"].includes(new URLSearchParams(location.search).get("rx_share")) && referrer !== "internal" ? new URLSearchParams(location.search).get("rx_share") : null;
    const path = location.pathname;
    const device = width < 640 ? "mobile" : width < 1024 ? "tablet" : "desktop";
    if (shouldSendView) postAnalytics({ human: true, shareSource, path, device, referrer });
    if (!document.querySelector('meta[name="rex-kids-page"]') && !/^\/(api|account|\.data)(\/|$)/i.test(path)) {
      trackEngagement(path, device);
    }
  }

  function start() {
    if (document.visibilityState === "visible") sendView();
    else document.addEventListener("visibilitychange", sendView);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
