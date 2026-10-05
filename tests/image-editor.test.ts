import test from 'node:test';
import assert from 'node:assert/strict';
import { arrowHead, cropGeometry, normalizeRect, pixelSize, zoomRect } from '../src/image-editor.ts';

// A 800x600 viewport captured at device pixel ratio 2.
const step = { x: 200, y: 150, width: 800, height: 600 };
const natural = { width: 1600, height: 1200 };

test('without a crop the marker geometry is unchanged', () => {
  assert.deepEqual(cropGeometry(step, natural, null, false), { x: 200, y: 150, width: 800, height: 600, hideMarker: false });
  assert.equal(cropGeometry(step, natural, null, true).hideMarker, true, 'an already hidden marker stays hidden');
});

test('a crop moves the marker into the cropped image and scales viewport units', () => {
  // Crop the image's right-bottom quarter-ish region that contains the marker (400,300 in image pixels).
  const geometry = cropGeometry(step, natural, { x: 200, y: 100, width: 800, height: 600 }, false);
  assert.deepEqual(geometry, { x: 100, y: 100, width: 400, height: 300, hideMarker: false });
  assert.equal(geometry.x / geometry.width, (400 - 200) / 800, 'marker keeps its place in the picture');
});

test('a crop that excludes the marker hides it and keeps valid geometry', () => {
  const geometry = cropGeometry(step, natural, { x: 1000, y: 800, width: 400, height: 300 }, false);
  assert.equal(geometry.hideMarker, true);
  assert.ok(geometry.x >= 0 && geometry.x <= geometry.width && geometry.y >= 0 && geometry.y <= geometry.height);
});

test('dragged rectangles are normalized and clipped to the image', () => {
  assert.deepEqual(normalizeRect({ x: 500, y: 400, width: -300, height: -500 }, natural), { x: 200, y: 0, width: 300, height: 400 });
  assert.deepEqual(normalizeRect({ x: 1500, y: 1100, width: 400, height: 400 }, natural), { x: 1500, y: 1100, width: 100, height: 100 });
});

test('blur cells are large enough that text in the box cannot be read', () => {
  assert.ok(pixelSize({ x: 0, y: 0, width: 300, height: 24 }) >= 12);
  assert.ok(pixelSize({ x: 0, y: 0, width: 600, height: 400 }) >= 24);
});

test('zoom crops half the image around the click, kept inside the image', () => {
  assert.deepEqual(zoomRect({ x: 400, y: 300, width: 800, height: 600 }, natural, false), { x: 400, y: 300, width: 800, height: 600 });
  assert.deepEqual(zoomRect({ x: 20, y: 10, width: 800, height: 600 }, natural, false), { x: 0, y: 0, width: 800, height: 600 }, 'clamped at the top left');
  assert.deepEqual(zoomRect({ x: 790, y: 590, width: 800, height: 600 }, natural, false), { x: 800, y: 600, width: 800, height: 600 }, 'clamped at the bottom right');
  assert.deepEqual(zoomRect({ x: 20, y: 10, width: 800, height: 600 }, natural, true), { x: 400, y: 300, width: 800, height: 600 }, 'hidden marker zooms the centre');
});

test('arrow heads point along the arrow', () => {
  const [left, right] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 20);
  assert.ok(left.x < 100 && right.x < 100, 'behind the tip');
  assert.equal(Math.round(left.y), -Math.round(right.y), 'symmetric');
});
