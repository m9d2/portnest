#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use hmac::{Hmac, Mac};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command as SystemCommand,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WindowEvent,
};
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};
use tauri_plugin_updater::UpdaterExt;
use tokio::{
    net::TcpListener,
    time::{sleep, timeout_at, Instant},
};
use url::Url;
use uuid::Uuid;

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const EVENT_MAX: usize = 12;
const DETAIL_LOG_MAX: usize = 200;

#[derive(Clone, Deserialize)]
#[serde(default)]
struct RuntimeConfig {
    #[serde(rename = "DISPATCHER_URLS")]
    dispatcher_urls: String,
    #[serde(rename = "CLIENT_SECRET")]
    client_secret: String,
    #[serde(rename = "APP_BRAND")]
    app_brand: String,
    #[serde(rename = "LOCAL_SOCKS_HINT")]
    local_socks_hint: u16,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            dispatcher_urls: "http://127.0.0.1:8422".into(),
            client_secret: String::new(),
            app_brand: "portnest".into(),
            local_socks_hint: 1080,
        }
    }
}

impl RuntimeConfig {
    fn dispatcher_list(&self) -> Vec<String> {
        let list: Vec<String> = self
            .dispatcher_urls
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(String::from)
            .collect();
        if list.is_empty() {
            vec!["http://127.0.0.1:8422".into()]
        } else {
            list
        }
    }
}

struct RuntimeState {
    data: Mutex<ClientState>,
    http: Client,
}

struct ClientState {
    config: RuntimeConfig,
    data_dir: PathBuf,
    machine_id: String,
    device_secret: String,
    clock_skew_ms: i64,
    local_socks_port: u16,
    current_dispatcher_url: String,
    running: bool,
    generation: u64,
    status: String,
    status_message: String,
    assignment: Option<Assignment>,
    tunnel_child: Option<CommandChild>,
    socks_child: Option<CommandChild>,
    socks_supervisor_running: bool,
    tunnel_restarts: usize,
    socks_restarts: usize,
    assist_count: u64,
    share_enabled: bool,
    last_reverse_ok: bool,
    last_frpc_error: String,
    update_downloaded: bool,
    events: Vec<EventItem>,
    logs: Vec<DetailLogItem>,
    network_info: NetworkInfo,
}

impl RuntimeState {
    fn new() -> Self {
        Self {
            data: Mutex::new(ClientState {
                config: RuntimeConfig::default(),
                data_dir: PathBuf::new(),
                machine_id: String::new(),
                device_secret: String::new(),
                clock_skew_ms: 0,
                local_socks_port: 1080,
                current_dispatcher_url: "http://127.0.0.1:8422".into(),
                running: false,
                generation: 0,
                status: "stopped".into(),
                status_message: "未启动".into(),
                assignment: None,
                tunnel_child: None,
                socks_child: None,
                socks_supervisor_running: false,
                tunnel_restarts: 0,
                socks_restarts: 0,
                assist_count: 0,
                share_enabled: true,
                last_reverse_ok: false,
                last_frpc_error: String::new(),
                update_downloaded: false,
                events: Vec::new(),
                logs: Vec::new(),
                network_info: NetworkInfo::default(),
            }),
            http: Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .expect("build http client"),
        }
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkInfo {
    ip: String,
    location: String,
    isp: String,
    updated_at: u128,
}

#[derive(Clone, Deserialize, Serialize)]
struct Assignment {
    #[serde(default)]
    code: String,
    server_ip: String,
    server_port: u16,
    remote_port: u16,
    tunnel_psk: String,
    #[serde(default)]
    tls_server_name: String,
    #[serde(default)]
    proxy_user: String,
    #[serde(default)]
    proxy_pass: String,
    #[serde(default)]
    gateway_host: String,
    #[serde(default = "default_gateway_port")]
    gateway_port: u16,
    #[serde(default)]
    device_secret: String,
    #[serde(default)]
    assist_count: u64,
    #[serde(default = "default_true")]
    share_enabled: bool,
    #[serde(default)]
    verified_recent: bool,
}

fn default_gateway_port() -> u16 {
    1080
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    running: bool,
    machine_id: String,
    local_socks_port: u16,
    assist_count: u64,
    share_enabled: bool,
    has_client_secret: bool,
    dispatcher: String,
    network_info: NetworkInfo,
}

#[derive(Clone, Serialize)]
struct EventItem {
    ts: u128,
    level: String,
    text: String,
}

#[derive(Clone, Serialize)]
struct DetailLogItem {
    ts: u128,
    source: String,
    text: String,
}

#[derive(Clone, Serialize)]
struct StatusPayload {
    state: String,
    message: String,
    running: bool,
}

#[derive(Serialize)]
struct CommandResult {
    ok: bool,
    error: Option<String>,
}

#[derive(Debug)]
struct ApiError {
    message: String,
    status: Option<u16>,
}

impl ApiError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: None,
        }
    }
}

fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn runtime(app: &AppHandle) -> State<'_, RuntimeState> {
    app.state::<RuntimeState>()
}

fn is_active(app: &AppHandle, generation: u64) -> bool {
    let state = runtime(app);
    let data = state.data.lock().expect("runtime mutex poisoned");
    data.running && data.generation == generation
}

fn redact(app: &AppHandle, input: &str) -> String {
    let state = runtime(app);
    let data = state.data.lock().expect("runtime mutex poisoned");
    let mut text = input.replace('\u{1b}', "");
    for base in data.config.dispatcher_list() {
        if let Ok(url) = Url::parse(&base) {
            if let Some(host) = url.host_str() {
                text = text.replace(host, "****");
            }
        }
    }
    if !data.device_secret.is_empty() {
        text = text.replace(&data.device_secret, "[SECRET]");
    }
    if !data.machine_id.is_empty() {
        text = text.replace(
            &data.machine_id,
            &format!("{}...", &data.machine_id[..data.machine_id.len().min(8)]),
        );
    }
    text
}

