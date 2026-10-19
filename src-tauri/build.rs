fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_info", "choose_workspace", "reopen_workspace", "quit_application",
        ]),
    )).expect("Could not build the desktop application");
}
