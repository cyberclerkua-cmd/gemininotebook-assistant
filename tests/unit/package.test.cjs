const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { collect, archive, verifyArchive, validateRuntime, build, ROOT } = require('../../scripts/package.cjs');

test('Release archives include runtime dependencies and a complete clean source tree', () => {
  const { runtime, source, version } = collect();
  assert.equal(version, require('../../manifest.json').version);
  for (const name of ['manifest.json', 'background.js', 'lib/import-results.js', 'offscreen/offscreen.html', 'INSTALL.md', 'LICENSE']) {
    assert.ok(runtime[name], `Missing runtime file ${name}`);
  }
  assert.equal(runtime['package.json'], undefined);
  assert.ok(source['package-lock.json']);
  assert.ok(source['tests/unit/reliability.test.cjs']);
  assert.ok(source['RELEASE_NOTES.md']);
  assert.ok(source['.gitignore']);
  for (const name of Object.keys(source)) assert.ok(!/^(?:\.git|node_modules|dist|test-results|playwright-report)\//.test(name));
  verifyArchive(archive(runtime), runtime);
  verifyArchive(archive(source), source);
});

test('ZIP generation has stable timestamps and identical bytes for identical inputs', () => {
  const { runtime } = collect();
  const first = archive(runtime);
  const second = archive(runtime);
  assert.ok(first.equals(second));
  assert.equal(first.readUInt32LE(0), 0x04034b50);
  assert.equal(first.readUInt16LE(10), 0); // DOS time: midnight
  assert.equal(first.readUInt16LE(12), 33); // DOS date: 1980-01-01
});

test('Archive validation rejects missing assets and changed contents', () => {
  const { runtime } = collect();
  const missing = { ...runtime };
  delete missing['lib/import-results.js'];
  assert.throws(() => validateRuntime(missing), /Missing HTML dependency/);
  assert.throws(() => verifyArchive(archive(missing), runtime), /file list differs/);
  const changed = { ...runtime, 'background.js': Buffer.from('truncated') };
  assert.throws(() => verifyArchive(archive(changed), runtime), /changed file contents/);
});

test('Packaging writes ready-to-upload folders and correct SHA-256 checksums', () => {
  const temporary = path.join(os.tmpdir(), 'opencode');
  fs.mkdirSync(temporary, { recursive: true });
  const output = fs.mkdtempSync(path.join(temporary, 'gna-package-'));
  try {
    const info = build(ROOT, output);
    assert.equal(info.artifacts.length, 2);
    assert.ok(fs.existsSync(path.join(output, 'extension', 'manifest.json')));
    assert.ok(fs.existsSync(path.join(output, 'github-update', '.gitignore')));
    const sums = fs.readFileSync(path.join(output, 'SHA256SUMS.txt'), 'utf8');
    for (const artifact of info.artifacts) {
      const digest = createHash('sha256').update(fs.readFileSync(path.join(output, artifact.name))).digest('hex');
      assert.equal(digest, artifact.sha256);
      assert.ok(sums.includes(`${digest}  ${artifact.name}`));
    }
    assert.deepEqual(build(ROOT, output), info);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});
