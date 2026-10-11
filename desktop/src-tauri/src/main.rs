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
            let mut pixels = vec![0_u8; 32 * 32 * 4];
            for y in 0..32 {
                for x in 0..32 {
                    let offset = (y * 32 + x) * 4;
                    if (8..24).contains(&x) && (5..27).contains(&y) {
                        pixels[offset..offset + 4].copy_from_slice(&[56, 189, 248, 255]);
                    }
                    if (11..21).contains(&x) && ((10..14).contains(&y) || (17..21).contains(&y)) {
                        pixels[offset..offset + 4].copy_from_slice(&[15, 23, 42, 255]);
                    }
                }
            }
            let tray = TrayIconBuilder::with_id("main")
                .icon(Image::new_owned(pixels, 32, 32))
                .tooltip("OpenCode Supervisor · Connecting")
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
        .expect("failed to run OpenCode Supervisor desktop window");
}
