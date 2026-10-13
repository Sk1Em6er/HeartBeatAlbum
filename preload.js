// 渲染进程与主进程之间的安全桥梁
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('album', {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (data) => ipcRenderer.invoke('data:save', data),
  pickPhoto: () => ipcRenderer.invoke('photo:pick'),
  savePhoto: (dataUrl) => ipcRenderer.invoke('photo:save', dataUrl),
  getPhoto: (fileName) => ipcRenderer.invoke('photo:get', fileName),
  deletePhoto: (fileName) => ipcRenderer.invoke('photo:delete', fileName),
  openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'),
  paths: () => ipcRenderer.invoke('app:paths'),

  // 图片库（pictures 文件夹）
  libraryList: () => ipcRenderer.invoke('library:list'),
  libraryThumb: (name) => ipcRenderer.invoke('library:thumb', name),
  libraryAdd: () => ipcRenderer.invoke('library:add'),
  libraryUse: (name) => ipcRenderer.invoke('library:use', name),
  libraryRemove: (name) => ipcRenderer.invoke('library:remove', name),
  libraryOpen: () => ipcRenderer.invoke('library:open'),

  // 背景音乐文件夹
  musicList: () => ipcRenderer.invoke('music:list'),
  musicAdd: () => ipcRenderer.invoke('music:add'),
  openMusicFolder: () => ipcRenderer.invoke('music:open')
});
