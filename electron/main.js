// NurseScheduler v4 - Electron main process
// Python FastAPI 서버를 자식 프로세스로 실행하고 BrowserWindow로 UI 표시

const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

let pythonProcess = null;
let mainWindow = null;
let serverPort = null;
let startupError = null;

function getPythonExePath() {
  // 패키징된 앱: resources/NurseScheduler/NurseScheduler(.exe)
  // 개발 모드: ../dist/NurseScheduler/NurseScheduler(.exe)
  // Windows는 .exe, macOS/Linux는 확장자 없음 (PyInstaller onedir 실행파일명)
  const exeName = process.platform === 'win32' ? 'NurseScheduler.exe' : 'NurseScheduler';
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'NurseScheduler', exeName);
  }
  return path.join(__dirname, '..', 'dist', 'NurseScheduler', exeName);
}

function startPythonServer() {
  return new Promise((resolve, reject) => {
    const exePath = getPythonExePath();
    if (!fs.existsSync(exePath)) {
      reject(new Error(`Python 서버 실행파일을 찾을 수 없습니다:\n${exePath}`));
      return;
    }

    console.log('[NurseScheduler] Python 서버 시작:', exePath);
    pythonProcess = spawn(exePath, [], {
      cwd: path.dirname(exePath),
      windowsHide: true,
      // Electron이 자체 창으로 UI를 띄우므로 Python이 브라우저(크롬)를 중복 오픈하지 않도록 억제
      env: { ...process.env, NURSE_NO_BROWSER: '1' },
    });

    let stdoutBuffer = '';
    pythonProcess.stdout.on('data', (data) => {
      const text = data.toString();
      stdoutBuffer += text;
      console.log('[python]', text.trim());

      // main.py가 "PORT:5757" 형식으로 포트를 출력
      const portMatch = stdoutBuffer.match(/PORT:(\d+)/);
      if (portMatch && !serverPort) {
        serverPort = parseInt(portMatch[1], 10);
        console.log('[NurseScheduler] 서버 포트:', serverPort);
        waitForServerReady(serverPort)
          .then(() => resolve(serverPort))
          .catch(reject);
      }
    });

    pythonProcess.stderr.on('data', (data) => {
      console.error('[python err]', data.toString().trim());
    });

    pythonProcess.on('error', (err) => {
      console.error('[NurseScheduler] Python 프로세스 에러:', err);
      reject(err);
    });

    pythonProcess.on('exit', (code) => {
      console.log('[NurseScheduler] Python 프로세스 종료:', code);
      if (!serverPort) {
        reject(new Error(`Python 서버가 시작되지 못했습니다 (exit code ${code})`));
      }
    });

    // 30초 타임아웃
    setTimeout(() => {
      if (!serverPort) {
        reject(new Error('Python 서버 시작 타임아웃 (30초)'));
      }
    }, 30000);
  });
}

function waitForServerReady(port, maxAttempts = 60) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      attempts++;
      const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 1000 }, (res) => {
        if (res.statusCode === 200) {
          console.log('[NurseScheduler] 서버 준비 완료');
          resolve();
        } else {
          retry();
        }
        res.resume();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (attempts >= maxAttempts) {
        reject(new Error('서버 응답 타임아웃'));
      } else {
        setTimeout(check, 500);
      }
    };
    check();
  });
}

function createWindow(port) {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, '..', 'resources', 'app.asar', 'icon.ico')
    : path.join(__dirname, '..', 'build', 'icon.ico');
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 600,
    title: 'NurseScheduler v4',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    frame: false,            // 프레임리스 — 앱 자체 커스텀 제목표시줄 사용 (frontend .titlebar)
    backgroundColor: '#f8f9fb',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 커스텀 제목표시줄 ↔ 창 최대화 상태 동기화 (최대화/복원 아이콘 토글)
  mainWindow.on('maximize',   () => mainWindow.webContents.send('win:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('win:maximized', false));

  // 외부 링크는 기본 브라우저로
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  // 메뉴 간소화 (파일/편집/보기만)
  const template = [
    {
      label: '파일',
      submenu: [
        { label: '새로고침', role: 'reload', accelerator: 'F5' },
        { type: 'separator' },
        { label: '종료', role: 'quit', accelerator: 'Alt+F4' },
      ],
    },
    {
      label: '편집',
      submenu: [
        { label: '실행 취소', role: 'undo' },
        { label: '다시 실행', role: 'redo' },
        { type: 'separator' },
        { label: '잘라내기', role: 'cut' },
        { label: '복사', role: 'copy' },
        { label: '붙여넣기', role: 'paste' },
        { label: '모두 선택', role: 'selectAll' },
      ],
    },
    {
      label: '보기',
      submenu: [
        { label: '확대', role: 'zoomIn', accelerator: 'Ctrl+=' },
        { label: '축소', role: 'zoomOut', accelerator: 'Ctrl+-' },
        { label: '실제 크기', role: 'resetZoom', accelerator: 'Ctrl+0' },
        { type: 'separator' },
        { label: '전체화면', role: 'togglefullscreen', accelerator: 'F11' },
        { type: 'separator' },
        { label: '개발자 도구', role: 'toggleDevTools', accelerator: 'F12' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── 커스텀 제목표시줄 창 제어 IPC (preload의 electronWin → 여기) ──────────────
ipcMain.on('win:minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.on('win:maximize-toggle', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('win:close', () => { if (mainWindow) mainWindow.close(); });
ipcMain.handle('win:is-maximized', () => !!(mainWindow && mainWindow.isMaximized()));

function showErrorAndQuit(err) {
  console.error('[NurseScheduler] 시작 실패:', err);
  dialog.showErrorBox(
    'NurseScheduler 시작 실패',
    `${err.message}\n\n앱을 종료합니다.`
  );
  app.quit();
}

app.whenReady().then(async () => {
  try {
    const port = await startPythonServer();
    createWindow(port);
  } catch (err) {
    showErrorAndQuit(err);
  }
});

// 종료 전 프로필 close(재암호화)를 서버에 요청 — 렌더러 beforeunload의 fetch는
// 창 파괴와 경쟁해 완료가 보장되지 않으므로 main 프로세스에서 동기적으로 대기한다.
function requestProfileClose(timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!serverPort) { resolve(); return; }
    const req = http.request({
      hostname: '127.0.0.1', port: serverPort,
      path: '/api/profiles/close', method: 'POST',
      timeout: timeoutMs,
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.end();
  });
}

let shuttingDown = false;
async function shutdownPython() {
  if (!pythonProcess) return;
  console.log('[NurseScheduler] 프로필 닫기 요청 후 Python 종료 중...');
  await requestProfileClose();
  if (pythonProcess) {
    pythonProcess.kill();
    pythonProcess = null;
  }
}

app.on('window-all-closed', async () => {
  if (!shuttingDown) {
    shuttingDown = true;
    await shutdownPython();
  }
  app.quit();
});

app.on('before-quit', (event) => {
  if (pythonProcess && !shuttingDown) {
    shuttingDown = true;
    event.preventDefault();
    shutdownPython().then(() => app.quit());
  }
});

// 단일 인스턴스만 실행
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
