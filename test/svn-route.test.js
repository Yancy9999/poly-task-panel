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

maybe('status: .svnignore 过滤 M/?/目录展开与祖先目录', async () => {
  // 准备：target 目录里一个已跟踪文件（改出 M）、一个未跟踪文件；根下未跟踪 *.tmp
  fs.mkdirSync(path.join(wcDir, 'target', 'cla', 'ss'), { recursive: true });
  fs.writeFileSync(path.join(wcDir, 'target', 'tracked.txt'), 'v1\n');
  svn(wcDir, 'add', 'target'); // 递归 add，含 tracked.txt
  svn(wcDir, 'commit', '-m', 'init: target/tracked.txt', 'target'); // 只提交 target，不污染其它用例基线
  fs.writeFileSync(path.join(wcDir, 'target', 'tracked.txt'), 'v2\n');   // M（被忽略）
  fs.writeFileSync(path.join(wcDir, 'target', 'untracked.txt'), 'new\n'); // ?（祖先被忽略）
  fs.writeFileSync(path.join(wcDir, 'target', 'cla', 'ss', 'X.class'), 'x'); // ?（更深祖先被忽略）
  fs.writeFileSync(path.join(wcDir, 'noise.tmp'), 'tmp\n');               // ?（通配符命中）
  fs.writeFileSync(path.join(wcDir, 'keep.tmp.log'), 'keep\n');           // ?（不应被误伤）
  // 无 .svnignore：全部可见（基线）。测试直接改磁盘，绕过面板写操作，需 refresh=1
  // 绕过服务端 status 缓存（真实用户走面板时写操作已自动失效缓存，无此问题）
  let r = await get('/api/projects/wc/svn/status?sync=1');
  const seen = () => r.body.files.map((f) => f.file);
  assert.ok(seen().some((f) => f.endsWith('target/tracked.txt')));
  assert.ok(seen().includes('noise.tmp'));
  // 写 .svnignore：名字规则 + dirOnly + 通配符 + 转义注释
  fs.writeFileSync(path.join(wcDir, '.svnignore'), [
    '# 注释行',
    'target/',            // dirOnly：整目录（含已跟踪 M 文件与子目录展开）
    '*.tmp',              // 通配符
    '\\#sharp',           // 行首 \# 转义：字面文件名 #sharp（不被当注释丢弃）
  ].join('\n'));
  r = await get('/api/projects/wc/svn/status?sync=1');
  assert.strictEqual(r.body.ok, true);
  assert.strictEqual(seen().some((f) => f.includes('target/')), false, 'target 下全部剔除（含 M 与 ? 展开）');
  assert.strictEqual(seen().includes('noise.tmp'), false, '通配符命中剔除');
  assert.ok(seen().includes('keep.tmp.log'), '*.tmp 不误伤 keep.tmp.log');
  // 行首 \# 转义：规则是字面文件名 #sharp 而非注释行——磁盘上建同名文件验证命中
  fs.writeFileSync(path.join(wcDir, '#sharp'), 's\n');
  r = await get('/api/projects/wc/svn/status?sync=1');
  assert.strictEqual(seen().includes('#sharp'), false, '\\#sharp 规则命中字面文件名 #sharp');
  fs.rmSync(path.join(wcDir, '#sharp'), { force: true });
  r = await get('/api/projects/wc/svn/status?sync=1');
  // .svnignore 自身也是 ? 未版本控制文件，默认可见
  assert.ok(seen().includes('.svnignore'), '.svnignore 自身不被忽略');
  // 锚定规则：'/dist' 只匹配根下 dist，不匹配子目录里的 dist
  fs.mkdirSync(path.join(wcDir, 'sub', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(wcDir, 'sub', 'dist', 'f.js'), 'f');
  fs.writeFileSync(path.join(wcDir, '.svnignore'), '/dist\n');
  r = await get('/api/projects/wc/svn/status?sync=1');
  assert.ok(seen().includes('sub/dist/f.js'), '锚定 /dist 不命中子目录 dist');
  // 根下真 dist 被忽略
  fs.mkdirSync(path.join(wcDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(wcDir, 'dist', 'out.js'), 'o');
  r = await get('/api/projects/wc/svn/status?sync=1');
  assert.strictEqual(seen().some((f) => f.startsWith('dist/')), false, '根下 dist 被锚定规则剔除');
  assert.ok(seen().includes('sub/dist/f.js'), 'sub/dist 不受影响');
  // 删 .svnignore 恢复默认行为；清理磁盘文件（target 已提交，revert M 后删目录）
  fs.rmSync(path.join(wcDir, '.svnignore'), { force: true });
  await post('/api/projects/wc/svn/revert', { files: ['target/tracked.txt'] });
  fs.rmSync(path.join(wcDir, 'target'), { recursive: true, force: true });
  fs.rmSync(path.join(wcDir, 'dist'), { recursive: true, force: true });
  fs.rmSync(path.join(wcDir, 'sub'), { recursive: true, force: true });
  fs.rmSync(path.join(wcDir, 'noise.tmp'), { force: true });
  fs.rmSync(path.join(wcDir, 'keep.tmp.log'), { force: true });
  svn(wcDir, 'update');
});

maybe('status: 祖先目录被忽略时深层未跟踪文件也剔除', async () => {
  // target/ 忽略但 target 下有已提交深层目录：展开 ? 文件靠路由的祖先目录检查剔除
  fs.mkdirSync(path.join(wcDir, 'deep-target', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(wcDir, 'deep-target', 't.txt'), 'v1\n');
  fs.writeFileSync(path.join(wcDir, 'deep-target', 'sub', 'X.txt'), 'x');
  svn(wcDir, 'add', 'deep-target');
  svn(wcDir, 'commit', '-m', 'init: deep-target', 'deep-target');
  fs.writeFileSync(path.join(wcDir, 'deep-target', 'sub', 'Y.txt'), 'y'); // ? 深层未跟踪
  fs.writeFileSync(path.join(wcDir, '.svnignore'), 'DEEP-TARGET/\n'); // 大小写不敏感规则
  let r = await get('/api/projects/wc/svn/status?sync=1');
  const seen = () => r.body.files.map((f) => f.file);
  assert.strictEqual(seen().some((f) => f.startsWith('deep-target/')), false, '祖先目录忽略剔除深层 ? 文件');
  // 清理
  fs.rmSync(path.join(wcDir, '.svnignore'), { force: true });
  svn(wcDir, 'update'); // 恢复 Y.txt 之外的基线
  fs.rmSync(path.join(wcDir, 'deep-target'), { recursive: true, force: true });
  svn(wcDir, 'update');
});

maybe('status: 返回版本与变更文件', async () => {
  const r = await get('/api/projects/wc/svn/status?sync=1');
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

maybe('status: stale-while-revalidate（refresh 秒回旧数据+后台重扫+轮询完成）', async () => {
  // delay 钩子拖慢扫描，制造确定的「重扫进行中」窗口（用完即删，不拖慢其他用例）
  process.env.__PTP_SVN_SCAN_DELAY_MS__ = '800';
  try {
    // 1) 无缓存时 refresh 同步扫（首屏路径），不带 stale
    const r1 = await get('/api/projects/wc/svn/status?sync=1');
    assert.strictEqual(r1.body.ok, true);
    assert.strictEqual(r1.body.stale, undefined, '无缓存 refresh 同步扫，不带 stale');
    // 2) 有缓存后 refresh=1：立即回旧数据 + stale 标志（手动刷新不再同步等扫描）
    const r2 = await get('/api/projects/wc/svn/status?refresh=1');
    assert.strictEqual(r2.body.ok, true);
    assert.strictEqual(r2.body.stale, true, '有缓存时 refresh 走 stale 秒回');
    assert.strictEqual(r2.body.fetchedAt, r1.body.fetchedAt, 'stale 数据就是旧缓存');
    // 2.5) 手动刷新触发的后台重扫进行中：busy=true 且 manual=true
    //（前端切回项目凭 manual 区分「用户在等」与例行重扫，前者才恢复转圈）
    let saw = null;
    for (let i = 0; i < 20 && !saw; i++) {
      const b = (await get('/api/projects/wc/svn/status-refresh-done')).body;
      if (b.busy) saw = b;
      else if (b.done) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    assert.ok(saw, '手动刷新触发的重扫进行中被轮询观察到');
    assert.strictEqual(saw.manual, true, '手动刷新的重扫 manual=true');
    // 3) 等 background 扫描完成（小仓库秒级），轮询接口报 done
    let done = false;
    for (let i = 0; i < 40 && !done; i++) {
      await new Promise((res) => setTimeout(res, 250));
      done = (await get('/api/projects/wc/svn/status-refresh-done')).body.done;
    }
    assert.strictEqual(done, true, '后台重扫完成（一次性消费）');
    // 3.5) TTL 过期触发的例行重扫：普通请求回 stale 但 manual=false（不该转圈）
    await new Promise((res) => setTimeout(res, 5500)); // 等缓存过期（TTL 5s）
    const r4 = await get('/api/projects/wc/svn/status');
    assert.strictEqual(r4.body.stale, true, 'TTL 过期普通请求回 stale');
    let saw2 = null;
    for (let i = 0; i < 20 && !saw2; i++) {
      const b = (await get('/api/projects/wc/svn/status-refresh-done')).body;
      if (b.busy) saw2 = b;
      else if (b.done) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    assert.ok(saw2, '例行重扫进行中被轮询观察到');
    assert.strictEqual(saw2.manual, false, '例行重扫 manual=false');
    // 3.6) 例行重扫期间手动刷新到来：升级为 manual（用户点了刷新在等，转圈该亮）
    await get('/api/projects/wc/svn/status?refresh=1');
    const up = (await get('/api/projects/wc/svn/status-refresh-done')).body;
    assert.strictEqual(up.busy, true, '例行重扫仍在进行（delay 钩子保证窗口）');
    assert.strictEqual(up.manual, true, '手动刷新把在跑任务升级为 manual');
    // 4) 等这轮完成，普通请求拿新缓存，无 stale
    let done2 = false;
    for (let i = 0; i < 40 && !done2; i++) {
      await new Promise((res) => setTimeout(res, 250));
      done2 = (await get('/api/projects/wc/svn/status-refresh-done')).body.done;
    }
    assert.strictEqual(done2, true, '升级后的重扫完成');
    const r5 = await get('/api/projects/wc/svn/status');
    assert.strictEqual(r5.body.stale, undefined, '重扫完成后数据新鲜');
    assert.ok(r5.body.fetchedAt >= r1.body.fetchedAt, 'fetchedAt 已更新');
  } finally {
    delete process.env.__PTP_SVN_SCAN_DELAY_MS__;
  }
  // 5) meta 接口不受缓存影响
  const m = await get('/api/projects/wc/svn/status-meta');
  assert.strictEqual(m.body.ok, true);
});

maybe('status: 缓存语义（TTL 复用 / 写操作失效 / stale 回填 / 并发去重）', async () => {
  // 建缓存：普通请求（无缓存时同步扫并回填）；后台若有残留任务先等它消化
  let r1 = await get('/api/projects/wc/svn/status');
  assert.strictEqual(r1.body.ok, true);
  assert.ok(r1.body.fetchedAt, '完整响应带 fetchedAt 时间戳');
  // 消化可能的 stale 后台任务：轮询直到 done 出现或超时，随后强制重扫一次固定基线
  for (let i = 0; i < 40; i++) {
    if (!(await get('/api/projects/wc/svn/status-refresh-done')).body.done) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  r1 = await get('/api/projects/wc/svn/status');
  let r2 = await get('/api/projects/wc/svn/status');
  assert.strictEqual(r2.body.fetchedAt, r1.body.fetchedAt, 'TTL 内普通请求复用缓存');
  // meta 接口不进缓存、不依赖缓存，秒回结构
  const m = await get('/api/projects/wc/svn/status-meta');
  assert.strictEqual(m.body.ok, true);
  assert.strictEqual(m.body.rev, r1.body.rev, 'meta rev 与完整 status 一致');
  assert.ok(m.body.url && m.body.url.startsWith('file:///'), 'meta 返回 url');
  assert.strictEqual(m.body.files, undefined, 'meta 不带变更列表');
  // 外部 svn 命令改磁盘（模拟非面板写入）→ 缓存不知道；但走面板写操作（revert）后失效
  let r3 = await post('/api/projects/wc/svn/revert', { files: ['a.txt'] });
  assert.strictEqual(r3.body.ok, true);
  let r4 = await get('/api/projects/wc/svn/status');
  assert.strictEqual(typeof r4.body.fetchedAt, 'number', '写操作后再次拉取仍带时间戳');
  // revert 后缓存已失效：新 fetchedAt 不同于旧缓存（等待 ≥1ms 保证时间戳变化）
  await new Promise((res) => setTimeout(res, 5));
  let r5 = await get('/api/projects/wc/svn/status?sync=1');
  assert.strictEqual(r5.body.fetchedAt > r1.body.fetchedAt, true, '写操作后强制重拉拿到新 fetchedAt');
  assert.strictEqual(r5.body.files.find((f) => f.file.endsWith('a.txt')), undefined, 'revert 后 a.txt 不再是 M');
  // 恢复 a.txt 修改态，供后续用例（commit: 指定文件时只提交该文件）使用
  fs.writeFileSync(path.join(wcDir, 'a.txt'), 'hello changed\n');
  await get('/api/projects/wc/svn/status?sync=1');
  // 并发去重：同时发 5 个 refresh 请求，fetchedAt 一致（共享同一次真扫描）
  const results = await Promise.all([
    get('/api/projects/wc/svn/status?sync=1'),
    get('/api/projects/wc/svn/status'),
    get('/api/projects/wc/svn/status'),
    get('/api/projects/wc/svn/status'),
    get('/api/projects/wc/svn/status'),
  ]);
  const stamps = new Set(results.map((x) => x.body.fetchedAt));
  assert.strictEqual(stamps.size, 1, '并发请求共享同一次扫描结果');
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
  r = await get('/api/projects/wc/svn/status?sync=1');
  const c = r.body.files.find((f) => f.file.endsWith('c-new.txt'));
  assert.strictEqual(c.st, 'A');
  // 提交（只提交 c-new.txt：SVN 无暂存区，files 非空 = 只提交指定文件）
  r = await post('/api/projects/wc/svn/commit', { message: 'test: add c-new.txt', files: ['c-new.txt'] });
  assert.strictEqual(r.body.ok, true);
  assert.ok(r.body.rev, '提交成功返回新版本号');
  // 提交后 c-new.txt 不再出现在变更列表
  r = await get('/api/projects/wc/svn/status?sync=1');
  assert.strictEqual(r.body.files.find((f) => f.file.endsWith('c-new.txt')), undefined);
});

maybe('status: 未版本控制目录展开为目录内具体文件', async () => {
  // 构造嵌套未版本控制目录：newpkg/f1.js、newpkg/sub/f2.js
  fs.mkdirSync(path.join(wcDir, 'newpkg', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(wcDir, 'newpkg', 'f1.js'), 'one\n');
  fs.writeFileSync(path.join(wcDir, 'newpkg', 'sub', 'f2.js'), 'two\n');
  const r = await get('/api/projects/wc/svn/status?sync=1');
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
  r = await get('/api/projects/wc/svn/status?sync=1');
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
  r = await get('/api/projects/wc/svn/status?sync=1');
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
