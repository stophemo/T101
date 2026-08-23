// T101 对局助手 · 侧边停靠面板（Tauri 2 壳）
// - 无边框 / 普通窗口层级 / 跳过任务栏 的 WebView 窗口，加载本地 t101 Web 服务
// - 停靠：找到 LOL 游戏/客户端主窗口，面板贴其右侧并保持普通窗口层级；窗口铺满屏时浮于右缘
// - F9 一键排布（游戏左 2/3，面板右 1/3）· F10 停靠开关 · F12 退出
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use tauri::{Manager, State};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, EnumWindows, GetWindowRect, GetWindowThreadProcessId, IsIconic,
    IsWindowVisible, PeekMessageW, SetWindowPos, TranslateMessage, MSG, PM_REMOVE,
    SWP_NOACTIVATE, SWP_NOZORDER, SWP_SHOWWINDOW, WM_HOTKEY,
};

const SERVER_HOST: &str = "127.0.0.1";
const SERVER_PORT: u16 = 7892;
/// 跟随模式下面板宽度
const PANEL_W: i32 = 400;
/// 面板与目标窗口的间距
const MARGIN: i32 = 8;

const HOTKEY_ARRANGE: i32 = 0x1001;
const HOTKEY_DOCK: i32 = 0x1002;
const HOTKEY_QUIT: i32 = 0x1003;
const VK_F9: u32 = 0x78;
const VK_F10: u32 = 0x79;
const VK_F12: u32 = 0x7B;

/// HWND 在线程间共享（句柄值本身是安全的整数，仅为绕过裸指针的 Send/Sync 限制）
#[derive(Clone, Copy)]
struct Hwnd(isize);
unsafe impl Send for Hwnd {}
unsafe impl Sync for Hwnd {}
impl Hwnd {
    fn from_raw(h: HWND) -> Self {
        Hwnd(h.0 as isize)
    }
    fn to_raw(self) -> HWND {
        HWND(self.0 as *mut core::ffi::c_void)
    }
}

/// 面板停靠状态（跨线程共享）
struct Dock {
    panel: Mutex<Option<Hwnd>>,
    docked: AtomicBool,
    last: Mutex<(i32, i32, i32, i32)>,
}

impl Dock {
    fn new() -> Self {
        Self {
            panel: Mutex::new(None),
            docked: AtomicBool::new(true),
            last: Mutex::new((0, 0, 0, 0)),
        }
    }
}

/// 枚举窗口的收集结果：优先游戏主窗口，其次客户端主窗口
struct Targets {
    game: Option<HWND>,
    client: Option<HWND>,
}

unsafe extern "system" fn enum_windows(hwnd: HWND, lparam: LPARAM) -> windows::core::BOOL {
    let targets = unsafe { &mut *(lparam.0 as *mut Targets) };
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == 0 {
        return true.into();
    }
    if let Ok(handle) = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let ok = unsafe {
            QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_FORMAT(0),
                windows::core::PWSTR(buf.as_mut_ptr()),
                &mut len,
            )
        };
        let _ = unsafe { CloseHandle(handle) };
        if ok.is_ok() {
            let name = String::from_utf16_lossy(&buf[..len as usize]).to_ascii_lowercase();
            let is_game = name.ends_with("league of legends.exe");
            let is_client = name.ends_with("leagueclientux.exe");
            if is_game || is_client {
                // 客户端进程有多个顶层窗口（主窗口 + 大量不可见辅助窗口），
                // 只保留“可用”窗口（可见、未最小化、尺寸>100），否则会选中不可见窗口导致停靠失效
                let vis = unsafe { IsWindowVisible(hwnd) }.as_bool();
                let icon = unsafe { IsIconic(hwnd) }.as_bool();
                let mut r = RECT::default();
                let big = unsafe { GetWindowRect(hwnd, &mut r) }.is_ok()
                    && r.right - r.left > 100
                    && r.bottom - r.top > 100;
                if vis && !icon && big {
                    if is_game {
                        targets.game = Some(hwnd);
                    } else {
                        targets.client = Some(hwnd);
                    }
                }
            }
        }
    }
    true.into()
}

/// 找到当前应跟随的目标窗口：游戏（对局中）优先，客户端（选人/房间）其次
fn find_target() -> Option<HWND> {
    let mut targets = Targets {
        game: None,
        client: None,
    };
    unsafe {
        let _ = EnumWindows(
            Some(enum_windows),
            LPARAM(&mut targets as *mut Targets as isize),
        );
    }
    targets.game.or(targets.client)
}

