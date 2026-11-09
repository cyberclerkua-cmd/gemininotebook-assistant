const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground, authenticate } = require('../helpers/background.cjs');

test('The page shortcut queues the active tab and respects notification settings', async () => {
  const env = loadBackground({ sync: { enableNotifications: false } });
  await env.ready();
  await env.chrome.commands.onCommand.emit('add-current-page');
  assert.equal(env.stores.local.queue[0].url, 'https://example.com/article');
  assert.equal(env.stores.local.queue[0].title, 'Article');
  assert.equal(env.calls.notifications.length, 0);
});

test('The PDF shortcut uploads to the notebook belonging to the active account', async () => {
  const env = loadBackground({ sync: { activeAccount: 1 }, local: {
    lastNotebookByAccount: { 0: 'nb-0', 1: 'nb-1' }, lastNotebookId: 'nb-0', lastNotebookAuthuser: 0
  } });
  authenticate(env);
  let target;
  env.api.addPdfSource = async function(notebookId) { target = { notebookId, account: this.tokens.authuser }; };
  await env.ready();
  await env.chrome.commands.onCommand.emit('add-as-pdf');
  assert.deepEqual(target, { notebookId: 'nb-1', account: 1 });
});

test('A PDF shortcut without a target preserves the original tab for the popup', async () => {
  const env = loadBackground();
  await env.ready();
  await env.chrome.commands.onCommand.emit('add-as-pdf');
  assert.equal(env.stores.local.pendingPdf.tabId, 7);
  assert.equal(env.stores.local.pendingPdf.title, 'Article');
  assert.equal(env.calls.debugger.length, 0);
});

test('Context-menu link import uses the link URL instead of the page URL', async () => {
  const env = loadBackground();
  await env.ready();
  await env.chrome.contextMenus.onClicked.emit({ menuItemId: 'add-to-nlm',
    linkUrl: 'https://example.com/link', pageUrl: 'https://example.com/page' }, { title: 'Page' });
  assert.equal(env.stores.local.queue[0].url, 'https://example.com/link');
});

test('Context menus are removed before being re-created on installation or update', async () => {
  const env = loadBackground();
  const calls = [];
  env.chrome.contextMenus.removeAll = callback => { calls.push('remove'); callback(); };
  env.chrome.contextMenus.create = (settings, callback) => { calls.push(settings.id); callback(); };
  await env.chrome.runtime.onInstalled.emit();
  await env.chrome.runtime.onInstalled.emit();
  assert.deepEqual(calls, ['remove', 'add-to-nlm', 'add-as-pdf', 'remove', 'add-to-nlm', 'add-as-pdf']);
});

test('Unsupported browser-internal pages fail gracefully without entering the queue', async () => {
  const env = loadBackground({ tabs: [{ id: 7, url: 'chrome://extensions/', title: 'Extensions', active: true }] });
  await env.ready();
  await env.chrome.commands.onCommand.emit('add-current-page');
  assert.equal(env.stores.local.queue.length, 0);
  assert.equal(env.calls.notifications[0].id, 'cmd-error');
});
