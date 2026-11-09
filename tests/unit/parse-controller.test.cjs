const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground, authenticate, flush } = require('../helpers/background.cjs');

const VIDEO = 'abcdefghijk';
const comments = [{ id: 'parent', author: 'Author', text: 'A comment', likeCount: 1, replies: [] }];
async function parserEnvironment(settings = {}) {
  const env = loadBackground({
    sync: { activeAccount: 0 }, local: settings,
    tabs: [{ id: 7, url: `https://www.youtube.com/watch?v=${VIDEO}`, title: 'Video', active: true }]
  });
  authenticate(env);
  const youtube = env.run('YouTubeCommentsAPI');
  youtube.getVideoMetadataFromDOM = async () => ({ videoId: VIDEO, title: 'Video', commentCount: 10 });
  youtube.fetchAllComments = async () => comments;
  env.api.addTextSource = async () => ({ sourceId: 'source-1' });
  await env.ready();
  return { env, youtube };
}
const start = env => env.send('parse-comments', { notebookId: 'nb-1', videoId: VIDEO, tabId: 7 });

test('Top-mode limits and zero/unlimited are forwarded without falsy-value defaults', async () => {
  for (const limit of [0, 2]) {
    const { env, youtube } = await parserEnvironment({ commentsMode: 'top', commentsLimit: limit, commentsIncludeReplies: false });
    let options;
    youtube.fetchAllComments = async (_video, config) => { options = config; return comments; };
    await start(env);
    await flush();
    assert.equal(options.maxComments, limit);
    assert.equal(options.includeReplies, false);
    assert.equal((await env.send('get-parse-status')).progress.phase, 'done');
  }
});

test('Cancelling waits for the in-flight parse and blocks concurrent replacement jobs', async () => {
  const { env, youtube } = await parserEnvironment();
  let release;
  let sources = 0;
  youtube.fetchAllComments = async () => new Promise(resolve => { release = resolve; });
  env.api.addTextSource = async () => { sources++; return {}; };
  await start(env);
  await flush();
  await env.send('cancel-parse');
  assert.equal((await env.send('get-parse-status')).active, true);
  assert.equal((await start(env)).error, 'Parse already in progress');
  release(comments);
  await flush();
  const status = await env.send('get-parse-status');
  assert.equal(status.progress.phase, 'cancelled');
  assert.equal(status.active, false);
  assert.equal(sources, 0);
});

test('A stale popup cannot cancel a different parse ID', async () => {
  const { env, youtube } = await parserEnvironment();
  let release;
  youtube.fetchAllComments = async () => new Promise(resolve => { release = resolve; });
  await start(env);
  await flush();
  await env.send('cancel-parse', { parseId: 'obsolete-parse' });
  assert.equal((await env.send('get-parse-status')).progress.phase, 'fetching');
  release(comments);
  await flush();
  assert.equal((await env.send('get-parse-status')).progress.phase, 'done');
});

test('Empty comments are never registered as a text source', async () => {
  const { env, youtube } = await parserEnvironment();
  let sources = 0;
  youtube.fetchAllComments = async () => [];
  env.api.addTextSource = async () => { sources++; };
  await start(env);
  await flush();
  const status = await env.send('get-parse-status');
  assert.equal(status.progress.phase, 'error');
  assert.match(status.error.message, /No comments/);
  assert.equal(sources, 0);
});

test('Interrupted parse checkpoints are surfaced after a service-worker restart', async () => {
  const env = loadBackground({ session: { parseStateCheckpoint: {
    active: true, parseId: 'old', videoId: VIDEO, progress: { phase: 'fetching', fetched: 42 }
  } } });
  await env.ready();
  const status = await env.send('get-parse-status');
  assert.equal(status.active, false);
  assert.equal(status.progress.phase, 'interrupted');
  assert.equal(status.progress.fetched, 42);
  assert.equal(status.error.code, 'INTERRUPTED');
});

test('Switching the global account cannot redirect an active parse', async () => {
  const { env, youtube } = await parserEnvironment();
  let release;
  let account;
  youtube.fetchAllComments = async () => new Promise(resolve => { release = resolve; });
  env.api.addTextSource = async function() { account = this.tokens.authuser; return { sourceId: 'source' }; };
  await start(env);
  await flush();
  await env.send('set-active-account', { authuser: 1 });
  release(comments);
  await flush();
  assert.equal(account, 0);
});
