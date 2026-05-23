(function setupTauriBridge() {
  if (window.api || !window.__TAURI__) return;

  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  window.api = {
    start: () => invoke('start'),
    stop: () => invoke('stop'),
    copy: (text) => navigator.clipboard.writeText(String(text || '')),
    getState: () => invoke('get_state'),
    getEvents: () => invoke('get_events'),
    getDetailLog: () => invoke('get_detail_log'),
    getNetworkInfo: () => invoke('get_network_info'),
    checkForUpdates: () => invoke('check_for_updates'),
    downloadUpdate: () => invoke('download_update'),
    installUpdate: () => invoke('install_update'),
    runSelfCheck: () => invoke('run_self_check'),
    buildDiagnostic: () => invoke('build_diagnostic'),
    toggleShare: (enabled) => invoke('toggle_share', { enabled: !!enabled }),
    getEarnings: () => invoke('get_earnings'),
    openExternal: (url) => invoke('open_external', { url: String(url || '') }),
    on: (channel, callback) => {
      let dispose = null;
      listen(channel, (event) => callback(event.payload)).then((unlisten) => {
        dispose = unlisten;
      });
      return () => {
        if (dispose) dispose();
      };
    },
  };
})();