fn log_detail(app: &AppHandle, source: &str, text: impl AsRef<str>) {
    let clean = redact(app, text.as_ref()).trim_end().to_string();
    if clean.is_empty() {
        return;
    }
    let item = DetailLogItem {
        ts: timestamp_ms(),
        source: source.into(),
        text: clean,
    };
    {
        let state = runtime(app);
        let mut data = state.data.lock().expect("runtime mutex poisoned");
        data.logs.push(item.clone());
        if data.logs.len() > DETAIL_LOG_MAX {
            data.logs.remove(0);
        }
    }
    let _ = app.emit("detailLog", item);
}

fn push_event(app: &AppHandle, level: &str, text: impl Into<String>) {
    let item = EventItem {
        ts: timestamp_ms(),
        level: level.into(),
        text: text.into(),
    };
    let events = {
        let state = runtime(app);
        let mut data = state.data.lock().expect("runtime mutex poisoned");
        data.events.insert(0, item.clone());
        data.events.truncate(EVENT_MAX);
        data.events.clone()
    };
    let _ = app.emit("events", events);
    log_detail(app, "event", format!("[{}] {}", level, item.text));
}

fn set_status(app: &AppHandle, status: &str, message: &str) {
    let running = {
        let state = runtime(app);
        let mut data = state.data.lock().expect("runtime mutex poisoned");
        data.status = status.into();
        data.status_message = message.into();
        data.running
    };
    let _ = app.emit(
        "status",
        StatusPayload {
            state: status.into(),
            message: message.into(),
            running,
        },
    );
}

fn send_progress(app: &AppHandle, stage: u8, tag: &str) {
    let labels = ["", "分配编号", "建立连接", "验证连接", "就绪"];
    let _ = app.emit(
        "progress",
        json!({
            "stage": stage,
            "percent": stage * 25,
            "label": labels.get(stage as usize).unwrap_or(&""),
            "tag": tag
        }),
    );
}

fn read_runtime_config(app: &AppHandle) -> RuntimeConfig {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("runtime-config.json"));
    }
    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.join("runtime-config.json"));
    }
    candidates
        .into_iter()
        .find_map(|path| {
            fs::read_to_string(path)
                .ok()
                .and_then(|text| serde_json::from_str(&text).ok())
        })
        .unwrap_or_default()
}

fn legacy_data_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("portnest-desktop-client")
}

fn load_text(path: &Path) -> String {
    fs::read_to_string(path)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn valid_device_secret(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|char| char.is_ascii_hexdigit())
}

fn save_private(path: &Path, value: &str) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(path, value);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
}

fn derive_machine_id() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = SystemCommand::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
        {
            let text = String::from_utf8_lossy(&output.stdout);
            if let Some(pos) = text.find("IOPlatformUUID") {
                let tail = &text[pos..];
                let parts: Vec<&str> = tail.split('"').collect();
                if parts.len() > 3 && !parts[3].is_empty() {
                    return parts[3].to_lowercase();
                }
            }
        }
    }
    Uuid::new_v4().to_string()
}

fn initialize_runtime(app: &AppHandle) {
    let config = read_runtime_config(app);
    let data_dir = legacy_data_dir(app);
    let machine_path = data_dir.join("machine_id");
    let secret_path = data_dir.join("device_secret");
    let stored_machine = load_text(&machine_path);
    let machine_id = if (8..=64).contains(&stored_machine.len()) {
        stored_machine
    } else {
        let value = derive_machine_id();
        save_private(&machine_path, &value);
        value
    };
    let stored_secret = load_text(&secret_path);
    let device_secret = if valid_device_secret(&stored_secret) {
        stored_secret
    } else {
        String::new()
    };
    let dispatcher = config
        .dispatcher_list()
        .first()
        .cloned()
        .unwrap_or_else(|| "http://127.0.0.1:8422".into());
    let state = runtime(app);
    let mut data = state.data.lock().expect("runtime mutex poisoned");
    data.local_socks_port = config.local_socks_hint;
    data.current_dispatcher_url = dispatcher;
    data.config = config;
    data.data_dir = data_dir;
    data.machine_id = machine_id;
    data.device_secret = device_secret;
}

async fn signed_request(
    app: &AppHandle,
    method: Method,
    url: &str,
    body: Option<Value>,
    secret: &str,
) -> Result<Value, ApiError> {
    let parsed = Url::parse(url).map_err(|error| ApiError::new(error.to_string()))?;
    let body_text = body.as_ref().map(Value::to_string).unwrap_or_default();
    let now = timestamp_ms() as i64;
    let skew = {
        let state = runtime(app);
        let value = state
            .data
            .lock()
            .expect("runtime mutex poisoned")
            .clock_skew_ms;
        value
    };
    let request_time = now + skew;
    let signature_text = format!(
        "{}\n{}\n{}\n{}",
        request_time,
        method.as_str(),
        parsed.path(),
        body_text
    );
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|_| ApiError::new("签名密钥无效"))?;
    mac.update(signature_text.as_bytes());
    let signature = hex::encode(mac.finalize().into_bytes());
    let state = runtime(app);
    let mut request = state
        .http
        .request(method, url)
        .header("content-type", "application/json")
        .header("x-timestamp", request_time.to_string())
        .header("x-sig", signature);
    if !body_text.is_empty() {
        request = request.body(body_text);
    }
    let response = request
        .send()
        .await
        .map_err(|error| ApiError::new(error.to_string()))?;
    if let Some(date) = response
        .headers()
        .get("date")
        .and_then(|item| item.to_str().ok())
    {
        if let Ok(server_time) = httpdate::parse_http_date(date) {
            let drift = server_time
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64
                - timestamp_ms() as i64;
            if drift.abs() > 30_000 {
                let mut data = state.data.lock().expect("runtime mutex poisoned");
                data.clock_skew_ms = drift;
            }
        }
    }
    let status = response.status();
    let raw = response.text().await.unwrap_or_default();
    let parsed_body = serde_json::from_str(&raw).unwrap_or_else(|_| json!({ "raw": raw }));
    if status.is_success() {
        Ok(parsed_body)
    } else {
        let detail = parsed_body
            .get("error")
            .or_else(|| parsed_body.get("detail"))
            .and_then(Value::as_str)
            .unwrap_or("");
        Err(ApiError {
            message: format!("HTTP {}: {}", status.as_u16(), detail),
            status: Some(status.as_u16()),
        })
    }
}

