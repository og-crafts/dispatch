//! Linked folders, phase 2 (docs/DESIGN-linked-workspaces.md): tell the app when files in a linked folder change, and
//! find copies of Dispatch files that a cloud drive or sync tool made (they can't be read, but must not go unnoticed).

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};

/// How long the folder must stay quiet before the app hears about it (a `git pull` or a cloud drive writes in bursts).
pub const QUIET: Duration = Duration::from_millis(500);

/// True for paths the app never cares about: git's own files, node_modules and Dispatch's temporary files.
fn ignored(root: &Path, p: &Path) -> bool {
    let rel = p.strip_prefix(root).unwrap_or(p);
    if rel.components().any(|c| matches!(c.as_os_str().to_str(), Some(".git") | Some("node_modules"))) { return true; }
    p.file_name().map(|n| n.to_string_lossy().ends_with(".dispatch-tmp")).unwrap_or(false)
}

/// Watches some folders and calls `on_change` with the folders whose files changed, once they have been quiet for
/// [`QUIET`]. Dropping it stops the watching (its thread ends when the watcher's channel closes).
pub struct FolderWatch { _watcher: notify::RecommendedWatcher }

impl FolderWatch {
    pub fn start(roots: Vec<String>, on_change: impl Fn(Vec<String>) + Send + 'static) -> Result<Self, String> {
        let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
        let mut watcher = notify::recommended_watcher(tx).map_err(|e| format!("Couldn’t watch folders: {e}"))?;
        let mut watched = vec![];
        for r in &roots {
            let p = PathBuf::from(r);
            // A folder that is gone (an unplugged drive) is skipped; the app still checks it on start and on focus.
            if p.is_dir() && watcher.watch(&p, RecursiveMode::Recursive).is_ok() { watched.push((r.clone(), p)); }
        }
        std::thread::spawn(move || {
            let hit = |ev: &notify::Event, out: &mut Vec<String>| {
                // Opening or reading a file (the app's own reads included) is not a change.
                if matches!(ev.kind, notify::EventKind::Access(_)) { return; }
                for path in &ev.paths {
                    for (name, root) in &watched {
                        if path.starts_with(root) && path != root && !ignored(root, path) && !out.contains(name) { out.push(name.clone()); }
                    }
                }
            };
            while let Ok(first) = rx.recv() {
                let mut changed = vec![];
                if let Ok(ev) = &first { hit(ev, &mut changed); }
                loop {
                    match rx.recv_timeout(QUIET) {
                        Ok(Ok(ev)) => hit(&ev, &mut changed),
                        Ok(Err(_)) => {}
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }
                if !changed.is_empty() { changed.sort(); on_change(changed); }
            }
        });
        Ok(FolderWatch { _watcher: watcher })
    }
}

/// The one watch the app has (it replaces it whenever the set of linked folders changes).
#[derive(Default)]
pub struct Watching(pub Mutex<Option<FolderWatch>>);

/// Names a sync tool gives a copy of a Dispatch file, e.g. `a.req (Laptop's conflicted copy).yaml` (Dropbox),
/// `a.req.sync-conflict-20261122-101010-ABC.yaml` (Syncthing) or `a.req.yaml.orig`. They are not Dispatch files,
/// so the app never reads, writes or deletes them; it only lists them so the person can look.
const MARKERS: [&str; 6] = [".req", "_folder", "dispatch.collection", ".env", ".flow", "dispatch.workspace"];
fn is_stray(name: &str) -> bool {
    if crate::is_ours(name) || name.ends_with(".dispatch-tmp") { return false; }
    let lower = name.to_lowercase();
    MARKERS.iter().any(|m| lower.contains(&format!("{m}.yaml")) || lower.contains(&format!("{m} ")) || lower.contains(&format!("{m}.sync-conflict")) || lower.contains(&format!("{m}-conflict")) || lower.contains(&format!("{m}(")))
}

/// Copies of Dispatch files under `root` (relative paths, sorted). Skips .git and node_modules.
pub fn folder_strays(root: &str) -> Result<Vec<String>, String> {
    let root = PathBuf::from(root);
    if !root.exists() { return Ok(vec![]); }
    let mut out = vec![];
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        for e in std::fs::read_dir(&dir).map_err(|e| format!("Couldn’t read {}: {e}", dir.display()))?.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if p.is_dir() { if name != ".git" && name != "node_modules" { stack.push(p); } continue; }
            if is_stray(&name) { out.push(p.strip_prefix(&root).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/")); }
        }
    }
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strays_are_copies_of_dispatch_files_only() {
        for n in ["a.req (Laptop's conflicted copy).yaml", "a.req.sync-conflict-20261122-101010-ABC.yaml", "a.req.yaml.orig", "_folder (1).yaml", "staging.env (copy).yaml", "x.flow-conflict-1.yaml", "dispatch.workspace (2).yaml"] {
            assert!(is_stray(n), "{n} should be a stray");
        }
        for n in ["a.req.yaml", "_folder.yaml", "dispatch.workspace.yaml", "staging.env.yaml", "notes.md", "README.yaml", ".a.req.yaml.dispatch-tmp", "request.yaml"] {
            assert!(!is_stray(n), "{n} should not be a stray");
        }
    }

    #[test]
    fn lists_strays_under_the_folder_but_not_in_git() {
        let dir = std::env::temp_dir().join(format!("dispatch-strays-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("collections/shop/.git")).unwrap();
        std::fs::write(dir.join("collections/shop/a.req.yaml"), "id: a").unwrap();
        std::fs::write(dir.join("collections/shop/a.req (Laptop's conflicted copy).yaml"), "id: a").unwrap();
        std::fs::write(dir.join("collections/shop/.git/b.req (1).yaml"), "id: b").unwrap();
        assert_eq!(folder_strays(dir.to_str().unwrap()).unwrap(), vec!["collections/shop/a.req (Laptop's conflicted copy).yaml".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reports_a_changed_folder_once_it_is_quiet() {
        let dir = std::env::temp_dir().join(format!("dispatch-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        let root = dir.to_string_lossy().to_string();
        let (tx, rx) = mpsc::channel();
        let _w = FolderWatch::start(vec![root.clone()], move |roots| { let _ = tx.send(roots); }).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        // Only git's own files and a temp file: nothing to report.
        std::fs::write(dir.join(".git/index"), "x").unwrap();
        std::fs::write(dir.join(".a.req.yaml.dispatch-tmp"), "x").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(1500)).is_err());
        for i in 0..3 { std::fs::write(dir.join("a.req.yaml"), format!("id: a{i}")).unwrap(); }
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), vec![root]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
