//! Writing and reading a collection folder: prune removes only Dispatch files, and paths can't escape the folder.
use dispatch_lib::{collection_dir_read as read_collection_dir, collection_dir_write as write_collection_dir};

#[test]
fn writes_prunes_and_refuses_escapes() {
    let root = std::env::temp_dir().join(format!("dispatch-files-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let r = root.display().to_string();
    let f = |p: &str, t: &str| (p.to_string(), t.to_string());
    write_collection_dir(r.clone(), vec![f("dispatch.collection.yaml", "name: A\n"), f("orders/_folder.yaml", "name: Orders\n"), f("orders/list.req.yaml", "name: List\n"), f("login.req.yaml", "name: Login\n")], true).unwrap();
    std::fs::write(root.join("README.md"), "mine").unwrap();
    let mut got: Vec<String> = read_collection_dir(r.clone()).unwrap().into_iter().map(|(p, _)| p).collect();
    got.sort();
    assert_eq!(got, ["dispatch.collection.yaml", "login.req.yaml", "orders/_folder.yaml", "orders/list.req.yaml"]);
    // Folder removed and request renamed: stale files go, empty folders go, other files stay.
    write_collection_dir(r.clone(), vec![f("dispatch.collection.yaml", "name: A\n"), f("sign-in.req.yaml", "name: Login\n")], true).unwrap();
    let mut got: Vec<String> = read_collection_dir(r.clone()).unwrap().into_iter().map(|(p, _)| p).collect();
    got.sort();
    assert_eq!(got, ["dispatch.collection.yaml", "sign-in.req.yaml"]);
    assert!(!root.join("orders").exists());
    assert_eq!(std::fs::read_to_string(root.join("README.md")).unwrap(), "mine");
    // No escaping the folder.
    assert!(write_collection_dir(r.clone(), vec![f("../evil.req.yaml", "x")], false).is_err());
    assert!(write_collection_dir(r.clone(), vec![f("/tmp/evil.req.yaml", "x")], false).is_err());
    let _ = std::fs::remove_dir_all(&root);
}

/// Linked folders: the app never overwrites or deletes a file that changed outside it since it last saw it.
#[test]
fn sync_leaves_outside_changes_alone() {
    use dispatch_lib::{folder_read, folder_sync, text_hash};
    use std::collections::HashMap;
    let root = std::env::temp_dir().join(format!("dispatch-sync-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let r = root.display().to_string();
    let f = |p: &str, t: &str| (p.to_string(), t.to_string());

    // First write into an empty folder: nothing to conflict with.
    let first = folder_sync(&r, vec![f("dispatch.workspace.yaml", "name: W\n"), f("flows/a.flow.yaml", "name: A\n"), f("flows/b.flow.yaml", "name: B\n")], Some(HashMap::new())).unwrap();
    assert!(first.conflicts.is_empty());
    assert_eq!(first.known.len(), 3);
    assert_eq!(first.known["flows/a.flow.yaml"], text_hash("name: A\n"));

    // Outside the app: a.flow edited, b.flow deleted, c.flow added (as a git pull would).
    std::fs::write(root.join("flows/a.flow.yaml"), "name: A from git\n").unwrap();
    std::fs::remove_file(root.join("flows/b.flow.yaml")).unwrap();
    std::fs::write(root.join("flows/c.flow.yaml"), "name: C\n").unwrap();

    // The app writes its own (older) versions and no longer has c: everything outside is kept and reported.
    let second = folder_sync(&r, vec![f("dispatch.workspace.yaml", "name: W2\n"), f("flows/a.flow.yaml", "name: A edited in app\n"), f("flows/b.flow.yaml", "name: B\n")], Some(first.known.clone())).unwrap();
    assert_eq!(second.conflicts, ["flows/a.flow.yaml", "flows/b.flow.yaml", "flows/c.flow.yaml"]);
    assert_eq!(std::fs::read_to_string(root.join("flows/a.flow.yaml")).unwrap(), "name: A from git\n");
    assert!(!root.join("flows/b.flow.yaml").exists());
    assert_eq!(std::fs::read_to_string(root.join("flows/c.flow.yaml")).unwrap(), "name: C\n");
    // Unchanged files are still written normally, and a conflicted file keeps its old hash.
    assert_eq!(std::fs::read_to_string(root.join("dispatch.workspace.yaml")).unwrap(), "name: W2\n");
    assert_eq!(second.known["flows/a.flow.yaml"], text_hash("name: A\n"));

    // Pruning removes only what the app last saw unchanged.
    let third = folder_sync(&r, vec![f("dispatch.workspace.yaml", "name: W2\n")], Some(HashMap::from([
        ("dispatch.workspace.yaml".to_string(), text_hash("name: W2\n")),
    ]))).unwrap();
    assert_eq!(third.conflicts, ["flows/a.flow.yaml", "flows/c.flow.yaml"]);
    assert!(root.join("flows/a.flow.yaml").exists());

    // "Keep mine" (no known state) overwrites and prunes regardless, and leaves no temporary files.
    let forced = folder_sync(&r, vec![f("dispatch.workspace.yaml", "name: W3\n"), f("flows/a.flow.yaml", "name: A mine\n")], None).unwrap();
    assert!(forced.conflicts.is_empty());
    let files: Vec<(String, String)> = folder_read(&r).unwrap().into_iter().map(|(p, t, _)| (p, t)).collect();
    assert_eq!(files, [f("dispatch.workspace.yaml", "name: W3\n"), f("flows/a.flow.yaml", "name: A mine\n")]);
    assert!(std::fs::read_dir(root.join("flows")).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".dispatch-tmp")));
    let _ = std::fs::remove_dir_all(&root);
}

/// The app hashes its own files the same way (src/core/folderMerge.ts `textHash`), so both must agree byte for byte.
#[test]
fn text_hash_matches_the_app() {
    use dispatch_lib::text_hash;
    assert_eq!(text_hash(""), "cbf29ce484222325");
    assert_eq!(text_hash("dispatch"), "4592850c14d1d82b");
    assert_eq!(text_hash("id: a\nname: Café ✈\n"), "117831fc4b033caa");
}

/// Send feedback's E-mail button opens a mailto: link (it was refused before 2026-11-22); other schemes stay refused.
#[test]
fn opens_web_and_mail_links_only() {
    use dispatch_lib::openable_link;
    for ok in ["https://dispatch.ogcrafts.cloud", "http://localhost:3000", "mailto:hello@ogcrafts.cloud?subject=Dispatch"] { assert!(openable_link(ok), "{ok}"); }
    for bad in ["file:///etc/passwd", "javascript:alert(1)", "ms-settings:", "C:\\Windows\\notepad.exe", ""] { assert!(!openable_link(bad), "{bad}"); }
}

/// The secrets file is written only over what the app last saw, and never by folder_sync.
#[test]
fn secrets_file_is_compare_before_write_and_left_alone_by_sync() {
    use dispatch_lib::{folder_sync, vault_put, vault_read, VAULT_FILE};
    let dir = std::env::temp_dir().join(format!("dispatch-vault-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let root = dir.to_str().unwrap();
    assert_eq!(vault_read(root).unwrap(), None);
    let h1 = vault_put(root, Some("{\"v\":1}"), None).unwrap().unwrap();
    assert_eq!(vault_read(root).unwrap().unwrap().1, h1);
    // Someone else changed it: the app's write is refused.
    std::fs::write(dir.join(VAULT_FILE), "{\"v\":2}").unwrap();
    assert_eq!(vault_put(root, Some("{\"v\":3}"), Some(&h1)).unwrap_err(), "changed");
    // A sync of the other files (with "keep mine") neither deletes nor reports it.
    let out = folder_sync(root, vec![("dispatch.workspace.yaml".into(), "id: w\n".into())], None).unwrap();
    assert!(out.conflicts.is_empty());
    assert_eq!(std::fs::read_to_string(dir.join(VAULT_FILE)).unwrap(), "{\"v\":2}");
    let h2 = vault_read(root).unwrap().unwrap().1;
    assert_eq!(vault_put(root, None, Some(&h2)).unwrap(), None);
    assert!(!dir.join(VAULT_FILE).exists());
    let _ = std::fs::remove_dir_all(&dir);
}
