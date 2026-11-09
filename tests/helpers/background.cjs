const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const root = path.resolve(__dirname, '../..');
const clone = value => structuredClone(value);
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));

class Clock {
  constructor() { this.now = Date.parse('2026-11-08T12:00:00Z'); this.timers = new Map(); this.nextId = 1; }
  setTimeout(fn, ms = 0) {
    const id = this.nextId++;
    this.timers.set(id, { fn, at: this.now + ms });
    return id;
  }
  clearTimeout(id) { this.timers.delete(id); }
  async advance(ms) {
    const target = this.now + ms;
    for (let steps = 0; steps < 1000; steps++) {
      const next = [...this.timers].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].fn();
      await flush();
    }
    this.now = target;
    await flush();
  }
}

function event() {
  const listeners = [];
  return {
    listeners,
    addListener(fn) { listeners.push(fn); },
    removeListener(fn) { const idx = listeners.indexOf(fn); if (idx !== -1) listeners.splice(idx, 1); },
    async emit(...args) { await Promise.all(listeners.map(fn => fn(...args))); await flush(); }
  };
}

function loadBackground(options = {}) {
  const clock = new Clock();
  const stores = {
    sync: clone(options.sync || {}),
    local: clone(options.local || {}),
    session: clone(options.session || {})
  };
  const calls = { fetch: [], notifications: [], debugger: [], tabs: [], scripts: [] };
  const storageChanged = event();
  function area(name) {
    return {
      get(keys, callback) {
        const store = stores[name];
        const result = keys == null ? clone(store) : typeof keys === 'string'
          ? { [keys]: clone(store[keys]) }
          : Array.isArray(keys) ? Object.fromEntries(keys.map(key => [key, clone(store[key])]))
          : Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, clone(store[key] ?? fallback)]));
        if (callback) { queueMicrotask(() => callback(result)); return; }
        return Promise.resolve(result);
      },
      async set(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: clone(stores[name][key]), newValue: clone(value) };
          stores[name][key] = clone(value);
        }
        // Chrome resolves set() independently of storage.onChanged listeners.
        storageChanged.emit(changes, name).catch(() => {});
      },
      async remove(keys) {
        for (const key of [].concat(keys)) delete stores[name][key];
      }
    };
  }
  const alarms = new Map();
  const tabs = options.tabs || [{ id: 7, url: 'https://example.com/article', title: 'Article', active: true, windowId: 1 }];
  let offscreen = false;
  const chrome = {
    storage: { sync: area('sync'), local: area('local'), session: area('session'), onChanged: storageChanged },
    runtime: {
      id: 'test-extension',
      lastError: null,
      getManifest: () => JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')),
      getURL: resource => `chrome-extension://test-extension/${resource}`,
      getContexts: async () => offscreen ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : [],
      onInstalled: event(), onStartup: event(), onMessage: event(),
      sendMessage: async message => options.offscreenHandler ? options.offscreenHandler(message) : undefined
    },
    offscreen: { createDocument: async () => { offscreen = true; }, closeDocument: async () => { offscreen = false; } },
    i18n: { getMessage: key => key, getUILanguage: () => 'en' },
    permissions: { contains: async () => true, request: async () => true },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    alarms: {
      create: async (name, settings) => { alarms.set(name, clone(settings)); },
      get: async name => alarms.has(name) ? { name, ...alarms.get(name) } : undefined,
      getAll: async () => [...alarms].map(([name, settings]) => ({ name, ...settings })),
      clear: async name => alarms.delete(name),
      onAlarm: event()
    },
    notifications: {
      create: (id, settings, callback) => { calls.notifications.push({ id, ...settings }); callback?.(); }
    },
    contextMenus: {
      removeAll: callback => callback?.(), create: (_settings, callback) => callback?.(), onClicked: event()
    },
    commands: { onCommand: event() },
    tabs: {
      query: async filter => clone(tabs.filter(tab => !filter.active || tab.active)),
      get: async id => { const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error('No tab with id'); return clone(tab); },
      create: async options => { calls.tabs.push(options); return options; }
    },
    scripting: {
      executeScript: async options => {
        calls.scripts.push(options);
        if (options.scriptHandler) return options.scriptHandler(options);
        if (loadBackground.scriptHandler) return loadBackground.scriptHandler(options);
        return [{ result: { ok: true, data: {} } }];
      }
    },
    debugger: {
      attach: async target => { calls.debugger.push(['attach', target]); },
      detach: async target => { calls.debugger.push(['detach', target]); },
      sendCommand: async (target, method, params) => {
        calls.debugger.push([method, target, params]);
        return { data: Buffer.from('%PDF-1.4\nfixture').toString('base64') };
      }
    }
  };
  if (options.scriptHandler) chrome.scripting.executeScript = async request => {
    calls.scripts.push(request); return options.scriptHandler(request);
  };
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const context = vm.createContext({
    chrome, console: { log() {}, warn() {}, error() {}, debug() {} },
    URL, URLSearchParams, AbortController, Response, Request, Headers, Blob, TextEncoder, TextDecoder,
    Uint8Array, atob, btoa, crypto: webcrypto, Date: TestDate,
    setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock),
    fetch: async (url, settings) => {
      calls.fetch.push({ url: String(url), settings });
      if (options.fetch) return options.fetch(String(url), settings);
      throw new Error(`Unexpected network request: ${url}`);
    }
  });
  context.importScripts = (...files) => {
    for (const file of files) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  };
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  const api = vm.runInContext('NotebookLMAPI', context);
  return {
    context, api, chrome, stores, calls, clock, alarms,
    run: code => vm.runInContext(code, context),
    send: (cmd, params = {}, sender = {}) => vm.runInContext('handleMessage', context)({ cmd, params }, sender),
    ready: async () => { await flush(); await flush(); },
    settle: async promise => {
      let done = false;
      promise.finally(() => { done = true; }).catch(() => {});
      for (let step = 0; !done && step < 100; step++) { await flush(); await clock.advance(1000); }
      return promise;
    }
  };
}

function rpcResponse(rpcId, data, framed = true) {
  const payload = JSON.stringify([['wrb.fr', rpcId, JSON.stringify(data), null, null, null, 'generic']]);
  return framed ? `)]}'\n\n${Buffer.byteLength(payload)}\n${payload}\n` : `)]}'\n${payload}`;
}
function rpcError(rpcId, message = 'Source limit reached', code = 9) {
  const payload = JSON.stringify([['er', rpcId, null, null, code, [message]]]);
  return `)]}'\n\n${Buffer.byteLength(payload)}\n${payload}\n`;
}

function authenticate(env) {
  env.api.getTokens = async function(authuser = 0) {
    this.tokens = { cfb2h: `sid-${authuser}`, SNlM0e: `token-${authuser}`, authuser };
    this.tokensAuthuser = authuser;
    this.tokensFetchedAt = env.clock.now;
    return this.tokens;
  };
}

module.exports = { loadBackground, rpcResponse, rpcError, plain, flush, root, authenticate };
