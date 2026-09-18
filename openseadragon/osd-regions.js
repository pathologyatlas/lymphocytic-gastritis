/**
 * OSD Regions
 * Click-to-zoom region panel for OpenSeadragon. Derives a `<stain>.regions.json`
 * sidecar URL from the viewer's tile source (same trick as osd-autoscalebar.js
 * uses for vips-properties.xml), fetches it, validates it against the actually
 * loaded image size, and renders a small dark-UI button list. Clicking a
 * button (or calling activateById) uses viewport.fitBounds() to frame the
 * region with a little padding.
 *
 * Most slides will not have a regions.json — a missing or unparsable file is
 * treated as "this slide has no regions" and is completely silent (no console
 * errors, no empty panel).
 *
 * Usage:
 *   var regions = OSDRegions(viewer, {
 *     lang: 'tr',
 *     onActivate: function (regionId) { ... }
 *   });
 *   regions.activateById('r1', true);
 *
 * Options:
 *   lang           - 'tr' (default) or 'en'. Controls which label_ / note_
 *                     field is preferred and the panel's own heading text.
 *   padding        - Fractional inflate applied to each region's bounding
 *                     box before fitBounds (default 0.10 = 10%).
 *   regionsUrl     - Override the auto-derived <stain>.regions.json URL.
 *   container      - DOM node the panel is appended to (default document.body).
 *   title          - Override the panel heading text.
 *   onRegionsLoaded(data)   - Fired once a valid, size-matched regions.json
 *                             has been rendered.
 *   onActivate(regionId)    - Fired whenever a region is framed, whether by
 *                             a button click or activateById() (including the
 *                             initial deep-link jump from a `r=` hash term).
 *   onSizeMismatch(expected, actual) - Fired instead of rendering when the
 *                             regions.json `size` doesn't match the loaded
 *                             image's content size.
 *
 * Deep links: on the very first 'open' event this plugin captures any
 * `r=<regionId>` term present in window.location.hash (via addOnceHandler),
 * then applies it (immediately, no animation) once regions.json has loaded
 * and validated — whichever happens later. Nothing here writes to the hash;
 * host pages that already own a hash convention (like HE.html's
 * #stain=..&x=..&y=..&z=..) should append '&r=' + id themselves from the
 * onActivate callback so the two coordinate systems (raw pixels here,
 * viewport fractions in the host's x/y/z) never mix in one code path.
 */
