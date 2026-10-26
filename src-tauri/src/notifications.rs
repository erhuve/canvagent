use tauri::{AppHandle, Manager, Webview};
use tauri_plugin_notification::{NotificationExt, PermissionState};

fn permission_name(permission: PermissionState) -> &'static str {
    match permission {
        PermissionState::Granted => "granted",
        PermissionState::Denied => "denied",
        PermissionState::Prompt | PermissionState::PromptWithRationale => "default",
    }
}

#[tauri::command]
pub fn notification_permission(app: AppHandle, webview: Webview) -> Result<&'static str, String> {
    crate::browser::require_main(&webview)?;
    // The desktop plugin reports support as granted. System notification settings
    // and Focus modes can still suppress delivery; app opt-in lives in the UI.
    app.notification().permission_state().map(permission_name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn request_notification_permission(app: AppHandle, webview: Webview) -> Result<&'static str, String> {
    crate::browser::require_main(&webview)?;
    app.notification().request_permission().map(permission_name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn send_notification(app: AppHandle, webview: Webview, title: String, body: String, project_id: String, session_id: String, notification_id: Option<String>) -> Result<(), String> {
    crate::browser::require_main(&webview)?;
    let title = title.trim();
    if title.is_empty() { return Err("A notification needs a title.".into()); }
    if app.notification().permission_state().map_err(|e| e.to_string())? != PermissionState::Granted {
        return Err("Notifications are not allowed.".into());
    }
    // A native browser child changes the first responder, but remains in the
    // main native window. Window focus therefore covers every app pane.
    if webview.window().is_focused().map_err(|e| e.to_string())? { return Ok(()); }
    let mut notification = app.notification().builder()
        .title(title.chars().take(160).collect::<String>())
        .body(body.chars().take(1000).collect::<String>())
        .extra("projectId", project_id)
        .extra("sessionId", session_id);
    if let Some(notification_id) = notification_id { notification = notification.extra("notificationId", notification_id); }
    notification.show().map_err(|e| e.to_string())
}

pub fn focus_main(app: &AppHandle) -> Result<(), String> {
    let view = app.get_webview("main").ok_or("The app window is unavailable.")?;
    let window = view.window();
    window.show().map_err(|e| e.to_string())?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    view.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn focus_application(app: AppHandle, webview: Webview) -> Result<(), String> {
    crate::browser::require_main(&webview)?;
    focus_main(&app)
}

pub fn listen(app: &AppHandle) -> tauri_plugin_notification::Result<()> {
    let action_app = app.clone();
    app.notification().on_action(move |action| {
        if action.action_id() != "tap" { return; }
        let _ = focus_main(&action_app);
        let Some(notification) = action.notification() else { return; };
        let extra = notification.extra();
        let (Some(project_id), Some(session_id)) = (
            extra.get("projectId").and_then(serde_json::Value::as_str),
            extra.get("sessionId").and_then(serde_json::Value::as_str),
        ) else { return; };
        let mut detail = serde_json::json!({ "projectId": project_id, "sessionId": session_id });
        if let Some(notification_id) = extra.get("notificationId").and_then(serde_json::Value::as_str) {
            detail["notificationId"] = serde_json::json!(notification_id);
        }
        if let Some(view) = action_app.get_webview("main") {
            let _ = view.eval(&format!("window.dispatchEvent(new CustomEvent('canvagent:open-notification', {{ detail: {detail} }}))"));
        }
    })
}
