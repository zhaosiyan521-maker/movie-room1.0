const { contextBridge, ipcRenderer } = require('electron');

// 暴露安全的 API 给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  // 获取后端 API 基地址（Electron 打包环境下前端以 file:// 加载，
  // 相对路径 '/api' 会失效，必须用绝对地址指向后端）
  getApiBase: () => ipcRenderer.invoke('get-api-base'),

  // 选择视频文件
  selectVideoFile: () => ipcRenderer.invoke('select-video-file'),
  
  // 获取文件信息
  getFileInfo: (filePath) => ipcRenderer.invoke('get-file-info', filePath),
  
  // 获取视频 URL
  getVideoUrl: (filePath) => ipcRenderer.invoke('get-video-url', filePath),
  
  // 平台信息
  platform: process.platform,
  
  // 是否在 Electron 中运行
  isElectron: true
});
