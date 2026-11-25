//! Streaming for the built-in assistant.
//!
//! The webview can't reach AI hosts (its CSP only allows the app itself), so it hands a request, API key
//! included, to `ai_stream`, which sends it and streams the answer back as `AiEvent`s on a channel.
//!
//! Rules, all enforced here and not trusted to the caller:
//! - https only, except for `localhost` and literal loopback/private/link-local addresses (local models);
//! - the URL must belong to the connection's `origin` (so a key only ever goes to the origin it was set up for);
//! - URLs with userinfo are refused; redirects are never followed; "accept any certificate" doesn't exist here;
//! - error text never holds headers (nor the URL, which can carry a key in its query).

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::Mutex;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use tokio::sync::oneshot;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
    pub id: u64,
    pub method: String,
    pub url: String,
    pub origin: String,
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub proxy: Option<String>,
    #[serde(default)]
    pub no_proxy: Option<String>,
    #[serde(default)]
    pub ca_certs_pem: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AiEvent {
    Head { status: u16, headers: Vec<(String, String)> },
    Chunk { base64: String },
    End,
    Error { message: String },
}

fn is_loopback_v4(a: &Ipv4Addr) -> bool { a.is_loopback() }
fn is_local_v4(a: &Ipv4Addr) -> bool { a.is_loopback() || a.is_private() || a.is_link_local() }
fn is_local_v6(a: &Ipv6Addr) -> bool {
    if let Some(v4) = a.to_ipv4_mapped() { return is_local_v4(&v4); }
    let s = a.segments()[0];
    a.is_loopback() || (s & 0xfe00) == 0xfc00 || (s & 0xffc0) == 0xfe80
}

/// (is a local address, is loopback) for the URL's host; `localhost` counts, other names don't.
fn host_kind(u: &reqwest::Url) -> Option<(bool, bool)> {
    let h = u.host_str()?;
    let h = h.strip_prefix('[').and_then(|x| x.strip_suffix(']')).unwrap_or(h);
    match h.parse::<IpAddr>() {
        Ok(IpAddr::V4(a)) => Some((is_local_v4(&a), is_loopback_v4(&a))),
        Ok(IpAddr::V6(a)) => {
            let lb = a.is_loopback() || a.to_ipv4_mapped().is_some_and(|v| v.is_loopback());
            Some((is_local_v6(&a), lb))
        }
        Err(_) => { let l = h.eq_ignore_ascii_case("localhost"); Some((l, l)) }
    }
}

fn origin_of(u: &reqwest::Url) -> Option<(String, String, u16)> {
    Some((u.scheme().to_string(), u.host_str()?.to_ascii_lowercase(), u.port_or_known_default()?))
}

/// Checks the request URL against the connection's origin and the transport rules.
pub fn check_target(url: &str, origin: &str) -> Result<reqwest::Url, String> {
    let u = reqwest::Url::parse(url).map_err(|_| "The assistant address isn’t a valid URL.".to_string())?;
    let o = reqwest::Url::parse(origin).map_err(|_| "The connection’s origin isn’t a valid URL.".to_string())?;
    for x in [&u, &o] {
        if x.scheme() != "http" && x.scheme() != "https" { return Err("The assistant address must start with https:// (or http:// for a local model).".into()); }
        if !x.username().is_empty() || x.password().is_some() { return Err("Addresses with a user name or password in them aren’t allowed.".into()); }
    }
    let (Some(uo), Some(oo)) = (origin_of(&u), origin_of(&o)) else { return Err("The assistant address has no host.".into()) };
    if uo != oo { return Err("The request goes somewhere other than the connection’s address, so the key wasn’t sent.".into()); }
    if u.scheme() == "http" && !host_kind(&u).is_some_and(|(local, _)| local) {
        return Err("Plain http is only allowed for local models (localhost or a private address). Use https.".into());
    }
    Ok(u)
}

