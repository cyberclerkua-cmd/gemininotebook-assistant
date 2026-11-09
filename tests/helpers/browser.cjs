const { test: base, expect, chromium } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const NB0 = '11111111-1111-4111-8111-111111111111';
const NB1 = '22222222-2222-4222-8222-222222222222';
const VIDEO = 'abcdefghijk';
const ARTICLE = 'https://www.youtube.com/extension-test/article';
const escapeHtml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const guid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

function envelope(rpcId, data, error) {
  const json = JSON.stringify(error ? [['er', rpcId, null, null, 9, [error]]]
    : [['wrb.fr', rpcId, JSON.stringify(data), null, null, null, 'generic']]);
  return `)]}'\n\n${Buffer.byteLength(json)}\n${json}\n`;
}

class Backend {
  constructor() {
    this.notebooks = {
      0: [{ id: NB0, title: 'Notebook zero', sources: [
        { id: guid(1), title: 'First page', type: 5, url: 'https://example.com/first' },
        { id: guid(2), title: 'Drive stale', type: 1, driveId: 'drive-stale', fresh: false },
        { id: guid(3), title: 'Drive fresh', type: 2, driveId: 'drive-fresh', fresh: true },
        { id: guid(4), title: 'PDF document', type: 3 }
      ] }],
      1: [{ id: NB1, title: 'Notebook one', sources: [{ id: guid(11), title: 'Account one page', type: 5, url: 'https://example.com/one' }] }]
    };
    this.rpcRequests = [];
    this.uploads = [];
    this.ytRequests = [];
    this.rpcErrors = {};
    this.httpErrors = {};
    this.dropResponses = {};
    this.delays = {};
    this.feeds = {};
    this.nextId = 100;
    this.signedIn = true;
    this.ytFailureCount = 0;
    this.ytGate = null;
  }

  packedSource(source) {
    const metadata = [];
    metadata[0] = source.driveId ? [source.driveId] : null;
    metadata[4] = source.type;
    metadata[source.type === 9 ? 5 : 7] = source.url ? [source.url] : null;
    return [[source.id], source.title, metadata];
  }

  notebook(id) { return Object.values(this.notebooks).flat().find(notebook => notebook.id === id); }

  async route(route) {
    const request = route.request();
    const url = new URL(request.url());
    if (!['http:', 'https:'].includes(url.protocol)) return route.continue();
    const headers = { 'access-control-allow-origin': '*' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: {
      ...headers, 'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, x-goog-upload-command, x-goog-upload-offset, x-goog-upload-protocol, x-goog-upload-header-content-length'
    } });

