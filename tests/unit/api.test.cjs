const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground, authenticate, rpcResponse, rpcError, plain } = require('../helpers/background.cjs');

test('Account tokens remain isolated during concurrent requests', async () => {
  const requests = [];
  const env = loadBackground({ fetch: async (url, settings) => {
    const account = new URL(url).searchParams.get('authuser');
    if (!url.includes('batchexecute')) {
      return new Response(`"cfb2h":"sid-${account}" "SNlM0e":"token-${account}"`);
    }
    requests.push({ account, token: settings.body.get('at'), sid: new URL(url).searchParams.get('f.sid') });
    return new Response(rpcResponse('izAoDd', []));
  } });
  await env.ready();
  await Promise.all([0, 1].map(authuser => env.send('add-source', { notebookId: 'nb-1', url: 'https://example.com', authuser })));
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.token, `token-${request.account}`);
    assert.equal(request.sid, `sid-${request.account}`);
  }
});

test('Account indices are not renumbered after filtering placeholder entries', async () => {
  const env = loadBackground({ fetch: async () => new Response(`postMessage('${JSON.stringify(['accounts', [[], [0, 0, 'User', 'user@example.com', 'photo']]])}', 'https://www.google.com')`) });
  const accounts = await env.api.listAccounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].authuser, 1);
});

test('Tokens are cached per account and refreshed after expiry', async () => {
  let fetches = 0;
  const env = loadBackground({ fetch: async () => { fetches++; return new Response('"cfb2h":"sid" "SNlM0e":"token"'); } });
  await env.api.getTokens(0);
  await env.api.getTokens(0);
  assert.equal(fetches, 1);
  await env.clock.advance(5 * 60 * 1000);
  await env.api.getTokens(0);
  assert.equal(fetches, 2);
});

test('Login pages and malformed RPC envelopes cannot look like successful imports', async () => {
  const env = loadBackground({ fetch: async () => new Response('<html>Sign in</html>') });
  await assert.rejects(env.api.getTokens(), /logged in/);
  assert.ok(env.api._parseBatchexecuteResponse('<html>Error</html>').error);
  assert.ok(env.api._parseBatchexecuteResponse('').error);
});

