const { test, expect, NB0, ARTICLE } = require('../helpers/browser.cjs');

test('Unpacked MV3 extension loads its real popup, worker, locales and RPC transport', async ({ extension }) => {
  const page = await extension.popup();
  await expect(page.locator('#notebook-select')).toHaveValue(NB0);
  await expect(page.locator('.tab')).toHaveCount(6);
  expect(extension.backend.rpcRequests.some(request => request.rpcId === 'wXbhsf')).toBe(true);
  expect(extension.errors).toEqual([]);
});

test('Add current page reaches the RPC endpoint through real extension messaging', async ({ extension }) => {
  const article = await extension.context.newPage();
  await article.goto(ARTICLE);
  await extension.setActive(article);
  const page = await extension.popup();
  await page.locator('#add-current-page').click();
  await expect(page.locator('#home-status')).toContainText('Added!');
  expect(extension.backend.notebook(NB0).sources.some(source => source.url === ARTICLE)).toBe(true);
  expect(extension.errors).toEqual([]);
});
