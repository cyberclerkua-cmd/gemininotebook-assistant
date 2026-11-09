/* Gemini Notebook Assistant v3.3.9 — Popup Logic */

// ─── Helpers ───
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);
const bg = (cmd, params = {}) => ExtensionClient.send(cmd, { authuser: currentAuthuser, ...params }, {
  timeoutMs: ['add-as-pdf', 'sync-drive-sources', 'parse-rss', 'add-sources', 'delete-sources'].includes(cmd) ? 300000 : 30000
});

// i18n helper — returns the key itself if I18n isn't ready / key missing
function t(key, substitutions = {}) {
  if (typeof I18n !== 'undefined' && typeof I18n.get === 'function') {
    return I18n.get(key, substitutions);
  }
  return key;
}

function showStatus(elId, msg, type, duration = 4000) {
  let el = $(elId);
  if (el?.closest('.panel') && !el.closest('.panel').classList.contains('active')) {
    el = $('.panel.active .status') || el;
  }
  if (!el) return;
  clearTimeout(el._statusTimer);
  el.textContent = msg;
  el.className = `status show ${type}`;
  if (duration > 0) el._statusTimer = setTimeout(() => { el.className = 'status'; }, duration);
}

// Escapes <, >, &, " and ' so the output is safe in BOTH text content AND
// double-quoted attribute values (e.g. data-url="${escapeHtml(u)}").
function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return t('timeJustNow');
  if (diff < 3600000) return t('timeMinutesAgo', { COUNT: Math.floor(diff / 60000) });
  if (diff < 86400000) return t('timeHoursAgo', { COUNT: Math.floor(diff / 3600000) });
  return new Date(ts).toLocaleDateString();
}

// Source type → icon mapping
const sourceIcons = {
  google_docs: 'ms-description',
  google_other: 'ms-cloud',
  pdf: 'ms-picture_as_pdf',
  pasted_text: 'ms-edit_note',
  web_page: 'ms-language',
  generated_text: 'ms-auto_fix_high',
  youtube: 'ms-smart_display',
  uploaded_file: 'ms-upload_file',
  image: 'ms-image',
  word_doc: 'ms-article',
  unknown: 'ms-help_outline'
};

// ─── State ───
let currentNotebookId = null;
let currentAuthuser = 0;
let accountSelectionId = 0;
let notebookLoadId = 0;
let sourceLoadId = 0;
let pendingPdf = null;
let parseTimer = null;
let currentParseId = null;

// ═══════════════════════════════════════
// TAB NAVIGATION
// ═══════════════════════════════════════
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $(`#panel-${tab.dataset.tab}`).classList.add('active');

    // Lazy-load data when tab activated
    if (tab.dataset.tab === 'queue') loadQueue();
    if (tab.dataset.tab === 'organize') loadSources();
    if (tab.dataset.tab === 'history') loadHistory();
    if (tab.dataset.tab === 'parsers') checkYouTubeTab();
  });
});

// ═══════════════════════════════════════
// THEME
// ═══════════════════════════════════════
async function initTheme() {
  const data = await chrome.storage.sync.get(['theme']);
  const theme = data.theme || 'light';
  applyTheme(theme);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const headerSel = $('#theme-select');
  if (headerSel) headerSel.value = theme;
  $('#settings-theme').value = theme;
  // Sync to content script (query both old and new domains — Google moved
  // notebooklm.google.com → notebook.google.com in late July 2026)
  chrome.tabs.query({ url: ['https://notebook.google.com/*', 'https://notebooklm.google.com/*'] }, tabs => {
    tabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, { cmd: 'set-theme', theme }).catch(() => {});
    });
  });
}

// Theme only controlled from Settings tab
$('#settings-theme').addEventListener('change', async (e) => {
  const theme = e.target.value;
  try {
    await chrome.storage.sync.set({ theme });
  } catch (err) {
    showStatus('#home-status', `Error saving theme: ${err.message}`, 'error');
    return;
  }
  applyTheme(theme);
});

// ═══════════════════════════════════════
// i18n
// ═══════════════════════════════════════
async function initI18n() {
  if (typeof I18n !== 'undefined') {
    await I18n.init();
  }
}

// ═══════════════════════════════════════
// ACCOUNTS
// ═══════════════════════════════════════
async function loadAccounts() {
  const loadId = ++accountSelectionId;
  const select = $('#account-select');
  select.innerHTML = '<option value="">Loading...</option>';
  try {
    const accounts = await bg('list-accounts');
    if (loadId !== accountSelectionId) return;
    select.innerHTML = '';
    if (Array.isArray(accounts) && accounts.length > 0) {
      const active = await bg('get-active-account');
      if (loadId !== accountSelectionId) return;
      const activeAuthuser = active.authuser;

      accounts.forEach(acc => {
        const opt = document.createElement('option');
        opt.value = acc.authuser;
        opt.textContent = `${acc.name || acc.email} (${acc.email})`;
        select.appendChild(opt);
      });

      // Select the persisted account if present in the list, else the first one
      const exists = accounts.some(a => Number(a.authuser) === Number(activeAuthuser));
      const selectedAuthuser = exists ? Number(activeAuthuser) : Number(accounts[0].authuser);
      select.value = String(selectedAuthuser);
      currentAuthuser = selectedAuthuser;

      if (!exists) await selectAccount(selectedAuthuser);
      else await loadNotebooks();
    } else {
      select.innerHTML = '<option value="">No accounts found</option>';
    }
  } catch (e) {
    if (loadId !== accountSelectionId) return;
    select.innerHTML = '<option value="">Error loading accounts</option>';
    showStatus('#home-status', `Error: ${e.message}`, 'error');
  }
}

