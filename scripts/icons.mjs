// Renders public/icons/icon.svg to the PNG sizes Chrome uses.
// Run after changing the icon: node scripts/icons.mjs
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const source = await readFile('public/icons/icon.svg', 'utf8');
// At 16 px a heavier line and a larger dot keep the mark legible.
const small = source.replace('stroke-width="13"', 'stroke-width="18"').replace('r="13" fill="#ff3d8b" stroke="#ffffff" stroke-width="5"', 'r="16" fill="#ff3d8b" stroke="#ffffff" stroke-width="5"');
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128]) {
    const svg = size <= 16 ? small : source;
    const data = await page.evaluate(async ({ svg, size }) => {
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      await image.decode();
      const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
      const context = canvas.getContext('2d');
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, size, size);
      return canvas.toDataURL('image/png');
    }, { svg, size });
    await writeFile(`public/icons/icon-${size}.png`, Buffer.from(data.split(',')[1], 'base64'));
    console.log(`public/icons/icon-${size}.png`);
  }
} finally {
  await browser.close();
}
