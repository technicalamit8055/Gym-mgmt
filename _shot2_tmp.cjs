const puppeteer = require('puppeteer-core');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const fixture = 'file://' + path.resolve(process.cwd(), '_fixture2_tmp.html').replace(/\\/g, '/');

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 900 });
  await page.goto(fixture, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 200));
  await page.screenshot({ path: path.join(process.cwd(), 'dark2.png') });

  await page.evaluate(() => { document.body.dataset.mode = 'light'; });
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: path.join(process.cwd(), 'light2.png') });

  await browser.close();
  console.log('done');
})();
