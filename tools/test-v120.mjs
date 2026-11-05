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

server.listen(8126, '127.0.0.1', async () => {
  try {
    const chromePath = findChrome();
    const port = 9452;
    const tmpDir = 'C:\\Users\\Hoanpn\\AppData\\Local\\Temp\\chrome_cdp_test_v120_' + Date.now(); // profile mới mỗi lần chạy — tránh Chrome HTTP cache phục vụ HTML stale
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const chromeProc = spawn(chromePath, [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${tmpDir}`,
      '--window-size=1360,920',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      'http://127.0.0.1:8126/'
    ]);

    await new Promise(r => setTimeout(r, 2000));

    const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
    const data = await listRes.json();
    const target = data.find(t => t.type === 'page' && t.url.includes('8126'));
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
          const solar = window.__solar;
          const state = solar.state;

          // --- 1. TEST TÍNH NĂNG 1: Góc nghiêng tối ưu (13°) & Hiệu suất đón quang năng ---
          // Chuyển sang mái bằng có khung sắt
          state.roofType = "bang";
          state.mount = "khungsat";
          state.rackTilt = 18;
          solar.applyState(solar.collectState());

          const optTiltBtn = document.getElementById("optTiltBtn");
          const optTiltBadge = document.getElementById("optTiltBadge");
          results.hasOptTiltBtn = !!optTiltBtn;
          results.badgeBeforeOpt = optTiltBadge ? optTiltBadge.textContent : null;

          // Click nút góc tối ưu
          if (optTiltBtn) optTiltBtn.click();
          results.rackTiltAfterClick = state.rackTilt;
          results.badgeAfterOpt = optTiltBadge ? optTiltBadge.textContent : null;
          results.solarFactorAt13 = (state.mount === "khungsat" && state.rackTilt === 13);

          // Kiểm tra hiển thị % đón nắng trong summary
          const summaryEl = document.getElementById("summary");
          results.summaryTextContainsSolar = summaryEl ? summaryEl.textContent.includes("Đón nắng") : false;

          // --- 2. TEST TÍNH NĂNG 2: Đường biên an toàn mép mái (Setback 0.40m) ---
          results.hasSetbackCheck = !!document.getElementById("setbackCheck");
          results.defaultShowSetback = state.showSetback;

          // Kiểm tra cảnh báo khi đặt chuỗi sát mép mái
          state.strings = [{
            id: 1, slopeKey: "bang", count: 6, dir: "doc", rot: 0,
            cx: state.houseW / 2 - 0.2, // rất sát mép mái
            cy: 0, disabled: []
          }];
          solar.refreshAll();
          const summaryAfterBadSetback = document.getElementById("summary")?.innerHTML || "";
          results.hasSetbackWarning = summaryAfterBadSetback.includes("Hành lang gió bão");

          // Đưa chuỗi lùi vào giữa an toàn
          state.strings[0].cx = 0;
          solar.refreshAll();
          const summaryAfterGoodSetback = document.getElementById("summary")?.innerHTML || "";
          results.clearedSetbackWarning = !summaryAfterGoodSetback.includes("Hành lang gió bão");

          // --- 3. TEST TÍNH NĂNG 3: Vật cản bồn nước Inox trên mái ---
          const bonCheck = document.getElementById("bonNuocCheck");
          const bonDetails = document.getElementById("bonNuocDetails");
          results.hasBonCheck = !!bonCheck;

          // Bật bồn nước inox
          if (bonCheck) {
            bonCheck.checked = true;
            bonCheck.dispatchEvent(new Event("change"));
          }
          results.showBonNuocInState = state.showBonNuoc;
          results.bonDetailsVisible = bonDetails ? bonDetails.style.display !== "none" : false;

          // Kiểm tra footprint của bồn nước đã được đưa vào hệ thống né vật cản
          const slopes = solar.getSlopes();
          const flatSlope = slopes.find(s => s.key === "bang");
          // Lay slots cho 1 chuỗi
          const lay = solar.layoutSlots(4, "doc", flatSlope);
          // Tìm free spot
          const freeSpot = solar.planPlacement(flatSlope, 4, "doc");
          results.canPlanPlacementWithObstacle = !!freeSpot;

          // Đổi sang bồn đứng
          const btnDung = document.getElementById("bonTypeDung");
          if (btnDung) btnDung.click();
          results.bonTypeInState = state.bonNuocType;

          return JSON.stringify(results);
        })()
      `,
      returnByValue: true
    });

    console.log('Test Results:', JSON.stringify(testRes));

    // Chụp screenshot để kiểm chứng
    const snapRes = await send('Page.captureScreenshot', { format: 'png' });
    if (snapRes.result && snapRes.result.data) {
      fs.writeFileSync('C:\\Users\\Hoanpn\\My Drive\\3D Thiết kế\\solar-3d-simulator\\tools\\screenshot_v120.png', Buffer.from(snapRes.result.data, 'base64'));
      console.log('Screenshot saved to tools/screenshot_v120.png');
    }

    ws.close();
    chromeProc.kill();
    server.close();
  } catch (err) {
    console.error('Test error:', err);
    server.close();
  }
});
