// The only bridge between the window and the background process.
const { contextBridge, ipcRenderer } = require('electron')

const listen = (channel) => (fn) => {
  const handler = (_e, ...args) => fn(...args)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('commonplace', {
  platform: process.platform,
  me: () => ipcRenderer.invoke('me'),
  setProfile: (patch) => ipcRenderer.invoke('profile:set', patch),

  listFiles: () => ipcRenderer.invoke('drive:list'),
  listFolders: () => ipcRenderer.invoke('drive:folders'),
  listApps: () => ipcRenderer.invoke('drive:apps'),
  createFile: (type, title, folderId) => ipcRenderer.invoke('drive:create', type, title, folderId),
  joinWithInvite: (invite, folderId) => ipcRenderer.invoke('drive:join', invite, folderId),
  createFolder: (name, parentId) => ipcRenderer.invoke('folder:create', name, parentId),
  renameFolder: (id, name) => ipcRenderer.invoke('folder:rename', id, name),
  deleteFolder: (id) => ipcRenderer.invoke('folder:delete', id),
  moveFolder: (id, parentId) => ipcRenderer.invoke('folder:move', id, parentId),
  moveFile: (docId, folderId) => ipcRenderer.invoke('file:move', docId, folderId),
  importFile: (folderId) => ipcRenderer.invoke('file:import', folderId),
  exportFile: (docId, format, payload) => ipcRenderer.invoke('file:export', docId, format, payload),
  pickImage: () => ipcRenderer.invoke('file:pickImage'),
  openLink: (url) => ipcRenderer.invoke('link:open', url),
  removeFile: (docId) => ipcRenderer.invoke('drive:remove', docId),
  copyInvite: (docId) => ipcRenderer.invoke('drive:copyInvite', docId),
  onDriveChanged: listen('drive:changed'),
  onInvite: listen('invite:received'),

  openDoc: (docId, clientId) => ipcRenderer.invoke('doc:open', docId, clientId),
  closeDoc: (docId) => ipcRenderer.invoke('doc:close', docId),
  sendUpdate: (docId, update) => ipcRenderer.send('doc:update', docId, update),
  sendAwareness: (docId, update) => ipcRenderer.send('doc:awareness', docId, update),
  onDocUpdate: listen('doc:update'),
  onDocAwareness: listen('doc:awareness')
})
