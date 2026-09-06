/**
 * OSD Auto Navigation
 * Serpentine (boustrophedon) sweep across the whole image at the current zoom,
 * like a motorised microscope stage.
 *
 * Usage:
 *   var nav = OSDAutoNav(viewer)
 *   var nav = OSDAutoNav(viewer, { speed: 0.3, direction: 'columns', reverse: true })
 *   nav.start(); nav.stop(); nav.toggle();
 *
 * Writable properties (direction/reverse are read at start(); the rest live):
 *   speed      - Screen widths per second (default 0.3). Zoom-invariant: the
 *                visual pace is the same at 4x and 40x.
 *   attention  - Fraction of the screen (width and height, centred) that
 *                counts as actually looked at (default 0.5). All path maths
 *                uses this central zone: the sweep runs until the slide edge
 *                reaches it, passes are spaced by its height, and tissue is
 *                detected only inside it. 1 = the whole screen.
 *   overlap    - Fraction of the attention zone that consecutive passes share
 *                (default 0.1). Read live at each pass change.
 *   direction  - 'rows' (sweep left/right, step down) or 'columns' (default 'rows')
 *   reverse    - false: sweep right/down from the current position toward the
 *                bottom-right; true: sweep left/up toward the top-left (default false)
 *   skipStrength - 0..10, how aggressively empty glass is skipped (default 3).
 *                0 = off (sweep the whole slide). Higher = tissue must be
 *                darker/more coloured than glass to count, and a smaller
 *                safety margin is kept around it. Set via setSkipStrength(v),
 *                which rebuilds the mask and flashes it on the navigator.
 *                When the view runs out of tissue the sweep looks ahead along
 *                its path for the next tissue, glides there in one smooth
 *                transit, and carries on; it stops when no tissue is left.
 *                Needs the tissue mask (built from the smallest DeepZoom tile
 *                on 'open'; same-origin tiles only).
 *   onStop     - Callback fired whenever the sweep stops (finished or Escape)
 *
 * The sweep starts from wherever the viewport is when start() is called and
 * moves continuously, including the step between passes. Everything is
 * planned for the attention zone, not the whole screen, so the middle of the
 * screen passes over every bit of tissue.
 *
 * Keyboard while running (WASD and arrow keys are captured; they steer the
 * sweep instead of panning):
 *   rows mode:    S/Down = glide to the next row below and reverse,
 *                 W/Up = row above and reverse, A/Left and D/Right = set the
 *                 travel direction.
 *   columns mode: D/Right = next column, A/Left = previous column,
 *                 W/Up and S/Down = set the travel direction.
 *   N = next pass in the current stepping direction; Escape = stop.
 * Any other pan the module did not make itself (drag, middle-click stage
 * drive, wheel-zoom about the cursor) pauses the sweep for a short grace
 * period and cancels any glide in progress; nothing is skipped while the
 * user holds the controls. The user can
 * pan/zoom freely while it runs: each frame continues from the viewport's
 * current target, so manual moves just shift where the sweep goes on from.
 * Only stop() (the Stop button) or the Escape key ends it.
 *
 * Readable state: running, transiting (gliding over glass to the next tissue).
 */