async fn http_json(
    app: &AppHandle,
    method: Method,
    path: &str,
    body: Option<Value>,
    device_scoped: bool,
) -> Result<Value, ApiError> {
    let (targets, secret) = {
        let state = runtime(app);
        let data = state.data.lock().expect("runtime mutex poisoned");
        let secret = if device_scoped && !data.device_secret.is_empty() {
            data.device_secret.clone()
        } else {
            data.config.client_secret.clone()
        };
        let targets = if path.starts_with("http://") || path.starts_with("https://") {
            vec![path.into()]
        } else {
            data.config
                .dispatcher_list()
                .into_iter()
                .map(|base| format!("{}{}", base.trim_end_matches('/'), path))
                .collect()
        };
        (targets, secret)
    };
    if secret.is_empty() {
        return Err(ApiError::new(
            "缺少 CLIENT_SECRET，请配置 runtime-config.json",
        ));
    }
    let mut errors = Vec::new();
    for target in targets {
        match signed_request(app, method.clone(), &target, body.clone(), &secret).await {
            Ok(result) => {
                if let Ok(url) = Url::parse(&target) {
                    let state = runtime(app);
                    let mut data = state.data.lock().expect("runtime mutex poisoned");
                    data.current_dispatcher_url = url.origin().ascii_serialization();
                }
                return Ok(result);
            }
            Err(error) => {
                if device_scoped && error.status == Some(403) {
                    let secret_file = {
                        let state = runtime(app);
                        let mut data = state.data.lock().expect("runtime mutex poisoned");
                        data.device_secret.clear();
                        data.data_dir.join("device_secret")
                    };
                    let _ = fs::remove_file(secret_file);
                }
                log_detail(
                    app,
                    "http",
                    format!("{} {} 失败: {}", method, target, error.message),
                );
                errors.push(error);
            }
        }
    }
    Err(errors
        .pop()
        .unwrap_or_else(|| ApiError::new("无法连接到调度中心")))
}

async fn ensure_local_port(app: &AppHandle) -> Result<u16, String> {
    let first = {
        let state = runtime(app);
        let value = state
            .data
            .lock()
            .expect("runtime mutex poisoned")
            .local_socks_port;
        value
    };
    for port in first..first.saturating_add(20) {
        if TcpListener::bind(("127.0.0.1", port)).await.is_ok() {
            if port != first {
                push_event(
                    app,
                    "info",
                    format!("端口 {} 被占用，已切到 {}", first, port),
                );
                runtime(app)
                    .data
                    .lock()
                    .expect("runtime mutex poisoned")
                    .local_socks_port = port;
            }
            return Ok(port);
        }
    }
    Err(format!(
        "无可用本地端口（{}-{}）",
        first,
        first.saturating_add(19)
    ))
}

fn backoff_delay(restarts: usize) -> Duration {
    Duration::from_millis([3000, 6000, 12000, 30000, 60000][restarts.min(4)])
}

async fn register_with_dispatcher(app: &AppHandle) -> Result<Assignment, ApiError> {
    let (machine_id, config, dispatcher) = {
        let state = runtime(app);
        let data = state.data.lock().expect("runtime mutex poisoned");
        (
            data.machine_id.clone(),
            data.config.clone(),
            data.current_dispatcher_url.clone(),
        )
    };
    set_status(app, "connecting", "正在分配编号");
    send_progress(app, 1, "register");
    log_detail(app, "reg", format!("POST /register via {}", dispatcher));
    let result = http_json(
        app,
        Method::POST,
        "/register",
        Some(json!({
            "machine_id": machine_id,
            "app_version": APP_VERSION,
            "app_brand": config.app_brand,
            "os_platform": node_platform(),
            "os_arch": node_arch(),
            "hostname": hostname::get().unwrap_or_default().to_string_lossy()
        })),
        false,
    )
    .await?;
    let assignment: Assignment =
        serde_json::from_value(result).map_err(|error| ApiError::new(error.to_string()))?;
    let (local_port, machine_id) = {
        let state = runtime(app);
        let mut data = state.data.lock().expect("runtime mutex poisoned");
        if valid_device_secret(&assignment.device_secret) {
            data.device_secret = assignment.device_secret.clone();
            save_private(&data.data_dir.join("device_secret"), &data.device_secret);
        }
        data.assist_count = assignment.assist_count;
        data.share_enabled = assignment.share_enabled;
        (data.local_socks_port, data.machine_id.clone())
    };
    let gateway = if assignment.gateway_host.is_empty() {
        assignment.server_ip.clone()
    } else {
        assignment.gateway_host.clone()
    };
    let _ = app.emit(
        "config",
        json!({
            "code": assignment.code,
            "gatewayHost": gateway,
            "gatewayPort": assignment.gateway_port,
            "local_socks_port": local_port,
            "machineId": machine_id,
            "server": format!("{}:{}", assignment.server_ip, assignment.server_port),
            "verified_recent": assignment.verified_recent
        }),
    );
    let _ = app.emit(
        "metrics",
        json!({ "assistCount": assignment.assist_count, "shareEnabled": assignment.share_enabled }),
    );
    push_event(
        app,
        "info",
        if assignment.code.is_empty() {
            "编号已分配".into()
        } else {
            format!("出口编号已就绪 ({})", assignment.code)
        },
    );
    send_progress(app, 2, "register_done");
    Ok(assignment)
}

