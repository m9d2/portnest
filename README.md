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

## GitHub Release Builds

Repository: `m9d2/portnest`

GitHub Actions builds macOS arm64 and x64 packages when a tag matching `v*` is pushed. The workflow publishes assets to GitHub Releases and generates `latest-mac.yml` for `electron-updater`.

Configure these GitHub repository secrets before tagging a release:

- `DISPATCHER_URLS`: production dispatcher URL, for example `http://43.130.53.127:8422`
- `CLIENT_SECRET`: client HMAC secret

The workflow writes `runtime-config.json` during CI from those secrets. Do not commit `runtime-config.json`.

Release flow:

```bash
npm version patch
git push
git push --tags
```

Unsigned macOS builds are generated with `CSC_IDENTITY_AUTO_DISCOVERY=false`. They can be installed, but macOS may show Gatekeeper warnings. For a smoother production install and update experience, add Apple Developer ID signing and notarization secrets later.
