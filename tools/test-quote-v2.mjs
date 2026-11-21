// Test nhịp "số liệu báo giá thông minh hơn":
//  (1) Che bóng quét quỹ đạo 6→18h đông chí trọng số năng lượng (thay 3 mốc 9/12/15h)
//  (3) Cảnh báo shortfall kWp mục tiêu + chip đạt + Bỏ mục tiêu
//  (4) Poly editor hiện diện tích + sức chứa ước tính (cả chế độ ▭ Nguyên mái)
// Chạy: node tools/test-quote-v2.mjs  (tự chứa: http server 8134 + Chrome headless CDP, profile mới)
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
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(ROOT + 'index.html'));
});

server.listen(8134, '127.0.0.1', async () => {
  let chromeProc = null; let failed = false;
  try {
    chromeProc = spawn(findChrome(), [
      '--headless=new', '--remote-debugging-port=9461',
      '--user-data-dir=' + process.env.TEMP + '\\solar3d_quote2_profile_' + Date.now(), '--window-size=1360,920',
      '--disable-gpu', '--no-first-run', 'http://127.0.0.1:8134/',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    chromeProc.stderr.on('data', () => {});
    await new Promise(r => setTimeout(r, 3000));
    let data = null;
    for (let i = 0; i < 20; i++) {
      try { data = await (await fetch('http://127.0.0.1:9461/json/list')).json(); if (Array.isArray(data)) break; } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!data) throw new Error('CDP không phản hồi sau 20s');
    const target = data.find(t => t.type === 'page' && t.url.includes('8134'));
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
      if (typeof v !== 'string') throw new Error('eval không trả JSON: ' + typeof v + ' — expr: ' + expr.slice(0, 160));
      return JSON.parse(v);
    };
    const waitSolar = async () => {
      for (let i = 0; i < 30; i++) {
        if (await evalJs('typeof window.__solar !== "undefined" && !!window.__solar.state') === true) return true;
        await new Promise(r => setTimeout(r, 500));
      }
      return false;
    };
    if (!await waitSolar()) throw new Error('app chưa sẵn sàng');

    let pass = 0; const results = [];
    const check = (name, ok, detail = '') => { results.push((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' — ' + detail : '')); if (ok) pass++; };
    const summaryText = () => evalJs('document.getElementById("summary").textContent');

    // ===== (3) Shortfall kWp mục tiêu =====
    // T1a: Nhật 9×11 + mục tiêu 10 kWp → chỉ 14 tấm ≈ 8.68 kWp → cảnh báo thiếu + gợi ý + link Bỏ mục tiêu
    const t1a = await evalJson(`(function(){
      const S = window.__solar;
      S.applyState({ ...S.collectState(), roofType: 'nhat', mount: 'apmai', strings: [], targetKwp: 10 });
      S.buildHouse(); S.refreshAll();
      document.getElementById('autoBtn').click();
      const panels = S.state.strings.reduce((a, s) => a + S.placedPanels(s), 0);
      const txt = document.getElementById('summary').textContent;
      return JSON.stringify({ panels, hasShort: txt.includes('Mục tiêu 10 kWp — mới đạt'), hasGap: txt.includes('thiếu'), hasHint: txt.includes('giảm mép mái'), hasLink: txt.includes('Bỏ mục tiêu'), hasCap: txt.includes('Toàn mái tối đa') });
    })()`);
    check('T1a shortfall: Nhật 14 tấm < 17 tấm mục tiêu 10 kWp → cảnh báo đủ 4 phần', t1a.panels === 14 && t1a.hasShort && t1a.hasGap && t1a.hasHint && t1a.hasLink && t1a.hasCap, JSON.stringify(t1a));
    // T1b: Bỏ mục tiêu → hết cảnh báo (từng bước để chẩn đoán nếu lỗi)
    const fnSrc = await evalJs('String(window.clearTargetKwp).slice(0, 60)');
    console.log('   [probe] clearTargetKwp =', fnSrc);
    await evalJs('window.clearTargetKwp()');
    const txt1b = await evalJs('document.getElementById("summary").textContent');
    const stateNull = await evalJs('window.__solar.state.targetKwp === null');
    const t1b = { cleared: !txt1b.includes('Mục tiêu 10 kWp'), stateNull };
    check('T1b Bỏ mục tiêu → state.targetKwp null + summary sạch', t1b.cleared && t1b.stateNull);
    // T1c: tôn 9×11 mục tiêu 5.58 kWp → 36 tấm 22.32 kWp → chip ĐẠT
    const t1c = await evalJson(`(function(){
      const S = window.__solar;
      S.applyState({ ...S.collectState(), roofType: 'ton', mount: 'apmai', strings: [], targetKwp: 5.58 });
      S.buildHouse(); S.refreshAll();
      document.getElementById('autoBtn').click();
      const txt = document.getElementById('summary').textContent;
      return JSON.stringify({ panels: S.state.strings.reduce((a, s) => a + S.placedPanels(s), 0), met: txt.includes('Đạt mục tiêu 5.58 kWp ✓') });
    })()`);
    check('T1c đạt mục tiêu: tôn 36 tấm ≥ 5.58 kWp → chip xanh Đạt', t1c.panels === 36 && t1c.met, JSON.stringify(t1c));
    // T1d: mục tiêu khi chưa có chuỗi → dòng dẫn bấm Xếp tự động
    const t1d = await evalJson(`(function(){
      const S = window.__solar;
      S.applyState({ ...S.collectState(), strings: [], targetKwp: 8 });
      S.buildHouse(); S.refreshAll();
      const txt = document.getElementById('summary').textContent;
      return JSON.stringify({ guide: txt.includes('Mục tiêu 8 kWp') && txt.includes('Xếp tự động') });
    })()`);
    check('T1d mục tiêu khi mái trống → dòng dẫn bấm Xếp tự động', t1d.guide);

    // ===== (1) Che bóng quét quỹ đạo =====
    // T2a: có tum thang + chuỗi đặt ĐÈ gần tum → giá trị > 0 có trọng số
    const t2a = await evalJson(`(function(){
      const S = window.__solar;
      const tum = S.getTumPos(S.state.houseW, S.state.houseL, S.state.tumW, S.state.tumL);
      S.applyState({
        ...S.collectState(), roofType: 'bang', mount: 'apmai', showTumThang: true, showBonNuoc: false, showTuongBao: false,
        strings: [{ slopeKey: 'bang', count: 6, dir: 'doc', rot: 0, cx: +(tum.x || 0).toFixed(2), cy: +(tum.z || 0).toFixed(2), disabled: [] }]
      });
      S.buildHouse(); S.refreshAll();
      const nStr = S.state.strings.length;
      const v1 = S.calcShadingLossPct();
      const v2 = S.calcShadingLossPct(); // cache phải trả đúng giá trị cũ
      return JSON.stringify({ nStr, v1, cached: v1 === v2 });
    })()`);
    check('T2a che bóng quỹ đạo: chuỗi đè tum → ~% > 0 + cache khớp', t2a.nStr >= 1 && t2a.v1 > 0 && t2a.v1 <= 60 && t2a.cached, JSON.stringify(t2a));
    // T2b: không vật cản nào → 0
    const t2b = await evalJson(`(function(){
      const S = window.__solar;
      S.applyState({ ...S.collectState(), showTumThang: false, showBonNuoc: false, showTuongBao: false });
      S.buildHouse(); S.refreshAll();
      return JSON.stringify({ v: S.calcShadingLossPct() });
    })()`);
    check('T2b không vật cản → che bóng 0%', t2b.v === 0, 'v=' + t2b.v);

    // ===== (4) Poly editor: diện tích + sức chứa ước tính =====
    const t3 = await evalJson(`(function(){
      const S = window.__solar;
      S.applyState({ ...S.collectState(), roofType: 'ton', mount: 'apmai', strings: [] });
      S.buildHouse(); S.refreshAll();
      document.getElementById('polyBtn').click();
      document.getElementById('polyRect').click();
      const info = document.getElementById('polyInfo').textContent;
      const okFull = info.includes('Nguyên mái') && info.includes('m²') && info.includes('tấm (≈') && /[0-9]+(\.[0-9]+)? m²/.test(info);
      const m = info.match(/([0-9.]+) m²/); const area = m ? +m[1] : 0;
      document.getElementById('polyCancel').click();
      return JSON.stringify({ okFull, area, closed: document.getElementById('polyModal').style.display === 'none' });
    })()`);
    check('T3 poly ▭ Nguyên mái: hiện m² + sức chứa ước tính (tôn 9×11 ≈ 115.6 m²)', t3.okFull && t3.area > 110 && t3.area < 125 && t3.closed, JSON.stringify(t3));

    console.log('=== KẾT QUẢ test-quote-v2: ' + pass + '/' + results.length + ' PASS ===');
    for (const r of results) console.log(r);
    if (pass !== results.length) failed = true;
  } catch (err) {
    failed = true;
    console.error('LỖI: ' + (err && err.message || err));
  } finally {
    try { if (chromeProc) chromeProc.kill(); } catch {}
    server.close();
    process.exit(failed ? 1 : 0);
  }
});