fn node_platform() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        return "darwin";
    }
    #[cfg(target_os = "windows")]
    {
        return "win32";
    }
    #[cfg(target_os = "linux")]
    {
        return "linux";
    }
    #[allow(unreachable_code)]
    "unknown"
}

fn node_arch() -> &'static str {
    #[cfg(target_arch = "aarch64")]
    {
        return "arm64";
    }
    #[cfg(target_arch = "x86_64")]
    {
        return "x64";
    }
    #[allow(unreachable_code)]
    "unknown"
}

fn toml_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn write_frpc_config(
    app: &AppHandle,
    assignment: &Assignment,
    proxy_name: &str,
) -> Result<PathBuf, String> {
    let (path, port) = {
        let state = runtime(app);
        let data = state.data.lock().expect("runtime mutex poisoned");
        (data.data_dir.join("frpc.toml"), data.local_socks_port)
    };
    let tls_name = if assignment.tls_server_name.is_empty() {
        "frp"
    } else {
        &assignment.tls_server_name
    };
    let config = format!(
        "serverAddr = \"{}\"\nserverPort = {}\nauth.method = \"token\"\nauth.token = \"{}\"\ntransport.tls.enable = true\ntransport.tls.disableCustomTLSFirstByte = true\ntransport.tls.serverName = \"{}\"\ntransport.tcpMux = true\ntransport.poolCount = 5\ntransport.heartbeatInterval = 15\ntransport.heartbeatTimeout = 60\nloginFailExit = false\nlog.level = \"info\"\n\n[[proxies]]\nname = \"{}\"\ntype = \"tcp\"\nlocalIP = \"127.0.0.1\"\nlocalPort = {}\nremotePort = {}\n",
        toml_escape(&assignment.server_ip),
        assignment.server_port,
        toml_escape(&assignment.tunnel_psk),
        toml_escape(tls_name),
        toml_escape(proxy_name),
        port,
        assignment.remote_port,
    );
    save_private(&path, &config);
    Ok(path)
}

fn launch_socks_supervisor(app: &AppHandle, generation: u64) {
    let should_launch = {
        let state = runtime(app);
        let mut data = state.data.lock().expect("runtime mutex poisoned");
        if data.socks_supervisor_running {
            false
        } else {
            data.socks_supervisor_running = true;
            true
        }
    };
    if should_launch {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move { socks_supervisor(handle, generation).await });
    }
}

async fn socks_supervisor(app: AppHandle, generation: u64) {
    while is_active(&app, generation) {
        let (port, user, pass) = {
            let state = runtime(&app);
            let data = state.data.lock().expect("runtime mutex poisoned");
            let (user, pass) = data
                .assignment
                .as_ref()
                .map(|a| (a.proxy_user.clone(), a.proxy_pass.clone()))
                .unwrap_or_default();
            (data.local_socks_port, user, pass)
        };
        let listen = if user.is_empty() || pass.is_empty() {
            format!("socks5://127.0.0.1:{}", port)
        } else {
            format!(
                "socks5://{}:{}@127.0.0.1:{}",
                utf8_percent_encode(&user, NON_ALPHANUMERIC),
                utf8_percent_encode(&pass, NON_ALPHANUMERIC),
                port
            )
        };
        log_detail(
            &app,
            "socks5",
            format!(
                "spawn gost -L socks5://{}127.0.0.1:{}",
                if user.is_empty() { "" } else { "***:***@" },
                port
            ),
        );
        let (mut rx, child) = match app
            .shell()
            .sidecar("gost")
            .and_then(|cmd| cmd.args(["-L", &listen]).spawn())
        {
            Ok(result) => result,
            Err(error) => {
                log_detail(&app, "socks5", format!("启动失败: {}", error));
                sleep(backoff_delay(0)).await;
                continue;
            }
        };
        runtime(&app)
            .data
            .lock()
            .expect("runtime mutex poisoned")
            .socks_child = Some(child);
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    log_detail(&app, "socks5", String::from_utf8_lossy(&line));
                }
                CommandEvent::Error(error) => log_detail(&app, "socks5", error),
                CommandEvent::Terminated(payload) => {
                    log_detail(&app, "socks5", format!("exit code={:?}", payload.code));
                    break;
                }
                _ => {}
            }
        }
        let delay = {
            let state = runtime(&app);
            let mut data = state.data.lock().expect("runtime mutex poisoned");
            data.socks_child.take();
            let delay = backoff_delay(data.socks_restarts);
            data.socks_restarts += 1;
            delay
        };
        if is_active(&app, generation) {
            sleep(delay).await;
        }
    }
    runtime(&app)
        .data
        .lock()
        .expect("runtime mutex poisoned")
        .socks_supervisor_running = false;
}

fn diagnose_frpc_error(line: &str) -> String {
    let lower = line.to_lowercase();
    if lower.contains("eof") || lower.contains("connection reset") {
        "连接被中断，可能有代理或防火墙干扰".into()
    } else if lower.contains("timeout") {
        "连接远端超时，请检查网络".into()
    } else if lower.contains("authentication") {
        "隧道认证失败，正在重新注册".into()
    } else if lower.contains("tls") || lower.contains("certificate") {
        "TLS 握手失败，请检查中间代理".into()
    } else {
        format!("连接失败：{}", line.chars().take(80).collect::<String>())
    }
}

