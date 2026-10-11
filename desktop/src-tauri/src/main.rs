#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::image::Image;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

#[tauri::command]
fn update_tray_status(app: tauri::AppHandle, status: String) {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(&status));
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![update_tray_status])
        .setup(|app| {
            let tray = TrayIconBuilder::with_id("main")
                .icon(Image::new(include_bytes!("../icons/tray.rgba"), 32, 32))
                .tooltip("AgentDashboard · Connecting")
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app);
            if let Err(error) = tray {
                eprintln!("System tray unavailable: {error}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run AgentDashboard desktop window");
}
