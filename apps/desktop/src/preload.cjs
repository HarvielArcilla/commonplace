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
  createFile: (type, title) => ipcRenderer.invoke('drive:create', type, title),
  joinWithInvite: (invite) => ipcRenderer.invoke('drive:join', invite),
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
