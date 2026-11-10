// Test "Voc/MPPT thành mặc định" — theo yêu cầu user 10-11-2026:
// 1) 4 ô nhập có giá trị mặc định datasheet nạp sẵn (HTML value tĩnh), section mở sẵn
// 2) Kiểm tra luôn chạy: chip xanh "⚡ Điện chuỗi ✓" khi đạt
// 3) Cảnh báo đỏ vẫn lên khi chuỗi 18 tấm = 995V > 850V (regression V1.21)
// 4) Hồi quy: kWh/tháng + Đón nắng vẫn hiển thị
// Chạy: node tools/test-elec-default.mjs  (tự chứa: http server + Chrome headless CDP, profile mới mỗi lần)
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

const PORT = 8131, CDP = 9461;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(fs.readFileSync(ROOT + 'index.html'));
});

const results = {};
let chromeProc = null;

function finish(ok) {
  console.log(ok ? '=== ALL PASS ===' : '=== FAILED ===');
  server.close();
  try { chromeProc?.kill(); } catch {}
  process.exit(ok ? 0 : 1);
}

server.listen(PORT, '127.0.0.1', async () => {
  try {
    chromeProc = spawn(findChrome(), [
      '--headless=new', '--remote-debugging-port=' + CDP,
      '--user-data-dir=' + process.env.TEMP + '\\solar3d_elec_profile_' + Date.now(), '--window-size=1360,920',
      '--disable-gpu', '--no-first-run', `http://127.0.0.1:${PORT}/`,
    ]);
    await new Promise(r => setTimeout(r, 2200));
    const data = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
    const target = data.find(t => t.type === 'page' && t.url.includes(String(PORT)));
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

    // T1: giá trị mặc định datasheet nạp sẵn + section mở
    results.t1_prefill = await evalJs(`(function(){
      const g = id => document.getElementById(id);
      return JSON.stringify({
        voc: g('panelVocInput').value, vmp: g('panelVmpInput').value,
        lo: g('mpptMinInput').value, hi: g('mpptMaxInput').value,
        open: g('elecField').open,
        stateVoc: window.__solar.state.panelVoc, stateVmp: window.__solar.state.panelVmp,
        stateLo: window.__solar.state.mpptMin, stateHi: window.__solar.state.mpptMax,
      });
    })()`);

    // T2: chuỗi 9 tấm mái trái (tôn áp mái) → chip xanh "Điện chuỗi ✓", không cảnh báo đỏ
    results.t2_greenChip = await evalJs(`(function(){
      const s = window.__solar;
      s.applyState({ ...s.collectState(), roofType: "ton", mount: "apmai", strings: [], showSetback: false });
      s.state.strings.push({ id: 1, slopeKey: "trai", count: 9, dir: "doc", rot: 0, cx: 0, cy: 0, group: null, disabled: [] });
      s.buildHouse(); s.refreshAll();
      const html = document.getElementById('summary').innerHTML;
      return JSON.stringify({ green: html.includes('Điện chuỗi ✓'), red: html.includes('Voc vượt MPPT max'), amber: html.includes('Vmp tụt dưới MPPT min') });
    })()`);

    // T3: chuỗi 18 tấm → Voc lạnh 995V > 850V → cảnh báo đỏ, chip xanh biến mất
    results.t3_redWarn = await evalJs(`(function(){
      const s = window.__solar;
      s.state.strings[0].count = 18; s.buildHouse(); s.refreshAll();
      const html = document.getElementById('summary').innerHTML;
      const elec = s.stringElectricalCheck();
      return JSON.stringify({ red: html.includes('Voc vượt MPPT max'), green: html.includes('Điện chuỗi ✓'), worstV: elec.worstV, overN: elec.overV.length });
    })()`);

    // T4: hồi quy — kWh/tháng + Đón nắng vẫn hiển thị
    results.t4_regress = await evalJs(`(function(){
      const s = window.__solar;
      s.state.strings[0].count = 9; s.buildHouse(); s.refreshAll();
      const html = document.getElementById('summary').innerHTML;
      return JSON.stringify({ kwh: html.includes('kWh/tháng'), nang: html.includes('Đón nắng'), green: html.includes('Điện chuỗi ✓') });
    })()`);

    // T5: đổi MPPT max → 1200 thì chuỗi 18 tấm ĐẠT (kiểm tra nhập của người dùng vẫn được tôn trọng)
    results.t5_userOverride = await evalJs(`(function(){
      const s = window.__solar;
      s.state.strings[0].count = 18;
      s.state.mpptMax = 1200; s.buildHouse(); s.refreshAll();
      const html = document.getElementById('summary').innerHTML;
      const out = { green: html.includes('Điện chuỗi ✓'), red: html.includes('Voc vượt MPPT max'), hiShown: html.includes('≤ 1200 V') };
      s.state.mpptMax = 850; s.buildHouse(); s.refreshAll();
      return JSON.stringify(out);
    })()`);

    chromeProc.kill();
    let ok = true;
    const t1 = JSON.parse(results.t1_prefill);
    if (!(t1.voc === "52.66" && t1.vmp === "44.33" && t1.lo === "150" && t1.hi === "850" && t1.open === true
          && t1.stateVoc === 52.66 && t1.stateVmp === 44.33 && t1.stateLo === 150 && t1.stateHi === 850)) {
      ok = false; console.log('[T1 LOI] prefill:', results.t1_prefill);
    } else console.log('[T1 OK] 4 ô nạp sẵn datasheet + section mở:', results.t1_prefill);

    const t2 = JSON.parse(results.t2_greenChip);
    if (!(t2.green && !t2.red && !t2.amber)) { ok = false; console.log('[T2 LOI] chip xanh:', results.t2_greenChip); }
    else console.log('[T2 OK] 9 tấm đạt → chip xanh, không cảnh báo');

    const t3 = JSON.parse(results.t3_redWarn);
    if (!(t3.red && !t3.green && t3.overN === 1 && t3.worstV === 995)) { ok = false; console.log('[T3 LOI] cảnh báo đỏ:', results.t3_redWarn); }
    else console.log('[T3 OK] 18 tấm → 995V > 850V cảnh báo đỏ, chip xanh tắt');

    const t4 = JSON.parse(results.t4_regress);
    if (!(t4.kwh && t4.nang && t4.green)) { ok = false; console.log('[T4 LOI] hồi quy:', results.t4_regress); }
    else console.log('[T4 OK] kWh/tháng + Đón nắng + chip xanh cùng hiển thị');

    const t5 = JSON.parse(results.t5_userOverride);
    if (!(t5.green && !t5.red && t5.hiShown)) { ok = false; console.log('[T5 LOI] override người dùng:', results.t5_userOverride); }
    else console.log('[T5 OK] MPPT max 1200 → 18 tấm đạt, nhãn chip cập nhật 1200V');

    finish(ok);
  } catch (e) {
    console.error('TEST ERROR:', e.message);
    try { chromeProc?.kill(); } catch {}
    server.close();
    process.exit(1);
  }
});
