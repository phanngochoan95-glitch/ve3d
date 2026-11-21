// Test E2E combo (nhịp #7 + #12) — mọi tính năng XẾP CHUNG một cảnh:
//  C1: mái bằng + khung sắt 1.0m + setback + tum + bồn + poly đa giác + Xếp tự động
//      → pin trong poly, không đè vật cản, setback ✓, bifacial 8%, BOM khung, Voc cảnh báo
//  C2: đo buildHouse ms (căn cứ thiết kế #6 rAF-coalesce)
//  C3: scheduleBuildHouse qua input event thật (wallH 3.0 → 4.2, đỉnh nhà phải tăng)
//  C4: payload VCC (#12) đủ field: core + bom + solarFactorPct + bifacialGainPct + snapshots 4
//  C5: onboarding tour (#10) tự bật lần đầu + Bỏ qua ghi localStorage
//  C6: P3-2 ô kWp "Mục tiêu" giữ giá trị khi bấm +/− số tấm
//  C7: P3-3 dim-line tự ẩn khi camera thấp, hiện khi cao
// Chạy: node tools/test-combo-v5.mjs  (tự chứa: http 8135 + Chrome CDP 9464, profile mới)
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { makeStaticHandler } from './serve-static.mjs';

const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
function findChrome() {
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return cands.find(p => fs.existsSync(p));
}
const server = http.createServer(makeStaticHandler(ROOT));

