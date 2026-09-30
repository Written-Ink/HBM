// Tests the bookmarklet build (run node tools/build-bookmarklet.mjs first): node test/bookmarklet.mjs
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
const dir = path.dirname(new URL(import.meta.url).pathname);
const url = fs.readFileSync(path.join(dir, '..', 'dist', 'bookmarklet.txt'), 'utf8');
const code = decodeURIComponent(url.slice('javascript:'.length));
const html = fs.readFileSync(path.join(dir, 'mock-map.html'), 'utf8');
const frameset = '<!doctype html><html><body style="margin:0"><div>Dispatch</div><iframe src="/dispatch/Map.jsp" style="width:1000px;height:700px"></iframe></body></html>';

let fail = 0;
const check = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) fail++; };
const browser = await chromium.launch();

for (const mode of ['direct', 'iframe']) {
  const feed = { trucks: [
    { truckNo: '101', statusDesc: 'To Job', lat: 1, lon: 2 },
    { truckNo: '102', statusDesc: 'Pouring', lat: 1, lon: 2 },
    { truckNo: '203', statusDesc: 'Returning', lat: 1, lon: 2 },
    { truckNo: '204', statusDesc: 'At Plant', lat: 1, lon: 2 },
  ]};
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log('PAGE ERROR', e.message); fail++; });
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.endsWith('/Map.jsp')) return route.fulfill({ contentType: 'text/html', body: html });
    if (u.endsWith('/Dispatch.jsp')) return route.fulfill({ contentType: 'text/html', body: frameset });
    if (u.endsWith('/TruckData.jsp')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(feed) });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('https://trackit-eu.commandalkon.io/dispatch/' + (mode === 'direct' ? 'Map.jsp' : 'Dispatch.jsp'));
  await page.waitForTimeout(1000);                 // map fully loaded BEFORE the bookmarklet is clicked
  await page.evaluate(code);                       // "click" the bookmarklet
  await page.evaluate(code);                       // clicking twice must be harmless
  const f = mode === 'direct' ? page.mainFrame() : page.frames()[1];
  await page.waitForTimeout(1500);
  const ids = await f.evaluate(() => [...window.__tkf.trucks.keys()].sort().join());
  check(ids === '101,102,203,204', `[${mode}] trucks detected after late start: ${ids}`);
  check(await f.locator('#tkf-host').count() === 1, `[${mode}] one panel, in the map frame`);
  if (mode === 'iframe') check(await page.mainFrame().locator('#tkf-host').count() === 0, '[iframe] no duplicate panel in outer page');

  await f.evaluate(() => { window.__tkf.settings.myTrucks = ['203']; window.__tkf.applyFilter(); });
  await page.waitForTimeout(800);
  const vis = await f.evaluate(() => window.__allMarkers.map((m) => (m._v.map ? 'on' : 'off')).join());
  check(vis === 'off,off,on,off', `[${mode}] pre-existing markers filtered: ${vis}`);

  await f.evaluate(() => { window.__c = 0; });
  await f.evaluate(() => { const AC = window.AudioContext.prototype.createOscillator;
    window.AudioContext.prototype.createOscillator = function () { window.__c++; return AC.call(this); }; });
  await page.mouse.click(5, 5);
  feed.trucks[2].statusDesc = 'Idle';
  await page.waitForTimeout(1200);
  check(await f.evaluate(() => window.__c) === 6, `[${mode}] idle alert chimed`);
  await ctx.close();
}
await browser.close();
console.log(fail ? `${fail} FAILED` : 'ALL PASSED');
process.exit(fail ? 1 : 0);
