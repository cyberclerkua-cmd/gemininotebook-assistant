const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { zipSync, unzipSync } = require('fflate');

const ROOT = path.resolve(__dirname, '..');
const NAME = 'gemininotebook-assistant';
const RUNTIME_DIRS = ['_locales', 'app', 'content', 'icons', 'lib', 'offscreen', 'popup'];
const SOURCE_FILES = [
  '.gitignore', 'README.md', 'LICENSE', 'manifest.json', 'background.js',
  'package.json', 'package-lock.json', 'playwright.config.cjs',
  'TESTING.md', 'TEST_REPORT.md', 'GITHUB_UPDATE.md', 'RELEASE_NOTES.md'
];
const EXCLUDED = new Set(['.git', 'node_modules', 'dist', 'test-results', 'playwright-report', '.test-profiles']);

function readFile(root, name) {
  const file = path.join(root, name);
  assert.ok(fs.lstatSync(file).isFile(), `Expected a regular file: ${name}`);
  return fs.readFileSync(file);
}

function collectTree(root, directory, files) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    if (EXCLUDED.has(entry.name) || entry.name.endsWith('.log')) continue;
    const name = path.posix.join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Package input must not be a symbolic link: ${name}`);
    if (entry.isDirectory()) collectTree(root, name, files);
    else if (entry.isFile()) files[name] = readFile(root, name);
  }
}

function validateRuntime(files) {
  const manifest = JSON.parse(files['manifest.json'].toString('utf8'));
  assert.equal(manifest.manifest_version, 3);
  const resources = [manifest.background.service_worker, manifest.action.default_popup,
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap(script => [...script.js, ...(script.css || [])]),
    `_locales/${manifest.default_locale}/messages.json`, 'offscreen/offscreen.html'];
  for (const resource of resources) assert.ok(files[resource], `Missing packaged resource: ${resource}`);
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.endsWith('.html')) continue;
    for (const match of bytes.toString('utf8').matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
      const reference = match[1];
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(reference)) continue;
      const resource = reference.startsWith('/') ? reference.slice(1)
        : path.posix.normalize(path.posix.join(path.posix.dirname(name), reference));
      assert.ok(files[resource.split(/[?#]/)[0]], `Missing HTML dependency ${reference} in ${name}`);
    }
  }
  return manifest;
}

function collect(root = ROOT) {
  const runtime = {};
  for (const name of ['manifest.json', 'background.js', 'LICENSE']) runtime[name] = readFile(root, name);
  for (const directory of RUNTIME_DIRS) collectTree(root, directory, runtime);
  runtime['INSTALL.md'] = readFile(root, 'release/INSTALL.md');
  const manifest = validateRuntime(runtime);
  const pkg = JSON.parse(readFile(root, 'package.json'));
  assert.equal(pkg.version, manifest.version, 'Package and extension versions must match');

  const source = {};
  for (const name of SOURCE_FILES) source[name] = readFile(root, name);
  for (const directory of [...RUNTIME_DIRS, 'scripts', 'tests', 'release']) collectTree(root, directory, source);
  return { version: manifest.version, runtime, source };
}

function archive(files) {
  // Stable order and DOS timestamps make identical inputs produce identical ZIPs.
  const entries = Object.fromEntries(Object.keys(files).sort().map(name => [name,
    [files[name], { level: 9, mtime: new Date(1980, 0, 1) }]
  ]));
  return Buffer.from(zipSync(entries));
}

function verifyArchive(bytes, expected) {
  const actual = unzipSync(bytes);
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), 'Archive file list differs from inputs');
  for (const name of Object.keys(expected)) {
    assert.ok(Buffer.from(actual[name]).equals(expected[name]), `Archive changed file contents: ${name}`);
  }
}

function writeTree(destination, files) {
  fs.mkdirSync(destination, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) {
    const file = path.join(destination, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
}

function build(root = ROOT, destination = path.join(root, 'dist')) {
  const inputs = collect(root);
  const marker = path.join(destination, 'package-info.json');
  const owned = fs.existsSync(marker) && JSON.parse(fs.readFileSync(marker, 'utf8')).tool === NAME;
  for (const directory of ['extension', 'github-update']) {
    const output = path.join(destination, directory);
    assert.ok(!fs.existsSync(output) || owned, `Output already exists and is not owned by the packager: ${output}`);
  }
  fs.mkdirSync(destination, { recursive: true });
  for (const directory of ['extension', 'github-update']) {
    fs.rmSync(path.join(destination, directory), { recursive: true, force: true });
  }
  writeTree(path.join(destination, 'extension'), inputs.runtime);
  writeTree(path.join(destination, 'github-update'), inputs.source);

  const artifacts = [];
  for (const [suffix, files] of [['', inputs.runtime], ['-source', inputs.source]]) {
    const name = `${NAME}-${inputs.version}${suffix}.zip`;
    const bytes = archive(files);
    verifyArchive(bytes, files);
    fs.writeFileSync(path.join(destination, name), bytes);
    artifacts.push({ name, bytes: bytes.length, files: Object.keys(files).length,
      sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  fs.writeFileSync(path.join(destination, 'SHA256SUMS.txt'),
    artifacts.map(artifact => `${artifact.sha256}  ${artifact.name}`).join('\n') + '\n');
  for (const name of ['RELEASE_NOTES.md', 'GITHUB_UPDATE.md']) {
    fs.writeFileSync(path.join(destination, name), inputs.source[name]);
  }
  const info = { tool: NAME, version: inputs.version, artifacts };
  fs.writeFileSync(marker, JSON.stringify(info, null, 2) + '\n');
  return info;
}

if (require.main === module) {
  const info = build();
  console.log(`Prepared version ${info.version} in dist/`);
  for (const artifact of info.artifacts) console.log(`${artifact.name}: ${artifact.files} files, ${artifact.bytes} bytes, SHA-256 ${artifact.sha256}`);
}

module.exports = { ROOT, collect, archive, verifyArchive, validateRuntime, build };
