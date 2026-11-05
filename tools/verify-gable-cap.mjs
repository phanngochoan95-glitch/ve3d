// Kiểm chứng lỗi "hở chỗ mái nhà" (tam giác bịt đầu hông bị cắt mặt do winding sai).
// Chạy:  node tools/verify-gable-cap.mjs
// - Phục vụ /before = tools/_before-gable.html (bản lỗi), /after = index.html (bản đã sửa)
// - Mỗi ca: set state qua window.__solar.applyState(...) rồi chụp canvas 3D
// - Xoay nhà 180° (houseAngle) để đầu hông bị culled quay về phía camera → thấy rõ lỗ hở
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BEFORE = path.join(HERE, '_before-gable.html');
const AFTER = path.join(HERE, '..', 'index.html');
const OUT = path.join(HERE, 'verify-gable-cap-out');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const CASES = [
  // side 'north' = camera phía Bắc (góc của user khi báo lỗi), 'south' = đối chứng hồi quy
  { tag: 'ton-north', state: { roofType: 'ton', ridgePct: 61 }, side: 'north' },
  { tag: 'ton-south', state: { roofType: 'ton', ridgePct: 61 }, side: 'south' },
  { tag: 'hdb-north', state: { roofType: 'hai_doc_bang', ridgePct: 61 }, side: 'north' },
  { tag: 'nhat-north', state: { roofType: 'nhat' }, side: 'north' }, // mái Nhật (bịt hông DoubleSide) — phải không đổi
];

function findChrome() {
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const found = cands.find(p => fs.existsSync(p));
  if (!found) throw new Error('Không tìm thấy Chrome');
  return found;
}

const server = http.createServer((req, res) => {
  const file = req.url.startsWith('/before') ? BEFORE : AFTER;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(file));
});

server.listen(8129, '127.0.0.1', async () => {
  const chromePath = findChrome();
  const port = 9455;
  const tmpDir = path.join(process.env.TEMP || '/tmp', 'chrome_cdp_gablecap');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const chromeProc = spawn(chromePath, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${tmpDir}`,
    '--window-size=1360,920', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    'about:blank',
  ]);
  await new Promise(r => setTimeout(r, 2000));

  try {
    const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
    const target = (await listRes.json()).find(t => t.type === 'page');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 1; const pending = new Map();
    ws.onmessage = (msg) => {
      const res = JSON.parse(msg.data);
      if (res.id && pending.has(res.id)) { pending.get(res.id)(res); pending.delete(res.id); }
    };
    await new Promise(r => ws.onopen = r);
    const send = (method, params = {}) => new Promise((resolve) => {
      const curId = id++; pending.set(curId, resolve);
      ws.send(JSON.stringify({ id: curId, method, params }));
    });

    await send('Page.enable');
    await send('Runtime.enable');

    for (const ver of ['before', 'after']) {
      await send('Page.navigate', { url: `http://127.0.0.1:8129/${ver}` });
      let ready = false, lastChk = null;
      for (let i = 0; i < 40 && !ready; i++) {
        await new Promise(r => setTimeout(r, 500));
        const chk = await send('Runtime.evaluate', { expression: 'typeof window.__solar !== "undefined"' });
        lastChk = chk;
        ready = chk.result?.result?.value === true;
      }
      if (!ready) throw new Error(`${ver}: __solar chưa sẵn sàng — lastChk=${JSON.stringify(lastChk).slice(0, 300)}`);
      await new Promise(r => setTimeout(r, 1500)); // chờ dựng scene + texture

      for (const cs of CASES) {
        const zCam = cs.side === 'north' ? -15.5 : 15.5;
        const res = await send('Runtime.evaluate', { expression: `
          (() => {
            window.__solar.applyState(Object.assign({
              roofType: 'ton', houseW: 9, houseL: 11, wallH: 3, roofAngle: 26,
              ridgePct: 61, houseAngle: 0, dirChoice: 'doc'
            }, ${JSON.stringify(cs.state)}));
            const { camera, controls, renderer, scene } = window.__solar;
            camera.position.set(0.5, 2.6, ${zCam});
            controls.target.set(0, 3.6, 0);
            controls.update();
            renderer.render(scene, camera);
            return 'ok';
          })()
        ` });
        if (res.result?.result?.value !== 'ok') throw new Error(`${ver}/${cs.tag}: applyState lỗi — ${JSON.stringify(res).slice(0, 300)}`);
        await new Promise(r => setTimeout(r, 900));

        const shot = await send('Page.captureScreenshot', { format: 'png' });
        const out = path.join(OUT, `${cs.tag}-${ver}.png`);
        fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
        console.log('chụp:', path.basename(out));
      }
    }
    console.log('XONG — ảnh trong tools/verify-gable-cap-out/');
  } finally {
    chromeProc.kill();
    server.close();
  }
});
