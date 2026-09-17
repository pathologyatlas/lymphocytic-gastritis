/**
 * OSD Auto Scalebar & Calibration
 * Automatically detects slide resolution (MPP, pixelsPerMeter, AppMag)
 * from vips-properties.xml, configures the OpenSeadragon Scalebar,
 * and provides microscope optical magnification utilities (2x, 4x, 10x, 20x, 40x).
 *
 * Usage:
 *   var autoScale = OSDAutoScalebar(viewer, {
 *     onCalibrate: function (info) { console.log('Calibrated:', info); }
 *   });
 *   autoScale.zoomTo(20); // Zoom to 20x objective power
 *   console.log(autoScale.getMagnification()); // e.g. 20.0
 */
var OSDAutoScalebar = (function () {
  function init(viewer, opts) {
    opts = opts || {};

    var info = {
      calibrated: false,
      pixelsPerMeter: opts.fallbackPixelsPerMeter || 3.80202e+06, // default ~0.263 µm/px (40x)
      mpp: opts.fallbackMPP || 0.263018,
      appMag: opts.fallbackAppMag || 40,
      scanner: opts.fallbackScanner || 'Aperio GT450 DX',
      sourceUrl: null
    };

    var scalebarDefaults = {
      type: (typeof OpenSeadragon !== 'undefined' && OpenSeadragon.ScalebarType) ? OpenSeadragon.ScalebarType.MICROSCOPY : 1,
      minWidth: opts.minWidth || '120px',
      location: (typeof OpenSeadragon !== 'undefined' && OpenSeadragon.ScalebarLocation) ? OpenSeadragon.ScalebarLocation.BOTTOM_RIGHT : 3,
      color: opts.color || 'black',
      fontColor: opts.fontColor || 'black',
      backgroundColor: opts.backgroundColor || 'rgba(255,255,255,0.65)',
      barThickness: opts.barThickness || 3,
      fontSize: opts.fontSize || '12px',
      xOffset: opts.xOffset != null ? opts.xOffset : 14,
      yOffset: opts.yOffset != null ? opts.yOffset : 14
    };

    function applyScalebar() {
      if (!viewer.scalebar) return;
      var conf = Object.assign({}, scalebarDefaults, {
        pixelsPerMeter: info.pixelsPerMeter
      });
      viewer.scalebar(conf);
    }

    // Initial scalebar setup with fallback/default
    applyScalebar();

    function parseXmlProperties(xmlText) {
      var parsed = {};

      // 1. Check for <name>xres</name><value...>...</value>
      var xresMatch = xmlText.match(/<name>\s*xres\s*<\/name>\s*<value[^>]*>([^<]+)<\/value>/i);
      if (xresMatch) {
        var xres = parseFloat(xresMatch[1]);
        if (!isNaN(xres) && xres > 0) {
          // OpenSlide dzsave xres is in pixels per millimeter -> convert to pixels per meter
          parsed.pixelsPerMeter = xres * 1000;
          parsed.mpp = 1000 / xres; // µm per pixel
        }
      }

      // 2. Check for <name>aperio.MPP</name> or comment MPP = ...
      var mppMatch = xmlText.match(/<name>\s*aperio\.MPP\s*<\/name>\s*<value[^>]*>([^<]+)<\/value>/i) ||
                     xmlText.match(/MPP\s*=\s*([0-9.]+)/i);
      if (mppMatch) {
        var mpp = parseFloat(mppMatch[1]);
        if (!isNaN(mpp) && mpp > 0) {
          parsed.mpp = mpp;
          parsed.pixelsPerMeter = 1 / (mpp * 1e-6);
        }
      }

      // 3. Check for aperio.AppMag or comment AppMag = ...
      var magMatch = xmlText.match(/<name>\s*aperio\.AppMag\s*<\/name>\s*<value[^>]*>([^<]+)<\/value>/i) ||
                     xmlText.match(/AppMag\s*=\s*([0-9.]+)/i);
      if (magMatch) {
        var mag = parseFloat(magMatch[1]);
        if (!isNaN(mag) && mag > 0) parsed.appMag = Math.round(mag);
      }

      // 4. Scanner Type
      var scanMatch = xmlText.match(/ScannerType\s*=\s*([^|\r\n<]+)/i) ||
                      xmlText.match(/<name>\s*aperio\.ScannerType\s*<\/name>\s*<value[^>]*>([^<]+)<\/value>/i);
      if (scanMatch) parsed.scanner = scanMatch[1].trim();

      return parsed;
    }

    function detectXmlUrl() {
      var item = viewer.world && viewer.world.getItemAt(0);
      if (!item || !item.source) return null;
      var src = item.source;

      // DeepZoom tileSources often store Image.Url (e.g. './HE_files/')
      if (src.tilesUrl) {
        var u = src.tilesUrl;
        return u.endsWith('/') ? u + 'vips-properties.xml' : u + '/vips-properties.xml';
      }

      if (src.getTileUrl) {
        // e.g. './HE_files/0/0_0.jpeg'
        var tileUrl = src.getTileUrl(0, 0, 0);
        if (tileUrl) {
          var filesIdx = tileUrl.indexOf('_files/');
          if (filesIdx !== -1) {
            return tileUrl.substring(0, filesIdx + 7) + 'vips-properties.xml';
          }
        }
      }
      return null;
    }

    function calibrateFromXml(url) {
      if (!url) return;
      info.sourceUrl = url;

      if (typeof fetch === 'function') {
        fetch(url)
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.text();
          })
          .then(function (xmlText) {
            var res = parseXmlProperties(xmlText);
            if (res.pixelsPerMeter) info.pixelsPerMeter = res.pixelsPerMeter;
            if (res.mpp) info.mpp = res.mpp;
            if (res.appMag) info.appMag = res.appMag;
            if (res.scanner) info.scanner = res.scanner;
            info.calibrated = true;

            applyScalebar();

            if (typeof opts.onCalibrate === 'function') {
              opts.onCalibrate(info);
            }
          })
          .catch(function () {
            // Graceful fallback to default calibration
            applyScalebar();
            if (typeof opts.onCalibrate === 'function') {
              opts.onCalibrate(info);
            }
          });
      }
    }

    function initDetection() {
      var url = opts.xmlUrl || detectXmlUrl();
      if (url) calibrateFromXml(url);
    }

    if (viewer.addHandler) {
      viewer.addHandler('open', initDetection);
    }
    if (viewer.world && viewer.world.getItemCount && viewer.world.getItemCount() > 0) {
      initDetection();
    }

    // -------------------------------------------------------------
    // Microscope Objective Magnification Utilities
    // Standard pathology WSI convention:
    // 1:1 image-to-screen pixel ratio corresponds to AppMag (e.g. 40x scan).
    // -------------------------------------------------------------
    function getCurrentMagnification() {
      if (!viewer.viewport) return 1;
      var fullZoom = viewer.viewport.imageToViewportZoom(1);
      if (!fullZoom || fullZoom <= 0) return 1;
      var currentZoom = viewer.viewport.getZoom(true);
      return (currentZoom / fullZoom) * info.appMag;
    }

    function zoomToMagnification(targetMag, refPoint) {
      if (!viewer.viewport) return;
      var fullZoom = viewer.viewport.imageToViewportZoom(1);
      if (!fullZoom || fullZoom <= 0) return;
      var targetZoom = fullZoom * (targetMag / info.appMag);
      var center = refPoint || (viewer.viewport.getCenter ? viewer.viewport.getCenter() : null);
      viewer.viewport.zoomTo(targetZoom, center, false);
    }

    return {
      info: info,
      parseXmlProperties: parseXmlProperties,
      getCurrentMagnification: getCurrentMagnification,
      zoomTo: zoomToMagnification,
      refresh: applyScalebar
    };
  }

  // Export static parser for unit tests / headless environments
  init.parseXmlProperties = function (xmlText) {
    var dummy = { world: null, addHandler: function () {} };
    return init(dummy).parseXmlProperties(xmlText);
  };

  return init;
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = OSDAutoScalebar;
}
