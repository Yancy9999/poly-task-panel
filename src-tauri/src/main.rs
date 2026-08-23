// 防止 Windows 上额外弹一个控制台窗口（windows_subsystem 在 lib.rs 里统一设置）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    poly_task_panel_lib::main()
}
