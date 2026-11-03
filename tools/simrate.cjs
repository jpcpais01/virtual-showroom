// measures cloth sim speed vs real time (no rendering): node tools/simrate.cjs [hold|overview|booth|drag]
const { chromium } = require('playwright');
(async () => {
  const mode = process.argv[2] || 'hold';
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  const t0 = Date.now();
  await page.goto('http://127.0.0.1:5173/?auto&bench&nolock', { timeout: 120000 });
  await page.waitForFunction(() => window.__khora && !document.getElementById('enterActions').hidden, null, { timeout: 120000 });
  console.log('ready after', ((Date.now() - t0) / 1000).toFixed(1), 's');
  await page.evaluate((mode) => {
    const K = window.__khora;
    const c = K.controls;
    if (mode === 'hold') { K.focus(K.hero); K.pickUp(); }
    if (mode === 'overview') { c.fly = null; c.pos.set(-1.5, 1.65, 5.5); c.yaw = c.yawT = 0.35; c.pitch = c.pitchT = -0.05; K.tees.forEach((t) => t.wake()); }
    if (mode === 'booth') { const sp = K.spots.booth; c.fly = null; c.pos.copy(sp.pos); c.yaw = c.yawT = sp.yaw; }
    if (mode === 'drag') { K.focus(K.hero); }
  }, mode);
  await page.waitForTimeout(3000);
  const a = await page.evaluate(() => ({ t: performance.now(), s: window.__khora.stats(), asleep: window.__khora.tees.map((t) => t.asleep + ':' + t.ke.toExponential(1)) }));
  await page.waitForTimeout(6000);
  const b = await page.evaluate(() => ({ t: performance.now(), s: window.__khora.stats(), asleep: window.__khora.tees.map((t) => t.asleep + ':' + t.ke.toExponential(1)) }));
  const wall = (b.t - a.t) / 1000;
  for (const id in b.s.steps) console.log('garment', id, 'sim/real =', ((b.s.steps[id] - (a.s.steps[id] || 0)) / wall).toFixed(2));
  console.log('fps', ((b.s.frames - a.s.frames) / wall).toFixed(1), 'workerMs per batch', b.s.workerMs, 'mainMs', b.s.updateMs, 'asleep', b.asleep);
  await browser.close();
})();