async fn report_node_error(app: &AppHandle, exit_code: Option<i32>, error_text: String) {
    if error_text.is_empty() {
        return;
    }
    let machine_id = runtime(app)
        .data
        .lock()
        .expect("runtime mutex poisoned")
        .machine_id
        .clone();
    let _ = http_json(
        app,
        Method::POST,
        "/node/report-error",
        Some(json!({
            "machine_id": machine_id,
            "component": "frpc",
            "exit_code": exit_code,
            "error_msg": error_text
        })),
        true,
    )
    .await;
}

async fn tunnel_supervisor(app: AppHandle, generation: u64) {
    while is_active(&app, generation) {
        let assignment = {
            let state = runtime(&app);
            let value = state
                .data
                .lock()
                .expect("runtime mutex poisoned")
                .assignment
                .clone();
            value
        };
        let assignment = match assignment {
            Some(value) => value,
            None => match register_with_dispatcher(&app).await {
                Ok(value) => {
                    runtime(&app)
                        .data
                        .lock()
                        .expect("runtime mutex poisoned")
                        .assignment = Some(value.clone());
                    value
                }
                Err(error) => {
                    push_event(&app, "error", "暂时无法接入服务，稍后自动重试");
                    set_status(&app, "reconnecting", &error.message);
                    log_detail(&app, "reg", format!("register 失败: {}", error.message));
                    let delay = {
                        let state = runtime(&app);
                        let mut data = state.data.lock().expect("runtime mutex poisoned");
                        let delay = backoff_delay(data.tunnel_restarts);
                        data.tunnel_restarts += 1;
                        delay
                    };
                    sleep(delay).await;
                    continue;
                }
            },
        };
        if !is_active(&app, generation) {
            break;
        }
        if let Err(error) = ensure_local_port(&app).await {
            push_event(&app, "error", error);
            break;
        }
        if !is_active(&app, generation) {
            break;
        }
        launch_socks_supervisor(&app, generation);
        let proxy_name = format!(
            "portnest-{}-{}",
            timestamp_ms(),
            &Uuid::new_v4().simple().to_string()[..8]
        );
        let config_path = match write_frpc_config(&app, &assignment, &proxy_name) {
            Ok(path) => path,
            Err(error) => {
                push_event(&app, "error", error);
                break;
            }
        };
        log_detail(
            &app,
            "tunnel",
            format!(
                "spawn frpc -> {}:{} remote={} proxy={}",
                assignment.server_ip, assignment.server_port, assignment.remote_port, proxy_name
            ),
        );
        set_status(&app, "connecting", "正在建立连接");
        let (mut rx, child) = match app
            .shell()
            .sidecar("frpc")
            .and_then(|cmd| cmd.args(["-c", &config_path.to_string_lossy()]).spawn())
        {
            Ok(value) => value,
            Err(error) => {
                log_detail(&app, "frpc", format!("启动失败: {}", error));
                sleep(backoff_delay(0)).await;
                continue;
            }
        };
        runtime(&app)
            .data
            .lock()
            .expect("runtime mutex poisoned")
            .tunnel_child = Some(child);
        let deadline = Instant::now() + Duration::from_secs(45);
        let mut proxy_ready = false;
        let mut login_success = false;
        let mut exit_code = None;
        loop {
            let event = if proxy_ready {
                rx.recv().await
            } else {
                match timeout_at(deadline, rx.recv()).await {
                    Ok(event) => event,
                    Err(_) => {
                        push_event(&app, "warn", "连接超时，正在重试");
                        kill_tunnel(&app);
                        break;
                    }
                }
            };
            match event {
                Some(CommandEvent::Stdout(line)) | Some(CommandEvent::Stderr(line)) => {
                    let line = String::from_utf8_lossy(&line).trim_end().to_string();
                    log_detail(&app, "frpc", &line);
                    let lower = line.to_lowercase();
                    if lower.contains("login to server success") {
                        login_success = true;
                        let state = runtime(&app);
                        let mut data = state.data.lock().expect("runtime mutex poisoned");
                        data.last_frpc_error.clear();
                        data.tunnel_restarts = 0;
                        drop(data);
                        send_progress(&app, 3, "tunnel_up");
                        set_status(&app, "connecting", "即将就绪");
                    }
                    if !proxy_ready && lower.contains("start proxy success") {
                        proxy_ready = true;
                        send_progress(&app, 4, "ready");
                        set_status(&app, "connected", "服务运行中");
                        push_event(&app, "ok", "已就绪 · 服务运行中");
                        let _ = app.emit(
                            "probeStatus",
                            json!({
                                "state": if assignment.verified_recent { "ok" } else { "pending" },
                                "startedAt": timestamp_ms()
                            }),
                        );
                    }
                    if lower.contains("authentication failed")
                        || (lower.contains("auth") && lower.contains("invalid"))
                    {
                        runtime(&app)
                            .data
                            .lock()
                            .expect("runtime mutex poisoned")
                            .assignment = None;
                        push_event(&app, "warn", "隧道配置失效，正在重新接入");
                        kill_tunnel(&app);
                    } else if lower.contains("already exists") {
                        runtime(&app)
                            .data
                            .lock()
                            .expect("runtime mutex poisoned")
                            .last_frpc_error = line.clone();
                        push_event(&app, "warn", "隧道名称冲突，正在重试");
                        kill_tunnel(&app);
                    } else if lower.contains("connect to server error")
                        || lower.contains("failed")
                        || lower.contains("error")
                    {
                        if !login_success {
                            runtime(&app)
                                .data
                                .lock()
                                .expect("runtime mutex poisoned")
                                .last_frpc_error = line.clone();
                        }
                        push_event(&app, "warn", diagnose_frpc_error(&line));
                    }
                }
                Some(CommandEvent::Error(error)) => log_detail(&app, "frpc", error),
                Some(CommandEvent::Terminated(payload)) => {
                    exit_code = payload.code;
                    log_detail(&app, "frpc", format!("exit code={:?}", payload.code));
                    break;
                }
                None => break,
                _ => {}
            }
        }
        let (delay, last_error) = {
            let state = runtime(&app);
            let mut data = state.data.lock().expect("runtime mutex poisoned");
            data.tunnel_child.take();
            data.last_reverse_ok = false;
            let delay = backoff_delay(data.tunnel_restarts);
            let last_error = data.last_frpc_error.clone();
            data.tunnel_restarts += 1;
            if data.tunnel_restarts % 9 == 0 {
                data.assignment = None;
            }
            (delay, last_error)
        };
        if is_active(&app, generation) {
            let report_app = app.clone();
            tauri::async_runtime::spawn(async move {
                report_node_error(&report_app, exit_code, last_error).await;
            });
            set_status(
                &app,
                "reconnecting",
                &format!("{}s 后重试", delay.as_secs()),
            );
            sleep(delay).await;
        }
    }
}

