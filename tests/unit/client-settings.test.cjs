const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadBackground, plain, root, flush } = require('../helpers/background.cjs');

test('Shared messaging unwraps results and propagates structured errors', async () => {
  const env = loadBackground();
  await env.ready();
  const client = env.run('ExtensionClient');
  env.chrome.runtime.sendMessage = async () => ({ result: { count: 3 } });
  assert.deepEqual(plain(await client.send('test')), { count: 3 });
  env.chrome.runtime.sendMessage = async () => ({ error: { message: 'Server denied the operation' } });
  await assert.rejects(client.send('test'), /Server denied/);
  env.chrome.runtime.sendMessage = async () => undefined;
  await assert.rejects(client.send('test'), /No response/);
  assert.equal(env.clock.timers.size, 0);
});

test('Shared messaging times out and cleans up its timer', async () => {
  const env = loadBackground();
  await env.ready();
  env.chrome.runtime.sendMessage = async () => new Promise(() => {});
  const assertion = assert.rejects(env.run('ExtensionClient').send('test', {}, { timeoutMs: 1000 }), /timed out/);
  await env.clock.advance(1000);
  await assertion;
  assert.equal(env.clock.timers.size, 0);
});

test('Parse status DTOs preserve nullable and populated error fields as data', async () => {
  const env = loadBackground();
  await env.ready();
  env.chrome.runtime.sendMessage = request => env.send(request.cmd, request.params);
  const client = env.run('ExtensionClient');
  const status = await client.send('get-parse-status');
  assert.equal(status.error, null);
  assert.equal(status.progress.phase, 'idle');
  env.chrome.runtime.sendMessage = async () => ({ active: false, progress: { phase: 'error' }, error: { message: 'No comments' } });
  assert.equal((await client.send('get-parse-status')).error.message, 'No comments');
});

function backupHelper() {
  const env = loadBackground();
  env.context.importScripts('lib/settings-backup.js');
  return env.run('SettingsBackup');
}

test('Backup preserves every real setting and ignores transient worker state', () => {
  const helper = backupHelper();
  const result = helper.normalize({
    sync: { theme: 'dark', language: 'ru', enableNotifications: false, enableBulkDelete: true, enableSyncDrive: false, activeAccount: 1 },
    local: { addDelay: 2500, commentsMode: 'newest', commentsLimit: 0, commentsIncludeReplies: false,
      lastNotebookId: 'nb-1', lastNotebookAuthuser: 1, lastNotebookByAccount: { 1: 'nb-1' },
      nlm_ext_toolbar_pos: { left: '10px', top: '20px', right: 'auto', bottom: 'auto' },
      nlm_ext_toolbar_hidden: true, nlm_ext_toolbar_collapsed: true,
      queue: [{ id: 'queue-1', url: 'https://example.com/a', status: 'pending', errorCount: 0, addedAt: 10 }],
      history: [{ action: 'add_source', url: 'https://example.com/a', timestamp: 10 }],
      queueRun: { status: 'processing' }, pendingPdf: { tabId: 1 }
    }
  });
  assert.equal(result.local.addDelay, 2500);
  assert.equal(result.local.commentsLimit, 0);
  assert.equal(result.local.commentsIncludeReplies, false);
  assert.equal(result.local.nlm_ext_toolbar_hidden, true);
  assert.equal(result.local.lastNotebookByAccount[1], 'nb-1');
  assert.equal(result.sync.enableNotifications, false);
  assert.equal(result.local.queue[0].id, 'queue-1');
  assert.equal(result.local.queueRun, undefined);
  assert.equal(result.local.pendingPdf, undefined);
});

test('Backup migrates legacy notification, delay, reply and toolbar keys', () => {
  const result = backupHelper().normalize({
    sync: { settingsNotifications: false, addDelay: 3000 },
    local: { commentsMode: 'new', commentsReplies: false, toolbarHidden: true, toolbarCollapsed: false,
      toolbarPosition: { left: '5px', top: '10px' } }
  });
  assert.equal(result.sync.enableNotifications, false);
  assert.equal(result.local.addDelay, 3000);
  assert.equal(result.local.commentsMode, 'newest');
  assert.equal(result.local.commentsIncludeReplies, false);
  assert.equal(result.local.nlm_ext_toolbar_hidden, true);
  assert.equal(result.local.nlm_ext_toolbar_collapsed, false);
});

test('Malformed backup values and duplicate queue IDs cannot overwrite storage', () => {
  const helper = backupHelper();
  for (const backup of [null, [], { sync: [] }, { sync: { enableNotifications: 'false' } },
    { sync: { activeAccount: -1 } }, { local: { addDelay: -1 } }, { local: { queue: [{ url: 'javascript:alert(1)' }] } },
    { local: { queue: [{ id: 'same', url: 'https://example.com/a' }, { id: 'same', url: 'https://example.com/b' }] } }
  ]) assert.throws(() => helper.normalize(backup));
});

test('An exported in-flight queue item is restored as a verifiable pending item', () => {
  const result = backupHelper().normalize({ local: { queue: [{ id: 'q-1', url: 'https://example.com/a', status: 'processing' }] } });
  assert.equal(result.local.queue[0].status, 'pending');
  assert.equal(result.local.queue[0].recovered, true);
});

test('Backups preserve uncertainty snapshots needed to avoid replaying a source import', () => {
  const snapshot = { notebookId: 'nb-1', authuser: 1, beforeSourceIds: ['old-source'] };
  const result = backupHelper().normalize({ local: { queue: [
    { id: 'q-1', url: 'https://example.com/one', status: 'failed', sourceAttempt: snapshot }
  ] } });
  assert.deepEqual(plain(result.local.queue[0].sourceAttempt), snapshot);
  assert.throws(() => backupHelper().normalize({ local: { queue: [
    { url: 'https://example.com/one', sourceAttempt: { ...snapshot, beforeSourceIds: 'wrong-type' } }
  ] } }), /Invalid source attempt/);
});

function i18nEnvironment(options = {}) {
  const env = loadBackground({ ...options, fetch: async url => {
    const language = url.includes('/ru/') ? 'ru' : 'en';
    return new Response(fs.readFileSync(path.join(root, '_locales', language, 'messages.json'), 'utf8'));
  } });
  env.context.document = { querySelectorAll: () => [] };
  env.context.navigator = { language: 'en' };
  env.context.importScripts('lib/i18n.js');
  return { env, i18n: env.run('I18n') };
}

test('Localization retains literal dollar characters in substitutions', async () => {
  const { i18n } = i18nEnvironment();
  await i18n.init();
  assert.equal(i18n.get('pendingPdf', { TITLE: '$& <title>' }), 'PDF ready to capture: $& <title>');
});

test('Localization uses an English per-key fallback and persists browser Russian', async () => {
  const { env, i18n } = i18nEnvironment();
  env.chrome.i18n.getUILanguage = () => 'ru-RU';
  await i18n.init();
  assert.equal(i18n.getLanguage(), 'ru');
  assert.equal(env.stores.sync.language, 'ru');
  delete i18n.translations.addCurrentPage;
  assert.equal(i18n.get('addCurrentPage'), 'Add page');
});

test('Both supported languages translate counts without leaving placeholder tokens', async () => {
  const { i18n } = i18nEnvironment();
  await i18n.init();
  for (const language of ['en', 'ru']) {
    await i18n.setLanguage(language);
    const text = i18n.get('tabsSelectedCount', { CURRENT: 2, TOTAL: 5 });
    assert.ok(text.includes('2') && text.includes('5'));
    assert.ok(!text.includes('$'));
  }
});
