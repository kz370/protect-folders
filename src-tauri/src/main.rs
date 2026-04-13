#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, State, WindowEvent,
};

#[cfg(target_os = "windows")]
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{CloseHandle, HANDLE},
        Storage::FileSystem::{
            CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAGS_AND_ATTRIBUTES, FILE_GENERIC_READ,
            FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        },
    },
};

#[cfg(target_os = "windows")]
use winreg::{enums::HKEY_CURRENT_USER, RegKey};

#[cfg(target_os = "windows")]
type FolderHandle = isize;
#[cfg(not(target_os = "windows"))]
type FolderHandle = usize;

struct AppState {
    handles: Mutex<HashMap<String, FolderHandle>>,
    startup_failures: Mutex<Vec<String>>,
    is_quitting: AtomicBool,
}

#[derive(Serialize, Deserialize)]
struct LockedFoldersFile {
    folders: Vec<String>,
}

fn data_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app_data_dir: {e}"))?;
    fs::create_dir_all(&app_data_dir).map_err(|e| format!("failed to create app_data_dir: {e}"))?;
    Ok(app_data_dir.join("locked-folders.json"))
}

fn save_locked_folders(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let paths = state
        .handles
        .lock()
        .map_err(|_| "failed to lock state".to_string())?
        .keys()
        .cloned()
        .collect::<Vec<_>>();

    let content = serde_json::to_string_pretty(&LockedFoldersFile { folders: paths })
        .map_err(|e| format!("failed to serialize folders: {e}"))?;
    let file_path = data_file_path(app)?;
    fs::write(file_path, content).map_err(|e| format!("failed to save locked folders: {e}"))?;
    Ok(())
}

fn load_locked_folders(app: &AppHandle) -> Vec<String> {
    let file_path = match data_file_path(app) {
        Ok(path) => path,
        Err(_) => return Vec::new(),
    };

    if !file_path.exists() {
        return Vec::new();
    }

    let Ok(content) = fs::read_to_string(file_path) else {
        return Vec::new();
    };

    let Ok(parsed) = serde_json::from_str::<LockedFoldersFile>(&content) else {
        return Vec::new();
    };

    parsed.folders
}

#[cfg(target_os = "windows")]
fn normalize_path(path: &str) -> Result<String, String> {
    let p = PathBuf::from(path.trim());
    if !p.exists() {
        return Err("folder does not exist".to_string());
    }
    if !p.is_dir() {
        return Err("path is not a folder".to_string());
    }
    fs::canonicalize(p)
        .map_err(|e| format!("failed to normalize path: {e}"))?
        .to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "invalid unicode path".to_string())
}

