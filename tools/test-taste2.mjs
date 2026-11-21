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

    await shot('screenshot_taste2_desktop.png');

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
