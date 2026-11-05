// Test V1.21 — kiểm duyệt V1.20 (P0-1 + P1-2/3/4/5) và tính năng mới (K2-mini shading raycast, K4-mini Voc/MPPT)
// Chạy: node tools/test-v121.mjs  (tự chứa: http server 8127 + Chrome headless CDP)
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

server.listen(8127, '127.0.0.1', async () => {
  try {
    const chromeProc = spawn(findChrome(), [
      '--headless=new', '--remote-debugging-port=9454',
      '--user-data-dir=' + process.env.TEMP + '\\solar3d_v121_profile_' + Date.now(), '--window-size=1360,920',
      '--disable-gpu', '--no-first-run', 'http://127.0.0.1:8127/',
    ]);
    await new Promise(r => setTimeout(r, 2000));
    const data = await (await fetch('http://127.0.0.1:9454/json/list')).json();
    const target = data.find(t => t.type === 'page' && t.url.includes('8127'));
    if (!target) throw new Error('page not found');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 1; const pending = new Map();
    ws.onmessage = (msg) => { const res = JSON.parse(msg.data); if (res.id && pending.has(res.id)) { pending.get(res.id)(res); pending.delete(res.id); } };
    await new Promise(r => ws.onopen = r);
    const send = (method, params = {}) => new Promise(resolve => { const curId = id++; pending.set(curId, resolve); ws.send(JSON.stringify({ id: curId, method, params })); });
    await send('Page.enable'); await send('Runtime.enable');
    for (let i = 0; i < 20; i++) {
      const chk = await send('Runtime.evaluate', { expression: 'typeof window.__solar !== "undefined"' });
      if (chk.result?.value === true) break;
      await new Promise(r => setTimeout(r, 500));
    }
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

    // ===== 1. P0-1: mặc định KHÔNG còn cảnh báo setback trên thiết kế chuẩn =====
    r.t1_defaultNoSetback = await evalJs(`(function(){
      const s = window.__solar;
      s.applyState({ ...s.collectState(), roofType: "ton", mount: "apmai", strings: [], showSetback: false });
      document.getElementById("autoBtn").click();
      const bad = s.checkSetbackViolations();
      let lines = 0;
      s.scene.traverse(o => { if (o.userData && o.userData.isSetbackLine) lines++; });
      return JSON.stringify({ showSetback: s.state.showSetback, badLen: bad.length, lines, summaryWarn: document.getElementById("summary").innerHTML.includes("Hành lang gió bão") });
    })()`);

    // ===== 2. P0-1b: bật setback trên mái bằng → auto-fill tự lùi ≥0.40m → không vi phạm =====
    r.t2_setbackOnFlatClean = await evalJs(`(function(){
      const s = window.__solar;
      s.applyState({ ...s.collectState(), roofType: "bang", mount: "khungsat", showSetback: true, edgeMargin: 0.22, strings: [] });
      document.getElementById("autoBtn").click();
      const bad = s.checkSetbackViolations();
      const nPanels = s.state.strings.reduce((a, st) => a + s.placedPanels(st), 0);
      return JSON.stringify({ badLen: bad.length, nPanels, note: "mép mái phẳng giờ >= 0.40m, sức chứa giảm so với 28 tấm cũ là ĐÚNG ý thiết kế" });
    })()`);

    // ===== 3. P1-2: mái 2 dốc + bằng ridge 70% + bồn nước → auto-fill không đè bồn =====
    r.t3_obstacleDomain = await evalJs(`(function(){
      const s = window.__solar;
      s.applyState({ ...s.collectState(), roofType: "hai_doc_bang", ridgePct: 70, mount: "apmai", strings: [], showBonNuoc: true, bonNuocType: "nam", bonNuocX: null, bonNuocZ: null, showTumThang: false });
      s.buildHouse();
      document.getElementById("autoBtn").click();
      const slope = s.getSlopes().find(k => k.key === "bang-giua");
      // vị trí bồn thật theo đúng hàm của app (mặc định sau-phải TRÊN DẢI BẰNG)
      const bp = s.getBonNuocPos();
      const bon = { cx: bp.x - slope.origin.x, cy: bp.z - slope.origin.z, hu: bp.bW/2 + 0.15, hv: bp.bL/2 + 0.15 };
      let overlaps = [];
      for (const st of s.state.strings) {
        if (st.slopeKey !== "bang-giua") continue;
        const lay = s.layoutSlots(s.placedPanels(st), st.dir, slope);
        const e = { hu: lay.totalU/2, hv: lay.totalV/2 };
        if (Math.abs(st.cx - bon.cx) < bon.hu + e.hu - 1e-6 && Math.abs(st.cy - bon.cy) < bon.hv + e.hv - 1e-6) overlaps.push(st.id);
      }
      return JSON.stringify({ originX: +slope.origin.x.toFixed(2), bonLocal: { cx: +bon.cx.toFixed(2), cy: +bon.cy.toFixed(2) }, nStrings: s.state.strings.length, overlaps, stripString: s.state.strings.filter(st => st.slopeKey === "bang-giua").length });
    })()`);

    // ===== 4. P1-3: bồn nước KHÔNG còn chìm dưới dải bằng =====
    r.t4_bonY = await evalJs(`(function(){
      const s = window.__solar;
      s.applyState({ ...s.collectState(), roofType: "hai_doc_bang", ridgePct: 70, mount: "apmai", strings: [], showBonNuoc: true, bonNuocType: "nam", bonNuocX: null, bonNuocZ: null, showTumThang: false });
      s.buildHouse();
      const slope = s.getSlopes().find(k => k.key === "bang-giua");
      let grp = null; s.scene.traverse(o => { if (o.userData && o.userData.isBonNuoc && o.type === "Group") grp = o; });
      const box = new s.THREE.Box3().setFromObject(grp);
      const sink = +(slope.origin.y - box.min.y).toFixed(2);
      return JSON.stringify({ stripTopY: +slope.origin.y.toFixed(2), bonMinY: +box.min.y.toFixed(2), sink });
    })()`);

    // ===== 5. P1-4: footprint bồn nằm khớp mesh (2.7) =====
    r.t5_bonFootprint = await evalJs(`(function(){
      const s = window.__solar;
      s.applyState({ ...s.collectState(), roofType: "bang", mount: "apmai", strings: [], showBonNuoc: true, bonNuocType: "nam", bonNuocX: 0, bonNuocZ: 0 });
      s.buildHouse();
      let grp = null; s.scene.traverse(o => { if (o.userData && o.userData.isBonNuoc && o.type === "Group") grp = o; });
      const box = new s.THREE.Box3().setFromObject(grp);
      return JSON.stringify({ meshZ: +(box.max.z - box.min.z).toFixed(2), khaiBao: 2.7 });
    })()`);

    // ===== 6. K2-mini: suy hao bóng raycast =====
    // 6a: auto-fill né vật cản 2D → khối pin dời ra khỏi vùng bóng → loss = 0 là ĐÚNG (avoidance làm việc)
    r.t6a_shadingAutoFill = await evalJs(`(function(){
      const s = window.__solar;
      s.applyState({ ...s.collectState(), roofType: "bang", mount: "khungsat", strings: [], showTumThang: true, showBonNuoc: true, showTuongBao: true, bonNuocType: "nam" });
      s.buildHouse();
      document.getElementById("autoBtn").click();
      return JSON.stringify({ loss: s.calcShadingLossPct(), nStrings: s.state.strings.length });
    })()`);
    // 6b: chuỗi KÉO TAY vào vùng bóng phía Tây Bắc của tum (tum đặt (2.5, 3.5)) → loss > 0
    r.t6b_shadingManual = await evalJs(`(function(){
      const s = window.__solar;
      s.applyState({ ...s.collectState(), roofType: "bang", mount: "khungsat", strings: [], showTumThang: true, showBonNuoc: false, showTuongBao: false, tumX: 2.5, tumZ: 3.5 });
      s.buildHouse();
      s.state.strings.push({ id: 1, slopeKey: "bang", count: 4, dir: "doc", rot: 0, cx: -0.5, cy: 0.5, group: null, disabled: [] });
      s.refreshAll();
      return JSON.stringify({ loss: s.calcShadingLossPct(), hit: s.calcShadingLossPct() > 0 });
    })()`);
    // 6c: không vật cản → 0
    r.t6c_shadingNone = await evalJs(`(function(){
      const s = window.__solar;
      s.applyState({ ...s.collectState(), strings: [], showTumThang: false, showBonNuoc: false, showTuongBao: false });
      s.buildHouse();
      document.getElementById("autoBtn").click();
      return JSON.stringify({ loss: s.calcShadingLossPct() });
    })()`);

    // ===== 7. K4-mini: Voc chuỗi 18 tấm vượt MPPT 850V mặc định =====
    r.t7_elecCheck = await evalJs(`(function(){
      const s = window.__solar;
      s.applyState({ ...s.collectState(), roofType: "ton", mount: "apmai", strings: [] });
      s.state.strings.push({ id: 1, slopeKey: "trai", count: 18, dir: "doc", rot: 0, cx: 0, cy: 0, group: null, disabled: [] });
      s.refreshAll();
      const e18 = s.stringElectricalCheck();
      const summaryWarnAt18 = document.getElementById("summary").innerHTML.includes("Voc vượt MPPT");
      s.state.strings[0].count = 8;
      s.refreshAll();
      const e8 = s.stringElectricalCheck();
      return JSON.stringify({ voc18: e18.worstV, over18: e18.overV.length, voc8: e8.worstV, over8: e8.overV.length, summaryWarnAt18 });
    })()`);

    // ===== 8. Hồi quy sản lượng: hệ số đón nắng áp đúng =====
    r.t8_solarFactor = await evalJs(`(function(){
      const s = window.__solar;
      const fSouth = s.calcSolarFactor();
      return JSON.stringify({ apmaiSouth: +fSouth.toFixed(3), in01: fSouth >= 0.78 && fSouth <= 1.02 });
    })()`);

    await shot('screenshot_v121.png');
    console.log(JSON.stringify(r, null, 2));
    ws.close(); chromeProc.kill(); server.close();
  } catch (err) { console.error('ERR:', err.message || err); server.close(); }
});
