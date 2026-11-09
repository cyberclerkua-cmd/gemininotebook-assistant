const { test, expect, NB0, NB1 } = require('../helpers/browser.cjs');

test('The last account selection wins when authentication responses arrive out of order', async ({ extension }) => {
  const page = await extension.popup();
  await page.evaluate(() => {
    window.completedSwitches = [];
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async message => {
      try { return await send(message); }
      finally { if (message.cmd === 'set-active-account') window.completedSwitches.push(message.params.authuser); }
    };
  });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let waiting = false;
  await extension.context.route('https://notebook.google.com/?authuser=1', async route => {
    waiting = true;
    await held;
    await extension.backend.route(route);
  });
  try {
    await page.locator('#account-select').selectOption('1');
    await expect.poll(() => waiting).toBe(true);
    await page.locator('#account-select').selectOption('0');
    await expect(page.locator('#notebook-select')).toHaveValue(NB0);
    release();
    await expect.poll(() => page.evaluate(() => window.completedSwitches.includes(1))).toBe(true);
    await expect(page.locator('#account-select')).toHaveValue('0');
    await expect(page.locator('#notebook-select')).toHaveValue(NB0);
    expect(await extension.worker.evaluate(async () => (await chrome.storage.sync.get('activeAccount')).activeAccount)).toBe(0);
    await page.locator('#single-url').fill('https://example.com/latest-account');
    await page.locator('#add-single-url').click();
    await expect(page.locator('#home-status')).toHaveClass(/success/);
    expect(extension.backend.notebook(NB0).sources).toHaveLength(5);
    expect(extension.backend.notebook(NB1).sources).toHaveLength(1);
  } finally { release(); }
});

test('Retrying a partial bulk import submits only failed and unattempted URLs', async ({ extension }) => {
  let rejectVideo = true;
  await extension.context.route(/\/data\/batchexecute\?/, async route => {
    const body = new URLSearchParams(route.request().postData());
    const request = JSON.parse(body.get('f.req'))[0][0];
    if (rejectVideo && request[0] === 'izAoDd' && JSON.parse(request[1])[0][0][7]) {
      return route.fulfill({ status: 200, body: JSON.stringify([['er', 'izAoDd', null, null, 9, ['Video import rejected']]]) });
    }
    return extension.backend.route(route);
  });
  const page = await extension.popup();
  const web = 'https://example.com/partial';
  const video = 'https://www.youtube.com/watch?v=abcdefghijk';
  await page.locator('summary').filter({ hasText: 'Bulk import' }).click();
  await page.locator('#bulk-urls').fill(`${web}\n${video}`);
  await page.locator('#bulk-add').click();
  await expect(page.locator('#home-status')).toContainText('Added 1');
  await expect(page.locator('#bulk-urls')).toHaveValue(video);
  const history = await extension.worker.evaluate(async () => (await chrome.storage.local.get('history')).history);
  expect(history.filter(entry => entry.action === 'add_source')).toHaveLength(1);
  rejectVideo = false;
  await page.locator('#bulk-add').click();
  await expect(page.locator('#bulk-urls')).toHaveValue('');
  expect(extension.backend.notebook(NB0).sources.filter(source => source.url === web)).toHaveLength(1);
  expect(extension.backend.notebook(NB0).sources.filter(source => source.url === video)).toHaveLength(1);
});

test('A failed account switch restores the confirmed account and notebook', async ({ extension }) => {
  const page = await extension.popup();
  await extension.context.route('https://notebook.google.com/?authuser=1', route =>
    route.fulfill({ status: 403, body: 'Account unavailable' }));
  await page.locator('#account-select').selectOption('1');
  await expect(page.locator('#home-status')).toContainText('HTTP 403');
  await expect(page.locator('#account-select')).toHaveValue('0');
  await expect(page.locator('#notebook-select')).toHaveValue(NB0);
  await expect(page.locator('#notebook-select')).toBeEnabled();
  expect(await extension.worker.evaluate(async () => (await chrome.storage.sync.get('activeAccount')).activeAccount)).toBe(0);
});

test('Notebook creation remembers its initiating account even if the user switches before completion', async ({ extension }) => {
  extension.backend.delays.CCqFvf = 800;
  const page = await extension.popup();
  await page.locator('summary').filter({ hasText: 'Create notebook' }).click();
  await page.locator('#new-notebook-title').fill('Created in account zero');
  await page.locator('#create-notebook').click();
  await expect.poll(() => extension.backend.rpcRequests.some(request => request.rpcId === 'CCqFvf')).toBe(true);
  await page.locator('#account-select').selectOption('1');
  await expect(page.locator('#notebook-select')).toHaveValue(NB1);
  await expect.poll(() => extension.backend.notebooks[0].length).toBe(2);
  const created = extension.backend.notebooks[0][1];
  await expect.poll(() => extension.worker.evaluate(async () => (await chrome.storage.local.get('lastNotebookByAccount')).lastNotebookByAccount[0])).toBe(created.id);
  await expect(page.locator('#account-select')).toHaveValue('1');
  await expect(page.locator('#notebook-select')).toHaveValue(NB1);
  expect(await extension.worker.evaluate(async () => (await chrome.storage.local.get('lastNotebookByAccount')).lastNotebookByAccount[1])).toBe(NB1);
});

