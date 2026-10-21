// Syntax-check mọi <script> inline trong index.html (dùng cho pre-push.bat).
// Không resolve import CDN — chỉ kiểm tra cú pháp. Exit 1 nếu có lỗi.
import { readFileSync, writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const html = readFileSync('index.html', 'utf8');
let failed = false;

const importmap = html.match(/<script[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/);
if (importmap) {
  try {
    const j = JSON.parse(importmap[1]);
    console.log('[OK] importmap hop le: ' + Object.keys(j.imports || {}).join(', '));
  } catch (e) {
    console.error('[LOI] importmap khong phai JSON hop le: ' + e.message);
    failed = true;
  }
} else {
  console.error('[LOI] khong tim thay <script type="importmap">');
  failed = true;
}

let checked = 0;
for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
  const attrs = m[1];
  const code = m[2];
  if (!code.trim()) continue;
  if (/\bsrc=/.test(attrs)) continue;
  if (/type=["']importmap["']/.test(attrs)) continue;

  const ext = /type=["']module["']/.test(attrs) ? '.mjs' : '.cjs';
  const dir = mkdtempSync(join(tmpdir(), 'jscheck-'));
  const file = join(dir, 'inline' + ext);
  writeFileSync(file, code);
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  const label = attrs.trim() || '(khong co thuoc tinh)';
  if (r.status !== 0) {
    console.error('[LOI] cu phap <script ' + label + '>:\n' + (r.stderr || r.stdout || 'khong ro loi'));
    failed = true;
  } else {
    console.log('[OK] <script ' + label + '> (' + code.length + ' ky tu) — cu phap hop le');
  }
  unlinkSync(file);
  checked++;
}

if (checked === 0 && !failed) {
  console.error('[LOI] khong tim thay <script> inline nao de kiem tra');
  failed = true;
}
process.exit(failed ? 1 : 0);
