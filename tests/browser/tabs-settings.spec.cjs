const { test, expect, NB0, ARTICLE, guid } = require('../helpers/browser.cjs');

async function readDownload(download) {
  const stream = await download.createReadStream();
  const buffers = [];
  for await (const buffer of stream) buffers.push(buffer);
  return Buffer.concat(buffers).toString('utf8');
}

test('Tab manager imports open tabs, toggles selection and loads valid fallback icons', async ({ extension }) => {
  for (const suffix of ['?tab=1', '?tab=2']) {
    const tab = await extension.context.newPage();
    await tab.goto(ARTICLE + suffix);
  }
  const popup = await extension.popup();
  const opened = extension.context.waitForEvent('page');
  await popup.locator('#import-tabs').click();
  const page = await opened;
  await expect(page.locator('.tab-item')).toHaveCount(2);
  await expect(page.locator('#notebook-select')).toHaveValue(NB0);
  await expect.poll(() => page.locator('.tab-item img').first().evaluate(image => image.complete && image.naturalWidth)).toBe(16);
  await page.locator('#select-all').click();
  await expect(page.locator('#count')).toHaveText('0 of 2 tabs selected');
  await page.locator('#add-selected').click();
  await expect(page.locator('#status')).toContainText('No tabs selected');
  await page.locator('#select-all').click();
  await page.locator('#add-selected').click();
  await expect(page.locator('#status')).toContainText('Successfully imported 2');
  expect(extension.backend.notebook(NB0).sources).toHaveLength(6);
  await page.locator('.tab-cb').first().uncheck();
  await page.locator('#add-as-queue').click();
  const queue = await extension.worker.evaluate(async () => (await chrome.storage.local.get('queue')).queue);
  expect(queue).toHaveLength(1);
});

test('Sources tab deletes exact IDs even when names are duplicated', async ({ extension }) => {
  extension.backend.notebook(NB0).sources = [{ id: guid(1), title: 'Duplicate', type: 5 }, { id: guid(2), title: 'Duplicate', type: 5 }];
  const page = await extension.popup();
  await page.locator('[data-tab="organize"]').click();
  await expect(page.locator('.source-cb')).toHaveCount(2);
  await page.locator('.source-cb').first().check();
  await page.locator('#delete-selected').click();
  await expect(page.locator('.source-cb')).toHaveCount(1);
  await expect(page.locator('#delete-selected')).toBeHidden();
  expect(extension.backend.notebook(NB0).sources[0].id).toBe(guid(2));
});

test('Source export downloads the complete title/type/URL list', async ({ extension }) => {
  const page = await extension.popup();
  await page.locator('[data-tab="organize"]').click();
  await expect(page.locator('.source-item')).toHaveCount(4);
  const downloading = page.waitForEvent('download');
  await page.locator('#export-sources').click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('notebooklm-sources.txt');
  const text = await readDownload(download);
  expect(text).toContain('First page\tweb_page\thttps://example.com/first');
  expect(text.split('\n')).toHaveLength(4);
});

test('Direct operation errors are searchable in history and history can be cleared', async ({ extension }) => {
  const page = await extension.popup();
  extension.backend.rpcErrors.izAoDd = 'Searchable failure';
  await page.locator('#single-url').fill('https://example.com/rejected');
  await page.locator('#add-single-url').click();
  await expect(page.locator('#home-status')).toHaveClass(/error/);
  await page.locator('[data-tab="history"]').click();
  await expect(page.locator('.history-item')).toHaveCount(1);
  await page.locator('#history-search').fill('Searchable');
  await expect(page.locator('.history-item')).toHaveCount(1);
  await expect(page.locator('.history-item')).toContainText('Searchable failure');
  await page.locator('#clear-history').click();
  await expect(page.locator('.history-item')).toHaveCount(0);
});

