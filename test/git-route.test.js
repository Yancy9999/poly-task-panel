'use strict';
// /api/projects/:id/git/* 路由：status/stage/commit/log/diff/branches/checkout/push/pull。
// 用临时目录 git init 构造真实仓库，断言：状态解析、暂存/提交闭环、日志与 diff、
// 分支切换、非 git 仓库 notRepo、路径逃逸拒绝、非法 commit hash 400。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

let srv = null;
let tmpDir, projectsFile, repoDir, noRepoDir;

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
}

before(() => {
  // 拦截 createServer 拿到实例，after 里关闭，避免 listen 挂住事件循环
  const origCreate = http.createServer;
  http.createServer = (...a) => { srv = origCreate.apply(http, a); return srv; };

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptp-git-'));
  repoDir = path.join(tmpDir, 'repo');
  noRepoDir = path.join(tmpDir, 'norepo');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(noRepoDir, { recursive: true });

  // 构造真实仓库：初始提交 + 一个已修改 + 一个未跟踪文件
  git(repoDir, 'init', '-b', 'main');
  git(repoDir, 'config', 'user.name', 'Tester');
  git(repoDir, 'config', 'user.email', 'tester@example.com');
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hello\n');
  fs.writeFileSync(path.join(repoDir, 'b.txt'), 'world\n');
  git(repoDir, 'add', '.');
  git(repoDir, 'commit', '-m', 'init commit');
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'hello changed\n');       // unstaged 修改
  fs.writeFileSync(path.join(repoDir, 'c-new.txt'), 'new file\n');        // untracked

  projectsFile = path.join(tmpDir, 'projects.json');
  fs.writeFileSync(projectsFile, JSON.stringify([
    { id: 'repo', name: 'Repo', projectPath: repoDir, type: 'folder' },
    { id: 'norepo', name: 'NoRepo', projectPath: noRepoDir, type: 'folder' },
    { id: 'missing', name: 'Missing', projectPath: path.join(tmpDir, 'no-such-xyz'), type: 'folder' },
  ], null, 2));
  process.env.PORT = '7957';
  process.env.PROJECTS_FILE = projectsFile;
  process.env.__PTP_TMPDIR__ = tmpDir;

  require('../server.js');
});

