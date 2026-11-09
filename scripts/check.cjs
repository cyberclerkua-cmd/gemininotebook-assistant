const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const ignored = new Set(['.git', 'node_modules', 'dist', 'test-results', 'playwright-report', '.test-profiles']);
let scripts = 0;
let jsonFiles = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(js|cjs)$/.test(file)) {
      new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
      scripts++;
    } else if (entry.name.endsWith('.json')) {
      JSON.parse(fs.readFileSync(file, 'utf8'));
      jsonFiles++;
    }
  }
}
walk(root);

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const locales = Object.fromEntries(['en', 'ru'].map(lang => [lang,
  JSON.parse(fs.readFileSync(path.join(root, '_locales', lang, 'messages.json'), 'utf8'))
]));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
  'manifest.json and package.json versions differ');
assert.deepEqual(Object.keys(locales.en).sort(), Object.keys(locales.ru).sort(), 'Locale keys differ');

const resources = [manifest.background.service_worker, manifest.action.default_popup,
  ...Object.values(manifest.icons),
  ...manifest.content_scripts.flatMap(script => [...script.js, ...(script.css || [])])];
for (const resource of resources) assert.ok(fs.existsSync(path.join(root, resource)), `Missing ${resource}`);

for (const [lang, messages] of Object.entries(locales)) {
  for (const [key, value] of Object.entries(messages)) {
    assert.equal(typeof value.message, 'string', `${lang}:${key} has no message`);
    const placeholders = [...value.message.matchAll(/\$([A-Z_]+)\$/g)].map(match => match[1]);
    for (const placeholder of placeholders) {
      assert.ok(value.placeholders?.[placeholder]?.content, `Undeclared Chrome placeholder ${lang}:${key}:${placeholder}`);
    }
    assert.deepEqual(placeholders.sort(), [...locales.en[key].message.matchAll(/\$([A-Z_]+)\$/g)]
      .map(match => match[1]).sort(), `Placeholder mismatch: ${lang}:${key}`);
  }
}

for (const file of ['popup/popup.js', 'app/app.js']) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  for (const match of source.matchAll(/\bt\(['"]([^'"]+)['"]/g)) {
    assert.ok(locales.en[match[1]], `Missing translation ${match[1]} used in ${file}`);
  }
}
console.log(`Checked ${scripts} JavaScript files, ${jsonFiles} JSON files, manifest resources and both locales.`);