/// The error and its causes on one line, without the URL (it can hold a key in its query).
fn describe(e: reqwest::Error) -> String {
    use std::error::Error as _;
    let e = e.without_url();
    let mut msg = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        let part = s.to_string();
        if !msg.contains(&part) { msg.push_str(": "); msg.push_str(&part); }
        src = s.source();
    }
    msg
}

/// Whether a configured proxy may carry this request: https only (a proxy sees plain http in the clear,
/// headers and key included), and never a loopback host.
fn proxy_allowed(u: &reqwest::Url) -> bool {
    let (_, loopback) = host_kind(u).unwrap_or((false, false));
    u.scheme() == "https" && !loopback
}

/// Sends the request and reports events through `emit` (which returns false once nobody listens any more).
/// `Err` means the request was refused before anything was sent; failures after that arrive as `Error` events.
/// A cancel (a value on `cancel`) ends it silently, dropping the connection.
pub async fn stream_core(req: &AiRequest, cancel: oneshot::Receiver<()>, mut emit: impl FnMut(AiEvent) -> bool) -> Result<(), String> {
    use futures_util::StreamExt;
    let url = check_target(&req.url, &req.origin)?;
    let method = reqwest::Method::from_bytes(req.method.as_bytes()).map_err(|_| "Unknown request method.".to_string())?;
    let mut cb = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .user_agent(concat!("Dispatch/", env!("CARGO_PKG_VERSION")));
    match req.proxy.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) if proxy_allowed(&url) => {
            let mut proxy = reqwest::Proxy::all(p).map_err(|_| "The proxy address isn’t valid.".to_string())?;
            if let Some(np) = req.no_proxy.as_deref().filter(|x| !x.trim().is_empty()) { proxy = proxy.no_proxy(reqwest::NoProxy::from_string(np)); }
            cb = cb.proxy(proxy);
        }
        _ => cb = cb.no_proxy(),
    }
    for pem in &req.ca_certs_pem {
        for c in reqwest::Certificate::from_pem_bundle(pem.as_bytes()).map_err(|_| "A CA certificate couldn’t be read.".to_string())? { cb = cb.add_root_certificate(c); }
    }
    let client = cb.build().map_err(describe)?;

    let mut b = client.request(method, url);
    for (k, v) in &req.headers {
        let name = reqwest::header::HeaderName::from_bytes(k.as_bytes()).map_err(|_| "A header name isn’t valid.".to_string())?;
        if name == reqwest::header::HOST { return Err("The Host header can’t be set.".into()); }
        let mut value = reqwest::header::HeaderValue::from_str(v).map_err(|_| "A header value has characters that can’t be sent.".to_string())?;
        value.set_sensitive(true);
        b = b.header(name, value);
    }
    if let Some(body) = &req.body { b = b.body(body.clone()); }

    let cancel = async { if cancel.await.is_err() { std::future::pending::<()>().await } };
    tokio::pin!(cancel);

    let res = tokio::select! {
        biased;
        _ = &mut cancel => return Ok(()),
        r = b.send() => match r { Ok(r) => r, Err(e) => { emit(AiEvent::Error { message: describe(e) }); return Ok(()); } },
    };
    let status = res.status();
    if status.is_redirection() {
        emit(AiEvent::Error { message: format!("The server answered with a redirect ({}). Redirects aren’t followed, so the key stays with the address you set up.", status.as_u16()) });
        return Ok(());
    }
    let headers = res.headers().iter().map(|(k, v)| (k.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned())).collect();
    if !emit(AiEvent::Head { status: status.as_u16(), headers }) { return Ok(()); }
    let mut stream = res.bytes_stream();
    loop {
        tokio::select! {
            biased;
            _ = &mut cancel => return Ok(()),
            next = stream.next() => match next {
                None => { emit(AiEvent::End); return Ok(()); }
                Some(Ok(bytes)) => { if !emit(AiEvent::Chunk { base64: STANDARD.encode(&bytes) }) { return Ok(()); } }
                Some(Err(e)) => { emit(AiEvent::Error { message: describe(e) }); return Ok(()); }
            },
        }
    }
}

