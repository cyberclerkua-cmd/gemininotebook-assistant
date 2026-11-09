const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground, authenticate, flush, plain, rpcResponse, rpcError } = require('../helpers/background.cjs');

test('A lost response after server commit does not duplicate a queued source', async () => {
  const sources = [];
  let attempts = 0;
  const env = loadBackground({ local: { addDelay: 500 }, fetch: async (_url, options) => {
    const request = JSON.parse(options.body.get('f.req'))[0][0];
    const params = JSON.parse(request[1]);
    sources.push({ id: 'source-' + (sources.length + 1), url: params[0][0][2][0] });
    if (++attempts === 1) throw new TypeError('Response lost after server commit');
    return new Response(rpcResponse('izAoDd', []));
  } });
  authenticate(env);
  env.api.getNotebook = async () => ({ sources: structuredClone(sources) });
  await env.ready();
  await env.send('add-to-queue', { items: ['https://example.com/article'] });
  await env.send('process-queue', { notebookId: 'nb-1' });
  await env.clock.advance(10000);
  assert.equal(sources.length, 1);
  assert.equal(attempts, 1);
  assert.equal((await env.send('get-queue-status')).processed, 1);
});

test('A new queue starts promptly after clearing an older in-flight run', async () => {
  const env = loadBackground({ local: { addDelay: 500 } });
  authenticate(env);
  env.api.getNotebook = async () => ({ sources: [] });
  await env.ready();
  const sent = [];
  let finishOld;
  env.api.addSource = async (_notebookId, url) => {
    sent.push(url);
    if (url.endsWith('/old')) await new Promise(resolve => { finishOld = resolve; });
  };
  await env.send('add-to-queue', { items: ['https://example.com/old'] });
  await env.send('process-queue', { notebookId: 'nb-1' });
  await env.clock.advance(0);
  await env.send('clear-queue');
  await env.send('add-to-queue', { items: ['https://example.com/new'] });
  await env.send('process-queue', { notebookId: 'nb-1' });
  await env.clock.advance(0);
  finishOld();
  await flush();
  await env.clock.advance(1000);
  assert.deepEqual(sent, ['https://example.com/old', 'https://example.com/new']);
  assert.equal((await env.send('get-queue-status')).status, 'completed');
});

test('Partial bulk imports report each outcome and retain acknowledged history', async () => {
  const created = [];
  const env = loadBackground({ fetch: async (_url, options) => {
    const request = JSON.parse(options.body.get('f.req'))[0][0];
    const params = JSON.parse(request[1]);
    if (params[0][0][7]) return new Response(rpcError('izAoDd', 'Video import rejected'));
    created.push(...params[0].map(source => source[2][0]));
    return new Response(rpcResponse('izAoDd', []));
  } });
  authenticate(env);
  await env.ready();
  const result = await env.send('add-sources', { notebookId: 'nb-1', urls: [
    'https://example.com/imported', 'https://www.youtube.com/watch?v=abcdefghijk',
    'https://www.youtube.com/watch?v=12345678901'
  ] });
  assert.equal(result.success, false);
  assert.equal(result.count, 1);
  assert.deepEqual(plain(result.results.map(item => item.status)), ['added', 'failed', 'pending']);
  assert.match(result.message, /Video import rejected/);
  assert.deepEqual(created, ['https://example.com/imported']);
  assert.equal(env.stores.local.history.filter(entry => entry.action === 'add_source').length, 1);
});

test('An older authentication response cannot overwrite the latest account selection', async () => {
  const env = loadBackground({ sync: { activeAccount: 0 } });
  authenticate(env);
  await env.ready();
  const getTokens = env.api.getTokens;
  let release;
  env.api.getTokens = async function(account) {
    if (account === 1) await new Promise(resolve => { release = resolve; });
    return getTokens.call(this, account);
  };
  const older = env.send('set-active-account', { authuser: 1 });
  await flush();
  await env.send('set-active-account', { authuser: 0 });
  release();
  const stale = await older;
  assert.equal(stale.superseded, true);
  assert.equal(env.stores.sync.activeAccount, 0);
});

test('A stale authentication failure cannot revive an older account selection', async () => {
  const env = loadBackground({ sync: { activeAccount: 0 } });
  authenticate(env);
  await env.ready();
  let rejectOld;
  const getTokens = env.api.getTokens;
  env.api.getTokens = async function(account) {
    if (account === 1) await new Promise((_, reject) => { rejectOld = reject; });
    return getTokens.call(this, account);
  };
  const old = env.send('set-active-account', { authuser: 1 });
  await flush();
  await env.send('set-active-account', { authuser: 0 });
  rejectOld(new Error('Old account is unavailable'));
  assert.equal((await old).superseded, true);
  assert.equal(env.stores.sync.activeAccount, 0);
});

