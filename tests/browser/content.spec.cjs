const { test, expect, NB0, NB1, guid } = require('../helpers/browser.cjs');

async function notebookPage(extension, query = '') {
  const page = await extension.context.newPage();
  await page.goto(`https://notebook.google.com/notebook/${NB0}?authuser=0${query}`);
  await expect(page.locator('.nlm-ext-toolbar')).toBeVisible();
  await expect(page.locator('.nlm-ext-checkbox')).toHaveCount(extension.backend.notebook(NB0).sources.length);
  return page;
}

test('The toolbar selects only sources and supports select-all and deselect-all', async ({ extension }) => {
  const page = await notebookPage(extension);
  await expect(page.locator('#non-source-note .nlm-ext-checkbox')).toHaveCount(0);
  await page.locator('#nlm-ext-select-all').click();
  await expect(page.locator('#nlm-ext-count')).toHaveText('4 selected');
  await page.locator('#nlm-ext-select-all').click();
  await expect(page.locator('#nlm-ext-count')).toHaveText('0 selected');
});

test('Bulk delete removes exactly the selected sources after API confirmation', async ({ extension }) => {
  const page = await notebookPage(extension);
  await page.locator('.nlm-ext-checkbox').nth(0).check();
  await page.locator('#nlm-ext-delete').click();
  await expect(page.locator('.single-source-container')).toHaveCount(3);
  expect(extension.backend.notebook(NB0).sources.some(source => source.id === guid(1))).toBe(false);
  await expect(page.locator('.nlm-ext-toast')).toContainText('Deleted 1');
});

test('An HTTP-200 RPC deletion error leaves the selected rows intact', async ({ extension }) => {
  extension.backend.rpcErrors.tGMBJ = 'Deletion denied';
  const page = await notebookPage(extension);
  await page.locator('.nlm-ext-checkbox').first().check();
  await page.locator('#nlm-ext-delete').click();
  await expect(page.locator('.nlm-ext-toast')).toContainText('Deletion denied');
  await expect(page.locator('.single-source-container')).toHaveCount(4);
  expect(extension.backend.notebook(NB0).sources).toHaveLength(4);
});

test('Ambiguous duplicate titles cannot delete a different source', async ({ extension }) => {
  extension.backend.notebook(NB0).sources = [
    { id: guid(1), title: 'Same title', type: 5 }, { id: guid(2), title: 'Same title', type: 5 }
  ];
  const page = await notebookPage(extension);
  await page.locator('#nlm-ext-select-all').click();
  await page.locator('#nlm-ext-delete').click();
  await expect(page.locator('.nlm-ext-toast')).toContainText('Multiple sources');
  expect(extension.backend.rpcRequests.filter(request => request.rpcId === 'tGMBJ')).toHaveLength(0);
  await expect(page.locator('.single-source-container')).toHaveCount(2);
});

test('Duplicate titles can be deleted when explicit source IDs are present', async ({ extension }) => {
  extension.backend.notebook(NB0).sources = [
    { id: guid(1), title: 'Same title', type: 5 }, { id: guid(2), title: 'Same title', type: 5 }
  ];
  const page = await notebookPage(extension, '&ids=true');
  await page.locator('.nlm-ext-checkbox').first().check();
  await page.locator('#nlm-ext-delete').click();
  await expect(page.locator('.single-source-container')).toHaveCount(1);
  expect(extension.backend.notebook(NB0).sources[0].id).toBe(guid(2));
});

test('A UUID in a source title is never mistaken for another source ID', async ({ extension }) => {
  extension.backend.notebook(NB0).sources = [
    { id: guid(1), title: guid(2), type: 5 }, { id: guid(2), title: 'Other source', type: 5 }
  ];
  const page = await notebookPage(extension);
  await page.locator('.nlm-ext-checkbox').first().check();
  await page.locator('#nlm-ext-delete').click();
  await expect(page.locator('.single-source-container')).toHaveCount(1);
  expect(extension.backend.notebook(NB0).sources[0].id).toBe(guid(2));
});

