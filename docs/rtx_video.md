# RTX Video (VSR / RTX HDR) in the browser

Windows + NVIDIA RTX only. This note explains why NVIDIA RTX Video Super
Resolution (VSR) and RTX Video HDR often skip a browser video for no visible
reason, how to check it, and what Framegen does about it.

## Short version

- The driver only enhances a video that Chromium shows as a **DirectComposition
  overlay**. A video that Chromium composites itself gets neither VSR nor HDR.
- Chromium promotes **one video per frame**, and **never one with a
  backdrop-filter quad above it**. A page can break both rules with elements
  nobody can see: a 1x1 px helper `<video>`, or a blurred drawer clipped out of
  view next to the player.
- Framegen's RTX Video mode presents frame generation through its own `<video>`,
  and the **RTX Video page fix** (on by default) neutralises those invisible
  blockers while it runs.

## How RTX Video reaches a browser video

On Windows, Chromium can hand a `<video>` to the OS compositor as a
DirectComposition overlay: the frame goes through a D3D11 video processor
(`VideoProcessorBlt`), and Chromium turns on NVIDIA's stream extensions for VSR
and TrueHDR on it. Whether they then run is the driver's decision.

If Chromium decides against an overlay, the video is drawn by its own GPU
compositor like any other layer. No video processor is involved, so the driver
never sees it. The same holds for a `<canvas>`, which is why Framegen's RTX
Video mode pipes its output into a `<video>` (see below).

VSR and HDR ride the same path, so they always appear and disappear together.

Measured on an RTX 5090 (driver indicator on, 150% Windows scaling):

- Input size matters: 640x360 and 360x640 get VSR; 600x338, 560x316, 512x288,
  480x270, 640x272, 448x448, 360x360 and 320x180 do not.
- The upscale factor does not: every factor tried from 1.05x to 2.5x engaged,
  fractional picture sizes included.
- The driver's "RTX VSR" indicator is bright for a few seconds after VSR
  (re)starts, then fades to a faint watermark. Faint still means active.

## Checking it: `chrome://histograms`

While the video plays, open `chrome://histograms/#DirectComposition`
(`edge://histograms/#DirectComposition` in Edge) and find
`GPU.DirectComposition.DCLayerResult.Video.Clear`. Every presented frame adds
one sample per video candidate. Reload the histogram page to see new counts and
compare the difference.

| bucket | meaning (confirmed by removing the cause, see below) |
|---|---|
| 0 | promoted to an overlay - the driver can enhance it |
| 8 | more than one video in the frame - none of them is promoted |
| 11 | a quad with `backdrop-filter` sits above the video |

`GPU.DirectComposition.IsUnderlay` at 1 is normal: the video is promoted below
the page, which is what happens when player controls overlap it.

## Case study: yifan.tv

Symptoms on yifan.tv before the fix, with or without Framegen:

- *Thor 3* (`/play/mRqDPlA2zXH`, 800x450): no VSR, windowed or full screen.
- *Detective Conan* (4:3, 704x528): VSR.
- DevTools docked left or right gave Thor VSR; undocked or docked at the bottom
  did not. Browser zoom 110% or 125% sometimes helped, 100% did not.
- Results changed between visits with nothing else changed.

Two invisible elements were responsible.

**1. A 1x1 px autoplay-unlock video.** The app's root template contains

```html
<video src="./assets/javascript/empty2.mp4" autoplay muted playsinline
       style="width:1px;height:1px;position:absolute;bottom:0;left:0">
```

The site removes it 500 ms after the first in-site navigation. Open a player
page directly and it stays, paused but still holding a frame: a second video
quad in every frame, so every video on the page gets bucket 8 - Conan too, when
its page is opened directly. That is why results depended on how the page was
opened.

**2. A blurred episode drawer parked outside the player.** `.player-media-list`
has `backdrop-filter: blur(16px)` and `z-index: 5002`, and waits at
`left: 1223px` - just past the right edge of `vg-player`, whose
`overflow: hidden` clips it to nothing. It cannot be seen, yet at some window
widths Chromium still counts its quad as covering the edge of the picture
(rounding to device pixels, presumably), and the video gets bucket 11. A 4:3
picture is pillarboxed far from
that edge, so Conan was never affected. In the site's own full screen
`vg-player` becomes the full-screen element and takes the drawer with it.

Measured in a real Chromium window with the same 2552 CSS px inner width at
150%:

| page and step | DCLayerResult |
|---|---|
| Thor, as loaded | 8 and 11 |
| Thor, helper video removed | 11 |
| Thor, helper removed and drawer blur dropped | **0** (underlay) |
| Thor, blur restored | 11 |
| Conan, as loaded | 8 |
| Conan, helper video removed | **0** |
| Thor at 1846 px (DevTools docked), as loaded | 8 |
| Thor at 1846 px, helper video removed | **0** |

Ruled out on the way: codec and decoder (both H.264 High, D3D11 decode, NV12),
pixel aspect, letterbox bars, upscale factor, fractional and whole-pixel picture
sizes.

## What Framegen does

### RTX Video mode

With RTX Video support on and an eligible adapter, each presented frame leaves
the WebGPU canvas as a `VideoFrame` through a `MediaStreamTrackGenerator` into
Framegen's own `<video>` (in a closed shadow root). The canvas renders at source
resolution so VSR, not a canvas stretch, does the upscaling; Framegen's own
Upscale and SDR to HDR step aside.

Once that `<video>` shows frames, the site's video gets `opacity: 0`. It keeps
decoding and stays clickable, but is no longer drawn - otherwise there would be
two videos in the frame (bucket 8).

### RTX Video page fix

Panel switch *RTX Video page fix* (`rtxUnblock`, on by default). While
Framegen runs on the page with RTX Video mode active, every 250 ms:

1. **Tiny videos.** Any other `<video>` covering 16 CSS px² or less gets
   `visibility: hidden !important`. Visible videos are never touched.
2. **Invisible backdrop filters.** Elements with a computed `backdrop-filter`
   are collected every 2 s (1.4-4 ms on a 2300-element page). One is set to
   `backdrop-filter: none !important` only if its box comes within one device
   pixel of the video **and** what is left of it after the viewport and the
   overflow clips of its containing-block chain is under one device pixel wide
   or tall - that is, it cannot be seen. When it slides into view (the user
   opens the episode list) its blur comes back on the next tick; VSR pauses
   while it covers the picture.
3. **Hand-back.** Saved inline values are restored when Framegen stops, when
   RTX Video mode turns off, or when the switch is turned off.

Visible elements are left alone, including a frosted control bar over the
picture: that is the site's design, and VSR stays off while it shows.

On yifan.tv (Thor, 2552 px at 150%) every frame now gets bucket 0, with frame
generation on and in passthrough. With the switch off, buckets 8 and 11 return.

### Limits

- The page fix only acts while Framegen is running on the page.
- Strength stays in NVIDIA App → System → Video. The driver's registry values
  can be read, but writing them has no effect.
- VSR and HDR cannot be switched separately from a page. Turning *RTX Video
  support* off moves the output back to the canvas, which removes both.

## Reproducing the measurements

- Overlay buckets need a real, non-headless window: headless Chromium has no
  DirectComposition. A Playwright-launched Chromium placed off screen works:
  `--window-position=-30000,0 --disable-features=CalculateNativeWinOcclusion
  --disable-backgrounding-occluded-windows --mute-audio`, then read
  `chrome://histograms/#DirectComposition` from a second tab.
- `web/rtx_probe.html` compares presentation paths (modes A-G) and, in mode A,
  shows a clip at an exact device-pixel upscale factor (`?sweep=2.3`, arrow
  keys, or `window.sweepTo(f)` from a script).
- The driver's indicator shows up in desktop captures (Snipping Tool,
  `Graphics.CopyFromScreen`), not in page screenshots taken through DevTools.

## Related reports

- [NVIDIA forum](https://www.nvidia.com/en-us/geforce/forums/game-ready-driver/13/556461/super-resolution-and-hdr-rtx-video-enhancements-on/):
  a `backdrop-filter` element on YouTube stops VSR.
- [Vivaldi forum](https://forum.vivaldi.net/topic/92035/vsr-nvidia-rtx-superres-breaks-when-switching-tab-in-same-window-as-video?page=3):
  the browser theme's blur limits VSR to full screen.
- [brave/brave-browser#29946](https://github.com/brave/brave-browser/issues/29946):
  the reverse use - `backdrop-filter: blur(0px)` on a video to keep it off the
  overlay path.
- [JFRedist/vsr-fullscreen-helper](https://github.com/JFRedist/vsr-fullscreen-helper):
  full-screens the bare `<video>` so page elements stop interfering; full screen
  only.
