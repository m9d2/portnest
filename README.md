# PortNest Desktop Client

Electron + Node.js + plain HTML desktop client for a dispatcher-managed SOCKS5 reverse tunnel.

## Layout

- `src/main.js`: Electron main process, dispatcher API client, local process supervisor.
- `src/preload.js`: safe IPC bridge for the renderer.
- `src/renderer/index.html`: single-page desktop UI.
- `bin/darwin-arm64/`: Apple Silicon `gost` and `frpc`.
- `bin/darwin-x64/`: Intel macOS `gost` and `frpc`.
- `bin/win32-x64/`: Windows x64 `gost.exe` and `frpc.exe`.
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

## GitHub Release Builds

Repository: `m9d2/portnest`

GitHub Actions builds macOS arm64/x64 and Windows x64 packages when a tag matching `v*` is pushed. The workflow publishes assets to GitHub Releases and generates update metadata for `electron-updater`.

Configure these GitHub repository secrets before tagging a release:

- `DISPATCHER_URLS`: production dispatcher URL, for example `http://43.130.53.127:8422`
- `CLIENT_SECRET`: client HMAC secret

The workflow writes `runtime-config.json` during CI from those secrets. Do not commit `runtime-config.json`.

Release flow:

```bash
npm run release -- 1.0.1
```

macOS builds are unsigned because the project does not currently use an Apple Developer ID certificate. Gatekeeper may report the downloaded app as damaged. For local testing, remove the quarantine flag after installing:

```bash
xattr -dr com.apple.quarantine /Applications/PortNest.app
```

Windows builds use the checked-in `bin/win32-x64` tunnel binaries and produce an unsigned NSIS installer.
