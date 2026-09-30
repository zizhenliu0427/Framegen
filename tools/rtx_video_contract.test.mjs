import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const content = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');

function functionSource(name) {
  const start = content.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const signatureEnd = content.indexOf(') {', start);
  assert.notEqual(signatureEnd, -1, `missing function body ${name}`);
  const body = signatureEnd + 2;
  let depth = 0;
  for (let index = body; index < content.length; index++) {
    if (content[index] === '{') depth++;
    if (content[index] === '}' && --depth === 0) return content.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function needsCanvas(cfg, sys) {
  const context = { cfg: { fg: false, sr: false, hdr: false, sharpness: 0, compare: false, ...cfg }, sys, result: null };
  vm.runInNewContext(`${functionSource('needsCanvasPresentation')}\nresult = needsCanvasPresentation();`, context);
  return context.result;
}

function rtxEligible({ windows = true, generator = true, vendor = 'nvidia', architecture = 'lovelace', description = '' }) {
  const context = {
    sys: {},
    IS_WINDOWS: windows,
    syncConditionalRows: () => {},
    adapter: { features: new Set(['shader-f16']), info: { vendor, architecture, description } },
    result: null,
  };
  if (generator) context.MediaStreamTrackGenerator = function MediaStreamTrackGenerator() {};
  vm.runInNewContext(`${functionSource('classifyAdapter')}\nclassifyAdapter(adapter); result = sys.rtxOk;`, context);
  return context.result;
}

test('RTX Video is only offered on Windows with an NVIDIA RTX-class adapter', () => {
  assert.equal(rtxEligible({}), true);
  assert.equal(rtxEligible({ architecture: 'turing' }), true);
  assert.equal(rtxEligible({ architecture: 'blackwell' }), true);
  assert.equal(rtxEligible({ architecture: '' }), true, 'unknown NVIDIA architecture is a newer one');
  assert.equal(rtxEligible({ vendor: '', architecture: '', description: 'NVIDIA GeForce RTX 4060 Ti' }), true);
  assert.equal(rtxEligible({ architecture: 'pascal' }), false, 'GTX 10 series has no RTX Video');
  assert.equal(rtxEligible({ vendor: 'amd', architecture: 'rdna-3' }), false);
  assert.equal(rtxEligible({ vendor: 'intel', architecture: 'xe-lpg' }), false);
  assert.equal(rtxEligible({ vendor: 'apple', architecture: 'metal-3' }), false);
  assert.equal(rtxEligible({ windows: false }), false, 'no RTX Video outside Windows (macOS, Linux)');
  assert.equal(rtxEligible({ generator: false }), false, 'browsers without MediaStreamTrackGenerator');
});

test('RTX Video hands upscaling and SDR->HDR to the driver instead of the canvas', () => {
  const rtx = { f16: true, hdrOk: true, rtxOn: true };
  assert.equal(needsCanvas({ sr: true }, rtx), false, 'SR alone must leave the native video to VSR');
  assert.equal(needsCanvas({ hdr: true }, rtx), false, 'ITM alone must leave the native video to RTX HDR');
  assert.equal(needsCanvas({ fg: true }, rtx), true);
  assert.equal(needsCanvas({ sharpness: 1 }, rtx), true);
  assert.equal(needsCanvas({ sr: true }, { ...rtx, rtxOn: false }), true);
});

test('TinySR stays off and the pool keeps presentation size under RTX Video', () => {
  const context = {
    cfg: { sr: true, canvas4k: false },
    sys: { f16: true, rtxOn: true },
    overlay: { width: 1280, height: 720 },
    videoEl: { videoWidth: 640, videoHeight: 360 },
    texW: 640, texH: 360, srCostMs: 3,
    result: null,
  };
  vm.runInNewContext(`${functionSource('needsNeuralUpscale')}\n${functionSource('canvasCap')}\n`
    + `${functionSource('poolDims')}\n${functionSource('activeSrCostMs')}\n`
    + 'result = { pool: Array.from(poolDims()), sr: activeSrCostMs() };', context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.result)), { pool: [1280, 720], sr: 0 });
  assert.match(functionSource('present'), /if \(cfg\.sr && sys\.f16 && !sys\.rtxOn\)/);
});

test('present hands the finished canvas frame to the RTX stream after submit', () => {
  assert.match(functionSource('present'),
    /device\.queue\.submit\(\[enc\.finish\(\)\]\);\s*if \(sys\.rtxOn\) pushRtxFrame\(\);/);
});

test('RTX frames are dropped, not queued, when the sink backs up', async () => {
  const writes = [];
  const context = {
    rtxGen: {}, rtxInflight: 0,
    rtxWriter: { write: frame => new Promise(resolve => writes.push({ frame, resolve })) },
    rtxVideo: { paused: false },
    diag: { rtxWritten: 0, rtxSkipped: 0 },
    overlay: {},
    performance: { now: () => 1 },
    VideoFrame: class { constructor(source, init) { this.source = source; this.init = init; } },
    openRtxStream: () => { throw new Error('stream already open'); },
    log: () => {},
  };
  vm.runInNewContext(`${functionSource('pushRtxFrame')}\npushRtxFrame(); pushRtxFrame(); pushRtxFrame();`, context);
  assert.equal(writes.length, 2);
  assert.equal(context.diag.rtxSkipped, 1);
  assert.equal(writes[0].frame.source, context.overlay);
  writes.forEach(w => w.resolve());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.rtxInflight, 0);
  assert.equal(context.diag.rtxWritten, 2);
});

test('our ITM yields to RTX HDR, native HDR fix modes keep the fp16 canvas', () => {
  const configure = functionSource('configureOverlay');
  assert.match(configure, /const rtx = cfg\.rtxVideo === 'auto' && sys\.rtxOk && !nativeFix;/);
  assert.match(configure, /let hdr = !!\(sys\.hdrOk && \(\(cfg\.hdr && !rtx\) \|\| nativeFix\)\);/);
  assert.match(configure, /sys\.hdrOn = hdr;\s*setRtxPresentation\(rtx\);/);
});

test('RTX canvas never renders above source resolution', () => {
  const position = functionSource('positionOverlay');
  assert.match(position, /const sourceCap = sys\.rtxOn && sourceWidth && sourceHeight\s*\? Math\.min\(sourceWidth \/ bw, sourceHeight \/ bh\) : 1;/);
  assert.match(position, /const cap = Math\.min\(1, capW \/ bw, capH \/ bh, sourceCap\);/);
});

test('the output <video> is invisible to page scripts and to biggestVideo()', () => {
  assert.match(functionSource('ensureRtxView'), /attachShadow\(\{ mode: 'closed' \}\)\.appendChild\(rtxVideo\)/);
});