var OSDRegions = (function () {

  function init(viewer, opts) {
    opts = opts || {};

    var lang = opts.lang || 'tr';
    var padding = opts.padding != null ? opts.padding : 0.10;
    var container = opts.container || document.body;

    var currentData = null;
    var activeId = null;
    var panelEl = null;

    var pendingInitialRegionId = null;
    var initialHashCaptured = false;

    // -------------------------------------------------------------
    // URL derivation — mirrors osd-autoscalebar.js's detectXmlUrl(),
    // but strips "_files" instead of appending "/vips-properties.xml".
    //   './HE_files/' -> './HE.regions.json'
    // -------------------------------------------------------------
    function stripFilesSuffix(base) {
      if (base.substr(-6) === '_files') {
        return base.substr(0, base.length - 6);
      }
      return base;
    }

    function detectRegionsUrl() {
      var item = viewer.world && viewer.world.getItemAt(0);
      if (!item || !item.source) return null;
      var src = item.source;

      if (src.tilesUrl) {
        var u = src.tilesUrl;
        var base = u.charAt(u.length - 1) === '/' ? u.slice(0, -1) : u;
        return stripFilesSuffix(base) + '.regions.json';
      }

      if (src.getTileUrl) {
        var tileUrl = src.getTileUrl(0, 0, 0);
        if (tileUrl) {
          var filesIdx = tileUrl.indexOf('_files/');
          if (filesIdx !== -1) {
            return tileUrl.substring(0, filesIdx) + '.regions.json';
          }
        }
      }
      return null;
    }

    // -------------------------------------------------------------
    // Fetch + validate. Silent on 404 / network error / bad JSON —
    // most slides simply have no regions.json.
    // -------------------------------------------------------------
    function loadRegions() {
      var url = opts.regionsUrl || detectRegionsUrl();
      if (!url) return;
      if (typeof fetch !== 'function') return;

      fetch(url)
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (data) {
          if (!data || !Array.isArray(data.regions)) throw new Error('malformed regions.json');
          handleData(data);
        })
        .catch(function () {
          // 404, network failure, or JSON parse error: do nothing at all.
          removePanel();
        });
    }

    function handleData(data) {
      currentData = null;
      removePanel();

      var item = viewer.world && viewer.world.getItemAt(0);
      var contentSize = item && item.getContentSize ? item.getContentSize() : null;

      if (data.size && contentSize) {
        if (data.size.width !== contentSize.x || data.size.height !== contentSize.y) {
          console.warn(
            '[OSDRegions] regions.json size ' + data.size.width + 'x' + data.size.height +
            ' does not match loaded image size ' + contentSize.x + 'x' + contentSize.y +
            ' — regions not rendered (coordinates would point at the wrong tissue).'
          );
          if (typeof opts.onSizeMismatch === 'function') {
            opts.onSizeMismatch(data.size, { width: contentSize.x, height: contentSize.y });
          }
          return;
        }
      }

      currentData = data;
      buildPanel(data);

      if (typeof opts.onRegionsLoaded === 'function') opts.onRegionsLoaded(data);

      // Deep-link: apply the region id captured from the hash at the very
      // first 'open' (if any), now that we actually have data to look it up in.
      if (pendingInitialRegionId) {
        var rid = pendingInitialRegionId;
        pendingInitialRegionId = null;
        activateById(rid, true);
      }
    }

    // -------------------------------------------------------------
    // Panel UI — dark-chrome style matching #stain-bar / #toolbar.
    // -------------------------------------------------------------
    function ensureStyle() {
      if (document.getElementById('osd-regions-style')) return;
      var style = document.createElement('style');
      style.id = 'osd-regions-style';
      style.textContent =
        '.osd-regions-panel {' +
        '  position: absolute; bottom: 10px; right: 10px; z-index: 100;' +
        '  background: rgba(0,0,0,0.85); padding: 8px 10px; border-radius: 8px;' +
        '  display: flex; flex-direction: column; gap: 4px; font-size: 11px;' +
        '  font-family: Arial, sans-serif; color: #eee; user-select: none;' +
        '  max-width: 230px; max-height: 40vh; overflow-y: auto; overflow-x: hidden;' +
        '  box-shadow: 0 4px 16px rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.12);' +
        '  scrollbar-width: thin; scrollbar-color: #555 transparent;' +
        '}' +
        '.osd-regions-panel::-webkit-scrollbar { width: 4px; }' +
        '.osd-regions-panel::-webkit-scrollbar-thumb { background: #555; border-radius: 2px; }' +
        '.osd-regions-panel::-webkit-scrollbar-track { background: transparent; }' +
        '.osd-regions-panel .osd-regions-title {' +
        '  font-size: 10px; color: #9cf; text-transform: uppercase; letter-spacing: 0.8px;' +
        '  font-weight: bold; margin-bottom: 2px;' +
        '}' +
        '.osd-regions-panel button.osd-region-btn {' +
        '  display: block; width: 100%; text-align: left; padding: 5px 8px;' +
        '  border-radius: 4px; border: 1px solid #555; background: #2a2a2a; color: #eee;' +
        '  font-size: 11px; cursor: pointer; transition: background 0.15s, border-color 0.15s;' +
        '  font-family: Arial, sans-serif;' +
        '}' +
        '.osd-regions-panel button.osd-region-btn:hover { background: #444; border-color: #777; color: #fff; }' +
        '.osd-regions-panel button.osd-region-btn.active { background: #06a; border-color: #09d; color: #fff; font-weight: bold; }';
      document.head.appendChild(style);
    }

    function removePanel() {
      if (panelEl && panelEl.parentNode) panelEl.parentNode.removeChild(panelEl);
      panelEl = null;
    }

    function regionLabel(r) {
      if (lang === 'en') return r.label_en || r.label_tr || r.id;
      return r.label_tr || r.label_en || r.id;
    }

    function regionNote(r) {
      if (lang === 'en') return r.note_en || r.note_tr || '';
      return r.note_tr || r.note_en || '';
    }

    function buildPanel(data) {
      ensureStyle();
      removePanel();

      panelEl = document.createElement('div');
      panelEl.className = 'osd-regions-panel';

      var title = document.createElement('div');
      title.className = 'osd-regions-title';
      title.textContent = opts.title || (lang === 'en' ? 'Regions' : 'Bölgeler');
      panelEl.appendChild(title);

      data.regions.forEach(function (r) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'osd-region-btn';
        btn.textContent = regionLabel(r);
        btn.setAttribute('data-region-id', r.id);
        var note = regionNote(r);
        if (note) btn.title = note;
        btn.addEventListener('click', function () {
          activate(r, false);
        });
        panelEl.appendChild(btn);
      });

      container.appendChild(panelEl);
      updateActiveButton();
    }

    function updateActiveButton() {
      if (!panelEl) return;
      var btns = panelEl.querySelectorAll('button.osd-region-btn');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('active', btns[i].getAttribute('data-region-id') === activeId);
      }
    }

    // -------------------------------------------------------------
    // Jump-to-region. Padding inflates the viewport rect (NOT the raw
    // pixel rect) symmetrically about its center so it works the same
    // regardless of image aspect ratio.
    // -------------------------------------------------------------
    function inflateViewportRect(rect, factor) {
      var dw = rect.width * factor;
      var dh = rect.height * factor;
      return new OpenSeadragon.Rect(
        rect.x - dw / 2,
        rect.y - dh / 2,
        rect.width + dw,
        rect.height + dh,
        rect.degrees
      );
    }

    function activate(r, immediately) {
      if (!viewer.viewport) return;
      var vpRect = viewer.viewport.imageToViewportRectangle(
        new OpenSeadragon.Rect(r.x, r.y, r.width, r.height));
      var padded = inflateViewportRect(vpRect, padding);
      viewer.viewport.fitBounds(padded, !!immediately);

      activeId = r.id;
      updateActiveButton();

      if (typeof opts.onActivate === 'function') opts.onActivate(r.id);
    }

    function findRegion(id) {
      if (!currentData) return null;
      for (var i = 0; i < currentData.regions.length; i++) {
        if (currentData.regions[i].id === id) return currentData.regions[i];
      }
      return null;
    }

    function activateById(id, immediately) {
      var r = findRegion(id);
      if (!r) return false;
      activate(r, immediately);
      return true;
    }

    // -------------------------------------------------------------
    // Deep-link capture: read '#...&r=<id>' exactly once, at the very
    // first image open, so later stain switches / re-opens don't keep
    // re-applying a stale hash value.
    // -------------------------------------------------------------
    function captureInitialHash() {
      if (initialHashCaptured) return;
      initialHashCaptured = true;
      var h = window.location.hash;
      if (!h) return;
      var params = new URLSearchParams(h.replace(/^#/, ''));
      var rid = params.get('r');
      if (rid) pendingInitialRegionId = rid;
    }

    if (viewer.addOnceHandler) {
      viewer.addOnceHandler('open', captureInitialHash);
    } else if (viewer.addHandler) {
      // Defensive fallback for older OSD builds without addOnceHandler.
      var onceWrap = function () {
        if (viewer.removeHandler) viewer.removeHandler('open', onceWrap);
        captureInitialHash();
      };
      viewer.addHandler('open', onceWrap);
    }

    if (viewer.addHandler) {
      viewer.addHandler('open', loadRegions);
    }
    if (viewer.world && viewer.world.getItemCount && viewer.world.getItemCount() > 0) {
      loadRegions();
    }

    function destroy() {
      removePanel();
      if (viewer.removeHandler) {
        viewer.removeHandler('open', loadRegions);
      }
    }

    return {
      getRegions: function () { return currentData; },
      getActiveRegionId: function () { return activeId; },
      activateById: activateById,
      refresh: loadRegions,
      destroy: destroy
    };
  }

  return init;
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = OSDRegions;
}
