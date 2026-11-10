// Test V1.22 — hiệu chuẩn PVGIS (calcSolarFactor), K6 bản vẽ mặt bằng 2D, hợp đồng key mái PA3
// Chạy: node tools/test-v122.mjs  (tự chứa: http server 8128 + Chrome headless CDP, profile mới mỗi lần)
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

server.listen(8128, '127.0.0.1', async () => {
  try {
    const chromeProc = spawn(findChrome(), [
      '--headless=new', '--remote-debugging-port=9455',
      '--user-data-dir=' + process.env.TEMP + '\\solar3d_v122_profile_' + Date.now(), '--window-size=1360,920',
      '--disable-gpu', '--no-first-run', 'http://127.0.0.1:8128/',
    ]);
    await new Promise(r => setTimeout(r, 2000));
    let data = null;
    for (let i = 0; i < 10; i++) {
      try { data = await (await fetch('http://127.0.0.1:9455/json/list')).json(); if (Array.isArray(data)) break; } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!data) throw new Error('CDP endpoint không phản hồi sau 10s');
    const target = data.find(t => t.type === 'page' && t.url.includes('8128'));
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
        if (chk.result?.result?.value === true) return true; // đúng độ sâu kết quả CDP (chk.result.result.value)
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
    const navTo = async (query) => {
      await send('Page.navigate', { url: 'http://127.0.0.1:8128/' + query });
      return waitSolar();
    };
    const shot = async (name) => {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(ROOT + 'tools\\' + name, Buffer.from(s.result.data, 'base64'));
    };

    const r = {};

    // ===== 1. Hiệu chuẩn PVGIS: default houseAngle=0 (Bắc, tilt 26°) → ~0.819; Nam → ~0.963; khung sắt 15° Nam → ~0.98 =====
    r.t1_solarFactorPVGIS = await evalJs(`(function(){
      const s = window.__solar;
      const fDefault = s.calcSolarFactor(); // mặc định az=0 (Bắc), tilt=26 → PVGIS 83.9% − 2% ≈ 0.819
      s.state.houseAngle = 90;  const fEast  = s.calcSolarFactor(); // ~0.918
      s.state.houseAngle = 180; const fSouth = s.calcSolarFactor(); // ~0.963
      s.state.houseAngle = 270; const fWest  = s.calcSolarFactor(); // ~0.944
      s.applyState({ ...s.collectState(), mount: "khungsat", rackTilt: 15 });
      s.buildHouse();
      const fKhung = s.calcSolarFactor(); // khung sắt: az 180, tilt 15 → ~0.98
      s.applyState({ ...s.collectState(), mount: "apmai" });
      s.buildHouse();
      s.state.houseAngle = 180;
      return JSON.stringify({
        fDefault: +fDefault.toFixed(3), fEast: +fEast.toFixed(3), fSouth: +fSouth.toFixed(3), fWest: +fWest.toFixed(3), fKhung: +fKhung.toFixed(3),
        northNearPVGIS: fDefault > 0.78 && fDefault < 0.90,
        orderNorthEastSouth: fDefault < fEast && fEast < fSouth,
        southNearPVGIS: fSouth > 0.94 && fSouth <= 1.02,
        khungNearPVGIS: fKhung > 0.94 && fKhung <= 1.02
      });
    })()`);

    // ===== 2. K6: renderPlanCanvas trả canvas vẽ được (không trắng) =====
    r.t2_planCanvas = await evalJs(`(function(){
      const s = window.__solar;
      document.getElementById("autoBtn").click(); // có giàn pin để bản vẽ có nội dung
      const c = s.renderPlanCanvas();
      const data = c.toDataURL("image/png");
      return JSON.stringify({ w: c.width, h: c.height, bytes: data.length, drawable: data.length > 20000 });
    })()`);

    // ===== 3. K6: bộ snapshot giờ có 5 ảnh, ảnh cuối là bản vẽ mặt bằng =====
    r.t3_planInSnapshots = await evalJs(`(function(){
      const snaps = window.__solar.captureStandardSnapshots();
      const last = snaps[snaps.length - 1];
      return JSON.stringify({
        count: snaps.length,
        lastId: last.id,
        ok5: snaps.length === 5 && last.id === "snap_plan",
        okJpeg: typeof last.dataUrl === "string" && last.dataUrl.startsWith("data:image/jpeg")
      });
    })()`);

    // ===== 4. Hợp đồng key mái PA3 (chiều VCC→3D): flat / hai_doc_bang / key lạ =====
    r.t4a_roofFlat = (await navTo('?from=vcc&dir=180&kwp=10&roof=flat')) && await evalJs(`JSON.stringify({roof: window.__solar.state.roofType, expect: "bang", ok: window.__solar.state.roofType === "bang"})`);
    r.t4b_roofHaiDocBang = (await navTo('?from=vcc&dir=180&kwp=10&roof=hai_doc_bang')) && await evalJs(`JSON.stringify({roof: window.__solar.state.roofType, expect: "hai_doc_bang", ok: window.__solar.state.roofType === "hai_doc_bang"})`);
    r.t4c_roofUnknownWarn = (await navTo('?from=vcc&dir=180&kwp=10&roof=hip')) && await evalJs(`JSON.stringify({roof: window.__solar.state.roofType, expect: "ton", ok: window.__solar.state.roofType === "ton", hasWarn: document.body.innerHTML.includes("không nhận dạng được")})`);

    // ===== 5. Hồi quy: nhà 9×11 tôn (chuẩn V2) auto-fill = 36 tấm + Voc chuỗi 18 vẫn bị bắt =====
    await navTo('?from=vcc&dir=180&kwp=25&roof=ton&w=9&l=11');
    r.t5_regressionDefault = await evalJs(`(function(){
      const s = window.__solar;
      document.getElementById("autoBtn").click();
      const n = s.state.strings.reduce((a, st) => a + s.placedPanels(st), 0);
      const elec = s.stringElectricalCheck();
      return JSON.stringify({
        panels: n, ok36: n === 36,
        vocWorst: elec.worstV ? Math.round(elec.worstV) : 0,
        vocOver: elec.overV.length > 0 // K4: chuỗi 18 tấm vẫn bị bắt vượt 850V
      });
    })()`);

    await shot('screenshot_v122.png');
    console.log(JSON.stringify(r, null, 2));
    ws.close(); chromeProc.kill(); server.close();
  } catch (e) {
    console.error('TEST ERROR:', e.message || e);
    try { server.close(); } catch {}
    process.exit(1);
  }
});
