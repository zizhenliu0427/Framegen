import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const content = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');

function autoHelpers({ hostname = 'www.bilibili.com', innerWidth = 1512, pip = null,
  autoSmall = false, autoAds = false } = {}) {
  const start = content.indexOf('  function siteKey(');
  const end = content.indexOf('  setInterval(async () => {', start);
  assert.notEqual(start, -1, 'siteKey must exist');
  assert.notEqual(end, -1, 'auto-enable tick must follow the helpers');
  const context = { location: { hostname }, innerWidth, document: { pictureInPictureElement: pip },
    cfg: { autoSites: [], autoSmall, autoAds } };
  vm.runInNewContext(`${content.slice(start, end)}
    result = { siteKey, autoFits, autoEligible, autoSiteEnabled };`, context);
  return { ...context.result, cfg: context.cfg };
}

function fakeVideo({ width = 1280, height = 720, paused = false, ended = false, readyState = 4,
  currentTime = 5, connected = true, ad = false } = {}) {
  return {
    isConnected: connected, paused, ended, readyState, currentTime,
    getBoundingClientRect: () => ({ width, height }),
    closest: selector => selector === '.html5-video-player'
      ? { classList: { contains: name => ad && name === 'ad-showing' } } : null,
  };
}

test('site keys group subdomains under the registrable domain', () => {
  const { siteKey } = autoHelpers();
  assert.equal(siteKey('www.bilibili.com'), 'bilibili.com');
  assert.equal(siteKey('search.bilibili.com'), 'bilibili.com');
  assert.equal(siteKey('m.youtube.com'), 'youtube.com');
  assert.equal(siteKey('www.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(siteKey('localhost'), 'localhost');
});

test('allowlist membership follows the current site', () => {
  const helpers = autoHelpers({ hostname: 'search.bilibili.com' });
  assert.equal(helpers.autoSiteEnabled(), false);
  helpers.cfg.autoSites.push('bilibili.com');
  assert.equal(helpers.autoSiteEnabled(), true);
});

test('only a large, playing, non-ad, non-PiP video qualifies', () => {
  const { autoEligible, autoFits } = autoHelpers({ innerWidth: 1512 });
  assert.equal(autoEligible(fakeVideo()), true);
  // hover previews on search pages and floating mini players are too small
  assert.equal(autoEligible(fakeVideo({ width: 350, height: 197 })), false);
  assert.equal(autoEligible(fakeVideo({ width: 560, height: 315 })), false); // < 40% of 1512
  // not playing yet / just loaded / finished
  assert.equal(autoEligible(fakeVideo({ paused: true })), false);
  assert.equal(autoEligible(fakeVideo({ currentTime: 0.1 })), false);
  assert.equal(autoEligible(fakeVideo({ readyState: 2 })), false);
  assert.equal(autoEligible(fakeVideo({ ended: true })), false);
  // YouTube ad
  assert.equal(autoEligible(fakeVideo({ ad: true })), false);
  // pausing keeps an auto-started FG (fits), shrinking or an ad does not
  assert.equal(autoFits(fakeVideo({ paused: true })), true);
  assert.equal(autoFits(fakeVideo({ width: 350, height: 197 })), false);
  assert.equal(autoFits(fakeVideo({ ad: true })), false);
});

test('picture-in-picture video is never auto-enabled', () => {
  const video = fakeVideo();
  const { autoEligible } = autoHelpers({ pip: video });
  assert.equal(autoEligible(video), false);
});

test('manual off and HDR show-original suppress auto-enable for the page', () => {
  assert.match(content, /stop\(\);\s*autoStarted = false;\s*autoSuppressHref = location\.href;/);
  assert.match(content, /if \(mode === 'original'\) autoSuppressHref = location\.href;/);
  assert.match(content, /<input class="fc-sw" type="checkbox" id="fcAuto">/);
});

test('small players and ads can each be opted in; PiP never', () => {
  const small = autoHelpers({ autoSmall: true });
  assert.equal(small.autoEligible(fakeVideo({ width: 350, height: 197 })), true); // hover preview / mini window
  assert.equal(small.autoEligible(fakeVideo({ width: 120, height: 68 })), false); // thumbnails stay out
  assert.equal(small.autoEligible(fakeVideo({ ad: true })), false);
  const ads = autoHelpers({ autoAds: true });
  assert.equal(ads.autoEligible(fakeVideo({ ad: true })), true);
  assert.equal(ads.autoEligible(fakeVideo({ width: 350, height: 197 })), false);
  const video = fakeVideo();
  const everything = autoHelpers({ autoSmall: true, autoAds: true, pip: video });
  assert.equal(everything.autoEligible(video), false);
  assert.match(content, /id="fcAutoSmall"/);
  assert.match(content, /id="fcAutoAds"/);
});
