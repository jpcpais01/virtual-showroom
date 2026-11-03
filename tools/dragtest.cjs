// pulls the hero tee sideways and logs how the cloth follows: node tools/dragtest.cjs
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('http://127.0.0.1:5173/?auto&bench&nolock', { timeout: 120000 });
  await page.waitForFunction(() => window.__khora && !document.getElementById('enterActions').hidden, null, { timeout: 120000 });
  await page.evaluate(() => window.__khora.focus(window.__khora.hero));
  await page.waitForTimeout(2500);
  const log = await page.evaluate(() => new Promise((res) => {
    const K = window.__khora, t = K.hero, c = t.cloth;
    // pick the particle nearest the hem centre-front
    let best = 0, bd = 1e9; const hp = new K.camera.position.constructor().setFromMatrixPosition(t.hangerMatrix);
    for (let i = 0; i < c.n; i++) { const dx = c.pos[3*i]-hp.x, dy = c.pos[3*i+1]-(hp.y-0.45), dz = c.pos[3*i+2]-(hp.z+0.2); const d = dx*dx+dy*dy+dz*dz; if (d < bd) { bd = d; best = i; } }
    const p0 = new K.camera.position.constructor(c.pos[3*best], c.pos[3*best+1], c.pos[3*best+2]);
    t.grab(best, p0.clone());
    const out = []; const T0 = performance.now(); let resN = 0; const orig = t._onResult.bind(t); t._onResult = (r) => { resN++; orig(r); };
    const cen = () => { let x = 0, z = 0; for (let i = 0; i < c.n; i++) { x += c.pos[3*i]; z += c.pos[3*i+2]; } return [x / c.n, z / c.n]; };
    const c0 = cen();
    function f() {
      const s = (performance.now() - T0) / 1000;
      const k = Math.min(1, s / 0.3);
      t.drag(p0.clone().add(new K.camera.position.constructor(0.0, 0.0, 0.45 * k)));
      const [cx, cz] = cen();
      out.push([s.toFixed(2), K.stats().workerMs, (c.pos[3*best+2]-p0.z).toFixed(3), (cz - c0[1]).toFixed(3), resN]);
      if (s < 1.6) requestAnimationFrame(f); else { t.release(); res(out.filter((_, i) => i % 6 === 0)); }
    }
    f();
  }));
  for (const l of log) console.log(l.join('\t'));
  await browser.close();
})();
