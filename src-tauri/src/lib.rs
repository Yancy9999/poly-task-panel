// Tauri WebView 壳：启动 Node 后端 + 开 WebView2 窗口 + 关窗杀进程树。
//
// 架构：
//   1. setup() 里用 0 端口让 OS 分配空闲端口，再把该端口传给 `node server.js --port=N`
//   2. 把 node 进程绑进 Job Object（JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE），
//      这样壳进程无论怎么退出——正常关窗、崩溃、被 taskkill /F 强杀——
//      OS 都会自动杀光 node 及其子孙（mvn/java/vite），绝不留孤儿占端口。
//   3. 轮询 TCP 连接等待 server 起来（超时 10s）
//   4. WebView2 窗口加载 http://localhost:N/  —— 前端 0 改动（location.host/ws 全部正确）
//
// 为什么要 Job Object：Rust 的 Child / RunEvent::Exit 都只在"正常退出"时有机会清理；
// 壳被强杀或崩溃时这些回调不执行，node 就会变孤儿。Job Object 是内核级绑定，
// 父进程一死内核自动回收子树，是 Windows 上唯一可靠的同生共死机制。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent};

// Windows: 从 GUI 进程（windows_subsystem = "windows"）spawn 控制台程序（node.exe）
// 时，OS 会给子进程新分配一个控制台窗口，于是安装后用户看到一个多余的黑窗口。
// CREATE_NO_WINDOW（0x08000000）让子进程继承父进程的控制台——而父进程是 GUI
// 程序没有控制台——等于不弹任何控制台窗口。
use std::os::windows::process::CommandExt;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::OpenProcess;
use windows_sys::Win32::System::Threading::PROCESS_SET_QUOTA;
use windows_sys::Win32::System::Threading::PROCESS_TERMINATE;

struct NodeState {
    // node 进程 PID：RunEvent::Exit 时 taskkill /T 快速收尾（Job Object 是兜底保险）
    pid: Mutex<Option<u32>>,
}

/// 创建 Job Object 并把子进程绑进去。返回 job handle，需由调用方持有
/// （handle 一旦 CloseHandle，内核就杀光 job 内所有进程——这正是我们想要的退出语义）。
/// 失败不致命：Job Object 只是兜底，绑不上时退回 Exit 时的 taskkill 路径。
fn bind_to_job(child_pid: u32) -> Option<HANDLE> {
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return None;
        }
        // KILL_ON_JOB_CLOSE：持有 job handle 的进程一退出，job 内全部进程被杀
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
        {
            CloseHandle(job);
            return None;
        }
        // 打开子进程句柄，assign 进 job
        let hproc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, child_pid);
        if hproc.is_null() {
            CloseHandle(job);
            return None;
        }
        if AssignProcessToJobObject(job, hproc) == 0 {
            CloseHandle(job);
            CloseHandle(hproc);
            return None;
        }
        // hproc 已被 job 接管，这里可关；job handle 保留，随壳进程退出自动触发 kill
        CloseHandle(hproc);
        Some(job)
    }
}