/// Streams in flight, by id. A cancel that arrives before its stream starts is remembered.
#[derive(Default)]
pub struct AiInFlight(Mutex<Registry>);

#[derive(Default)]
struct Registry { running: HashMap<u64, oneshot::Sender<()>>, early: HashSet<u64> }

impl AiInFlight {
    /// Registers `id`; Ok(None) when it was cancelled already.
    fn begin(&self, id: u64) -> Result<Option<oneshot::Receiver<()>>, String> {
        let mut r = self.0.lock().unwrap();
        if r.early.remove(&id) { return Ok(None); }
        if r.running.contains_key(&id) { return Err("That assistant request id is already in use.".into()); }
        let (tx, rx) = oneshot::channel();
        r.running.insert(id, tx);
        Ok(Some(rx))
    }
    fn cancel(&self, id: u64) {
        let mut r = self.0.lock().unwrap();
        match r.running.remove(&id) {
            Some(tx) => { let _ = tx.send(()); }
            None => { if r.early.len() >= 256 { r.early.clear(); } r.early.insert(id); }
        }
    }
    fn finish(&self, id: u64) { self.0.lock().unwrap().running.remove(&id); }
}

#[tauri::command]
pub async fn ai_stream(state: tauri::State<'_, AiInFlight>, req: AiRequest, on_event: tauri::ipc::Channel<AiEvent>) -> Result<(), String> {
    let id = req.id;
    let Some(rx) = state.begin(id)? else { return Ok(()) };
    let out = stream_core(&req, rx, |ev| on_event.send(ev).is_ok()).await;
    state.finish(id);
    out
}

