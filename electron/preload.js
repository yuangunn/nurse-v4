// NurseScheduler v4 — Electron preload
// 렌더러 프로세스에 노출할 API (필요 시 확장)
// 현재는 보안상 비워두고, 렌더러는 localhost API만 사용

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronInfo', {
  isElectron: true,
  version: '4.3.6',
});

// 커스텀 제목표시줄(프레임리스) 창 제어 — frontend .titlebar 버튼에서 호출
contextBridge.exposeInMainWorld('electronWin', {
  minimize: () => ipcRenderer.send('win:minimize'),
  maximizeToggle: () => ipcRenderer.send('win:maximize-toggle'),
  close: () => ipcRenderer.send('win:close'),
  isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
  onMaximized: (cb) => ipcRenderer.on('win:maximized', (_e, v) => cb(!!v)),
});
