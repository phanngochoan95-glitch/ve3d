// Test Taste Phase 2 — focus ring a11y, reduced-motion CSS, entrance, select mũi tên,
// keyboard cho .opt / .string-item (Enter/Space), màu xám tương phản, meta head block.
// Chạy: node tools/test-taste2.mjs  (tự chứa: http server 8133 + Chrome headless CDP, profile mới)
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');

function findChrome() {
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return cands.find(p => fs.existsSync(p));
}

const server = http.createServer((req, res) => {
  const filePath = ROOT + 'index.html';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(filePath));
});

server.listen(8133, '127.0.0.1', async () => {
  let chromeProc = null; let failed = false;
  try {
    chromeProc = spawn(findChrome(), [
      '--headless=new', '--remote-debugging-port=9460',
      '--user-data-dir=' + process.env.TEMP + '\\solar3d_taste2_profile_' + Date.now(), '--window-size=1360,920',
      '--disable-gpu', '--no-first-run', 'http://127.0.0.1:8133/',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    chromeProc.stderr.on('data', () => {}); // nuốt log stderr, tránh buffer đầy
    chromeProc.on('error', (e) => console.error('spawn chrome lỗi: ' + e.message));
    await new Promise(r => setTimeout(r, 3000));
    let data = null;
    for (let i = 0; i < 20; i++) {
      try { data = await (await fetch('http://127.0.0.1:9460/json/list')).json(); if (Array.isArray(data)) break; } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!data) throw new Error('CDP endpoint không phản hồi sau 10s');
    const target = data.find(t => t.type === 'page' && t.url.includes('8133'));
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
      if (typeof v !== 'string') throw new Error('eval không trả JSON, nhận: ' + typeof v + ' ' + JSON.stringify(v)?.slice(0, 200));
      return JSON.parse(v);
    };
    const waitSolar = async () => {
      for (let i = 0; i < 30; i++) {
        const chk = await evalJs('typeof window.__solar !== "undefined" && !!window.__solar.state');
        if (chk === true) return true;
        await new Promise(r => setTimeout(r, 500));
      }
      return false;
    };
    if (!await waitSolar()) throw new Error('app chưa sẵn sàng');
    const shot = async (name) => {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(ROOT + 'tools\\' + name, Buffer.from(s.result.data, 'base64'));
    };
    const pressTab = async () => {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await new Promise(r => setTimeout(r, 120));
    };

    let pass = 0; const results = [];
    const check = (name, ok, detail = '') => { results.push((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' — ' + detail : '')); if (ok) pass++; };

    // ===== 1. Head block (description/theme-color/OG/favicon) =====
    const head = await evalJson(`JSON.stringify({
      desc: !!document.querySelector('meta[name="description"]'),
      theme: document.querySelector('meta[name="theme-color"]')?.content || '',
      og: !!document.querySelector('meta[property="og:title"]'),
      icon: (document.querySelector('link[rel="icon"]')?.href || '').startsWith('data:image/svg')
    })`);
    check('meta description + theme-color + og + favicon', head.desc && head.theme === '#1473e6' && head.og && head.icon);

    // ===== 2. CSS phase 2 có trong document.styleSheets =====
    const css = await evalJson(`JSON.stringify({
      focusVisible: [...document.styleSheets].some(ss => { try { return [...ss.cssRules].some(r => r.selectorText && r.selectorText.includes(':focus-visible')); } catch { return false; } }),
      reducedMotion: [...document.styleSheets].some(ss => { try { return [...ss.cssRules].some(r => r.media && (r.media.mediaText || '').includes('prefers-reduced-motion')); } catch { return false; } }),
      panelAnim: getComputedStyle(document.getElementById('panel')).animationName,
      overlayAnim: getComputedStyle(document.querySelector('.house-dir-overlay')).animationName,
      selectNone: getComputedStyle(document.getElementById('designSelect')).appearance,
      noticeAnim: getComputedStyle(document.getElementById('notice')).animationName
    })`);
    check('rule :focus-visible tồn tại', css.focusVisible);
    check('media prefers-reduced-motion tồn tại', css.reducedMotion);
    check('panel có animation entrance (desktop)', css.panelAnim === 'taste-panel-in', css.panelAnim);
    check('overlay entrance fade-down', css.overlayAnim === 'taste-fade-down', css.overlayAnim);
    check('select appearance:none + mũi tên tự vẽ', css.selectNone === 'none', css.selectNone);
    check('notice animation pop', css.noticeAnim === 'taste-pop', css.noticeAnim);

    // ===== 3. Tab qua bàn phím → focus ring hiển thị thật (:focus-visible) =====
    await evalJs('document.activeElement && document.activeElement.blur(); document.body.focus && document.body.focus();');
    await pressTab(); await pressTab(); await pressTab();
    const focusInfo = await evalJson(`JSON.stringify({
      tag: document.activeElement.tagName,
      id: document.activeElement.id || '',
      fv: document.activeElement.matches(':focus-visible'),
      outline: getComputedStyle(document.activeElement).outlineStyle
    })`);
    check('Tab → :focus-visible active + outline vẽ', focusInfo.fv && focusInfo.outline !== 'none', focusInfo.tag + '#' + focusInfo.id + ' outline=' + focusInfo.outline);

    // ===== 4. Keyboard .opt: Enter trên "Có khung sắt" → đổi mount =====
    const optState = await evalJson(`JSON.stringify({
      tabs: [...document.querySelectorAll('#mountOptions .opt')].map(o => o.tabIndex === 0 && o.getAttribute('role') === 'button'),
      stringItemRole: !!document.querySelector('.string-item') === false ? 'no-item' : 'skip'
    })`);
    check('mount .opt tabindex+role', optState.tabs.length === 2 && optState.tabs.every(Boolean));
    const mountBefore = await evalJs('window.__solar.state.mount');
    const enterResult = await evalJson(`(function(){
      const opts = document.querySelectorAll('#mountOptions .opt');
      const target = [...opts].find(o => o.dataset.v === 'khungsat');
      target.focus();
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      const s = window.__solar;
      return JSON.stringify({
        mount: s.state.mount,
        rackShown: document.getElementById('rackControls').style.display !== 'none'
      });
    })()`);
    check('Enter trên .opt đổi mount sang khungsat + mở rackControls', mountBefore === 'apmai' && enterResult.mount === 'khungsat' && enterResult.rackShown, mountBefore + '→' + enterResult.mount);
    // trả lại apmai
    await evalJs(`(function(){ const s = window.__solar; s.applyState({ ...s.collectState(), mount: 'apmai' }); s.buildHouse(); s.refreshAll ? s.refreshAll() : null; return s.state.mount; })()`);

    // ===== 5. Màu xám tương phản đã thay hết =====
    const grey = await evalJson(`JSON.stringify({
      old: ['#8c9ba5', '#6b7c8c', '#718096', '#7a8a99', '#6b7785'].map(c => document.querySelectorAll('[style*="' + c + '"]').length)
    })`);
    check('hết màu xám kém tương phản (đổi #64748b)', grey.old.every(n => n === 0));

    // ===== 6. Checkbox + nút inline có micro-interaction =====
    const micro = await evalJson(`JSON.stringify({
      cbTrans: getComputedStyle(document.getElementById('setbackCheck')).transitionDuration,
      tiltTrans: getComputedStyle(document.getElementById('optTiltBtn')).transitionDuration
    })`);
    check('checkbox + optTiltBtn có transition', parseFloat(micro.cbTrans) > 0 && parseFloat(micro.tiltTrans) > 0);

    // ===== 6b. Loading veil: CSS tồn tại + tự ẩn sau frame đầu =====
    const veil = await evalJson(`JSON.stringify({
      gone: !document.getElementById('loadingVeil') || document.getElementById('loadingVeil').classList.contains('done'),
      css: [...document.styleSheets].some(ss => { try { return [...ss.cssRules].some(r => (r.selectorText || '').includes('.loading-veil')); } catch { return false; } })
    })`);
    check('loading veil có CSS + tự ẩn sau frame đầu', veil.css && veil.gone);

    // ===== 6c. Camera preset bay mượt: có chuyển động giữa chừng + đến đúng đích =====
    const poseTop = await evalJson('(function(){ const p = window.__solar.cameraPoseFor("top"); return JSON.stringify({ y: +p.pos.y.toFixed(2), z: +p.pos.z.toFixed(2) }); })()');
    await evalJs('window.__solar.setCameraView("top")');
    let midFly = null;
    for (let k = 0; k < 3 && (midFly === null || Math.abs(midFly.y - poseTop.y) <= 3); k++) {
      await new Promise(r => setTimeout(r, 120));
      midFly = await evalJson('(function(){ const c = window.__solar.camera.position; return JSON.stringify({ y: +c.y.toFixed(2) }); })()');
    }
    await new Promise(r => setTimeout(r, 1400));
    const finFly = await evalJson('(function(){ const c = window.__solar.camera.position; return JSON.stringify({ y: +c.y.toFixed(2), z: +c.z.toFixed(2) }); })()');
    check('camera bay tới đúng đích preset top', Math.abs(finFly.y - poseTop.y) < 0.6 && Math.abs(finFly.z - poseTop.z) < 0.6, 'fin=' + finFly.y + '/' + finFly.z + ' dich=' + poseTop.y + '/' + poseTop.z);
    check('camera bay có chuyển động giữa chừng (không nhảy tức thời)', Math.abs(midFly.y - finFly.y) > 3, 'mid y=' + midFly.y + ' fin y=' + finFly.y);

    // ===== 6d. User chạm canvas → huỷ tween giữa chừng (không giành camera) =====
    await evalJs('window.__solar.setCameraView("iso")');
    await new Promise(r => setTimeout(r, 200));
    await evalJs(`(function(){ const el = window.__solar.renderer.domElement; const r = el.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: 1 }; el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new PointerEvent('pointermove', o)); el.dispatchEvent(new PointerEvent('pointerup', o)); return true; })()`);
    await new Promise(r => setTimeout(r, 900));
    const frozen = await evalJson('(function(){ const p = window.__solar.cameraPoseFor("iso"); const c = window.__solar.camera.position; return JSON.stringify({ dy: +(c.y - p.pos.y).toFixed(2), dz: +(c.z - p.pos.z).toFixed(2) }); })()');
    check('user chạm canvas huỷ tween (đứng giữa chừng)', Math.abs(frozen.dy) > 0.5, 'dy=' + frozen.dy);

    // ===== 6e. Hover highlight chuỗi pin =====
    await evalJs('window.__solar.setCameraView("front")');
    await new Promise(r => setTimeout(r, 1300));
    await evalJs('window.__solar.addString()');
    await evalJs('window.__solar.addString()'); // chuỗi 2 được auto-chọn → hover chuỗi 1 để thấy khung amber
    const stInfo = await evalJson(`(function(){
      const S = window.__solar; const st = S.state.strings[0];
      if (!st || !st.group) return JSON.stringify({ err: 'no-string' });
      let mesh = null;
      st.group.traverse(o => { if (!mesh && o.isMesh && o.userData.stringId === st.id) mesh = o; });
      if (!mesh) return JSON.stringify({ err: 'no-mesh' });
      const c = new S.THREE.Box3().setFromObject(mesh).getCenter(new S.THREE.Vector3());
      const v = c.project(S.camera);
      const r = S.renderer.domElement.getBoundingClientRect();
      return JSON.stringify({ id: st.id, n: S.state.strings.length, x: Math.round(r.left + (v.x + 1) / 2 * r.width), y: Math.round(r.top + (1 - v.y) / 2 * r.height), z: +v.z.toFixed(2) });
    })()`);
    check('addString đặt 2 chuỗi cho test hover', !stInfo.err && stInfo.n >= 2 && stInfo.z < 1, JSON.stringify(stInfo).slice(0, 80));
    await evalJs(`(function(){ const el = window.__solar.renderer.domElement; el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: ${stInfo.x}, clientY: ${stInfo.y}, button: 0, buttons: 0 })); return true; })()`);
    await new Promise(r => setTimeout(r, 160));
    const hov = await evalJson(`JSON.stringify({ id: window.__solar.getHoverStringId(), cursor: window.__solar.renderer.domElement.style.cursor, box: window.__solar.hoverBoxVisible() })`);
    check('hover chuỗi → khung amber + cursor pointer', hov.id === stInfo.id && hov.cursor === 'pointer' && hov.box === true, 'id=' + hov.id + ' cursor=' + hov.cursor + ' box=' + hov.box);
    await shot('screenshot_taste2_desktop.png');
    await evalJs(`(function(){ const el = window.__solar.renderer.domElement; const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: r.left + 2, clientY: r.top + 2, button: 0, buttons: 0 })); return true; })()`);
    await new Promise(r => setTimeout(r, 160));
    const hovOff = await evalJson('JSON.stringify({ id: window.__solar.getHoverStringId() })');
    check('rời chuỗi → hết highlight', hovOff.id === null);

    // ===== 6f. Cung đường mặt trời 6h→18h =====
    const sp = await evalJson(`(function(){
      const g = window.__solar.sunPathGroup();
      if (!g) return JSON.stringify({ err: 'none' });
      const arcs = g.children.filter(c => c.isLine);
      const sprites = g.children.filter(c => c.isSprite);
      const dots = g.children.filter(c => c.isMesh && c.geometry.type === 'SphereGeometry');
      return JSON.stringify({ visible: g.visible, lines: arcs.length, pts: arcs[0] ? arcs[0].geometry.attributes.position.count : 0, sprites: sprites.length, dots: dots.length, flag: !!g.userData.isSunPath });
    })()`);
    check('cung nắng: 1 line ≥48 điểm + 3 nhãn + 3 mốc + flag ẩn xuất', sp.lines === 1 && sp.pts >= 48 && sp.sprites === 3 && sp.dots === 3 && sp.flag && sp.visible, JSON.stringify(sp));
    const sunAlign = await evalJson(`(function(){
      const S = window.__solar;
      const sun = S.scene.children.find(o => o.isMesh && o.geometry.type === 'SphereGeometry' && o.material.color && o.material.color.getHex() === 0xffd54a);
      if (!sun) return JSON.stringify({ err: 'no-sun' });
      const dots = S.sunPathGroup().children.filter(c => c.isMesh && c.geometry.type === 'SphereGeometry');
      const a = sun.position.clone().normalize();
      let best = 0;
      for (const d of dots) best = Math.max(best, a.dot(d.position.clone().normalize()));
      return JSON.stringify({ best: +best.toFixed(4) });
    })()`);
    check('mốc giờ trên cung trùng hướng mặt trời (dot ≥ 0.999)', sunAlign.best >= 0.999, JSON.stringify(sunAlign));

    await shot('screenshot_taste2_hover.png');

    // ===== 7. Mobile 390: panel entrance KHÔNG chạy (không phá bottom-sheet) =====
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await new Promise(r => setTimeout(r, 600));
    const mob = await evalJson(`JSON.stringify({
      anim: getComputedStyle(document.getElementById('panel')).animationName,
      sheet: getComputedStyle(document.getElementById('panel')).position
    })`);
    check('mobile: panel không animation (không phá sheet)', mob.anim === 'none' || mob.anim === '', 'anim=' + mob.anim + ' pos=' + mob.sheet);
    await shot('screenshot_taste2_mobile.png');
    await send('Emulation.clearDeviceMetricsOverride');

    console.log('=== KẾT QUẢ test-taste2: ' + pass + '/' + results.length + ' PASS ===');
    for (const r of results) console.log(r);
    if (pass !== results.length) failed = true;
  } catch (err) {
    failed = true;
    console.error('LỖI: ' + (err && err.message || err));
  } finally {
    try { if (chromeProc && chromeProc.pid) { await fetch('http://127.0.0.1:9460/json/close/' + (await (await fetch('http://127.0.0.1:9460/json/list')).json())[0].id).catch(() => {}); } } catch {}
    try { if (chromeProc) chromeProc.kill(); } catch {}
    server.close();
    process.exit(failed ? 1 : 0);
  }
});
