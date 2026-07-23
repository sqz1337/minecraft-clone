use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager, PhysicalPosition, WebviewWindow};

mod raw_mouse;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorldMetadata {
    id: String,
    name: String,
    seed: String,
    game_mode: String,
    created_at: f64,
    last_played: f64,
    #[serde(default)]
    silent_hill: bool,
}

fn validate_world_id(world_id: &str) -> Result<(), String> {
    let valid = !world_id.is_empty()
        && world_id.len() <= 80
        && world_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
    if valid {
        Ok(())
    } else {
        Err("invalid world id".into())
    }
}

fn worlds_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("worlds");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn world_dir(app: &AppHandle, world_id: &str) -> Result<PathBuf, String> {
    validate_world_id(world_id)?;
    Ok(worlds_dir(app)?.join(world_id))
}

fn write_world_metadata(app: &AppHandle, metadata: &WorldMetadata) -> Result<(), String> {
    validate_world_id(&metadata.id)?;
    if metadata.name.trim().is_empty()
        || metadata.name.chars().count() > 48
        || metadata.seed.chars().count() > 200
        || (metadata.game_mode != "creative" && metadata.game_mode != "survival")
    {
        return Err("invalid world metadata".into());
    }
    let directory = world_dir(app, &metadata.id)?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let metadata_json = serde_json::to_string_pretty(metadata).map_err(|error| error.to_string())?;
    fs::write(directory.join("world.json"), metadata_json).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_worlds(app: AppHandle) -> Result<Vec<WorldMetadata>, String> {
    let mut worlds = Vec::new();
    for entry in fs::read_dir(worlds_dir(&app)?).map_err(|error| error.to_string())? {
        let entry = match entry {
            Ok(value) if value.path().is_dir() => value,
            _ => continue,
        };
        let metadata_path = entry.path().join("world.json");
        let raw = match fs::read_to_string(metadata_path) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if let Ok(metadata) = serde_json::from_str::<WorldMetadata>(&raw) {
            if validate_world_id(&metadata.id).is_ok() {
                worlds.push(metadata);
            }
        }
    }
    worlds.sort_by(|left, right| {
        right
            .last_played
            .partial_cmp(&left.last_played)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(worlds)
}

#[tauri::command]
fn register_world(app: AppHandle, metadata: WorldMetadata) -> Result<bool, String> {
    write_world_metadata(&app, &metadata)?;
    Ok(true)
}

#[tauri::command]
fn load_world(app: AppHandle, world_id: String) -> Result<Option<String>, String> {
    let path = world_dir(&app, &world_id)?.join("level.json");
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(path).map(Some).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_world(
    app: AppHandle,
    world_id: String,
    data: String,
    metadata: WorldMetadata,
) -> Result<bool, String> {
    validate_world_id(&world_id)?;
    if metadata.id != world_id {
        return Err("world metadata id mismatch".into());
    }
    let directory = world_dir(&app, &world_id)?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let parsed: serde_json::Value = serde_json::from_str(&data).map_err(|error| error.to_string())?;
    if !parsed.is_object() {
        return Err("world data must be a JSON object".into());
    }
    let level_path = directory.join("level.json");
    let temporary_path = directory.join("level.json.tmp");
    fs::write(&temporary_path, data).map_err(|error| error.to_string())?;
    if level_path.exists() {
        let backup_path = directory.join("level.json.bak");
        let _ = fs::copy(&level_path, backup_path);
        fs::remove_file(&level_path).map_err(|error| error.to_string())?;
    }
    fs::rename(temporary_path, level_path).map_err(|error| error.to_string())?;
    write_world_metadata(&app, &metadata)?;
    Ok(true)
}

#[tauri::command]
fn delete_world(app: AppHandle, world_id: String) -> Result<bool, String> {
    let directory = world_dir(&app, &world_id)?;
    if !directory.exists() {
        return Ok(true);
    }
    fs::remove_dir_all(directory).map_err(|error| error.to_string())?;
    Ok(true)
}

fn center_cursor(window: &WebviewWindow) -> Result<(), String> {
    let size = window.inner_size().map_err(|error| error.to_string())?;
    window
        .set_cursor_position(PhysicalPosition::new(size.width / 2, size.height / 2))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_game_cursor_lock(window: WebviewWindow, locked: bool) -> Result<bool, String> {
    if locked {
        center_cursor(&window)?;
        window.set_cursor_grab(true).map_err(|error| error.to_string())?;
        window.set_cursor_visible(false).map_err(|error| error.to_string())?;
        raw_mouse::set_locked(true);
    } else {
        raw_mouse::set_locked(false);
        center_cursor(&window)?;
        window.set_cursor_grab(false).map_err(|error| error.to_string())?;
        window.set_cursor_visible(true).map_err(|error| error.to_string())?;
    }
    Ok(true)
}

#[tauri::command]
fn set_app_fullscreen(window: WebviewWindow, fullscreen: bool) -> Result<bool, String> {
    window
        .set_fullscreen(fullscreen)
        .map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            raw_mouse::install(app.handle()).map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_worlds,
            register_world,
            load_world,
            save_world,
            delete_world,
            set_game_cursor_lock,
            set_app_fullscreen,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running Realmcraft");
}
