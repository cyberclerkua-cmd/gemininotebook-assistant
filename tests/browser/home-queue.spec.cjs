const { test, expect, NB0, NB1, ARTICLE, guid } = require('../helpers/browser.cjs');

async function bulk(page, text) {
  await page.locator('summary').filter({ hasText: 'Bulk import' }).click();
  await page.locator('#bulk-urls').fill(text);
}

test('Manual URL import reports an RPC rejection instead of success', async ({ extension }) => {
  const page = await extension.popup();
  extension.backend.rpcErrors.izAoDd = 'Source limit <reached>';
  await page.locator('#single-url').fill('https://example.com/rejected');
  await page.locator('#add-single-url').click();
  await expect(page.locator('#home-status')).toContainText('Source limit <reached>');
  await expect(page.locator('#home-status')).toHaveClass(/error/);
  expect(extension.backend.notebook(NB0).sources).toHaveLength(4);
});

test('Bulk import sends both web and YouTube sources and records history', async ({ extension }) => {
  const page = await extension.popup();
  await bulk(page, 'https://example.com/a\nhttps://www.youtube.com/watch?v=abcdefghijk\nhttps://example.com/b');
  await page.locator('#bulk-add').click();
  await expect(page.locator('#home-status')).toContainText('Added 3');
  expect(extension.backend.notebook(NB0).sources).toHaveLength(7);
  expect(extension.backend.notebook(NB0).sources.at(-1).type).toBe(9);
  const history = await extension.worker.evaluate(async () => (await chrome.storage.local.get('history')).history);
  expect(history).toHaveLength(3);
});

test('An invalid bulk URL aborts validation before any source is sent', async ({ extension }) => {
  const page = await extension.popup();
  await bulk(page, 'https://example.com/a\njavascript:alert(1)');
  await page.locator('#bulk-add').click();
  await expect(page.locator('#home-status')).toHaveClass(/error/);
  expect(extension.backend.rpcRequests.filter(request => request.rpcId === 'izAoDd')).toHaveLength(0);
});

