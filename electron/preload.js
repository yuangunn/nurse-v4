// NurseScheduler v4 — Electron preload
// 렌더러 프로세스에 노출할 API (필요 시 확장)
// 현재는 보안상 비워두고, 렌더러는 localhost API만 사용

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronInfo', {
  isElectron: true,
  version: '4.0.3',
});
