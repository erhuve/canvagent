#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod browser;
mod notifications;
#[cfg(target_os = "macos")]
mod canvas_navigation;

use serde::Serialize;
use std::{fs, path::{Path, PathBuf}, sync::{atomic::{AtomicBool, Ordering}, RwLock}, time::Duration};
use tauri::{menu::{Menu, MenuItem, Submenu}, Manager, RunEvent, Webview, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::{process::{CommandChild, CommandEvent}, ShellExt};
use tokio::sync::{oneshot, Mutex};

struct Backend {
    child: CommandChild,
    exited: oneshot::Receiver<()>,
}

#[derive(Default)]
struct DesktopState {
    backend: Mutex<Option<Backend>>,
    origin: RwLock<Option<String>>,
    closing: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopInfo {
    last_workspace: Option<String>,
    version: String,
}

fn recent_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    Ok(directory.join("last-workspace.json"))
}

fn recent_workspace(app: &tauri::AppHandle) -> Option<PathBuf> {
    let bytes = fs::read(recent_file(app).ok()?).ok()?;
    let path: PathBuf = serde_json::from_slice(&bytes).ok()?;
    path.is_dir().then_some(path)
}

fn canonical_workspace(path: &Path) -> Result<PathBuf, String> {
    let workspace = fs::canonicalize(path).map_err(|e| format!("Could not open that folder: {e}"))?;
    if !workspace.is_dir() { return Err("Choose a project folder.".into()); }
    Ok(workspace)
}

fn remember_current_workspace(app: &tauri::AppHandle, window: &Webview, workspace: &Path) -> Result<(), String> {
    let name = workspace.file_name().unwrap_or_default().to_string_lossy();
    window.window().set_title(&format!("{name} — Canvagent")).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec(workspace).map_err(|e| e.to_string())?;
    fs::write(recent_file(app)?, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn desktop_info(app: tauri::AppHandle, webview: Webview) -> Result<DesktopInfo, String> {
    browser::require_main(&webview)?;
    Ok(DesktopInfo {
        last_workspace: recent_workspace(&app).map(|p| p.to_string_lossy().into_owned()),
        version: app.package_info().version.to_string(),
    })
}

#[tauri::command]
fn remember_workspace(app: tauri::AppHandle, window: Webview, workspace: String) -> Result<(), String> {
    browser::require_main(&window)?;
    let workspace = canonical_workspace(Path::new(&workspace))?;
    remember_current_workspace(&app, &window, &workspace)
}

async fn stop_backend(backend: Backend) {
    let Backend { mut child, mut exited, .. } = backend;
    let _ = child.write(b"shutdown\n");
    if tokio::time::timeout(Duration::from_secs(5), &mut exited).await.is_err() {
        let _ = child.kill();
    }
}

async fn start_workspace(app: &tauri::AppHandle, window: &Webview, path: &Path) -> Result<(), String> {
    let workspace = canonical_workspace(path)?;
    // Install before loading the workspace, so its first iframe navigation is
    // already frame-aware and cannot be opened externally by the main policy.
    #[cfg(target_os = "macos")]
    canvas_navigation::enable(window).await?;
    let state = app.state::<DesktopState>();
    let mut running = state.backend.lock().await;
    if running.is_some() {
        return Err("A workspace is already open. Add another project from the sidebar.".into());
    }
    *state.origin.write().unwrap() = None;

    let resources = app.path().resource_dir().map_err(|e| e.to_string())?.join("desktop");
    let data_root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&data_root).map_err(|e| e.to_string())?;
    let (mut events, child) = app.shell().sidecar("canvagent-node").map_err(|e| e.to_string())?
        .arg(resources.join("server.mjs").to_string_lossy().into_owned())
        .args(["--workspace", &workspace.to_string_lossy(), "--data-root", &data_root.to_string_lossy(), "--resources", &resources.to_string_lossy()])
        .current_dir(&workspace)
        .spawn().map_err(|e| format!("Could not start the local service: {e}"))?;

    let startup = tokio::time::timeout(Duration::from_secs(20), async {
        let mut diagnostic = String::new();
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                        if value["type"] == "ready" {
                            if let Some(url) = value["url"].as_str() {
                                let parsed = tauri::Url::parse(url).map_err(|e| e.to_string())?;
                                if parsed.scheme() == "http" && parsed.host_str() == Some("127.0.0.1") && parsed.port().is_some() { return Ok(parsed); }
                            }
                        }
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    diagnostic.push_str(&String::from_utf8_lossy(&bytes));
                    diagnostic.truncate(4000);
                }
                CommandEvent::Terminated(_) => return Err(format!("The local service stopped during startup. {diagnostic}")),
                _ => {}
            }
        }
        Err("The local service closed before it was ready.".to_string())
    }).await;
    let url = match startup {
        Ok(Ok(url)) => url,
        result => {
            let _ = child.kill();
            return Err(match result { Ok(Err(error)) => error, _ => "The local service took too long to start.".into() });
        }
    };
    let (exit_sender, exited) = oneshot::channel();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            if matches!(event, CommandEvent::Terminated(_)) { break; }
        }
        let _ = exit_sender.send(());
    });
    *state.origin.write().unwrap() = Some(url.origin().ascii_serialization());
    *running = Some(Backend { child, exited });
    // Failure to remember a folder must not stop an otherwise working session.
    let _ = remember_current_workspace(app, window, &workspace);
    window.navigate(url).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn choose_workspace(app: tauri::AppHandle, window: Webview) -> Result<Option<String>, String> {
    browser::require_main(&window)?;
    let choice = app.dialog().file().set_title("Open a Canvagent workspace").blocking_pick_folder();
    if let Some(choice) = choice {
        let path = choice.into_path().map_err(|e| e.to_string())?;
        let workspace = canonical_workspace(&path)?;
        let running = app.state::<DesktopState>().backend.lock().await.is_some();
        if running { return Ok(Some(workspace.to_string_lossy().into_owned())); }
        start_workspace(&app, &window, &workspace).await?;
    }
    Ok(None)
}

