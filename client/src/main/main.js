const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

let mainWindow;

// 后端 API 基地址。
// 优先级：环境变量 API_BASE > 默认 http://localhost:3001（与 server 默认端口一致）。
// 供渲染进程在 file:// 协议下仍能正确访问后端（登录/接口/视频代理）。
const API_BASE = (process.env.API_BASE || 'http://localhost:3001').replace(/\/+$/, '');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 768,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // 安全加固：禁止渲染进程加载不必要的能力
      sandbox: false,
      webSecurity: true,
    },
    icon: path.join(__dirname, '../../public/icon.png'),
    title: 'Movie Room - 共享观影室',
    show: false
  });

  // 开发环境加载 vite dev server，生产环境加载 dist/index.html
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  if (isDev) {
    // 开发服务器地址可被覆盖，避免端口被占用时加载到错误页面
    const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools();
  } else {
    // 打包后 __dirname 为 app.asar/src/main，dist 位于 app.asar/dist，
    // 故需向上两级。原写法 '../dist' 会解析到 app.asar/src/dist 导致白屏。
    mainWindow.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  // 禁止导航到外部页面与新窗口，避免被诱导打开任意站点
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = process.env.NODE_ENV === 'development'
      ? 'http://localhost:5173'
      : 'file://';
    if (!String(url).startsWith(allowed)) {
      event.preventDefault();
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
}

// 返回后端 API 基地址，供渲染进程在 file:// 协议下正确访问后端
ipcMain.handle('get-api-base', async () => API_BASE);

// 选择视频文件
ipcMain.handle('select-video-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: '视频文件', extensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const filePath = result.filePaths[0];

  // 兜底：仅允许读取实际存在的普通文件，避免对设备/管道等特殊路径取 stat
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return null;

    return {
      path: filePath,
      name: path.basename(filePath),
      size: stats.size,
      lastModified: stats.mtimeMs
    };
  } catch {
    return null;
  }
});

// 获取文件流（用于播放本地视频）
ipcMain.handle('get-file-info', async (event, filePath) => {
  // 仅接受字符串且必须是绝对路径，避免探测任意相对路径
  if (typeof filePath !== 'string' || !filePath || !path.isAbsolute(filePath)) {
    return { exists: false };
  }
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return { exists: false };
    return {
      exists: true,
      size: stats.size,
      name: path.basename(filePath)
    };
  } catch {
    return { exists: false };
  }
});

// 将本地文件转换为可访问的 URL（仅用于视频播放）
ipcMain.handle('get-video-url', async (event, filePath) => {
  // 使用 pathToFileURL 正确转义空格、中文与 # ? & 等特殊字符。
  // 手工拼接 `file://${path}` 在这些情况下会被截断或解析失败。
  if (typeof filePath !== 'string' || !filePath || !path.isAbsolute(filePath)) {
    return null;
  }
  try {
    if (!fs.statSync(filePath).isFile()) return null;
    return pathToFileURL(filePath).href;
  } catch {
    return null;
  }
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
