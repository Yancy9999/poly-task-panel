#!/usr/bin/env node
// fetch-node.js — 把固定版本的 node win-x64 二进制下载到 src-tauri/bundled-node/node.exe。
//
// 为什么需要：node-pty 是 native addon，打包机固化的 ABI 到用户机若 node 大版本不同
// 会 NODE_MODULE_VERSION mismatch。把固定版本 node 打进 resources，壳 release 调用
// resource_dir/bundled-node/node.exe，ABI 与 node-pty prebuild 必然匹配。
// （node-pty 实测为 N-API 构建，prebuild 跨版本稳；打包固定 node 是已确认的稳妥解。）
//
// 用法：node src-tauri/fetch-node.js [版本号，默认 v24.14.0]
// 产物：src-tauri/bundled-node/node.exe （约 40MB，已 gitignore，不入库）
//
// 应在 `tauri build` 前执行（build.bat 已接入）。
'use strict';

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

// 版本号对齐 dev 机 node（确保 dev/release 行为一致 + node-pty prebuild 匹配）。
// 可命令行覆盖：node fetch-node.js v22.11.0
const VERSION = process.argv[2] || `v${process.versions.node}`;
const OUT_DIR = path.join(__dirname, 'bundled-node');
const OUT_FILE = path.join(OUT_DIR, 'node.exe');

const URL = `https://nodejs.org/dist/${VERSION}/node-${VERSION}-win-x64.zip`;

const VERSION_FILE = path.join(OUT_DIR, '.version');

// 已下载且版本一致则跳过（避免每次 build 都重新拉 ~40MB）。
if (fs.existsSync(OUT_FILE) && fs.existsSync(VERSION_FILE)) {
  const cached = fs.readFileSync(VERSION_FILE, 'utf8').trim();
  if (cached === VERSION) {
    console.log(`[fetch-node] 已存在 ${VERSION} 的 node.exe，跳过下载`);
    return;
  }
  console.log(`[fetch-node] 版本变更 ${cached} -> ${VERSION}，重新下载`);
} else {
  console.log(`[fetch-node] 下载 ${URL}`);
}

function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirects > 5) return reject(new Error('重定向过多'));
        res.resume();
        return resolve(download(res.headers.location, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`下载失败: HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  const zip = await download(URL);
  console.log(`[fetch-node] 下载完成 ${(zip.length / 1048576).toFixed(1)}MB，解压中...`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // 用 PowerShell 的 Expand-Archive 解压（Windows 自带，无需额外依赖）
  const tmpZip = path.join(OUT_DIR, 'node.zip');
  fs.writeFileSync(tmpZip, zip);
  const tmpExtract = path.join(OUT_DIR, '_extract');
  try { fs.rmSync(tmpExtract, { recursive: true, force: true }); } catch (e) {}
  execFileSync('powershell', [
    '-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${tmpZip}' -DestinationPath '${tmpExtract}' -Force`,
  ], { stdio: 'inherit' });
  // zip 内结构：node-<ver>-win-x64/node.exe
  const sub = fs.readdirSync(tmpExtract).find((d) => d.startsWith('node-'));
  if (!sub) throw new Error('解压后未找到 node 目录');
  const srcExe = path.join(tmpExtract, sub, 'node.exe');
  if (!fs.existsSync(srcExe)) throw new Error('未找到 node.exe: ' + srcExe);
  fs.copyFileSync(srcExe, OUT_FILE);
  fs.writeFileSync(VERSION_FILE, VERSION);
  // 清理临时文件
  fs.unlinkSync(tmpZip);
  fs.rmSync(tmpExtract, { recursive: true, force: true });
  console.log(`[fetch-node] 完成 -> ${OUT_FILE} (${(fs.statSync(OUT_FILE).size / 1048576).toFixed(1)}MB)`);
})().catch((e) => {
  console.error('[fetch-node] 失败:', e.message);
  process.exit(1);
});