var OSDAutoNav = (function () {
  function init(viewer, opts) {
    opts = opts || {};

    var nav = {
      speed: opts.speed || 0.3,
      attention: opts.attention || 0.5,
      overlap: opts.overlap == null ? 0.1 : opts.overlap,
      direction: opts.direction || 'rows',
      reverse: !!opts.reverse,
      skipStrength: opts.skipStrength == null ? 3 : opts.skipStrength,
      onStop: opts.onStop || null,
      running: false,
      transiting: false,
      mask: null, // { w, h, data: Uint8Array } 1 = tissue, in image-normalised coords
      start: null, stop: null, toggle: null, nextPass: null, steer: null, destroy: null, setSkipStrength: null, showMask: null
    };

    var animId = null;
    var lastT = 0;
    // Only the sweep's *phase* is state; position is re-read from the viewport
    // every frame so user pans/zooms are absorbed instead of fought.
    var st = null;
    var rows = true; // travel axis for this run: true = x (rows), false = y (columns)
    // While gliding over glass: { x, y, ph, t0 } target + phase to adopt on arrival.
    var transit = null;
    var TRANSIT_TIMEOUT = 2500; // ms; give up waiting for the spring
    // Where we last put the viewport target; any difference next frame means
    // the user moved it. userUntil = timestamp until which the sweep pauses.
    var lastSet = null;
    var userUntil = 0;
    var USER_GRACE = 400; // ms after the last user move before the sweep resumes

    function axisRange(imgMin, imgSize, viewSize) {
      // Centre can travel from imgMin+view/2 to imgMax-view/2; if the image
      // is smaller than the view on this axis, pin the centre to the middle.
      if (imgSize <= viewSize) {
        var mid = imgMin + imgSize / 2;
        return { min: mid, max: mid };
      }
      return { min: imgMin + viewSize / 2, max: imgMin + imgSize - viewSize / 2 };
    }

    function clamp(v, r) { return Math.min(r.max, Math.max(r.min, v)); }

    // Geometry for this frame: the attention zone (central part of the view)
    // and the travel ranges it implies for both axes at the current zoom.
    function geometry() {
      var item = viewer.world.getItemAt(0);
      if (!item) return null;
      var view = viewer.viewport.getBounds();
      var img = item.getBounds();
      var att = Math.max(0.1, Math.min(1, nav.attention));
      var zone = { width: view.width * att, height: view.height * att };
      return {
        view: view,
        zone: zone,
        img: img,
        xr: axisRange(img.x, img.width, zone.width),
        yr: axisRange(img.y, img.height, zone.height)
      };
    }

    function start() {
      // ponytail: single-item world assumed; rotation ignored (sweep is in image space).
      var g = geometry();
      if (!g) return;
      // Nothing to sweep if the whole image already fits the view.
      if (g.xr.min === g.xr.max && g.yr.min === g.yr.max) return;
      rows = nav.direction !== 'columns';
      // If the chosen travel axis has no room, sweep along the other one
      // instead of hopping a pass every frame.
      if ((rows ? g.xr : g.yr).min === (rows ? g.xr : g.yr).max) rows = !rows;
      var sign = nav.reverse ? -1 : 1;
      st = { pSign: sign, sSign: sign, turn: false, sTarget: 0, lastPass: false, done: false };
      transit = null;
      lastSet = null;
      userUntil = 0;
      nav.running = true;
      lastT = 0;
      if (!animId) animId = requestAnimationFrame(tick);
    }

    // Move one position along the serpentine path by `dist` (viewport units),
    // mutating pos {p, s} and phase ph. Pure w.r.t. the viewer, so it serves
    // both the live step and the look-ahead over glass.
    function advance(pos, ph, dist, g) {
      var pr = rows ? g.xr : g.yr;
      var sr = rows ? g.yr : g.xr;
      if (ph.turn) {
        // Turning: glide along the secondary axis to the next pass. Re-clamp
        // the target in case the user zoomed.
        var target = clamp(ph.sTarget, sr);
        pos.s += ph.sSign * dist;
        if (ph.sSign > 0 ? pos.s >= target : pos.s <= target) {
          pos.s = target;
          ph.turn = false;
          ph.pSign = -ph.pSign;
        }
      } else {
        pos.p += ph.pSign * dist;
        var hitEnd = ph.pSign > 0 ? pos.p >= pr.max : pos.p <= pr.min;
        if (hitEnd) {
          pos.p = ph.pSign > 0 ? pr.max : pr.min;
          var sEnd = ph.sSign > 0 ? sr.max : sr.min;
          if (ph.lastPass || pos.s === sEnd) { ph.done = true; return; }
          ph.turn = true;
          var ov = Math.max(0, Math.min(0.9, nav.overlap));
          ph.sTarget = pos.s + ph.sSign * (rows ? g.zone.height : g.zone.width) * (1 - ov);
          if (ph.sSign > 0 ? ph.sTarget >= sEnd : ph.sTarget <= sEnd) {
            ph.sTarget = sEnd;
            ph.lastPass = true;
          }
        }
      }
    }

    // The attention zone centred at a path position (what is "seen" there).
    function viewAt(pos, g) {
      var x = rows ? pos.p : pos.s;
      var y = rows ? pos.s : pos.p;
      return { x: x - g.zone.width / 2, y: y - g.zone.height / 2, width: g.zone.width, height: g.zone.height };
    }

    // Walk the path ahead of pos in small chunks until the view contains
    // tissue again. Returns { pos, ph } or null if the path ends on glass.
    function nextTissue(pos, ph, g) {
      var chunk = Math.min(g.zone.width, g.zone.height) * 0.25;
      var q = { p: pos.p, s: pos.s };
      var h = { pSign: ph.pSign, sSign: ph.sSign, turn: ph.turn, sTarget: ph.sTarget, lastPass: ph.lastPass, done: false };
      for (var i = 0; i < 20000; i++) {
        advance(q, h, chunk, g);
        if (h.done) return null;
        if (!isEmpty(viewAt(q, g), g.img)) return { pos: q, ph: h };
      }
      return null;
    }

    function tick(t) {
      animId = null;
      if (!nav.running) return;
      var dt = lastT ? Math.min((t - lastT) / 1000, 0.1) : 0;
      lastT = t;

      var g = geometry();
      if (!g) { stop(); return; }
      var pr = rows ? g.xr : g.yr;
      var sr = rows ? g.yr : g.xr;

      // Did someone else move the viewport target since our last frame?
      var c = viewer.viewport.getCenter();
      var expected = transit ? transit : lastSet;
      if (expected && Math.hypot(c.x - expected.x, c.y - expected.y) > g.view.width * 1e-4) {
        userUntil = t + USER_GRACE;
        if (transit) { st = transit.ph; transit = null; nav.transiting = false; }
      }
      if (t < userUntil) {
        // User is driving: hold the sweep, leave the springs alone, resume later
        // from wherever they put it.
        lastSet = { x: c.x, y: c.y };
        animId = requestAnimationFrame(tick);
        return;
      }

      if (transit) {
        // Wait for the spring to arrive.
        var cur = viewer.viewport.getCenter(true);
        var arrived = Math.hypot(cur.x - transit.x, cur.y - transit.y) < g.view.width * 0.01;
        if (arrived || t - transit.t0 > TRANSIT_TIMEOUT) {
          st = transit.ph;
          transit = null;
          nav.transiting = false;
          lastSet = { x: c.x, y: c.y };
        }
        animId = requestAnimationFrame(tick);
        return;
      }

      // Use the spring TARGET (not current) so a pan that landed this frame is
      // included rather than overwritten.
      var pos = { p: clamp(rows ? c.x : c.y, pr), s: clamp(rows ? c.y : c.x, sr) };

      advance(pos, st, nav.speed * g.view.width * dt, g);
      if (st.done) { pan(pos.p, pos.s); stop(); return; }

      if (nav.skipStrength > 0 && nav.mask && isEmpty(viewAt(pos, g), g.img)) {
        var nt = nextTissue(pos, st, g);
        if (!nt) { pan(pos.p, pos.s); stop(); return; } // no tissue left on the path
        glideTo(nt.pos, nt.ph, g, t);
        animId = requestAnimationFrame(tick);
        return;
      }

      pan(pos.p, pos.s);
      animId = requestAnimationFrame(tick);
    }

    function pan(p, s) {
      var x = rows ? p : s;
      var y = rows ? s : p;
      lastSet = { x: x, y: y };
      viewer.viewport.panTo(new OpenSeadragon.Point(x, y), true);
    }

    // Smooth spring glide to a path position; adopt phase `ph` on arrival.
    function glideTo(pos, ph, g, t) {
      var v = viewAt(pos, g);
      transit = { x: v.x + v.width / 2, y: v.y + v.height / 2, ph: ph, t0: t };
      nav.transiting = true;
      viewer.viewport.panTo(new OpenSeadragon.Point(transit.x, transit.y), false);
    }

    // Skip the rest of the current pass: glide straight to the next
    // row/column from here and continue in the opposite direction.
    function nextPass() {
      if (!nav.running) return;
      var g = geometry();
      if (!g) return;
      if (transit) { st = transit.ph; transit = null; nav.transiting = false; }
      var pr = rows ? g.xr : g.yr;
      var sr = rows ? g.yr : g.xr;
      var c = viewer.viewport.getCenter();
      var pos = { p: clamp(rows ? c.x : c.y, pr), s: clamp(rows ? c.y : c.x, sr) };
      var sEnd = st.sSign > 0 ? sr.max : sr.min;
      if (st.turn) { pos.s = clamp(st.sTarget, sr); }
      else {
        if (pos.s === sEnd) return; // already on the last pass
        var ov = Math.max(0, Math.min(0.9, nav.overlap));
        pos.s += st.sSign * (rows ? g.zone.height : g.zone.width) * (1 - ov);
        if (st.sSign > 0 ? pos.s >= sEnd : pos.s <= sEnd) pos.s = sEnd;
      }
      var ph = { pSign: st.turn ? st.pSign : -st.pSign, sSign: st.sSign, turn: false, sTarget: 0,
                 lastPass: pos.s === sEnd, done: false };
      glideTo(pos, ph, g, performance.now());
      userUntil = 0;
    }

    // Steer with a direction: along the travel axis it sets the direction;
    // across it, it steps to the neighbouring pass that way (and reverses).
    function steer(dir) {
      if (!nav.running) return;
      var sign = (dir === 'right' || dir === 'down') ? 1 : -1;
      var alongTravel = rows ? (dir === 'left' || dir === 'right') : (dir === 'up' || dir === 'down');
      if (alongTravel) {
        if (transit) transit.ph.pSign = sign;
        else st.pSign = st.turn ? -sign : sign; // a turn flips pSign when it ends
        userUntil = 0;
        return;
      }
      if (transit) { st = transit.ph; transit = null; nav.transiting = false; }
      st.sSign = sign;
      if (st.turn) { st.turn = false; st.pSign = -st.pSign; } // abandon the pending turn
      st.lastPass = false;
      nextPass();
    }

    function stop() {
      if (!nav.running) return;
      nav.running = false;
      nav.transiting = false;
      transit = null;
      if (animId) { cancelAnimationFrame(animId); animId = null; }
      if (nav.onStop) nav.onStop();
    }

    // ---- Tissue mask: is the given viewport rect (normalised coords) blank? ----
    function isEmpty(rect, img) {
      var m = nav.mask;
      if (!m) return false;
      var x0 = Math.max(0, Math.floor((rect.x - img.x) / img.width * m.w));
      var x1 = Math.min(m.w - 1, Math.ceil((rect.x + rect.width - img.x) / img.width * m.w));
      var y0 = Math.max(0, Math.floor((rect.y - img.y) / img.height * m.h));
      var y1 = Math.min(m.h - 1, Math.ceil((rect.y + rect.height - img.y) / img.height * m.h));
      for (var y = y0; y <= y1; y++)
        for (var x = x0; x <= x1; x++)
          if (m.data[y * m.w + x]) return false;
      return true;
    }

    // Build the mask from the largest DeepZoom level that still fits in a
    // single tile (~150-250px across). Glass level = median luminance of the
    // tile; tissue = anything darker than glass by `offset` or with chroma
    // above `chromaMin`, then dilated by `margin` px (1px ~ 500 image px) so
    // a pass never ends right at a tissue edge. skipStrength scales all
    // three. ponytail: one tile; use a finer level if very pale tissue still
    // gets skipped at low strengths.
    var raw = null; // { w, h, lum: Float32Array, chroma: Uint8Array, glass }

    function strengthParams(k) {
      return {
        offset: 2 + 1.6 * k,                    // 3.6 .. 18 luminance levels below glass
        chromaMin: 3 + k,                       // 4 .. 13
        margin: Math.max(0, Math.round(3 - k / 3)) // 3,3,2,2,2,1,1,1,0,0
      };
    }

    function rebuildMask() {
      if (!raw) return;
      var k = nav.skipStrength;
      if (!(k > 0)) { nav.mask = null; return; }
      var prm = strengthParams(k);
      var w = raw.w, h = raw.h, n = w * h, i;
      var tissue = new Uint8Array(n);
      for (i = 0; i < n; i++)
        tissue[i] = (raw.chroma[i] > prm.chromaMin || raw.lum[i] < raw.glass - prm.offset) ? 1 : 0;
      var data = new Uint8Array(n);
      var m = prm.margin;
      for (var y = 0; y < h; y++)
        for (var x = 0; x < w; x++) {
          var hit = 0;
          for (var dy = -m; dy <= m && !hit; dy++)
            for (var dx = -m; dx <= m && !hit; dx++) {
              var yy = y + dy, xx = x + dx;
              if (yy >= 0 && yy < h && xx >= 0 && xx < w && tissue[yy * w + xx]) hit = 1;
            }
          data[y * w + x] = hit;
        }
      nav.mask = { w: w, h: h, data: data };
    }

    function buildMask() {
      var item = viewer.world.getItemAt(0);
      if (!item || !item.source || !item.source.getTileUrl) return;
      var src = item.source;
      var level = src.maxLevel;
      while (level > src.minLevel) {
        var n = src.getNumTiles(level);
        if (n.x === 1 && n.y === 1) break;
        level--;
      }
      var im = new Image();
      im.onload = function () {
        var cv = document.createElement('canvas');
        cv.width = im.width; cv.height = im.height;
        var ctx = cv.getContext('2d');
        ctx.drawImage(im, 0, 0);
        var px;
        try { px = ctx.getImageData(0, 0, cv.width, cv.height).data; }
        catch (e) { return; } // cross-origin tile: no mask, sweep everything
        var w = cv.width, h = cv.height, n = w * h;
        var lum = new Float32Array(n), chroma = new Uint8Array(n);
        var hist = new Uint32Array(256);
        for (var i = 0; i < n; i++) {
          var r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
          lum[i] = (r + g + b) / 3;
          chroma[i] = Math.max(r, g, b) - Math.min(r, g, b);
          hist[Math.round(lum[i])]++;
        }
        var acc = 0, glass = 255;
        for (var v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n / 2) { glass = v; break; } }
        raw = { w: w, h: h, lum: lum, chroma: chroma, glass: glass };
        rebuildMask();
      };
      im.src = src.getTileUrl(level, 0, 0);
    }

    // Flash the skipped (glass) areas on the navigator thumbnail for `ms`.
    var maskCanvas = null, maskTimer = null;
    function showMask(ms) {
      if (!viewer.navigator || !viewer.navigator.element) return;
      if (!maskCanvas) {
        maskCanvas = document.createElement('canvas');
        var cs = maskCanvas.style;
        cs.position = 'absolute'; cs.left = '0'; cs.top = '0';
        cs.width = '100%'; cs.height = '100%';
        cs.pointerEvents = 'none'; cs.zIndex = '2';
        viewer.navigator.element.appendChild(maskCanvas);
      }
      var ctx = maskCanvas.getContext('2d');
      if (nav.mask) {
        var m = nav.mask;
        maskCanvas.width = m.w; maskCanvas.height = m.h;
        var img = ctx.createImageData(m.w, m.h);
        for (var i = 0; i < m.data.length; i++) {
          if (m.data[i]) continue; // tissue stays clear; glass gets tinted
          img.data[i * 4] = 40; img.data[i * 4 + 1] = 90; img.data[i * 4 + 2] = 200; img.data[i * 4 + 3] = 120;
        }
        ctx.putImageData(img, 0, 0);
      } else {
        ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
      }
      maskCanvas.style.display = 'block';
      if (maskTimer) clearTimeout(maskTimer);
      maskTimer = setTimeout(function () { maskCanvas.style.display = 'none'; }, ms || 1500);
    }

    function setSkipStrength(k) {
      nav.skipStrength = Math.max(0, Math.min(10, +k || 0));
      rebuildMask();
      showMask(1500);
    }

    var STEER_KEYS = { w: 'up', arrowup: 'up', s: 'down', arrowdown: 'down',
                       a: 'left', arrowleft: 'left', d: 'right', arrowright: 'right' };

    // Capture-phase listener so steering keys never reach the OSD canvas or
    // the keyboard-pan module while the sweep runs.
    function onKeyDown(e) {
      if (!nav.running) return;
      if (e.key === 'Escape') { stop(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      var tg = e.target;
      if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) return;
      var k = e.key.toLowerCase();
      if (k === 'n') { e.preventDefault(); nextPass(); return; }
      var dir = STEER_KEYS[k];
      if (!dir) return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) steer(dir);
    }

    viewer.addHandler('open', buildMask);
    if (viewer.world && viewer.world.getItemCount() > 0) buildMask();
    document.addEventListener('keydown', onKeyDown, true);

    nav.start = start;
    nav.stop = stop;
    nav.nextPass = nextPass;
    nav.steer = steer;
    nav.setSkipStrength = setSkipStrength;
    nav.showMask = showMask;
    nav.toggle = function () { nav.running ? stop() : start(); };
    nav.destroy = function () {
      stop();
      viewer.removeHandler('open', buildMask);
      document.removeEventListener('keydown', onKeyDown, true);
    };

    return nav;
  }

  return init;
})();
