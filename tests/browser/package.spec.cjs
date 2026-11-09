const path = require('node:path');
const { test, expect, NB0 } = require('../helpers/browser.cjs');
const { ROOT, build } = require('../../scripts/package.cjs');

test.use({ extensionPath: path.join(ROOT, 'dist', 'extension') });
test.beforeAll(() => { build(); });

test('The packaged runtime loads in Chrome and imports a source', async ({ extension }) => {
  const page = await extension.popup();
  await expect(page.locator('#notebook-select')).toHaveValue(NB0);
  await page.locator('#single-url').fill('https://example.com/packaged-release');
  await page.locator('#add-single-url').click();
  await expect(page.locator('#home-status')).toHaveClass(/success/);
  expect(extension.backend.notebook(NB0).sources.some(source => source.url === 'https://example.com/packaged-release')).toBe(true);
  expect(extension.errors).toEqual([]);
});