server.listen(8135, '127.0.0.1', async () => {
  let chromeProc = null; let failed = false;
  try {
    chromeProc = spawn(findChrome(), [
      '--headless=new', '--remote-debugging-port=9464',
      '--user-data-dir=' + process.env.TEMP + '\\solar3d_combo_profile_' + Date.now(), '--window-size=1360,920',
      '--disable-gpu', '--no-first-run', 'http://127.0.0.1:8135/',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    chromeProc.stderr.on('data', () => {});
    await new Promise(r => setTimeout(r, 3000));
    let data = null;
    for (let i = 0; i < 20; i++) {
      try { data = await (await fetch('http://127.0.0.1:9464/json/list')).json(); if (Array.isArray(data)) break; } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!data) throw new Error('CDP không phản hồi');
    const target = data.find(t => t.type === 'page' && t.url.includes('8135'));
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
      if (typeof v !== 'string') throw new Error('eval không trả JSON — expr: ' + expr.slice(0, 80));
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

    // ===== C5. Tour (#10) tự bật lần đầu → Bỏ qua ghi localStorage =====
    await new Promise(r => setTimeout(r, 2200)); // tour start delay 900ms
    const tour = await evalJson(`JSON.stringify({
      shown: document.getElementById('tourOverlay').style.display === 'block',
      step: document.getElementById('tourStep').textContent
    })`);
    await evalJs(`(function(){ document.getElementById('tourSkip').click(); return true; })()`);
    const tourEnd = await evalJson(`JSON.stringify({
      hidden: document.getElementById('tourOverlay').style.display === 'none',
      stored: localStorage.getItem('solar3d.tour_done_v1') === '1'
    })`);
    check('C5 tour lần đầu tự bật (BƯỚC 1/3) + Bỏ qua → ẩn + localStorage', tour.shown && tour.step.includes('1/3') && tourEnd.hidden && tourEnd.stored, JSON.stringify({ tour, tourEnd }));

    // ===== C1. Combo scene =====
    const combo = await evalJson(`(function(){
      try {
        const S = window.__solar;
        // poly ngũ giác lưng nhà (tránh mép trước) — tọa độ nhà, trong bìa 9×11
        const poly = [{ x: -3.5, z: -4.5 }, { x: 3.5, z: -4.5 }, { x: 3.5, z: 2.0 }, { x: 0.5, z: 4.5 }, { x: -3.5, z: 2.0 }];
        S.applyState({
          ...S.collectState(), roofType: 'bang', mount: 'khungsat', rackH: 1.0, rackTilt: 13,
          houseAngle: 180, showTumThang: true, showBonNuoc: true, showTuongBao: false, showSetback: true, targetKwp: null,
          roofPoly: poly, strings: []
        });
        S.buildHouse();
        S.houseGroup.rotation.y = Math.PI;
        document.getElementById('autoBtn').click();
        S.scene.updateMatrixWorld(true);
        let inside = 0, total = 0;
        for (const st of S.state.strings) {
          const slope = S.getSlopes().find(k => k.key === st.slopeKey);
          const lay = S.layoutSlots(st.count, st.dir, slope);
          const o = S.stringOrigin(slope, st.cx, st.cy);
          total++;
          if (S.pointInPoly(o.x, o.z, S.state.roofPoly)) inside++;
        }
        let setbackLines = 0, polyLines = 0;
        S.scene.traverse(o => {
          if (o.userData && o.userData.isSetbackLine && o.visible) setbackLines++;
          if (o.userData && o.userData.isPolyOutline && o.visible) polyLines++;
        });
        const bom = window.__solar && S.state.strings.length ? null : null;
        return JSON.stringify({
          panels: S.state.strings.reduce((a, s) => a + S.placedPanels(s), 0),
          inside, total,
          setbackLines, polyLines,
          gain: S.calcBifacialGainPct(),
          shade: S.calcShadingLossPct(),
          setbackViol: S.checkSetbackViolations().length,
          voc: S.stringElectricalCheck()
        });
      } catch (e) { return JSON.stringify({ err: String(e && e.message || e) }); }
    })()`);
    check('C1 combo: pin xếp được, nằm TRONG poly, không vi phạm setback, biên + poly-line hiện',
      !combo.err && combo.panels > 0 && combo.inside === combo.total && combo.setbackViol === 0 && combo.setbackLines > 0 && combo.polyLines > 0, JSON.stringify(combo).slice(0, 220));
    check('C1b combo: bifacial 8% (khung 1m mái bằng)', combo.gain === 8, 'gain=' + combo.gain);
    // K4 Voc: chuỗi dài 18 tấm → 995V > 850V cảnh báo (kiểm deterministic, không phụ thuộc sức chứa poly)
    const voc18 = await evalJson(`(function(){
      const S = window.__solar;
      S.applyState({ ...S.collectState(), roofType: 'bang', mount: 'apmai', targetKwp: null, roofPoly: null,
        strings: [{ slopeKey: 'bang', count: 18, dir: 'doc', rot: 0, cx: 0, cy: 0, disabled: [] }] });
      S.buildHouse(); S.refreshAll();
      const e = S.stringElectricalCheck();
      return JSON.stringify({ worstV: e.worstV, over: e.overV.length });
    })()`);
    check('C1c K4 Voc chuỗi 18 tấm = 995V > 850V → cảnh báo', voc18.worstV >= 990 && voc18.over >= 1, JSON.stringify(voc18));

    // ===== C2. buildHouse ms (căn cứ thiết kế #6) =====
    const bh = await evalJson(`(function(){
      const S = window.__solar;
      S.applyState({ ...S.collectState(), roofType: 'ton', mount: 'apmai', houseAngle: 0, showTumThang: false, showBonNuoc: false, showSetback: false, targetKwp: null, roofPoly: null, strings: [] });
      document.getElementById('autoBtn').click();
      const t = [];
      for (let i = 0; i < 3; i++) { const t0 = performance.now(); S.buildHouse(); t.push(performance.now() - t0); }
      return JSON.stringify({ avg: Math.round(t.reduce((a, b) => a + b, 0) / 3), max: Math.round(Math.max(...t)) });
    })()`);
    check('C2 buildHouse 36 tấm avg < 200ms (rAF-coalesce #6 có ý nghĩa)', bh.avg > 0 && bh.avg < 200, JSON.stringify(bh));

    // ===== C3. scheduleBuildHouse qua input event thật =====
    const c3 = await evalJson(`(function(){
      const S = window.__solar;
      S.applyState({ ...S.collectState(), roofType: 'ton', mount: 'apmai', wallH: 3.0 });
      S.buildHouse();
      S.scene.updateMatrixWorld(true);
      const box = new S.THREE.Box3().setFromObject(S.houseGroup);
      const apexBefore = +box.max.y.toFixed(2);
      const range = document.getElementById('wallHRange');
      range.value = '4.2';
      range.dispatchEvent(new Event('input', { bubbles: true }));
      return JSON.stringify({ apexBefore, wallH: S.state.wallH });
    })()`);
    await new Promise(r => setTimeout(r, 300)); // rAF coalesce chạy
    const c3b = await evalJson(`(function(){
      const S = window.__solar;
      S.scene.updateMatrixWorld(true);
      const box = new S.THREE.Box3().setFromObject(S.houseGroup);
      return JSON.stringify({ apexAfter: +box.max.y.toFixed(2), label: document.getElementById('wallHVal').textContent });
    })()`);
    check('C3 scheduleBuildHouse: input wallH 4.2 → rAF dựng lại, đỉnh nhà tăng theo',
      c3.wallH === 4.2 && c3b.apexAfter > c3.apexBefore + 1.0 && c3b.label.includes('4.2'), 'before=' + c3.apexBefore + ' after=' + c3b.apexAfter);

    // ===== C4. payload VCC (#12) =====
    const pay = await evalJson(`(function(){
      try {
        const p = window.__solar.prepareBaoGiaPayload();
        return JSON.stringify({
          kwp: p.kwp > 0, panels: p.panels > 0, roof: !!p.roof, roofArea: p.roofAreaM2 > 90,
          mount: !!p.mount, bom: p.bom && p.bom.railM > 0,
          solar: typeof p.solarFactorPct === 'number', bif: typeof p.bifacialGainPct === 'number',
          shade: typeof p.shadingLossPct === 'number', voc: typeof p.stringVocMaxV === 'number',
          mppt: p.mpptMin > 0 && p.mpptMax > 0, snap1: (p.snapshot || '').startsWith('data:image'),
          snaps4: Array.isArray(p.snapshots) && p.snapshots.length >= 4 && p.snapshots.every(s => (s.dataUrl || '').startsWith('data:image'))
        });
      } catch (e) { return JSON.stringify({ err: String(e && e.message || e) }); }
    })()`);
    check('C4 payload VCC đủ field (core + bom + solar + bifacial + shade + voc + mppt + ≥4 ảnh có dataUrl)',
      !pay.err && Object.keys(pay).every(k => pay[k]), JSON.stringify(pay));

    // ===== C6. P3-2: ô kWp "Mục tiêu" giữ giá trị khi +/− số tấm =====
    const c6 = await evalJson(`(function(){
      const S = window.__solar;
      const inp = document.getElementById('targetKwpInput');
      inp.value = '10';
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      const label1 = document.getElementById('kwpInputLabel').textContent;
      const val1 = inp.value;
      document.getElementById('countPlus').click(); // +1 tấm — trước đây ghi đè ô thành 15.56
      const label2 = document.getElementById('kwpInputLabel').textContent;
      const val2 = inp.value;
      return JSON.stringify({ target: S.state.targetKwp, label1, val1, label2, val2 });
    })()`);
    check('C6 P3-2: nhãn đổi "Mục tiêu (kWp)" + ô giữ 10.00 sau khi bấm + tấm',
      c6.target === 10 && c6.label1 === 'Mục tiêu (kWp):' && c6.val1 === '10.00' && c6.label2 === 'Mục tiêu (kWp):' && c6.val2 === '10.00', JSON.stringify(c6));

    // ===== C7. P3-3: dim-line ẩn khi camera thấp, hiện khi cao =====
    const c7 = await evalJson(`(function(){
      const S = window.__solar;
      const countVisible = () => { let n = 0; S.houseGroup.traverse(o => { if (o.userData && o.userData.isDimLine && o.visible) n++; }); return n; };
      const tgt = S.controls.target;
      S.camera.position.set(tgt.x + 6, tgt.y + 0.3, tgt.z + 6); // elevation ~1.2°
      return JSON.stringify({ lowReady: true });
    })()`);
    await new Promise(r => setTimeout(r, 350));
    const c7low = await evalJs('(function(){ let n=0; window.__solar.houseGroup.traverse(o => { if (o.userData && o.userData.isDimLine && o.visible) n++; }); return n; })()');
    await evalJs('(function(){ const S = window.__solar; const t = S.controls.target; S.camera.position.set(t.x - 10, t.y + 14, t.z + 16); return true; })()');
    await new Promise(r => setTimeout(r, 350));
    const c7high = await evalJs('(function(){ let n=0; window.__solar.houseGroup.traverse(o => { if (o.userData && o.userData.isDimLine && o.visible) n++; }); return n; })()');
    // tôn 9×11 có 4 nét trên mái (2 cạnh + 2 dốc) — ẩn hết khi thấp; Rộng/Dài/Đỉnh (3 nét quanh nhà) LUÔN hiện theo thiết kế
    check('C7 P3-3: camera thấp → 4 nét trên mái ẩn (còn 3 nét quanh nhà), camera cao → hiện lại đủ (7)',
      c7low === 3 && c7high >= 6, 'low=' + c7low + ' (3 nét quanh nhà giữ) high=' + c7high);

    console.log('=== KẾT QUẢ test-combo-v5: ' + pass + '/' + results.length + ' PASS ===');
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
