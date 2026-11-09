/* Gemini Notebook Assistant v3.1.0 — Content Script
 * Injected into notebook.google.com (formerly notebooklm.google.com — the
 * domain moved in late July 2026; both are matched in manifest.json)
 * Features: bulk source delete checkboxes, Drive sync button, SPA nav handling,
 *           theme support, multi-account switcher, toolbar close/minimize.
 *
 * v3.1.0 fixes (see reports/03-content-script.md):
 *  - BUG 1 (CRITICAL): Delete now uses exact source ID extracted from DOM, not
 *    fuzzy bidirectional title matching. Falls back to EXACT title equality
 *    (not `includes`) only when no DOM source ID is available, with a warning.
 *  - BUG 2 (MAJOR): No more location.reload() after delete — rows are removed
 *    from the DOM directly, with a toast banner. Reload only as a fallback.
 *  - BUG 3 (MAJOR): Removed history.pushState/replaceState monkey-patches.
 *    Combined URL MutationObserver + popstate into a single debounced setup()
 *    (500ms) using a `setupTimer`.
 *  - BUG 4 (MAJOR): Combined the two document.body MutationObservers (URL
 *    change + checkbox rescan) into ONE observer with an efficient callback.
 *  - BUG 5 (MAJOR): Global listeners (click/resize/popstate/storage.onChanged)
 *    are added exactly once, guarded by a `listenersAdded` flag.
 *  - BUG 6 (MAJOR): Added close (×) and minimize buttons to the toolbar header,
 *    plus a floating "re-open" button. State persisted to storage.local.
 *  - BUG 7 (MAJOR): Active account is loaded from background
 *    (`get-active-account` with `list-accounts` fallback) and sent as
 *    `params.authuser` in every outbound message. Optional account switcher
 *    dropdown rendered in the toolbar header.
 *  - BUG 8 (MAJOR): After 3 failed source-list lookups, emits a console.warn
 *    AND a `log-warning` message to background (best-effort, no throw).
 *  - BUG 9 (MINOR): CSS class `.ms` renamed to `.nlm-ms` everywhere (JS + CSS)
 *    to avoid collisions with host-page elements. Toolbar root gets the
 *    `nlm-assistant-toolbar` scope class.
 *  - BUG 10 (MINOR): File header version is now "v3.1.0" (was "v3.1").
 *  - BUG 11 (MINOR): safeSendMessage now races against a 15s timeout. On
 *    timeout the user sees "Request timed out. Please try again." and the
 *    action buttons are re-enabled.
 */
