# Tauri Migration

PortNest is being migrated alongside the existing Electron application. The
Electron release path remains the production path until the Rust runtime has
been exercised against the service and the updater is implemented.

## Implemented

- Tauri 2 application shell using the existing renderer assets.
- Compatibility bridge exposing the existing `window.api` surface in Tauri.
- macOS and Windows `frpc` / `gost` sidecar bundle preparation.
- Window close-to-hide behavior and tray menu controls.
- Runtime config and existing Electron data-directory identity loading.
- Signed dispatcher registration, heartbeat, status polling, share and
  earnings requests.
- Managed `gost` and `frpc` sidecars with log forwarding, stop handling and
  reconnect backoff.

## Local Commands

```bash
npm install
npm run tauri:prepare
npm run tauri:check
```

`npm run tauri:dev` starts the Tauri application only when interactive testing
is intended.

## Next Work

1. Exercise start, reconnect and stop behavior against a test dispatcher.
2. Complete diagnostic binary probing and error reporting parity.
3. Add the Tauri updater and replace the Electron release metadata for Tauri
   artifacts.
4. Add a parallel GitHub Actions build once the Tauri client can establish a
   real tunnel.
5. Switch the default scripts to Tauri and remove Electron after verification.
