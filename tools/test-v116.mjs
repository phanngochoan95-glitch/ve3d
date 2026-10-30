import http from 'node:http';
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

// Start temporary local HTTP server for index.html
const server = http.createServer((req, res) => {
  const filePath = 'C:\\Users\\Hoanpn\\My Drive\\3D Thiết kế\\solar-3d-simulator\\index.html';
  if (fs.existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(filePath));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(8125, '127.0.0.1', async () => {
  try {
    const chromePath = findChrome();
    const port = 9450;
    const tmpDir = 'C:\\Users\\Hoanpn\\AppData\\Local\\Temp\\chrome_cdp_test_v116';
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const chromeProc = spawn(chromePath, [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${tmpDir}`,
      '--window-size=1360,920',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      'http://127.0.0.1:8125/'
    ]);

    await new Promise(r => setTimeout(r, 2000));

    const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
    const data = await listRes.json();
    const target = data.find(t => t.type === 'page' && t.url.includes('8125'));
    if (!target) throw new Error('Target page not found: ' + JSON.stringify(data));

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let id = 1;
    const pending = new Map();
    ws.onmessage = (msg) => {
      const res = JSON.parse(msg.data);
      if (res.id && pending.has(res.id)) {
        pending.get(res.id)(res);
        pending.delete(res.id);
      }
    };
    await new Promise(r => ws.onopen = r);

    function send(method, params = {}) {
      return new Promise((resolve) => {
        const curId = id++;
        pending.set(curId, resolve);
        ws.send(JSON.stringify({ id: curId, method, params }));
      });
    }

    await send('Page.enable');
    await send('Runtime.enable');

    for (let i = 0; i < 20; i++) {
      const chk = await send('Runtime.evaluate', { expression: 'typeof window.__solar !== "undefined"' });
      if (chk.result?.value === true) break;
      await new Promise(r => setTimeout(r, 500));
    }

    const testRes = await send('Runtime.evaluate', {
      expression: `
        (function() {
          const results = {};
          // 1. Kiểm tra các nút la bàn
          const dirBtns = Array.from(document.querySelectorAll('#dirPresetsRow .dir-btn'));
          results.dirBtnsCount = dirBtns.length;
          results.dirBtnLabels = dirBtns.map(b => b.textContent.trim());

          // Click nút Nam 180°
          const btnNam = dirBtns.find(b => b.dataset.angle === "180");
          if (btnNam) btnNam.click();
          results.angleAfterNam = window.__solar.state.houseAngle;
          results.angleValText = document.getElementById('angleVal')?.textContent;
          results.namIsActive = btnNam.classList.contains('active');

          // Click nút Đ.Nam 135°
          const btnDN = dirBtns.find(b => b.dataset.angle === "135");
          if (btnDN) btnDN.click();
          results.angleAfterDN = window.__solar.state.houseAngle;
          results.angleValTextDN = document.getElementById('angleVal')?.textContent;
          results.dnIsActive = btnDN.classList.contains('active');

          // 2. Kiểm tra link và nút Báo Giá VCC
          const linkTop = document.getElementById('linkBaoGiaTop');
          const linkBtn = document.getElementById('linkBaoGiaBtn');
          results.hasLinkTop = !!linkTop;
          results.hasLinkBtn = !!linkBtn;
          results.linkTopHref = linkTop?.getAttribute('href');

          // 3. Kiểm tra overlay toggle
          const toggleBtn = document.getElementById('overlayToggleBtn');
          const overlay = document.getElementById('houseDirOverlay');
          results.hasToggleBtn = !!toggleBtn;
          results.initCollapsed = overlay?.classList.contains('collapsed');
          toggleBtn?.click();
          results.afterClickCollapsed = overlay?.classList.contains('collapsed');
          toggleBtn?.click(); // mở lại

          return JSON.stringify(results);
        })()
      `,
      returnByValue: true
    });

    console.log('Test Results:', JSON.stringify(testRes));

    // Chụp screenshot để kiểm chứng
    const snapRes = await send('Page.captureScreenshot', { format: 'png' });
    if (snapRes.result && snapRes.result.data) {
      fs.writeFileSync('C:\\Users\\Hoanpn\\My Drive\\3D Thiết kế\\solar-3d-simulator\\tools\\screenshot_v116.png', Buffer.from(snapRes.result.data, 'base64'));
      console.log('Screenshot saved to tools/screenshot_v116.png');
    }

    ws.close();
    chromeProc.kill();
    server.close();
  } catch (err) {
    console.error('Test error:', err);
    server.close();
  }
});
