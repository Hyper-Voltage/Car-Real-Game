(() => {
  "use strict";
  if (window.RandomExpressAccount) return;
  if(document.documentElement.dataset.rexActivity!=="off"&&!window.__rexActivityLoading&&!/^\/(admin|api|account)(\/|$)/.test(location.pathname)){window.__rexActivityLoading=true;const load=()=>import('/assets/random-express-activity.mjs?v=20261118-acct1').catch(()=>{window.__rexActivityLoading=false;});if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',load,{once:true});else load();}

  const state = { available: null, authenticated: false, user: null, saves: [], csrf: "", loading: true };
  let dialog = null;
  let lastFocus = null;

  const escapeHtml = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const emit = () => window.dispatchEvent(new CustomEvent("random-express:account-state", { detail: { ...state } }));

  let refreshPromise = null;
  function refresh() {
    return refreshPromise ||= refreshState().finally(() => { refreshPromise = null; });
  }

  async function refreshState() {
    state.loading = true;
    try {
      // A stalled phone connection must not leave "Checking account status..." up forever.
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timer = controller && setTimeout(() => controller.abort(), 12000);
      let response;
      try { response = await fetch("/api/account.php", { credentials: "same-origin", cache: "no-store", ...(controller ? { signal: controller.signal } : {}) }); }
      finally { clearTimeout(timer); }
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.available === false || typeof payload.authenticated !== 'boolean') throw new Error('Account status unavailable.');
      state.available = true;
      state.authenticated = payload.authenticated;
      state.user = payload.user || null;
      state.saves = Array.isArray(payload.saves) ? payload.saves : [];
      state.profile = payload.profile || null;
      state.csrf = String(payload.csrf || state.csrf || "");
      state.message = String(payload.message || "");
    } catch {
      // A temporary network failure does not mean the user signed out.
      state.available = false;
    }
    state.loading = false;
    // The homepage can attach its listener after the first status request finishes.
    document.querySelectorAll('[data-cosmic-account]').forEach(button => {
      button.textContent = state.authenticated ? 'Account' : 'Sign in';
    });
    emit();
    return { ...state };
  }

  async function request(action, values = {}) {
    if (!state.csrf) await refresh();
    const response = await fetch("/api/account.php", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, csrf: state.csrf, ...values })
    });
    const payload = await response.json().catch(() => ({ error: "The account service returned an unreadable response." }));
    if (!response.ok) {
      const error = new Error(payload.error || payload.message || "The account request failed.");
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    // Wait out a status request started before the mutation, then read its result.
    if (refreshPromise) await refreshPromise;
    await refresh();
    try { localStorage.setItem('rex.account.changed', String(Date.now()) + ':' + Math.random()); } catch {}
    return payload;
  }

  // Sign-in started inside an experience comes back to it. /account/?return=/slug/ carries the page across a
  // full-page sign-in, and the register path is remembered so the email confirmation link can offer it again.
  const RETURN_KEY = "rex.account.returnTo";
  function safeReturn(value) {
    return typeof value === "string" && /^\/[a-z0-9][a-z0-9/-]*\/?$/.test(value) && !/^\/(account|admin|api|kids-save)(\/|$)/.test(value) ? value : null;
  }
  function returnTarget() {
    if (location.pathname !== "/account/") return null;
    return safeReturn(new URLSearchParams(location.search).get("return"));
  }
  function rememberReturn() {
    const path = location.pathname === "/account/" ? returnTarget() : safeReturn(location.pathname);
    if (!path) return;
    const nav = document.querySelector("random-express-nav");
    const title = (nav?.getAttribute("current-title") || document.title.split(/\s+[-|]\s+/)[0] || "").trim().slice(0, 80);
    try { localStorage.setItem(RETURN_KEY, JSON.stringify({ path, title, at: Date.now() })); } catch {}
  }
  function rememberedReturn() {
    try {
      const value = JSON.parse(localStorage.getItem(RETURN_KEY) || "null");
      if (value && safeReturn(value.path) && Date.now() - Number(value.at) < 8 * 86400000) return { path: value.path, title: String(value.title || "") };
    } catch {}
    return null;
  }
  function forgetReturn() { try { localStorage.removeItem(RETURN_KEY); } catch {} }

  function finishAuthentication(action) {
    const back = returnTarget();
    if (back) { forgetReturn(); location.replace(back + "?account_notice=" + (action === "register" ? "register" : "login")); return; }
    close();
    showSuccessToast(action);
    window.dispatchEvent(new CustomEvent('random-express:account-success', { detail: { action } }));
  }

  function showSuccessToast(action) {
    const toast = document.createElement('div');
    toast.className = 'rex-account-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.style.cssText = 'position:relative;z-index:1;width:max-content;max-width:calc(100vw - 32px);box-sizing:border-box;margin:8px auto;padding:10px 16px;border:1px solid #a98aff;border-radius:14px;background:#241b38;color:#fff;font:600 14px/1.5 system-ui;pointer-events:none;text-align:center';
    const header = document.querySelector('.cosmic-header');
    if (header) header.after(toast); else { toast.style.cssText += ';position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:2147483647;margin:0'; document.body.append(toast); }
    requestAnimationFrame(() => { toast.textContent = (action === 'register' ? 'Account created successfully.' : 'Signed in successfully.') + (state.user && !state.user.verified ? ' Check your email to confirm your account.' : ''); });
    setTimeout(() => toast.remove(), 6000);
  }

  function ensureDialog() {
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.className = "rex-account-dialog";
    dialog.setAttribute("aria-labelledby", "rex-account-title");
    if(!document.querySelector('[data-rex-signin-style]')){const style=document.createElement('link');style.rel='stylesheet';style.href='/assets/account/signin.css?v=20261118-acct1';style.dataset.rexSigninStyle='';document.head.append(style);}
    dialog.innerHTML = '<button class="rex-account-close" type="button" aria-label="Close sign in">&times;</button><div class="rex-account-layout"><div class="rex-account-card"><a class="rex-account-brand" href="/" aria-label="Random Express home"><img src="/assets/favicon.svg" alt="" width="34" height="34">Random Express</a><h2 id="rex-account-title" tabindex="-1">Sign in</h2><div data-account-view></div></div><div class="rex-account-art" aria-hidden="true"><picture><source media="(max-width:700px)" srcset="data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="><img src="/assets/account/signin-rocket.webp" width="800" height="1000" alt="" decoding="async"></picture></div></div>';
    document.body.append(dialog);
    dialog.querySelector(".rex-account-close").addEventListener("click", close);
    dialog.addEventListener("click", event => { event.stopPropagation(); if (event.target === dialog) close(); });
    // Game shortcuts and delegated mode handlers must not consume account interactions.
    for (const type of ['keydown', 'keyup', 'submit']) dialog.addEventListener(type, event => event.stopPropagation());
    dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
    dialog.querySelector("[data-account-view]").addEventListener("click", handleClick);
    dialog.querySelector("[data-account-view]").addEventListener("submit", handleSubmit);
    return dialog;
  }

  const googleIcon='<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285F4" d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11a9.4 9.4 0 0 1-4.1 6.2v5h6.6c3.9-3.6 6.1-8.7 6.1-14.9Z"/><path fill="#34A853" d="M24 44c5.5 0 10.1-1.8 13.5-4.9l-6.6-5c-1.8 1.2-4.1 2-6.9 2-5.3 0-9.8-3.6-11.4-8.5H5.8v5.2A20.4 20.4 0 0 0 24 44Z"/><path fill="#FBBC05" d="M12.6 27.6a12.2 12.2 0 0 1 0-7.2v-5.2H5.8a20.2 20.2 0 0 0 0 17.6l6.8-5.2Z"/><path fill="#EA4335" d="M24 11.9c3 0 5.6 1 7.7 3l5.7-5.7A19.5 19.5 0 0 0 24 4 20.4 20.4 0 0 0 5.8 15.2l6.8 5.2A12 12 0 0 1 24 11.9Z"/></svg>';
  // Google refuses sign-in inside app browsers (TikTok, Instagram, Facebook and other webviews), so say so up front.
  const inAppBrowser = /FBAN|FBAV|FB_IAB|FBIOS|Instagram|musical_ly|TikTok|BytedanceWebview|Snapchat|Pinterest|LinkedInApp|Line\/|; wv\)/i.test(navigator.userAgent || "");
  const googleBlock = () => inAppBrowser
    ? '<div class="rex-account-inapp" role="note"><strong>Google sign-in needs your phone’s browser.</strong><p>This app’s built-in browser can’t use Google. Open this page in Chrome or Safari, or sign in with email below.</p><button class="rex-account-action" type="button" data-copy-link>Copy page link</button></div><div class="rex-account-divider">or</div>'
    : '<button class="rex-account-google" type="button" data-google>'+googleIcon+'Continue with Google</button><div class="rex-account-divider">or</div>';
  function authForm(mode) {
    const register=mode==='register',forgot=mode==='forgot';
    return `<p class="rex-account-intro">${register?'Save your progress. Pick up on any device.':forgot?'We’ll email you a link to reset your password.':'Your next happy distraction awaits.'}</p>
    ${forgot?'':googleBlock()}
    <form class="rex-account-form" data-action="${forgot?'forgot':register?'register':'login'}">
    <label>Email<input name="email" type="email" inputmode="email" placeholder="you@example.com" autocomplete="${register?'email':'username'}" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="next" required maxlength="254"></label>
    ${forgot?'':'<label>Password<span class="rex-account-password"><input name="password" type="password" placeholder="'+(register?'At least 12 characters':'Your password')+'" autocomplete="'+(register?'new-password':'current-password')+'" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="'+(register?'next':'go')+'" required minlength="12" maxlength="128"><button class="rex-account-reveal" type="button" data-reveal aria-label="Show password">Show</button></span></label>'}
    ${register?'<label class="rex-account-check"><input name="acceptTerms" type="checkbox" value="true" required><span>I agree to the <a href="/terms/">Terms</a> and <a href="/privacy/">Privacy Policy</a>.</span></label>':''}
    <label class="rex-account-trap" aria-hidden="true">Company website<input name="company_website" tabindex="-1" autocomplete="off"></label><label class="rex-account-trap" aria-hidden="true">Fax<input name="fax_number" tabindex="-1" autocomplete="off"></label>
    <button class="rex-account-action primary" type="submit">${forgot?'Send reset link':register?'Create account':'Sign in'}</button></form>
    <div class="rex-account-links">${mode==='login'?'<button class="rex-account-link" type="button" data-mode="register">Create an account</button><button class="rex-account-link" type="button" data-mode="forgot">Forgot password?</button>':'<button class="rex-account-link" type="button" data-mode="login">Back to sign in</button>'}</div>
    ${forgot?'':'<p class="rex-account-legal">By continuing, you agree to our <a href="/terms/">Terms of Service</a> and <a href="/privacy/">Privacy Policy</a>.</p>'}`;
  }

  function render(mode = "login", message = "", error = false) {
    const view = ensureDialog().querySelector("[data-account-view]");
    dialog.dataset.mode=mode;
    dialog.querySelector("#rex-account-title").textContent=mode==="forgot"?"Reset password":state.authenticated?"Your account":mode==="register"?"Create an account":mode==="forgot"?"Reset password":"Sign in";
    if (state.loading) { view.innerHTML = '<p class="rex-account-message">Checking account status...</p>'; return; }
    if (state.available === false) { view.innerHTML = '<p class="rex-account-message error">We couldn’t reach your account just now. Check your connection and try again. Your progress keeps saving in this browser.</p><button class="rex-account-action primary" type="button" data-account-retry>Try again</button>'; return; }
    if (state.authenticated && state.user && mode !== "forgot") {
      const pending = !state.user.verified;
      const googleConnection = state.user.googleConnected === true
        ? '<span class="rex-account-provider-note" data-google-connected role="status">Google connected</span>'
        : state.user.googleConnected === false
          ? '<button class="rex-account-link" type="button" data-google>Connect Google</button>'
          : '<span class="rex-account-provider-note" role="status">Google connection status unavailable.</span>';
      view.innerHTML = `${message ? `<p class="rex-account-message ${error ? "error" : ""}" role="status">${escapeHtml(message)}</p>` : ""}<p class="rex-account-intro">Signed in as</p><p class="rex-account-email">${escapeHtml(state.user.email)}</p>${pending ? '<div class="rex-account-pending"><strong>Temporary cloud save</strong><p>Check your email to complete double opt-in. This pending account and its cloud saves expire after seven days.</p><button class="rex-account-action" type="button" data-account-action="resend">Resend verification</button></div>' : '<p class="rex-account-message">Email confirmed. Supported project progress can sync across devices.</p>'}<div class="rex-account-links"><a href="/account/">View profile & saves</a>${googleConnection}<button class="rex-account-link" type="button" data-mode="forgot">Set or reset password</button><button class="rex-account-link" type="button" data-account-action="logout">Sign out</button></div>`;
      return;
    }
    view.innerHTML = `${message ? `<p class="rex-account-message ${error ? "error" : ""}" role="status">${escapeHtml(message)}</p>` : ""}${authForm(mode)}`;
  }

  async function handleSubmit(event) {
    const form = event.target.closest("form[data-action]");
    if (!form) return;
    event.preventDefault();
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    const values = Object.fromEntries(new FormData(form));
    if (form.dataset.action === "register") rememberReturn();
    values.acceptTerms = form.elements.acceptTerms?.checked || false;
    try {
      const payload = await request(form.dataset.action, values);
      if (state.authenticated && (form.dataset.action === "login" || form.dataset.action === "register")) { finishAuthentication(form.dataset.action); return; }
      render(form.dataset.action === "forgot" ? "forgot" : "login", payload.message || "Account updated.");
      window.dispatchEvent(new CustomEvent("random-express:account-success", { detail: { action: form.dataset.action, payload } }));
    } catch (error) {
      render(form.dataset.action === "register" ? "register" : form.dataset.action === "forgot" ? "forgot" : "login", error.message, true);
    } finally { button.disabled = false; }
  }

  async function handleClick(event) {
    if (event.target.closest('[data-account-retry]')) { const b = event.target.closest('[data-account-retry]'); b.disabled = true; b.textContent = 'Checking...'; await refresh(); render(dialog.dataset.mode || 'login'); return; }
    if (event.target.closest('[data-copy-link]')) {
      const b = event.target.closest('[data-copy-link]'), url = location.origin + location.pathname;
      try { await navigator.clipboard.writeText(url); b.textContent = 'Link copied. Paste it in your browser.'; }
      catch { b.outerHTML = '<p class="rex-account-email">' + escapeHtml(url) + '</p>'; }
      return;
    }
    if(event.target.closest('[data-reveal]')){const b=event.target.closest('[data-reveal]'),input=b.parentElement.querySelector('input');input.type=input.type==='password'?'text':'password';b.textContent=input.type==='password'?'Show':'Hide';b.setAttribute('aria-label',b.textContent+' password');return;}
    if(event.target.closest('[data-google]')){const b=event.target.closest('[data-google]');b.disabled=true;try{if(!state.csrf)await refresh();const response=await fetch('/api/account-google.php',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({csrf:state.csrf,returnTo:location.pathname + location.search,acceptTerms:true})});const payload=await response.json();if(!response.ok)throw Error(payload.error||'Google sign-in is temporarily unavailable.');const target=new URL(payload.url);if(target.origin!=='https://accounts.google.com')throw Error('Invalid Google sign-in destination.');location.assign(target.href);}catch(error){render('login',error.message,true);}finally{b.disabled=false;}return;}
    const mode = event.target.closest("button[data-mode]")?.dataset.mode;
    if (mode) return render(mode);
    const action = event.target.closest("[data-account-action]")?.dataset.accountAction;
    if (!action) return;
    try {
      const payload = await request(action);
      if (action === "logout") render("login", payload.message);
      else render("register", payload.message);
    } catch (error) { render("register", error.message, true); }
  }

  async function open(options = {}) {
    const kidsProject = document.querySelector('meta[name="rex-kids-save-project"]')?.content;
    if (kidsProject) { location.assign('/kids-save/?project=' + encodeURIComponent(kidsProject)); return; }
    lastFocus = options.trigger || document.activeElement;
    if (state.available === null || state.loading) await refresh();
    if (state.authenticated && (options.trigger || document.activeElement)?.matches("[data-cosmic-account]")) { location.assign("/account/"); return; }
    ensureDialog();
    render(options.mode || "login", options.message || "");
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => dialog.querySelector("#rex-account-title")?.focus({preventScroll:true}));
  }

  function close() {
    if (dialog?.open) dialog.close();
    lastFocus?.focus?.({ preventScroll: true });
  }

  window.RandomExpressAccount = { state, refresh, request, open, close, returnTarget, rememberedReturn, forgetReturn };
  window.addEventListener("random-express:account-open", event => open(event.detail || {}));
  // Phones fire focus, visibilitychange and pageshow together on every app switch; one status check per 10 s
  // is enough there. A sign-in or sign-out in another tab (storage event) always checks right away.
  let lastResume = 0;
  const resume = force => {
    if (document.hidden || (squisharium && state.available === null)) return;
    if (force !== true && state.available === true && Date.now() - lastResume < 10000) return;
    lastResume = Date.now();
    refresh();
  };
  window.addEventListener('focus', resume);
  window.addEventListener('pageshow', event => { if (event.persisted) resume(true); });
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('storage', event => { if (event.key === 'rex.account.changed') resume(true); });
  const squisharium = document.querySelector('meta[name="rex-squisharium-privacy"]') !== null;
  const initialRefresh = squisharium ? Promise.resolve() : refresh();
  const notice = new URLSearchParams(location.search).get('account_notice');
  if (notice === 'login' || notice === 'register') {
    const url = new URL(location.href); url.searchParams.delete('account_notice');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    initialRefresh.then(() => { if (state.authenticated) showSuccessToast(notice); });
  }
  const oauthResult=new URLSearchParams(location.search).get('account_google');
  if(oauthResult){const url=new URL(location.href);url.searchParams.delete('account_google');history.replaceState(null,'',url.pathname+url.search+url.hash);if(oauthResult==='success'){initialRefresh.then(()=>{if(state.authenticated){if(location.pathname==='/')showSuccessToast('login');else finishAuthentication('login');}});return;}open({mode:'login',message:oauthResult==='link_required'?'Sign in with your password first, then connect Google from your account.':oauthResult==='cancelled'?'Google sign-in was cancelled. You can try again.':oauthResult==='expired'?'That Google sign-in timed out. Please try again.':'Google sign-in could not be completed. Please try again.'});}
})();
