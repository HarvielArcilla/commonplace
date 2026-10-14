// Electron main process: runs CommonDrive (sync, storage, networking) and
// hosts the window. The window never touches the network or the disk; it
// talks to this process over a narrow IPC surface defined in preload.cjs.

import { app, BrowserWindow, ipcMain, clipboard, shell } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import { Drive } from '@commonplace/drive'
import { docsApp } from '@commonplace/docs'

const here = path.dirname(fileURLToPath(import.meta.url))

// COMMONPLACE_PROFILE=bob lets you run a second, independent copy on the same
// computer (separate identity and files), which is handy for trying sync.
const profile = process.env.COMMONPLACE_PROFILE
if (profile) app.setPath('userData', `${app.getPath('userData')}-${profile.replace(/[^a-z0-9-]/gi, '')}`)

if (!profile && !app.requestSingleInstanceLock()) app.quit()

let win = null
let drive = null
let pendingInvite = null
const openDocs = new Set()

function findInvite (argv) {
  return argv.find((a) => typeof a === 'string' && a.startsWith('commonplace://')) || null
}

function deliverInvite (url) {
  if (!url) return
  if (win && !win.webContents.isLoading()) {
    win.webContents.send('invite:received', url)
    if (win.isMinimized()) win.restore()
    win.focus()
  } else {
    pendingInvite = url
  }
}

// commonplace:// links open the app with an invite.
if (process.defaultApp) {
  app.setAsDefaultProtocolClient('commonplace', process.execPath, [path.resolve(process.argv[1] || '.')])
} else {
  app.setAsDefaultProtocolClient('commonplace')
}
app.on('open-url', (event, url) => { event.preventDefault(); deliverInvite(url) }) // macOS
app.on('second-instance', (_e, argv) => deliverInvite(findInvite(argv))) // Windows
pendingInvite = findInvite(process.argv)

function send (channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function createWindow () {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    title: 'Commonplace',
    backgroundColor: '#fbfbf9',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true
    }
  })
  win.removeMenu?.()
  win.loadFile(path.join(here, '..', 'renderer', 'index.html'))
  win.webContents.on('did-finish-load', () => {
    if (pendingInvite) { send('invite:received', pendingInvite); pendingInvite = null }
  })
  // Links inside documents open in the system browser, never in the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.on('closed', () => { win = null; openDocs.clear() })
}

function registerIpc () {
  ipcMain.handle('me', () => drive.me())
  ipcMain.handle('profile:set', (_e, patch) => { drive.setProfile(patch); return drive.me() })
  ipcMain.handle('drive:list', () => drive.list())
  ipcMain.handle('drive:create', (_e, type, title) => drive.create(type, title))
  ipcMain.handle('drive:join', (_e, invite) => drive.join(invite))
  ipcMain.handle('drive:remove', (_e, docId) => { openDocs.delete(docId); return drive.remove(docId) })
  ipcMain.handle('drive:copyInvite', (_e, docId) => {
    const invite = drive.invite(docId)
    if (invite) clipboard.writeText(invite)
    return invite
  })

  // Opening a document hands the window a full copy plus current presence.
  // From then on, updates flow both ways as small binary messages.
  ipcMain.handle('doc:open', (_e, docId, clientId) => {
    const doc = drive.getDoc(docId)
    if (!doc) throw new Error('This file is no longer in your Drive.')
    openDocs.add(docId)
    drive.engine.registerLocalClient(docId, clientId)
    drive.markOpened(docId)
    const states = [...doc.awareness.getStates().keys()]
    return {
      state: Y.encodeStateAsUpdate(doc.ydoc),
      awareness: awarenessProtocol.encodeAwarenessUpdate(doc.awareness, states),
      file: drive.describe(docId)
    }
  })
  ipcMain.handle('doc:close', (_e, docId) => { openDocs.delete(docId) })
  ipcMain.on('doc:update', (_e, docId, update) => drive.engine.applyLocalUpdate(docId, update, 'renderer'))
  ipcMain.on('doc:awareness', (_e, docId, update) => drive.engine.applyLocalAwareness(docId, update, 'renderer'))
}

app.whenReady().then(async () => {
  drive = new Drive({ dataDir: app.getPath('userData'), apps: [docsApp] })
  drive.on('error', (err) => console.error('[commonplace]', err))
  drive.on('changed', () => send('drive:changed', drive.list(), drive.me()))
  drive.engine.on('update', (docId, update, origin) => {
    if (origin !== 'renderer' && origin !== 'disk' && openDocs.has(docId)) send('doc:update', docId, update)
  })
  drive.engine.on('awareness', (docId, update, origin) => {
    if (origin !== 'renderer' && openDocs.has(docId)) send('doc:awareness', docId, update)
  })
  registerIpc()
  await drive.start()
  createWindow()

  app.on('activate', () => { if (!win) createWindow() })
})

// Quitting stops sharing. On macOS the app keeps running (and keeps serving
// your documents to collaborators) after the window closes, like most Mac apps.
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

let stopping = false
app.on('before-quit', (event) => {
  if (stopping || !drive) return
  event.preventDefault()
  stopping = true
  drive.stop().catch(() => {}).finally(() => app.quit())
})
