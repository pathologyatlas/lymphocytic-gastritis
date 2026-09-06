// Run: node openseadragon/osd-autonav.test.js
// Self-check: stub OSD, run the sweep with a fake clock, assert coverage,
// termination, start-from-current-position, jump-free motion, user pans
// being absorbed, and empty-glass boost.
const fs = require('fs'); const vm = require('vm');
const IMG = { x: 0, y: 0, width: 1, height: 0.53 };
const VIEW = { width: 0.12, height: 0.07 };
const SPEED = 4, FRAME = 16; // screen widths/s → 0.48 img/s → 0.00768 per frame
const ATT = 0.5;              // attention zone = central half of the view
const ZONE = { width: VIEW.width * ATT, height: VIEW.height * ATT };
function run(o) {
  const frames = []; let cb = null, t = 0, tickN = 0; let cur = { x: o.center[0], y: o.center[1] };
  const view = o.view || VIEW;
  const ctx = {
    OpenSeadragon: { Point: function (x, y) { this.x = x; this.y = y; } },
    requestAnimationFrame: f => { cb = f; return 1; },
    cancelAnimationFrame: () => { cb = null; },
    document: { addEventListener() {}, removeEventListener() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + '/osd-autonav.js', 'utf8').replace('var OSDAutoNav', 'OSDAutoNav'), ctx);
  const viewer = {
    world: { getItemAt: () => ({ getBounds: () => IMG, source: null }), getItemCount: () => 1 },
    viewport: {
      getBounds: () => ({ x: cur.x - view.width / 2, y: cur.y - view.height / 2, width: view.width, height: view.height }),
      getCenter: () => cur,
      panTo: (p, immediate) => { cur = { x: p.x, y: p.y }; frames.push({ x: p.x, y: p.y, transit: !immediate, n: tickN }); },
    },
    addHandler() {}, removeHandler() {},
  };
  const nav = ctx.OSDAutoNav(viewer, { direction: o.direction || 'rows', reverse: !!o.reverse, speed: SPEED, skipStrength: o.mask ? 3 : 0, attention: ATT, overlap: o.overlap == null ? 0.1 : o.overlap });
  ctx.performance = { now: () => t };
  if (o.setup) o.setup(nav);
  if (o.mask) nav.mask = o.mask;
  nav.start();
  let n = 0;
  while (cb && nav.running && n++ < 100000) {
    const f = cb; cb = null; t += FRAME; tickN = n;
    if (o.onFrame) o.onFrame(n, () => cur, p => { cur = p; }); // simulated user pan
    f(t);
  }
  if (nav.running) throw new Error('did not terminate');
  let miss = 0, total = 0;
  for (let cx = 0.005; cx < IMG.width; cx += 0.01) for (let cy = 0.005; cy < IMG.height; cy += 0.01) {
    total++;
    const zw = view.width * ATT / 2, zh = view.height * ATT / 2;
    if (!frames.some(f => Math.abs(f.x - cx) <= zw + 1e-9 && Math.abs(f.y - cy) <= zh + 1e-9)) miss++;
  }
  let maxStep = 0;
  for (let i = 1; i < frames.length; i++) maxStep = Math.max(maxStep, Math.hypot(frames[i].x - frames[i-1].x, frames[i].y - frames[i-1].y));
  return { frames: frames.length, miss, total, maxStep, first: frames[0], last: frames[frames.length - 1], all: frames };
}
const perFrame = SPEED * VIEW.width * FRAME / 1000 + 1e-9;
for (const d of ['rows', 'columns']) for (const r of [false, true]) {
  const res = run({ direction: d, reverse: r, center: r ? [1, 1] : [0, 0] });
  console.log(d, r ? 'reverse' : 'forward', { ...res, all: undefined });
  if (res.miss !== 0) throw new Error('coverage gap');
  if (res.maxStep > perFrame) throw new Error('jump detected: ' + res.maxStep);
}
const mid = run({ center: [0.5, 0.25] });
console.log('start-from-current', { ...mid, all: undefined });
if (Math.abs(mid.first.x - 0.5) > 1e-9 || Math.abs(mid.first.y - 0.25) > 1e-9) throw new Error('did not start at current centre');
// Ends on the last row; which side depends on row parity
if (![ZONE.width / 2, 1 - ZONE.width / 2].some(x => Math.abs(mid.last.x - x) < 1e-9) || Math.abs(mid.last.y - (0.53 - ZONE.height / 2)) > 1e-9) throw new Error('did not end on the last row: ' + JSON.stringify(mid.last));
// User pans down by 0.2 at frame 10 while sweeping: the sweep pauses for the
// grace period (400ms = 25 frames), then continues from the new position.
const panned = run({ center: [0.03, 0.0175], onFrame: (n, get, set) => { if (n === 10) { const c = get(); set({ x: c.x, y: c.y + 0.2 }); } } });
const afterPan = panned.all.find(f => f.n > 10);
console.log('user-pan: sweep resumed at frame ' + afterPan.n + ' y=' + afterPan.y.toFixed(4));
if (afterPan.n < 10 + 25) throw new Error('sweep did not pause for the user: resumed at frame ' + afterPan.n);
if (Math.abs(afterPan.y - 0.2175) > 1e-9) throw new Error('user pan was overridden: ' + afterPan.y);
// User pans onto glass with skip on: no transit while they hold it (frames 10..20), then the sweep skips as usual
const glassMask = { w: 100, h: 53, data: new Uint8Array(100 * 53) };
for (let y = 0; y < 53; y++) for (let x = 0; x < 30; x++) glassMask.data[y * 100 + x] = 1;
const onto = run({ center: [0.03, 0.0175], mask: glassMask, onFrame: (n, get, set) => { if (n >= 10 && n <= 20) { const c = get(); set({ x: (n === 10 ? 0.6 : c.x + 0.005), y: c.y }); } } }); // held key: keeps nudging
const duringHold = onto.all.filter(f => f.n >= 10 && f.n < 20 + 25); // grace = 400ms = 25 frames after the last nudge
console.log('user-onto-glass: module frames during hold+grace = ' + duringHold.length + ', total transits ' + onto.all.filter(f => f.transit).length);
if (duringHold.length) throw new Error('sweep fought the user while they held the view on glass');
// nextPass: from the first row, N glides to the second row and reverses direction
let navRef = null;
const np = run({ center: [0.03, 0.0175], setup: nv => { navRef = nv; }, onFrame: (n) => { if (n === 5) navRef.nextPass(); } });
const glide = np.all.find(f => f.transit);
console.log('nextPass: glide target y=' + (glide && glide.y.toFixed(4)) + ' expected ' + (0.0175 + ZONE.height * 0.9).toFixed(4));
if (!glide || Math.abs(glide.y - (0.0175 + ZONE.height * 0.9)) > 1e-9) throw new Error('nextPass did not glide to the next row');
const afterGlide = np.all.filter(f => !f.transit && f.n > glide.n).slice(0, 2);
if (!(afterGlide[1].x < afterGlide[0].x)) throw new Error('nextPass did not reverse direction');
// steer: 'down' from the middle steps one row down and reverses; then 'up' steps back up (sSign flips); 'left'/'right' set travel direction
const stv = run({ center: [0.5, 0.25], setup: nv => { navRef = nv; }, onFrame: (n) => { if (n === 5) navRef.steer('down'); if (n === 40) navRef.steer('up'); if (n === 80) navRef.steer('right'); if (n === 90) navRef.steer('left'); } });
const g1 = stv.all.find(f => f.transit); const g2 = stv.all.find(f => f.transit && f.n >= 40);
console.log('steer: down->y ' + g1.y.toFixed(4) + ' (expected ' + (0.25 + ZONE.height * 0.9).toFixed(4) + '), up->y ' + g2.y.toFixed(4) + ' (expected 0.2500)');
if (Math.abs(g1.y - (0.25 + ZONE.height * 0.9)) > 1e-9) throw new Error('steer down went wrong');
if (Math.abs(g2.y - 0.25) > 1e-9) throw new Error('steer up went wrong');
const dirAt = n => { const f = stv.all.filter(x => !x.transit && x.n > n).slice(0, 2); return Math.sign(f[1].x - f[0].x); };
if (dirAt(6) !== -1) throw new Error('down did not reverse to leftward');
if (dirAt(41) !== 1) throw new Error('up did not reverse to rightward');
if (dirAt(80) !== 1 || dirAt(90) !== -1) throw new Error('left/right did not set travel direction');
// Skip empty glass: tissue in the left 30% and right 20% only. Every
// non-transit frame must show tissue, all tissue cells must be covered, and
// the sweep must end at the last tissue rather than the slide corner.
const mask = { w: 100, h: 53, data: new Uint8Array(100 * 53) };
for (let y = 0; y < 53; y++) for (let x = 0; x < 100; x++) if (x < 30 || x >= 80) mask.data[y * 100 + x] = 1;
const tissueAt = (cx, cy) => mask.data[Math.min(52, Math.floor(cy / 0.53 * 53)) * 100 + Math.min(99, Math.floor(cx * 100))] === 1;
const skip = run({ center: [ZONE.width / 2, ZONE.height / 2], mask });
// A sweep frame is 'on glass' if no tissue lies within the view plus one mask cell (the module rounds outward by a cell)
const onGlass = skip.all.filter(f => !f.transit && [-(ZONE.width / 2 + 0.01), 0, ZONE.width / 2 + 0.01].every(dx => !tissueAt(Math.min(0.999, Math.max(0, f.x + dx)), f.y)));
const transits = skip.all.filter(f => f.transit).length;
let tissueMiss = 0;
for (let cx = 0.005; cx < 1; cx += 0.01) for (let cy = 0.005; cy < 0.53; cy += 0.01) {
  if (!tissueAt(cx, cy)) continue;
  if (!skip.all.some(f => Math.abs(f.x - cx) <= ZONE.width / 2 + 1e-9 && Math.abs(f.y - cy) <= ZONE.height / 2 + 1e-9)) tissueMiss++;
}
console.log('skip-empty frames=' + skip.frames + ' transits=' + transits + ' glassFrames=' + onGlass.length + ' tissueMiss=' + tissueMiss + ' last=', skip.last);
if (transits === 0) throw new Error('never transited over the gap');
if (onGlass.length) throw new Error('swept over glass: ' + JSON.stringify(onGlass[0]));
if (tissueMiss) throw new Error('tissue not covered');
const full = run({ center: [ZONE.width / 2, ZONE.height / 2] });
if (skip.frames > full.frames * 0.75) throw new Error('skipping saved too little time');
// Start on glass in the middle: first move is a transit to tissue
const fromGlass = run({ center: [0.5, 0.25], mask });
if (!fromGlass.all[0].transit) throw new Error('did not transit from a glass start');
// Tissue only in the top 20% rows: sweep must stop there, not continue to the bottom
const topMask = { w: 100, h: 53, data: new Uint8Array(100 * 53) };
for (let y = 0; y < 10; y++) for (let x = 0; x < 100; x++) topMask.data[y * 100 + x] = 1;
const top = run({ center: [ZONE.width / 2, ZONE.height / 2], mask: topMask });
console.log('stops-at-tissue-end last=', top.last, 'frames=' + top.frames);
if (top.last.y > 0.2) throw new Error('kept sweeping past the tissue');
// Overlap: distinct row centres must be spaced by zone.height * (1 - overlap)
for (const ov of [0, 0.1, 0.5]) {
  const r = run({ center: [0, 0], overlap: ov });
  // rows = y values held for many frames (the glide between rows touches each y once)
  const counts = {}; r.all.filter(f => !f.transit).forEach(f => { const k = f.y.toFixed(6); counts[k] = (counts[k] || 0) + 1; });
  const ys = Object.keys(counts).filter(k => counts[k] >= 10).map(Number).sort((a, b) => a - b);
  const gaps = ys.slice(1).map((y, i) => y - ys[i]).filter(gp => gp > 1e-6);
  const rowGap = Math.max(...gaps);
  console.log('overlap ' + ov + ': row gap ' + rowGap.toFixed(5) + ' expected ' + (ZONE.height * (1 - ov)).toFixed(5));
  if (Math.abs(rowGap - ZONE.height * (1 - ov)) > 1e-6) throw new Error('row spacing ignores overlap');
  if (r.miss !== 0) throw new Error('coverage gap at overlap ' + ov);
}
// Whole image fits in view: nothing to do
const big = run({ center: [0.5, 0.25], view: { width: 2, height: 1.2 } });
if (big.frames > 0) throw new Error('should not run');
console.log('ALL CHECKS PASSED');