after(async () => {
  if (srv && srv.listening) await new Promise((r) => srv.close(r));
  const tmp = process.env.__PTP_TMPDIR__;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

function get(queryPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 7957, path: queryPath }, (res) => {
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
      host: '127.0.0.1', port: 7957, path: queryPath,
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

test('status: 返回分支与变更文件', async () => {
  const r = await get('/api/projects/repo/git/status');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.branch, 'main');
  const a = r.body.files.find((f) => f.file === 'a.txt');
  assert.ok(a, 'a.txt 在变更列表');
  assert.strictEqual(a.x, ' ');      // 未暂存
  assert.strictEqual(a.y, 'M');
  const c = r.body.files.find((f) => f.file === 'c-new.txt');
  assert.ok(c, 'c-new.txt（未跟踪）在变更列表');
  assert.strictEqual(c.x, '?');
});

test('status: ahead/behind 无 upstream 时为 null', async () => {
  const r = await get('/api/projects/repo/git/status');
  assert.strictEqual(r.body.ahead, null);
  assert.strictEqual(r.body.behind, null);
});

test('status: 非 git 仓库返回 notRepo', async () => {
  const r = await get('/api/projects/norepo/git/status');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.ok, false);
  assert.strictEqual(r.body.notRepo, true);
});

test('status: 项目不存在 404', async () => {
  const r = await get('/api/projects/nope/git/status');
  assert.strictEqual(r.status, 404);
});

test('stage + commit 闭环：暂存 → 状态进 staged → 提交后工作区干净', async () => {
  // 暂存 a.txt
  let r = await post('/api/projects/repo/git/stage', { files: ['a.txt'] });
  assert.strictEqual(r.body.ok, true);
  r = await get('/api/projects/repo/git/status');
  const a = r.body.files.find((f) => f.file === 'a.txt');
  assert.strictEqual(a.x, 'M');      // 已暂存
  assert.strictEqual(a.y, ' ');
  // diff --cached 应包含 a.txt
  const d = await get('/api/projects/repo/git/diff?file=' + encodeURIComponent('a.txt') + '&cached=1');
  assert.ok(d.body.diff.includes('hello changed'), 'cached diff 含新内容');
  // 提交
  r = await post('/api/projects/repo/git/commit', { message: 'test: change a.txt' });
  assert.strictEqual(r.body.ok, true);
  // 提交后 a.txt 不再出现在变更列表
  r = await get('/api/projects/repo/git/status');
  assert.strictEqual(r.body.files.find((f) => f.file === 'a.txt'), undefined);
});

test('commit: 空说明 400', async () => {
  const r = await post('/api/projects/repo/git/commit', { message: '  ' });
  assert.strictEqual(r.status, 400);
});

test('log: 返回提交历史（含刚才的提交）', async () => {
  const r = await get('/api/projects/repo/git/log');
  assert.strictEqual(r.body.ok, true);
  assert.ok(r.body.commits.length >= 2);
  assert.strictEqual(r.body.commits[0].subject, 'test: change a.txt');
  assert.ok(r.body.commits[0].hash.length >= 7);
  assert.strictEqual(r.body.commits[0].author, 'Tester');
  assert.ok(r.body.commits[0].at > 0);
  // --name-only 附带变更文件列表
  assert.deepStrictEqual(r.body.commits[0].files, ['a.txt']);
  const init = r.body.commits.find((c) => c.subject === 'init commit');
  assert.ok(init.files.includes('a.txt') && init.files.includes('b.txt'), 'init commit 文件列表');
});

test('diff: commit+file 组合看某次提交中单个文件的 diff', async () => {
  const log = await get('/api/projects/repo/git/log');
  const hash = log.body.commits[0].hash;   // test: change a.txt
  const r = await get('/api/projects/repo/git/diff?commit=' + hash + '&file=' + encodeURIComponent('a.txt'));
  assert.strictEqual(r.body.ok, true);
  assert.ok(r.body.diff.includes('a.txt'), 'diff 涉及 a.txt');
  assert.ok(!r.body.diff.includes('b.txt'), '不含其他文件');
});

test('diff: 工作区 diff 与 commit diff', async () => {
  // c-new.txt 未跟踪，git diff 不显示；对工作区整体 diff 应仍 ok
  const r = await get('/api/projects/repo/git/diff');
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(typeof r.body.diff, 'string');
  // commit diff：对上次提交做 diff 应非空
  const log = await get('/api/projects/repo/git/log');
  const hash = log.body.commits[0].hash;
  const r2 = await get('/api/projects/repo/git/diff?commit=' + hash);
  assert.strictEqual(r2.body.ok, true);
  assert.ok(r2.body.diff.includes('a.txt'));
});

test('diff: 路径逃逸拒绝 400', async () => {
  // 注意：不用 ../../etc/passwd 之类的真实系统路径——本机安全软件会在连接层
  // 直接 RST 含该特征的 HTTP 请求（与被测代码无关），用普通逃逸路径验证沙箱逻辑
  const r = await get('/api/projects/repo/git/diff?file=' + encodeURIComponent('../../outside/secret.txt'));
  assert.strictEqual(r.status, 400);
});

test('diff: 非法 commit hash 400', async () => {
  const r = await get('/api/projects/repo/git/diff?commit=' + encodeURIComponent('rm -rf; drop'));
  assert.strictEqual(r.status, 400);
});

test('branches + checkout: 列出分支并切换', async () => {
  git(repoDir, 'branch', 'feature-x');
  let r = await get('/api/projects/repo/git/branches');
  assert.strictEqual(r.body.ok, true);
  assert.ok(r.body.branches.includes('main'));
  assert.ok(r.body.branches.includes('feature-x'));
  assert.strictEqual(r.body.current, 'main');
  // 切换
  r = await post('/api/projects/repo/git/checkout', { branch: 'feature-x' });
  assert.strictEqual(r.body.ok, true);
  r = await get('/api/projects/repo/git/status');
  assert.strictEqual(r.body.branch, 'feature-x');
  // 切回 main，清理
  await post('/api/projects/repo/git/checkout', { branch: 'main' });
  r = await get('/api/projects/repo/git/status');
  assert.strictEqual(r.body.branch, 'main');
});

test('stage: 空 files 400', async () => {
  const r = await post('/api/projects/repo/git/stage', { files: [] });
  assert.strictEqual(r.status, 400);
});

test('stage: 非 git 仓库返回 notRepo', async () => {
  const r = await post('/api/projects/norepo/git/stage', { files: ['x'] });
  assert.strictEqual(r.body.ok, false);
  assert.strictEqual(r.body.notRepo, true);
});

test('discard: 撤销未提交修改恢复到 HEAD（不可逆丢弃）', async () => {
  // 造一个未提交修改 → discard → 内容与状态都恢复
  const target = path.join(repoDir, 'b.txt');
  fs.writeFileSync(target, 'local edit\n');
  const before = await get('/api/projects/repo/git/status');
  assert.ok(before.body.files.some((f) => f.file === 'b.txt'), 'b.txt 在变更列表');
  const r = await post('/api/projects/repo/git/discard', { file: 'b.txt' });
  assert.strictEqual(r.body.ok, true);
  // Windows 上 core.autocrlf 会在 checkout 时把 LF 转 CRLF，比对前归一化
  const content = fs.readFileSync(target, 'utf-8').replace(/\r\n/g, '\n');
  assert.strictEqual(content, 'world\n', '内容恢复到 HEAD');
  const after = await get('/api/projects/repo/git/status');
  assert.strictEqual(after.body.files.find((f) => f.file === 'b.txt'), undefined, '变更消失');
});

test('discard: 空文件 400', async () => {
  const r = await post('/api/projects/repo/git/discard', { file: '' });
  assert.strictEqual(r.status, 400);
});

test('fetch: 无远端时静默成功（git fetch 对无 origin 的仓库是 no-op，退出码 0）', async () => {
  const r = await post('/api/projects/repo/git/fetch');
  assert.strictEqual(r.body.ok, true);
  // 有伪 origin 配置的仓库（undo 测试残留已清理，这里仅验证路由通路）
  // fetch 后 status 仍正常
  const st = await get('/api/projects/repo/git/status');
  assert.strictEqual(st.body.ok, true);
});

test('项目目录不存在 404', async () => {
  const r = await get('/api/projects/missing/git/status');
  assert.strictEqual(r.status, 404);
});

test('status: ahead/behind 从分支行解析（放最后：会提交并伪造 upstream）', async () => {
  // 本地领先 1：提交 c-new.txt 并伪造远端指针在 HEAD~1。
  // --set-upstream-to 要求 origin 是完整配置的 remote（有 url/fetch spec），
  // 所以先补 remote 配置再建 tracking。
  git(repoDir, 'add', '.');
  git(repoDir, 'commit', '-m', 'ahead test');
  git(repoDir, 'update-ref', 'refs/remotes/origin/main', 'HEAD~1');
  git(repoDir, 'config', 'remote.origin.url', 'https://example.com/repo.git');
  git(repoDir, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  git(repoDir, 'branch', '--set-upstream-to=origin/main', 'main');
  let r = await get('/api/projects/repo/git/status');
  assert.strictEqual(r.body.ahead, 1, '本地领先 1');
  assert.strictEqual(r.body.behind, null);
  // 远端指针追平 HEAD：ahead 归 null
  git(repoDir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  r = await get('/api/projects/repo/git/status');
  assert.strictEqual(r.body.ahead, null, '同步后 ahead 归 null');
  // 清理 upstream，不留测试痕迹
  git(repoDir, 'branch', '--unset-upstream', 'main');
  git(repoDir, 'update-ref', '-d', 'refs/remotes/origin/main');
});

test('log: pushed 标记区分已推送/未推送（放最后：依赖 upstream 伪造）', async () => {
  // 伪造远端在 HEAD~2（HEAD 与 HEAD~1 未推送），配置 upstream
  git(repoDir, 'update-ref', 'refs/remotes/origin/main', 'HEAD~2');
  git(repoDir, 'config', 'remote.origin.url', 'https://example.com/repo.git');
  git(repoDir, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  git(repoDir, 'branch', '--set-upstream-to=origin/main', 'main');
  const r = await get('/api/projects/repo/git/log');
  assert.strictEqual(r.body.ok, true);
  const [head, head1] = r.body.commits;
  assert.strictEqual(head.pushed, false, '最新提交未推送');
  assert.strictEqual(head1.pushed, false, '次新提交未推送');
  assert.strictEqual(r.body.commits[2].pushed, true, '更早提交已推送');
  // 无 upstream：全部 pushed=false
  git(repoDir, 'branch', '--unset-upstream', 'main');
  git(repoDir, 'update-ref', '-d', 'refs/remotes/origin/main');
  const r2 = await get('/api/projects/repo/git/log');
  assert.ok(r2.body.commits.every(c => c.pushed === false), '无 upstream 全部视为未推送');
});

test('undo-commit: 无 upstream 拒绝撤回', async () => {
  const before = git(repoDir, 'rev-parse', 'HEAD').trim();
  const r = await post('/api/projects/repo/git/undo-commit');
  assert.strictEqual(r.body.ok, false);
  assert.ok(/upstream/i.test(r.body.msg), '提示缺 upstream');
  // HEAD 未变（拒绝时不产生副作用）
  assert.strictEqual(git(repoDir, 'rev-parse', 'HEAD').trim(), before);
});

test('undo-commit: 软撤回最新未推送提交（放最后：会伪造 upstream 并改写 HEAD）', async () => {
  // 伪造远端在 HEAD~1（只有 HEAD 未推送），配置 upstream
  git(repoDir, 'update-ref', 'refs/remotes/origin/main', 'HEAD~1');
  git(repoDir, 'config', 'remote.origin.url', 'https://example.com/repo.git');
  git(repoDir, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  git(repoDir, 'branch', '--set-upstream-to=origin/main', 'main');
  const headBefore = git(repoDir, 'rev-parse', 'HEAD').trim();
  const r = await post('/api/projects/repo/git/undo-commit');
  assert.strictEqual(r.body.ok, true);
  // HEAD 回退一条
  const headAfter = git(repoDir, 'rev-parse', 'HEAD').trim();
  assert.notStrictEqual(headAfter, headBefore, 'HEAD 已回退');
  assert.strictEqual(headAfter, git(repoDir, 'rev-parse', headBefore + '~1').trim(), 'HEAD 变为原提交的父');
  // 软撤回：原提交的改动回到已暂存区（status 里 c-new.txt 应为已暂存 A）
  const st = await get('/api/projects/repo/git/status');
  const c = st.body.files.find((f) => f.file === 'c-new.txt');
  assert.ok(c, 'c-new.txt 回到变更列表');
  assert.strictEqual(c.x, 'A', '改动在已暂存区');
  // 历史少一条且原 hash 不在
  const log = await get('/api/projects/repo/git/log');
  assert.ok(!log.body.commits.some((x) => x.hash === headBefore.slice(0, 7) || headBefore.startsWith(x.hash)), '原提交从历史消失');
  // 已推送场景拒绝：远端追平 HEAD 后再撤回应被拒（upstream 不是 HEAD~1 的祖先）
  git(repoDir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const r2 = await post('/api/projects/repo/git/undo-commit');
  assert.strictEqual(r2.body.ok, false, '已推送场景拒绝');
  // 清理 upstream，不留测试痕迹
  git(repoDir, 'branch', '--unset-upstream', 'main');
  git(repoDir, 'update-ref', '-d', 'refs/remotes/origin/main');
});

// ---------------------------------------------------------------------------
// git init / remote-url / remote-set：非仓库初始化与远端配置闭环
// ---------------------------------------------------------------------------

test('init: 非仓库目录 git init 后 status 恢复正常（初始化闭环）', async () => {
  // 前置：确认当前 notRepo
  const r0 = await get('/api/projects/norepo/git/status');
  assert.strictEqual(r0.body.notRepo, true, '初始为非仓库');
  // init
  const r = await post('/api/projects/norepo/git/init');
  assert.strictEqual(r.body.ok, true, 'init 成功');
  // status 恢复：空仓库、零提交、文件全为 untracked
  const st = await get('/api/projects/norepo/git/status');
  assert.strictEqual(st.body.ok, true, 'init 后 status 正常');
  assert.ok(!st.body.notRepo);
  assert.strictEqual(st.body.branch, 'master', '默认分支 master（本机 git 默认）');
  assert.ok(Array.isArray(st.body.files), 'files 为数组（空仓库可为空或含未跟踪文件）');
});

test('remote-url: 无 origin 时返回 url:null', async () => {
  // 前置：undo-commit 测试会经 git config 写入 remote.origin.url（非真 remote），先清掉
  try { git(repoDir, 'config', '--unset', 'remote.origin.url'); } catch (_) {}
  try { git(repoDir, 'config', '--unset', 'remote.origin.fetch'); } catch (_) {}
  try { git(repoDir, 'remote', 'remove', 'origin'); } catch (_) {}
  const r = await get('/api/projects/repo/git/remote-url');
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(r.body.url, null, 'repo 未配置 origin');
});

test('remote-set: 首次 add origin，remote-url 回读一致', async () => {
  const r = await post('/api/projects/repo/git/remote-set', { url: 'https://example.com/yancy/demo.git' });
  assert.strictEqual(r.body.ok, true);
  const g = await get('/api/projects/repo/git/remote-url');
  assert.strictEqual(g.body.url, 'https://example.com/yancy/demo.git', '回读到新地址');
  // git 侧真实生效
  assert.strictEqual(git(repoDir, 'remote', 'get-url', 'origin').trim(), 'https://example.com/yancy/demo.git');
});

test('remote-set: 已有 origin 时改为 set-url（不报 already exists）', async () => {
  const r = await post('/api/projects/repo/git/remote-set', { url: 'https://example.com/yancy/demo2.git' });
  assert.strictEqual(r.body.ok, true, '重复设置走 set-url');
  const g = await get('/api/projects/repo/git/remote-url');
  assert.strictEqual(g.body.url, 'https://example.com/yancy/demo2.git', '地址已更新');
});

test('remote-set: 空 URL 400', async () => {
  const r = await post('/api/projects/repo/git/remote-set', { url: '  ' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.ok, false);
});

test('remote-set: URL 不经 shell，特殊字符原样保存', async () => {
  const weird = 'https://user:p@ss w$rd@example.com/x y.git';
  const r = await post('/api/projects/repo/git/remote-set', { url: weird });
  assert.strictEqual(r.body.ok, true);
  const g = await get('/api/projects/repo/git/remote-url');
  assert.strictEqual(g.body.url, weird, '特殊字符原样保存');
});

test('remote-url: 非仓库返回 notRepo（norepo 在 init 前已测，此处对 missing 目录 404）', async () => {
  const r = await get('/api/projects/missing/git/remote-url');
  assert.strictEqual(r.status, 404);
});

// 清理：删掉测试配置的 origin，不污染后续测试运行（repo 目录在 after 中删除，此处防御性清理）
test('cleanup: 移除 repo 的 origin', async () => {
  git(repoDir, 'remote', 'remove', 'origin');
  const g = await get('/api/projects/repo/git/remote-url');
  assert.strictEqual(g.body.url, null, 'origin 已清除');
});
