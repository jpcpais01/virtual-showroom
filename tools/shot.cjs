// usage: node tools/shot.mjs <url> <out.png> [waitMs] [w] [h]
const { chromium } = require('playwright');
(async () => {
const [url, out, wait = '4000', w = '900', h = '900'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
page.on('console', (m) => console.log('[console]', m.type(), m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url, { timeout: 120000 });
await page.waitForTimeout(+wait);
try { console.log('stats', JSON.stringify(await page.evaluate(() => (window.stats && window.stats()) || (window.__khora && window.__khora.stats())))); } catch (e) {}
await page.screenshot({ path: out, timeout: 150000 });
await browser.close();
})();