test('A failed latest selection retains the committed account rather than an older pending one', async () => {
  const env = loadBackground({ sync: { activeAccount: 0 } });
  authenticate(env);
  await env.ready();
  let release;
  const getTokens = env.api.getTokens;
  env.api.getTokens = async function(account) {
    if (account === 1) await new Promise(resolve => { release = resolve; });
    if (account === 2) throw new Error('Latest account is unavailable');
    return getTokens.call(this, account);
  };
  const old = env.send('set-active-account', { authuser: 1 });
  await flush();
  await assert.rejects(env.send('set-active-account', { authuser: 2 }), /unavailable/);
  release();
  assert.equal((await old).superseded, true);
  assert.equal(env.stores.sync.activeAccount, 0);
});

test('Account storage commits stay ordered when an older write is already in flight', async () => {
  const env = loadBackground({ sync: { activeAccount: 0 } });
  authenticate(env);
  await env.ready();
  const set = env.chrome.storage.sync.set;
  let release;
  env.chrome.storage.sync.set = async values => {
    if (values.activeAccount === 1) await new Promise(resolve => { release = resolve; });
    return set(values);
  };
  const first = env.send('set-active-account', { authuser: 1 });
  await flush();
  const last = env.send('set-active-account', { authuser: 0 });
  await flush();
  release();
  await Promise.all([first, last]);
  assert.equal(env.stores.sync.activeAccount, 0);
});

test('Delayed source visibility is reconciled without resending the original POST', async () => {
  const env = loadBackground({ local: { addDelay: 500 } });
  authenticate(env);
  await env.ready();
  let reads = 0;
  let sends = 0;
  env.api.getNotebook = async () => ({ sources: ++reads < 3 ? [] : [{ id: 'new-source', url: 'https://example.com/delayed' }] });
  env.api.addSource = async () => { sends++; throw Object.assign(new Error('Lost response'), { rpcOutcome: 'unknown' }); };
  await env.send('add-to-queue', { items: ['https://example.com/delayed'] });
  await env.send('process-queue', { notebookId: 'nb-1' });
  await env.clock.advance(10000);
  assert.equal(sends, 1);
  assert.equal((await env.send('get-queue-status')).processed, 1);
});

test('Pre-existing sources cannot be mistaken for a lost response; manual retry only reconciles', async () => {
  const env = loadBackground({ local: { addDelay: 500 } });
  authenticate(env);
  await env.ready();
  const sources = [{ id: 'old-source', url: 'https://example.com/same' }];
  let sends = 0;
  env.api.getNotebook = async () => ({ sources: structuredClone(sources) });
  env.api.addSource = async () => { sends++; throw Object.assign(new Error('Lost response'), { rpcOutcome: 'unknown' }); };
  await env.send('add-to-queue', { items: ['https://example.com/same'] });
  await env.send('process-queue', { notebookId: 'nb-1' });
  await env.clock.advance(10000);
  assert.equal((await env.send('get-queue-status')).processed, 0);
  assert.equal(env.stores.local.queue[0].status, 'failed');
  assert.deepEqual(plain(env.stores.local.queue[0].sourceAttempt.beforeSourceIds), ['old-source']);
  await env.send('retry-failed');
  await env.send('process-queue', { notebookId: 'nb-1' });
  await env.clock.advance(10000);
  assert.equal(sends, 1);
  sources.push({ id: 'new-source', url: 'https://example.com/same' });
  await env.send('retry-failed');
  await env.send('process-queue', { notebookId: 'nb-1' });
  await env.clock.advance(1000);
  assert.equal(sends, 1);
  assert.equal((await env.send('get-queue-status')).processed, 1);
});

test('A lost YouTube response is reconciled across short and canonical watch URLs', async () => {
  const env = loadBackground();
  authenticate(env);
  await env.ready();
  let sends = 0;
  env.api.getNotebook = async () => ({ sources: sends ? [{ id: 'video', url: 'https://www.youtube.com/watch?v=abcdefghijk' }] : [] });
  env.api.addSource = async () => { sends++; throw Object.assign(new Error('Lost response'), { rpcOutcome: 'unknown' }); };
  await env.send('add-to-queue', { items: ['https://youtu.be/abcdefghijk?t=10'] });
  await env.send('process-queue', { notebookId: 'nb-1' });
  await env.clock.advance(10000);
  assert.equal(sends, 1);
  assert.equal((await env.send('get-queue-status')).processed, 1);
});

