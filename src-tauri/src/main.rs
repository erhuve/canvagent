#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::{fs, path::{Path, PathBuf}, sync::{atomic::{AtomicBool, Ordering}, RwLock}, time::Duration};
use tauri::{menu::{Menu, MenuItem, Submenu}, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::{process::{CommandChild, CommandEvent}, ShellExt};
use tokio::sync::{oneshot, Mutex};

struct Backend {
    child: CommandChild,
    exited: oneshot::Receiver<()>,
    workspace: PathBuf,
    url: tauri::Url,
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

#[tauri::command]
fn desktop_info(app: tauri::AppHandle) -> DesktopInfo {
    DesktopInfo {
        last_workspace: recent_workspace(&app).map(|p| p.to_string_lossy().into_owned()),
        version: app.package_info().version.to_string(),
    }
}

async fn stop_backend(backend: Backend) {
    let Backend { mut child, mut exited, .. } = backend;
    let _ = child.write(b"shutdown\n");
    if tokio::time::timeout(Duration::from_secs(5), &mut exited).await.is_err() {
        let _ = child.kill();
    }
}

async fn start_workspace(app: &tauri::AppHandle, window: &WebviewWindow, path: &Path) -> Result<(), String> {
    let workspace = fs::canonicalize(path).map_err(|e| format!("Could not open that folder: {e}"))?;
    if !workspace.is_dir() { return Err("Choose a project folder.".into()); }
    let state = app.state::<DesktopState>();
    let mut running = state.backend.lock().await;
    if let Some(current) = running.as_ref() {
        if current.workspace == workspace {
            window.navigate(current.url.clone()).map_err(|e| e.to_string())?;
            return Ok(());
        }
    }
    if let Some(previous) = running.take() { stop_backend(previous).await; }
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
    *running = Some(Backend { child, exited, workspace: workspace.clone(), url: url.clone() });
    // Failure to remember a folder must not stop an otherwise working session.
    if let Ok(file) = recent_file(app) {
        if let Ok(bytes) = serde_json::to_vec(&workspace) { let _ = fs::write(file, bytes); }
    }
    window.navigate(url).map_err(|e| e.to_string())?;
    let name = workspace.file_name().unwrap_or_default().to_string_lossy();
    let _ = window.set_title(&format!("{name} — Canvagent"));
    Ok(())
}

#[tauri::command]
async fn choose_workspace(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    let choice = app.dialog().file().set_title("Open a Canvagent workspace").blocking_pick_folder();
    if let Some(choice) = choice {
        let path = choice.into_path().map_err(|e| e.to_string())?;
        start_workspace(&app, &window, &path).await?;
    }
    Ok(())
}

#[tauri::command]
async fn reopen_workspace(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    let path = recent_workspace(&app).ok_or("The previous workspace is no longer available. Choose a folder instead.")?;
    start_workspace(&app, &window, &path).await
}

#[tauri::command]
async fn quit_application(app: tauri::AppHandle) {
    let state = app.state::<DesktopState>();
    if state.closing.swap(true, Ordering::SeqCst) { return; }
    if let Some(backend) = state.backend.lock().await.take() { stop_backend(backend).await; }
    app.exit(0);
}

fn frontend_event(app: &tauri::AppHandle, name: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(&format!("window.dispatchEvent(new Event('{name}'))"));
        let _ = window.set_focus();
    }
}

fn main() {
    let app = tauri::Builder::default()
        .manage(DesktopState::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![desktop_info, choose_workspace, reopen_workspace, quit_application])
        .setup(|app| {
            let menu = Menu::default(app.handle())?;
            let open = MenuItem::with_id(app, "open-workspace", "Open Workspace…", true, Some("CmdOrCtrl+O"))?;
            menu.append(&Submenu::with_items(app, "Workspace", true, &[&open])?)?;
            app.set_menu(menu)?;
            let navigation_app = app.handle().clone();
            let external_app = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Canvagent").inner_size(1440.0, 940.0).min_inner_size(850.0, 600.0).center()
                .on_navigation(move |url| {
                    if url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost") { return true; }
                    let state = navigation_app.state::<DesktopState>();
                    if state.origin.read().unwrap().as_deref() == Some(&url.origin().ascii_serialization()) { return true; }
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
        .on_menu_event(|app, event| { if event.id().as_ref() == "open-workspace" { frontend_event(app, "canvagent:open-workspace"); } })
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
