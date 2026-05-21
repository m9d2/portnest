# PortNest macOS Client

Electron + Node.js + plain HTML client for a dispatcher-managed SOCKS5 reverse tunnel.

## Layout

- `src/main.js`: Electron main process, dispatcher API client, local process supervisor.
- `src/preload.js`: safe IPC bridge for the renderer.
- `src/renderer/index.html`: single-page macOS-style UI.
- `bin/darwin-arm64/gost`: place `gost` here for Apple Silicon builds.
- `bin/darwin-arm64/frpc`: place `frpc` here for Apple Silicon builds.
- `runtime-config.json`: local runtime config, copied from `runtime-config.example.json`.

## Run

```bash
npm install
cp runtime-config.example.json runtime-config.json
npm start
```

`CLIENT_SECRET` is intentionally not hardcoded. Put it in `runtime-config.json` or the environment only for your own deployment.

## Server

The Go dispatcher/API server lives in `server/`.

```bash
cd server
CLIENT_SECRET='change-me' TUNNEL_PSK='change-me' SERVER_IP='127.0.0.1' go run ./cmd/aidnet-server
```

The reverse tunnel transport still requires a matching `frps` process. See `server/README.md` and `server/configs/frps.example.toml`.