fn is_usable(hwnd: HWND) -> bool {
    unsafe {
        IsWindowVisible(hwnd).as_bool()
            && !IsIconic(hwnd).as_bool()
            && {
                let mut r = RECT::default();
                GetWindowRect(hwnd, &mut r).is_ok()
                    && r.right - r.left > 100
                    && r.bottom - r.top > 100
            }
    }
}

fn work_area_of(hwnd: HWND) -> Option<RECT> {
    let mon = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    let mut mi = unsafe { std::mem::zeroed::<MONITORINFO>() };
    mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    if unsafe { GetMonitorInfoW(mon, &mut mi) }.as_bool() {
        Some(mi.rcWork)
    } else {
        None
    }
}

fn primary_work_area() -> Option<RECT> {
    work_area_of(HWND(std::ptr::null_mut()))
}

/// 计算面板位置：目标窗口右侧跟随；目标铺满屏时浮于工作区右缘；无目标回退主屏右缘
fn dock_position(target: Option<HWND>, fallback: RECT) -> (i32, i32, i32, i32) {
    if let Some(t) = target {
        if let Some(wa) = work_area_of(t) {
            let mut r = RECT::default();
            if unsafe { GetWindowRect(t, &mut r) }.is_ok() {
                let tw = r.right - r.left;
                let th = r.bottom - r.top;
                let ww = wa.right - wa.left;
                let wh = wa.bottom - wa.top;
                if tw >= ww - 4 && th >= wh - 4 {
                    // 全屏/最大化：浮于工作区右缘（盖在游戏右缘上）
                    return (wa.right - PANEL_W - MARGIN, wa.top, PANEL_W, wh);
                }
                if tw > 200 && th > 200 {
                    let y = r.top.max(wa.top);
                    let h = th.min(wa.bottom - wa.top);
                    return (r.right + MARGIN, y, PANEL_W, h);
                }
            }
        }
    }
    (
        fallback.right - PANEL_W - MARGIN,
        fallback.top,
        PANEL_W,
        fallback.bottom - fallback.top,
    )
}

fn set_window_pos(hwnd: HWND, x: i32, y: i32, w: i32, h: i32, show: bool) {
    unsafe {
        let _ = SetWindowPos(
            hwnd,
            None,
            x,
            y,
            w,
            h,
            SWP_NOZORDER
                | SWP_NOACTIVATE
                | if show { SWP_SHOWWINDOW } else { SWP_NOZORDER },
        );
    }
}

/// 停靠跟随（250ms 节拍调用，位置未变时零开销）
fn apply_dock(dock: &Dock, forced: bool) {
    if !forced && !dock.docked.load(Ordering::Relaxed) {
        return;
    }
    let Some(panel) = *dock.panel.lock().unwrap() else {
        return;
    };
    let panel = panel.to_raw();
    let target = find_target().filter(|h| is_usable(*h));
    let Some(fallback) = primary_work_area() else {
        return;
    };
    let pos = dock_position(target, fallback);
    let mut last = dock.last.lock().unwrap();
    if *last == pos {
        return;
    }
    set_window_pos(panel, pos.0, pos.1, pos.2, pos.3, true);
    *last = pos;
}

/// F9 / 面板按钮：一键排布
/// - 目标未铺满屏（桌面客户端/窗口化游戏）：目标窗口铺满工作区剩余区域，面板固定 400px 贴右
/// - 目标已铺满屏（游戏中无边框全屏/最大化）：**不动游戏窗口**，面板仅贴工作区右缘悬浮（对局中只看战绩）
fn arrange(dock: &Dock) {
    let Some(panel) = *dock.panel.lock().unwrap() else {
        return;
    };
    let panel = panel.to_raw();
    let Some(target) = find_target() else {
        return;
    };
    if !is_usable(target) {
        return;
    }
    let Some(wa) = work_area_of(target) else {
        return;
    };
    let ww = wa.right - wa.left;
    let wh = wa.bottom - wa.top;
    let mut tr = RECT::default();
    if !unsafe { GetWindowRect(target, &mut tr) }.is_ok() {
        return;
    }
    let tw = tr.right - tr.left;
    let th = tr.bottom - tr.top;
    if tw >= ww - 4 && th >= wh - 4 {
        // 游戏全屏：只归位面板到工作区右缘（贴屏幕，浮于游戏之上），绝不缩游戏窗口
        set_window_pos(panel, wa.right - PANEL_W - MARGIN, wa.top, PANEL_W, wh, true);
        return;
    }
    // 面板保持固定宽度，避免停靠线程下一拍又把“排布”宽度改回 400px。
    // 目标窗口占满剩余空间，面板留出小间距贴在右侧。
    let pw = PANEL_W;
    let gw = (ww - pw - MARGIN * 2).max(320);
    let px = wa.left + gw + MARGIN;
    set_window_pos(target, wa.left, wa.top, gw, wh, false);
    set_window_pos(panel, px, wa.top, pw, wh, true);
}