#[tauri::command]
async fn reopen_workspace(app: tauri::AppHandle, window: Webview) -> Result<(), String> {
    browser::require_main(&window)?;
    let path = recent_workspace(&app).ok_or("The previous workspace is no longer available. Choose a folder instead.")?;
    start_workspace(&app, &window, &path).await
}

#[tauri::command]
async fn quit_application(app: tauri::AppHandle, webview: Webview) -> Result<(), String> {
    browser::require_main(&webview)?;
    let state = app.state::<DesktopState>();
    if state.closing.swap(true, Ordering::SeqCst) { return Ok(()); }
    if let Some(backend) = state.backend.lock().await.take() { stop_backend(backend).await; }
    app.exit(0);
    Ok(())
}

fn frontend_event(app: &tauri::AppHandle, name: &str) {
    if let Some(window) = app.get_webview("main") {
        let _ = window.window().set_focus();
        // Native browser children share the window but keep their own first
        // responder; focus the main webview before its editor/terminal command.
        let _ = window.set_focus();
        let _ = window.eval(&format!("window.dispatchEvent(new Event('{name}'))"));
    }
}

fn main() {
    let app = tauri::Builder::default()
        .manage(DesktopState::default())
        .manage(browser::BrowserHost::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview("main") { let _ = window.window().show(); let _ = window.window().set_focus(); }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![desktop_info, choose_workspace, reopen_workspace, remember_workspace, quit_application,
            notifications::notification_permission, notifications::request_notification_permission, notifications::send_notification, notifications::focus_application,
            browser::browser_open, browser::browser_bounds, browser::browser_hide, browser::browser_close, browser::browser_action, browser::browser_state, browser::browser_annotate])
        .setup(|app| {
            notifications::listen(app.handle())?;
            let menu = Menu::default(app.handle())?;
            let open = MenuItem::with_id(app, "open-workspace", "Open Workspace…", true, Some("CmdOrCtrl+O"))?;
            menu.append(&Submenu::with_items(app, "Workspace", true, &[&open])?)?;
            let quick_open = MenuItem::with_id(app, "quick-open", "Quick Open…", true, Some("CmdOrCtrl+P"))?;
            let find_file = MenuItem::with_id(app, "find-file", "Find in File…", true, Some("CmdOrCtrl+F"))?;
            let search_files = MenuItem::with_id(app, "search-files", "Search in Files…", true, Some("CmdOrCtrl+Shift+F"))?;
            let editor_commands = MenuItem::with_id(app, "editor-commands", "Editor Commands…", true, Some("CmdOrCtrl+Shift+P"))?;
            menu.append(&Submenu::with_items(app, "Go", true, &[&quick_open, &find_file, &search_files, &editor_commands])?)?;
            let toggle_terminal = MenuItem::with_id(app, "toggle-terminal", "Toggle Terminal", true, Some("Ctrl+Backquote"))?;
            menu.append(&Submenu::with_items(app, "Terminal", true, &[&toggle_terminal])?)?;
            app.set_menu(menu)?;
            let navigation_app = app.handle().clone();
            let external_app = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Canvagent").inner_size(1440.0, 940.0).min_inner_size(850.0, 600.0).center()
                // The composer and canvas handle dropped images through HTML5
                // File objects, rather than native filesystem-path events.
                .disable_drag_drop_handler()
                .on_navigation(move |url| {
                    if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") {
                        browser::close_for_navigation(&navigation_app);
                        return true;
                    }
                    let state = navigation_app.state::<DesktopState>();
                    if state.origin.read().unwrap().as_deref() == Some(&url.origin().ascii_serialization()) {
                        browser::close_for_navigation(&navigation_app);
                        return true;
                    }
                    if matches!(url.scheme(), "https" | "http") { let _ = navigation_app.opener().open_url(url.as_str(), None::<&str>); }
                    false
                })
                .on_new_window(move |url, _| {
                    if matches!(url.scheme(), "https" | "http") { let _ = external_app.opener().open_url(url.as_str(), None::<&str>); }
                    tauri::webview::NewWindowResponse::Deny
                })
                .build()?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "open-workspace" => frontend_event(app, "canvagent:open-workspace"),
                "quick-open" => frontend_event(app, "canvagent:quick-open"),
                "find-file" => frontend_event(app, "canvagent:find-file"),
                "search-files" => frontend_event(app, "canvagent:search-files"),
                "editor-commands" => frontend_event(app, "canvagent:editor-commands"),
                "toggle-terminal" => frontend_event(app, "canvagent:toggle-terminal"),
                _ => {}
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !window.state::<DesktopState>().closing.load(Ordering::SeqCst) {
                    api.prevent_close();
                    frontend_event(window.app_handle(), "canvagent:close");
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Could not launch Canvagent");
    app.run(|app, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            if !app.state::<DesktopState>().closing.load(Ordering::SeqCst) {
                api.prevent_exit();
                frontend_event(app, "canvagent:close");
            }
        }
    });
}
