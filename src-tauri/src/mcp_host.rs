//! A local MCP endpoint (Streamable HTTP, JSON responses) so AI assistants can use the open app: its collections,
//! the active environment, cookies and signed-in tokens. Off until turned on in Settings.
//!
//! Rust only guards and relays: it listens on 127.0.0.1, requires the bearer token from Settings, refuses requests
//! from web pages (an Origin header) and from other host names (DNS rebinding), then hands each JSON-RPC message to
//! the frontend, which answers with the same tools as `dispatch-run mcp`.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;

const MAX_BODY: usize = 4 * 1024 * 1024;
/// A run_collection or run_flow can take a while.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Default)]
pub struct McpHost {
    /// The running listener: its stop signal and its task. An async lock, held while starting or stopping, so a
    /// restart waits for the old listener to let go of the port before binding again.
    running: tokio::sync::Mutex<Option<(oneshot::Sender<()>, tauri::async_runtime::JoinHandle<()>)>>,
    waiting: Mutex<HashMap<u64, oneshot::Sender<Option<String>>>>,
    next: AtomicU64,
}

#[derive(Clone, Serialize)]
struct McpHostRequest {
    id: u64,
    body: String,
}

fn same_bytes(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() { return false; }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn respond(sock: &mut tokio::net::TcpStream, status: &str, extra: &str, body: &str) {
    let ct = if body.is_empty() { "" } else { "Content-Type: application/json\r\n" };
    let head = format!("HTTP/1.1 {status}\r\n{ct}{extra}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    let _ = sock.write_all(head.as_bytes()).await;
    let _ = sock.write_all(body.as_bytes()).await;
}

fn rpc_error(msg: &str) -> String {
    serde_json::json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32000, "message": msg } }).to_string()
}

/// Why a request was turned away: the status line, extra headers and the JSON-RPC error body.
#[derive(Debug, PartialEq)]
struct Refusal {
    status: &'static str,
    extra: &'static str,
    body: String,
}

fn refuse(status: &'static str, extra: &'static str, msg: &str) -> Refusal {
    Refusal { status, extra, body: if msg.is_empty() { String::new() } else { rpc_error(msg) } }
}

/// Every check a request must pass before it reaches the frontend, in order. `headers` have lower-case names.
fn gate(method: &str, target: &str, headers: &[(String, String)], port: u16, token: &str) -> Result<(), Refusal> {
    let header = |name: &str| headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());
    // Web pages may not talk to it (browsers always send Origin on cross-site requests), nor other host names.
    if header("origin").is_some() {
        return Err(refuse("403 Forbidden", "", "Requests from web pages aren't accepted."));
    }
    let host_ok = header("host").map(|h| h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}")).unwrap_or(false);
    if !host_ok {
        return Err(refuse("403 Forbidden", "", "Use http://127.0.0.1:<port>/mcp."));
    }
    let path = target.split('?').next().unwrap_or("");
    if path != "/mcp" {
        return Err(refuse("404 Not Found", "", "The MCP endpoint is /mcp."));
    }
    let presented = header("authorization").and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer "))).unwrap_or("");
    if token.is_empty() || !same_bytes(presented.trim().as_bytes(), token.as_bytes()) {
        return Err(refuse("401 Unauthorized", "WWW-Authenticate: Bearer\r\n", "Missing or wrong token. Copy it from Dispatch → Settings → AI assistants."));
    }
    if method != "POST" {
        // No server-to-client stream: every answer comes back on the POST that asked.
        return Err(refuse("405 Method Not Allowed", "Allow: POST\r\n", ""));
    }
    Ok(())
}

