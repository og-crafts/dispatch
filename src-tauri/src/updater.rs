//! In-app updates (Tauri's updater plugin), as Dispatch's own commands so the window needs no plugin permissions.
//!
//! An update is only installed when its signature matches the public key in `tauri.conf.json`
//! (`plugins.updater.pubkey`). Builds without that key (development, forks) don't load the plugin, and the
//! commands say updates aren't set up. Release builds read `latest.json` from the newest published GitHub release.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The update found by the last check, kept for `update_install`.
#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current: String,
    /// None when this is the newest version.
    version: Option<String>,
    notes: Option<String>,
    date: Option<String>,
}

/// True when this build carries an update key (so the plugin can be loaded).
pub fn configured<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|c| c.get("pubkey"))
        .and_then(|k| k.as_str())
        .is_some_and(|k| !k.trim().is_empty())
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    if !configured(&app) {
        return Err("This build can’t update itself. Download the newest version from dispatch.ogcrafts.cloud.".into());
    }
    let updater = app.updater().map_err(|e| e.to_string())?;
    let found = updater.check().await.map_err(|e| check_error_text(&e, &current))?;
    let info = match &found {
        Some(u) => UpdateInfo { current, version: Some(u.version.clone()), notes: u.body.clone(), date: u.date.map(|d| d.to_string()) },
        None => UpdateInfo { current, version: None, notes: None, date: None },
    };
    *app.state::<PendingUpdate>().0.lock().unwrap() = found;
    Ok(info)
}

/// What to tell the person when a check fails. `ReleaseNotFound` means no endpoint gave a `latest.json`: there's
/// no newer published release with one (a pre-release, or the old previews before 0.1.0, never has one), or GitHub
/// couldn't be reached. Neither needs the plugin's own wording.
pub fn check_error_text(e: &tauri_plugin_updater::Error, current: &str) -> String {
    match e {
        tauri_plugin_updater::Error::ReleaseNotFound => format!(
            "No update found. You have Dispatch {current}. If you’re offline, try again later; new releases are also listed on dispatch.ogcrafts.cloud."
        ),
        other => format!("Couldn’t check for updates: {other}"),
    }
}

/// Downloads and installs the update found by `update_check`, then restarts Dispatch.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let update = app.state::<PendingUpdate>().0.lock().unwrap().take().ok_or("Check for updates first.")?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("Couldn’t install the update: {e}"))?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::check_error_text;
    use tauri_plugin_updater::Error;

    #[test]
    fn no_release_json_reads_as_no_update() {
        let t = check_error_text(&Error::ReleaseNotFound, "0.1.0");
        assert!(t.starts_with("No update found. You have Dispatch 0.1.0."), "{t}");
        assert!(!t.contains("release JSON"), "{t}");
    }

    #[test]
    fn other_errors_keep_their_cause() {
        let t = check_error_text(&Error::EmptyEndpoints, "0.1.0");
        assert!(t.starts_with("Couldn’t check for updates: "), "{t}");
    }
}
