const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground, rpcResponse, rpcError, plain, flush } = require('../helpers/background.cjs');

function authenticate(env) {
  env.api.getTokens = async function(authuser = 0) {
    this.tokens = { cfb2h: `sid-${authuser}`, SNlM0e: `token-${authuser}`, authuser };
    this.tokensAuthuser = authuser;
    return this.tokens;
  };
}

test('RPC decoder handles length-prefixed responses and text containing "error"', () => {
  const env = loadBackground();
  const result = env.api._parseBatchexecuteResponse(rpcResponse('rLM1Ne', [['An error-analysis notebook', [], 'nb-1']]));
  assert.equal(result.error, null);
  assert.equal(result.data[0][0], 'An error-analysis notebook');
});

for (const [method, args] of [
  ['addSource', ['nb-1', 'https://example.com']],
  ['deleteSources', ['nb-1', ['source-1']]],
  ['syncDriveSource', ['source-1', 'nb-1']]
]) {
  test(`${method} rejects RPC errors returned with HTTP 200`, async () => {
    const env = loadBackground({ fetch: async url => new Response(rpcError(new URL(url).searchParams.get('rpcids'))) });
    authenticate(env);
    await env.api.getTokens();
    await assert.rejects(env.api[method](...args), /Source limit reached/);
  });
}

test('HTTP errors are surfaced without recording a successful add', async () => {
  const env = loadBackground({ fetch: async () => new Response('Forbidden', { status: 403 }) });
  authenticate(env);
  await env.ready();
  await assert.rejects(env.send('add-source', { notebookId: 'nb-1', url: 'https://example.com' }));
  assert.equal((env.stores.local.history || []).length, 0);
});

test('URLs are validated before queue insertion', async () => {
  const env = loadBackground();
  await env.ready();
  for (const url of ['javascript:alert(1)', 'chrome://extensions', 'not-a-url']) {
    await assert.rejects(env.send('add-to-queue', { items: [{ url }] }), /URL|http/i);
  }
  assert.equal((env.stores.local.queue || []).length, 0);
});

test('Concurrent queue additions retain every item and stable IDs', async () => {
  const env = loadBackground();
  await env.ready();
  await Promise.all(Array.from({ length: 20 }, (_, i) => env.send('add-to-queue', {
    items: [{ url: `https://example.com/${i}` }]
  })));
  assert.equal(env.stores.local.queue.length, 20);
  assert.equal(new Set(env.stores.local.queue.map(item => item.id)).size, 20);
});

test('Concurrent history updates do not overwrite each other', async () => {
  const env = loadBackground();
  await env.ready();
  const addHistory = env.run('addHistory');
  await Promise.all(Array.from({ length: 30 }, (_, i) => addHistory({ action: 'test', title: String(i) })));
  assert.equal(env.stores.local.history.length, 30);
});

test('History keeps the most recent 500 entries', async () => {
  const env = loadBackground();
  await env.ready();
  const addHistory = env.run('addHistory');
  for (let i = 0; i < 505; i++) await addHistory({ action: 'test', title: String(i) });
  assert.equal(env.stores.local.history.length, 500);
  assert.equal(env.stores.local.history[0].title, '504');
});

test('The notifications preference actually suppresses notifications', async () => {
  const env = loadBackground({ sync: { enableNotifications: false } });
  await env.run('notify')('test', { message: 'Should not be shown' });
  assert.equal(env.calls.notifications.length, 0);
});

test('A source command uses its explicit Google account', async () => {
  const env = loadBackground({
    sync: { activeAccount: 0 },
    fetch: async url => url.includes('batchexecute')
      ? new Response(rpcResponse('izAoDd', [[['source-1']]]))
      : new Response('"cfb2h":"sid" "SNlM0e":"token"')
  });
  await env.ready();
  await env.send('add-source', { notebookId: 'nb-1', url: 'https://example.com', authuser: 1 });
  const request = env.calls.fetch.find(call => call.url.includes('batchexecute'));
  assert.equal(new URL(request.url).searchParams.get('authuser'), '1');
});

test('A content-script command respects the account in the page URL', async () => {
  const env = loadBackground({
    sync: { activeAccount: 0 },
    fetch: async url => url.includes('batchexecute')
      ? new Response(rpcResponse('rLM1Ne', [['Notebook', [], 'nb-1']]))
      : new Response('"cfb2h":"sid" "SNlM0e":"token"')
  });
  await env.ready();
  await env.send('get-sources', { notebookId: 'nb-1' }, { url: 'https://notebook.google.com/notebook/nb-1?authuser=2' });
  assert.equal(new URL(env.calls.fetch.find(call => call.url.includes('batchexecute')).url)
    .searchParams.get('authuser'), '2');
});

test('Queue items can be removed by stable ID instead of a stale display index', async () => {
  const env = loadBackground();
  await env.ready();
  await env.send('add-to-queue', { items: ['https://example.com/a', 'https://example.com/b'] });
  const secondId = env.stores.local.queue[1].id;
  await env.send('remove-from-queue', { id: secondId });
  assert.deepEqual(env.stores.local.queue.map(item => item.url), ['https://example.com/a']);
});

test('Source deletion is batched in groups of 20', async () => {
  const batches = [];
  const env = loadBackground({ fetch: async (url, settings) => {
    const request = JSON.parse(settings.body.get('f.req'));
    batches.push(JSON.parse(request[0][0][1])[0]);
    return new Response(rpcResponse('tGMBJ', []));
  } });
  authenticate(env);
  await env.api.getTokens();
  const result = await env.api.deleteSources('nb-1', Array.from({ length: 45 }, (_, i) => `source-${i}`));
  assert.equal(result.deleted, 45);
  assert.deepEqual(batches.map(batch => batch.length), [20, 20, 5]);
});

test('PDF generation detaches the debugger after a print failure', async () => {
  const env = loadBackground();
  env.chrome.debugger.sendCommand = async () => { throw new Error('Printing failed'); };
  await assert.rejects(env.run('generatePdf')(7), /Printing failed/);
  assert.equal(env.calls.debugger.at(-1)[0], 'detach');
});

test('PDF generation has a timeout and still detaches the debugger', async () => {
  const env = loadBackground();
  env.chrome.debugger.sendCommand = async () => new Promise(() => {});
  const promise = env.run('generatePdf')(7);
  const assertion = assert.rejects(promise, /timeout/i);
  await flush();
  await env.clock.advance(30000);
  await assertion;
  assert.equal(env.calls.debugger.at(-1)[0], 'detach');
});

test('The PDF context menu uploads to the last selected notebook', async () => {
  const env = loadBackground({ local: { lastNotebookId: 'nb-1' } });
  authenticate(env);
  let uploads = 0;
  env.api.addPdfSource = async () => { uploads++; return { sourceId: 'pdf-1' }; };
  await env.ready();
  await env.chrome.contextMenus.onClicked.emit({ menuItemId: 'add-as-pdf', pageUrl: 'https://example.com' }, {
    id: 7, title: 'Page', url: 'https://example.com'
  });
  assert.equal(uploads, 1);
});

test('Unknown commands return an actionable error', async () => {
  const env = loadBackground();
  const result = await env.send('does-not-exist');
  assert.match(result.error, /Unknown command/);
});