    if (url.hostname === 'accounts.google.com') {
      const accounts = this.signedIn ? [0, 1].map(account => [0, 0, `Account ${account}`, `account${account}@example.test`, '']) : [];
      return route.fulfill({ status: 200, contentType: 'text/plain', body: `postMessage('${JSON.stringify(['accounts', accounts])}', 'https://www.google.com')` });
    }
    if (/^notebook(?:lm)?\.google\.com$/.test(url.hostname)) {
      if (url.pathname.includes('batchexecute')) return this.rpc(route, url);
      const requestHeaders = await request.allHeaders();
      if (url.pathname.startsWith('/upload/')) {
        if (requestHeaders['x-goog-upload-command'] === 'start') {
          const metadata = JSON.parse(request.postData());
          return route.fulfill({ status: 200, headers: { ...headers,
            'x-goog-upload-url': `https://notebook.google.com/upload/fixture?sourceId=${metadata.SOURCE_ID}` }, body: '' });
        }
        const bytes = request.postDataBuffer();
        this.uploads.push({ sourceId: url.searchParams.get('sourceId'), bytes, headers: requestHeaders });
        return route.fulfill({ status: 200, body: 'OK', headers });
      }
      if (request.isNavigationRequest()) {
        return route.fulfill({ status: 200, contentType: 'text/html', body: this.notebookHtml(url) });
      }
      const account = url.searchParams.get('authuser') || '0';
      return route.fulfill({ status: 200, contentType: 'text/html',
        body: this.signedIn ? `"cfb2h":"sid-${account}" "SNlM0e":"token-${account}"` : '<html>Sign in to Google</html>' });
    }
    if (url.hostname === 'www.youtube.com') {
      if (url.pathname.startsWith('/youtubei/v1/next')) {
        const payload = request.postDataJSON();
        this.ytRequests.push(payload.continuation);
        if (this.ytGate) await this.ytGate;
        if (this.ytFailureCount > 0) {
          this.ytFailureCount--;
          return route.fulfill({ status: 503, body: 'Retry later' });
        }
        return route.fulfill({ status: 200, json: this.youtubeResponse(payload.continuation) });
      }
      if (Object.prototype.hasOwnProperty.call(this.feeds, url.href)) {
        const feed = this.feeds[url.href];
        return route.fulfill({ status: feed.status || 200, contentType: 'application/xml', body: feed.xml ?? feed });
      }
      if (url.pathname === '/watch') return route.fulfill({ status: 200, contentType: 'text/html', body: this.youtubeHtml() });
      if (url.pathname.startsWith('/embed/')) return route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>Embedded video</body></html>' });
      return route.fulfill({ status: 200, contentType: 'text/html', body: this.articleHtml(url) });
    }
    return route.abort('blockedbyclient');
  }

  async rpc(route, url) {
    const body = new URLSearchParams(route.request().postData());
    const wire = JSON.parse(body.get('f.req'))[0][0];
    const rpcId = wire[0];
    const params = JSON.parse(wire[1]);
    const account = Number(url.searchParams.get('authuser') || 0);
    this.rpcRequests.push({ rpcId, params, account, sid: url.searchParams.get('f.sid'), token: body.get('at') });
    if (this.delays[rpcId]) await new Promise(resolve => setTimeout(resolve, this.delays[rpcId]));
    if (this.httpErrors[rpcId]) return route.fulfill({ status: this.httpErrors[rpcId], body: 'HTTP failure' });
    const configured = this.rpcErrors[rpcId];
    if (configured && (typeof configured === 'string' || configured.remaining > 0)) {
      if (typeof configured !== 'string') configured.remaining--;
      return route.fulfill({ status: 200, contentType: 'text/plain', body: envelope(rpcId, null, configured.message || configured) });
    }
    let notebookId = ['izAoDd', 'o4cbdc'].includes(rpcId) ? params[1]
      : rpcId === 'rLM1Ne' ? params[0] : (url.searchParams.get('source-path') || '').split('/notebook/')[1];
    const notebook = (this.notebooks[account] || []).find(notebook => notebook.id === notebookId);
    if (notebookId && !notebook) return route.fulfill({ status: 200, body: envelope(rpcId, null, 'No access to this notebook') });
    let data;
    switch (rpcId) {
      case 'wXbhsf': data = [(this.notebooks[account] || []).map(notebook =>
        [notebook.title, notebook.sources.map(source => this.packedSource(source)), notebook.id, ''])]; break;
      case 'CCqFvf': {
        const created = { id: guid(this.nextId++), title: params[0], sources: [] };
        this.notebooks[account].push(created);
        data = [[created.title, [], created.id]];
        break;
      }
      case 'rLM1Ne': data = [[notebook.title, notebook.sources.map(source => this.packedSource(source)), notebook.id]]; break;
      case 'izAoDd': {
        const created = params[0].map(spec => {
          const source = Array.isArray(spec[1]) ? { title: spec[1][0], text: spec[1][1], type: 4 }
            : spec[7] ? { title: 'YouTube video', url: spec[7][0], type: 9 }
            : { title: spec[2][0], url: spec[2][0], type: 5 };
          source.id = guid(this.nextId++);
          notebook.sources.push(source);
          return this.packedSource(source);
        });
        data = [created];
        break;
      }
      case 'tGMBJ': {
        const ids = params[0].map(entry => entry[0]);
        notebook.sources = notebook.sources.filter(source => !ids.includes(source.id));
        data = [];
        break;
      }
      case 'yR9Yof': data = [[null, !!notebook.sources.find(source => source.id === params[1][0])?.fresh, [params[1][0]]]]; break;
      case 'FLmJqe': notebook.sources.find(source => source.id === params[1][0]).fresh = true; data = []; break;
      case 'o4cbdc': {
        const source = { id: guid(this.nextId++), title: params[0][0][0], type: 3 };
        notebook.sources.push(source);
        data = [[[[source.id], source.title, [null, null, null, null, 0]]], null];
        break;
      }
      default: return route.fulfill({ status: 200, body: envelope(rpcId, null, 'Unexpected RPC ' + rpcId) });
    }
    if (this.dropResponses[rpcId] > 0) {
      this.dropResponses[rpcId]--;
      return route.abort('connectionclosed');
    }
    return route.fulfill({ status: 200, contentType: 'text/plain', body: envelope(rpcId, data) });
  }

  notebookHtml(url) {
    const id = url.pathname.match(/\/notebook\/([^/]+)/)?.[1];
    const notebook = this.notebook(id);
    const explicitIds = url.searchParams.get('ids') === 'true';
    return `<!doctype html><html><head><title>Notebook fixture</title><style>
      .single-source-container {position:relative;width:480px;min-height:42px;margin:4px;padding-left:32px;border:1px solid #ddd}
      .source-stretched-button {padding:10px;background:white;border:0}
    </style></head><body><h1>Notebook fixture</h1><div class="sources-panel">${(notebook?.sources || []).map(source =>
      `<div class="single-source-container" ${explicitIds ? `data-source-id="${source.id}"` : ''}>
       <button class="source-stretched-button" aria-label="${escapeHtml(source.title)}"><span class="source-title">${escapeHtml(source.title)}</span></button></div>`).join('')}
      </div><div role="listitem" class="cdk-drag" id="non-source-note">This is a note, not a source</div></body></html>`;
  }

  articleHtml(url) {
    const links = url.searchParams.get('fixture') === 'youtube-links' ? [
      'https://www.youtube.com/watch?v=abcdefghijk', 'https://youtu.be/abcdefghijk',
      'https://www.youtube.com/shorts/12345678901', 'https://m.youtube.com/watch?v=12345678901',
      'https://notyoutube.com/watch?v=abcdefghijk'
    ] : Array.from({ length: 60 }, (_, i) => `https://example.com/article-${i}`);
    return `<!doctype html><html><head><title>Article &lt;one&gt; &amp; "quotes"</title>
      <link rel="alternate" type="application/rss+xml" title="Fixture RSS" href="https://www.youtube.com/extension-test/rss.xml">
      </head><body><h1>Article fixture</h1>${links.map((link, i) => `<p><a href="${escapeHtml(link)}">Link ${i}</a></p>`).join('')}
      <iframe src="https://www.youtube.com/embed/zyxwvutsrqp" title="Embedded video"></iframe></body></html>`;
  }

  youtubeHtml() {
    return `<!doctype html><html><head><title>Fixture video - YouTube</title></head><body>
      <ytd-watch-flexy></ytd-watch-flexy><ytd-comments></ytd-comments>
      <like-button-view-model><button aria-label="1,234 likes">Like</button></like-button-view-model>
      <script>
      window.ytcfg = {data_: {INNERTUBE_API_KEY: 'fixture-key', INNERTUBE_CONTEXT: {client: {clientName: 'WEB'}}}};
      document.querySelector('ytd-watch-flexy').data = {playerResponse: {videoDetails: {
        videoId: '${VIDEO}', title: 'Fixture video', author: 'Fixture channel', viewCount: '1234'
      }, microformat: {playerMicroformatRenderer: {publishDate: '2026-07-01'}}},
      engagementPanels: [{commentsEntryPointHeaderRenderer: {commentCount: {simpleText: '3 comments'}}}]};
      document.querySelector('ytd-comments').data = {sortFilterSubMenuRenderer: {subMenuItems: [
        {title: 'Top', selected: true, serviceEndpoint: {continuationCommand: {token: 'yt-top'}}},
        {title: 'Newest', serviceEndpoint: {continuationCommand: {token: 'yt-newest'}}}
      ]}};
      </script></body></html>`;
  }

  youtubeResponse(token) {
    const comment = (id, text) => ({ commentId: id, authorText: { simpleText: 'Author' },
      contentText: { runs: [{ text }] }, voteCount: { simpleText: '1.2K' }, publishedTimeText: { runs: [{ text: '2 days ago' }] } });
    const continuation = token => ({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token } } } });
    if (token === 'yt-replies') return { onResponseReceivedEndpoints: [{ appendContinuationItemsAction: {
      targetId: 'comment-replies-item-parent-1', continuationItems: [{ commentRenderer: comment('parent-1.reply', 'A reply') }]
    } }] };
    const newest = token === 'yt-newest';
    const items = token === 'yt-next' ? [{ commentThreadRenderer: { comment: { commentRenderer: comment('parent-3', 'Third comment') } } }]
      : [1, 2].map(number => ({ commentThreadRenderer: {
        comment: { commentRenderer: comment(`parent-${number}`, newest ? `Newest comment ${number}` : `Top comment ${number}`) },
        ...(number === 1 ? { replies: { commentRepliesRenderer: { contents: [continuation('yt-replies')] } } } : {})
      } }));
    if (token !== 'yt-next') items.push(continuation('yt-next'));
    return { onResponseReceivedEndpoints: [{ appendContinuationItemsAction: { targetId: 'comments-section', continuationItems: items } }] };
  }
}

