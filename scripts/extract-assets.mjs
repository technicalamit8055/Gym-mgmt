
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const srcImg = 'C:/Users/abhin/AppData/Local/Temp/claude/c--Users-abhin-OneDrive-Desktop-Projects-Gymbook-Seatbook/66d3a3ba-2095-4cd8-91b1-c1a499f3885e/images/1.png';
const outDir = path.resolve('public/images/coach');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage();

const base64 = fs.readFileSync(srcImg).toString('base64');
await page.setContent(`
<!DOCTYPE html>
<html>
<head><style>body { margin: 0; background: transparent; }</style></head>
<body>
  <img id="ref" src="data:image/png;base64,${base64}" />
  <canvas id="c"></canvas>
</body>
</html>
`);

await page.waitForFunction(() => {
  const img = document.getElementById('ref');
  return img.complete && img.naturalWidth > 0;
});

// We can crop elements using canvas
const crops = [
  // name, x, y, width, height
  { name: 'coach-hero', x: 612, y: 160, w: 303, h: 310 },
  { name: 'coach-avatar', x: 42, y: 575, w: 108, h: 108 },
  { name: 'food-protein-meal', x: 50, y: 1295, w: 126, h: 126 },
  { name: 'food-yogurt-snack', x: 340, y: 1295, w: 126, h: 126 },
  { name: 'food-healthy-fats', x: 625, y: 1295, w: 126, h: 126 },
];

for (const crop of crops) {
  const { pngUrl, webpUrl } = await page.evaluate(({ x, y, w, h }) => {
    const img = document.getElementById('ref');
    const c = document.getElementById('c');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
    return {
      pngUrl: c.toDataURL('image/png'),
      webpUrl: c.toDataURL('image/webp', 0.95),
    };
  }, crop);

  fs.writeFileSync(path.join(outDir, `${crop.name}.png`), Buffer.from(pngUrl.split(',')[1], 'base64'));
  fs.writeFileSync(path.join(outDir, `${crop.name}.webp`), Buffer.from(webpUrl.split(',')[1], 'base64'));
  console.log(`Saved ${crop.name} (.png & .webp, ${crop.w}x${crop.h})`);
}

await browser.close();
console.log('All crops saved.');