async fn probe_sidecar(app: &AppHandle, name: &str, args: &[&str]) -> Value {
    match app.shell().sidecar(name) {
        Ok(command) => match command.args(args).output().await {
            Ok(output) => json!({
                "ok": output.status.success(),
                "output": format!(
                    "{}{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                ).trim()
            }),
            Err(error) => json!({ "ok": false, "error": error.to_string() }),
        },
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    }
}

fn kill_tunnel(app: &AppHandle) {
    let child = runtime(app)
        .data
        .lock()
        .expect("runtime mutex poisoned")
        .tunnel_child
        .take();
    if let Some(child) = child {
        let _ = child.kill();
    }
}

fn kill_socks(app: &AppHandle) {
    let child = runtime(app)
        .data
        .lock()
        .expect("runtime mutex poisoned")
        .socks_child
        .take();
    if let Some(child) = child {
        let _ = child.kill();
    }
}

async fn status_loop(app: AppHandle, generation: u64) {
    loop {
        if !is_active(&app, generation) {
            break;
        }
        let (machine_id, connected) = {
            let state = runtime(&app);
            let data = state.data.lock().expect("runtime mutex poisoned");
            (
                data.machine_id.clone(),
                data.status == "connected" && data.assignment.is_some(),
            )
        };
        if !connected {
            sleep(Duration::from_secs(20)).await;
            continue;
        }
        match http_json(
            &app,
            Method::GET,
            &format!("/status?mid={}", machine_id),
            None,
            true,
        )
        .await
        {
            Ok(value) => {
                if let Some(probe) = value.get("last_probe") {
                    if probe
                        .get("age_ms")
                        .and_then(Value::as_u64)
                        .unwrap_or(u64::MAX)
                        <= 120_000
                    {
                        let ok = probe.get("ok").and_then(Value::as_bool).unwrap_or(false);
                        let state = runtime(&app);
                        let mut data = state.data.lock().expect("runtime mutex poisoned");
                        if ok && !data.last_reverse_ok {
                            let _ = app.emit("probeStatus", json!({ "state": "ok" }));
                        } else if !ok {
                            let _ = app.emit("probeStatus", json!({ "state": "failed" }));
                        }
                        data.last_reverse_ok = ok;
                    }
                }
            }
            Err(error) => log_detail(&app, "status", error.message),
        }
        sleep(Duration::from_secs(20)).await;
    }
}

async fn heartbeat_loop(app: AppHandle, generation: u64) {
    sleep(Duration::from_secs(3)).await;
    loop {
        if !is_active(&app, generation) {
            break;
        }
        let machine_id = runtime(&app)
            .data
            .lock()
            .expect("runtime mutex poisoned")
            .machine_id
            .clone();
        match http_json(
            &app,
            Method::POST,
            "/heartbeat",
            Some(json!({ "machine_id": machine_id })),
            true,
        )
        .await
        {
            Ok(result) => {
                let (count, share) = {
                    let state = runtime(&app);
                    let mut data = state.data.lock().expect("runtime mutex poisoned");
                    if let Some(count) = result.get("assist_count").and_then(Value::as_u64) {
                        data.assist_count = count;
                    }
                    if let Some(share) = result.get("share_enabled").and_then(Value::as_bool) {
                        data.share_enabled = share;
                    }
                    (data.assist_count, data.share_enabled)
                };
                let _ = app.emit(
                    "metrics",
                    json!({ "assistCount": count, "shareEnabled": share }),
                );
            }
            Err(error) => {
                log_detail(&app, "heartbeat", &error.message);
                if error.status == Some(404) || error.message.contains("not registered") {
                    runtime(&app)
                        .data
                        .lock()
                        .expect("runtime mutex poisoned")
                        .assignment = None;
                    kill_tunnel(&app);
                }
            }
        }
        sleep(Duration::from_secs(5 * 60)).await;
    }
}

async fn refresh_network_info(app: &AppHandle) -> NetworkInfo {
    let cached = runtime(app)
        .data
        .lock()
        .expect("runtime mutex poisoned")
        .network_info
        .clone();
    let result = runtime(app)
        .http
        .get("http://ip-api.com/json/?lang=zh-CN&fields=status,message,query,regionName,city,isp,org")
        .send()
        .await
        .ok()
        .and_then(|response| response.error_for_status().ok());
    if let Some(response) = result {
        if let Ok(value) = response.json::<Value>().await {
            if value.get("status").and_then(Value::as_str) == Some("success") {
                let region = value
                    .get("regionName")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let city = value.get("city").and_then(Value::as_str).unwrap_or("");
                let info = NetworkInfo {
                    ip: value
                        .get("query")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .into(),
                    location: if region == city {
                        region.into()
                    } else {
                        format!("{} {}", region, city).trim().into()
                    },
                    isp: value
                        .get("isp")
                        .or_else(|| value.get("org"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .into(),
                    updated_at: timestamp_ms(),
                };
                runtime(app)
                    .data
                    .lock()
                    .expect("runtime mutex poisoned")
                    .network_info = info.clone();
                let _ = app.emit("networkInfo", info.clone());
                return info;
            }
        }
    }
    cached
}

async fn start_runtime(app: AppHandle) -> CommandResult {
    let generation = {
        let state = runtime(&app);
        let mut data = state.data.lock().expect("runtime mutex poisoned");
        if data.running {
            return CommandResult {
                ok: true,
                error: None,
            };
        }
        if data.config.client_secret.is_empty() {
            return CommandResult {
                ok: false,
                error: Some("缺少 CLIENT_SECRET，请配置 runtime-config.json".into()),
            };
        }
        data.running = true;
        data.generation += 1;
        data.tunnel_restarts = 0;
        data.socks_restarts = 0;
        data.socks_supervisor_running = false;
        data.generation
    };
    set_status(&app, "connecting", "正在连接服务");
    let _ = app.emit("probeStatus", json!({ "state": "pending" }));
    let net_app = app.clone();
    tauri::async_runtime::spawn(async move { refresh_network_info(&net_app).await });
    let tunnel_app = app.clone();
    tauri::async_runtime::spawn(async move { tunnel_supervisor(tunnel_app, generation).await });
    let status_app = app.clone();
    tauri::async_runtime::spawn(async move { status_loop(status_app, generation).await });
    tauri::async_runtime::spawn(async move { heartbeat_loop(app, generation).await });
    CommandResult {
        ok: true,
        error: None,
    }
}

async fn stop_runtime(app: AppHandle) -> CommandResult {
    let machine_id = {
        let state = runtime(&app);
        let mut data = state.data.lock().expect("runtime mutex poisoned");
        data.running = false;
        data.generation += 1;
        data.assignment = None;
        data.socks_supervisor_running = false;
        data.machine_id.clone()
    };
    kill_tunnel(&app);
    kill_socks(&app);
    if !machine_id.is_empty() {
        let offline_app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = http_json(
                &offline_app,
                Method::POST,
                "/node/offline",
                Some(json!({ "machine_id": machine_id })),
                true,
            )
            .await;
        });
    }
    set_status(&app, "stopped", "已停止");
    let _ = app.emit("probeStatus", json!({ "state": "idle" }));
    CommandResult {
        ok: true,
        error: None,
    }
}

#[tauri::command]
fn get_state(runtime: State<'_, RuntimeState>) -> Snapshot {
    let data = runtime.data.lock().expect("runtime mutex poisoned");
    Snapshot {
        running: data.running,
        machine_id: data.machine_id.clone(),
        local_socks_port: data.local_socks_port,
        assist_count: data.assist_count,
        share_enabled: data.share_enabled,
        has_client_secret: !data.config.client_secret.is_empty(),
        dispatcher: data.current_dispatcher_url.clone(),
        network_info: data.network_info.clone(),
    }
}

#[tauri::command]
fn get_events(runtime: State<'_, RuntimeState>) -> Vec<EventItem> {
    runtime
        .data
        .lock()
        .expect("runtime mutex poisoned")
        .events
        .clone()
}

#[tauri::command]
fn get_detail_log(runtime: State<'_, RuntimeState>) -> Vec<DetailLogItem> {
    runtime
        .data
        .lock()
        .expect("runtime mutex poisoned")
        .logs
        .clone()
}

#[tauri::command]
async fn get_network_info(app: AppHandle) -> NetworkInfo {
    refresh_network_info(&app).await
}

#[tauri::command]
async fn start(app: AppHandle) -> CommandResult {
    start_runtime(app).await
}

#[tauri::command]
async fn stop(app: AppHandle) -> CommandResult {
    stop_runtime(app).await
}

#[tauri::command]
async fn check_for_updates(app: AppHandle) -> CommandResult {
    log_detail(&app, "update", "正在检查更新");
    let _ = app.emit("update", json!({ "state": "checking" }));
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            return CommandResult {
                ok: false,
                error: Some(error.to_string()),
            };
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.to_string();
            log_detail(&app, "update", format!("发现新版本 {}", version));
            let _ = app.emit(
                "update-available",
                json!({ "version": version, "currentVersion": APP_VERSION }),
            );
            let _ = app.emit(
                "update",
                json!({ "state": "available", "version": version }),
            );
            CommandResult {
                ok: true,
                error: None,
            }
        }
        Ok(None) => {
            log_detail(&app, "update", format!("当前已是最新版本 {}", APP_VERSION));
            let _ = app.emit(
                "update",
                json!({ "state": "not-available", "version": APP_VERSION }),
            );
            CommandResult {
                ok: true,
                error: None,
            }
        }
        Err(error) => {
            let message = error.to_string();
            log_detail(&app, "update", &message);
            let _ = app.emit("update", json!({ "state": "error", "message": message }));
            CommandResult {
                ok: false,
                error: Some(message),
            }
        }
    }
}