const test = base.extend({
  extensionPath: [root, { option: true }],
  extension: async ({ extensionPath }, use) => {
    const tempRoot = path.join(os.tmpdir(), 'opencode');
    fs.mkdirSync(tempRoot, { recursive: true });
    const profile = fs.mkdtempSync(path.join(tempRoot, 'gemininotebook-browser-'));
    const launch = () => chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
      acceptDownloads: true, viewport: { width: 1280, height: 800 }
    });
    let context = await launch();
    const backend = new Backend();
    await context.route('**/*', route => backend.route(route));
    let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    await worker.evaluate(async ({ NB0, NB1 }) => {
      await chrome.storage.sync.set({ activeAccount: 0, theme: 'light', language: 'en', enableNotifications: false });
      await chrome.storage.local.set({ lastNotebookId: NB0, lastNotebookAuthuser: 0,
        lastNotebookByAccount: { 0: NB0, 1: NB1 }, addDelay: 500, commentsMode: 'top', commentsLimit: 2, commentsIncludeReplies: true });
    }, { NB0, NB1 });
    const errors = [];
    context.on('page', page => {
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => dialog.accept());
    });
    const popup = async () => {
      const page = await context.newPage();
      await page.setViewportSize({ width: 380, height: 600 });
      await page.goto(`chrome-extension://${id}/popup/popup.html`);
      await expect(page.locator('#account-select option')).toHaveCount(2);
      await expect(page.locator('#notebook-select')).not.toHaveValue('');
      return page;
    };
    const setActive = async page => {
      const url = page.url();
      await page.bringToFront();
      // A popup opened as a test tab must not become the page being imported.
      await worker.evaluate(async url => {
        globalThis.__fixtureActiveTab = (await chrome.tabs.query({})).find(tab => tab.url === url)?.id;
        if (!globalThis.__nativeTabsQuery) {
          globalThis.__nativeTabsQuery = chrome.tabs.query.bind(chrome.tabs);
          chrome.tabs.query = async filter => filter?.active && globalThis.__fixtureActiveTab
            ? [await chrome.tabs.get(globalThis.__fixtureActiveTab)] : globalThis.__nativeTabsQuery(filter);
        }
      }, url);
    };
    const relaunch = async () => {
      // Keep an empty startup tab so reloading a popup cannot race the routes.
      const blank = await context.newPage();
      for (const page of context.pages()) if (page !== blank) await page.close();
      await context.close();
      context = await launch();
      await context.route('**/*', route => backend.route(route));
      worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
      context.on('page', page => {
        page.on('pageerror', error => errors.push(error.message));
        page.on('dialog', dialog => dialog.accept());
      });
    };
    try { await use({ get context() { return context; }, get worker() { return worker; }, id, backend, popup, setActive, errors, relaunch }); }
    finally { await context.close(); fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  }
});

module.exports = { test, expect, NB0, NB1, VIDEO, ARTICLE, guid, escapeHtml };