async fn serve_one(mut sock: tokio::net::TcpStream, app: tauri::AppHandle, host: Arc<McpHost>, port: u16, token: Arc<String>) {
    use tauri::Emitter;
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    let head_end = loop {
        match tokio::time::timeout(Duration::from_secs(30), sock.read(&mut tmp)).await {
            Ok(Ok(0)) | Ok(Err(_)) | Err(_) => return,
            Ok(Ok(n)) => buf.extend_from_slice(&tmp[..n]),
        }
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") { break i; }
        if buf.len() > 64 * 1024 { return; }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split_whitespace();
    let method = first.next().unwrap_or("").to_string();
    let target = first.next().unwrap_or("/").to_string();
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))).collect();
    let header = |name: &str| headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());

    if let Err(no) = gate(&method, &target, &headers, port, &token) {
        respond(&mut sock, no.status, no.extra, &no.body).await;
        return;
    }
    let len: usize = header("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if len > MAX_BODY {
        respond(&mut sock, "413 Payload Too Large", "", &rpc_error("Request too large.")).await;
        return;
    }
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < len {
        match sock.read(&mut tmp).await { Ok(0) | Err(_) => break, Ok(n) => body.extend_from_slice(&tmp[..n]) }
    }
    body.truncate(len);

    let id = host.next.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    host.waiting.lock().unwrap().insert(id, tx);
    let _ = app.emit("mcp-host-request", McpHostRequest { id, body: String::from_utf8_lossy(&body).to_string() });
    match tokio::time::timeout(ANSWER_TIMEOUT, rx).await {
        Ok(Ok(Some(answer))) => respond(&mut sock, "200 OK", "", &answer).await,
        Ok(Ok(None)) => respond(&mut sock, "202 Accepted", "", "").await,
        _ => {
            host.waiting.lock().unwrap().remove(&id);
            respond(&mut sock, "504 Gateway Timeout", "", &rpc_error("Dispatch didn't answer in time.")).await;
        }
    }
}

/// Starts (or restarts) the endpoint on 127.0.0.1:<port>.
#[tauri::command]
pub async fn mcp_host_start(app: tauri::AppHandle, state: tauri::State<'_, Arc<McpHost>>, port: u16, token: String) -> Result<(), String> {
    if token.len() < 32 { return Err("The token is too short; generate a new one.".into()); }
    let host = state.inner().clone();
    let mut running = host.running.lock().await;
    stop_listener(&mut running).await;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.map_err(|e| format!("Couldn’t start the MCP endpoint on port {port}: {e}"))?;
    let (tx, mut rx) = oneshot::channel::<()>();
    let token = Arc::new(token);
    let task_host = host.clone();
    let task = tauri::async_runtime::spawn(async move {
        let host = task_host;
        loop {
            tokio::select! {
                _ = &mut rx => break,
                acc = listener.accept() => {
                    if let Ok((sock, _)) = acc { tauri::async_runtime::spawn(serve_one(sock, app.clone(), host.clone(), port, token.clone())); }
                }
            }
        }
    });
    *running = Some((tx, task));
    Ok(())
}

/// Stops the listener (if any) and waits until its socket is closed.
async fn stop_listener(running: &mut Option<(oneshot::Sender<()>, tauri::async_runtime::JoinHandle<()>)>) {
    if let Some((stop, task)) = running.take() {
        let _ = stop.send(());
        let _ = task.await;
    }
}

#[tauri::command]
pub async fn mcp_host_stop(state: tauri::State<'_, Arc<McpHost>>) -> Result<(), ()> {
    stop_listener(&mut *state.running.lock().await).await;
    for (_, tx) in state.waiting.lock().unwrap().drain() { let _ = tx.send(None); }
    Ok(())
}

/// The frontend's answer to one message; `None` for a notification (HTTP 202, no body).
#[tauri::command]
pub fn mcp_host_reply(state: tauri::State<'_, Arc<McpHost>>, id: u64, body: Option<String>) {
    if let Some(tx) = state.waiting.lock().unwrap().remove(&id) { let _ = tx.send(body); }
}

#[cfg(test)]
mod tests {
    use super::{gate, same_bytes};

    const PORT: u16 = 4320;
    const TOKEN: &str = "s3cret-token";

