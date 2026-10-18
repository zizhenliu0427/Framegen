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

function fakeNode(tag, [left, top, width, height], style = {}, parentElement = null) {
  const props = new Map();
  return {
    tag, parentElement, isConnected: true, computed: { position: 'static', transform: 'none',
      overflowX: 'visible', overflowY: 'visible', backdropFilter: 'none', ...style },
    rect: [left, top, width, height],
    getBoundingClientRect() {
      const [l, t, w, h] = this.rect;
      return { left: l, top: t, right: l + w, bottom: t + h, width: w, height: h };
    },
    style: {
      getPropertyValue: k => props.get(k)?.[0] ?? '',
      getPropertyPriority: k => props.get(k)?.[1] ?? '',
      setProperty: (k, v, p = '') => props.set(k, [v, p]),
      removeProperty: k => props.delete(k),
    },
    inline: k => props.get(k) ?? null,
  };
}

test('invisible overlay blockers are cleared while RTX Video is on, and handed back', () => {
  // yifan.tv at 2552x1308 CSS px: Chromium kept the video off the overlay path for
  // a 1x1 autoplay-unlock <video> and an episode drawer parked outside the player
  const html = fakeNode('html', [0, 0, 2552, 1308]);
  const body = fakeNode('body', [0, 0, 2537, 5089], { overflowX: 'auto', overflowY: 'auto' }, html);
  const player = fakeNode('div', [386.5, 64, 1223, 688],
    { position: 'relative', overflowX: 'hidden', overflowY: 'hidden' }, body);
  const video = fakeNode('video', [386.5, 64, 1223, 688], {}, player);
  const host = fakeNode('app-player-media-list', [1609.5, 64, 0, 688], {}, player);
  const drawer = fakeNode('div', [1609.5, 64, 420, 688],
    { position: 'absolute', backdropFilter: 'blur(16px)' }, host);
  const frostedBar = fakeNode('div', [386.5, 673, 1223, 80],
    { position: 'absolute', backdropFilter: 'blur(8px)' }, player);
  const sidebar = fakeNode('div', [1609.5, 64, 420, 688], { backdropFilter: 'blur(16px)' }, body);
  const unlock = fakeNode('video', [0, 1307, 1, 1], { position: 'absolute' }, body);
  const all = [body, player, video, host, drawer, frostedBar, sidebar, unlock];
  const context = {
    running: true, sys: { rtxOn: true }, videoEl: video, innerWidth: 2552, innerHeight: 1308, devicePixelRatio: 1.5,
    performance: { now: () => 10000 },
    document: { body, documentElement: html,
      getElementsByTagName: tag => all.filter(n => tag === '*' || n.tag === tag) },
    getComputedStyle: n => ({ ...n.computed, backdropFilter: n.style.getPropertyValue('backdrop-filter') || n.computed.backdropFilter }),
  };
  const state = content.match(/const hiddenStrayVideos = [^\n]*\n\s*let backdropCandidates = [^\n]*\n/);
  assert.ok(state, 'blocker state declarations');
  vm.runInNewContext(`${state[0]}${['saveInline', 'restoreInline', 'visibleBox', 'unseenOverPicture',
    'clearOverlayBlockers', 'restoreOverlayBlockers'].map(functionSource).join('\n')}
    this.clear = clearOverlayBlockers; this.restore = restoreOverlayBlockers;`, context);

  context.clear();
  assert.deepEqual(unlock.inline('visibility'), ['hidden', 'important']);
  assert.deepEqual(drawer.inline('backdrop-filter'), ['none', 'important'], 'clipped-away drawer drops its blur');
  assert.equal(frostedBar.inline('backdrop-filter'), null, 'a visible bar over the picture is the site\'s call');
  assert.equal(sidebar.inline('backdrop-filter'), null, 'a visible neighbour keeps its blur');
  assert.equal(video.inline('visibility'), null);

  drawer.rect = [1189.5, 64, 420, 688]; // the user opens the episode list
  context.clear();
  assert.equal(drawer.inline('backdrop-filter'), null, 'blur back the moment it shows');
  drawer.rect = [1609.5, 64, 420, 688];
  context.clear();
  assert.deepEqual(drawer.inline('backdrop-filter'), ['none', 'important'], 'and dropped again once it is parked');

  context.restore();
  assert.equal(drawer.inline('backdrop-filter'), null);
  assert.equal(unlock.inline('visibility'), null);
  assert.match(functionSource('stop'), /^function stop\(\) \{\s*veilSource\(false\);\s*restoreOverlayBlockers\(\);/);
  assert.match(functionSource('setRtxPresentation'), /if \(!on\) \{[^}]*restoreOverlayBlockers\(\);/);
});

function fakeVideo(opacity = '', priority = '') {
  const props = new Map(opacity ? [['opacity', [opacity, priority]]] : []);
  return {
    style: {
      getPropertyValue: k => props.get(k)?.[0] ?? '',
      getPropertyPriority: k => props.get(k)?.[1] ?? '',
      setProperty: (k, v, p = '') => props.set(k, [v, p]),
      removeProperty: k => props.delete(k),
    },
    inline: () => props.get('opacity') ?? null,
  };
}

test('the site video goes transparent under the RTX output and comes back intact', () => {
  const context = { sys: { rtxOn: true }, videoEl: fakeVideo('0.9', 'important'), sourceVeil: null };
  vm.runInNewContext(`${functionSource('veilSource')}\nthis.veil = veilSource;`, context);
  const first = context.videoEl;
  context.veil(true);
  assert.deepEqual(first.inline(), ['0', 'important']);
  context.veil(true); // every presented frame re-asserts it, no state churn
  context.videoEl = fakeVideo();
  context.veil(true); // a new source: the old one gets its own opacity back first
  assert.deepEqual(first.inline(), ['0.9', 'important']);
  assert.deepEqual(context.videoEl.inline(), ['0', 'important']);
  context.veil(false);
  assert.equal(context.videoEl.inline(), null, 'no inline opacity left behind');
  context.sys.rtxOn = false;
  context.veil(true);
  assert.equal(context.videoEl.inline(), null, 'canvas mode leaves the source alone');

  const present = functionSource('present');
  assert.match(present, /if \(sys\.rtxOn && rtxVideo\.readyState >= 2 && performance\.now\(\) - viewRevealedAt > 300\) veilSource\(true\);/);
  assert.match(functionSource('stop'), /^function stop\(\) \{\s*veilSource\(false\);/);
  for (const name of ['useNativePassthrough', 'onSrcChange', 'positionOverlay', 'handleDeviceLost', 'start']) {
    assert.match(functionSource(name), /veilSource\(false\)/, `${name} must hand the source back`);
  }
});

test('the output <video> is invisible to page scripts and to biggestVideo()', () => {
  assert.match(functionSource('ensureRtxView'), /attachShadow\(\{ mode: 'closed' \}\)\.appendChild\(rtxVideo\)/);
});
