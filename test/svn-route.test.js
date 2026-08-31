'use strict';
// /api/projects/:id/svn/* 路由：status/update/add/commit/revert/log/diff。
// 用 svnadmin create 构造本地仓库 + file:/// checkout 出真实工作副本，断言：
// 状态解析、add/commit 闭环、日志与 diff、revert、非 SVN 工作副本 notRepo、
// 路径逃逸拒绝、非法版本号 400。环境无 svn 命令行时整组跳过。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

let srv = null;
let tmpDir, projectsFile, wcDir, noRepoDir;
let svnAvailable = true;

function svn(cwd, ...args) {
  return execFileSync('svn', ['--non-interactive', ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
}

before(() => {
  // 拦截 createServer 拿到实例，after 里关闭，避免 listen 挂住事件循环
  const origCreate = http.createServer;
  http.createServer = (...a) => { srv = origCreate.apply(http, a); return srv; };

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-svn-'));
  wcDir = path.join(tmpDir, 'wc');
  noRepoDir = path.join(tmpDir, 'norepo');
  fs.mkdirSync(wcDir, { recursive: true });
  fs.mkdirSync(noRepoDir, { recursive: true });

  try {
    // 构造真实工作副本：本地 file:/// 仓库 → checkout 到 wcDir → 初始提交 + 一个已修改 + 一个未跟踪文件
    const repoPath = path.join(tmpDir, 'repo').replace(/\\/g, '/');
    execFileSync('svnadmin', ['create', repoPath], { stdio: 'ignore' });
    // Windows 下 file:/// URL 形如 file:///D:/path/to/repo
    const repoUrl = 'file:///' + repoPath.replace(/^([A-Za-z]:)/, '$1|').replace('|', '');
    svn(wcDir, 'checkout', repoUrl, '.');
    fs.writeFileSync(path.join(wcDir, 'a.txt'), 'hello\n');
    fs.writeFileSync(path.join(wcDir, 'b.txt'), 'world\n');
    svn(wcDir, 'add', 'a.txt', 'b.txt');
    svn(wcDir, 'commit', '-m', 'init commit');
    fs.writeFileSync(path.join(wcDir, 'a.txt'), 'hello changed\n');   // 已修改
    fs.writeFileSync(path.join(wcDir, 'c-new.txt'), 'new file\n');    // 未版本控制
  } catch (e) {
    svnAvailable = false;
  }

  projectsFile = path.join(tmpDir, 'projects.json');
  fs.writeFileSync(projectsFile, JSON.stringify([
    { id: 'wc', name: 'WC', projectPath: wcDir, type: 'folder' },
    { id: 'norepo', name: 'NoRepo', projectPath: noRepoDir, type: 'folder' },
    { id: 'missing', name: 'Missing', projectPath: path.join(tmpDir, 'no-such-xyz'), type: 'folder' },
  ], null, 2));
  process.env.PORT = '7958';
  process.env.PROJECTS_FILE = projectsFile;
  process.env.__PTP_TMPDIR__ = tmpDir;

  require('../server.js');
});

after(async () => {
  if (srv && srv.listening) await new Promise((r) => srv.close(r));
  // svn 工作副本带只读 .svn 元数据，Windows 上常规 rm 会失败，先清只读位再删
  try {
    execFileSync('attrib', ['-r', path.join(tmpDir, '*'), '/s', '/d']);
  } catch (e) { /* 非 Windows 无 attrib，直接删 */ }
  const tmp = process.env.__PTP_TMPDIR__;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

function get(queryPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 7958, path: queryPath }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}
function post(queryPath, data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data || {});
    const req = http.request({
      host: '127.0.0.1', port: 7958, path: queryPath,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// 无 svn 环境（CI 最小镜像等）：只跑 notRepo/404 这类不依赖工作副本的用例
const maybe = svnAvailable ? test : test.skip;

maybe('status: 返回版本与变更文件', async () => {
  const r = await get('/api/projects/wc/svn/status');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.ok(/^\d+$/.test(r.body.rev), 'rev 为数字');
  assert.ok(r.body.url && r.body.url.startsWith('file:///'), 'url 为仓库地址');
  const a = r.body.files.find((f) => f.file.endsWith('a.txt'));
  assert.ok(a, 'a.txt 在变更列表');
  assert.strictEqual(a.st, 'M');
  const c = r.body.files.find((f) => f.file.endsWith('c-new.txt'));
  assert.ok(c, 'c-new.txt（未版本控制）在变更列表');
  assert.strictEqual(c.st, '?');
});

test('status: 非 SVN 工作副本返回 notRepo', async () => {
  const r = await get('/api/projects/norepo/svn/status');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, false);
  assert.strictEqual(r.body.notRepo, true);
});

test('status: 项目不存在 404', async () => {
  const r = await get('/api/projects/nope/svn/status');
  assert.strictEqual(r.status, 404);
});

maybe('add + commit 闭环：add → 状态 ? 变 A → 提交后回到干净', async () => {
  // add c-new.txt
  let r = await post('/api/projects/wc/svn/add', { files: ['c-new.txt'] });
  assert.strictEqual(r.body.ok, true);
  r = await get('/api/projects/wc/svn/status');
  const c = r.body.files.find((f) => f.file.endsWith('c-new.txt'));
  assert.strictEqual(c.st, 'A');
  // 提交（只提交 c-new.txt：SVN 无暂存区，files 非空 = 只提交指定文件）
  r = await post('/api/projects/wc/svn/commit', { message: 'test: add c-new.txt', files: ['c-new.txt'] });
  assert.strictEqual(r.body.ok, true);
  assert.ok(r.body.rev, '提交成功返回新版本号');
  // 提交后 c-new.txt 不再出现在变更列表
  r = await get('/api/projects/wc/svn/status');
  assert.strictEqual(r.body.files.find((f) => f.file.endsWith('c-new.txt')), undefined);
});

maybe('status: 未版本控制目录展开为目录内具体文件', async () => {
  // 构造嵌套未版本控制目录：newpkg/f1.js、newpkg/sub/f2.js
  fs.mkdirSync(path.join(wcDir, 'newpkg', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(wcDir, 'newpkg', 'f1.js'), 'one\n');
  fs.writeFileSync(path.join(wcDir, 'newpkg', 'sub', 'f2.js'), 'two\n');
  const r = await get('/api/projects/wc/svn/status');
  assert.strictEqual(r.body.ok, true);
  // 目录本身不再出现在列表（以文件为单位），目录内文件展开为独立 ? 条目
  const dirEntry = r.body.files.find((f) => f.st === '?' && (f.file === 'newpkg' || f.file === 'newpkg/'));
  assert.strictEqual(dirEntry, undefined, '? 目录条目不显示');
  const f1 = r.body.files.find((f) => f.st === '?' && f.file === 'newpkg/f1.js');
  assert.ok(f1, 'newpkg/f1.js 展开为独立条目');
  const f2 = r.body.files.find((f) => f.st === '?' && f.file === 'newpkg/sub/f2.js');
  assert.ok(f2, 'newpkg/sub/f2.js 展开为独立条目');
});

maybe('add: 目录内文件自顶向下 add（含父目录）', async () => {
  // 依赖上一用例构造的 newpkg；直接 add 目录内文件应成功（父目录自动先 add）
  let r = await post('/api/projects/wc/svn/add', { files: ['newpkg/f1.js', 'newpkg/sub/f2.js'] });
  assert.strictEqual(r.body.ok, true);
  r = await get('/api/projects/wc/svn/status');
  const f1 = r.body.files.find((f) => f.file === 'newpkg/f1.js');
  assert.ok(f1 && f1.st === 'A', 'newpkg/f1.js 变 A');
  const f2 = r.body.files.find((f) => f.file === 'newpkg/sub/f2.js');
  assert.ok(f2 && f2.st === 'A', 'newpkg/sub/f2.js 变 A');
  // 清理：revert 整目录并删除磁盘文件，不影响后续用例
  await post('/api/projects/wc/svn/revert', { files: ['newpkg'] });
  fs.rmSync(path.join(wcDir, 'newpkg'), { recursive: true, force: true });
  const s = await get('/api/projects/wc/svn/status');
  assert.strictEqual(s.body.files.find((f) => f.file.includes('newpkg')), undefined);
});

maybe('commit: 空说明 400', async () => {
  const r = await post('/api/projects/wc/svn/commit', { message: '  ' });
  assert.strictEqual(r.status, 400);
});

maybe('commit: 指定文件时只提交该文件', async () => {
  // a.txt 是已修改状态；commit 只带 a.txt 不应影响其他（当前无其他变更，验证提交成功即可）
  const r = await post('/api/projects/wc/svn/commit', { message: 'test: change a.txt', files: ['a.txt'] });
  assert.strictEqual(r.body.ok, true);
  const s = await get('/api/projects/wc/svn/status');
  assert.strictEqual(s.body.files.find((f) => f.file.endsWith('a.txt')), undefined);
});

maybe('log: 返回提交历史（含刚才的提交）', async () => {
  const r = await get('/api/projects/wc/svn/log');
  assert.strictEqual(r.body.ok, true);
  assert.ok(r.body.commits.length >= 3);
  assert.strictEqual(r.body.commits[0].subject, 'test: change a.txt');
  assert.ok(r.body.commits[0].rev, 'rev 非空');
  assert.ok(r.body.commits[0].at > 0);
  // -v 附带变更文件列表
  assert.ok(r.body.commits[0].files.some((f) => f.file.endsWith('a.txt')), '变更文件列表含 a.txt');
  const init = r.body.commits.find((c) => c.subject === 'init commit');
  assert.ok(init.files.some((f) => f.file.endsWith('a.txt')), 'init commit 文件列表');
});

maybe('commit: 新增目录中的文件自动补齐 A 祖先目录（E200009）', async () => {
  // 复现：新目录 nested/deep/ 下 add 文件，只提交文件本身 →
  // svn 拒绝（父目录未随提交，E200009 not known to exist），后端应自动补齐
  fs.mkdirSync(path.join(wcDir, 'nested', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(wcDir, 'nested', 'deep', 'n.txt'), 'nested new\n');
  const add = await post('/api/projects/wc/svn/add', { files: ['nested/deep/n.txt'] });
  assert.strictEqual(add.body.ok, true);
  const r = await post('/api/projects/wc/svn/commit', { message: 'test: nested commit', files: ['nested/deep/n.txt'] });
  assert.strictEqual(r.body.ok, true, '提交成功: ' + (r.body.msg || ''));
  assert.ok(r.body.rev, '有新版本号');
  const s = await get('/api/projects/wc/svn/status');
  assert.strictEqual(s.body.files.find((f) => f.file.startsWith('nested/')), undefined, '提交后 nested 无残留变更');
});

maybe('diff: 工作区 diff 与 -c <rev> 提交 diff', async () => {
  // 造一个未提交修改后看工作区 diff
  fs.writeFileSync(path.join(wcDir, 'b.txt'), 'world changed\n');
  const r = await get('/api/projects/wc/svn/diff?file=' + encodeURIComponent('b.txt'));
  assert.strictEqual(r.body.ok, true);
  assert.ok(r.body.diff.includes('world changed'), '工作区 diff 含新内容');
  // -c <rev>：看 a.txt 那次提交自身的变更（nested 用例在 log 之后又提交过，不能取最新一条）
  const log = await get('/api/projects/wc/svn/log');
  const rev = log.body.commits.find((c) => c.subject === 'test: change a.txt').rev;
  const r2 = await get('/api/projects/wc/svn/diff?rev=' + rev + '&file=' + encodeURIComponent('a.txt'));
  assert.strictEqual(r2.body.ok, true);
  assert.ok(r2.body.diff.includes('a.txt'), '提交 diff 涉及 a.txt');
  assert.ok(!r2.body.diff.includes('b.txt'), '不含其他文件');
  // 该修改保留给 revert 用例（验证 revert 恢复到 BASE 内容）
});

maybe('diff: 路径逃逸拒绝 400', async () => {
  // 注意：不用 ../../etc/passwd 之类的真实系统路径——本机安全软件会在连接层
  // 直接 RST 含该特征的 HTTP 请求（与被测代码无关），用普通逃逸路径验证沙箱逻辑
  const r = await get('/api/projects/wc/svn/diff?file=' + encodeURIComponent('../../outside/secret.txt'));
  assert.strictEqual(r.status, 400);
});

maybe('diff: 非法版本号 400', async () => {
  const r = await get('/api/projects/wc/svn/diff?rev=' + encodeURIComponent('rm -rf; drop'));
  assert.strictEqual(r.status, 400);
});

maybe('revert: 撤销未提交修改，工作区恢复 BASE', async () => {
  // 前置：diff 用例刚把 b.txt 改成 'world changed\n'（未提交），BASE 是 'world\n'
  fs.writeFileSync(path.join(wcDir, 'b.txt'), 'will be reverted\n');
  let r = await post('/api/projects/wc/svn/revert', { files: ['b.txt'] });
  assert.strictEqual(r.body.ok, true);
  r = await get('/api/projects/wc/svn/status');
  assert.strictEqual(r.body.files.find((f) => f.file.endsWith('b.txt')), undefined, 'revert 后 b.txt 不再在变更列表');
  assert.strictEqual(fs.readFileSync(path.join(wcDir, 'b.txt'), 'utf-8'), 'world\n');
});

maybe('revert: 未指定文件 400', async () => {
  const r = await post('/api/projects/wc/svn/revert', { files: [] });
  assert.strictEqual(r.status, 400);
});

maybe('update: 网络操作返回输出（file:/// 无新版本，输出 ok）', async () => {
  const r = await post('/api/projects/wc/svn/update', {});
  assert.strictEqual(r.body.ok, true);
  assert.ok(r.body.msg.includes('revision'), 'update 输出包含 revision');
});

// 放在其他用例之后：本组用例会真实 svn update 拉远端内容覆盖工作副本，
// 提前跑会破坏后续用例依赖的文件修改态
maybe('remote-status: 返回未更新提交条数 behind', async () => {
  // 此时工作副本与 file:/// 仓库同步：behind 为 0
  const r = await get('/api/projects/wc/svn/remote-status');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.behind, 0);
  // 从另一个 checkout 提交新版本到仓库 → 本工作副本出现远端待更新条目
  const repoUrl = (await get('/api/projects/wc/svn/status')).body.url;
  const otherDir = path.join(tmpDir, 'other-wc');
  svn(tmpDir, 'checkout', repoUrl, otherDir.replace(/\\/g, '/'));
  fs.writeFileSync(path.join(otherDir, 'b.txt'), 'from other wc\n');
  svn(otherDir, 'commit', '-m', 'remote change');
  const r2 = await get('/api/projects/wc/svn/remote-status');
  assert.strictEqual(r2.body.ok, true);
  assert.ok(r2.body.behind >= 1, '远端有新提交时 behind >= 1，实际 ' + r2.body.behind);
  // update 后同步，behind 归零（真实 svn update，验证闭环）
  const u = await post('/api/projects/wc/svn/update', {});
  assert.strictEqual(u.body.ok, true);
  const r3 = await get('/api/projects/wc/svn/remote-status');
  assert.strictEqual(r3.body.behind, 0);
});

test('remote-status: 非 SVN 工作副本返回 notRepo', async () => {
  const r = await get('/api/projects/norepo/svn/remote-status');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, false);
  assert.strictEqual(r.body.notRepo, true);
});

test('remote-status: 项目不存在 404', async () => {
  const r = await get('/api/projects/nope/svn/remote-status');
  assert.strictEqual(r.status, 404);
});