async function selectAccount(authuser) {
  const selectionId = ++accountSelectionId;
  currentAuthuser = authuser;
  currentNotebookId = null;
  currentSources = [];
  notebookLoadId++;
  sourceLoadId++;
  $('#notebook-select').disabled = true;
  $('#notebook-select').innerHTML = '<option value="">Loading...</option>';
  try {
    const result = await bg('set-active-account', { authuser });
    if (selectionId !== accountSelectionId) return;
    currentAuthuser = result.authuser;
    $('#account-select').value = String(currentAuthuser);
    await loadNotebooks();
  } catch (err) {
    if (selectionId !== accountSelectionId) return;
    const active = await bg('get-active-account').catch(() => null);
    if (selectionId !== accountSelectionId) return;
    if (active) {
      currentAuthuser = active.authuser;
      $('#account-select').value = String(currentAuthuser);
      await loadNotebooks();
    }
    if (selectionId !== accountSelectionId) return;
    showStatus('#home-status', `Error: ${err.message}`, 'error');
  }
}
$('#account-select').addEventListener('change', e => {
  selectAccount(Number(e.target.value));
});

// ═══════════════════════════════════════
// NOTEBOOKS
// ═══════════════════════════════════════
async function loadNotebooks() {
  const select = $('#notebook-select');
  const loadId = ++notebookLoadId;
  const authuser = currentAuthuser;
  select.disabled = true;
  currentNotebookId = null;
  currentSources = [];
  sourceLoadId++;
  select.innerHTML = '<option value="">Loading...</option>';
  try {
    const notebooks = await bg('list-notebooks', { authuser });
    if (loadId !== notebookLoadId) return;
    select.innerHTML = '<option value="">Select notebook...</option>';
    if (Array.isArray(notebooks)) {
      notebooks.forEach(nb => {
        const opt = document.createElement('option');
        opt.value = nb.id;
        opt.textContent = `${nb.emoji || ''} ${nb.title}`.trim();
        select.appendChild(opt);
      });
    }
    // Restore last selected
    const stored = await chrome.storage.local.get(['lastNotebookByAccount', 'lastNotebookId', 'lastNotebookAuthuser']);
    if (loadId !== notebookLoadId) return;
    const notebookId = stored.lastNotebookByAccount?.[authuser] ||
      ((stored.lastNotebookAuthuser === authuser || (stored.lastNotebookAuthuser === undefined && authuser === 0))
        ? stored.lastNotebookId : null);
    if (notebookId) {
      select.value = notebookId;
      // Verify the option actually exists in the list
      if (select.value === notebookId) {
        currentNotebookId = notebookId;
      } else {
        // Notebook was deleted or belongs to different account
        currentNotebookId = null;
        await bg('set-last-notebook', { notebookId: '', authuser });
      }
    }
  } catch (e) {
    if (loadId !== notebookLoadId) return;
    select.innerHTML = '<option value="">Error — are you logged in?</option>';
    showStatus('#home-status', e.message, 'error');
  } finally {
    if (loadId === notebookLoadId) select.disabled = false;
  }
}

$('#notebook-select').addEventListener('change', async (e) => {
  currentNotebookId = e.target.value;
  try {
    await bg('set-last-notebook', { notebookId: currentNotebookId });
  } catch (err) {
    showStatus('#home-status', `Error: ${err.message}`, 'error');
  }
});

$('#refresh-notebooks').addEventListener('click', loadNotebooks);

// ─── Create notebook ───
$('#create-notebook').addEventListener('click', async () => {
  const title = $('#new-notebook-title').value.trim();
  if (!title) return;
  const authuser = currentAuthuser;
  const selectionId = accountSelectionId;
  showStatus('#home-status', 'Creating...', 'info', 0);
  try {
    const result = await bg('create-notebook', { title, authuser });
    if (result && result.id) {
      showStatus('#home-status', `Created: ${title}`, 'success');
      $('#new-notebook-title').value = '';
      await bg('set-last-notebook', { notebookId: result.id, authuser });
      if (selectionId === accountSelectionId) await loadNotebooks();
    } else {
      showStatus('#home-status', 'Could not create notebook', 'error');
    }
  } catch (e) {
    showStatus('#home-status', `Error: ${e.message}`, 'error');
  }
});

// ═══════════════════════════════════════
// HOME — ADD ACTIONS
// ═══════════════════════════════════════
function requireNotebook() {
  if (!currentNotebookId) {
    showStatus('#home-status', 'Please select a notebook first', 'warning');
    return false;
  }
  return true;
}

// Add current page
$('#add-current-page').addEventListener('click', async () => {
  if (!requireNotebook()) return;
  const notebookId = currentNotebookId;
  const authuser = currentAuthuser;
  showStatus('#home-status', t('statusAdding'), 'info', 0);
  try {
    const tab = await bg('get-current-tab');
    await bg('add-source', { notebookId, authuser, url: UrlUtils.httpUrl(tab.url) });
    showStatus('#home-status', `${t('statusAdded')} ${tab.title || ''}`, 'success');
  } catch (e) {
    showStatus('#home-status', `Error: ${e.message}`, 'error');
  }
});

// Add as PDF
$('#add-as-pdf').addEventListener('click', async () => {
  if (!requireNotebook()) return;
  const notebookId = currentNotebookId;
  const authuser = currentAuthuser;
  const pending = pendingPdf;
  const button = $('#add-as-pdf');
  button.disabled = true;
  showStatus('#home-status', 'Capturing PDF...', 'info', 0);
  try {
    const tab = pending ? { id: pending.tabId, title: pending.title } : await bg('get-current-tab');
    await bg('add-as-pdf', { notebookId, authuser, tabId: tab.id, title: tab.title });
    if (pending) await chrome.storage.local.remove('pendingPdf');
    await loadPendingPdf();
    showStatus('#home-status', `PDF saved: ${tab.title || ''}`, 'success');
  } catch (e) {
    showStatus('#home-status', `Error: ${e.message}`, 'error');
  } finally {
    button.disabled = false;
  }
});