    fn hdrs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter().map(|(k, v)| (k.to_ascii_lowercase(), v.to_string())).collect()
    }
    /// A request an MCP client really sends, with any header replaced (an empty value drops it).
    fn ask(method: &str, target: &str, change: &[(&str, &str)]) -> Result<(), &'static str> {
        let mut list = vec![("host", "127.0.0.1:4320".to_string()), ("authorization", format!("Bearer {TOKEN}")), ("content-type", "application/json".into())];
        for (k, v) in change {
            list.retain(|(name, _)| name != k);
            if !v.is_empty() { list.push((k, v.to_string())); }
        }
        let list: Vec<(&str, &str)> = list.iter().map(|(k, v)| (*k, v.as_str())).collect();
        gate(method, target, &hdrs(&list), PORT, TOKEN).map_err(|r| r.status)
    }

    #[test]
    fn compares_tokens() {
        assert!(same_bytes(b"abc", b"abc"));
        assert!(!same_bytes(b"abc", b"abd"));
        assert!(!same_bytes(b"abc", b"abcd"));
    }

    #[test]
    fn lets_a_real_client_in() {
        assert_eq!(ask("POST", "/mcp", &[]), Ok(()));
        assert_eq!(ask("POST", "/mcp?session=1", &[("host", "localhost:4320")]), Ok(()));
        assert_eq!(ask("POST", "/mcp", &[("authorization", "bearer s3cret-token ")]), Ok(()));
    }

    #[test]
    fn refuses_web_pages() {
        for origin in ["https://evil.example", "http://127.0.0.1:4320", "null"] {
            assert_eq!(ask("POST", "/mcp", &[("origin", origin)]), Err("403 Forbidden"), "Origin {origin}");
        }
    }

    #[test]
    fn refuses_other_host_names() {
        // DNS rebinding: a page on evil.example resolves to 127.0.0.1 but still sends its own Host.
        for host in ["evil.example:4320", "127.0.0.1:9999", "127.0.0.1", "localhost", "0.0.0.0:4320", "[::1]:4320", ""] {
            assert_eq!(ask("POST", "/mcp", &[("host", host)]), Err("403 Forbidden"), "Host {host:?}");
        }
    }

    #[test]
    fn refuses_a_missing_or_wrong_token() {
        for auth in ["", "Bearer", "Bearer ", "Bearer wrong", "Bearer s3cret-token-and-more", "Basic czNjcmV0LXRva2Vu", "s3cret-token"] {
            assert_eq!(ask("POST", "/mcp", &[("authorization", auth)]), Err("401 Unauthorized"), "Authorization {auth:?}");
        }
        let h = hdrs(&[("host", "127.0.0.1:4320"), ("authorization", "Bearer ")]);
        assert_eq!(gate("POST", "/mcp", &h, PORT, "").map_err(|r| r.status), Err("401 Unauthorized"), "an empty token never matches");
    }

    #[test]
    fn says_how_to_sign_in_and_which_method_works() {
        let h = hdrs(&[("host", "127.0.0.1:4320")]);
        let no = gate("POST", "/mcp", &h, PORT, TOKEN).unwrap_err();
        assert_eq!(no.extra, "WWW-Authenticate: Bearer\r\n");
        assert!(no.body.contains("Settings → AI assistants"));
        let h = hdrs(&[("host", "127.0.0.1:4320"), ("authorization", "Bearer s3cret-token")]);
        let no = gate("GET", "/mcp", &h, PORT, TOKEN).unwrap_err();
        assert_eq!((no.status, no.extra, no.body.as_str()), ("405 Method Not Allowed", "Allow: POST\r\n", ""));
    }

    #[test]
    fn checks_in_a_safe_order() {
        // A web page learns nothing about the token or the path: Origin is refused first.
        assert_eq!(ask("GET", "/other", &[("origin", "https://evil.example"), ("authorization", "")]), Err("403 Forbidden"));
        // Only the MCP path exists, and the token is checked before the method.
        assert_eq!(ask("POST", "/", &[]), Err("404 Not Found"));
        assert_eq!(ask("POST", "/mcp/", &[]), Err("404 Not Found"));
        assert_eq!(ask("GET", "/mcp", &[("authorization", "")]), Err("401 Unauthorized"));
        for m in ["GET", "PUT", "DELETE", "OPTIONS", "post"] { assert_eq!(ask(m, "/mcp", &[]), Err("405 Method Not Allowed"), "{m}"); }
    }
}
