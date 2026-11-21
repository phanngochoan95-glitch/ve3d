// Đánh giá 2 vai V4 — đo trực tiếp trên LIVE https://ve3d.onrender.com (không server local).
// Phương pháp như V3: drive bằng API window.__solar, đo geometry/scene (không tin screenshot).
// Chạy: node tools/evaluate-v4-live.mjs  (Chrome headless CDP, profile mới mỗi lần)
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const LIVE = 'https://ve3d.onrender.com/';

function findChrome() {
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return cands.find(p => fs.existsSync(p));
}

async function main() {
  const chromeProc = spawn(findChrome(), [
    '--headless=new', '--remote-debugging-port=9462',
    '--user-data-dir=' + process.env.TEMP + '\\solar3d_evalv4_profile_' + Date.now(), '--window-size=1360,920',
    '--disable-gpu', '--no-first-run', LIVE,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  chromeProc.stderr.on('data', () => {});
  let data = null;
  for (let i = 0; i < 25; i++) {
    try { data = await (await fetch('http://127.0.0.1:9462/json/list')).json(); if (Array.isArray(data)) break; } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!data) throw new Error('CDP không phản hồi');
  const target = data.find(t => t.type === 'page' && t.url.includes('ve3d'));
  if (!target) throw new Error('page not found');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 1; const pending = new Map();
  ws.onmessage = (msg) => { const res = JSON.parse(msg.data); if (res.id && pending.has(res.id)) { pending.get(res.id)(res); pending.delete(res.id); } };
  await new Promise(r => ws.onopen = r);
  const send = (method, params = {}) => new Promise(resolve => { const curId = id++; pending.set(curId, resolve); ws.send(JSON.stringify({ id: curId, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval exception: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    return r.result.result.value;
  };
  const evalJson = async (expr) => {
    const v = await evalJs(expr);
    if (typeof v !== 'string') throw new Error('eval không trả JSON — expr: ' + expr.slice(0, 100));
    return JSON.parse(v);
  };
  const waitSolar = async () => {
    for (let i = 0; i < 40; i++) {
      if (await evalJs('typeof window.__solar !== "undefined" && !!window.__solar.state') === true) return true;
      await new Promise(r => setTimeout(r, 700));
    }
    return false;
  };
  const ready = await waitSolar();
  if (!ready) throw new Error('app chưa sẵn sàng trên LIVE');
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('C:\\Users\\Hoanpn\\My Drive\\3D Thiết kế\\solar-3d-simulator\\tools\\' + name, Buffer.from(s.result.data, 'base64'));
  };
  let pass = 0; const out = [];
  const check = (name, ok, detail = '') => { out.push((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' — ' + detail : '')); if (ok) pass++; };

  // ===== A. Live integrity: marker của các nhịp hôm nay =====
  const live = await evalJson(`JSON.stringify({
    vendor: !!document.querySelector('link[rel="preconnect"]') || [...document.querySelectorAll('script[type="importmap"]')].some(s => s.textContent.includes('./vendor/three')),
    veilGone: !document.getElementById('loadingVeil') || document.getElementById('loadingVeil').classList.contains('done'),
    focusCSS: [...document.styleSheets].some(ss => { try { return [...ss.cssRules].some(r => r.selectorText && r.selectorText.includes(':focus-visible')); } catch { return false; } }),
    reducedMotion: [...document.styleSheets].some(ss => { try { return [...ss.cssRules].some(r => r.media && (r.media.mediaText || '').includes('prefers-reduced-motion')); } catch { return false; } }),
    metaDesc: !!document.querySelector('meta[name="description"]'),
    clearTarget: typeof window.clearTargetKwp === 'function',
    sunPathAPI: typeof window.__solar.sunPathGroup === 'function'
  })`);
  check('A. Live có đủ marker các nhịp hôm nay (vendor/veil/focus/reduced-motion/meta/clearTarget/sunPath)',
    live.vendor && live.veilGone && live.focusCSS && live.reducedMotion && live.metaDesc && live.clearTarget && live.sunPathAPI, JSON.stringify(live));

  // ===== B. Geometry regression trên live: pháp tuyến NAM 4 góc + số tấm =====
  const setup = (roof, mount) => evalJs(`(function(){
    const S = window.__solar;
    S.applyState({ ...S.collectState(), roofType: ${JSON.stringify(roof)}, mount: ${JSON.stringify(mount)}, strings: [], targetKwp: null });
    S.buildHouse();
    document.getElementById('autoBtn').click();
    return true;
  })()`);
  const normals4 = {};
  for (const ang of [0, 90, 180, 270]) {
    await evalJs(`(function(){
      const S = window.__solar;
      S.applyState({ ...S.collectState(), roofType: 'bang', mount: 'khungsat', houseAngle: ${ang}, strings: [] });
      S.buildHouse();
      S.houseGroup.rotation.y = ${ang} * Math.PI / 180; // buildHouse KHÔNG đặt rotation — bắt buộc đặt bằng tay (bài học V3)
      document.getElementById('autoBtn').click();
      return true;
    })()`);
    normals4[ang] = await evalJson(`(function(){
      const S = window.__solar;
      S.scene.updateMatrixWorld(true);
      let bad = 0, total = 0; const v = new S.THREE.Vector3();
      for (const st of S.state.strings) {
        if (!st.group) continue;
        S.houseGroup.traverse(o => {
          if (!o.isMesh || o.userData.stringId !== st.id || !Array.isArray(o.material)) return;
          o.getWorldDirection(v); total++;
          if (!(Math.abs(v.x) < 0.05 && Math.abs(v.y - 0.966) < 0.02 && Math.abs(v.z - 0.259) < 0.02)) bad++;
        });
      }
      return JSON.stringify({ panels: total, bad });
    })()`);
  }
  check('B. Khung mái bằng pin NAM 4 góc nhà trên LIVE (bad=0, 28 tấm/góc)',
    Object.values(normals4).every(n => n.panels === 28 && n.bad === 0), JSON.stringify(normals4));

  // ===== C. Hồi quy số tấm 5 mái × 2 lắp =====
  const expect = { 'ton/apmai': 36, 'ton/khungsat': 36, 'ngoi/apmai': 36, 'ngoi/khungsat': 36, 'nhat/apmai': 14, 'nhat/khungsat': 14, 'bang/apmai': 28, 'bang/khungsat': 28, 'hai_doc_bang/apmai': 26, 'hai_doc_bang/khungsat': 26 };
  const counts = {};
  for (const roof of ['ton', 'ngoi', 'nhat', 'bang', 'hai_doc_bang']) {
    for (const mount of ['apmai', 'khungsat']) {
      await setup(roof, mount);
      counts[roof + '/' + mount] = await evalJs(`(function(){ const S = window.__solar; S.houseGroup.rotation.y = S.state.houseAngle * Math.PI / 180; return S.state.strings.reduce((a, s) => a + S.placedPanels(s), 0); })()`);
    }
  }
  check('C. Hồi quy số tấm 5 mái × 2 lắp trên LIVE (36/36/14/28/26)', JSON.stringify(counts) === JSON.stringify(expect), JSON.stringify(counts));

  // ===== D. BOM spot-check 2 cấu hình =====
  await evalJs(`(function(){ const S = window.__solar; S.applyState({ ...S.collectState(), roofType: 'ton', mount: 'khungsat', strings: [] }); S.buildHouse(); document.getElementById('autoBtn').click(); return true; })()`);
  const bomTon = await evalJson(`JSON.stringify(window.__solar.state.strings.length ? (function(){ const b = (function(){ try { return window.__solar; } catch { return null; } })(); return null; })() : null)`);
  // dùng renderRackBOM DOM để đọc khối lượng (ổn định, không cần expose calcRackBOM)
  const bomTonDom = await evalJson(`(function(){
    document.querySelectorAll('#rackControls table td:last-child');
    return JSON.stringify({
      rail: document.getElementById('bomRail3x6') ? document.getElementById('bomRail3x6').textContent : '',
      cot: document.getElementById('bomCotD') ? document.getElementById('bomCotD').textContent : ''
    });
  })()`);
  await evalJs(`(function(){ const S = window.__solar; S.applyState({ ...S.collectState(), roofType: 'bang', mount: 'khungsat', strings: [] }); S.buildHouse(); document.getElementById('autoBtn').click(); return true; })()`);
  const bomBangDom = await evalJson(`(function(){
    return JSON.stringify({
      rail: document.getElementById('bomRail3x6').textContent,
      cot: document.getElementById('bomCotD').textContent
    });
  })()`);
  check('D. BOM live khớp chuẩn (tôn khungsat rail≈97.7/cot=0 · bằng khungsat rail≈73.4/cot=18m)',
    bomTonDom.rail.indexOf('97.7') >= 0 && bomTonDom.cot.indexOf('0 m') === 0 && bomBangDom.rail.indexOf('73.4') >= 0 && bomBangDom.cot.indexOf('18') === 0,
    'tôn=' + bomTonDom.rail + '/' + bomTonDom.cot + ' · bằng=' + bomBangDom.rail + '/' + bomBangDom.cot);

  // ===== E. Che bóng quỹ đạo (weighted) trên live =====
  const shade = await evalJson(`(function(){
    const S = window.__solar;
    const tum = S.getTumPos(S.state.houseW, S.state.houseL, S.state.tumW, S.state.tumL);
    S.applyState({
      ...S.collectState(), roofType: 'bang', mount: 'apmai', houseAngle: 0, showTumThang: true, showBonNuoc: false, showTuongBao: false, targetKwp: null,
      strings: [{ slopeKey: 'bang', count: 6, dir: 'doc', rot: 0, cx: +(tum.x || 0).toFixed(2), cy: +(tum.z || 0).toFixed(2), disabled: [] }]
    });
    S.buildHouse(); S.refreshAll();
    const t0 = performance.now();
    const v = S.calcShadingLossPct();
    const ms = Math.round(performance.now() - t0);
    return JSON.stringify({ v, ms, angle: S.state.houseAngle });
  })()`);
  check('E. Che bóng quỹ đạo trọng số năng lượng trên LIVE (chuỗi đè tum ~27.2%, houseAngle 0)', Math.abs(shade.v - 27.2) < 0.5 && shade.angle === 0, 'v=' + shade.v + ' (' + shade.ms + 'ms, angle=' + shade.angle + ')');

  // ===== F. Perf probe: kéo slider hướng nhà CÓ VẬT CẢN (mỗi tick invalidate cache shading) =====
  const tickMs = await evalJson(`(function(){
    const S = window.__solar;
    S.applyState({ ...S.collectState(), roofType: 'bang', mount: 'apmai', houseAngle: 0, showTumThang: true, showBonNuoc: true, showTuongBao: true, targetKwp: null, strings: [] });
    S.buildHouse();
    document.getElementById('autoBtn').click(); // 28 tấm — mái bằng đầy + 3 loại vật cản
    const times = [];
    for (let a = 91; a <= 100; a++) {
      const t0 = performance.now();
      S.state.houseAngle = a;
      S.houseGroup.rotation.y = a * Math.PI / 180;
      (window.__solar.refreshAll)(); // renderSummary bên trong → calcShadingLossPct recompute (houseAngle trong signature)
      times.push(performance.now() - t0);
    }
    return JSON.stringify({ avg: Math.round(times.reduce((x, y) => x + y, 0) / times.length), max: Math.round(Math.max(...times)) });
  })()`);
  check('F. Perf tick hướng nhà CÓ vật cản (28 tấm + refreshAll + shading recompute 13 giờ) avg < 60ms', tickMs.avg < 60, JSON.stringify(tickMs) + ' (P2 nếu >60, P3 nếu 30-60)');

  // ===== G. Shortfall + poly + sun path (tính năng mới trên live) — tách bước nhỏ =====
  await evalJs(`(function(){
    const S = window.__solar;
    S.applyState({ ...S.collectState(), roofType: 'nhat', mount: 'apmai', strings: [], targetKwp: 10 });
    S.buildHouse(); S.refreshAll();
    document.getElementById('autoBtn').click();
    return true;
  })()`);
  const shortTxt = await evalJs('document.getElementById("summary").textContent');
  const shortOk = shortTxt.includes('Mục tiêu 10 kWp — mới đạt') && shortTxt.includes('Bỏ mục tiêu');
  await evalJs('window.clearTargetKwp()');
  const area = await evalJs(`(function(){
    const S = window.__solar;
    S.applyState({ ...S.collectState(), roofType: 'ton', strings: [], targetKwp: null });
    S.buildHouse(); S.refreshAll();
    document.getElementById('polyBtn').click();
    document.getElementById('polyRect').click();
    const m = document.getElementById('polyInfo').textContent.match(/([0-9.]+) m²/);
    document.getElementById('polyCancel').click();
    return m ? +m[1] : 0;
  })()`);
  const sunPath = await evalJson(`(function(){
    const S = window.__solar;
    const g = S.sunPathGroup();
    if (!g) return JSON.stringify({ err: 'none' });
    const dots = g.children.filter(c => c.isMesh && c.geometry.type === 'SphereGeometry');
    const sun = S.scene.children.find(o => o.isMesh && o.geometry.type === 'SphereGeometry' && o.material.color.getHex() === 0xffd54a);
    const a = sun.position.clone().normalize();
    let best = 0; for (const d of dots) best = Math.max(best, a.dot(d.position.clone().normalize()));
    return JSON.stringify({ sunDot: +best.toFixed(4), arcPts: g.children.filter(c => c.isLine)[0].geometry.attributes.position.count });
  })()`);
  const feat = { shortOk, area, sunDot: sunPath.sunDot, arcPts: sunPath.arcPts };
  check('G. Shortfall Nhật 10kWp cảnh báo + poly 115.6 m² + cung nắng 49 điểm trùng hướng mặt trời',
    feat.shortOk && feat.area > 110 && feat.area < 125 && feat.sunDot >= 0.999 && feat.arcPts >= 48, JSON.stringify(feat));

  // hover + focus ring + tween cancel
  await evalJs('window.__solar.setCameraView("front")');
  await new Promise(r => setTimeout(r, 1200));
  const hov = await evalJson(`(function(){
    try {
      const S = window.__solar;
      S.addString(); S.addString();
      const st = S.state.strings[0];
      let mesh = null; st.group.traverse(o => { if (!mesh && o.isMesh && o.userData.stringId === st.id) mesh = o; });
      const c = new S.THREE.Box3().setFromObject(mesh).getCenter(new S.THREE.Vector3());
      const v = c.project(S.camera);
      const el = S.renderer.domElement;
      const r = el.getBoundingClientRect();
      const x = Math.round(r.left + (v.x + 1) / 2 * r.width), y = Math.round(r.top + (1 - v.y) / 2 * r.height);
      el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, button: 0, buttons: 0 }));
      return JSON.stringify({ id: S.getHoverStringId(), cursor: S.renderer.domElement.style.cursor });
    } catch (e) { return JSON.stringify({ err: String(e && e.message || e) }); }
  })()`);
  check('H. Hover highlight chuỗi trên LIVE', hov.id !== null && hov.cursor === 'pointer', JSON.stringify(hov));
  await shot('screenshot_evalv4_hover.png');

  // ===== I. Screenshot cấu hình đầy đủ (tum + bồn + cung nắng + chuỗi) cho vai GĐ huyện =====
  const full = await evalJson(`(function(){
    const S = window.__solar;
    S.applyState({
      ...S.collectState(), roofType: 'hai_doc_bang', mount: 'apmai', houseAngle: 180, hour: 9,
      showTumThang: true, showBonNuoc: true, targetKwp: null, strings: []
    });
    S.buildHouse();
    S.houseGroup.rotation.y = Math.PI;
    document.getElementById('autoBtn').click();
    return JSON.stringify({ panels: S.state.strings.reduce((x, s) => x + S.placedPanels(s), 0) });
  })()`);
  check('I. Cảnh demo GĐ huyện: hai_doc_bang + tum + bồn + 9h sáng xếp được', full.panels >= 20, JSON.stringify(full));
  await shot('screenshot_evalv4_full.png');

  // ===== J. Mobile 390 =====
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await new Promise(r => setTimeout(r, 700));
  const mob = await evalJson(`JSON.stringify({
    fab: getComputedStyle(document.getElementById('fab')).display !== 'none',
    anim: getComputedStyle(document.getElementById('panel')).animationName,
    dirBtnFont: getComputedStyle(document.querySelector('.dir-btn')).fontSize,
    dirBtnH: Math.round(document.querySelector('.dir-btn').getBoundingClientRect().height)
  })`);
  check('J. Mobile: FAB hiện, panel không entrance, nút hướng nhà chạm được (chuẩn ≥44px → FAIL nếu <36)',
    mob.fab && (mob.anim === 'none' || mob.anim === '') && mob.dirBtnH >= 36, JSON.stringify(mob));
  await shot('screenshot_evalv4_mobile.png');
  await send('Emulation.clearDeviceMetricsOverride');

  // ===== K. Tab stops đầu tiên (a11y) =====
  await evalJs('document.body.focus && document.body.focus(); document.activeElement.blur && document.activeElement.blur();');
  const stops = [];
  for (let i = 0; i < 5; i++) {
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    stops.push(await evalJs(`(function(){ const el = document.activeElement; return (el.tagName || '') + (el.id ? '#' + el.id : '') + (el.matches(':focus-visible') ? ' fv' : ''); })()`));
    await new Promise(r => setTimeout(r, 60));
  }
  check('K. 5 Tab đầu đều :focus-visible', stops.length === 5 && stops.every(s => s.includes(' fv')), stops.join(' | '));

  console.log('=== ĐÁNH GIÁ V4 LIVE: ' + pass + '/' + out.length + ' PASS ===');
  for (const r of out) console.log(r);
}

main().then(() => process.exit(0)).catch((e) => { console.error('LỖI: ' + e.message); process.exit(1); });
