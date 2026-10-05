// Pixelation shared by automatic blur (worker) and the screenshot editor (page).
export interface Rect { x: number; y: number; width: number; height: number }
// Boxes in viewport CSS pixels, as reported by the page at capture time.
export interface Regions { width: number; height: number; boxes: Rect[] }

// Pixelation cell size. Large cells make blurred text unrecoverable.
export const pixelSize = (rect: Rect) => Math.max(12, Math.round(Math.min(rect.width, rect.height) / 4));

type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type MakeCanvas = (width: number, height: number) => HTMLCanvasElement | OffscreenCanvas;
export function pixelate(context: Canvas2D, rect: Rect, makeCanvas: MakeCanvas): void {
  if (rect.width < 1 || rect.height < 1) return;
  const cell = pixelSize(rect);
  const small = makeCanvas(Math.max(1, Math.ceil(rect.width / cell)), Math.max(1, Math.ceil(rect.height / cell)));
  const s = small.getContext('2d') as Canvas2D;
  s.imageSmoothingEnabled = true; s.imageSmoothingQuality = 'high';
  s.drawImage(context.canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, small.width, small.height);
  context.save(); context.imageSmoothingEnabled = false;
  context.drawImage(small, 0, 0, small.width, small.height, rect.x, rect.y, rect.width, rect.height);
  context.restore();
}

// Viewport boxes to screenshot pixels: scaled by the device pixel ratio,
// padded so glyph edges are covered, clipped to the image.
export function imageBoxes(regions: Regions[], image: { width: number; height: number }): Rect[] {
  const out: Rect[] = [];
  for (const region of regions) {
    if (!(region.width > 0) || !(region.height > 0)) continue;
    const sx = image.width / region.width, sy = image.height / region.height, pad = 4;
    for (const box of region.boxes) {
      const x1 = Math.max(0, Math.floor((box.x - pad) * sx)), y1 = Math.max(0, Math.floor((box.y - pad) * sy));
      const x2 = Math.min(image.width, Math.ceil((box.x + box.width + pad) * sx)), y2 = Math.min(image.height, Math.ceil((box.y + box.height + pad) * sy));
      if (x2 > x1 && y2 > y1) out.push({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
    }
  }
  return out;
}
// Boxes only map onto a screenshot of the same shape. A mismatch (an emulated
// viewport, a resize mid-capture) means the boxes cannot be trusted.
export function matchesViewport(regions: Regions[], image: { width: number; height: number }): boolean {
  return regions.every(r => r.width > 0 && r.height > 0 && Math.abs(image.width / image.height - r.width / r.height) <= 0.03 * (r.width / r.height));
}