pub fn main() {
    tauri::Builder::default()
        .manage(NodeState {
            pid: Mutex::new(None),
        })
        .setup(|app| {
            // 1. 选空闲端口：bind 0 端口让 OS 分配，立即 drop 释放，再交给 node
            let listener = TcpListener::bind("127.0.0.1:0")?;
            let port = listener.local_addr()?.port();
            drop(listener);

            // 2. 定位 server.js 所在目录
            //    dev：项目根（src-tauri 的上级）
            //    release：resource_dir（构建时把 server.js/public/node_modules 打进 resources）
            let server_dir = if cfg!(debug_assertions) {
                // dev 模式 cwd = 项目根的 src-tauri，往上一级是项目根
                std::env::current_dir()?
                    .parent()
                    .map(|p| p.to_path_buf())
                    .unwrap_or_else(|| std::env::current_dir().unwrap())
            } else {
                app.path().resource_dir()?
            };

            // 3. 定位 node 可执行文件并 spawn server.js --port=<port>
            //    node-pty 是 native addon，其 .node 二进制按单一 Node ABI 编译。
            //    release 构建用打包进 resources 的固定版本 node（resources/node/node.exe），
            //    保证运行时 node ABI 与 node-pty prebuild 必然匹配，消除 ABI 错配风险。
            //    dev 构建用 PATH 上的 node（dev 机的 node 与本地 npm install 的 node-pty ABI 自匹配）。
            let node_exe = if cfg!(debug_assertions) {
                "node".to_string()
            } else {
                // resources 配置把 bundled-node/ 映射到 resource_dir/bundled-node/
                let mut p = app.path().resource_dir()?;
                p.push("bundled-node");
                p.push("node.exe");
                p.to_string_lossy().to_string()
            };

            //    CREATE_NO_WINDOW：抑制 node（控制台程序）弹出黑窗口。
            let child = std::process::Command::new(&node_exe)
                .arg("server.js")
                .arg(format!("--port={}", port))
                .current_dir(&server_dir)
                .envs(std::env::vars())
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()?;

            let pid = child.id();
            *app.state::<NodeState>().pid.lock().unwrap() = Some(pid);

            // 4. 绑 Job Object：壳一死内核自动杀 node + 其子孙（mvn/java/vite）。
            //    handle 存进 app state，存活到壳退出；丢弃也行（handle 泄漏 = job 存活到壳死，正是我们要的）。
            let _ = bind_to_job(pid);

            // 5. 轮询等 server 监听端口（最多 10s）
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if Instant::now() > deadline {
                    return Err(format!(
                        "后端 10s 内未启动 (port {})，请检查 node 是否在 PATH 中",
                        port
                    )
                    .into());
                }
                if TcpStream::connect_timeout(
                    &format!("127.0.0.1:{}", port).parse().unwrap(),
                    Duration::from_millis(200),
                )
                .is_ok()
                {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }

            // 6. 开 WebView2 窗口加载 http://localhost:<port>/
            let url = format!("http://localhost:{}/", port);
            let _win = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(url.parse().unwrap()),
            )
            .title(format!("多元任务面板 v{}", app.config().version.as_deref().unwrap_or("0.0.0")))
            // 无边框：系统标题栏去掉，由前端自绘标题栏（logo/名称/版本 + 最小化/最大化/关闭，
            // 拖动走 data-tauri-drag-region）。标题仍保留（任务栏/Alt+Tab 显示用）。
            .decorations(false)
            .shadow(true)
            .inner_size(1100.0, 680.0)
            .min_inner_size(800.0, 500.0)
            .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败")
        .run(|app_handle, event| {
            // 正常关窗走这里：taskkill /T 快速收尾。
            // 强杀/崩溃时此回调不执行，但 Job Object 会兜底杀光子树。
            //
            // /T 递归杀进程树：node 后端 spawn 的宿主项目进程（mvn/java/vite）
            // 与 claude 会话 PTY 子进程（node-pty spawn 的 claude）都是 node 的子孙，
            // 一道 /T 即连同 claude 会话一起清掉，不留孤儿。后端自身的退出钩子
            // (stopAllClaudeOnExit) 是壳层之外的二级兜底。
            if let RunEvent::Exit = event {
                let pid = app_handle.state::<NodeState>().pid.lock().unwrap().take();
                if let Some(pid) = pid {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/T", "/F", "/PID", &pid.to_string()])
                        // CREATE_NO_WINDOW：taskkill 是控制台程序，从 GUI 壳 spawn 会
                        // 弹一个一闪而过的黑框。和 setup() 里 spawn node 一样抑制掉。
                        .creation_flags(CREATE_NO_WINDOW)
                        .output();
                }
            }
        });
}
