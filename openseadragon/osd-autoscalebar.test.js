// Run: node openseadragon/osd-autoscalebar.test.js
const fs = require('fs');
const path = require('path');
const OSDAutoScalebar = require('./osd-autoscalebar.js');

console.log('Testing OSDAutoScalebar XML Parser...');

// 1. Test parsing real HE_files/vips-properties.xml
const heXmlPath = path.join(__dirname, '../HE_files/vips-properties.xml');
if (fs.existsSync(heXmlPath)) {
  const heXml = fs.readFileSync(heXmlPath, 'utf8');
  const parsed = OSDAutoScalebar.parseXmlProperties(heXml);
  console.log('HE parsed result:', parsed);

  if (Math.abs(parsed.pixelsPerMeter - 3802021.15) > 1) {
    throw new Error('Incorrect pixelsPerMeter: ' + parsed.pixelsPerMeter);
  }
  if (Math.abs(parsed.mpp - 0.263018) > 0.0001) {
    throw new Error('Incorrect MPP: ' + parsed.mpp);
  }
  if (parsed.appMag !== 40) {
    throw new Error('Incorrect AppMag: ' + parsed.appMag);
  }
  if (!parsed.scanner || !parsed.scanner.includes('GT450')) {
    throw new Error('Incorrect Scanner: ' + parsed.scanner);
  }
  console.log('✓ HE_files/vips-properties.xml parsed successfully');
}

// 2. Test fallback & edge cases
const emptyParsed = OSDAutoScalebar.parseXmlProperties('<image><properties></properties></image>');
console.log('Empty XML result:', emptyParsed);
if (Object.keys(emptyParsed).length !== 0) {
  throw new Error('Empty XML should produce empty parsed properties');
}
console.log('✓ Empty XML handled gracefully');

// 3. Test optical magnification calculations
const mockViewer = {
  world: {
    getItemAt: () => ({ source: { tilesUrl: './HE_files/' } }),
    getItemCount: () => 1
  },
  addHandler: () => {},
  viewport: {
    imageToViewportZoom: (z) => 0.05, // 1:1 image pixel = zoom 0.05
    getZoom: () => 0.025, // currently at 50% of 1:1 -> 20x on a 40x scan
    getCenter: () => ({ x: 0.5, y: 0.5 }),
    zoomTo: (target) => { mockViewer.lastZoomTarget = target; }
  },
  scalebar: () => {}
};

const autoScale = OSDAutoScalebar(mockViewer, {
  fallbackAppMag: 40,
  fallbackPixelsPerMeter: 3802021
});

const currentMag = autoScale.getCurrentMagnification();
console.log('Calculated current magnification:', currentMag);
if (Math.abs(currentMag - 20) > 0.001) {
  throw new Error('Expected 20x magnification, got: ' + currentMag);
}

// Test zoomTo(10) -> should zoom to 25% of 1:1 (0.0125)
autoScale.zoomTo(10);
console.log('Zoom target for 10x:', mockViewer.lastZoomTarget);
if (Math.abs(mockViewer.lastZoomTarget - 0.0125) > 0.0001) {
  throw new Error('Expected zoom target 0.0125 for 10x, got: ' + mockViewer.lastZoomTarget);
}

console.log('ALL AUTOSCALEBAR TESTS PASSED');
