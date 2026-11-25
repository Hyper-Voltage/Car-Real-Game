(() => {
  "use strict";
  let adapter = null;
  let account = { available: null, authenticated: false, user: null, csrf: "" };
  let currentRevision = 0;
  let remoteSave = null;
  let dirty = false;
  let localHealthy = true;
  let cloudHealthy = false;
  let saveTimer = 0;
  let pill = null;
  let conflictDialog = null;
  // Pause account writes from detection until the player picks a save. Cancel and Esc leave the pause in place.
  let conflictPending = false;
  let uploading = null;
  let nextUpload = null;
  let refreshingSession = false;
  let accountGeneration = 0;
  let changeCount = 0;
  const KEEPALIVE_LIMIT_BYTES = 60 * 1024; // browsers refuse keepalive bodies over 64 KB

  const stable = value => {
    // progress.php decodes saves to PHP arrays, so an empty {} comes back as []; both must compare as the same save.
    if (Array.isArray(value) && !value.length) return "{}";
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    return JSON.stringify(value);
  };
  const escapeHtml = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");

  // Which account saves came from this device, as [revision, fingerprint] pairs: the one it last matched, then uploads
  // whose answer it may never have seen because the page closed. A later visit that finds one of these on the account
  // knows its local copy is simply newer. Anything else came from another device and has to ask.
  const fingerprint = value => {
    const text = stable(value);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193); }
    return `${text.length}.${(hash >>> 0).toString(36)}`;
  };
  const syncKey = () => (adapter && account.user?.activityScope ? `rex-progress-sync:${adapter.projectId}:${account.user.activityScope}` : "");
  function readSynced() {
    try {
      const entries = syncKey() ? JSON.parse(window.localStorage.getItem(syncKey())) : null;
      return Array.isArray(entries) ? entries : [];
    } catch { return []; }
  }
  function writeSynced(entries) {
    try { if (syncKey()) window.localStorage.setItem(syncKey(), JSON.stringify(entries)); } catch { /* without storage, differences just ask */ }
  }
  const markSynced = (revision, payload) => writeSynced([[revision, fingerprint(payload)]]);
  const markSent = (revision, payload) => {
    const [first, ...rest] = [...readSynced(), [revision, fingerprint(payload)]];
    writeSynced([first, ...rest.slice(-3)]);
  };
  const cameFromThisDevice = save => {
    const id = fingerprint(save.payload);
    return readSynced().some(([revision, known]) => revision === save.revision && known === id);
  };

  function safeLocal() {
    try { return adapter?.readLocal?.() ?? null; }
    catch { localHealthy = false; renderPill("Browser saving failed"); return null; }
  }

  function payloadValid(payload) {
    try { return typeof adapter?.validate !== "function" || Boolean(adapter.validate(payload)); }
    catch { return false; }
  }

  function meaningful(payload = safeLocal()) {
    try { return Boolean(adapter?.isMeaningful?.(payload)); } catch { return false; }
  }

  function ensurePill() {
    if (pill) return pill;
    pill = document.createElement("aside");
    pill.className = "rex-progress-pill";
    pill.setAttribute("aria-live", "polite");
    pill.innerHTML = `<style>body>.rex-progress-pill{display:none!important}.rex-progress-pill{position:fixed;z-index:9000;right:max(12px,env(safe-area-inset-right));bottom:max(12px,env(safe-area-inset-bottom));max-width:min(360px,calc(100vw - 24px));display:flex;align-items:center;gap:.65rem;padding:.65rem .72rem .65rem .85rem;border:1px solid rgba(23,37,34,.24);border-radius:999px;background:rgba(255,253,248,.95);color:#172522;box-shadow:0 12px 36px rgba(0,0,0,.18);backdrop-filter:blur(14px);font:700 12px/1.2 Inter,system-ui,sans-serif}.rex-progress-pill[data-error=true]{border-color:#c95542}.rex-progress-pill span{min-width:0}.rex-progress-pill button{min-height:44px;padding:0 .8rem;border:0;border-radius:999px;background:#172522;color:white;font:inherit;cursor:pointer;white-space:nowrap}.rex-progress-pill button:focus-visible{outline:3px solid #d49a3a;outline-offset:2px}@media(max-width:480px){.rex-progress-pill{left:12px;right:12px;justify-content:space-between}}@media(prefers-reduced-motion:reduce){.rex-progress-pill{backdrop-filter:none}}</style><span data-progress-label>Saved on this device</span><button type="button" data-progress-action>Save to account</button>`;
    document.body.append(pill);
    pill.querySelector("button").addEventListener("click", () => saveNow({ openAccount: true }));
    return pill;
  }

  // Saving runs in the background. The shared status element never floats over an experience (body > pill is hidden);
  // experiences may still dock it inside their own save menus. Real save failures go to the admin Health page as errors.
  let status = { label: "", error: false };
  const reported = new Set();
  function reportSaveError(error) {
    const message = String(error?.message || error || "").slice(0, 300);
    // A dropped connection never reached the server and cannot be fixed by us; anything else needs a fix.
    if (!message || navigator.onLine === false || (error instanceof TypeError && !error.status)) return;
    const key = `${adapter?.projectId}|${message}`;
    if (reported.has(key)) return;
    reported.add(key);
    try { window.RandomExpressHealth?.report?.(new Error(`Save error (${adapter?.projectId || "unknown"}): ${message}`), { source: "assets/random-express-progress.js?v=20261112-session1" }); }
    catch { /* reporting must never break saving */ }
  }

  function renderPill(label = "") {
    if (!adapter) return;
    const root = ensurePill();
    const button = root.querySelector("button");
    if (!label) {
      if (conflictPending) label = adapter.deferConflicts ? "Two saves found. Review to sync." : "Choose which save to keep";
      else if (!localHealthy && !cloudHealthy) label = "Progress is not saved";
      else if (account.authenticated && account.user?.verified) label = cloudHealthy ? "Saved to your account" : dirty ? "Waiting to sync" : "Account save ready";
      else if (account.authenticated) label = cloudHealthy ? "Temporarily saved - confirm email" : "Pending account save";
      else label = localHealthy ? "Saved on this device" : "Browser saving failed";
    }
    root.querySelector("[data-progress-label]").textContent = label;
    const error = (!localHealthy && !cloudHealthy) || /failed|could not|conflict|version/i.test(label);
    root.dataset.error = String(error);
    if (status.label !== label || status.error !== error) {
      status = { label, error };
      try { window.dispatchEvent(new CustomEvent("random-express:progress-status", { detail: { projectId: adapter.projectId, ...status } })); }
      catch { /* a status event must never break saving */ }
    }
    button.textContent = conflictPending ? (adapter.deferConflicts ? "Review saves" : "Choose") : account.authenticated ? "Save now" : "Save to account";
    button.hidden = !meaningful(localHealthy ? safeLocal() : null) && !account.authenticated;
  }

  async function progressFetch(url, options = {}) {
    const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...options });
    const payload = await response.json().catch(() => ({ error: "Cloud saving returned an unreadable response." }));
    if (!response.ok) {
      const error = new Error(payload.error || "Cloud saving failed.");
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function normalizeRemote(save) {
    const fromVersion = Number(save?.schemaVersion || 0);
    let payload = save?.payload;
    let migrated = false;
    if (fromVersion !== adapter.schemaVersion) {
      if (typeof adapter.migrate !== "function") {
        throw new Error(`Account save version ${fromVersion} needs a project migration to version ${adapter.schemaVersion}.`);
      }
      payload = await adapter.migrate(payload, fromVersion);
      migrated = true;
    }
    if (!payloadValid(payload)) throw new Error("The account save is not valid for this version of the project.");
    return {
      ...save,
      schemaVersion: adapter.schemaVersion,
      payload,
      summary: migrated ? (adapter.summarize?.(payload) || {}) : (save.summary || {}),
      migrated,
    };
  }

  async function loadRemote() {
    if (!adapter || !account.authenticated) return;
    try {
      const response = await progressFetch(`/api/progress.php?project=${encodeURIComponent(adapter.projectId)}`);
      const storedSave = response.save || null;
      remoteSave = storedSave ? await normalizeRemote(storedSave) : null;
      currentRevision = Number(storedSave?.revision || 0);
      const local = safeLocal();
      if (!remoteSave) {
        if (meaningful(local)) await saveNow();
        else renderPill();
        return;
      }
      if (!meaningful(local)) {
        await adapter.applyLocal(remoteSave.payload);
        dirty = Boolean(remoteSave.migrated);
        cloudHealthy = !remoteSave.migrated;
        if (remoteSave.migrated) await saveNow();
        else { markSynced(currentRevision, remoteSave.payload); renderPill("Restored from your account"); }
        return;
      }
      if (stable(local) === stable(remoteSave.payload)) {
        dirty = Boolean(remoteSave.migrated);
        cloudHealthy = !remoteSave.migrated;
        if (remoteSave.migrated) await saveNow();
        else { markSynced(currentRevision, remoteSave.payload); renderPill(); }
        return;
      }
      // The player left before the last upload finished. The account still holds this device's own older save, so there is nothing to choose.
      if (cameFromThisDevice(remoteSave)) {
        dirty = true;
        await saveNow();
        return;
      }
      flagConflict(local, remoteSave);
    } catch (error) {
      cloudHealthy = false;
      if (error.payload?.code === 'kids_save_controls') { renderPill('Saved on this device'); return; }
      reportSaveError(error);
      renderPill(error.message || "Cloud saving is unavailable");
    }
  }

  async function saveNow(options = {}) {
    if (!adapter) return false;
    if (!account.authenticated) {
      if (options.openAccount) window.RandomExpressAccount?.open({ mode: "register", message: "Create an account without leaving this project, then this progress will be saved." });
      return false;
    }
    if (conflictPending) {
      // Keep saving in the browser while account writes wait for the player's choice.
      if (options.openAccount) showConflict(safeLocal(), remoteSave);
      else renderPill();
      return false;
    }
    if (uploading) {
      // One upload at a time, and repeat calls share the next one, so a slow network can't make this device conflict with itself.
      const again = () => { nextUpload = null; return saveNow(options); };
      nextUpload ||= uploading.then(again, again);
      return nextUpload;
    }
    uploading = upload(options).finally(() => { uploading = null; });
    return uploading;
  }

  async function upload(options, attempt = 0) {
    const payload = safeLocal();
    if (!meaningful(payload)) { renderPill("Nothing to save yet"); return true; }
    const blocked = adapter.uploadBlockReason?.(payload);
    if (blocked) { cloudHealthy = false; renderPill(blocked); return false; }
    if (!payloadValid(payload)) { localHealthy = false; reportSaveError("This device's save failed the project's own validation."); renderPill("Project save validation failed"); return false; }
    if (remoteSave && !remoteSave.migrated && remoteSave.revision === currentRevision && stable(payload) === stable(remoteSave.payload)) {
      // The account already holds exactly this. The server keeps 5 revisions, so don't spend one on a repeat.
      dirty = false;
      cloudHealthy = true;
      renderPill();
      return true;
    }
    renderPill("Saving...");
    const changesAtStart = changeCount;
    const requestGeneration = accountGeneration;
    const scope = account.user?.activityScope;
    const previousToken = account.csrf;
    try {
      const body = JSON.stringify({ projectId: adapter.projectId, schemaVersion: adapter.schemaVersion, baseRevision: currentRevision, payload, summary: adapter.summarize?.(payload) || {}, csrf: account.csrf });
      markSent(currentRevision + 1, payload);
      const result = await progressFetch("/api/progress.php", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        keepalive: Boolean(options.keepalive) && new Blob([body]).size <= KEEPALIVE_LIMIT_BYTES,
        body,
      });
      if (requestGeneration !== accountGeneration) return false;
      currentRevision = Number(result.revision || currentRevision + 1);
      remoteSave = { projectId: adapter.projectId, schemaVersion: adapter.schemaVersion, revision: currentRevision, payload, summary: result.summary || {}, updatedAt: result.updatedAt, migrated: false };
      markSynced(currentRevision, payload);
      dirty = changeCount !== changesAtStart;
      cloudHealthy = true;
      renderPill(account.user?.verified ? "Saved to your account" : "Temporarily saved - confirm email");
      return true;
    } catch (error) {
      if (requestGeneration !== accountGeneration) return false;
      cloudHealthy = false;
      if (error.payload?.code === 'kids_save_controls') {
        renderPill('Saved on this device');
        if (options.openAccount) location.assign('/kids-save/?project=' + encodeURIComponent(adapter.projectId));
        return false;
      }
      if (error.status === 403 && attempt === 0 && typeof window.RandomExpressAccount?.refresh === 'function') {
        try {
          refreshingSession = true;
          const fresh = await window.RandomExpressAccount.refresh();
          // Retry only for the same account with a genuinely renewed token. Never move a save between accounts.
          if (requestGeneration === accountGeneration && account.authenticated && account.user?.activityScope === scope && scope && fresh.available === true && fresh.authenticated && fresh.user?.activityScope === scope && fresh.csrf && fresh.csrf !== previousToken) {
            account = { ...fresh };
            return upload(options, 1);
          }
        } catch { /* Preserve the original failure and the device save if account refresh fails. */ } finally { refreshingSession = false; }
      }
      if (error.status === 409) {
        try {
          const fresh = await progressFetch(`/api/progress.php?project=${encodeURIComponent(adapter.projectId)}`);
          remoteSave = fresh.save ? await normalizeRemote(fresh.save) : null;
          currentRevision = Number(fresh.save?.revision || 0);
          if (remoteSave && stable(payload) === stable(remoteSave.payload)) {
            // Sign-in starts two uploads of the same save; the loser of that race has nothing to ask about.
            markSynced(currentRevision, payload);
            dirty = changeCount !== changesAtStart;
            cloudHealthy = true;
            renderPill();
            return true;
          }
          // An upload from this device got there first, such as the one sent as the page closed.
          if (remoteSave && attempt === 0 && cameFromThisDevice(remoteSave)) return upload({}, 1);
          if (remoteSave) flagConflict(payload, remoteSave);
          else renderPill("Save conflict - retry");
        } catch (fresh) { reportSaveError(fresh); renderPill("Save conflict - retry"); }
      } else { reportSaveError(error); renderPill(error.message || "Cloud save failed"); }
      return false;
    }
  }

  function changed(options = {}) {
    dirty = true;
    changeCount += 1;
    if (options.localSaved === false) localHealthy = false;
    else if (options.localSaved === true) localHealthy = true;
    renderPill();
    clearTimeout(saveTimer);
    if (account.authenticated) saveTimer = setTimeout(() => saveNow(), 900);
  }

  function uploadOnExit() {
    if (!adapter || !dirty || !account.authenticated || conflictPending || uploading) return;
    clearTimeout(saveTimer);
    saveNow({ keepalive: true });
  }

  function ensureConflict() {
    if (conflictDialog) return conflictDialog;
    conflictDialog = document.createElement("dialog");
    conflictDialog.className = "rex-progress-conflict";
    conflictDialog.innerHTML = `<style>.rex-progress-conflict{width:min(600px,calc(100% - 24px));padding:1.3rem;border:1px solid rgba(23,37,34,.24);border-radius:22px;background:#fffdf8;color:#172522;box-shadow:0 28px 90px rgba(0,0,0,.3);font:15px/1.45 Inter,system-ui,sans-serif}.rex-progress-conflict::backdrop{background:rgba(8,16,18,.58)}.rex-progress-conflict h2{margin:.2rem 0 .5rem;font:400 2.4rem/1 Georgia,serif}.rex-conflict-grid{display:grid;grid-template-columns:1fr 1fr;gap:.7rem;margin:1rem 0}.rex-conflict-card{padding:1rem;border:1px solid rgba(23,37,34,.2);border-radius:14px}.rex-conflict-card strong{display:block;margin-bottom:.4rem}.rex-conflict-card p{margin:.2rem 0;color:#65706a}.rex-conflict-actions{display:flex;gap:.5rem;flex-wrap:wrap}.rex-conflict-actions button{min-height:46px;padding:0 1rem;border:1px solid rgba(23,37,34,.22);border-radius:999px;background:transparent;color:#172522;font:inherit;font-weight:850;cursor:pointer}.rex-conflict-actions .primary{background:#172522;color:white}@media(max-width:520px){.rex-conflict-grid{grid-template-columns:1fr}}</style><p>Cloud save conflict</p><h2>Which progress should stay?</h2><p>Neither copy will change until you choose.</p><div class="rex-conflict-grid"><div class="rex-conflict-card" data-local></div><div class="rex-conflict-card" data-remote></div></div><div class="rex-conflict-actions"><button class="primary" type="button" data-choice="local">Keep this device</button><button type="button" data-choice="remote">Use account save</button><button type="button" data-choice="cancel">Cancel</button></div>`;
    document.body.append(conflictDialog);
    conflictDialog.addEventListener("click", handleConflict);
    return conflictDialog;
  }

  function summaryHtml(title, summary, updated) {
    const entries = Object.entries(summary || {}).slice(0, 4).map(([key, value]) => `<p>${escapeHtml(String(key).replace(/([A-Z])/g, " $1"))}: <b>${escapeHtml(value)}</b></p>`).join("");
    return `<strong>${escapeHtml(title)}</strong>${entries || "<p>Project progress</p>"}<p>${escapeHtml(updated || "Saved time unavailable")}</p>`;
  }

  function flagConflict(local, remote) {
    conflictPending = true;
    cloudHealthy = false;
    if (adapter.deferConflicts) renderPill();
    else showConflict(local, remote);
  }

  function showConflict(local, remote) {
    const root = ensureConflict();
    root.dataset.local = stable(local);
    root.querySelector("[data-local]").innerHTML = summaryHtml("This device", adapter.summarize?.(local), "Current browser");
    root.querySelector("[data-remote]").innerHTML = summaryHtml("Your account", remote?.summary, remote?.updatedAt ? new Date(remote.updatedAt).toLocaleString() : "Saved time unavailable");
    if (!root.open) root.showModal();
    renderPill();
  }

  async function handleConflict(event) {
    const choice = event.target.closest("[data-choice]")?.dataset.choice;
    if (!choice) return;
    if (choice === "cancel") { conflictDialog.close(); renderPill(); return; }
    if (choice === "remote") {
      await adapter.applyLocal(remoteSave.payload);
      conflictPending = false;
      dirty = Boolean(remoteSave.migrated);
      cloudHealthy = !remoteSave.migrated;
      conflictDialog.close();
      if (remoteSave.migrated) await saveNow();
      else { markSynced(currentRevision, remoteSave.payload); renderPill("Account save restored"); }
      return;
    }
    conflictPending = false;
    conflictDialog.close();
    await saveNow();
  }

  async function confirmLoss(options = {}) {
    if (!adapter || !meaningful()) return true;
    return new Promise(resolve => {
      const root = document.createElement("dialog");
      root.className = "rex-progress-loss";
      root.innerHTML = `<style>.rex-progress-loss{width:min(560px,calc(100% - 24px));padding:1.35rem;border:1px solid rgba(23,37,34,.24);border-radius:22px;background:#fffdf8;color:#172522;box-shadow:0 28px 90px rgba(0,0,0,.3);font:15px/1.45 Inter,system-ui,sans-serif}.rex-progress-loss::backdrop{background:rgba(8,16,18,.58)}.rex-progress-loss h2{margin:.2rem 0 .55rem;font:400 2.25rem/1 Georgia,serif}.rex-progress-loss p{color:#59645f}.rex-loss-actions{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:1rem}.rex-loss-actions button{min-height:46px;padding:0 1rem;border:1px solid rgba(23,37,34,.22);border-radius:999px;background:transparent;color:#172522;font:inherit;font-weight:850;cursor:pointer}.rex-loss-actions .primary{background:#172522;color:#fff}.rex-loss-actions .danger{border-color:#b84735;color:#9b2f20}.rex-loss-status{min-height:1.4em;margin:.7rem 0 0;font-weight:750}</style><p>${escapeHtml(options.eyebrow || "Unsaved progress")}</p><h2>${escapeHtml(options.title || "Save before continuing?")}</h2><p>${escapeHtml(options.message || "This action will replace progress on this device.")}</p><p class="rex-loss-status" data-loss-status aria-live="polite"></p><div class="rex-loss-actions"><button class="primary" type="button" data-loss="save">${escapeHtml(options.saveLabel || (account.authenticated ? "Save to account and continue" : "Create account and save"))}</button><button class="danger" type="button" data-loss="continue">${escapeHtml(options.continueLabel || "Continue and lose progress")}</button><button type="button" data-loss="cancel">Cancel</button></div>`;
      document.body.append(root);
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        root.close();
        root.remove();
        resolve(value);
      };
      root.addEventListener("cancel", event => { event.preventDefault(); finish(false); });
      root.addEventListener("click", async event => {
        const choice = event.target.closest("[data-loss]")?.dataset.loss;
        if (!choice) return;
        if (choice === "cancel") return finish(false);
        if (choice === "continue") return finish(true);
        const button = root.querySelector('[data-loss="save"]');
        const status = root.querySelector("[data-loss-status]");
        button.disabled = true;
        status.textContent = account.authenticated ? "Saving your progress..." : "Create an account in the window that opens, then choose save again.";
        const saved = await saveNow({ openAccount: true });
        button.disabled = false;
        if (saved) finish(true);
        else if (account.authenticated) status.textContent = "Progress could not be saved. Nothing has been replaced.";
      });
      root.showModal();
    });
  }

  function register(nextAdapter) {
    if (!nextAdapter || typeof nextAdapter.projectId !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(nextAdapter.projectId) || !Number.isInteger(nextAdapter.schemaVersion) || nextAdapter.schemaVersion < 1 || nextAdapter.schemaVersion > 1000 || typeof nextAdapter.readLocal !== "function" || typeof nextAdapter.applyLocal !== "function") {
      throw new TypeError("Invalid Random.Express progress adapter.");
    }
    if (adapter && adapter.projectId !== nextAdapter.projectId) throw new Error(`Progress is already connected to ${adapter.projectId}.`);
    adapter = {
      ...nextAdapter,
      isMeaningful: typeof nextAdapter.isMeaningful === "function" ? nextAdapter.isMeaningful : value => value !== null,
      summarize: typeof nextAdapter.summarize === "function" ? nextAdapter.summarize : () => ({}),
    };
    localHealthy = true;
    ensurePill();
    renderPill();
    if (typeof adapter.subscribe === "function") adapter.subscribe(changed);
    const accountState = window.RandomExpressAccount?.state;
    if (accountState) {
      account = { ...accountState };
      if (!account.loading) loadRemote();
    }
    return { changed, saveNow, confirmLoss, get state() { return { currentRevision, dirty, localHealthy, cloudHealthy, account }; } };
  }

  function connectLocalStorage(options) {
    if (!options || typeof options.storageKey !== "string" || !options.storageKey || options.storageKey.length > 160 || typeof options.validate !== "function") {
      throw new TypeError("connectLocalStorage requires storageKey and validate options.");
    }
    const storage = options.storage || window.localStorage;
    const readLocal = () => {
      const raw = storage.getItem(options.storageKey);
      if (raw === null) return null;
      const value = JSON.parse(raw);
      if (!options.validate(value)) throw new Error("Stored project progress is invalid.");
      return value;
    };
    const writeLocal = value => {
      if (!options.validate(value)) throw new TypeError("Project progress failed validation.");
      storage.setItem(options.storageKey, JSON.stringify(value));
      return true;
    };
    const project = register({
      projectId: options.projectId,
      schemaVersion: options.schemaVersion,
      validate: options.validate,
      isMeaningful: options.isMeaningful,
      summarize: options.summarize,
      migrate: options.migrate,
      deferConflicts: options.deferConflicts === true,
      readLocal,
      applyLocal: async value => {
        writeLocal(value);
        if (typeof options.onRestore === "function") await options.onRestore(value);
        else {
          window.dispatchEvent(new CustomEvent("random-express:progress-restored", { detail: { projectId: options.projectId, payload: value } }));
          if (options.reloadOnRestore !== false) window.location?.reload?.();
        }
      },
      subscribe: options.subscribe,
    });
    return {
      load(fallback = null) {
        try {
          const value = readLocal();
          return value === null ? (typeof fallback === "function" ? fallback() : fallback) : value;
        } catch {
          localHealthy = false;
          renderPill("Browser saving failed");
          return typeof fallback === "function" ? fallback() : fallback;
        }
      },
      save(value) {
        try {
          writeLocal(value);
          changed({ localSaved: true });
          return true;
        } catch {
          changed({ localSaved: false });
          return false;
        }
      },
      saveNow: options => saveNow(options),
      confirmLoss: options => confirmLoss(options),
      get state() { return project.state; },
    };
  }

  window.addEventListener("random-express:account-state", event => {
    const wasAuthenticated = account.authenticated;
    if (account.authenticated !== event.detail.authenticated || account.user?.activityScope !== event.detail.user?.activityScope) accountGeneration += 1;
    // Signing out ends what this device can vouch for: whoever plays next is not known to be the same player.
    if (wasAuthenticated && !event.detail.authenticated && syncKey()) { try { window.localStorage.removeItem(syncKey()); } catch { /* nothing to forget */ } }
    account = { ...event.detail };
    if (!account.authenticated) { conflictPending = false; if (conflictDialog?.open) conflictDialog.close(); }
    renderPill();
    if (adapter && account.authenticated && !refreshingSession && (!wasAuthenticated || remoteSave === null)) loadRemote();
    if (!account.authenticated) { currentRevision = 0; remoteSave = null; cloudHealthy = false; }
  });
  window.addEventListener("random-express:account-success", () => { if (adapter && window.RandomExpressAccount?.state.authenticated) saveNow(); });
  window.addEventListener("beforeunload", event => {
    if (adapter && meaningful() && dirty && !localHealthy && !cloudHealthy) { event.preventDefault(); event.returnValue = ""; }
  });
  // Page exit fires pagehide then visibilitychange, so waiting for visibilitychange also carries anything the experience wrote in its own pagehide handler.
  window.addEventListener("pagehide", () => { if (document.visibilityState === "hidden") uploadOnExit(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") uploadOnExit();
    else if (dirty && account.authenticated) { clearTimeout(saveTimer); saveTimer = setTimeout(() => saveNow(), 900); }
  });

  window.RandomExpressProgress = {
    register,
    connectLocalStorage,
    changed,
    saveNow,
    confirmLoss,
    markLocalSave(ok) { localHealthy = Boolean(ok); renderPill(); },
    get state() { return { currentRevision, dirty, localHealthy, cloudHealthy, account, status }; },
  };
})();