test('URL and YouTube source descriptors use the correct RPC positions', async () => {
  const requests = [];
  const env = loadBackground({ fetch: async (_url, settings) => {
    const envelope = JSON.parse(settings.body.get('f.req'));
    requests.push(JSON.parse(envelope[0][0][1]));
    return new Response(rpcResponse('izAoDd', []));
  } });
  authenticate(env);
  await env.api.getTokens();
  await env.api.addSources('nb-1', ['https://example.com/article', 'https://www.youtube.com/watch?v=abcdefghijk']);
  assert.equal(requests[0][0][0][2][0], 'https://example.com/article');
  assert.equal(requests[1][0][0][7][0], 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(requests[1][0][0].length, 11);
});

test('Pasted sources send title/content together and return the raw acknowledgement', async () => {
  let params;
  const sourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const env = loadBackground({ fetch: async (_url, settings) => {
    const envelope = JSON.parse(settings.body.get('f.req'));
    params = JSON.parse(envelope[0][0][1]);
    return new Response(rpcResponse('izAoDd', [[[[sourceId]]]]));
  } });
  authenticate(env);
  await env.api.getTokens();
  const result = await env.api.addTextSource('nb-1', 'Content', 'Title', { verify: false });
  assert.deepEqual(params[0][0][1], ['Title', 'Content']);
  assert.equal(params[0][0][3], 2);
  assert.equal(result.sourceId, sourceId);
  assert.ok(result.raw.includes('wrb.fr'));
});

test('Pasted sources detect a silent format rejection', async () => {
  const env = loadBackground({ fetch: async () => new Response(rpcResponse('izAoDd', null)) });
  authenticate(env);
  await env.api.getTokens();
  env.api.getNotebook = async () => ({ sources: [] });
  await assert.rejects(env.settle(env.api.addTextSource('nb-1', 'Content', 'Title')), /not created|not confirm/i);
});

test('Notebook details distinguish Drive, PDF, text, web and YouTube sources', () => {
  const env = loadBackground();
  const source = (id, type, url, drive) => {
    const meta = [];
    meta[0] = drive ? [drive] : null;
    meta[4] = type;
    meta[type === 9 ? 5 : 7] = url ? [url] : null;
    return [[id], `Title ${id}`, meta];
  };
  const result = env.api._parseNotebookDetails(rpcResponse('rLM1Ne', [['Notebook', [
    source('drive', 1, null, 'document-1'), source('pdf', 3), source('text', 4),
    source('web', 5, 'https://example.com'), source('yt', 9, 'https://www.youtube.com/watch?v=abcdefghijk')
  ], 'nb-1']]));
  assert.deepEqual(plain(result.sources.map(source => source.type)), ['google_docs', 'pdf', 'pasted_text', 'web_page', 'youtube']);
  assert.equal(result.sources[0].canSync, true);
  assert.equal(result.sources[4].url, 'https://www.youtube.com/watch?v=abcdefghijk');
});

test('Drive synchronization distinguishes fresh, stale, unavailable and failed sources', async () => {
  const env = loadBackground();
  env.api.getNotebook = async () => ({ sources: ['fresh', 'stale', 'unavailable', 'failed'].map(id => ({ id, canSync: true })) });
  env.api.checkSourceFreshness = async id => id === 'fresh' ? true : id === 'unavailable' ? null : false;
  env.api.syncDriveSource = async id => { if (id === 'failed') throw new Error('Sync rejected'); };
  const result = await env.run('syncDriveSources')('nb-1');
  assert.deepEqual(plain(result.results), { total: 4, fresh: 1, synced: 1, skipped: 1, errors: 1 });
});

test('PDF upload uses registration, resumable start and binary finalization', async () => {
  const requests = [];
  const env = loadBackground({ fetch: async (url, settings) => {
    requests.push({ url, settings });
    if (url.includes('batchexecute')) return new Response(rpcResponse('o4cbdc', [[['pdf-source']]]));
    if (settings.headers['x-goog-upload-command'] === 'start') {
      return new Response('', { headers: { 'x-goog-upload-url': 'https://notebook.google.com/upload/session' } });
    }
    return new Response('OK');
  } });
  authenticate(env);
  await env.api.getTokens();
  await env.api.addPdfSource('nb-1', Buffer.from('%PDF-1.4\ncontent').toString('base64'), 'Page.pdf');
  assert.equal(requests.length, 3);
  assert.equal(JSON.parse(requests[1].settings.body).SOURCE_NAME, 'Page.pdf');
  assert.equal(requests[2].settings.headers['x-goog-upload-command'], 'upload, finalize');
  assert.equal(requests[2].settings.headers['content-type'], 'application/pdf');
  assert.equal(Buffer.from(requests[2].settings.body).toString(), '%PDF-1.4\ncontent');
});

test('PDF names preserve Cyrillic titles', async () => {
  const env = loadBackground();
  let filename;
  env.api.addPdfSource = async (_notebookId, _pdf, name) => { filename = name; };
  await env.run('addAsPdf')('nb-1', 7, 'Статья: пример?');
  assert.equal(filename, 'Статья пример.pdf');
});

test('Text-source verification tolerates delayed registration and unchanged total counts', async () => {
  const env = loadBackground({ fetch: async () => new Response(rpcResponse('izAoDd', null)) });
  authenticate(env);
  await env.api.getTokens();
  let reads = 0;
  env.api.getNotebook = async () => ({ sources: ++reads < 3
    ? [{ id: 'old', title: 'Old' }] : [{ id: 'new', title: 'Title' }] });
  const result = await env.settle(env.api.addTextSource('nb-1', 'Content', 'Title'));
  assert.equal(result.sourceId, 'new');
});

test('A text source without an acknowledgement or readable notebook is not reported as added', async () => {
  const env = loadBackground({ fetch: async () => new Response(rpcResponse('izAoDd', null)) });
  authenticate(env);
  await env.api.getTokens();
  env.api.getNotebook = async () => { throw new Error('Notebook unreadable'); };
  await assert.rejects(env.api.addTextSource('nb-1', 'Content', 'Title'), /confirm|created/i);
});

test('A failed PDF upload cleans up only its newly registered placeholder', async () => {
  const env = loadBackground();
  env.api.registerPdfSource = async () => 'pdf-placeholder';
  env.api.getUploadUrl = async () => { throw new Error('Upload unavailable'); };
  const deleted = [];
  env.api.deleteSource = async (notebookId, sourceId) => { deleted.push([notebookId, sourceId]); };
  await assert.rejects(env.api.addPdfSource('nb-1', Buffer.from('%PDF-1.4\ncontent').toString('base64'), 'File.pdf'), /Upload unavailable/);
  assert.deepEqual(deleted, [['nb-1', 'pdf-placeholder']]);
});

test('Invalid PDF bytes are rejected before source registration', async () => {
  const env = loadBackground();
  let registered = false;
  env.api.registerPdfSource = async () => { registered = true; return 'pdf-placeholder'; };
  await assert.rejects(env.api.addPdfSource('nb-1', 'not base64 !', 'File.pdf'), /PDF|base64/i);
  assert.equal(registered, false);
});

test('Freshness RPC failures are errors rather than successful skips', async () => {
  const env = loadBackground({ fetch: async () => new Response(rpcError('yR9Yof', 'Drive access denied')) });
  authenticate(env);
  await env.api.getTokens();
  await assert.rejects(env.api.checkSourceFreshness('source-1', 'nb-1'), /Drive access denied/);
});

test('PDF registration decodes the full source descriptor returned by the live Google API', async () => {
  const sourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const source = [[sourceId], 'GNA PDF shape probe.pdf', [null, null, [1794163384, 789031000], null, 0]];
  const env = loadBackground({ fetch: async () => new Response(rpcResponse('o4cbdc', [[source], null, [[source]]])) });
  authenticate(env);
  await env.api.getTokens();
  assert.equal(await env.api.registerPdfSource('nb-1', 'GNA PDF shape probe.pdf'), sourceId);
});

for (const fresh of [true, false]) {
  test(`Drive freshness reads the live boolean response (${fresh})`, async () => {
    const env = loadBackground({ fetch: async () => new Response(rpcResponse('yR9Yof', [[null, fresh, ['source-1']]])) });
    authenticate(env);
    await env.api.getTokens();
    assert.equal(await env.api.checkSourceFreshness('source-1', 'nb-1'), fresh);
  });
}

test('An unrecognized or mismatched Drive response is not interpreted as a stale source', async () => {
  for (const data of [[], [[null]], [[null, false, ['another-source']]]]) {
    const env = loadBackground({ fetch: async () => new Response(rpcResponse('yR9Yof', data)) });
    authenticate(env);
    await env.api.getTokens();
    assert.equal(await env.api.checkSourceFreshness('source-1', 'nb-1'), null);
  }
});