test('A real Chrome fetch losing its reply does not create a second queued source', async ({ extension }) => {
  extension.backend.dropResponses.izAoDd = 1;
  const page = await extension.popup();
  const url = 'https://example.com/lost-reply';
  await page.locator('summary').filter({ hasText: 'Bulk import' }).click();
  await page.locator('#bulk-urls').fill(url);
  await page.locator('#bulk-queue').click();
  await page.locator('[data-tab="queue"]').click();
  await page.locator('#process-queue').click();
  await expect(page.locator('#queue-status')).toContainText('Done: 1 added, 0 failed');
  expect(extension.backend.notebook(NB0).sources.filter(source => source.url === url)).toHaveLength(1);
  expect(extension.backend.rpcRequests.filter(request => request.rpcId === 'izAoDd')).toHaveLength(1);
});

test('Clearing and immediately restarting a busy queue does not wait for the alarm watchdog', async ({ extension }) => {
  extension.backend.delays.izAoDd = 800;
  const page = await extension.popup();
  await page.locator('summary').filter({ hasText: 'Bulk import' }).click();
  await page.locator('#bulk-urls').fill('https://example.com/old-run');
  await page.locator('#bulk-queue').click();
  await page.locator('[data-tab="queue"]').click();
  await page.locator('#process-queue').click();
  await expect.poll(() => extension.backend.rpcRequests.filter(request => request.rpcId === 'izAoDd').length).toBe(1);
  await page.locator('#clear-queue').click();
  await page.locator('[data-tab="home"]').click();
  await page.locator('#bulk-urls').fill('https://example.com/new-run');
  await page.locator('#bulk-queue').click();
  await page.locator('[data-tab="queue"]').click();
  await page.locator('#process-queue').click();
  await expect(page.locator('#queue-status')).toContainText('Done: 1 added', { timeout: 5000 });
  expect(extension.backend.notebook(NB0).sources.filter(source => source.url === 'https://example.com/new-run')).toHaveLength(1);
});

test('An unconfirmed bulk write is shown separately and excluded from retry', async ({ extension }) => {
  extension.backend.dropResponses.izAoDd = 1;
  const page = await extension.popup();
  const web = 'https://example.com/unconfirmed';
  const video = 'https://www.youtube.com/watch?v=abcdefghijk';
  await page.locator('summary').filter({ hasText: 'Bulk import' }).click();
  await page.locator('#bulk-urls').fill(`${web}\n${video}`);
  await page.locator('#bulk-add').click();
  await expect(page.locator('#home-status')).toContainText('unconfirmed 1');
  await expect(page.locator('#bulk-results [data-status="uncertain"]')).toContainText(web);
  await expect(page.locator('#bulk-urls')).toHaveValue(video);
  await page.locator('#bulk-add').click();
  await expect(page.locator('#bulk-urls')).toHaveValue('');
  expect(extension.backend.notebook(NB0).sources.filter(source => source.url === web)).toHaveLength(1);
  expect(extension.backend.notebook(NB0).sources.filter(source => source.url === video)).toHaveLength(1);
});

test('The tab manager unchecks acknowledged imports when a later source fails', async ({ extension }) => {
  let rejectVideo = true;
  await extension.context.route(/\/data\/batchexecute\?/, async route => {
    const request = JSON.parse(new URLSearchParams(route.request().postData()).get('f.req'))[0][0];
    if (rejectVideo && request[0] === 'izAoDd' && JSON.parse(request[1])[0][0][7]) {
      return route.fulfill({ status: 200, body: JSON.stringify([['er', 'izAoDd', null, null, 9, ['Video import rejected']]]) });
    }
    return extension.backend.route(route);
  });
  const web = 'https://www.youtube.com/extension-test/article';
  const video = 'https://www.youtube.com/watch?v=abcdefghijk';
  for (const url of [web, video]) {
    const tab = await extension.context.newPage();
    await tab.goto(url);
  }
  const page = await extension.context.newPage();
  await page.goto(`chrome-extension://${extension.id}/app/app.html`);
  await expect(page.locator('#notebook-select')).toHaveValue(NB0);
  await expect(page.locator('.tab-cb')).toHaveCount(2);
  await page.locator('#add-selected').click();
  await expect(page.locator('#status')).toContainText('Added 1');
  await expect(page.locator('.tab-cb:checked')).toHaveCount(1);
  await expect(page.locator('.tab-item').filter({ has: page.locator('.tab-cb:checked') })).toContainText(video);
  rejectVideo = false;
  await page.locator('#add-selected').click();
  await expect(page.locator('#status')).toContainText('Successfully imported 1');
  expect(extension.backend.notebook(NB0).sources.filter(source => source.url === web)).toHaveLength(1);
  expect(extension.backend.notebook(NB0).sources.filter(source => source.url === video)).toHaveLength(1);
});