test('Creating a notebook selects its actual ID, even when the title is a UUID', async ({ extension }) => {
  const page = await extension.popup();
  await page.locator('summary').filter({ hasText: 'Create notebook' }).click();
  await page.locator('#new-notebook-title').fill('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await page.locator('#create-notebook').click();
  await expect(page.locator('#notebook-select')).toHaveValue(guid(100));
  expect(extension.backend.notebook(guid(100)).title).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
});

test('The saved Google account and its notebook survive reopening the popup', async ({ extension }) => {
  await extension.worker.evaluate(() => chrome.storage.sync.set({ activeAccount: 1 }));
  let page = await extension.popup();
  await expect(page.locator('#account-select')).toHaveValue('1');
  await expect(page.locator('#notebook-select')).toHaveValue(NB1);
  await page.close();
  page = await extension.popup();
  await expect(page.locator('#account-select')).toHaveValue('1');
  await expect(page.locator('#notebook-select')).toHaveValue(NB1);
});

test('Switching accounts sends new sources only to the selected account', async ({ extension }) => {
  const page = await extension.popup();
  await page.locator('#account-select').selectOption('1');
  await expect(page.locator('#notebook-select')).toHaveValue(NB1);
  await page.locator('#single-url').fill('https://example.com/account-one');
  await page.locator('#add-single-url').click();
  await expect(page.locator('#home-status')).toHaveClass(/success/);
  expect(extension.backend.notebook(NB0).sources).toHaveLength(4);
  expect(extension.backend.notebook(NB1).sources).toHaveLength(2);
  const request = extension.backend.rpcRequests.find(request => request.rpcId === 'izAoDd');
  expect(request.account).toBe(1);
  expect(request.token).toBe('token-1');
});

test('Queue UI reflects real progress and completion', async ({ extension }) => {
  extension.backend.delays.izAoDd = 300;
  const page = await extension.popup();
  await bulk(page, 'https://example.com/a\nhttps://example.com/b');
  await page.locator('#bulk-queue').click();
  await page.locator('[data-tab="queue"]').click();
  await expect(page.locator('.queue-item')).toHaveCount(2);
  await page.locator('#process-queue').click();
  await expect(page.locator('#queue-status')).toContainText('Processing:');
  await expect(page.locator('#queue-status')).toContainText('Done: 2 added');
  await expect(page.locator('.queue-item')).toHaveCount(0);
  expect(extension.backend.notebook(NB0).sources).toHaveLength(6);
});

test('Failed queue items retain their error and can be retried from the popup', async ({ extension }) => {
  extension.backend.rpcErrors.izAoDd = 'Source limit reached';
  const page = await extension.popup();
  await bulk(page, 'https://example.com/a');
  await page.locator('#bulk-queue').click();
  await page.locator('[data-tab="queue"]').click();
  await page.locator('#process-queue').click();
  await expect(page.locator('#queue-status')).toContainText('1 failed');
  await expect(page.locator('.queue-item-state')).toContainText('Source limit reached');
  await expect(page.locator('#retry-failed')).toBeVisible();
  delete extension.backend.rpcErrors.izAoDd;
  await page.locator('#retry-failed').click();
  await expect(page.locator('#process-queue')).toBeEnabled();
  await page.locator('#process-queue').click();
  await expect(page.locator('#queue-status')).toContainText('Done: 1 added, 0 failed');
  expect(extension.backend.rpcRequests.filter(request => request.rpcId === 'izAoDd')).toHaveLength(4);
});

test('Queue removal uses stable IDs after the displayed indices change', async ({ extension }) => {
  const page = await extension.popup();
  await bulk(page, 'https://example.com/a\nhttps://example.com/b\nhttps://example.com/c');
  await page.locator('#bulk-queue').click();
  await page.locator('[data-tab="queue"]').click();
  await expect(page.locator('.queue-item')).toHaveCount(3);
  const ids = await page.locator('.queue-item').evaluateAll(rows => rows.map(row => row.dataset.id));
  await page.evaluate(id => chrome.runtime.sendMessage({ cmd: 'remove-from-queue', params: { id } }), ids[0]);
  await page.locator(`.queue-item[data-id="${ids[1]}"] .remove`).click();
  await expect(page.locator('.queue-item')).toHaveCount(1);
  await expect(page.locator('.queue-item')).toContainText('https://example.com/c');
});

test('Clear queue cancels further imports without restoring an old queue snapshot', async ({ extension }) => {
  extension.backend.delays.izAoDd = 700;
  const page = await extension.popup();
  await bulk(page, 'https://example.com/a\nhttps://example.com/b');
  await page.locator('#bulk-queue').click();
  await page.locator('[data-tab="queue"]').click();
  await page.locator('#process-queue').click();
  await expect.poll(() => extension.backend.rpcRequests.filter(request => request.rpcId === 'izAoDd').length).toBe(1);
  await page.locator('#clear-queue').click();
  await expect(page.locator('.queue-item')).toHaveCount(0);
  await expect(page.locator('#queue-status')).toContainText('cancelled');
  await expect.poll(() => extension.backend.notebook(NB0).sources.length).toBe(5);
  const state = await extension.worker.evaluate(async () => (await chrome.storage.local.get(['queue', 'queueRun'])));
  expect(state.queue).toHaveLength(0);
  expect(state.queueRun.status).toBe('cancelled');
});

test('A complete Chrome restart resumes the queue with its original notebook and account', async ({ extension }) => {
  const page = await extension.popup();
  await extension.worker.evaluate(() => chrome.storage.local.set({ addDelay: 8000 }));
  await bulk(page, 'https://example.com/restart-a\nhttps://example.com/restart-b');
  await page.locator('#bulk-queue').click();
  await page.locator('[data-tab="queue"]').click();
  await page.locator('#process-queue').click();
  await expect.poll(() => extension.worker.evaluate(async () => (await chrome.storage.local.get('queueRun')).queueRun.processed)).toBe(1);
  await extension.worker.evaluate(() => chrome.storage.sync.set({ activeAccount: 1 }));
  await extension.relaunch();
  // Cached extension workers are not routed by CDP on persistent-context
  // relaunch. Substitute the remote API at its boundary, keeping Chrome's
  // worker, storage, scheduler and account selection real.
  await extension.worker.evaluate(({ notebooks }) => {
    globalThis.__resumedRequests = [];
    NotebookLMAPI.getTokens = async function(authuser) {
      this.tokens = { authuser, cfb2h: 'fixture', SNlM0e: 'fixture' };
      return this.tokens;
    };
    NotebookLMAPI.listAccounts = async () => [0, 1].map(authuser => ({ authuser, name: `Account ${authuser}`, email: `account${authuser}@example.test` }));
    NotebookLMAPI.listNotebooks = async function() { return notebooks[this.tokens.authuser]; };
    NotebookLMAPI.getNotebook = async function(notebookId) {
      return structuredClone(notebooks[this.tokens.authuser].find(notebook => notebook.id === notebookId));
    };
    NotebookLMAPI.addSource = async function(notebookId, url) {
      globalThis.__resumedRequests.push({ notebookId, url, authuser: this.tokens.authuser });
    };
  }, { notebooks: extension.backend.notebooks });
  const reopened = await extension.popup();
  await expect(reopened.locator('#account-select')).toHaveValue('1');
  await reopened.locator('[data-tab="queue"]').click();
  await expect(reopened.locator('#queue-status')).toContainText('Done: 2 added', { timeout: 20000 });
  const resumed = await extension.worker.evaluate(() => globalThis.__resumedRequests);
  expect(resumed).toEqual([{ notebookId: NB0, url: 'https://example.com/restart-b', authuser: 0 }]);
  expect(extension.backend.notebook(NB0).sources).toHaveLength(5);
  expect(extension.backend.notebook(NB1).sources).toHaveLength(1);
  expect(extension.backend.rpcRequests.filter(request => request.rpcId === 'izAoDd')).toHaveLength(1);
});
