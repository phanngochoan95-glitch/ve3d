// Verify LIVE ve3d.onrender.com sau deploy V1.25 (fix P1 azimuth khung mái bằng)
// Đo pháp tuyến pin ở 4 góc nhà + cột khớp rail —same methodology test-v125, chỉ chạy core.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

function findChrome() {
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return cands.find(p => fs.existsSync(p));
}

const chromeProc = spawn(findChrome(), [
  '--headless=new', '--remote-debugging-port=9461',
  '--user-data-dir=' + process.env.TEMP + '\\solar3d_live_v125_' + Date.now(), '--window-size=1360,920',
  '--disable-gpu', '--no-first-run', 'https://ve3d.onrender.com/',
]);
await new Promise(r => setTimeout(r, 4000));
let data = null;
for (let i = 0; i < 20; i++) {
  try { data = await (await fetch('http://127.0.0.1:9461/json/list')).json(); if (Array.isArray(data) && data.length) break; } catch {}
  await new Promise(r => setTimeout(r, 1000));
}
if (!data) throw new Error('CDP không phản hồi');
const target = data.find(t => t.type === 'page' && t.url.includes('ve3d.onrender.com'));
if (!target) throw new Error('page not found');
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 1; const pending = new Map();
ws.onmessage = (msg) => { const res = JSON.parse(msg.data); if (res.id && pending.has(res.id)) { pending.get(res.id)(res); pending.delete(res.id); } };
await new Promise(r => ws.onopen = r);
const send = (method, params = {}) => new Promise(resolve => { const curId = id++; pending.set(curId, resolve); ws.send(JSON.stringify({ id: curId, method, params })); });
await send('Page.enable'); await send('Runtime.enable');
for (let i = 0; i < 60; i++) {
  const chk = await send('Runtime.evaluate', { expression: 'typeof window.__solar !== "undefined" && !!window.__solar.state' });
  if (chk.result?.result?.value === true) break;
  await new Promise(r => setTimeout(r, 1000));
}
const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
  return r.result.result.value;
};
const evalJson = async (expr) => {
  const v = await evalJs(expr);
  if (typeof v !== 'string') throw new Error('not json: ' + typeof v);
  return JSON.parse(v);
};

const out = {};
for (const a of [0, 90, 180, 270]) {
  await evalJs(`(function(){
    const s = window.__solar;
    s.applyState({ ...s.collectState(), roofType: "bang", mount: "khungsat", houseAngle: ${a}, strings: [] });
    s.buildHouse();
    document.getElementById("autoBtn").click();
    return 1;
  })()`);
  const m = await evalJson(`(function(){
    const s = window.__solar;
    s.scene.updateMatrixWorld(true);
    const v = new s.THREE.Vector3();
    const flat = [];
    for (const st of s.state.strings) {
      if (!st.group) continue;
      const slope = s.getSlopes().find(k => k.key === st.slopeKey);
      if (!slope || slope.n.y <= 0.9) continue;
      s.houseGroup.traverse(o => {
        if (!o.isMesh || o.userData.stringId !== st.id || !Array.isArray(o.material)) return;
        o.getWorldDirection(v);
        flat.push({ x: +v.x.toFixed(3), y: +v.y.toFixed(3), z: +v.z.toFixed(3) });
      });
    }
    return JSON.stringify({ panels: flat.length, bad: flat.filter(n => !(n.z > 0.2 && n.y > 0.9)).length, sample: flat[0] || null });
  })()`);
  out['house' + a] = m;
}
console.log(JSON.stringify(out, null, 2));
const allGood = Object.values(out).every(m => m.panels > 0 && m.bad === 0);
console.log(allGood ? 'LIVE VERIFY PASS — pin hướng Nam ở cả 4 góc nhà' : 'LIVE VERIFY FAIL');
ws.close(); chromeProc.kill();
process.exit(allGood ? 0 : 1);
