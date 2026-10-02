import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

createRequire(import.meta.url)('../extension/i18n.js');
const I18n = globalThis.FramegenI18n;

const read = file => readFile(new URL(`../extension/${file}`, import.meta.url), 'utf8');
const scripts = ['content.js', 'options.js', 'popup.js', 'cadence.js'];
const pages = ['options.html', 'popup.html'];

async function usedKeys() {
  const keys = new Map();
  const add = (key, file) => keys.set(key, [...(keys.get(key) || []), file]);
  for (const file of scripts) {
    const source = await read(file);
    for (const [, key] of source.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/g)) add(key, file);
    assert.doesNotMatch(source, /\bt\(\s*`/, `${file}: keep i18n keys literal so they can be checked`);
  }
  for (const file of pages) {
    const source = await read(file);
    for (const [, key] of source.matchAll(/data-i18n(?:-html|-aria|-title)?="([A-Za-z0-9_]+)"/g)) add(key, file);
  }
  return keys;
}

test('every i18n key the extension uses resolves in every language', async () => {
  const keys = await usedKeys();
  assert.ok(keys.size > 100, 'expected the UI to be localized');
  for (const lang of I18n.availableLangs()) {
    I18n.setLang(lang);
    const missing = [...keys].filter(([key]) => I18n.t(key) === key).map(([key, files]) => `${key} (${files})`);
    assert.deepEqual(missing, [], `${lang}: raw keys would be shown to users`);
  }
  I18n.setLang('en');
});

test('content scripts load i18n before anything that translates', async () => {
  const manifest = JSON.parse(await read('manifest.json'));
  assert.equal(manifest.content_scripts[0].js[0], 'i18n.js');
  for (const page of pages) {
    const source = await read(page);
    const i18n = source.indexOf('src="i18n.js"');
    assert.notEqual(i18n, -1, `${page} must load i18n.js`);
    for (const [, script] of source.matchAll(/src="([a-z-]+\.js)"/g)) {
      if (script !== 'i18n.js') assert.ok(source.indexOf(`src="${script}"`) > i18n, `${page}: ${script} before i18n.js`);
    }
  }
});
