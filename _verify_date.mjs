import { chromium } from 'playwright';

const shot = (name) => `C:\\Users\\techn\\AppData\\Local\\Temp\\claude\\c--Users-techn-OneDrive-Desktop-gymbook-gymbook\\95a43e7e-a122-4a3c-ae08-236931091e86\\scratchpad\\${name}.png`;

const browser = await chromium.launch();
const page = await browser.newPage({ colorScheme: 'dark' });
page.on('pageerror', (err) => console.log('PAGE ERROR:', err.message));

await page.goto('http://localhost:3000/g/rsa-pro-fitness');
await page.waitForTimeout(500);
await page.screenshot({ path: shot('01-landing') });

const emailInput = page.locator('input[type="email"], input[name="email"]').first();
await emailInput.fill('admin@gymbook.local');
await page.locator('input[type="password"]').first().fill('admin12345');
await page.locator('button[type="submit"]').first().click();
await page.waitForTimeout(1000);
await page.screenshot({ path: shot('02-after-login') });
console.log('URL after login:', page.url());

await page.goto('http://localhost:3000/g/rsa-pro-fitness/#/members');
await page.waitForTimeout(800);
await page.screenshot({ path: shot('03-members') });

const addBtn = page.locator('button:has-text("New member"), button:has-text("Add member"), button:has-text("＋")').first();
if (await addBtn.count()) {
  await addBtn.click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: shot('04-member-form') });

  const dateFieldText = page.locator('.date-field input[type="text"]').first();
  const count = await page.locator('.date-field').count();
  console.log('date-field wrapper count:', count);

  if (count > 0) {
    const val = await dateFieldText.inputValue();
    console.log('Date field displayed value:', val);

    await page.locator('.date-toggle').first().click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot('05-calendar-open') });

    const dayCell = page.locator('.date-cell.today, .date-cell.selected').first();
    if (await dayCell.count()) {
      await dayCell.click();
    } else {
      await page.locator('.date-cell:not(.empty)').first().click();
    }
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot('06-after-pick') });
    const valAfter = await dateFieldText.inputValue();
    console.log('Date field value after pick:', valAfter);

    await dateFieldText.fill('');
    await dateFieldText.fill('05/03/2026');
    await dateFieldText.press('Tab');
    await page.waitForTimeout(200);
    const valTyped = await dateFieldText.inputValue();
    console.log('Date field value after typing 05/03/2026:', valTyped);
    await page.screenshot({ path: shot('07-after-type') });
  }
} else {
  console.log('Could not find add-member button');
}

await browser.close();
