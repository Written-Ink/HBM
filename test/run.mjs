// Headless test: node test/run.mjs   (needs playwright; uses the pre-installed Chromium)
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
const dir = path.dirname(new URL(import.meta.url).pathname);
const script = fs.readFileSync(path.join(dir, '..', 'trackit-truck-filter.user.js'), 'utf8');
const html = fs.readFileSync(path.join(dir, 'mock-map.html'), 'utf8');

const feed = { trucks: [
  { truckNo: '101', statusDesc: 'To Job', lat: 1, lon: 2 },
  { truckNo: '102', statusDesc: 'Pouring', lat: 1, lon: 2 },
  { truckNo: '203', statusDesc: 'Returning', lat: 1, lon: 2 },
  { truckNo: '204', statusDesc: 'At Plant', lat: 1, lon: 2 },
]};
let fail = 0;
const check = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) fail++; };

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => { console.log('PAGE ERROR', e.message); fail++; });
await page.route('**/*', (route) => {
  const u = route.request().url();
  if (u.endsWith('/Map.jsp')) return route.fulfill({ contentType: 'text/html', body: html });
  if (u.endsWith('/TruckData.jsp')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(feed) });
  return route.fulfill({ status: 404, body: '' });
});
await page.addInitScript({ content: script + '\n' });
await page.addInitScript(() => {  // count chimes instead of playing them
  window.__chimes = 0;
  const AC = window.AudioContext;
  window.AudioContext = function () { const c = new AC(); const o = c.createOscillator.bind(c);
    c.createOscillator = () => { window.__chimes++; return o(); }; return c; };
});
await page.goto('https://trackit-eu.commandalkon.io/dispatch/Map.jsp');
await page.waitForTimeout(1500);

const ids = await page.evaluate(() => [...window.__tkf.trucks.keys()].sort());
check(JSON.stringify(ids) === '["101","102","203","204"]', 'detects all trucks: ' + ids);
check(await page.evaluate(() => window.__tkf.trucks.get('102').eff) === 'Pouring', 'status from network feed');
check(await page.locator('#tkf-host').count() === 1, 'panel mounted');

// Choose my trucks via the panel search box (Enter adds)
await page.locator('#tkf-host input[data-k="q"]').fill('101, 203');
await page.locator('#tkf-host input[data-k="q"]').press('Enter');
await page.waitForTimeout(500);
const vis = await page.evaluate(() => window.__allMarkers.map((m) => [m.getTitle().split(' ')[1], m._v.map ? 'on' : 'off']));
check(JSON.stringify(vis) === '[["101","on"],["102","off"],["203","on"],["204","off"]]', 'only my markers on map: ' + JSON.stringify(vis));

// A hidden marker re-added by the app must stay hidden
await page.evaluate(() => window.__allMarkers[1].setMap({ name: 'MAP' }));
check(await page.evaluate(() => !window.__allMarkers[1]._v.map), 'hidden marker stays hidden when app re-adds it');

// Unlock audio with a click (browser gesture rule), then make 203 go idle
await page.mouse.click(5, 5);
feed.trucks[2].statusDesc = 'Idle';
await page.waitForTimeout(1200);
const events = await page.evaluate(() => window.__chimes);
check(events === 6, 'chime played 3x (6 tones) for my truck going idle: ' + events);
check(await page.locator('#tkf-host').evaluate((h) => h.shadowRoot.textContent.includes('203 went idle')), 'alert logged in panel');

// Non-mine truck going idle: no sound
feed.trucks[1].statusDesc = 'Idle';
await page.waitForTimeout(1200);
check(await page.evaluate(() => window.__chimes) === 6, 'no alert for trucks that are not mine');

// Filter off shows everything
await page.locator('#tkf-host input[type=checkbox]').first().uncheck();
await page.waitForTimeout(300);
check(await page.evaluate(() => window.__allMarkers.every((m) => m._v.map)), 'filter off shows all markers');
await page.locator('#tkf-host input[type=checkbox]').first().check();

// List row filtering via the picker
await page.locator('#tkf-host summary', { hasText: 'Settings' }).click();
await page.locator('#tkf-host button', { hasText: 'Pick truck row' }).click();
await page.locator('#trucks td').first().click();
await page.waitForTimeout(2600);
const sel = await page.evaluate(() => window.__tkf.settings.rowSelector);
const rows = await page.evaluate(() => [...document.querySelectorAll('#trucks tr')].map((r) => r.cells[0].textContent + ':' + (r.style.display || 'shown')));
check(sel === 'tr.truckRow', 'picker selector: ' + sel);
check(rows.filter((r) => r.endsWith('none')).length === 2, 'non-mine list rows hidden: ' + rows);

// Settings persist across reload
await page.reload();
await page.waitForTimeout(1500);
check(JSON.stringify(await page.evaluate(() => window.__tkf.settings.myTrucks)) === '["101","203"]', 'my trucks persisted');
await page.screenshot({ path: path.join(dir, 'screenshot.png') });
await browser.close();
console.log(fail ? `${fail} FAILED` : 'ALL PASSED');
process.exit(fail ? 1 : 0);
