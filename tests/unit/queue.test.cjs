const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground, authenticate, flush } = require('../helpers/background.cjs');

async function queueEnvironment() {
  const env = loadBackground({ local: { addDelay: 1000 } });
  authenticate(env);
  env.api.getNotebook = async () => ({ sources: [] });
  await env.ready();
  return env;
}

test('Queue processes every URL sequentially with the configured delay', async () => {
  const env = await queueEnvironment();
  const added = [];
  env.api.addSource = async (_notebookId, url) => { added.push({ url, at: env.clock.now }); };
  await env.send('add-to-queue', { items: ['https://example.com/a', 'https://example.com/b'] });
  const started = await env.send('process-queue', { notebookId: 'nb-1' });
  assert.equal(started.started, true);
  assert.equal((await env.send('get-queue-status')).active, true);
  await env.clock.advance(1000);
  assert.equal(added.length, 2);
  assert.ok(added[1].at - added[0].at >= 1000);
  const state = await env.send('get-queue-status');
  assert.equal(state.status, 'completed');
  assert.equal(state.processed, 2);
  assert.equal(state.queue.length, 0);
});

test('Transient queue errors are retried automatically', async () => {
  const env = await queueEnvironment();
  let attempts = 0;
  env.api.addSource = async () => { if (++attempts < 3) throw new Error('Temporarily unavailable'); };
  await env.send('add-to-queue', { items: ['https://example.com/a'] });
  await env.send('process-queue', { notebookId: 'nb-1' });
  await env.clock.advance(10000);
  const state = await env.send('get-queue-status');
  assert.equal(attempts, 3);
  assert.equal(state.processed, 1);
  assert.equal(state.errors, 0);
  assert.equal(state.queue.length, 0);
});

test('Three failed attempts retain the error and allow a manual retry', async () => {
  const env = await queueEnvironment();
  let failing = true;
  let attempts = 0;
  env.api.addSource = async () => { attempts++; if (failing) throw new Error('Source limit reached'); };
  await env.send('add-to-queue', { items: ['https://example.com/a'] });
  await env.send('process-queue', { notebookId: 'nb-1' });
  await env.clock.advance(10000);
  let state = await env.send('get-queue-status');
  assert.equal(state.errors, 1);
  assert.equal(state.queue[0].status, 'failed');
  assert.equal(state.queue[0].errorCount, 3);
  assert.equal(state.queue[0].lastError, 'Source limit reached');
  const result = await env.send('retry-failed');
  assert.equal(result.reset, 1);
  assert.equal(env.stores.local.queue[0].errorCount, 0);
  failing = false;
  await env.send('process-queue', { notebookId: 'nb-1' });
  await env.clock.advance(1000);
  state = await env.send('get-queue-status');
  assert.equal(state.queue.length, 0);
  assert.equal(state.processed, 1);
  assert.equal(attempts, 4);
});

test('An obsolete alarm cannot process the active queue', async () => {
  const env = await queueEnvironment();
  let calls = 0;
  env.api.addSource = async () => { calls++; };
  await env.send('add-to-queue', { items: ['https://example.com/a'] });
  await env.send('process-queue', { notebookId: 'nb-1' });
  await env.chrome.alarms.onAlarm.emit({ name: 'process-queue-obsolete' });
  assert.equal(calls, 0);
  await env.clock.advance(0);
  assert.equal(calls, 1);
});

test('Items added during a pending network request are not overwritten', async () => {
  const env = await queueEnvironment();
  let release;
  env.api.addSource = async () => new Promise(resolve => { release = resolve; });
  await env.send('add-to-queue', { items: ['https://example.com/a'] });
  await env.send('process-queue', { notebookId: 'nb-1' });
  await env.clock.advance(0);
  assert.equal(env.stores.local.queue[0].status, 'processing');
  await env.send('add-to-queue', { items: ['https://example.com/b'] });
  release();
  await flush();
  assert.deepEqual(env.stores.local.queue.map(item => item.url), ['https://example.com/b']);
});

test('Clearing an in-flight queue does not resurrect its old snapshot', async () => {
  const env = await queueEnvironment();
  let release;
  env.api.addSource = async () => new Promise(resolve => { release = resolve; });
  await env.send('add-to-queue', { items: ['https://example.com/a', 'https://example.com/b'] });
  await env.send('process-queue', { notebookId: 'nb-1' });
  await env.clock.advance(0);
  await env.send('clear-queue');
  release();
  await flush();
  await env.clock.advance(10000);
  assert.equal(env.stores.local.queue.length, 0);
  assert.equal(env.stores.local.queueRun.status, 'cancelled');
});

