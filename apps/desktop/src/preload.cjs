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
  copyInvite: (docId, role, options) => ipcRenderer.invoke('drive:copyInvite', docId, role, options),
  approveRequest: (docId, userId, role) => ipcRenderer.invoke('request:approve', docId, userId, role),
  declineRequest: (docId, userId) => ipcRenderer.invoke('request:decline', docId, userId),
  setMemberRole: (docId, userId, role) => ipcRenderer.invoke('member:role', docId, userId, role),
  removeMember: (docId, userId) => ipcRenderer.invoke('member:remove', docId, userId),
  transferOwnership: (docId, userId) => ipcRenderer.invoke('member:transfer', docId, userId),
  resetInvites: (docId) => ipcRenderer.invoke('invites:reset', docId),
  setSyncMode: (docId, mode) => ipcRenderer.invoke('file:syncMode', docId, mode),
  listConflicts: (docId) => ipcRenderer.invoke('conflicts:list', docId),
  resolveConflict: (docId, id, choice) => ipcRenderer.invoke('conflicts:resolve', docId, id, choice),
  startMove: () => ipcRenderer.invoke('move:start'),
  cancelMove: () => ipcRenderer.invoke('move:cancel'),
  receiveMove: (code) => ipcRenderer.invoke('move:receive', code),
  onMoveStatus: listen('move:status'),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  onDriveChanged: listen('drive:changed'),
  onInvite: listen('invite:received'),

  openDoc: (docId, clientId) => ipcRenderer.invoke('doc:open', docId, clientId),
  closeDoc: (docId) => ipcRenderer.invoke('doc:close', docId),
  sendUpdate: (docId, update) => ipcRenderer.send('doc:update', docId, update),
  sendAwareness: (docId, update) => ipcRenderer.send('doc:awareness', docId, update),
  onDocUpdate: listen('doc:update'),
  onDocAwareness: listen('doc:awareness')
})
