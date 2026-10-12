import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'msedge' });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  serviceWorkers: 'block',
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => m.type() === 'error' && console.log('CONSOLE', m.text()));

await page.addInitScript(() => {
  const realFetch = window.fetch;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/portal/coach/status')) {
      return new Response(JSON.stringify({ enabled: true, daily_limit: 20, remaining_today: 19 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (u.includes('/portal/coach/ask')) {
      const enc = new TextEncoder();
      const ev = (e, d) => enc.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
      const answer =
        "You've eaten 867 calories so far today, with 62g protein. You still have **2413 calories, 82g protein, 303g carbs, and 97g fats** left to reach your daily targets for muscle gain.\n\nFocus on a meal with lean protein like chicken or fish, complex carbs such as rice or potatoes, and healthy fats like avocado or nuts to help you get closer to your goals.";
      const diet = {
        eaten: { calories: 867, protein_g: 62, carbs_g: 117, fats_g: 23 },
        targets: { calories: 3280, protein_g: 144, carbs_g: 420, fats_g: 120 },
      };
      const body = new ReadableStream({
        async start(c) {
          c.enqueue(ev('step', { text: 'Reading your profile and goal' }));
          c.enqueue(ev('step', { text: "Reading today's food log against your targets" }));
          await sleep(500);
          c.enqueue(ev('thought', { text: '**Assessing remaining macros**\nMember has 2413 kcal left.' }));
          await sleep(500);
          for (let i = 0; i < answer.length; i += 12) {
            c.enqueue(ev('answer', { text: answer.slice(i, i + 12) }));
            await sleep(25);
          }
          c.enqueue(ev('done', { answer, diet, remaining_today: 18 }));
          c.close();
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return realFetch(url, opts);
  };
});

// Start dev server is running on port 3001
await page.goto('http://127.0.0.1:3001/');
await page.waitForSelector('#modal-root', { state: 'attached' });
await page.evaluate(async () => {
  localStorage.setItem('gymbook.coach.notice.anon', '1');
  const { openCoachSheet } = await import('/js/coach.js');
  openCoachSheet({ screen: 'diet' });
});

await page.waitForTimeout(600);
await page.screenshot({ path: 'public/images/coach/preview-top.png' });
console.log('Saved preview-top.png');

// Now ask a question
await page.evaluate(async () => {
  const input = document.querySelector('.coach-input');
  const sendBtn = document.querySelector('.coach-send');
  if (input && sendBtn) {
    input.value = 'What should I eat next?';
    sendBtn.click();
  }
});

// Wait for animation to finish
await page.waitForTimeout(4000);
await page.screenshot({ path: 'public/images/coach/preview-bottom.png' });
console.log('Saved preview-bottom.png');
await browser.close();