test('Overlapping alarms cannot send an item twice', async () => {
  const env = await queueEnvironment();
  let release;
  let calls = 0;
  env.api.addSource = async () => { calls++; return new Promise(resolve => { release = resolve; }); };
  await env.send('add-to-queue', { items: ['https://example.com/a'] });
  await env.send('process-queue', { notebookId: 'nb-1' });
  const alarm = 'process-queue-' + env.stores.local.queueRun.id;
  const one = env.run('processOneQueueItem')(alarm);
  const two = env.run('processOneQueueItem')(alarm);
  await flush();
  assert.equal(calls, 1);
  release();
  await Promise.all([one, two]);
  assert.equal(calls, 1);
});

test('A recovered queue keeps its captured account and verifies already-added URLs', async () => {
  const env = loadBackground({ sync: { activeAccount: 2 }, local: {
    queue: [{ id: 'item-1', url: 'https://example.com/a', status: 'processing', errorCount: 0 }],
    queueRun: { id: 'run-1', notebookId: 'nb-1', authuser: 1, status: 'processing', total: 1, processed: 0, errors: 0, nextRunAt: 0 }
  } });
  const accounts = [];
  authenticate(env);
  const getTokens = env.api.getTokens;
  env.api.getTokens = async function(account) { accounts.push(account); return getTokens.call(this, account); };
  let adds = 0;
  env.api.addSource = async () => { adds++; };
  env.api.getNotebook = async () => ({ sources: [{ id: 'existing', url: 'https://example.com/a' }] });
  await env.ready();
  await env.clock.advance(1000);
  assert.deepEqual(accounts, [1]);
  assert.equal(adds, 0);
  assert.equal(env.stores.local.queue.length, 0);
  assert.equal(env.stores.local.queueRun.processed, 1);
});

test('The alarm watchdog resumes work when an in-memory timer is lost', async () => {
  const env = await queueEnvironment();
  let adds = 0;
  env.api.addSource = async () => { adds++; };
  await env.send('add-to-queue', { items: ['https://example.com/a'] });
  await env.send('process-queue', { notebookId: 'nb-1' });
  env.clock.timers.clear();
  await env.clock.advance(60000);
  await env.chrome.alarms.onAlarm.emit({ name: 'process-queue-' + env.stores.local.queueRun.id });
  assert.equal(adds, 1);
  assert.equal(env.stores.local.queue.length, 0);
});

test('A history storage failure does not retry a successful source addition', async () => {
  const env = await queueEnvironment();
  let adds = 0;
  env.api.addSource = async () => { adds++; };
  const set = env.chrome.storage.local.set;
  env.chrome.storage.local.set = async values => {
    if (values.history) throw new Error('History quota exceeded');
    return set(values);
  };
  await env.send('add-to-queue', { items: ['https://example.com/a'] });
  await env.send('process-queue', { notebookId: 'nb-1' });
  await env.clock.advance(10000);
  assert.equal(adds, 1);
  assert.equal(env.stores.local.queue.length, 0);
});

test('Invalid run IDs and accounts are rejected before queue processing', async () => {
  const env = await queueEnvironment();
  for (const account of [-1, 1.5, NaN]) await assert.rejects(env.send('set-active-account', { authuser: account }));
  await assert.rejects(env.send('process-queue', { notebookId: '' }), /Notebook ID/);
});

test('A failed queue commit after a successful RPC can recover without duplicate uploads', async () => {
  const env = await queueEnvironment();
  let adds = 0;
  env.api.addSource = async () => { adds++; };
  env.api.getNotebook = async () => ({ sources: adds ? [{ id: 'added', url: 'https://example.com/a' }] : [] });
  const set = env.chrome.storage.local.set;
  let fail = true;
  env.chrome.storage.local.set = async values => {
    if (values.queue?.length === 0 && values.queueRun?.status === 'completed' && fail) {
      fail = false;
      throw new Error('Transient storage failure');
    }
    return set(values);
  };
  await env.send('add-to-queue', { items: ['https://example.com/a'] });
  await env.send('process-queue', { notebookId: 'nb-1' });
  await env.clock.advance(0);
  await env.chrome.alarms.onAlarm.emit({ name: 'process-queue-' + env.stores.local.queueRun.id });
  await env.clock.advance(0);
  assert.equal(adds, 1);
  assert.equal(env.stores.local.queue.length, 0);
  assert.equal(env.stores.local.queueRun.processed, 1);
});
