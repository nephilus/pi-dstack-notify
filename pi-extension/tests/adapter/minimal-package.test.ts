import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../../../', import.meta.url);

test('Git-root package statically selects exactly minimal entry, no incidental root skills/prompts or acquisition scripts', () => {
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  assert.deepEqual(manifest.pi, { extensions: ['./pi-extension/minimal.ts'] });
  assert.equal(manifest.type, 'module'); assert.equal(manifest.private, true);
  assert.equal(manifest.engines.node, '>=24.0.0');
  assert.deepEqual(manifest.peerDependencies, { '@earendil-works/pi-coding-agent': '*', typebox: '*' });
  for (const field of ['scripts', 'dependencies', 'devDependencies', 'optionalDependencies', 'workspaces', 'main', 'exports'])
    assert.equal(Object.hasOwn(manifest, field), false, field);
  for (const entry of manifest.pi.extensions) assert.equal(existsSync(new URL(entry, root)), true);
  // The dormant shared factory is not an additional activation route.
  assert.equal(existsSync(new URL('pi-extension/package.json', root)), false);
});

test('minimal static relative-source closure exists with host-only externals and tracked Unicode runtime data; no build/bridge', () => {
  const visited = new Set<string>(), external = new Set<string>();
  function visit(url: URL) {
    const file = fileURLToPath(url); if (visited.has(file)) return; visited.add(file);
    assert.equal(existsSync(file), true, file);
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /child_process|notification-python|alert_binding|registerCommand|registerMcpServer|setActiveTools/);
    for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier.startsWith('.')) { assert.match(specifier, /\.ts$/); visit(new URL(specifier, url)); }
      else external.add(specifier);
    }
  }
  visit(new URL('pi-extension/minimal.ts', root));
  for (const specifier of external) assert.ok(specifier.startsWith('node:')
    || ['@earendil-works/pi-coding-agent', 'typebox'].includes(specifier), specifier);
  assert.ok(visited.has(fileURLToPath(new URL('pi-extension/core/casefold-data.ts', root))));
  const data = readFileSync(new URL('pi-extension/core/casefold-data.ts', root), 'utf8');
  assert.match(data, /15\.1/);
  assert.ok(visited.has(fileURLToPath(new URL('pi-extension/core/storage.ts', root))), 'native sqlite belongs to host Node, not acquired npm backend');
});
