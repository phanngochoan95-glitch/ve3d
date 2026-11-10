// Test V1.23 — K6 phase 2: vùng mái đa giác vẽ tay (state, cổng insideRoof, tắt chuỗi ngoài,
// persistence/share, payload roofAreaM2, bản vẽ 2D có tô đa giác)
// Chạy: node tools/test-v123.mjs  (tự chứa: http server 8131 + Chrome headless CDP, profile mới mỗi lần)
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

server.listen(8131, '127.0.0.1', async () => {
  try {
    const chromeProc = spawn(findChrome(), [
      '--headless=new', '--remote-debugging-port=9458',
      '--user-data-dir=' + process.env.TEMP + '\\solar3d_v123_profile_' + Date.now(), '--window-size=1360,920',
      '--disable-gpu', '--no-first-run', 'http://127.0.0.1:8131/?from=vcc&dir=180&kwp=25&roof=ton&w=9&l=11',
    ]);
    await new Promise(r => setTimeout(r, 2000));
    let data = null;
    for (let i = 0; i < 10; i++) {
      try { data = await (await fetch('http://127.0.0.1:9458/json/list')).json(); if (Array.isArray(data)) break; } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!data) throw new Error('CDP endpoint không phản hồi sau 10s');
    const target = data.find(t => t.type === 'page' && t.url.includes('8131'));
    if (!target) throw new Error('page not found');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 1; const pending = new Map();
    ws.onmessage = (msg) => { const res = JSON.parse(msg.data); if (res.id && pending.has(res.id)) { pending.get(res.id)(res); pending.delete(res.id); } };
    await new Promise(r => ws.onopen = r);
    const send = (method, params = {}) => new Promise(resolve => { const curId = id++; pending.set(curId, resolve); ws.send(JSON.stringify({ id: curId, method, params })); });
    await send('Page.enable'); await send('Runtime.enable');
    const waitSolar = async () => {
      for (let i = 0; i < 30; i++) {
        const chk = await send('Runtime.evaluate', { expression: 'typeof window.__solar !== "undefined" && !!window.__solar.state' });
        if (chk.result?.result?.value === true) return true;
        await new Promise(r => setTimeout(r, 500));
      }
      return false;
    };
    await waitSolar();
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r.exceptionDetails) return { __exc: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
      return r.result.result.value;
    };
    const shot = async (name) => {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(ROOT + 'tools\\' + name, Buffer.from(s.result.data, 'base64'));
    };

    const r = {};
    const L_SHAPE = '[{x:-4.5,z:-5.5},{x:4.5,z:-5.5},{x:4.5,z:0},{x:0,z:0},{x:0,z:5.5},{x:-4.5,z:5.5}]'; // literal mảng nhúng thẳng vào biểu thức eval

    // ===== 1. Hồi quy: không đa giác — 9×11 tôn auto-fill = 36 tấm như cũ =====
    r.t1_noPoly36 = await evalJs(`(function(){
      const s = window.__solar;
      document.getElementById("autoBtn").click();
      return JSON.stringify({ panels: s.state.strings.reduce((a, st) => a + s.placedPanels(st), 0), poly: s.state.roofPoly });
    })()`);

    // ===== 2. polyAreaM2 chữ L = 74.25 m² (9×5.5 + 4.5×5.5) =====
    r.t2_area = await evalJs(`JSON.stringify({ area: +window.__solar.polyAreaM2(${L_SHAPE}).toFixed(2), expect: 74.25 })`);

    // ===== 3. Áp đa giác khi ĐÃ có Layout 36 tấm → chuỗi trong vùng cắt bị TẮT =====
    r.t3_applyDisables = await evalJs(`(function(){
      const s = window.__solar;
      const ok = s.applyRoofPoly(${L_SHAPE});
      const strings = s.state.strings;
      const offStrings = strings.filter(st => Array.isArray(st.disabled) && st.disabled.length > 0).length;
      const placed = strings.reduce((a, st) => a + s.placedPanels(st), 0);
      return JSON.stringify({ ok, nStrings: strings.length, offStrings, placed, reduced: placed < 36 });
    })()`);

    // ===== 4. Xoá sạch + auto-fill lại → mọi chuỗi có TÂM nằm trong đa giác, số tấm giảm hợp lý =====
    r.t4_refillInside = await evalJs(`(function(){
      const s = window.__solar;
      s.applyState({ ...s.collectState(), strings: [] });
      s.buildHouse();
      document.getElementById("autoBtn").click();
      const strings = s.state.strings;
      let allInside = true;
      for (const st of strings) {
        const slope = s.getSlopes().find(k => k.key === st.slopeKey);
        if (!slope) continue;
        // tâm chuỗi (slope-local) quy về toạ độ nhà rồi thử điểm-in-đa giác
        const hx = slope.origin.x + slope.u.x * st.cx + slope.v.x * st.cy;
        const hz = slope.origin.z + slope.u.z * st.cx + slope.v.z * st.cy;
        if (!s.pointInPoly(hx, hz, s.state.roofPoly)) allInside = false;
      }
      const placed = strings.reduce((a, st) => a + s.placedPanels(st), 0);
      return JSON.stringify({ nStrings: strings.length, placed, allInside, inRange: placed >= 10 && placed < 36 });
    })()`);

    // ===== 5. Persistence: collectState → applyState roundtrip + shareURL có roofPoly =====
    r.t5_persist = await evalJs(`(function(){
      const s = window.__solar;
      const saved = s.collectState();
      const kept = JSON.stringify(saved.roofPoly) === JSON.stringify(s.state.roofPoly);
      s.applyState({ ...saved, strings: saved.strings }); // đổ lại chính nó
      const after = JSON.stringify(s.state.roofPoly) === JSON.stringify(saved.roofPoly);
      const url = s.shareURL();
      const hashPart = decodeURIComponent(url.split("#d=")[1] || "");
      return JSON.stringify({ kept, after, shareHasPoly: hashPart.includes("roofPoly") });
    })()`);

    // ===== 6. Payload VCC có roofAreaM2 = 74.3 (đa giác) thay vì 99 (W×L) =====
    r.t6_payload = await evalJs(`JSON.stringify({ url: window.__solar.getBaoGiaUrl().match(/roofAreaM2=([\\d.]+)/)?.[1], expect: "74.3" })`);

    // ===== 7. Bỏ đa giác → auto-fill về đủ 36 tấm =====
    r.t7_clearBack36 = await evalJs(`(function(){
      const s = window.__solar;
      s.applyRoofPoly(null);
      s.applyState({ ...s.collectState(), strings: [] });
      s.buildHouse();
      document.getElementById("autoBtn").click();
      return JSON.stringify({ poly: s.state.roofPoly, panels: s.state.strings.reduce((a, st) => a + s.placedPanels(st), 0) });
    })()`);

    // ===== 8. Ảnh minh chứng: bản vẽ 2D có tô đa giác =====
    r.t8_planCanvas = await evalJs(`(function(){
      const s = window.__solar;
      const ok = s.applyRoofPoly(${L_SHAPE});
      const c = s.renderPlanCanvas();
      return JSON.stringify({ ok, bytes: c.toDataURL("image/png").length, drawable: c.width > 0 });
    })()`);
    await shot('screenshot_v123.png');
    const planUrl = await evalJs(`window.__solar.renderPlanCanvas().toDataURL("image/png")`);
    if (typeof planUrl === "string" && planUrl.startsWith("data:image/png")) {
      fs.writeFileSync(ROOT + 'tools\\screenshot_plan_poly_v123.png', Buffer.from(planUrl.split(',')[1], 'base64'));
    }

    console.log(JSON.stringify(r, null, 2));
    ws.close(); chromeProc.kill(); server.close();
  } catch (e) {
    console.error('TEST ERROR:', e.message || e);
    try { server.close(); } catch {}
    process.exit(1);
  }
});
