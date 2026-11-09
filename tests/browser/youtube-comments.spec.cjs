const { test, expect, NB0, VIDEO } = require('../helpers/browser.cjs');

async function videoParser(extension) {
  const video = await extension.context.newPage();
  await video.goto(`https://www.youtube.com/watch?v=${VIDEO}`);
  await extension.setActive(video);
  const page = await extension.popup();
  await page.locator('[data-tab="parsers"]').click();
  await expect(page.locator('#start-parse')).toBeEnabled();
  return page;
}

test('YouTube comments, replies and video metadata become a verified Markdown source', async ({ extension }) => {
  const page = await videoParser(extension);
  await page.locator('#start-parse').click();
  await expect(page.locator('#parse-text')).toContainText('Done!');
  const source = extension.backend.notebook(NB0).sources.find(source => source.type === 4);
  expect(source.title).toBe('Comments: Fixture video');
  expect(source.text).toContain('Top comment 1');
  expect(source.text).toContain('Top comment 2');
  expect(source.text).toContain('A reply');
  expect(source.text).not.toContain('Third comment');
  expect(source.text).toContain('01.07.2026');
  expect(extension.backend.ytRequests).toEqual(['yt-top', 'yt-replies']);
});

test('Newest sorting and the unlimited value survive popup settings and reach InnerTube', async ({ extension }) => {
  const page = await videoParser(extension);
  await page.locator('#comments-mode').selectOption('newest');
  await page.locator('#comments-limit').fill('0');
  await page.locator('#comments-replies').uncheck();
  await page.locator('#start-parse').click();
  await expect(page.locator('#parse-text')).toContainText('3 comments');
  const source = extension.backend.notebook(NB0).sources.find(source => source.type === 4);
  expect(source.text).toContain('Newest comment 1');
  expect(source.text).toContain('Third comment');
  expect(source.text).not.toContain('A reply');
  expect(extension.backend.ytRequests).toEqual(['yt-newest', 'yt-next']);
  await page.close();
  const reopened = await extension.popup();
  await reopened.locator('[data-tab="parsers"]').click();
  await expect(reopened.locator('#comments-mode')).toHaveValue('newest');
  await expect(reopened.locator('#comments-limit')).toHaveValue('0');
  await expect(reopened.locator('#comments-replies')).not.toBeChecked();
});

test('Transient InnerTube HTTP errors retry successfully', async ({ extension }) => {
  extension.backend.ytFailureCount = 1;
  const page = await videoParser(extension);
  await page.locator('#comments-replies').uncheck();
  await page.locator('#start-parse').click();
  await expect(page.locator('#parse-text')).toContainText('Done!');
  expect(extension.backend.ytRequests.slice(0, 2)).toEqual(['yt-top', 'yt-top']);
});

test('Cancelling an in-flight parse prevents any source from being added', async ({ extension }) => {
  let release;
  extension.backend.ytGate = new Promise(resolve => { release = resolve; });
  const page = await videoParser(extension);
  try {
    await page.locator('#start-parse').click();
    await expect.poll(() => extension.backend.ytRequests.length).toBe(1);
    await page.locator('#cancel-parse').click();
    await expect(page.locator('#cancel-parse')).toBeDisabled();
    release();
    await expect(page.locator('#parse-text')).toContainText('Cancelled');
    expect(extension.backend.notebook(NB0).sources).toHaveLength(4);
  } finally { release(); }
});

test('Closing and reopening the popup restores an active parsing job', async ({ extension }) => {
  let release;
  extension.backend.ytGate = new Promise(resolve => { release = resolve; });
  const page = await videoParser(extension);
  try {
    await page.locator('#start-parse').click();
    await expect.poll(() => extension.backend.ytRequests.length).toBe(1);
    await page.close();
    const reopened = await extension.popup();
    await reopened.locator('[data-tab="parsers"]').click();
    await expect(reopened.locator('#parse-progress')).toBeVisible();
    release();
    await expect(reopened.locator('#parse-text')).toContainText('Done!');
    expect(extension.backend.notebook(NB0).sources.filter(source => source.type === 4)).toHaveLength(1);
  } finally { release(); }
});

test('Disabled comments and text-source RPC errors cannot produce false success', async ({ extension }) => {
  extension.backend.youtubeResponse = () => ({ onResponseReceivedEndpoints: [] });
  const page = await videoParser(extension);
  await page.locator('#start-parse').click();
  await expect(page.locator('#parse-text')).toContainText('No comments');
  expect(extension.backend.notebook(NB0).sources).toHaveLength(4);
  const history = await extension.worker.evaluate(async () => (await chrome.storage.local.get('history')).history);
  expect(history[0].action).toBe('error');
});

test('A rejected text source is shown as an error and recorded in history', async ({ extension }) => {
  extension.backend.rpcErrors.izAoDd = 'Text import denied';
  const page = await videoParser(extension);
  await page.locator('#comments-replies').uncheck();
  await page.locator('#start-parse').click();
  await expect(page.locator('#parse-text')).toContainText('Text import denied');
  expect(extension.backend.notebook(NB0).sources).toHaveLength(4);
});