test('Closing and minimizing the toolbar persist across page reloads', async ({ extension }) => {
  const page = await notebookPage(extension);
  await page.locator('#nlm-ext-min').click();
  await expect(page.locator('.nlm-ext-toolbar')).toHaveClass(/is-collapsed/);
  await page.reload();
  await expect(page.locator('.nlm-ext-toolbar')).toHaveClass(/is-collapsed/);
  await page.locator('#nlm-ext-close').click();
  await expect(page.locator('.nlm-ext-reopen-btn')).toBeVisible();
  await page.reload();
  await expect(page.locator('.nlm-ext-toolbar')).toBeHidden();
  await page.locator('.nlm-ext-reopen-btn').click();
  await expect(page.locator('.nlm-ext-toolbar')).toBeVisible();
});

test('Enable/disable, dark theme, late source rows and SPA navigation update the toolbar', async ({ extension }) => {
  await extension.worker.evaluate(() => chrome.storage.sync.set({ enableBulkDelete: false }));
  const page = await extension.context.newPage();
  await page.goto(`https://notebook.google.com/notebook/${NB0}?authuser=0`);
  await expect(page.locator('.nlm-ext-toolbar')).toHaveCount(0);
  await extension.worker.evaluate(() => chrome.storage.sync.set({ enableBulkDelete: true, theme: 'dark' }));
  await expect(page.locator('.nlm-ext-toolbar')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-nlm-theme', 'dark');
  await page.evaluate(() => {
    const row = document.createElement('div');
    row.className = 'single-source-container';
    row.innerHTML = '<button class="source-stretched-button" aria-label="Late source">Late source</button>';
    document.querySelector('.sources-panel').appendChild(row);
  });
  await expect(page.locator('.nlm-ext-checkbox')).toHaveCount(5);
  await page.evaluate(() => history.pushState({}, '', '/'));
  await expect(page.locator('.nlm-ext-toolbar')).toBeHidden();
  await expect(page.locator('.nlm-ext-checkbox')).toHaveCount(0);
});

test('Drive sync and account switching work from the floating toolbar', async ({ extension }) => {
  const page = await notebookPage(extension);
  await page.locator('#nlm-ext-sync').click();
  await expect(page.locator('.nlm-ext-toast')).toContainText('Synced 1');
  expect(extension.backend.notebook(NB0).sources.find(source => source.id === guid(2)).fresh).toBe(true);
  await expect(page.locator('#nlm-ext-account')).toBeVisible();
  await page.locator('#nlm-ext-account').selectOption('1');
  await expect(page).toHaveURL('https://notebook.google.com/?authuser=1');
  const active = await extension.worker.evaluate(async () => (await chrome.storage.sync.get('activeAccount')).activeAccount);
  expect(active).toBe(1);
});

test('Toolbar dragging persists its position and resizing keeps it in the viewport', async ({ extension }) => {
  const page = await notebookPage(extension);
  const handle = await page.locator('#nlm-ext-drag-handle').boundingBox();
  await page.mouse.move(handle.x + 5, handle.y + 5);
  await page.mouse.down();
  await page.mouse.move(150, 200, { steps: 10 });
  await page.mouse.up();
  const before = await page.locator('.nlm-ext-toolbar').boundingBox();
  const saved = await extension.worker.evaluate(async () => (await chrome.storage.local.get('nlm_ext_toolbar_pos')).nlm_ext_toolbar_pos);
  expect(saved.left).toBeTruthy();
  await page.reload();
  await expect(page.locator('.nlm-ext-toolbar')).toBeVisible();
  const after = await page.locator('.nlm-ext-toolbar').boundingBox();
  expect(Math.abs(after.x - before.x)).toBeLessThan(2);
  await page.setViewportSize({ width: 600, height: 400 });
  await expect.poll(async () => {
    const rect = await page.locator('.nlm-ext-toolbar').boundingBox();
    return rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 601 && rect.y + rect.height <= 401;
  }).toBe(true);
});

test('The legacy NotebookLM domain receives the same toolbar and account isolation', async ({ extension }) => {
  await extension.worker.evaluate(() => chrome.storage.sync.set({ activeAccount: 1 }));
  const page = await extension.context.newPage();
  await page.goto(`https://notebooklm.google.com/notebook/${NB0}?authuser=0`);
  await expect(page.locator('.nlm-ext-checkbox')).toHaveCount(4);
  const request = extension.backend.rpcRequests.find(request => request.rpcId === 'rLM1Ne');
  expect(request.account).toBe(0);
});