#[cfg(target_os = "windows")]
fn lock_folder_inner(path: &str, state: &AppState) -> Result<String, String> {
    let normalized_path = normalize_path(path)?;
    let mut handles = state
        .handles
        .lock()
        .map_err(|_| "failed to lock state".to_string())?;

    if handles.contains_key(&normalized_path) {
        return Ok(normalized_path);
    }

    let mut wide_path: Vec<u16> = normalized_path.encode_utf16().collect();
    wide_path.push(0);

    let handle = unsafe {
        CreateFileW(
            PCWSTR::from_raw(wide_path.as_ptr()),
            FILE_GENERIC_READ.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_FLAGS_AND_ATTRIBUTES(FILE_FLAG_BACKUP_SEMANTICS.0),
            None,
        )
    }
    .map_err(|e| format!("failed to acquire folder handle: {e}"))?;

    handles.insert(normalized_path.clone(), handle.0 as isize);
    if let Ok(mut failures) = state.startup_failures.lock() {
        failures.retain(|entry| !entry.starts_with(&normalized_path));
    }
    Ok(normalized_path)
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn lock_folder(path: String, app: AppHandle, state: State<AppState>) -> Result<(), String> {
    lock_folder_inner(&path, state.inner())?;
    save_locked_folders(&app, state.inner())?;
    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn unlock_folder(path: String, app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let normalized = normalize_path(&path)?;
    let mut handles = state
        .handles
        .lock()
        .map_err(|_| "failed to lock state".to_string())?;

    let raw = handles
        .remove(&normalized)
        .ok_or_else(|| "folder is not currently locked".to_string())?;
    let closed = unsafe { CloseHandle(HANDLE(raw as *mut core::ffi::c_void)) };
    if let Err(e) = closed {
        return Err(format!("failed to close folder handle: {e}"));
    }

    drop(handles);
    save_locked_folders(&app, state.inner())?;
    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn get_locked_folders(state: State<AppState>) -> Vec<String> {
    state
        .handles
        .lock()
        .map(|m| m.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn get_relock_failures(state: State<AppState>) -> Vec<String> {
    state
        .startup_failures
        .lock()
        .map(|v| v.clone())
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn unlock_all(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let mut handles = state
        .handles
        .lock()
        .map_err(|_| "failed to lock state".to_string())?;
    for (_, raw) in handles.drain() {
        let _ = unsafe { CloseHandle(HANDLE(raw as *mut core::ffi::c_void)) };
    }
    drop(handles);
    save_locked_folders(&app, state.inner())?;
    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn set_autostart(enabled: bool) -> Result<(), String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let run_path = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    let (run_key, _) = hkcu
        .create_subkey(run_path)
        .map_err(|e| format!("failed to open Run key: {e}"))?;

    if enabled {
        let exe = std::env::current_exe().map_err(|e| format!("failed to resolve exe path: {e}"))?;
        let exe_str = exe
            .to_str()
            .ok_or_else(|| "failed to convert exe path to string".to_string())?;
        run_key
            .set_value("FolderLocker", &exe_str)
            .map_err(|e| format!("failed to set startup key: {e}"))?;
    } else {
        let _ = run_key.delete_value("FolderLocker");
    }

    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
fn get_autostart_status() -> Result<bool, String> {
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let run_path = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    let run_key = hkcu
        .open_subkey(run_path)
        .map_err(|e| format!("failed to open Run key: {e}"))?;
    let value: Result<String, _> = run_key.get_value("FolderLocker");
    Ok(value.is_ok())
}

#[cfg(target_os = "windows")]
fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItem::with_id(app, "show", "Show Folder Locker", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

    let app_handle = app.handle().clone();
    TrayIconBuilder::with_id("folder-locker-tray")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                let state = app.state::<AppState>();
                state.is_quitting.store(true, Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(move |_tray, event| {
            if let tauri::tray::TrayIconEvent::Click { .. } = event {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn lock_folder(_path: String, _app: AppHandle, _state: State<AppState>) -> Result<(), String> {
    Err("Folder locking is only supported on Windows".to_string())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn unlock_folder(_path: String, _app: AppHandle, _state: State<AppState>) -> Result<(), String> {
    Err("Folder locking is only supported on Windows".to_string())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn get_locked_folders(_state: State<AppState>) -> Vec<String> {
    Vec::new()
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn get_relock_failures(_state: State<AppState>) -> Vec<String> {
    Vec::new()
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn unlock_all(_app: AppHandle, _state: State<AppState>) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn set_autostart(_enabled: bool) -> Result<(), String> {
    Err("Autostart is only supported on Windows".to_string())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
fn get_autostart_status() -> Result<bool, String> {
    Ok(false)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            handles: Mutex::new(HashMap::new()),
            startup_failures: Mutex::new(Vec::new()),
            is_quitting: AtomicBool::new(false),
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, WindowEvent::CloseRequested { .. }) {
                let state = window.state::<AppState>();
                if !state.is_quitting.load(Ordering::SeqCst) {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                    }
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            #[cfg(target_os = "windows")]
            {
                let app_handle = app.handle().clone();
                let state = app.state::<AppState>();
                setup_tray(app)?;
                for folder in load_locked_folders(&app_handle) {
                    if let Err(err) = lock_folder_inner(&folder, state.inner()) {
                        if let Ok(mut failures) = state.startup_failures.lock() {
                            failures.push(format!("{folder} ({err})"));
                        }
                    }
                }
                let _ = save_locked_folders(&app_handle, state.inner());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            lock_folder,
            unlock_folder,
            get_locked_folders,
            get_relock_failures,
            unlock_all,
            set_autostart,
            get_autostart_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