async function loadPendingPdf() {
  const data = await chrome.storage.local.get(['pendingPdf']);
  pendingPdf = data.pendingPdf || null;
  $('#pending-pdf-info').style.display = pendingPdf ? 'flex' : 'none';
  $('#pending-pdf-title').textContent = pendingPdf ? t('pendingPdf', { TITLE: pendingPdf.title || pendingPdf.url }) : '';
}
$('#cancel-pending-pdf').addEventListener('click', async () => {
  try { await chrome.storage.local.remove('pendingPdf'); await loadPendingPdf(); }
  catch (error) { showStatus('#home-status', error.message, 'error'); }
});

// Add single URL
$('#add-single-url').addEventListener('click', async () => {
  if (!requireNotebook()) return;
  const url = $('#single-url').value.trim();
  if (!url) return;
  showStatus('#home-status', t('statusAdding'), 'info', 0);
  try {
    await bg('add-source', { notebookId: currentNotebookId, url: UrlUtils.httpUrl(url) });
    showStatus('#home-status', t('statusAdded'), 'success');
    $('#single-url').value = '';
  } catch (e) {
    showStatus('#home-status', `Error: ${e.message}`, 'error');
  }
});

// Bulk import — add directly
$('#bulk-add').addEventListener('click', async () => {
  if (!requireNotebook()) return;
  const urls = $('#bulk-urls').value.trim().split('\n').map(u => u.trim()).filter(u => u);
  if (!urls.length) return;
  const controls = [$('#bulk-add'), $('#bulk-queue'), $('#bulk-urls')];
  controls.forEach(control => { control.disabled = true; });
  $('#bulk-results').replaceChildren();
  showStatus('#home-status', `Adding ${urls.length} URLs...`, 'info', 0);
  try {
    const result = await bg('add-sources', { notebookId: currentNotebookId, urls: urls.map(url => UrlUtils.httpUrl(url)) });
    $('#bulk-urls').value = ImportResults.retryable(result).map(item => item.url).join('\n');
    ImportResults.render($('#bulk-results'), result, t);
    if (result.success) showStatus('#home-status', `Added ${result.count} sources!`, 'success');
    else showStatus('#home-status', ImportResults.summary(result, t) + '\n' + result.message,
      result.count ? 'warning' : 'error', 0);
  } catch (e) {
    showStatus('#home-status', `Error: ${e.message}`, 'error');
  } finally {
    controls.forEach(control => { control.disabled = false; });
  }
});

// Bulk import — add to queue
$('#bulk-queue').addEventListener('click', async () => {
  const urls = $('#bulk-urls').value.trim().split('\n').map(u => u.trim()).filter(u => u);
  if (!urls.length) return;
  try {
    await bg('add-to-queue', { items: urls.map(url => ({ url })) });
    showStatus('#home-status', `${urls.length} URLs added to queue`, 'success');
    $('#bulk-urls').value = '';
  } catch (e) {
    showStatus('#home-status', `Error: ${e.message}`, 'error');
  }
});

// Open the full-page tab manager (app/app.html)
$('#import-tabs').addEventListener('click', () => {
  try {
    chrome.tabs.create({ url: chrome.runtime.getURL('app/app.html') });
  } catch (e) {
    showStatus('#home-status', `Error: ${e.message}`, 'error');
  }
});

// ═══════════════════════════════════════
// PARSERS — YouTube Comments
// ═══════════════════════════════════════
async function checkYouTubeTab() {
  const info = $('#yt-info');
  let tab;
  try {
    tab = await bg('get-current-tab');
  } catch (e) {
    info.style.display = 'block';
    info.innerHTML = `<i class="ms ms-info" style="font-size:14px;vertical-align:middle"></i> ${escapeHtml(t('statusError') + ': ' + e.message)}`;
    $('#start-parse').disabled = true;
    return;
  }
  if (tab && UrlUtils.videoId(tab.url)) {
    info.style.display = 'block';
    info.innerHTML = `<i class="ms ms-smart_display" style="font-size:14px;vertical-align:middle"></i> ${escapeHtml(tab.title)}`;
    $('#start-parse').disabled = false;
  } else {
    info.style.display = 'block';
    info.innerHTML = '<i class="ms ms-info" style="font-size:14px;vertical-align:middle"></i> Navigate to a YouTube video tab to parse comments';
    $('#start-parse').disabled = true;
  }
}

$('#start-parse').addEventListener('click', async () => {
  if (!requireNotebook()) return;
  const notebookId = currentNotebookId;
  const authuser = currentAuthuser;
  let tab;
  try {
    tab = await bg('get-current-tab');
  } catch (e) {
    showStatus('#home-status', `Error: ${e.message}`, 'error');
    return;
  }
  if (!tab || !UrlUtils.videoId(tab.url)) return;

  // Extract video ID
  const videoId = UrlUtils.videoId(tab.url);

  // Save settings
  try {
    await chrome.storage.local.set({
      commentsMode: $('#comments-mode').value,
      commentsLimit: $('#comments-limit').value === '' ? 1000 : Math.max(0, Math.min(99999, Number($('#comments-limit').value))),
      commentsIncludeReplies: $('#comments-replies').checked
    });
  } catch (e) {
    showStatus('#home-status', `Error: ${e.message}`, 'error');
    return;
  }

  try {
    const result = await bg('parse-comments', {
      notebookId, authuser,
      videoId,
      tabId: tab.id
    });

    if (result && result.error) {
      showStatus('#home-status', `Error: ${String(result.error)}`, 'error');
      return;
    }

    // Show progress
    currentParseId = result.parseId;
    $('#parse-progress').style.display = 'flex';
    $('#start-parse').style.display = 'none';
    startParsePolling();
  } catch (e) {
    showStatus('#home-status', `Error: ${e.message}`, 'error');
  }
});

