const { test, expect, NB0, ARTICLE } = require('../helpers/browser.cjs');

test('Chrome debugger generates a real PDF and the full binary upload is preserved', async ({ extension }) => {
  const article = await extension.context.newPage();
  await article.goto(ARTICLE);
  await extension.setActive(article);
  await extension.worker.evaluate(() => {
    const original = chrome.debugger.sendCommand.bind(chrome.debugger);
    chrome.debugger.sendCommand = async (...args) => {
      const result = await original(...args);
      if (args[1] === 'Page.printToPDF') globalThis.__printedPdf = result.data;
      return result;
    };
  });
  const page = await extension.popup();
  await page.locator('#add-as-pdf').click();
  await expect(page.locator('#home-status')).toContainText('PDF saved');
  expect(extension.backend.uploads).toHaveLength(1);
  const uploaded = extension.backend.uploads[0];
  expect(uploaded.bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(uploaded.bytes.length).toBeGreaterThan(1000);
  const printed = await extension.worker.evaluate(() => globalThis.__printedPdf);
  expect(uploaded.bytes.equals(Buffer.from(printed, 'base64'))).toBe(true);
  expect(uploaded.headers['content-type']).toBe('application/pdf');
  expect(extension.backend.notebook(NB0).sources).toHaveLength(5);
});

test('A pending PDF targets its original tab even when another tab is active', async ({ extension }) => {
  const original = await extension.context.newPage();
  await original.goto(ARTICLE + '?original=true');
  const tabId = await extension.worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, original.url());
  await extension.worker.evaluate(tabId => chrome.storage.local.set({ pendingPdf: { tabId, title: 'Original page' } }), tabId);
  const other = await extension.context.newPage();
  await other.goto(ARTICLE + '?other=true');
  await extension.setActive(other);
  const page = await extension.popup();
  await expect(page.locator('#pending-pdf-title')).toContainText('Original page');
  await page.locator('#add-as-pdf').click();
  await expect(page.locator('#home-status')).toContainText('Original page');
  await expect(page.locator('#pending-pdf-info')).toBeHidden();
  const source = extension.backend.notebook(NB0).sources.at(-1);
  expect(source.title).toBe('Original page.pdf');
});

test('A closed pending PDF tab produces an error and can be cancelled', async ({ extension }) => {
  await extension.worker.evaluate(() => chrome.storage.local.set({ pendingPdf: { tabId: 9999999, title: 'Closed tab' } }));
  const page = await extension.popup();
  await page.locator('#add-as-pdf').click();
  await expect(page.locator('#home-status')).toHaveClass(/error/);
  expect(extension.backend.uploads).toHaveLength(0);
  await page.locator('#cancel-pending-pdf').click();
  await expect(page.locator('#pending-pdf-info')).toBeHidden();
});