#[tauri::command]
pub fn ai_cancel(state: tauri::State<'_, AiInFlight>, id: u64) { state.cancel(id); }

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Instant;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn check_target_accepts() {
        for (u, o) in [
            ("https://api.anthropic.com/v1/messages", "https://api.anthropic.com"),
            ("https://API.anthropic.com:443/v1/messages", "https://api.anthropic.com"),
            ("http://localhost:11434/v1", "http://localhost:11434"),
            ("http://127.0.0.1:1234", "http://127.0.0.1:1234"),
            ("http://[::1]:1", "http://[::1]:1"),
            ("http://192.168.1.5:8000/x", "http://192.168.1.5:8000"),
            ("http://10.1.2.3/x", "http://10.1.2.3:80"),
            ("http://172.20.0.1/x", "http://172.20.0.1"),
            ("http://169.254.1.1/x", "http://169.254.1.1"),
            ("http://[fd00::1]/x", "http://[fd00::1]"),
            ("http://[fe80::1]/x", "http://[fe80::1]"),
            ("http://[::ffff:127.0.0.1]/x", "http://[::ffff:127.0.0.1]"),
        ] { assert!(check_target(u, o).is_ok(), "{u}"); }
    }

    #[test]
    fn check_target_refuses() {
        for (u, o) in [
            ("http://api.example.com", "http://api.example.com"),
            ("http://localhost.evil.com", "http://localhost.evil.com"),
            ("https://127.0.0.1@evil.com", "https://evil.com"),
            ("https://user:pw@api.example.com", "https://api.example.com"),
            ("https://api.example.com/v1", "https://other.example.com"),
            ("https://api.example.com:8443/v1", "https://api.example.com"),
            ("http://localhost:1/v1", "https://localhost:1"),
            ("file:///etc/passwd", "file:///etc/passwd"),
            ("http://172.32.0.1", "http://172.32.0.1"),
            ("http://8.8.8.8", "http://8.8.8.8"),
            ("http://[2001:db8::1]", "http://[2001:db8::1]"),
            ("http://[::ffff:8.8.8.8]", "http://[::ffff:8.8.8.8]"),
            ("not a url", "https://a.com"),
        ] { assert!(check_target(u, o).is_err(), "{u}"); }
    }

    #[test]
    fn check_target_attack_urls() {
        // userinfo that looks like the real origin
        assert!(check_target("http://localhost:11434@evil.com/", "http://localhost:11434").is_err());
        assert!(check_target("http://localhost.evil.com/", "http://localhost:11434").is_err());
        assert!(check_target("http://localhost:11434.evil.com/", "http://localhost:11434").is_err());
        // a backslash is a slash for http(s) URLs, so these name the host in front of it, as the HTTP client reads them
        let u = check_target("http://localhost:11434\\@evil.com/", "http://localhost:11434").unwrap();
        assert_eq!(u.host_str(), Some("localhost"));
        assert!(check_target("http://evil.com\\@localhost:11434/", "http://localhost:11434").is_err());
        assert!(check_target("https://api.example.com\\.evil.com/", "https://api.example.com").is_ok_and(|u| u.host_str() == Some("api.example.com")));
        // numeric spellings are normalised before the checks (2130706433 is 127.0.0.1, 134744072 is 8.8.8.8)
        let u = check_target("http://2130706433:1234/", "http://127.0.0.1:1234").unwrap();
        assert_eq!(u.host_str(), Some("127.0.0.1"));
        assert!(check_target("http://0x7f.1:1234/", "http://127.0.0.1:1234").is_ok());
        assert!(check_target("http://134744072/", "http://8.8.8.8").is_err());
        assert!(check_target("http://2130706433/", "http://localhost").is_err()); // not the connection's origin
    }

    #[test]
    fn proxy_only_for_https_and_never_loopback() {
        let p = |u: &str| proxy_allowed(&reqwest::Url::parse(u).unwrap());
        assert!(p("https://api.anthropic.com/v1"));
        assert!(!p("http://192.168.1.5:8000/v1"));
        assert!(!p("http://10.0.0.2/v1"));
        assert!(!p("http://localhost:11434/v1"));
        assert!(!p("http://127.0.0.1:1/v1"));
        assert!(!p("http://[::1]:1/v1"));
        assert!(!p("https://localhost/v1"));
        assert!(!p("https://127.0.0.1/v1"));
    }

    #[tokio::test]
    async fn loopback_never_goes_through_the_proxy() {
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (tport, pport) = (target.local_addr().unwrap().port(), proxy.local_addr().unwrap().port());
        tokio::spawn(async move {
            let (mut s, _) = target.accept().await.unwrap();
            read_head(&mut s).await;
            let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok").await;
        });
        let proxy_hit = Arc::new(AtomicUsize::new(0));
        let h = proxy_hit.clone();
        tokio::spawn(async move { loop { let _ = proxy.accept().await; h.fetch_add(1, Ordering::SeqCst); } });
        let mut r = req(tport, "/");
        r.proxy = Some(format!("http://127.0.0.1:{pport}"));
        let mut evs = vec![];
        let (_k, rx) = oneshot::channel();
        tokio::time::timeout(Duration::from_secs(5), stream_core(&r, rx, |e| { evs.push(e); true })).await.expect("hung").unwrap();
        assert_eq!(evs.last(), Some(&AiEvent::End));
        assert_eq!(proxy_hit.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn host_header_is_refused() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        for name in ["Host", "host", "hOsT"] {
            let mut r = req(port, "/");
            r.headers.push((name.into(), "evil.com".into()));
            let (_k, rx) = oneshot::channel();
            let e = tokio::time::timeout(Duration::from_secs(2), stream_core(&r, rx, |_| true)).await.expect("it sent the request").unwrap_err();
            assert!(e.contains("Host") && !e.contains("evil.com"), "{e}");
        }
        assert!(tokio::time::timeout(Duration::from_millis(200), l.accept()).await.is_err(), "a connection was made");
    }

    fn req(port: u16, path: &str) -> AiRequest {
        AiRequest { id: 1, method: "POST".into(), url: format!("http://127.0.0.1:{port}{path}"), origin: format!("http://127.0.0.1:{port}"),
            headers: vec![("x-api-key".into(), "sk-secret".into())], body: Some("{}".into()), proxy: None, no_proxy: None, ca_certs_pem: vec![] }
    }

    async fn read_head(s: &mut tokio::net::TcpStream) {
        let mut buf = vec![0u8; 4096];
        let mut got = Vec::new();
        while !got.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = s.read(&mut buf).await.unwrap();
            if n == 0 { return; }
            got.extend_from_slice(&buf[..n]);
        }
    }

    #[tokio::test]
    async fn chunks_arrive_before_the_end() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let (go_tx, go_rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            read_head(&mut s).await;
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n").await.unwrap();
            go_rx.await.unwrap(); // only continues once the client has seen the first chunk
            s.write_all(b"5\r\nworld\r\n0\r\n\r\n").await.unwrap();
        });
        let mut go = Some(go_tx);
        let mut events = vec![];
        let (_keep, rx) = oneshot::channel();
        stream_core(&req(port, "/"), rx, |e| {
            if matches!(e, AiEvent::Chunk { .. }) { if let Some(g) = go.take() { let _ = g.send(()); } }
            events.push(e); true
        }).await.unwrap();
        assert!(matches!(&events[0], AiEvent::Head { status: 200, .. }));
        let text: Vec<String> = events.iter().filter_map(|e| if let AiEvent::Chunk { base64 } = e { Some(String::from_utf8(STANDARD.decode(base64).unwrap()).unwrap()) } else { None }).collect();
        assert_eq!(text.concat(), "helloworld");
        assert_eq!(events.last(), Some(&AiEvent::End));
    }

    #[tokio::test]
    async fn redirect_is_an_error_and_not_followed() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let hits = Arc::new(AtomicUsize::new(0));
        let h = hits.clone();
        tokio::spawn(async move {
            loop {
                let (mut s, _) = l.accept().await.unwrap();
                h.fetch_add(1, Ordering::SeqCst);
                read_head(&mut s).await;
                let _ = s.write_all(format!("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{port}/second\r\nContent-Length: 0\r\n\r\n").as_bytes()).await;
            }
        });
        let mut events = vec![];
        let (_keep, rx) = oneshot::channel();
        stream_core(&req(port, "/"), rx, |e| { events.push(e); true }).await.unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(hits.load(Ordering::SeqCst), 1);
        assert_eq!(events.len(), 1);
        match &events[0] {
            AiEvent::Error { message } => { assert!(message.contains("302")); assert!(!message.contains("sk-secret")); }
            e => panic!("{e:?}"),
        }
    }

    /// A server that sends `n` chunks, a few ms apart, then keeps the connection open, and reports when the client closes it.
    async fn spawn_flood(n: usize) -> (u16, tokio::sync::mpsc::UnboundedReceiver<Instant>) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            loop {
                let (mut s, _) = l.accept().await.unwrap();
                let tx = tx.clone();
                tokio::spawn(async move {
                    read_head(&mut s).await;
                    s.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
                    let (mut rd, mut wr) = s.into_split();
                    // keeps writing, a chunk every few ms, until the client is gone
                    tokio::spawn(async move { for _ in 0..n { if wr.write_all(b"5\r\nhello\r\n").await.is_err() { break; } tokio::time::sleep(Duration::from_millis(3)).await; } });
                    let mut b = [0u8; 64];
                    loop { match rd.read(&mut b).await { Ok(0) | Err(_) => break, _ => {} } }
                    let _ = tx.send(Instant::now());
                });
            }
        });
        (port, rx)
    }

    // Multi-threaded, so the server keeps writing while the callback below blocks.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancel_closes_the_socket_within_a_second_and_nothing_follows() {
        let (port, mut closed) = spawn_flood(400).await;
        tokio::time::timeout(Duration::from_secs(20), async {
            // Many rounds: without `biased` a ready chunk wins half the time, so one round alone could pass by luck.
            for _ in 0..25 {
                let (ctx, crx) = oneshot::channel();
                let mut ctx = Some(ctx);
                let mut cancelled_at = None;
                let mut after = 0;
                stream_core(&req(port, "/"), crx, |e| {
                    if cancelled_at.is_some() { after += 1; }
                    if matches!(e, AiEvent::Chunk { .. }) && ctx.is_some() { cancelled_at = Some(Instant::now()); let _ = ctx.take().unwrap().send(());
                        // more chunks arrive while the cancel is pending
                        std::thread::sleep(Duration::from_millis(25));
                    }
                    true
                }).await.unwrap();
                assert_eq!(after, 0, "events after the cancel");
                let at = closed.recv().await.unwrap();
                assert!(at.duration_since(cancelled_at.unwrap()) < Duration::from_secs(1));
            }
        }).await.expect("hung");
    }

    #[tokio::test]
    async fn cancel_before_connect_sends_nothing() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let (tx, rx) = oneshot::channel();
        tx.send(()).unwrap();
        let mut n = 0;
        tokio::time::timeout(Duration::from_secs(5), stream_core(&req(port, "/"), rx, |_| { n += 1; true })).await.expect("hung").unwrap();
        assert_eq!(n, 0);
        assert!(tokio::time::timeout(Duration::from_millis(200), l.accept()).await.is_err(), "a connection was made");
    }

    #[tokio::test]
    async fn cancel_while_waiting_for_the_answer() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move { let (mut s, _) = l.accept().await.unwrap(); read_head(&mut s).await; tokio::time::sleep(Duration::from_secs(30)).await; });
        let (tx, rx) = oneshot::channel();
        tokio::spawn(async move { tokio::time::sleep(Duration::from_millis(200)).await; let _ = tx.send(()); });
        let t = Instant::now();
        stream_core(&req(port, "/"), rx, |_| true).await.unwrap();
        assert!(t.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn the_frontend_going_away_stops_the_stream() {
        let (port, mut closed) = spawn_flood(400).await;
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut calls = 0;
            let (_keep, rx) = oneshot::channel();
            stream_core(&req(port, "/"), rx, |e| { calls += 1; !matches!(e, AiEvent::Chunk { .. }) }).await.unwrap();
            assert_eq!(calls, 2); // head, then the chunk that found nobody listening
            closed.recv().await.unwrap();
        }).await.expect("hung or socket not closed");
    }

    #[tokio::test]
    async fn refused_target_never_connects_and_errors_hold_no_secrets() {
        // A refused request aimed at a live local listener: nothing may connect.
        let live = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let lport = live.local_addr().unwrap().port();
        let mut r = req(lport, "/?key=sk-secret");
        r.origin = format!("https://127.0.0.1:{lport}"); // scheme differs from the url
        let (_k, rx) = oneshot::channel();
        let e = stream_core(&r, rx, |_| true).await.unwrap_err();
        assert!(!e.contains("sk-secret"));
        assert!(tokio::time::timeout(Duration::from_millis(300), live.accept()).await.is_err(), "a connection was made");
        // a refused connection: the message has no URL (the key can be in its query)
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let mut r = req(port, "/?key=sk-secret");
        r.headers.push(("authorization".into(), "Bearer sk-secret".into()));
        let mut evs = vec![];
        let (_k, rx) = oneshot::channel();
        stream_core(&r, rx, |e| { evs.push(e); true }).await.unwrap();
        match &evs[..] { [AiEvent::Error { message }] => assert!(!message.contains("sk-secret") && !message.contains("127.0.0.1:"), "{message}"), e => panic!("{e:?}") }
    }

    #[test]
    fn registry_cancel_rules() {
        let s = AiInFlight::default();
        s.cancel(99); // unknown id: harmless
        assert!(s.begin(99).unwrap().is_none()); // it arrived early, so that stream never starts
        let mut rx = s.begin(5).unwrap().unwrap();
        assert!(s.begin(5).is_err());
        s.cancel(5);
        assert!(rx.try_recv().is_ok());
        s.finish(5);
        assert!(s.0.lock().unwrap().running.is_empty());
        assert!(s.begin(5).unwrap().is_some()); // the id is free again
    }
}
