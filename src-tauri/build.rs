fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_info", "choose_workspace", "reopen_workspace", "remember_workspace", "quit_application",
            "notification_permission", "request_notification_permission", "send_notification", "focus_application",
            "browser_open", "browser_bounds", "browser_hide", "browser_close", "browser_action", "browser_state", "browser_annotate",
        ]),
    )).expect("Could not build the desktop application");
}