#[tauri::command]
async fn download_update(app: AppHandle) -> CommandResult {
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(error) => {
            return CommandResult {
                ok: false,
                error: Some(error.to_string()),
            };
        }
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            return CommandResult {
                ok: false,
                error: Some("没有可下载的更新".into()),
            };
        }
        Err(error) => {
            return CommandResult {
                ok: false,
                error: Some(error.to_string()),
            };
        }
    };
    let version = update.version.to_string();
    let progress_version = version.clone();
    let received = Arc::new(AtomicU64::new(0));
    let progress_received = received.clone();
    let progress_app = app.clone();
    match update
        .download_and_install(
            move |chunk_length, content_length| {
                let total_received = progress_received
                    .fetch_add(chunk_length as u64, Ordering::Relaxed)
                    + chunk_length as u64;
                let percent = content_length
                    .filter(|total| *total > 0)
                    .map(|total| total_received.saturating_mul(100) / total)
                    .unwrap_or(0);
                let _ = progress_app.emit(
                    "update",
                    json!({
                        "state": "downloading",
                        "version": progress_version,
                        "percent": percent,
                        "transferred": total_received,
                        "total": content_length
                    }),
                );
            },
            || {},
        )
        .await
    {
        Ok(()) => {
            runtime(&app)
                .data
                .lock()
                .expect("runtime mutex poisoned")
                .update_downloaded = true;
            log_detail(&app, "update", format!("新版本 {} 已下载", version));
            let _ = app.emit(
                "update",
                json!({ "state": "downloaded", "version": version }),
            );
            CommandResult {
                ok: true,
                error: None,
            }
        }
        Err(error) => {
            let message = error.to_string();
            log_detail(&app, "update", &message);
            let _ = app.emit("update", json!({ "state": "error", "message": message }));
            CommandResult {
                ok: false,
                error: Some(message),
            }
        }
    }
}