(function() {
  'use strict';

  // ─── State ───
  let isEnabled = true;
  let isSyncEnabled = true;
  let currentNotebookId = null;
  let currentTheme = 'light';
  let currentAuthuser = 0;       // BUG 7 fix
  let accountsList = [];          // BUG 7 fix
  let addCheckboxesTimer = null;
  let sourceIdWarnedThisPass = false;  // v3.3.2 — throttle "no source ID" warnings
  let setupTimer = null;          // BUG 3 fix — debounced setup
  let sourceListMissCount = 0;    // BUG 8 fix — telemetry
  let listenersAdded = false;     // BUG 5 fix — add listeners once
  let bodyObserver = null;        // BUG 4 fix — single combined observer
  let lastUrl = location.href;

  // Source-row selectors — verified against notebooklm-py RPC reference
  // (live-captured 2026-06-15 from a real Chrome session).
  // Primary: ".single-source-container" (confirmed by notebooklm-py SOURCES_SELECTORS)
  // Fallbacks: common Angular Material patterns + generic source-card classes.
  const SOURCE_ROW_SELECTORS =
    '.single-source-container, source-list-item, [data-source-id], .source-item, .source-card, .source-row';
  const SOURCE_LIST_SELECTORS = '.sources-panel, .source-list, .sources-list, [aria-label="Sources"], [aria-label="Источники"]';

  // Storage keys
  const TOOLBAR_POS_KEY = 'nlm_ext_toolbar_pos';
  const TOOLBAR_HIDDEN_KEY = 'nlm_ext_toolbar_hidden';       // BUG 6 fix
  const TOOLBAR_COLLAPSED_KEY = 'nlm_ext_toolbar_collapsed'; // BUG 6 fix

  // ─── Safe messaging (handles context invalidation + 15s timeout) ───
  function isContextValid() {
    try {
      return !!chrome.runtime && !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  }

  async function safeSendMessage(msg) {
    if (!isContextValid()) {
      showReloadBanner();
      throw new Error('Extension was updated. Please reload the page.');
    }
    try {
      return await ExtensionClient.send(msg.cmd, msg.params || {}, {
        timeoutMs: ['delete-sources', 'sync-drive-sources'].includes(msg.cmd) ? 300000 : 30000
      });
    } catch (e) {
      if (e && e.message && e.message.includes('Extension context invalidated')) {
        showReloadBanner();
      }
      throw e;
    }
  }

  function showReloadBanner() {
    if (document.querySelector('#nlm-ext-reload-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'nlm-ext-reload-banner';
    banner.style.cssText = `
      position:fixed; top:0; left:0; right:0; z-index:999999;
      background:#ea4335; color:#fff; text-align:center;
      padding:10px 16px; font:500 14px/1.4 'Segoe UI',Roboto,sans-serif;
      cursor:pointer;
    `;
    banner.textContent = 'Gemini Notebook Assistant was updated. Click here to reload the page.';
    banner.addEventListener('click', () => location.reload());
    document.body.appendChild(banner);

    const toolbar = document.querySelector('.nlm-ext-toolbar');
    if (toolbar) toolbar.style.display = 'none';
  }

  // ─── Small HTML/attr escaper (defensive; icons are static) ───
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ─── Inject extension styles ───
  function injectStyles() {
    if (document.querySelector('#nlm-assistant-styles')) return;
    const style = document.createElement('style');
    style.id = 'nlm-assistant-styles';
    style.textContent = `
      /* Checkbox overlay on source items */
      .nlm-ext-checkbox-wrap {
        position: absolute;
        left: 4px;
        top: 50%;
        transform: translateY(-50%);
        z-index: 100;
        opacity: 0;
        transition: opacity 200ms;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
      }
      .nlm-ext-has-checkbox:hover .nlm-ext-checkbox-wrap,
      .nlm-ext-checkbox-wrap.is-checked {
        opacity: 1;
      }
      .nlm-ext-checkbox {
        width: 18px;
        height: 18px;
        cursor: pointer;
        accent-color: var(--nlm-ext-accent, #4285f4);
        margin: 0;
      }
      .nlm-ext-has-checkbox { position: relative !important; }

      /* Toolbar (scoped via .nlm-assistant-toolbar) */
      .nlm-ext-toolbar.nlm-assistant-toolbar {
        position: fixed;
        bottom: 20px;
        right: 20px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 6px 8px;
        background: var(--nlm-ext-bg, #fff);
        border: 1px solid var(--nlm-ext-border, #dadce0);
        border-radius: 16px;
        box-shadow: 0 4px 16px rgba(0,0,0,.12);
        z-index: 99999;
        font-family: 'Segoe UI', Roboto, sans-serif;
        user-select: none;
        touch-action: none;
        max-width: 380px;
      }
      .nlm-ext-toolbar.is-dragging {
        opacity: 0.85;
        box-shadow: 0 8px 32px rgba(0,0,0,.22);
        cursor: grabbing;
      }

      /* Toolbar header (drag handle + account select + min + close) */
      .nlm-ext-toolbar .nlm-ext-toolbar-header {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 2px 0;
      }
      .nlm-ext-toolbar .nlm-ext-toolbar-body {
        display: flex;
        gap: 8px;
        align-items: center;
      }
      .nlm-ext-toolbar.is-collapsed .nlm-ext-toolbar-body { display: none; }

      .nlm-ext-drag-handle {
        display: flex;
        align-items: center;
        cursor: grab;
        padding: 2px 4px 2px 0;
        color: var(--nlm-ext-muted, #5f6368);
        flex-shrink: 0;
        border-right: 1px solid var(--nlm-ext-border, #dadce0);
        margin-right: 4px;
      }
      .nlm-ext-drag-handle:active { cursor: grabbing; }
      .nlm-ext-drag-handle svg {
        width: 16px; height: 16px; fill: currentColor;
        opacity: 0.5; transition: opacity 150ms;
      }
      .nlm-ext-drag-handle:hover svg { opacity: 1; }

      .nlm-ext-account-select {
        font-family: inherit;
        font-size: 12px;
        padding: 4px 6px;
        border: 1px solid var(--nlm-ext-border, #dadce0);
        border-radius: 8px;
        background: var(--nlm-ext-bg2, #f0f1f3);
        color: var(--nlm-ext-text, #1f1f1f);
        max-width: 160px;
        cursor: pointer;
      }

      .nlm-ext-icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px; height: 26px;
        padding: 0;
        border: none;
        background: transparent;
        color: var(--nlm-ext-muted, #5f6368);
        cursor: pointer;
        border-radius: 6px;
        font-size: 0;
      }
      .nlm-ext-icon-btn:hover {
        background: var(--nlm-ext-bg2, #f0f1f3);
        color: var(--nlm-ext-text, #1f1f1f);
      }

      .nlm-ext-btn {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 16px;
        border: none;
        border-radius: 999px;
        font-family: 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: all 200ms;
        line-height: 1;
      }
      .nlm-ext-btn:hover { filter: brightness(0.92); }
      .nlm-ext-btn:disabled { opacity: 0.6; cursor: not-allowed; }

      .nlm-ext-btn-delete { background: #ea4335; color: #fff; }
      .nlm-ext-btn-sync   { background: #4285f4; color: #fff; }
      .nlm-ext-btn-select {
        background: var(--nlm-ext-bg2, #f0f1f3);
        color: var(--nlm-ext-text, #1f1f1f);
        border: 1px solid var(--nlm-ext-border, #dadce0);
      }

      .nlm-ext-count {
        font-size: 12px;
        color: var(--nlm-ext-muted, #5f6368);
        padding: 0 4px;
        white-space: nowrap;
      }

      /* Floating re-open button (BUG 6 fix) */
      .nlm-ext-reopen-btn {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 99998;
        padding: 8px 12px;
        border-radius: 999px;
        border: 1px solid var(--nlm-ext-border, #dadce0);
        background: var(--nlm-ext-bg, #fff);
        color: var(--nlm-ext-text, #1f1f1f);
        font: 500 12px/1 'Segoe UI', Roboto, sans-serif;
        cursor: pointer;
        box-shadow: 0 4px 16px rgba(0,0,0,.12);
      }
      .nlm-ext-reopen-btn:hover { filter: brightness(0.96); }

      /* Toast banner (BUG 2 fix) */
      .nlm-ext-toast {
        position: fixed;
        bottom: 80px;
        left: 50%;
        transform: translateX(-50%) translateY(20px);
        z-index: 999998;
        background: #1e1e2e;
        color: #fff;
        padding: 10px 18px;
        border-radius: 999px;
        font: 500 13px/1.4 'Segoe UI', Roboto, sans-serif;
        box-shadow: 0 4px 16px rgba(0,0,0,.24);
        opacity: 0;
        pointer-events: none;
        transition: opacity 200ms, transform 200ms;
      }
      .nlm-ext-toast.is-visible {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }

      /* Light theme */
      :root {
        --nlm-ext-bg: #fff;
        --nlm-ext-bg2: #f0f1f3;
        --nlm-ext-text: #1f1f1f;
        --nlm-ext-muted: #5f6368;
        --nlm-ext-border: #dadce0;
        --nlm-ext-accent: #4285f4;
      }
      :root[data-nlm-theme="dark"] {
        --nlm-ext-bg: #1e1e2e;
        --nlm-ext-bg2: #2a2a3e;
        --nlm-ext-text: #e0e0e0;
        --nlm-ext-muted: #9aa0a6;
        --nlm-ext-border: #3c3c5a;
        --nlm-ext-accent: #8ab4f8;
      }
    `;
    document.head.appendChild(style);
  }

  // ─── Apply theme ───
  function applyTheme(theme) {
    currentTheme = theme;
    document.documentElement.setAttribute('data-nlm-theme', theme);
  }

  // ─── Find source items in DOM ───
  function getSourceItems() {
    const visible = el => !!el.textContent?.trim() && el.offsetParent !== null && !el.closest('.nlm-assistant-toolbar');
    for (const selector of SOURCE_ROW_SELECTORS.split(', ')) {
      const items = Array.from(document.querySelectorAll(selector)).filter(visible);
      if (items.length) return items.filter(item => !items.some(other => other !== item && other.contains(item)));
    }
    // Generic list/drag selectors are only safe inside the Sources panel.
    const panel = document.querySelector(SOURCE_LIST_SELECTORS);
    return panel ? Array.from(panel.querySelectorAll('mat-list-option, .cdk-drag, [role="listitem"]')).filter(visible) : [];
  }

  // Only source-specific attributes or NotebookLM source links identify a
  // source. Titles, aria-labels and generic data-id fields are not IDs.
  function getSourceIdFromRow(row) {
    if (!row) return null;
    for (const attribute of ['data-source-id', 'ng-reflect-source-id', 'data-ng-source-id']) {
      const value = row.getAttribute(attribute) || row.querySelector(`[${attribute}]`)?.getAttribute(attribute);
      if (value) return value;
    }
    for (const link of row.querySelectorAll('a[href]')) {
      try {
        const url = new URL(link.getAttribute('href'), location.href);
        if (url.protocol !== 'https:' || !/^notebook(?:lm)?\.google\.com$/.test(url.hostname)) continue;
        if (url.pathname.match(/\/notebook\/([^/]+)/)?.[1] !== getNotebookIdFromUrl()) continue;
        const id = url.pathname.match(/\/source\/([A-Za-z0-9_-]+)/)?.[1] || url.searchParams.get('sourceId');
        if (id) return id;
      } catch (_) {}
    }
    return null;
  }

  // ─── Extract source title text from an item element (BUG 1 fix) ───
  // Narrower than before: only returns specific source-title text, NOT the
  // entire row (which can include metadata and leak into matching).
  function getSourceTitle(el) {
    const sourceButton = el.querySelector('.source-stretched-button[aria-label]');
    if (sourceButton?.getAttribute('aria-label')) return sourceButton.getAttribute('aria-label').trim();
    // v3.3.4: try source-title elements first
    const titleEl = el.querySelector(
      '.source-title-column, .source-title, [class*="source-title"]'
    );
    if (titleEl) return titleEl.textContent.trim();
    // v3.3.4: try aria-label on the source button (Gemini Notebook puts the
    // source title in aria-label, e.g. aria-label="VC4_CORE.md")
    const btn = el.querySelector('.source-stretched-button[aria-label]') || el.querySelector('button[aria-label], a[aria-label]');
    if (btn) {
      const label = btn.getAttribute('aria-label') || '';
      if (label) return label.trim();
    }
    const heading = el.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
    if (heading) return heading.textContent.trim();
    return '';
  }

  // ─── Extract notebook ID from URL ───
  function getNotebookIdFromUrl() {
    const match = location.pathname.match(/\/notebook\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;
  }

  // ─── Add checkboxes to source items (BUG 1, BUG 8 fix) ───
  function addCheckboxes() {
    if (!isEnabled || !getNotebookIdFromUrl()) return;

    // v3.3.5: skip on non-source-list pages. Gemini Notebook uses URL params
    // to indicate modal/overlay states where the source list isn't the main
    // content. Running addCheckboxes() there floods the console with
    // "selectors not matching" warnings.
    //   ?addSource=true     — "Add source" modal is open
    //   ?sourceId=...       — a single source is open in the source viewer
    //   ?chat=...           — chat focus mode
    //   ?notes=...          — notes panel focus
    // On these pages, source rows either aren't in the DOM or are obscured,
    // so we bail out early without warning.
    const url = location.href;
    const isNonSourceListPage =
      url.includes('addSource=true') ||
      /[?&]sourceId=/.test(url) ||
      /[?&]chat=/.test(url) ||
      /[?&]notes=/.test(url) ||
      /[?&]studio=/.test(url);
    if (isNonSourceListPage) {
      // Reset miss counter so we don't carry over a partial state from a
      // previous page; when the user navigates back to the source list,
      // addCheckboxes() will run fresh.
      sourceListMissCount = 0;
      return;
    }

    const items = getSourceItems();

    // BUG 8 fix: telemetry on missing source rows.
    // v3.3.7: changed from console.warn to console.debug. Angular lazy-loads
    // source rows — they may appear 5-10 seconds after page load on slow
    // connections. The MutationObserver will catch them when they arrive and
    // call addCheckboxes() again. Logging a visible warning here just alarms
    // the user for a transient state that resolves itself.
    if (items.length === 0) {
      sourceListMissCount++;
      if (sourceListMissCount >= 5) {  // v3.3.7: increased from 3 to 5
        // debug-level: invisible in the default DevTools "Errors" tab.
        // Only visible when "Verbose" logging level is enabled.
        console.debug(
          '[Gemini Notebook Assistant] Source rows not yet rendered after 5 checks. ' +
          'The MutationObserver will add checkboxes automatically when Angular ' +
          'renders them. (This is normal for slow connections / large notebooks.)'
        );
        sourceListMissCount = 0; // reset to avoid spamming
      }
      return;
    }
    sourceListMissCount = 0; // reset on success

    // v3.3.4: Gemini Notebook (Angular) does NOT expose source IDs in the DOM.
    // The source ID lives in Angular's component state (JavaScript memory), not
    // in HTML attributes. Confirmed by inspecting the live DOM:
    //   <div class="single-source-container ...">
    //     <button class="source-stretched-button" aria-label="VC4_CORE.md" ...>
    //   </div>
    // The aria-label contains the source TITLE, not a UUID. No data-source-id,
    // no href with /source/<id>, no data-id — nothing.
    //
    // Therefore: DOM-based ID extraction (strategies 1-7) will ALWAYS fail here.
    // This is EXPECTED, not an error. We silently add checkboxes without IDs,
    // and proactively fetch the source list via RPC to cache IDs by title match
    // (see ensureSourceIdCache below). The delete handler uses these cached IDs.
    //
    // No warning is logged — there's nothing wrong.

    let itemsNeedingCheckbox = [];
    for (const item of items) {
      if (item.querySelector('.nlm-ext-checkbox-wrap')) continue; // already has checkbox
      const sid = getSourceIdFromRow(item); // will return null for Gemini Notebook
      itemsNeedingCheckbox.push({ item, sourceId: sid });
    }

    itemsNeedingCheckbox.forEach(({ item, sourceId }) => {

      item.classList.add('nlm-ext-has-checkbox');
      if (sourceId) item.setAttribute('data-nlm-source-id', sourceId);

      const wrap = document.createElement('div');
      wrap.className = 'nlm-ext-checkbox-wrap';
      wrap.setAttribute('data-nlm-source-id', sourceId || '');

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'nlm-ext-checkbox';
      cb.setAttribute('aria-label', 'Select source for bulk delete');

      cb.addEventListener('change', () => {
        wrap.classList.toggle('is-checked', cb.checked);
        updateToolbar();
      });
      cb.addEventListener('click', (e) => e.stopPropagation());
      wrap.addEventListener('click', (e) => e.stopPropagation());

      wrap.appendChild(cb);
      item.prepend(wrap);
    });

    // v3.3.4: Proactively fetch the source list via RPC and cache source IDs
    // on the DOM rows by title match. Gemini Notebook doesn't expose IDs in
    // the DOM, so we get them from the API and cache them for instant delete.
    // Non-blocking — runs in the background after checkboxes are added.
    ensureSourceIdCache();
  }

  // ─── Fetch source list via RPC and cache IDs on DOM rows by title ───
  // Gemini Notebook (Angular) doesn't put source IDs in the DOM. We fetch the
  // notebook's source list from the API (get-notebook RPC via background),
  // match each DOM row by its title (from aria-label or .source-title), and
  // cache the source ID on the row's data-nlm-source-id attribute. This makes
  // delete instant (no API call needed at delete time) and reliable (uses exact
  // IDs, not fuzzy title matching).
  let sourceIdCachePromise = null;
  let sourceIdCacheNotebookId = null;
  let sourceIdCacheAuthuser = null;
  let sourceIdCacheSources = [];
  let sourceIdCacheAt = 0;
  let sourceIdCacheGeneration = 0;

  function invalidateSourceCache() {
    sourceIdCacheGeneration++;
    sourceIdCachePromise = null;
    sourceIdCacheNotebookId = null;
    sourceIdCacheSources = [];
    sourceIdCacheAt = 0;
  }

  function cacheSourceIds(apiSources) {
    const norm = text => (text || '').replace(/\s+/g, ' ').trim();
    const titles = new Map();
    for (const source of apiSources) {
      const key = norm(source.title);
      if (!titles.has(key)) titles.set(key, []);
      titles.get(key).push(source);
    }
    for (const row of getSourceItems()) {
      const exactId = getSourceIdFromRow(row);
      const matches = titles.get(norm(getSourceTitle(row))) || [];
      const source = apiSources.find(source => source.id === exactId) || (matches.length === 1 ? matches[0] : null);
      const wrap = row.querySelector('.nlm-ext-checkbox-wrap');
      if (source) row.setAttribute('data-nlm-source-id', source.id);
      else row.removeAttribute('data-nlm-source-id');
      if (wrap) wrap.setAttribute('data-nlm-source-id', source?.id || '');
    }
  }

  function ensureSourceIdCache() {
    const nbId = getNotebookIdFromUrl();
    if (!nbId) return;
    if (sourceIdCacheNotebookId === nbId && sourceIdCacheAuthuser === currentAuthuser) {
      if (sourceIdCachePromise) return sourceIdCachePromise;
      if (Date.now() - sourceIdCacheAt < 5000) { cacheSourceIds(sourceIdCacheSources); return; }
    }
    const generation = ++sourceIdCacheGeneration;
    const authuser = currentAuthuser;
    sourceIdCacheNotebookId = nbId;
    sourceIdCacheAuthuser = authuser;
    const request = (async () => {
      try {
        const resp = await safeSendMessage({
          cmd: 'get-sources',
          params: { notebookId: nbId, authuser }
        });
        if (generation !== sourceIdCacheGeneration || getNotebookIdFromUrl() !== nbId || currentAuthuser !== authuser) return;
        sourceIdCacheSources = Array.isArray(resp.sources) ? resp.sources : [];
        sourceIdCacheAt = Date.now();
        cacheSourceIds(sourceIdCacheSources);
      } catch (e) {
        // Non-fatal — delete will fall back to fetching at delete time
        console.debug('[Gemini Notebook Assistant] Source ID cache fetch failed:', e.message);
      }
    })();
    sourceIdCachePromise = request;
    request.finally(() => { if (sourceIdCachePromise === request) sourceIdCachePromise = null; });
    return request;
  }

  // ─── Debounced add checkboxes ───
  function scheduleAddCheckboxes(delay = 300) {
    if (addCheckboxesTimer) clearTimeout(addCheckboxesTimer);
    addCheckboxesTimer = setTimeout(addCheckboxes, delay);
  }

  // ─── Count checked ───
  function getCheckedCount() {
    return document.querySelectorAll('.nlm-ext-checkbox:checked').length;
  }

  // ─── Get all checkboxes ───
  function getAllCheckboxes() {
    return document.querySelectorAll('.nlm-ext-checkbox');
  }

  // ─── Toolbar position persistence ───
  function saveToolbarPosition(toolbar) {
    const pos = {
      left: toolbar.style.left || '',
      top: toolbar.style.top || '',
      right: toolbar.style.right || '',
      bottom: toolbar.style.bottom || ''
    };
    try {
      chrome.storage.local.set({ [TOOLBAR_POS_KEY]: pos });
    } catch (e) {}
  }

  function restoreToolbarPosition(toolbar) {
    try {
      chrome.storage.local.get(TOOLBAR_POS_KEY, (data) => {
        const pos = data[TOOLBAR_POS_KEY];
        if (!pos) return;
        if (pos.left && pos.top) {
          toolbar.style.left = pos.left;
          toolbar.style.top = pos.top;
          toolbar.style.right = 'auto';
          toolbar.style.bottom = 'auto';
          clampToViewport(toolbar);
        }
      });
    } catch (e) {}
  }

  function clampToViewport(toolbar) {
    const rect = toolbar.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = rect.left;
    let y = rect.top;
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x + rect.width > vw) x = Math.max(0, vw - rect.width);
    if (y + rect.height > vh) y = Math.max(0, vh - rect.height);
    toolbar.style.left = x + 'px';
    toolbar.style.top = y + 'px';
  }

  // ─── Make an element draggable via its handle ───
  function makeDraggable(toolbar) {
    const handle = toolbar.querySelector('#nlm-ext-drag-handle');
    if (!handle) return;

    let isDragging = false;
    let startX, startY, origX, origY;

    function onPointerDown(e) {
      if (e.button && e.button !== 0) return;
      e.preventDefault();
      isDragging = true;
      toolbar.classList.add('is-dragging');

      const rect = toolbar.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
      startX = e.clientX;
      startY = e.clientY;

      toolbar.style.left = origX + 'px';
      toolbar.style.top = origY + 'px';
      toolbar.style.right = 'auto';
      toolbar.style.bottom = 'auto';

      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    }

    function onPointerMove(e) {
      if (!isDragging) return;
      e.preventDefault();
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      toolbar.style.left = (origX + dx) + 'px';
      toolbar.style.top = (origY + dy) + 'px';
    }

    function onPointerUp() {
      if (!isDragging) return;
      isDragging = false;
      toolbar.classList.remove('is-dragging');
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      clampToViewport(toolbar);
      saveToolbarPosition(toolbar);
    }

    handle.addEventListener('pointerdown', onPointerDown);
  }

  // ─── Toast banner (BUG 2 fix) ───
  function showToast(message, durationMs = 3000) {
    let toast = document.querySelector('.nlm-ext-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'nlm-ext-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => {
      toast.classList.remove('is-visible');
    }, durationMs);
  }

  // ─── BUG 6 fix: toolbar hide / collapse ───
  function saveToolbarHidden(hidden) {
    try { chrome.storage.local.set({ [TOOLBAR_HIDDEN_KEY]: !!hidden }); } catch (e) {}
  }
  function saveToolbarCollapsed(collapsed) {
    try { chrome.storage.local.set({ [TOOLBAR_COLLAPSED_KEY]: !!collapsed }); } catch (e) {}
  }

  function setToolbarHidden(hidden) {
    const toolbar = document.querySelector('.nlm-ext-toolbar');
    const enabledHere = isEnabled && !!getNotebookIdFromUrl();
    if (toolbar) toolbar.style.display = !hidden && enabledHere ? 'flex' : 'none';

    let reopen = document.querySelector('.nlm-ext-reopen-btn');
    if (hidden && enabledHere) {
      if (!reopen) {
        reopen = document.createElement('button');
        reopen.className = 'nlm-ext-reopen-btn';
        reopen.innerHTML = '<i class="nlm-ms nlm-ms-select_all"></i> Gemini Notebook';
        reopen.title = 'Reopen Gemini Notebook Assistant toolbar';
        reopen.addEventListener('click', () => {
          saveToolbarHidden(false);
          setToolbarHidden(false);
        });
        document.body.appendChild(reopen);
      }
    } else if (reopen) {
      reopen.remove();
    }
  }

  function setToolbarCollapsed(collapsed) {
    const toolbar = document.querySelector('.nlm-ext-toolbar');
    if (!toolbar) return;
    toolbar.classList.toggle('is-collapsed', collapsed);
    const minBtn = document.getElementById('nlm-ext-min');
    if (minBtn) {
      // Minimize button shows an underscore ("_") when expanded (click to collapse)
      // and an expand icon when collapsed (click to expand). The underscore is
      // the standard window-minimize glyph, matching OS conventions.
      minBtn.innerHTML = collapsed
        ? '<i class="nlm-ms nlm-ms-expand"></i>'
        : '<i class="nlm-ms nlm-ms-minimize"></i>';
      minBtn.title = collapsed ? 'Expand' : 'Minimize';
      minBtn.setAttribute('aria-label', collapsed ? 'Expand' : 'Minimize');
    }
  }

  // Google defaults to account 0 when the page has no authuser parameter.
  function getPageAuthuser() {
    const query = new URLSearchParams(location.search).get('authuser');
    const path = location.pathname.match(/^\/u\/(\d+)\//)?.[1];
    const value = query ?? path ?? '0';
    return /^\d+$/.test(value) ? Number(value) : 0;
  }

  // ─── Account loading & switcher ───
  async function loadActiveAccount() {
    try {
      const resp = await safeSendMessage({ cmd: 'get-active-account', params: {} });
      accountsList = resp.accounts || [];
      if (!accountsList.length) accountsList = await safeSendMessage({ cmd: 'list-accounts', params: {} });
    } catch (e) {
      console.warn('[Gemini Notebook Assistant] Could not load accounts:', e.message);
    }
    currentAuthuser = getPageAuthuser();
    renderAccountSwitcher();
  }

  function renderAccountSwitcher() {
    const sel = document.getElementById('nlm-ext-account');
    if (!sel) return;
    if (!accountsList || accountsList.length <= 1) {
      sel.style.display = 'none';
      return;
    }
    sel.style.display = 'inline-block';
    sel.innerHTML = accountsList.map(a => {
      const val = String(a.authuser == null ? 0 : a.authuser);
      const label = a.email || a.name || ('Account ' + val);
      const selected = (Number(val) === currentAuthuser) ? 'selected' : '';
      return `<option value="${escapeHtml(val)}" ${selected}>${escapeHtml(label)}</option>`;
    }).join('');
  }

  let accountSwitchId = 0;
  async function setActiveAccount(authuser) {
    const switchId = ++accountSwitchId;
    try {
      const result = await safeSendMessage({ cmd: 'set-active-account', params: { authuser } });
      if (switchId !== accountSwitchId) return;
      if (result.superseded) { renderAccountSwitcher(); return; }
      location.assign(`${location.origin}/?authuser=${authuser}`);
    } catch (e) {
      if (switchId !== accountSwitchId) return;
      showToast('Account switch failed: ' + e.message);
      renderAccountSwitcher();
    }
  }

  // ─── Create floating toolbar ───
  function createToolbar() {
    if (document.querySelector('.nlm-ext-toolbar')) return;
    if (!isEnabled) return;

    const toolbar = document.createElement('div');
    toolbar.className = 'nlm-ext-toolbar nlm-assistant-toolbar'; // BUG 9 fix: scope class
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Gemini Notebook Assistant');
    toolbar.innerHTML = `
      <div class="nlm-ext-toolbar-header">
        <div class="nlm-ext-drag-handle" id="nlm-ext-drag-handle" title="Drag to move">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="10" r="1.5"/><circle cx="15" cy="10" r="1.5"/><circle cx="9" cy="15" r="1.5"/><circle cx="15" cy="15" r="1.5"/><circle cx="9" cy="20" r="1.5"/><circle cx="15" cy="20" r="1.5"/></svg>
        </div>
        <select id="nlm-ext-account" class="nlm-ext-account-select" title="Switch account" aria-label="Switch account"></select>
        <button class="nlm-ext-icon-btn" id="nlm-ext-min" title="Minimize" aria-label="Minimize">
          <i class="nlm-ms nlm-ms-minimize"></i>
        </button>
        <button class="nlm-ext-icon-btn" id="nlm-ext-close" title="Close" aria-label="Close toolbar">
          <i class="nlm-ms nlm-ms-close"></i>
        </button>
      </div>
      <div class="nlm-ext-toolbar-body">
        <button class="nlm-ext-btn nlm-ext-btn-select" id="nlm-ext-select-all">
          <i class="nlm-ms nlm-ms-select_all"></i> Select all
        </button>
        <span class="nlm-ext-count" id="nlm-ext-count">0 selected</span>
        <button class="nlm-ext-btn nlm-ext-btn-delete" id="nlm-ext-delete" style="display:none">
          <i class="nlm-ms nlm-ms-delete"></i> Delete
        </button>
        <button class="nlm-ext-btn nlm-ext-btn-sync" id="nlm-ext-sync" style="display:${isSyncEnabled ? 'inline-flex' : 'none'}">
          <i class="nlm-ms nlm-ms-sync"></i> Sync Drive
        </button>
      </div>
    `;
    document.body.appendChild(toolbar);

    makeDraggable(toolbar);
    restoreToolbarPosition(toolbar);
    renderAccountSwitcher();

    // Restore hidden / collapsed state from storage (BUG 6 fix)
    try {
      chrome.storage.local.get([TOOLBAR_HIDDEN_KEY, TOOLBAR_COLLAPSED_KEY], (data) => {
        if (data && data[TOOLBAR_COLLAPSED_KEY] === true) setToolbarCollapsed(true);
        if (data && data[TOOLBAR_HIDDEN_KEY] === true) setToolbarHidden(true);
      });
    } catch (e) {}

    // Close button (BUG 6 fix)
    document.getElementById('nlm-ext-close').addEventListener('click', () => {
      saveToolbarHidden(true);
      setToolbarHidden(true);
    });

    // Minimize button (BUG 6 fix)
    document.getElementById('nlm-ext-min').addEventListener('click', () => {
      const t = document.querySelector('.nlm-ext-toolbar');
      if (!t) return;
      const collapsed = !t.classList.contains('is-collapsed');
      saveToolbarCollapsed(collapsed);
      setToolbarCollapsed(collapsed);
    });

    // Account switcher (BUG 7 fix)
    document.getElementById('nlm-ext-account').addEventListener('change', (e) => {
      const val = Number(e.target.value);
      if (Number.isFinite(val)) setActiveAccount(val);
    });

    // Select all / Deselect all
    document.getElementById('nlm-ext-select-all').addEventListener('click', () => {
      const cbs = getAllCheckboxes();
      if (cbs.length === 0) return;
      const allChecked = Array.from(cbs).every(cb => cb.checked);
      const newState = !allChecked;
      cbs.forEach(cb => {
        if (cb.checked !== newState) {
          cb.checked = newState;
          const wrap = cb.closest('.nlm-ext-checkbox-wrap');
          if (wrap) wrap.classList.toggle('is-checked', newState);
        }
      });
      updateToolbar();
    });

    // Delete selected (BUG 1, 2, 11 fix)
    document.getElementById('nlm-ext-delete').addEventListener('click', handleDelete);

    // Sync Drive (BUG 11 fix)
    document.getElementById('nlm-ext-sync').addEventListener('click', handleSync);
  }

  // ─── BUG 1, 2, 11 fix: delete handler ───
  async function handleDelete() {
    const checked = document.querySelectorAll('.nlm-ext-checkbox:checked');
    if (!checked.length) return;

    const nbId = getNotebookIdFromUrl();
    if (!nbId) return;

    const btn = document.getElementById('nlm-ext-delete');
    if (!btn) return;
    btn.disabled = true;
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<i class="nlm-ms nlm-ms-hourglass_empty"></i> Deleting...';

    try {
      const authuser = currentAuthuser;
      const rows = [...new Set(Array.from(checked).map(cb => cb.closest('.nlm-ext-has-checkbox')).filter(Boolean))];
      const notebook = await safeSendMessage({ cmd: 'get-sources', params: { notebookId: nbId, authuser } });
      const apiSources = notebook.sources || [];
      const norm = text => (text || '').replace(/\s+/g, ' ').trim();
      const sourceIds = rows.map(row => {
        const exactId = getSourceIdFromRow(row);
        const exact = apiSources.find(source => source.id === exactId);
        if (exact) return exact.id;
        const matches = apiSources.filter(source => norm(source.title) === norm(getSourceTitle(row)));
        if (matches.length > 1) {
          throw new Error('Multiple sources share this title. Select them by ID in the extension Sources tab.');
        }
        if (matches.length !== 1) throw new Error('Could not determine every selected source ID. Refresh the source list and retry.');
        return matches[0].id;
      });
      if (!sourceIds.length || new Set(sourceIds).size !== rows.length) {
        throw new Error('The selected rows cannot be mapped to distinct source IDs. Use the extension Sources tab.');
      }
      if (getNotebookIdFromUrl() !== nbId || currentAuthuser !== authuser) throw new Error('The notebook changed. Please retry.');

      const confirmMsg = `Delete ${sourceIds.length} source(s)?`;
      if (!confirm(confirmMsg)) {
        btn.disabled = false;
        btn.innerHTML = origHtml;
        return;
      }

      const result = await safeSendMessage({
        cmd: 'delete-sources',
        params: { notebookId: nbId, sourceIds, authuser }
      });
      if (!result.success || result.deleted !== sourceIds.length) throw new Error('Source deletion was not confirmed');
      if (getNotebookIdFromUrl() === nbId && currentAuthuser === authuser) {
        rows.forEach(row => row.remove());
      }

      showToast(`Deleted ${sourceIds.length} source(s)`);

      // v3.3.4: invalidate the source ID cache so it re-fetches on next addCheckboxes
      invalidateSourceCache();
      ensureSourceIdCache();

      updateToolbar();
      btn.disabled = false;
      btn.innerHTML = origHtml;
      btn.style.display = 'none';
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      // v3.3.6: friendly handling of context-invalidation (extension was reloaded).
      // safeSendMessage already shows the red reload banner; here we just show a
      // concise toast and avoid a scary console.error + "Delete failed: ..." text.
      const isContextInvalid = msg.includes('Extension was updated') ||
                               msg.includes('Extension context invalidated');
      const isTimeout = msg.toLowerCase().includes('timed out');

      if (isContextInvalid) {
        // The reload banner is already shown by safeSendMessage — no need for
        // a console.error too. Just tell the user to reload.
        console.warn('[Gemini Notebook Assistant] Delete aborted: extension updated. Reload the page.');
        showToast('Extension was updated. Please reload the page, then try again.');
        btn.innerHTML = '<i class="nlm-ms nlm-ms-error"></i> Reload page';
      } else if (isTimeout) {
        console.error('[Gemini Notebook Assistant] Bulk delete timeout:', e);
        btn.innerHTML = '<i class="nlm-ms nlm-ms-error"></i> Timed out';
        showToast('Request timed out. Please try again.');
      } else {
        console.error('[Gemini Notebook Assistant] Bulk delete error:', e);
        btn.innerHTML = '<i class="nlm-ms nlm-ms-error"></i> Error';
        showToast('Delete failed: ' + msg);
      }
      setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = origHtml;
      }, 3000);
    }
  }

  // ─── BUG 11 fix: sync handler with timeout-aware UI ───
  async function handleSync() {
    const nbId = getNotebookIdFromUrl();
    if (!nbId) return;

    const btn = document.getElementById('nlm-ext-sync');
    if (!btn) return;
    btn.disabled = true;
    const origHtml = btn.innerHTML;
    btn.innerHTML = '<i class="nlm-ms nlm-ms-sync"></i> Syncing...';

    try {
      const result = await safeSendMessage({
        cmd: 'sync-drive-sources',
        params: { notebookId: nbId, authuser: currentAuthuser }
      });
      const r = (result && (result.results || (result.result && result.result.results))) || {};
      const synced = r.synced || 0;
      btn.innerHTML = `<i class="nlm-ms nlm-ms-check"></i> ${synced} synced`;
      showToast(`Synced ${synced} source(s) from Drive${r.errors ? ', ' + r.errors + ' errors' : ''}`);
      setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = origHtml;
      }, 3000);
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      const isContextInvalid = msg.includes('Extension was updated') ||
                               msg.includes('Extension context invalidated');
      const isTimeout = msg.toLowerCase().includes('timed out');

      if (isContextInvalid) {
        console.warn('[Gemini Notebook Assistant] Sync aborted: extension updated. Reload the page.');
        showToast('Extension was updated. Please reload the page, then try again.');
        btn.innerHTML = '<i class="nlm-ms nlm-ms-error"></i> Reload page';
      } else if (isTimeout) {
        console.error('[Gemini Notebook Assistant] Sync timeout:', e);
        btn.innerHTML = '<i class="nlm-ms nlm-ms-error"></i> Timed out';
        showToast('Request timed out. Please try again.');
      } else {
        console.error('[Gemini Notebook Assistant] Sync error:', e);
        btn.innerHTML = '<i class="nlm-ms nlm-ms-error"></i> Error';
        showToast('Sync failed: ' + msg);
      }
      setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = origHtml;
      }, 3000);
    }
  }

  // ─── Update toolbar state ───
  function updateToolbar() {
    const count = getCheckedCount();
    const countEl = document.getElementById('nlm-ext-count');
    const deleteBtn = document.getElementById('nlm-ext-delete');
    const selectBtn = document.getElementById('nlm-ext-select-all');

    if (countEl) countEl.textContent = `${count} selected`;
    if (deleteBtn) deleteBtn.style.display = count > 0 ? 'inline-flex' : 'none';

    if (selectBtn) {
      const cbs = getAllCheckboxes();
      const allChecked = cbs.length > 0 && Array.from(cbs).every(cb => cb.checked);
      selectBtn.innerHTML = allChecked
        ? '<i class="nlm-ms nlm-ms-select_all"></i> Deselect all'
        : '<i class="nlm-ms nlm-ms-select_all"></i> Select all';
    }
  }

  // ─── BUG 3, 4 fix: single combined MutationObserver on document.body ───
  // Watches for BOTH: URL changes (SPA nav) and source-list mutations.
  function startBodyObserver() {
    if (bodyObserver) bodyObserver.disconnect();
    bodyObserver = new MutationObserver((mutations) => {
      // (a) URL change → debounced setup()
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        scheduleSetup(500);
      }
      // (b) source-list change → debounced addCheckboxes()
      let sourceListChanged = false;
      for (const m of mutations) {
        if (m.target.closest?.('.nlm-assistant-toolbar, .nlm-ext-checkbox-wrap, .nlm-ext-toast')) continue;
        if (m.type === 'attributes' && m.target.closest?.(SOURCE_ROW_SELECTORS)) { sourceListChanged = true; break; }
        for (const node of [...m.addedNodes, ...m.removedNodes]) {
          if (node.nodeType === 1 && node.matches('.nlm-ext-checkbox-wrap')) continue;
          if (m.target.closest?.(SOURCE_ROW_SELECTORS) || m.target.matches?.(SOURCE_LIST_SELECTORS)) {
            sourceListChanged = true; break;
          }
          if (node.nodeType !== 1) continue;
          if (node.matches && node.matches(SOURCE_ROW_SELECTORS)) {
            sourceListChanged = true; break;
          }
          if (node.querySelector && node.querySelector(SOURCE_ROW_SELECTORS)) {
            sourceListChanged = true; break;
          }
        }
        if (sourceListChanged) break;
      }
      if (sourceListChanged) { invalidateSourceCache(); scheduleAddCheckboxes(200); }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true, attributes: true,
      attributeFilter: ['aria-label', 'data-source-id', 'href'] });
  }

  // ─── BUG 3 fix: debounced setup ───
  function scheduleSetup(delay = 500) {
    if (setupTimer) clearTimeout(setupTimer);
    setupTimer = setTimeout(() => {
      setupTimer = null;
      setup();
    }, delay);
  }

  // ─── Remove all extension-injected checkboxes ───
  function cleanupCheckboxes() {
    document.querySelectorAll('.nlm-ext-checkbox-wrap').forEach(el => el.remove());
    document.querySelectorAll('.nlm-ext-has-checkbox').forEach(el => {
      el.classList.remove('nlm-ext-has-checkbox');
      el.removeAttribute('data-nlm-source-id');
    });
  }

  // ─── BUG 5 fix: disconnect observers / clear timers (does NOT remove global
  // listeners — those are added once and live for the page lifetime) ───
  function cleanupObservers() {
    if (bodyObserver) { bodyObserver.disconnect(); bodyObserver = null; }
    if (setupTimer) { clearTimeout(setupTimer); setupTimer = null; }
    if (addCheckboxesTimer) { clearTimeout(addCheckboxesTimer); addCheckboxesTimer = null; }
  }

  // ─── Setup (called on each navigation, debounced) ───
  function setup() {
    const nbId = getNotebookIdFromUrl();
    if (!nbId) {
      currentNotebookId = null;
      invalidateSourceCache();
      // Not on a notebook page — hide UI
      const toolbar = document.querySelector('.nlm-ext-toolbar');
      if (toolbar) toolbar.style.display = 'none';
      const reopen = document.querySelector('.nlm-ext-reopen-btn');
      if (reopen) reopen.remove();
      cleanupCheckboxes();
      // Keep the body observer alive so we detect when the user navigates back.
      if (!bodyObserver) startBodyObserver();
      return;
    }

    // If notebook changed, clean up old checkboxes + reset the source-ID warning
    // throttle so the diagnostic warning can fire once on the new notebook too.
    if (currentNotebookId && currentNotebookId !== nbId) {
      cleanupCheckboxes();
      invalidateSourceCache();
      sourceIdWarnedThisPass = false;
    }
    currentNotebookId = nbId;
    const pageAuthuser = getPageAuthuser();
    if (currentAuthuser !== pageAuthuser) {
      currentAuthuser = pageAuthuser;
      invalidateSourceCache();
      renderAccountSwitcher();
    }
    if (!bodyObserver) startBodyObserver();
    if (!isEnabled) return;

    // Show/create toolbar (respecting hidden state)
    const existingToolbar = document.querySelector('.nlm-ext-toolbar');
    if (existingToolbar) {
      try {
        chrome.storage.local.get([TOOLBAR_HIDDEN_KEY], (data) => {
          if (data && data[TOOLBAR_HIDDEN_KEY] === true) {
            setToolbarHidden(true);
          } else {
            existingToolbar.style.display = 'flex';
          }
        });
      } catch (e) {
        existingToolbar.style.display = 'flex';
      }
      updateToolbar();
    } else {
      createToolbar();
    }

    addCheckboxes();
    startBodyObserver();
    // v3.3.7: retry with increasing delays for Angular lazy-loaded content.
    // Gemini Notebook can take 5-10s to render source rows on slow connections
    // or large notebooks. The MutationObserver also catches them when they arrive.
    setTimeout(addCheckboxes, 1000);
    setTimeout(addCheckboxes, 3000);
    setTimeout(addCheckboxes, 6000);
    setTimeout(addCheckboxes, 10000);
  }

  // ─── Listen for messages from popup/background ───
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.cmd === 'set-theme') {
      applyTheme(msg.theme);
      sendResponse({ success: true });
    }
    if (msg.cmd === 'ping') {
      sendResponse({ alive: true, notebookId: currentNotebookId, authuser: currentAuthuser });
    }
    // NOTE: we intentionally do NOT return true here for the synchronous cases
    // above. If a future async handler is added, return true from that branch.
  });

  // ─── Init ───
  async function init() {
    currentAuthuser = getPageAuthuser();
    document.documentElement.setAttribute('data-nlm-ext', 'v3');

    if (!isContextValid()) {
      console.warn('[Gemini Notebook Assistant] Extension context invalidated, skipping init.');
      return;
    }

    injectStyles();

    // Load settings
    try {
      const settings = await chrome.storage.sync.get(['enableBulkDelete', 'enableSyncDrive', 'theme']);
      isEnabled = settings.enableBulkDelete !== false;
      isSyncEnabled = settings.enableSyncDrive !== false;
      if (settings.theme) applyTheme(settings.theme);
    } catch (e) {}

    // CRITICAL: Run setup() IMMEDIATELY so the toolbar appears without delay.
    // loadActiveAccount() is fired in the background (not awaited) because it
    // can take up to 30s if the SW is asleep (two 15s timeouts for
    // get-active-account → list-accounts fallback). Blocking setup() on it
    // caused the toolbar to "disappear" for 30s on every page load.
    // The toolbar works fine with currentAuthuser=0 (default) until the
    // account loads; loadActiveAccount() calls renderAccountSwitcher() when
    // done, which updates the toolbar's account dropdown.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', setup);
    } else {
      setup();
    }

    // Load active account in the background (non-blocking). When it completes,
    // renderAccountSwitcher() updates the toolbar dropdown.
    loadActiveAccount().catch((e) => {
      console.warn('[Gemini Notebook Assistant] loadActiveAccount failed:', e.message);
    });

    // BUG 5 fix: add global listeners exactly ONCE.
    if (!listenersAdded) {
      listenersAdded = true;

      // SPA back/forward (BUG 3 fix: popstate only — no pushState/replaceState patches)
      window.addEventListener('popstate', () => scheduleSetup(500));
      window.navigation?.addEventListener('navigatesuccess', () => scheduleSetup(100));

      // Settings changes
      chrome.storage.onChanged.addListener((changes, ns) => {
        if (ns !== 'sync') return;
        if (changes.enableBulkDelete) {
          isEnabled = changes.enableBulkDelete.newValue !== false;
          const toolbar = document.querySelector('.nlm-ext-toolbar');
          const reopen = document.querySelector('.nlm-ext-reopen-btn');
          if (!isEnabled) {
            if (toolbar) toolbar.style.display = 'none';
            if (reopen) reopen.remove();
            cleanupCheckboxes();
          } else {
            setup();
          }
        }
        if (changes.enableSyncDrive) {
          isSyncEnabled = changes.enableSyncDrive.newValue !== false;
          const btn = document.getElementById('nlm-ext-sync');
          if (btn) btn.style.display = isSyncEnabled ? 'inline-flex' : 'none';
        }
        if (changes.theme) {
          applyTheme(changes.theme.newValue);
        }
      });

      // Debounced checkbox rescan on any click (Angular re-renders on click)
      document.addEventListener('click', () => scheduleAddCheckboxes(300));

      // Keep toolbar inside viewport on resize
      window.addEventListener('resize', () => {
        const toolbar = document.querySelector('.nlm-ext-toolbar');
        if (toolbar && toolbar.style.left && toolbar.style.left !== 'auto') {
          clampToViewport(toolbar);
        }
      });
    }
  }

  // Expose cleanup for tests / hot-reload scenarios (best-effort, no-op if unavailable)
  try {
    window.__nlmAssistantCleanup = cleanupObservers;
  } catch (e) {}

  init();
})();