/// 等待本地 t101 Web 服务就绪后跳转（服务未起时停留在等待页，持续重试）
fn server_waiter(dock: Arc<Dock>, win: tauri::WebviewWindow) {
    let addr: SocketAddr = format!("{SERVER_HOST}:{SERVER_PORT}").parse().unwrap();
    let mut waited = 0u32;
    loop {
        let up = TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok();
        if up {
            std::thread::sleep(Duration::from_millis(400)); // 让服务先应答
            let url: tauri::Url = format!("http://{SERVER_HOST}:{SERVER_PORT}/")
                .parse()
                .unwrap();
            if win.navigate(url).is_ok() {
                break;
            }
        }
        waited += 1;
        if waited % 10 == 0 {
            // 服务 10s 未起，重设一次停靠位置（避免面板卡在角落）
            apply_dock(&dock, true);
        }
        std::thread::sleep(Duration::from_millis(600));
    }
}

/// 热键 + 停靠节拍循环
fn dock_thread(dock: Arc<Dock>) {
    for _ in 0..100 {
        if dock.panel.lock().unwrap().is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    unsafe {
        let r1 = RegisterHotKey(None, HOTKEY_ARRANGE, MOD_NOREPEAT, VK_F9);
        let r2 = RegisterHotKey(None, HOTKEY_DOCK, MOD_NOREPEAT, VK_F10);
        // F12 常被其他程序占用，退出用 Ctrl+Alt+F12
        let r3 = RegisterHotKey(None, HOTKEY_QUIT, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, VK_F12);
        eprintln!("[dock] hotkeys: F9={:?} F10={:?} Ctrl+Alt+F12={:?}", r1, r2, r3);
    }
    apply_dock(&dock, true);
    let mut msg: MSG = unsafe { std::mem::zeroed() };
    loop {
        let got = unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool();
        if got {
            if msg.message == WM_HOTKEY {
                eprintln!("[dock] WM_HOTKEY id={}", msg.wParam.0 as i32);
                match msg.wParam.0 as i32 {
                    HOTKEY_ARRANGE => arrange(&dock),
                    HOTKEY_DOCK => {
                        let on = !dock.docked.load(Ordering::Relaxed);
                        dock.docked.store(on, Ordering::Relaxed);
                        if on {
                            apply_dock(&dock, true);
                        }
                    }
                    HOTKEY_QUIT => std::process::exit(0),
                    _ => {}
                }
            } else {
                unsafe {
                    let _ = TranslateMessage(&msg);
                    let _ = DispatchMessageW(&msg);
                }
            }
        } else {
            apply_dock(&dock, false);
            std::thread::sleep(Duration::from_millis(250));
        }
    }
}

#[tauri::command]
fn arrange_windows(dock: State<'_, Arc<Dock>>) -> bool {
    arrange(&dock);
    true
}

#[tauri::command]
fn set_docked(dock: State<'_, Arc<Dock>>, enabled: bool) -> bool {
    dock.docked.store(enabled, Ordering::Relaxed);
    if enabled {
        apply_dock(&dock, true);
    }
    dock.docked.load(Ordering::Relaxed)
}

#[tauri::command]
fn dock_status(dock: State<'_, Arc<Dock>>) -> bool {
    dock.docked.load(Ordering::Relaxed)
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let dock = Arc::new(Dock::new());
            app.manage(dock.clone());

            let win = app.get_window("main").expect("main window");
            let hwnd = {
                let h = win
                    .window_handle()
                    .expect("window handle (Windows required)");
                match h.as_raw() {
                    RawWindowHandle::Win32(w) => HWND(w.hwnd.get() as *mut core::ffi::c_void),
                    _ => return Err("仅支持 Windows".into()),
                }
            };
            *dock.panel.lock().unwrap() = Some(Hwnd::from_raw(hwnd));

            let webview = app.get_webview_window("main").expect("main webview");
            std::thread::spawn({
                let dock = dock.clone();
                let win = webview.clone();
                move || server_waiter(dock, win)
            });
            std::thread::spawn({
                let dock = dock.clone();
                move || dock_thread(dock)
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![arrange_windows, set_docked, dock_status])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
