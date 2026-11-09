const { test, expect, ARTICLE } = require('../helpers/browser.cjs');

const RSS = 'https://www.youtube.com/extension-test/rss.xml';
async function parsers(extension, sourceUrl = ARTICLE) {
  const source = await extension.context.newPage();
  await source.goto(sourceUrl);
  await extension.setActive(source);
  const page = await extension.popup();
  await page.locator('[data-tab="parsers"]').click();
  return page;
}
async function parse(page, url) {
  await page.locator('#rss-url').fill(url);
  await page.locator('#rss-parse').click();
}

test('RSS imports CDATA, Unicode and relative article URLs through the real offscreen DOM', async ({ extension }) => {
  extension.backend.feeds[RSS] = '<rss version="2.0"><channel><title>Фид</title><item><title><![CDATA[A <b> &amp; B]]></title><link>/post-a</link></item><item><title>Second</title><link>https://example.com/b</link></item></channel></rss>';
  const page = await parsers(extension);
  await parse(page, RSS);
  await expect(page.locator('.rss-cb')).toHaveCount(2);
  await page.locator('.rss-cb').nth(1).uncheck();
  await page.locator('#rss-add-selected').click();
  const queue = await extension.worker.evaluate(async () => (await chrome.storage.local.get('queue')).queue);
  expect(queue).toHaveLength(1);
  expect(queue[0].url).toBe('https://www.youtube.com/post-a');
  expect(queue[0].title).toBe('A <b> &amp; B');
  await expect(page.locator('#rss-results b')).toHaveCount(0);
});

test('Atom namespace, xml:base and alternate links are parsed correctly', async ({ extension }) => {
  const url = 'https://www.youtube.com/extension-test/atom.xml';
  extension.backend.feeds[url] = `<a:feed xmlns:a='http://www.w3.org/2005/Atom' xml:base='https://example.com/'><a:title>Atom</a:title><a:entry xml:base='posts/'><a:title>Entry</a:title><a:link rel='self' href='feed.xml'/><a:link rel='alternate' href='article?q=one&amp;two=2'/><a:updated>2026-11-08</a:updated></a:entry></a:feed>`;
  const page = await parsers(extension);
  await parse(page, url);
  await expect(page.locator('.rss-cb')).toHaveCount(1);
  expect(await page.locator('.rss-cb').getAttribute('data-url')).toBe('https://example.com/posts/article?q=one&two=2');
});

test('Sitemap URL sets deduplicate their URLs', async ({ extension }) => {
  const url = 'https://www.youtube.com/extension-test/sitemap.xml';
  extension.backend.feeds[url] = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url></urlset>';
  const page = await parsers(extension);
  await parse(page, url);
  await expect(page.locator('.rss-cb')).toHaveCount(2);
});

test('Sitemap indices follow child files and stop cyclic references', async ({ extension }) => {
  const base = 'https://www.youtube.com/extension-test/';
  extension.backend.feeds[base + 'index.xml'] = `<sitemapindex><sitemap><loc>${base}part.xml</loc></sitemap><sitemap><loc>${base}cycle.xml</loc></sitemap></sitemapindex>`;
  extension.backend.feeds[base + 'part.xml'] = '<urlset><url><loc>https://example.com/article</loc></url></urlset>';
  extension.backend.feeds[base + 'cycle.xml'] = `<sitemapindex><sitemap><loc>${base}index.xml</loc></sitemap></sitemapindex>`;
  const page = await parsers(extension);
  await parse(page, base + 'index.xml');
  await expect(page.locator('.rss-cb')).toHaveCount(1);
});

test('RSS autodetection parses a discovered feed before queueing its articles', async ({ extension }) => {
  extension.backend.feeds[RSS] = '<rss><channel><title>Feed</title><item><title>Article</title><link>https://example.com/article</link></item></channel></rss>';
  const page = await parsers(extension);
  await page.locator('#rss-detect').click();
  await expect(page.locator('.rss-load-feed')).toHaveCount(1);
  await page.locator('.rss-load-feed').click();
  await expect(page.locator('.rss-cb')).toHaveCount(1);
  await page.locator('#rss-add-selected').click();
  const queue = await extension.worker.evaluate(async () => (await chrome.storage.local.get('queue')).queue);
  expect(queue[0].url).toBe('https://example.com/article');
});

test('Invalid XML and denied permission produce errors instead of an empty success', async ({ extension }) => {
  extension.backend.feeds[RSS] = '<rss><channel><item></rss>';
  const page = await parsers(extension);
  await parse(page, RSS);
  await expect(page.locator('#rss-results')).toContainText('Invalid XML');
  await page.evaluate(() => { chrome.permissions.request = async () => false; });
  await parse(page, 'https://permission-denied.example/rss.xml');
  await expect(page.locator('#rss-results')).toContainText('Permission needed');
  await expect(page.locator('.rss-cb')).toHaveCount(0);
});

test('All page links remain selectable beyond the old 50-link cutoff', async ({ extension }) => {
  const page = await parsers(extension);
  await page.locator('#extract-links').click();
  await expect(page.locator('.link-cb')).toHaveCount(60);
  await page.locator('.link-cb').nth(59).check();
  await page.locator('#links-add-selected').click();
  const queue = await extension.worker.evaluate(async () => (await chrome.storage.local.get('queue')).queue);
  expect(queue[0].url).toBe('https://example.com/article-59');
});

test('YouTube links normalize watch, short, mobile, short URL and iframe formats', async ({ extension }) => {
  const page = await parsers(extension, ARTICLE + '?fixture=youtube-links');
  await page.locator('#yt-extract').click();
  await expect(page.locator('.yt-cb')).toHaveCount(3);
  await page.locator('#yt-add-selected').click();
  const queue = await extension.worker.evaluate(async () => (await chrome.storage.local.get('queue')).queue);
  expect(queue.map(item => item.url).sort()).toEqual([
    'https://www.youtube.com/watch?v=abcdefghijk', 'https://www.youtube.com/watch?v=12345678901',
    'https://www.youtube.com/watch?v=zyxwvutsrqp'
  ].sort());
});