#[tauri::command]
async fn install_update(app: AppHandle) -> CommandResult {
    let downloaded = runtime(&app)
        .data
        .lock()
        .expect("runtime mutex poisoned")
        .update_downloaded;
    if !downloaded {
        return CommandResult {
            ok: false,
            error: Some("update not downloaded".into()),
        };
    }
    stop_runtime(app.clone()).await;
    app.restart();
}

#[tauri::command]
async fn run_self_check(app: AppHandle) -> Value {
    let dispatcher = http_json(&app, Method::GET, "/health", None, false)
        .await
        .map(|_| json!({ "ok": true }))
        .unwrap_or_else(|error| json!({ "ok": false, "error": error.message }));
    let gost = probe_sidecar(&app, "gost", &["-V"]).await;
    let frpc = probe_sidecar(&app, "frpc", &["-v"]).await;
    json!({
        "dispatcher": dispatcher,
        "gost": gost,
        "frpc": frpc,
        "local_socks_port": get_state(runtime(&app)).local_socks_port
    })
}

#[tauri::command]
async fn build_diagnostic(app: AppHandle) -> Value {
    let snapshot = get_state(runtime(&app));
    let assignment = runtime(&app)
        .data
        .lock()
        .expect("runtime mutex poisoned")
        .assignment
        .clone();
    json!({
        "app": { "version": APP_VERSION, "brand": "portnest", "platform": node_platform(), "arch": node_arch() },
        "runtime": "tauri",
        "running": snapshot.running,
        "machine_id": if snapshot.machine_id.is_empty() { "".into() } else { format!("{}...", &snapshot.machine_id[..snapshot.machine_id.len().min(8)]) },
        "assignment": assignment,
        "recent_events": get_events(runtime(&app)),
        "recent_logs": get_detail_log(runtime(&app))
    })
}

#[tauri::command]
async fn toggle_share(app: AppHandle, enabled: bool) -> Result<Value, String> {
    let machine_id = runtime(&app)
        .data
        .lock()
        .expect("runtime mutex poisoned")
        .machine_id
        .clone();
    let result = http_json(
        &app,
        Method::POST,
        "/node/share",
        Some(json!({ "machine_id": machine_id, "enabled": enabled })),
        true,
    )
    .await
    .map_err(|error| error.message)?;
    let count = {
        let state = runtime(&app);
        let mut data = state.data.lock().expect("runtime mutex poisoned");
        data.share_enabled = enabled;
        data.assist_count
    };
    let _ = app.emit(
        "metrics",
        json!({ "assistCount": count, "shareEnabled": enabled }),
    );
    Ok(result)
}

#[tauri::command]
async fn get_earnings(app: AppHandle) -> Result<Value, String> {
    let machine_id = runtime(&app)
        .data
        .lock()
        .expect("runtime mutex poisoned")
        .machine_id
        .clone();
    http_json(
        &app,
        Method::GET,
        &format!("/node/earnings?mid={}", machine_id),
        None,
        true,
    )
    .await
    .map_err(|error| error.message)
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> CommandResult {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return CommandResult {
            ok: false,
            error: Some("不支持的链接".into()),
        };
    }
    #[allow(deprecated)]
    match app.shell().open(url, None) {
        Ok(()) => CommandResult {
            ok: true,
            error: None,
        },
        Err(error) => CommandResult {
            ok: false,
            error: Some(error.to_string()),
        },
    }
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示 PortNest", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "启动 / 停止服务", true, None::<&str>)?;
    let updates = MenuItem::with_id(app, "update", "检查更新", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &toggle, &updates, &separator, &quit])?;
    let mut builder = TrayIconBuilder::with_id("portnest-tray")
        .tooltip("PortNest")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "toggle" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let running = runtime(&handle)
                        .data
                        .lock()
                        .expect("runtime mutex poisoned")
                        .running;
                    if running {
                        stop_runtime(handle).await;
                    } else {
                        start_runtime(handle).await;
                    }
                });
            }
            "update" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    check_for_updates(handle).await;
                });
            }
            "quit" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    stop_runtime(handle.clone()).await;
                    handle.exit(0);
                });
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(RuntimeState::new())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            start,
            stop,
            get_state,
            get_events,
            get_detail_log,
            get_network_info,
            check_for_updates,
            download_update,
            install_update,
            run_self_check,
            build_diagnostic,
            toggle_share,
            get_earnings,
            open_external
        ])
        .setup(|app| {
            initialize_runtime(app.handle());
            setup_tray(app)?;
            let has_secret = !app
                .state::<RuntimeState>()
                .data
                .lock()
                .expect("runtime mutex poisoned")
                .config
                .client_secret
                .is_empty();
            set_status(
                app.handle(),
                "stopped",
                if has_secret {
                    "未启动"
                } else {
                    "缺少 CLIENT_SECRET"
                },
            );
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                push_event(window.app_handle(), "info", "窗口已隐藏，可从状态栏恢复");
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running PortNest");
}
