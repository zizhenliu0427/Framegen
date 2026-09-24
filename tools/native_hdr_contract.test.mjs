import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const content = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));

function signalToNits() {
  const start = content.indexOf('  const PQ_M1');
  const end = content.indexOf('  function sourceTransfer(');
  assert.notEqual(start, -1, 'PQ constants must exist');
  assert.notEqual(end, -1, 'sourceTransfer must follow the transfer helpers');
  const context = {};
  vm.runInNewContext(`${content.slice(start, end)}\nresult = HDR_SIGNAL_TO_NITS;`, context);
  return context.result;
}

test('PQ and HLG signal-to-nits helpers match BT.2100 / BT.2408 reference points', () => {
  const { pq, hlg } = signalToNits();
  assert.equal(pq(0), 0);
  assert.ok(Math.abs(pq(1) - 10000) < 1e-6);
  assert.ok(Math.abs(pq(0.5081) - 100) < 1, `PQ 0.5081 should be ~100 nits, got ${pq(0.5081)}`);
  assert.ok(Math.abs(pq(0.5806) - 203) < 2, `PQ 0.5806 should be ~203 nits, got ${pq(0.5806)}`);
  assert.equal(hlg(0), 0);
  assert.ok(Math.abs(hlg(0.75) - 203) < 1, `HLG 75% should be ~203 nits, got ${hlg(0.75)}`);
  assert.ok(Math.abs(hlg(1) - 1000) < 1, `HLG 100% should be ~1000 nits, got ${hlg(1)}`);
  for (const f of [pq, hlg]) {
    let previous = -1;
    for (let i = 0; i <= 100; i++) {
      const nits = f(i / 100);
      assert.ok(nits >= previous, 'signal-to-nits must be monotonic');
      previous = nits;
    }
  }
});

test('calibration ramps ship with the extension and are web accessible', async () => {
  for (const name of ['pq_ramp.mp4', 'hlg_ramp.mp4']) {
    const info = await stat(new URL(`../extension/assets/${name}`, import.meta.url));
    assert.ok(info.size > 0 && info.size < 64 * 1024, `${name} should be a small clip`);
    assert.match(content, new RegExp(`assets/${name.replace('.', '\\.')}`));
  }
  const exposed = manifest.web_accessible_resources.flatMap(entry => entry.resources);
  assert.ok(exposed.includes('assets/*'), 'ramps are fetched via chrome.runtime.getURL');
});

test('native HDR defaults to the original video and the experimental modes are labelled', () => {
  assert.match(content, /nativeHdr: 'original'/);
  assert.match(content, /<option value="fix">Gentle HDR \(experimental\)<\/option>/);
  assert.match(content, /<option value="real">Real HDR \(experimental\)<\/option>/);
  assert.match(content, /function syncHdrRows\(\)/);
});
