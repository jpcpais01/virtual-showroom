// scripted interaction screenshots: node tools/flow.cjs <outDir>
const { chromium } = require('playwright');
(async () => {
  const out = process.argv[2];
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const W = +(process.env.W || 1100), H = +(process.env.H || 680);
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.text()); });
  const steps = (process.argv[3] || 'booth,rail,hold,back').split(',');
  await page.goto('http://127.0.0.1:5173/?auto&nolock&bench', { timeout: 120000 });
  await page.waitForFunction(() => window.__khora && !document.getElementById('enterActions').hidden, null, { timeout: 150000 });
  await page.waitForTimeout(1500);
  if (process.env.TARGET) await page.evaluate((t) => (window.__target = t), process.env.TARGET);
  const shot = async (name) => { await page.evaluate(() => window.__khora.setBench(false)); await page.waitForTimeout(1500); await page.screenshot({ path: `${out}/f_${name}.png`, timeout: 200000 }); console.log('shot', name); await page.evaluate(() => window.__khora.setBench(true)); };
  for (const s of steps) {
    if (s === 'booth' || s === 'rail' || s === 'entrance') {
      await page.evaluate((k) => { const K = window.__khora; const sp = K.spots[k]; K.controls.flyTo(sp.pos, sp.yaw, sp.pitch); }, s);
      await page.waitForTimeout(9000);
      await shot(s);
    }
    if (s.startsWith('cam:')) {
      // cam:x:y:z:yaw:pitch:name:wait
      const [, x, y, z, yaw, pitch, name, wait] = s.split(':');
      await page.evaluate(([x, y, z, yaw, pitch]) => { const c = window.__khora.controls; c.fly = null; c.pos.set(x, y, z); c.yaw = c.yawT = yaw; c.pitch = c.pitchT = pitch; }, [+x, +y, +z, +yaw, +pitch]);
      await page.waitForTimeout(+(wait || 5000));
      await shot(name);
    }
    if (s === 'focus') {
      await page.evaluate(() => { const K = window.__khora; const t = K.tees.find((x) => x.name === (window.__target || 'hero')) || K.hero; K.focus(t); const c = K.controls; const f = c.fly; c.fly = null; if (t !== K.hero && f) { c.pos.copy(f.to); c.yaw = c.yawT = f.yaw1; c.pitch = c.pitchT = f.p1; } if (t === K.hero) { c.pos.copy(K.spots.hero.pos); c.yaw = c.yawT = 0; c.pitch = c.pitchT = -0.02; } });
      await page.waitForTimeout(3000);
      await shot('focus');
    }
    if (s === 'hold') {
      await page.evaluate(() => { const K = window.__khora; const t = K.tees.find((x) => x.name === (window.__target || 'hero')) || K.hero; K.focus(t); const c = K.controls; const f = c.fly; c.fly = null; if (t !== K.hero && f) { c.pos.copy(f.to); c.yaw = c.yawT = f.yaw1; c.pitch = c.pitchT = f.p1; } if (t === K.hero) { c.pos.copy(K.spots.hero.pos); c.yaw = c.yawT = 0; c.pitch = c.pitchT = -0.02; } });
      await page.waitForTimeout(3000);
      await page.evaluate(() => window.__khora.pickUp());
      await page.waitForTimeout(+(process.env.HOLDWAIT || 30000));
      await shot('hold');
    }
    if (s === 'put') {
      await page.evaluate(() => window.__khora.putBack());
      await page.waitForTimeout(+(process.env.HOLDWAIT || 30000));
      await shot('put');
    }
    if (s === 'back') {
      await page.evaluate(() => window.__khora.setHoldYaw(Math.PI));
      await page.waitForTimeout(+(process.env.HOLDWAIT || 30000));
      await shot('back');
    }
  }
  await browser.close();
})();
