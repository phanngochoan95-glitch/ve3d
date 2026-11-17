// Test V1.25 — Fix P1 đánh giá V3: khung mái bằng azimuth cố định Nam (tilt.rotation.x = −θ)
// Kiểm: (1) pháp tuyến pin mặt bằng + dải bằng hai_doc_bang hướng NAM ở cả 4 góc nhà;
// (2) rail vẫn NGỒI ĐÚNG trên dầm ở ĐÚNG hàng z sau khi mirror buildFlatRack (bẫy lật dấu yAt);
// (3) hồi quy số tấm 5 mái × 2 lắp 36/36/14/28/26; (4) áp mái mái dốc không bị ảnh hưởng;
// (5) badge đón nắng mái bằng 98% (P2 tự khép theo P1); (6) ảnh minh chứng mép cao về Bắc.
// Chạy: node tools/test-v125.mjs  (tự chứa: http server 8132 + Chrome headless CDP, profile mới)
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

server.listen(8132, '127.0.0.1', async () => {
  try {
    const chromeProc = spawn(findChrome(), [
      '--headless=new', '--remote-debugging-port=9459',
      '--user-data-dir=' + process.env.TEMP + '\\solar3d_v125_profile_' + Date.now(), '--window-size=1360,920',
      '--disable-gpu', '--no-first-run', 'http://127.0.0.1:8132/',
    ]);
    await new Promise(r => setTimeout(r, 2000));
    let data = null;
    for (let i = 0; i < 10; i++) {
      try { data = await (await fetch('http://127.0.0.1:9459/json/list')).json(); if (Array.isArray(data)) break; } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!data) throw new Error('CDP endpoint không phản hồi sau 10s');
    const target = data.find(t => t.type === 'page' && t.url.includes('8132'));
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
      if (r.exceptionDetails) throw new Error('eval exception: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
      return r.result.result.value;
    };
    const evalJson = async (expr) => {
      const v = await evalJs(expr);
      if (typeof v !== 'string') throw new Error('eval không trả JSON, nhận: ' + typeof v + ' ' + JSON.stringify(v)?.slice(0, 200));
      return JSON.parse(v);
    };
    const shot = async (name) => {
      const s = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(ROOT + 'tools\\' + name, Buffer.from(s.result.data, 'base64'));
    };

    // Đổi cấu hình + xếp tự động full mái
    const setup = (roof, mount, angle) => evalJs(`(function(){
      const s = window.__solar;
      s.applyState({ ...s.collectState(), roofType: ${JSON.stringify(roof)}, mount: ${JSON.stringify(mount)}, houseAngle: ${angle}, strings: [] });
      s.buildHouse();
      document.getElementById("autoBtn").click();
      return s.state.strings.length;
    })()`);

    // Gom số liệu pin: pháp tuyến world (getWorldDirection = mặt +z texture), phân loại flat/dốc
    const measure = () => evalJson(`(function(){
      const s = window.__solar;
      s.scene.updateMatrixWorld(true);
      const out = { flat: [], sloped: [], structures: [] };
      const v = new s.THREE.Vector3();
      for (const st of s.state.strings) {
        if (!st.group) continue;
        const slope = s.getSlopes().find(k => k.key === st.slopeKey);
        const isFlat = slope && slope.n.y > 0.9;
        s.houseGroup.traverse(o => {
          if (!o.isMesh || o.userData.stringId !== st.id || !Array.isArray(o.material)) return;
          o.getWorldDirection(v);
          (isFlat ? out.flat : out.sloped).push({ x: +v.x.toFixed(3), y: +v.y.toFixed(3), z: +v.z.toFixed(3) });
        });
        if (isFlat) {
          // dầm: Box height 0.08 là con trực tiếp của group chuỗi; cột D76: Cylinder r=0.038 con trực tiếp
          const g = st.group;
          const beams = g.children.filter(c => c.isMesh && c.geometry.type === 'BoxGeometry' && Math.abs(c.geometry.parameters.height - 0.08) < 0.001)
            .map(c => { const b = new s.THREE.Box3().setFromObject(c); return { z: +((b.min.z + b.max.z) / 2).toFixed(3), top: +b.max.y.toFixed(3) }; });
          const cols = g.children.filter(c => c.isMesh && c.geometry.type === 'CylinderGeometry' && Math.abs(c.geometry.parameters.radiusTop - 0.038) < 0.001)
            .map(c => { const b = new s.THREE.Box3().setFromObject(c); return { z: +((b.min.z + b.max.z) / 2).toFixed(3), top: +b.max.y.toFixed(3) }; });
          const rails = [];
          g.traverse(o => {
            if (!o.isMesh || o.geometry.type !== 'BoxGeometry') return;
            const p = o.geometry.parameters;
            if (Math.abs(p.height - 0.06) < 0.001 && (p.width > 1 || p.depth > 1) && o.parent !== g && o.parent.type === 'Group') rails.push(o);
          });
          const railsInfo = rails.map(r => {
            const p = r.geometry.parameters;
            const ends = p.depth > 1
              ? [new s.THREE.Vector3(0, -p.height / 2, -p.depth / 2), new s.THREE.Vector3(0, -p.height / 2, p.depth / 2)]
              : [new s.THREE.Vector3(-p.width / 2, -p.height / 2, 0), new s.THREE.Vector3(p.width / 2, -p.height / 2, 0)];
            const w = ends.map(e => r.localToWorld(e.clone()));
            return { z1: +w[0].z.toFixed(3), y1: +w[0].y.toFixed(3), z2: +w[1].z.toFixed(3), y2: +w[1].y.toFixed(3), halfH: p.height / 2 };
          });
          out.structures.push({ slopeKey: st.slopeKey, nCols: cols.length, nRails: rails.length, beams, rails: railsInfo, cols });
        }
      }
      out.nStrings = s.state.strings.length;
      out.panels = s.state.strings.reduce((a, st) => a + s.placedPanels(st), 0);
      return JSON.stringify(out);
    })()`);

    const r = {};

    // ===== 1. P1: pháp tuyến pin mái bằng + khungsat ở 4 góc nhà — mọi tấm phải hướng NAM (z>0.2, y>0.9) =====
    r.t1_flatNormals = {};
    for (const a of [0, 90, 180, 270]) {
      await setup('bang', 'khungsat', a);
      const m = await measure();
      const bad = m.flat.filter(n => !(n.z > 0.2 && n.y > 0.9));
      r.t1_flatNormals['house' + a] = { panels: m.flat.length, bad: bad.length, sample: m.flat[0] || null };
    }

    // ===== 2. P1 nhánh hai_doc_bang: các tấm trên DẢI BẰNG cũng phải hướng Nam =====
    await setup('hai_doc_bang', 'khungsat', 90);
    {
      const m = await measure();
      const bad = m.flat.filter(n => !(n.z > 0.2 && n.y > 0.9));
      r.t2_haiDocBangFlat = { flatPanels: m.flat.length, bad: bad.length, sample: m.flat[0] || null };
    }

    // ===== 3. Cấu trúc: đỉnh cột D76 phải SAT mép rail tại đúng z của cột (bẫy lật dấu yAt: =====
    // sai mirror thì cột cao 1.6m đâm xuyên rail/panel ở phía mép thấp, lệch > 1m) =====
    await setup('bang', 'khungsat', 0);
    {
      const m = await measure();
      let worstGap = 0, checks = 0;
      const dbg = [];
      for (const st of m.structures) {
        dbg.push({ dir: st.dir, nCols: st.nCols, nRails: st.nRails, cols: st.cols, rails: st.rails, beams: st.beams });
        for (const c of st.cols) {
          let best = null;
          for (const rail of st.rails) {
            const lo = Math.min(rail.z1, rail.z2), hi = Math.max(rail.z1, rail.z2);
            const yLo = rail.z1 < rail.z2 ? rail.y1 : rail.y2, yHi = rail.z1 < rail.z2 ? rail.y2 : rail.y1;
            const zc = Math.min(hi, Math.max(lo, c.z));
            const t = (zc - lo) / Math.max(0.001, hi - lo);
            const railTopAtCol = yLo + (yHi - yLo) * t + rail.halfH;
            const gap = Math.abs(c.top - railTopAtCol);
            if (best === null || gap < best.gap) best = gap;
          }
          if (best !== null) { worstGap = Math.max(worstGap, best); checks++; }
        }
      }
      r.t3_colMeetsRail = { worstGap: +worstGap.toFixed(3), checks, strings: m.structures.length, pass: worstGap < 0.2, dbg };
    }

    // ===== 4. Hồi quy số tấm: 5 mái × 2 lắp = 36/36/14/28/26 =====
    r.t4_counts = {};
    for (const roof of ['ton', 'ngoi', 'nhat', 'bang', 'hai_doc_bang']) {
      for (const mount of ['apmai', 'khungsat']) {
        await setup(roof, mount, 180);
        const m = await measure();
        r.t4_counts[roof + '/' + mount] = m.panels;
      }
    }
    r.t4_expect = { 'ton/apmai': 36, 'ton/khungsat': 36, 'ngoi/apmai': 36, 'ngoi/khungsat': 36, 'nhat/apmai': 14, 'nhat/khungsat': 14, 'bang/apmai': 28, 'bang/khungsat': 28, 'hai_doc_bang/apmai': 26, 'hai_doc_bang/khungsat': 26 };

    // ===== 5. Áp mái mái dốc không bị ảnh hưởng: pin theo dốc mái (tôn: 2 dốc trái/phải = ±x) =====
    await setup('ton', 'khungsat', 0);
    {
      const m0 = await measure();
      await setup('ton', 'khungsat', 180);
      const m180 = await measure();
      const xMax0 = Math.max(...m0.sloped.map(n => Math.abs(n.x)));
      const zMax0 = Math.max(...m0.sloped.map(n => Math.abs(n.z)));
      const xMax180 = Math.max(...m180.sloped.map(n => Math.abs(n.x)));
      const zMax180 = Math.max(...m180.sloped.map(n => Math.abs(n.z)));
      // dốc 26°: |x| ≈ sin26 = 0.438, z ≈ 0 ở CẢ HAI góc (không phải hướng Nam cố định)
      r.t5_slopedFollowsRoof = { xMaxHouse0: xMax0, zMaxHouse0: zMax0, xMaxHouse180: xMax180, zMaxHouse180: zMax180, pass: Math.abs(xMax0 - 0.438) < 0.06 && Math.abs(xMax180 - 0.438) < 0.06 && zMax0 < 0.1 && zMax180 < 0.1 };
    }

    // ===== 6. P2: badge đón nắng mái bằng khungsat = 98% (đúng vì pin luôn Nam sau fix) =====
    await setup('bang', 'khungsat', 0);
    r.t6_solarFactor = await evalJs(`(function(){ try { const f = window.__solar.calcSolarFactor(); return JSON.stringify({ bangKhungsat: Math.round(f * 1000) / 10 }); } catch (e) { return JSON.stringify({ err: String(e) }); } })()`);

    // ===== 7. Ảnh minh chứng: mép cao khung về BẮC (house0) và không quay theo nhà (house180 cùng pose) =====
    await setup('bang', 'khungsat', 0);
    await shot('screenshot_v125_flat_h0.png');
    await setup('bang', 'khungsat', 180);
    await shot('screenshot_v125_flat_h180.png');

    console.log(JSON.stringify(r, null, 2));
    ws.close(); chromeProc.kill(); server.close();
  } catch (e) {
    console.error('TEST ERROR:', e.message || e);
    try { server.close(); } catch {}
    process.exit(1);
  }
});