test('An uncertain source attempt survives a worker restart with its original snapshot', async () => {
  const env = loadBackground({ sync: { activeAccount: 2 }, local: {
    queue: [{ id: 'item', url: 'https://example.com/same', status: 'processing', errorCount: 1,
      sourceAttempt: { notebookId: 'nb-1', authuser: 1, beforeSourceIds: ['old-source'] } }],
    queueRun: { id: 'run', notebookId: 'nb-1', authuser: 1, status: 'processing', total: 1, processed: 0, errors: 0, nextRunAt: 0 }
  } });
  authenticate(env);
  let writes = 0;
  env.api.addSource = async () => { writes++; };
  env.api.getNotebook = async function() {
    assert.equal(this.tokens.authuser, 1);
    return { sources: [{ id: 'old-source', url: 'https://example.com/same' }, { id: 'new-source', url: 'https://example.com/same' }] };
  };
  await env.ready();
  await env.clock.advance(1000);
  assert.equal(writes, 0);
  assert.equal((await env.send('get-queue-status')).processed, 1);
});

test('An uncertain attempt cannot silently move to another notebook on retry', async () => {
  const env = loadBackground({ local: { queue: [{ id: 'item', url: 'https://example.com/one', status: 'pending', errorCount: 0,
    sourceAttempt: { notebookId: 'original', authuser: 0, beforeSourceIds: [] } }] } });
  authenticate(env);
  let sends = 0;
  env.api.addSource = async () => { sends++; };
  await env.ready();
  await env.send('process-queue', { notebookId: 'different' });
  await env.clock.advance(10000);
  assert.equal(sends, 0);
  assert.match(env.stores.local.queue[0].lastError, /different notebook or account/);
});

test('An obsolete run cannot clear the timer of its replacement', async () => {
  const env = loadBackground();
  authenticate(env);
  env.api.getNotebook = async () => ({ sources: [] });
  const sent = [];
  env.api.addSource = async (_notebookId, url) => { sent.push(url); };
  await env.ready();
  await env.send('add-to-queue', { items: ['https://example.com/old'] });
  await env.send('process-queue', { notebookId: 'nb-1' });
  const old = structuredClone(env.stores.local.queueRun);
  await env.send('clear-queue');
  await env.send('add-to-queue', { items: ['https://example.com/new'] });
  await env.send('process-queue', { notebookId: 'nb-1' });
  await env.run('scheduleQueue')(old);
  await env.run('stopQueueSchedule')(old);
  await env.clock.advance(0);
  assert.deepEqual(sent, ['https://example.com/new']);
});

test('Bulk transport failures distinguish unconfirmed writes from unattempted URLs', async () => {
  const env = loadBackground({ fetch: async () => { throw new TypeError('Connection closed'); } });
  authenticate(env);
  await env.ready();
  const result = await env.send('add-sources', { notebookId: 'nb-1', urls: [
    'https://example.com/unknown', 'https://www.youtube.com/watch?v=abcdefghijk'
  ] });
  assert.equal(result.success, false);
  assert.equal(result.count, 0);
  assert.deepEqual(plain(result.results.map(item => item.status)), ['uncertain', 'pending']);
  assert.equal(env.calls.fetch.length, 1);
});

test('Partial results preserve original input positions, including repeated URLs', async () => {
  let calls = 0;
  const env = loadBackground({ fetch: async () => new Response(++calls === 3
    ? rpcError('izAoDd', 'Rejected second copy') : rpcResponse('izAoDd', [])) });
  authenticate(env);
  await env.ready();
  const video = 'https://www.youtube.com/watch?v=abcdefghijk';
  const result = await env.send('add-sources', { notebookId: 'nb-1', urls: [video, 'https://example.com/web', video] });
  assert.deepEqual(plain(result.results), [
    { url: video, status: 'added' }, { url: 'https://example.com/web', status: 'added' }, { url: video, status: 'failed' }
  ]);
  assert.equal(result.count, 2);
});

test('Bulk history failures cannot turn acknowledged imports into retryable errors', async () => {
  const env = loadBackground({ fetch: async () => new Response(rpcResponse('izAoDd', [])) });
  authenticate(env);
  await env.ready();
  const set = env.chrome.storage.local.set;
  env.chrome.storage.local.set = async values => {
    if (values.history) throw new Error('History is full');
    return set(values);
  };
  const result = await env.send('add-sources', { notebookId: 'nb-1', urls: [
    'https://example.com/web', 'https://www.youtube.com/watch?v=abcdefghijk'
  ] });
  assert.equal(result.success, true);
  assert.equal(result.count, 2);
  assert.equal(env.calls.fetch.length, 2);
});