$('#cancel-parse').addEventListener('click', async () => {
  try {
    $('#cancel-parse').disabled = true;
    const result = await bg('cancel-parse', { parseId: currentParseId });
    if (result.success === false) $('#cancel-parse').disabled = false;
  } catch (e) {
    showStatus('#home-status', `Error: ${e.message}`, 'error');
  }
  // Keep polling until the in-flight request has actually stopped.
});

function startParsePolling() {
  stopParsePolling();
  parseTimer = setInterval(async () => {
    const fill = $('#parse-fill');
    const text = $('#parse-text');
    let status;
    try {
      status = await bg('get-parse-status');
    } catch (e) {
      // Background unreachable — keep polling, surface error
      text.textContent = `Error: ${e.message}`;
      return;
    }
    if (!status || !status.progress) return;
    currentParseId = status.parseId;

    if (!status.active && status.progress.phase === 'done') {
      stopParsePolling();
      $('#cancel-parse').disabled = false;
      fill.style.width = '100%';
      const r = status.result || {};
      const sentParts = r.sentPartCount !== undefined ? r.sentPartCount : r.partCount;
      text.innerHTML = `<span style="color:var(--success,#16a34a)">✓ Done!</span> ${r.commentCount || 0} comments, ${sentParts}/${r.partCount || 0} parts added to notebook`;
      showStatus('#home-status', `✓ ${r.commentCount || 0} comments added to notebook (${sentParts} part${sentParts !== 1 ? 's' : ''})`, 'success');
      setTimeout(() => {
        $('#parse-progress').style.display = 'none';
        $('#start-parse').style.display = '';
      }, 6000);
      return;
    }

    if (!status.active && ['error', 'interrupted', 'cancelled'].includes(status.progress.phase)) {
      stopParsePolling();
      $('#cancel-parse').disabled = false;
      const errMsg = status.error ? (status.error.message || 'Unknown error') : 'Cancelled';
      if (status.progress.phase !== 'cancelled') {
        text.innerHTML = `<span style="color:var(--danger,#dc2626)">✗ Error: ${escapeHtml(errMsg)}</span>`;
        showStatus('#home-status', `✗ Comments not added: ${errMsg}`, 'error');
      } else {
        text.textContent = 'Cancelled';
      }
      setTimeout(() => {
        $('#parse-progress').style.display = 'none';
        $('#start-parse').style.display = '';
      }, 5000);
      return;
    }

    // Update progress
    const fetched = status.progress.fetched || 0;
    const total = status.progress.total || 0;
    const pct = total > 0 ? Math.min(Math.round(fetched / total * 100), 95) : 0;
    fill.style.width = (status.progress.phase === 'sending' ? '90%' : status.progress.phase === 'formatting' ? '85%' : pct + '%');

    const phases = {
      fetching: `Fetching comments... ${fetched}${total ? '/' + total : ''}`,
      fetching_replies: `Fetching replies... ${fetched}`,
      formatting: 'Formatting to Markdown...',
      sending: 'Sending to Gemini Notebook...',
      cancelling: 'Cancelling the current request...'
    };
    text.textContent = phases[status.progress.phase] || status.progress.phase;
  }, 1000);
}

function stopParsePolling() {
  if (parseTimer) { clearInterval(parseTimer); parseTimer = null; }
}

// Restore in-progress parse UI on popup reopen (MV3 service-worker may keep
// a long parse running across popup close/reopen cycles).
async function restoreParseProgress() {
  let status;
  try {
    status = await bg('get-parse-status');
  } catch (_) {
    return;
  }
  if (!status || !status.progress) return;
  if (status.progress.phase === 'interrupted') {
    showStatus('#home-status', status.error?.message || 'Parsing was interrupted. Please start again.', 'error', 0);
    return;
  }
  if (!status.active) return;
  currentParseId = status.parseId;
  // A parse is in progress — show the progress UI and resume polling
  const progressEl = $('#parse-progress');
  const startBtn = $('#start-parse');
  if (!progressEl || !startBtn) return;
  progressEl.style.display = 'flex';
  startBtn.style.display = 'none';
  startParsePolling();
}

// ═══════════════════════════════════════
// PARSERS — RSS / Sitemap
// ═══════════════════════════════════════
// Shared helper: wire up the "Add selected to queue" button inside #rss-results
function wireRssAddSelected(container) {
  const btn = container.querySelector('#rss-add-selected');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    try {
      const checked = container.querySelectorAll('.rss-cb:checked');
      const items = Array.from(checked).map(cb => ({
        url: cb.dataset.url || '',
        title: cb.dataset.title || ''
      })).filter(it => it.url);
      if (!items.length) return;
      btn.disabled = true;
      await bg('add-to-queue', { items });
      showStatus('#home-status', `${items.length} RSS items added to queue`, 'success');
      btn.disabled = false;
    } catch (err) {
      showStatus('#home-status', `Error: ${err.message}`, 'error');
      btn.disabled = false;
    }
  });
}

// Render an RSS feed's items into #rss-results with checkboxes + add-to-queue button
function renderRssItems(container, feed) {
  const items = (feed && Array.isArray(feed.items)) ? feed.items : [];
  if (!items.length) {
    container.innerHTML = `<div class="text-muted text-center">${escapeHtml(t('rssNoItems'))}</div>`;
    return;
  }
  const countText = t('rssItemsFound', { COUNT: items.length });
  container.innerHTML = `
    ${feed.title ? `<div style="margin-bottom:4px;font-weight:600">${escapeHtml(feed.title)}</div>` : ''}
    ${feed.description ? `<div style="margin-bottom:6px;font-size:12px;color:var(--text-secondary)">${escapeHtml(feed.description)}</div>` : ''}
    <div style="margin-bottom:6px;font-size:12px;color:var(--text-secondary)">${escapeHtml(countText)}</div>
    ${items.map(item => `
      <div class="result-item">
        <input type="checkbox" class="rss-cb" data-url="${escapeHtml(item.url || '')}" data-title="${escapeHtml(item.title || '')}" checked>
        <i class="ms ms-rss_feed" style="font-size:14px;color:var(--accent)"></i>
        <span class="title">${escapeHtml(item.title || item.url || '')}</span>
      </div>
    `).join('')}
    <button class="btn btn-primary btn-full mt-8" id="rss-add-selected">
      <i class="ms ms-add"></i> ${escapeHtml(t('addToQueue'))}
    </button>
  `;
  wireRssAddSelected(container);
}