test('Theme, language, toggles and delay persist in Chrome storage', async ({ extension }) => {
  const page = await extension.popup();
  await page.locator('[data-tab="settings"]').click();
  await page.locator('#settings-theme').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.locator('#settings-lang').selectOption('ru');
  await expect(page.locator('[data-tab="home"]')).toContainText('Главная');
  await page.locator('#settings-delay').fill('3000');
  await page.locator('#settings-delay').dispatchEvent('change');
  await page.locator('#settings-bulk-delete').uncheck();
  await page.locator('#settings-sync-drive').uncheck();
  await page.locator('#settings-notifications').check();
  await expect.poll(() => extension.worker.evaluate(async () => (await chrome.storage.sync.get('enableNotifications')).enableNotifications)).toBe(true);
  const settings = await extension.worker.evaluate(async () => ({ sync: await chrome.storage.sync.get(null), local: await chrome.storage.local.get('addDelay') }));
  expect(settings.sync.language).toBe('ru');
  expect(settings.sync.enableBulkDelete).toBe(false);
  expect(settings.sync.enableSyncDrive).toBe(false);
  expect(settings.local.addDelay).toBe(3000);
});

test('Backup and restore preserve real keys, queue, history and zero limits', async ({ extension }) => {
  const page = await extension.popup();
  await extension.worker.evaluate(() => chrome.storage.local.set({ commentsLimit: 0, commentsIncludeReplies: false,
    nlm_ext_toolbar_hidden: true, nlm_ext_toolbar_pos: { left: '25px', top: '35px' },
    queue: [{ id: 'queue-1', url: 'https://example.com/saved', title: 'Saved', status: 'pending', errorCount: 0, addedAt: 10 }],
    history: [{ action: 'add_source', title: 'Saved', url: 'https://example.com/saved', timestamp: 10 }] }));
  await page.locator('[data-tab="settings"]').click();
  const downloading = page.waitForEvent('download');
  await page.locator('#backup-settings').click();
  const backup = JSON.parse(await readDownload(await downloading));
  expect(backup.version).toBe(require('../../manifest.json').version);
  expect(backup.local.commentsLimit).toBe(0);
  expect(backup.local.nlm_ext_toolbar_hidden).toBe(true);
  await extension.worker.evaluate(async () => {
    await chrome.storage.local.set({ queue: [], history: [], commentsLimit: 1000, nlm_ext_toolbar_hidden: false });
    await chrome.storage.sync.set({ theme: 'dark' });
  });
  await page.locator('#restore-file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await expect(page.locator('#settings-status')).toContainText('Settings restored');
  const restored = await extension.worker.evaluate(async () => ({ sync: await chrome.storage.sync.get(null), local: await chrome.storage.local.get(null) }));
  expect(restored.sync.theme).toBe('light');
  expect(restored.local.queue[0].id).toBe('queue-1');
  expect(restored.local.history[0].title).toBe('Saved');
  expect(restored.local.commentsLimit).toBe(0);
  expect(restored.local.nlm_ext_toolbar_hidden).toBe(true);
});

test('Malformed restore files fail validation without changing settings', async ({ extension }) => {
  const page = await extension.popup();
  await page.locator('[data-tab="settings"]').click();
  await page.locator('#restore-file').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"sync":{"theme":"broken"}}') });
  await expect(page.locator('#settings-status')).toContainText('Invalid backup');
  const settings = await extension.worker.evaluate(async () => (await chrome.storage.sync.get('theme')).theme);
  expect(settings).toBe('light');
});

test('Tab manager includes tabs from multiple Chrome windows', async ({ extension }) => {
  const article = await extension.context.newPage();
  await article.goto(ARTICLE + '?window=1');
  await extension.worker.evaluate(url => chrome.windows.create({ url }), ARTICLE + '?window=2');
  await expect.poll(() => extension.worker.evaluate(async () => (await chrome.tabs.query({}))
    .filter(tab => tab.url?.includes('/extension-test/article?window=')).length)).toBe(2);
  const page = await extension.context.newPage();
  await page.goto(`chrome-extension://${extension.id}/app/app.html`);
  await expect(page.locator('.tab-item')).toHaveCount(2);
});