async function parseFeedIntoResults(input) {
  const container = $('#rss-results');
  let url;
  try {
    url = UrlUtils.httpUrl(input);
  } catch (error) {
    container.textContent = error.message;
    return;
  }
  // Request directly in the click handler's gesture chain; an earlier await
  // (even permissions.contains) can discard Chrome's user-activation token.
  try {
    const granted = await chrome.permissions.request({ origins: [new URL(url).origin + '/*'] });
    if (!granted) {
      container.textContent = t('rssPermissionNeeded');
      return;
    }
    container.textContent = 'Parsing...';
    const feed = await bg('parse-rss', { url });
    renderRssItems(container, feed);
  } catch (error) {
    container.textContent = 'Error: ' + error.message;
  }
}
$('#rss-parse').addEventListener('click', () => parseFeedIntoResults($('#rss-url').value.trim()));

$('#rss-detect').addEventListener('click', async () => {
  const container = $('#rss-results');
  container.innerHTML = '<div class="text-muted text-center">Detecting...</div>';
  let tab;
  try {
    tab = await bg('get-current-tab');
  } catch (e) {
    container.innerHTML = `<div class="text-muted text-center">Error: ${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!tab) {
    container.innerHTML = '<div class="text-muted text-center">No active tab</div>';
    return;
  }
  let feeds;
  try {
    feeds = await bg('detect-rss', { tabId: tab.id });
  } catch (e) {
    container.innerHTML = `<div class="text-muted text-center">Error: ${escapeHtml(e.message)}</div>`;
    return;
  }

  if (!feeds || !feeds.length) {
    container.innerHTML = '<div class="text-muted text-center">No RSS feeds found on this page</div>';
    return;
  }

  // A detected feed must be parsed before its article URLs are queued.
  container.innerHTML = `
    <div style="margin-bottom:6px;font-size:12px;color:var(--text-secondary)">${feeds.length} feeds found</div>
    ${feeds.map(f => `
      <div class="result-item">
        <i class="ms ms-rss_feed" style="font-size:14px;color:var(--accent)"></i>
        <span class="title">${escapeHtml(f.title || '')}</span>
        <button class="btn btn-sm rss-load-feed" data-url="${escapeHtml(f.url || '')}">${escapeHtml(t('rssParse'))}</button>
      </div>
    `).join('')}
  `;
  container.querySelectorAll('.rss-load-feed').forEach(button => {
    button.addEventListener('click', () => {
      $('#rss-url').value = button.dataset.url;
      parseFeedIntoResults(button.dataset.url);
    });
  });
});

// ═══════════════════════════════════════
// PARSERS — YouTube Playlist / Links
// ═══════════════════════════════════════
$('#yt-extract').addEventListener('click', async () => {
  const container = $('#yt-results');
  container.innerHTML = '<div class="text-muted text-center">Extracting...</div>';
  let tab;
  try {
    tab = await bg('get-current-tab');
  } catch (e) {
    container.innerHTML = `<div class="text-muted text-center">Error: ${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!tab) {
    container.innerHTML = '<div class="text-muted text-center">No active tab</div>';
    return;
  }
  let urls;
  try {
    urls = await bg('extract-yt-urls', { tabId: tab.id });
  } catch (e) {
    container.innerHTML = `<div class="text-muted text-center">Error: ${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!Array.isArray(urls) || !urls.length) {
    container.innerHTML = '<div class="text-muted text-center">No YouTube links found</div>';
    return;
  }

  container.innerHTML = `
    <div style="margin-bottom:6px;font-size:12px;color:var(--text-secondary)">${urls.length} videos found</div>
    ${urls.map(u => `
      <div class="result-item">
        <input type="checkbox" class="yt-cb" data-url="${escapeHtml(u)}" checked>
        <i class="ms ms-smart_display" style="font-size:14px;color:var(--danger)"></i>
        <span class="title">${escapeHtml(u)}</span>
      </div>
    `).join('')}
    <button class="btn btn-primary btn-full mt-8" id="yt-add-selected">
      <i class="ms ms-add"></i> ${escapeHtml(t('addToQueue'))}
    </button>
  `;

  container.querySelector('#yt-add-selected')?.addEventListener('click', async () => {
    const btn = container.querySelector('#yt-add-selected');
    try {
      const checked = container.querySelectorAll('.yt-cb:checked');
      const items = Array.from(checked).map(cb => ({ url: cb.dataset.url })).filter(it => it.url);
      if (items.length) {
        btn.disabled = true;
        await bg('add-to-queue', { items });
        showStatus('#home-status', `${items.length} videos added to queue`, 'success');
        btn.disabled = false;
      }
    } catch (err) {
      showStatus('#home-status', `Error: ${err.message}`, 'error');
      btn.disabled = false;
    }
  });
});

$('#extract-links').addEventListener('click', async () => {
  const container = $('#links-results');
  container.innerHTML = '<div class="text-muted text-center">Extracting...</div>';
  let tab;
  try {
    tab = await bg('get-current-tab');
  } catch (e) {
    container.innerHTML = `<div class="text-muted text-center">Error: ${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!tab) {
    container.innerHTML = '<div class="text-muted text-center">No active tab</div>';
    return;
  }
  let links;
  try {
    links = await bg('extract-links', { tabId: tab.id });
  } catch (e) {
    container.innerHTML = `<div class="text-muted text-center">Error: ${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!Array.isArray(links) || !links.length) {
    container.innerHTML = '<div class="text-muted text-center">No links found</div>';
    return;
  }

  container.innerHTML = `
    <div style="margin-bottom:6px;font-size:12px;color:var(--text-secondary)">${links.length} links found</div>
    ${links.map(l => `
      <div class="result-item">
        <input type="checkbox" class="link-cb" data-url="${escapeHtml(l.url || '')}">
        <i class="ms ms-link" style="font-size:14px"></i>
        <span class="title">${escapeHtml(l.title || '')}</span>
      </div>
    `).join('')}
    <button class="btn btn-primary btn-full mt-8" id="links-add-selected">
      <i class="ms ms-add"></i> ${escapeHtml(t('addToQueue'))}
    </button>
  `;

  container.querySelector('#links-add-selected')?.addEventListener('click', async () => {
    const btn = container.querySelector('#links-add-selected');
    try {
      const checked = container.querySelectorAll('.link-cb:checked');
      const items = Array.from(checked).map(cb => ({ url: cb.dataset.url })).filter(it => it.url);
      if (items.length) {
        btn.disabled = true;
        await bg('add-to-queue', { items });
        showStatus('#home-status', `${items.length} links added to queue`, 'success');
        btn.disabled = false;
      }
    } catch (err) {
      showStatus('#home-status', `Error: ${err.message}`, 'error');
      btn.disabled = false;
    }
  });
});

// ═══════════════════════════════════════
// QUEUE
// ═══════════════════════════════════════
let queueLoadId = 0;
async function loadQueue() {
  const loadId = ++queueLoadId;
  const list = $('#queue-list');
  let state;
  try { state = await bg('get-queue-status'); } catch (error) {
    showStatus('#queue-status', error.message, 'error');
    return;
  }
  if (loadId !== queueLoadId) return;
  const queue = state.queue || [];
  $('#queue-count').textContent = queue.length;
  $('#process-queue').disabled = state.active || !state.pending;
  $('#retry-failed').style.display = state.failed ? '' : 'none';
  $('#retry-failed').disabled = state.active;
  if (state.active) {
    showStatus('#queue-status', t('queueRunning', { COUNT: state.processed, TOTAL: state.total, ERRORS: state.errors }), 'info', 0);
  } else if (state.pending) {
    showStatus('#queue-status', t('queueReady', { COUNT: state.pending }), 'info', 0);
  } else if (state.status === 'completed') {
    showStatus('#queue-status', t('queueDone', { COUNT: state.processed, ERRORS: state.errors }), state.errors ? 'warning' : 'success', 0);
  } else if (state.status === 'cancelled') {
    showStatus('#queue-status', t('queueCancelled'), 'info', 0);
  }
  list.innerHTML = queue.length ? queue.map(item => `
    <div class="queue-item" data-id="${escapeHtml(item.id)}">
      <i class="ms ms-link" style="font-size:14px;color:var(--accent)"></i>
      <div class="queue-item-details">
        <span class="title" title="${escapeHtml(item.url || '')}">${escapeHtml(item.title || item.url || '')}</span>
        <small class="queue-item-state ${item.status === 'failed' ? 'failed' : ''}">${escapeHtml(t(
          item.status === 'failed' ? 'queueFailedItem' : item.status === 'processing' ? 'queueProcessingItem' : 'queuePendingItem'))}
          ${item.lastError ? ': ' + escapeHtml(item.lastError) : ''}</small>
      </div>
      <button class="remove" data-id="${escapeHtml(item.id)}" title="Remove" ${item.status === 'processing' ? 'disabled' : ''}>&times;</button>
    </div>
  `).join('') : '<div class="text-muted text-center" style="padding:16px">Queue is empty</div>';
  list.querySelectorAll('.remove').forEach(button => {
    button.addEventListener('click', async () => {
      try {
        await bg('remove-from-queue', { id: button.dataset.id });
        await loadQueue();
      } catch (error) { showStatus('#queue-status', error.message, 'error'); }
    });
  });
}

$('#process-queue').addEventListener('click', async () => {
  if (!requireNotebook()) return;
  $('#process-queue').disabled = true;
  showStatus('#queue-status', 'Processing queue...', 'info', 0);
  try {
    await bg('process-queue', { notebookId: currentNotebookId });
    await loadQueue();
  } catch (e) {
    $('#cancel-parse').disabled = false;
    $('#process-queue').disabled = false;
    showStatus('#queue-status', `Error: ${e.message}`, 'error');
  }
});

$('#retry-failed').addEventListener('click', async () => {
  try { await bg('retry-failed'); await loadQueue(); }
  catch (error) { showStatus('#queue-status', error.message, 'error'); }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.queue || changes.queueRun) && $('#panel-queue').classList.contains('active')) loadQueue();
  if (area === 'local' && changes.pendingPdf) loadPendingPdf();
});

$('#clear-queue').addEventListener('click', async () => {
  if (!confirm('Clear all queue items?')) return;
  try {
    await bg('clear-queue');
    loadQueue();
  } catch (e) {
    showStatus('#queue-status', `Error: ${e.message}`, 'error');
  }
});

// ═══════════════════════════════════════
// ORGANIZE — Sources
// ═══════════════════════════════════════
let currentSources = [];

async function loadSources() {
  if (!currentNotebookId) {
    $('#sources-list').innerHTML = '<div class="text-muted text-center" style="padding:16px">Select a notebook first</div>';
    return;
  }

  $('#sources-list').innerHTML = '<div class="text-muted text-center" style="padding:16px">Loading sources...</div>';
  const loadId = ++sourceLoadId;
  const notebookId = currentNotebookId;
  const authuser = currentAuthuser;

  try {
    const nb = await bg('get-notebook', { notebookId, authuser });
    if (loadId !== sourceLoadId || notebookId !== currentNotebookId) return;
    currentSources = nb.sources || [];
    renderSources();
  } catch (e) {
    if (loadId !== sourceLoadId) return;
    $('#sources-list').innerHTML = `<div class="text-muted text-center" style="padding:16px">Error: ${escapeHtml(e.message)}</div>`;
  }
}

function renderSources() {
  const list = $('#sources-list');
  if (!currentSources.length) {
    $('#delete-selected').style.display = 'none';
    $('#del-count').textContent = '0';
    list.innerHTML = '<div class="text-muted text-center" style="padding:16px">No sources in this notebook</div>';
    return;
  }

  list.innerHTML = currentSources.map(s => `
    <div class="source-item" data-source-id="${escapeHtml(s.id || '')}">
      <input type="checkbox" class="source-cb" data-id="${escapeHtml(s.id || '')}">
      <i class="ms ${sourceIcons[s.type] || 'ms-help_outline'}"></i>
      <span class="title" title="${escapeHtml((s.url || '') + '\nID: ' + s.id)}">${escapeHtml(s.title || '')}</span>
      <span class="type">${escapeHtml(s.type || '')}</span>
      ${s.canSync ? '<i class="ms ms-cloud_sync sync-badge" title="Drive source"></i>' : ''}
    </div>
  `).join('');

  // Update delete count on checkbox changes
  list.querySelectorAll('.source-cb').forEach(cb => {
    cb.addEventListener('change', updateDeleteCount);
  });
  updateDeleteCount();
}

function updateDeleteCount() {
  const checked = $$('.source-cb:checked').length;
  const delBtn = $('#delete-selected');
  const countEl = $('#del-count');
  delBtn.style.display = checked > 0 ? '' : 'none';
  countEl.textContent = checked;
}

$('#refresh-sources').addEventListener('click', loadSources);

$('#select-all-sources').addEventListener('click', () => {
  const cbs = $$('.source-cb');
  const allChecked = Array.from(cbs).every(cb => cb.checked);
  cbs.forEach(cb => { cb.checked = !allChecked; });
  updateDeleteCount();
});

$('#delete-selected').addEventListener('click', async () => {
  const ids = Array.from($$('.source-cb:checked')).map(cb => cb.dataset.id);
  if (!ids.length || !currentNotebookId) return;
  if (!confirm(`Delete ${ids.length} sources?`)) return;

  showStatus('#organize-status', 'Deleting...', 'info', 0);
  try {
    await bg('delete-sources', { notebookId: currentNotebookId, sourceIds: ids });
    showStatus('#organize-status', `Deleted ${ids.length} sources`, 'success');
    loadSources();
  } catch (e) {
    showStatus('#organize-status', `Error: ${e.message}`, 'error');
  }
});

$('#sync-drive').addEventListener('click', async () => {
  if (!currentNotebookId) return;
  showStatus('#organize-status', 'Syncing Drive sources...', 'info', 0);
  try {
    const result = await bg('sync-drive-sources', { notebookId: currentNotebookId });
    const r = (result && result.results) || {};
    showStatus('#organize-status', `Sync: ${r.synced || 0} updated, ${r.fresh || 0} up-to-date, ${r.skipped || 0} skipped, ${r.errors || 0} errors`, r.errors ? 'warning' : 'success');
  } catch (e) {
    showStatus('#organize-status', `Error: ${e.message}`, 'error');
  }
});

$('#export-sources').addEventListener('click', () => {
  if (!currentSources.length) return;
  const text = currentSources.map(s => `${s.title}\t${s.type}\t${s.url || ''}`).join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'notebooklm-sources.txt';
  a.click();
  URL.revokeObjectURL(url);
});

// ═══════════════════════════════════════
// HISTORY
// ═══════════════════════════════════════
async function loadHistory() {
  const list = $('#history-list');
  let history;
  try {
    history = await bg('get-history');
  } catch (e) {
    list.innerHTML = `<div class="text-muted text-center" style="padding:16px">Error: ${escapeHtml(e.message)}</div>`;
    return;
  }
  if (!Array.isArray(history) || !history.length) {
    list.innerHTML = '<div class="text-muted text-center" style="padding:16px">No history yet</div>';
    return;
  }

  renderHistory(history);
}

function renderHistory(history) {
  const list = $('#history-list');
  list.innerHTML = history.map(h => {
    const iconMap = {
      add_source: 'ms-add_link',
      add_text: 'ms-edit_note',
      add_pdf: 'ms-picture_as_pdf',
      add_youtube_comments: 'ms-smart_display',
      create_notebook: 'ms-auto_stories',
      sync_drive: 'ms-cloud_sync',
      delete_source: 'ms-delete',
      delete_sources: 'ms-delete_sweep',
      error: 'ms-error'
    };
    const iconCls = iconMap[h.action] || 'ms-info';
    const detail = h.action === 'error' ? `${h.url || h.title || ''}: ${h.error || ''}`
      : h.url || h.title || `${h.count ?? 1} sources`;
    return `
      <div class="history-item">
        <i class="ms ${iconCls}"></i>
        <div class="details">${escapeHtml(detail)}</div>
        <span class="time">${timeAgo(h.timestamp)}</span>
      </div>
    `;
  }).join('');
}

// Debounced history search (avoids spamming background with get-history
// on every keystroke).
let historySearchTimer = null;
$('#history-search').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase();
  if (historySearchTimer) clearTimeout(historySearchTimer);
  historySearchTimer = setTimeout(async () => {
    let history;
    try {
      history = await bg('get-history');
    } catch (err) {
      $('#history-list').innerHTML = `<div class="text-muted text-center" style="padding:16px">Error: ${escapeHtml(err.message)}</div>`;
      return;
    }
    if (!Array.isArray(history)) history = [];
    const filtered = q ? history.filter(h =>
      (h.url || '').toLowerCase().includes(q) ||
      (h.title || '').toLowerCase().includes(q) ||
      (h.error || '').toLowerCase().includes(q) ||
      (h.action || '').toLowerCase().includes(q)
    ) : history;
    renderHistory(filtered);
  }, 250);
});

$('#clear-history').addEventListener('click', async () => {
  if (!confirm('Clear all history?')) return;
  try {
    await bg('clear-history');
    loadHistory();
  } catch (e) {
    showStatus('#home-status', `Error: ${e.message}`, 'error');
  }
});

// ═══════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════
async function loadSettings() {
  let sync, local;
  try {
    sync = await chrome.storage.sync.get(['theme', 'language', 'enableBulkDelete', 'enableSyncDrive', 'enableNotifications', 'settingsNotifications']);
    local = await chrome.storage.local.get(['addDelay', 'commentsMode', 'commentsLimit', 'commentsIncludeReplies']);
  } catch (e) {
    showStatus('#home-status', `Error loading settings: ${e.message}`, 'error');
    return;
  }

  $('#settings-theme').value = sync.theme || 'light';
  $('#settings-lang').value = sync.language || (typeof I18n !== 'undefined' ? I18n.getLanguage() : 'en');
  $('#settings-delay').value = local.addDelay || 2000;
  $('#settings-bulk-delete').checked = sync.enableBulkDelete !== false;
  $('#settings-sync-drive').checked = sync.enableSyncDrive !== false;
  $('#settings-notifications').checked = (sync.enableNotifications ?? sync.settingsNotifications) !== false;
  $('#comments-mode').value = ['new', 'newest'].includes(local.commentsMode) ? 'newest' : 'top';
  $('#comments-limit').value = local.commentsLimit ?? 1000;
  $('#comments-replies').checked = local.commentsIncludeReplies !== false;
}

// Auto-save all settings on change
['#settings-lang', '#settings-delay', '#settings-bulk-delete', '#settings-sync-drive', '#settings-notifications'].forEach(sel => {
  $(sel).addEventListener('change', saveSettings);
});

async function saveSettings() {
  try {
    await chrome.storage.sync.set({
      theme: $('#settings-theme').value,
      language: $('#settings-lang').value,
      enableBulkDelete: $('#settings-bulk-delete').checked,
      enableSyncDrive: $('#settings-sync-drive').checked,
      enableNotifications: $('#settings-notifications').checked
    });
    await chrome.storage.local.set({
      addDelay: Math.min(30000, Math.max(500, Number($('#settings-delay').value) || 2000))
    });
  } catch (e) {
    showStatus('#home-status', `Error saving settings: ${e.message}`, 'error');
    return;
  }

  // Apply language
  if (typeof I18n !== 'undefined') {
    try {
      await I18n.setLanguage($('#settings-lang').value);
    } catch (_) { /* ignore */ }
  }
}

// Backup
$('#backup-settings').addEventListener('click', async () => {
  try {
    const sync = await chrome.storage.sync.get(null);
    const local = await chrome.storage.local.get(null);
    const backup = { ...SettingsBackup.normalize({ sync, local }), version: chrome.runtime.getManifest().version, date: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nlm-assistant-backup-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showStatus('#home-status', 'Backup downloaded', 'success');
  } catch (e) {
    showStatus('#home-status', `Error: ${e.message}`, 'error');
  }
});

// Restore
$('#restore-settings').addEventListener('click', () => {
  $('#restore-file').click();
});

$('#restore-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  // Always reset so the same file can be re-selected later
  e.target.value = '';
  if (!file) return;

  let backup;
  try {
    const text = await file.text();
    backup = JSON.parse(text);
  } catch (err) {
    showStatus('#home-status', `Invalid backup file: ${err.message}`, 'error');
    return;
  }

  let payload;
  try { payload = SettingsBackup.normalize(backup); } catch (error) {
    showStatus('#home-status', 'Invalid backup file: ' + error.message, 'error');
    return;
  }

  // Confirm overwrite before touching storage
  if (!confirm(t('confirmRestore'))) {
    return;
  }

  const syncPayload = payload.sync;
  const localPayload = payload.local;

  try {
    if (Object.keys(syncPayload).length) {
      await chrome.storage.sync.set(syncPayload);
    }
    if (Object.keys(localPayload).length) {
      if (localPayload.queue) await bg('clear-queue');
      await chrome.storage.local.set(localPayload);
    }
    await loadSettings();
    await initTheme();
    await initI18n();
    await loadAccounts();
    showStatus('#home-status', 'Settings restored!', 'success');
  } catch (err) {
    showStatus('#home-status', `Restore failed: ${err.message}`, 'error');
  }
});

// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await initTheme();
  } catch (e) {
    console.error('initTheme failed:', e);
  }
  try {
    await initI18n();
  } catch (e) {
    console.error('initI18n failed:', e);
  }
  try {
    await loadSettings();
  } catch (e) {
    console.error('loadSettings failed:', e);
  }
  try { await loadPendingPdf(); } catch (error) { console.error('Pending PDF:', error); }
  try {
    await loadAccounts();
  } catch (e) {
    console.error('loadAccounts failed:', e);
  }
  // Resume progress UI if a YouTube-comments parse is in progress on the
  // background service worker (MV3 SW outlives popup close/reopen).
  try {
    await restoreParseProgress();
  } catch (e) {
    console.error('restoreParseProgress failed:', e);
  }
});

// Catch unhandled promise rejections so they don't disappear silently.
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled rejection in popup:', event.reason);
});
