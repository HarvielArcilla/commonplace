// Electron main process: runs commonDrive (sync, storage, networking) and
// hosts the window. The window never touches the network or the disk; it
// talks to this process over a narrow IPC surface defined in preload.cjs.

import fsSync from 'node:fs'
import { app, BrowserWindow, ipcMain, clipboard, shell, dialog, Notification, nativeImage, Menu, screen } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import DHT from 'hyperdht'
import { Drive, sendDrive, receiveDrive, newMoveCode, Backups, readBackupFile, restoreBackup, fileKind, safeFileName, POLICY_FIELDS, POLICY_GROUPS } from '@commonplace/drive'
import { docsApps } from '@commonplace/docs'
import { sheetsApp } from '@commonplace/sheets'
import { exportXlsx, importXlsx, exportCsv, importCsv } from '@commonplace/sheets/convert'
import { slidesApp } from '@commonplace/slides'
import { exportPptx } from '@commonplace/slides/convert'
import { formsApp } from '@commonplace/forms'
import { tasksApp } from '@commonplace/tasks'
import { exportCsv as tasksCsv, exportMarkdown as tasksMarkdown } from '@commonplace/tasks/convert'
import { calendarApp } from '@commonplace/calendar'
import { exportIcs, importIcs } from '@commonplace/calendar/ics'
import { importPptx, MAX_PPTX_BYTES } from '@commonplace/slides/pptx-import'
import { whiteboardApp } from '@commonplace/whiteboard'
import { formServices } from './forms.js'
import { linkServices } from './links.js'
import { Reminders } from './reminders.js'
import { Updates } from './updates.js'
import { readPage, PAGE_SIZES, DEFAULT_PAGE, pageLine } from '@commonplace/docs/page'
import { exportDocx, importDocx } from '@commonplace/docs/convert'

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }

const here = path.dirname(fileURLToPath(import.meta.url))
const APPS = [...docsApps, sheetsApp, slidesApp, tasksApp, calendarApp, whiteboardApp, formsApp]

// COMMONPLACE_PROFILE=bob lets you run a second, independent copy on the same
// computer (separate identity and files), which is handy for trying sync.
// Your files and identity stay in the folder earlier versions used
// ("Commonplace"), whatever the app is called now.
if (path.basename(app.getPath('userData')) === 'commonplace') app.setPath('userData', path.join(app.getPath('appData'), 'Commonplace'))
const profile = process.env.COMMONPLACE_PROFILE
if (profile) app.setPath('userData', `${app.getPath('userData')}-${profile.replace(/[^a-z0-9-]/gi, '')}`)

if (!profile && !app.requestSingleInstanceLock()) app.quit()

// Our name and icon, also when running from source (the Electron binary
// itself is renamed by scripts/brand.mjs at install time).
const ICON = path.join(here, '..', 'build', 'icon.png')
app.setName('commonplace')
if (process.platform === 'win32') app.setAppUserModelId('org.commonplace.desktop')
app.setAboutPanelOptions?.({ applicationName: 'commonplace', applicationVersion: app.getVersion(), copyright: 'MIT License' })

let win = null
let updates = null
let drive = null
let pendingInvite = null
let pendingNotice = null // shown once the window has loaded
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

// Settings that belong to this computer's app rather than to a Drive.
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json')
function readSettings () {
  try { return JSON.parse(fsSync.readFileSync(settingsFile(), 'utf8')) } catch { return {} }
}
function writeSettings (patch) {
  const next = { ...readSettings(), ...patch }
  try { fsSync.writeFileSync(settingsFile(), JSON.stringify(next, null, 2)) } catch {}
  return next
}

// Right-click in text: spelling suggestions first, then cut, copy and paste.
function editMenu (p) {
  if (!win) return
  const items = []
  if (p.misspelledWord) {
    for (const word of p.dictionarySuggestions.slice(0, 5)) items.push({ label: word, click: () => win?.webContents.replaceMisspelling(word) })
    if (!items.length) items.push({ label: 'No suggestions', enabled: false })
    items.push({ label: 'Add to dictionary', click: () => win?.webContents.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: 'separator' })
  }
  if (p.isEditable) items.push({ role: 'cut', enabled: p.editFlags.canCut }, { role: 'copy', enabled: p.editFlags.canCopy }, { role: 'paste', enabled: p.editFlags.canPaste }, { type: 'separator' }, { role: 'selectAll' })
  else if (p.selectionText) items.push({ role: 'copy' })
  if (items.length) Menu.buildFromTemplate(items).popup({ window: win })
}

// A header or footer for Chromium's PDF printer, which fills in the page numbers.
function pdfPageLine (text, title) {
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
  const parts = pageLine(text).map((p) => typeof p === 'string' ? esc(p) : p.field === 'page' ? '<span class="pageNumber"></span>' : p.field === 'pages' ? '<span class="totalPages"></span>' : esc(p.field === 'title' ? title : new Date().toLocaleDateString()))
  return `<div style="width:100%;text-align:center;font-size:9px;color:#8a8f9b;font-family:Georgia,serif">${parts.join('')}</div>`
}

function send (channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
}

function createWindow () {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    title: 'commonplace',
    backgroundColor: '#fbfbf9',
    icon: ICON,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Centered in the 52px top bar; the bar leaves 84px for them (body.mac).
    trafficLightPosition: { x: 20, y: 20 },
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
    if (pendingNotice) { send('notice', pendingNotice); pendingNotice = null }
  })
  // Links inside documents open in the system browser, never in the app.
  // The one window the app opens itself is the audience's while presenting.
  win.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (url === 'about:blank' && frameName === 'commonplace-audience') return { action: 'allow', overrideBrowserWindowOptions: audienceWindow() }
    openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.session.setSpellCheckerEnabled(readSettings().spellcheck !== false)
  win.webContents.on('context-menu', (_e, p) => editMenu(p))
  win.on('closed', () => { win = null; openDocs.clear() })
}

// Full screen on another display when there is one, otherwise a window
// that can be dragged to a projector (F makes it full screen).
function audienceWindow () {
  const here = screen.getDisplayMatching(win.getBounds())
  const other = screen.getAllDisplays().find((d) => d.id !== here.id)
  const base = { backgroundColor: '#000000', autoHideMenuBar: true, title: 'commonplace: presenting', icon: ICON }
  if (other) return { ...base, x: other.bounds.x, y: other.bounds.y, width: other.bounds.width, height: other.bounds.height, fullscreen: true }
  return { ...base, width: 1024, height: 576 }
}

function openExternal (url) {
  if (/^(https?:|mailto:)/i.test(String(url))) shell.openExternal(url)
}

// A small JPEG for an uploaded image, so the Drive can show it before anyone downloads it.
async function makeThumb (file) {
  const img = nativeImage.createFromPath(file)
  if (img.isEmpty()) return null
  const { width, height } = img.getSize()
  const k = Math.min(1, 320 / Math.max(width, height))
  const url = `data:image/jpeg;base64,${img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'good' }).toJPEG(72).toString('base64')}`
  return url.length < 60000 ? url : null
}

function safeName (title, ext) {
  const base = String(title || 'Untitled').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled'
  return `${base}.${ext}`
}

async function saveAs (title, ext, data, filterName) {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('documents'), safeName(title, ext)),
    filters: [{ name: filterName, extensions: [ext] }]
  })
  if (canceled || !filePath) return null
  await fs.writeFile(filePath, data)
  return path.basename(filePath)
}

function registerIpc () {
  ipcMain.handle('me', () => drive.me())
  ipcMain.handle('drive:apps', () => drive.apps())
  ipcMain.handle('drive:folders', () => drive.listFolders())
  ipcMain.handle('folder:create', (_e, name, parentId) => drive.createFolder(name, parentId))
  ipcMain.handle('folder:createShared', (_e, name, parentId) => drive.createSharedFolder(name, parentId))
  ipcMain.handle('folder:share', (_e, id) => drive.shareFolder(id))
  ipcMain.handle('folder:rename', (_e, id, name) => drive.renameFolder(id, name))
  ipcMain.handle('folder:delete', (_e, id) => drive.deleteFolder(id))
  ipcMain.handle('folder:restoreRemoved', (_e, id) => drive.restoreRemoved(id))
  ipcMain.handle('folder:move', (_e, id, parentId) => drive.moveFolder(id, parentId))
  ipcMain.handle('file:move', (_e, docId, folderId) => drive.moveFile(docId, folderId))
  ipcMain.handle('link:open', (_e, url) => openExternal(url))
  ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text)))

  // Import a .md or .docx file as a new document. The window fills in the
  // content right after opening it (the editor owns the content schema).
  ipcMain.handle('file:import', async (_e, folderId) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Documents, spreadsheets, presentations and calendars', extensions: ['docx', 'md', 'markdown', 'txt', 'xlsx', 'csv', 'tsv', 'pptx', 'ics'] }]
    })
    if (canceled || !filePaths[0]) return null
    const file = filePaths[0]
    const ext = path.extname(file).toLowerCase()
    const title = path.basename(file, path.extname(file))
    if ((await fs.stat(file)).size > MAX_PPTX_BYTES) throw new Error('That file is over 200 MB, too large to import.')
    const bytes = await fs.readFile(file)
    if (ext === '.xlsx' || ext === '.csv' || ext === '.tsv') {
      // Spreadsheets are filled in here; the window just opens them.
      const docId = await drive.create('sheet', title, { folderId })
      const ydoc = drive.getDoc(docId).ydoc
      const { warnings } = ext === '.xlsx' ? await importXlsx(ydoc, bytes) : importCsv(ydoc, bytes.toString('utf8'), { name: title.slice(0, 80) })
      return { docId, content: null, warnings }
    }
    if (ext === '.pptx') {
      const docId = await drive.create('slides', title, { folderId })
      try {
        const { slides, warnings } = await importPptx(drive.getDoc(docId).ydoc, bytes)
        const lost = warnings ? `${warnings} item${warnings === 1 ? '' : 's'} (charts, video, tables or pictures in other formats) came over as text or were left out.` : ''
        return { docId, content: null, warnings, note: `${slides} slide${slides === 1 ? '' : 's'}`, warningText: lost }
      } catch (err) {
        await drive.remove(docId)
        throw err
      }
    }
    if (ext === '.ics') {
      const docId = await drive.create('calendar', title, { folderId })
      const { added, simplified } = importIcs(drive.getDoc(docId).ydoc, bytes.toString('utf8'))
      return { docId, content: null, warnings: simplified, note: `${added} event${added === 1 ? '' : 's'}`, warningText: simplified ? `${simplified} repeating event${simplified === 1 ? '' : 's'} became one-off events.` : '' }
    }
    if (ext === '.docx') {
      const { html, page, warnings } = await importDocx(bytes)
      const docId = await drive.create('paged', title, { folderId })
      drive.getDoc(docId).ydoc.transact(() => drive.getDoc(docId).ydoc.getMap('page').set('setup', page), 'local')
      return { docId, content: { type: 'html', value: html }, warnings }
    }
    const docId = await drive.create('markdown', title, { folderId })
    return { docId, content: { type: 'markdown', value: bytes.toString('utf8') }, warnings: 0 }
  })

  ipcMain.handle('file:export', async (_e, docId, format, payload) => {
    const file = drive.describe(docId)
    const doc = drive.getDoc(docId)
    if (!file || !doc) throw new Error('This file is no longer in your Drive.')
    if (format === 'md' && file.kind !== 'tasks') return saveAs(file.title, 'md', String(payload.markdown || ''), 'Markdown')
    if (format === 'docx') {
      const setup = file.kind === 'paged' ? readPage(doc.ydoc) : { ...DEFAULT_PAGE, footer: '' }
      return saveAs(file.title, 'docx', await exportDocx(payload.json, setup, { title: file.title }), 'Word document')
    }
    if (format === 'xlsx') return saveAs(file.title, 'xlsx', await exportXlsx(doc.ydoc), 'Excel workbook')
    if (format === 'csv' && file.kind === 'form') return saveAs(`${file.title} answers`, 'csv', '\uFEFF' + forms.csv(docId), 'CSV')
    if (format === 'csv' && file.kind === 'tasks') return saveAs(file.title, 'csv', '\uFEFF' + tasksCsv(doc.ydoc, payload.names || {}), 'CSV')
    if (format === 'md' && file.kind === 'tasks') return saveAs(file.title, 'md', tasksMarkdown(doc.ydoc, file.title, payload.names || {}), 'Markdown')
    if (format === 'csv') return saveAs(file.title, 'csv', '\uFEFF' + exportCsv(doc.ydoc, payload.sheetId), 'CSV')
    if (format === 'ics') return saveAs(file.title, 'ics', exportIcs(doc.ydoc, file.title), 'Calendar')
    if (format === 'svg') return saveAs(file.title, 'svg', String(payload.svg || ''), 'SVG image')
    if (format === 'png') return saveAs(file.title, 'png', Buffer.from(String(payload.png || ''), 'base64'), 'PNG image')
    if (format === 'pptx') return saveAs(file.title, 'pptx', await exportPptx(doc.ydoc, { title: file.title }), 'PowerPoint presentation')
    if (format === 'pdf' && file.kind === 'slides') {
      // The window has laid out one page per slide (13.33 x 7.5 in).
      const pdf = await win.webContents.printToPDF({ pageSize: { width: 13.333, height: 7.5 }, margins: { top: 0, right: 0, bottom: 0, left: 0 }, printBackground: true })
      return saveAs(file.title, 'pdf', pdf, 'PDF')
    }
    if (format === 'pdf') {
      const setup = readPage(doc.ydoc)
      const pdf = await win.webContents.printToPDF({
        pageSize: PAGE_SIZES[setup.size].pdf,
        landscape: setup.orientation === 'landscape',
        margins: setup.margins,
        printBackground: true,
        displayHeaderFooter: Boolean(setup.header || setup.footer),
        headerTemplate: pdfPageLine(setup.header, file.title),
        footerTemplate: pdfPageLine(setup.footer, file.title)
      })
      return saveAs(file.title, 'pdf', pdf, 'PDF')
    }
    throw new Error(`Can't export as ${format}.`)
  })

  ipcMain.handle('file:pickImage', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
    })
    if (canceled || !filePaths[0]) return null
    const type = IMAGE_TYPES[path.extname(filePaths[0]).toLowerCase()]
    const bytes = await fs.readFile(filePaths[0])
    if (!type) throw new Error('That file type isn\u2019t supported. Use PNG, JPEG, GIF or WebP.')
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('That image is over 8 MB. Images are stored inside the document, so use a smaller one.')
    return { src: `data:${type};base64,${bytes.toString('base64')}`, alt: path.basename(filePaths[0], path.extname(filePaths[0])) }
  })

  ipcMain.handle('profile:set', (_e, patch) => { drive.setProfile(patch); return drive.me() })
  ipcMain.handle('drive:list', () => drive.list())
  ipcMain.handle('drive:create', (_e, type, title, folderId) => drive.create(type, title, { folderId }))
  ipcMain.handle('drive:join', (_e, invite, folderId) => drive.join(invite, { folderId }))
  ipcMain.handle('drive:remove', (_e, docId) => { openDocs.delete(docId); return drive.remove(docId) })
  ipcMain.handle('drive:copyInvite', (_e, docId, role, options) => {
    const invite = drive.invite(docId, role, options || {})
    if (invite) clipboard.writeText(invite)
    return invite
  })
  ipcMain.handle('request:approve', (_e, docId, userId, role) => drive.approveRequest(docId, userId, role))
  ipcMain.handle('request:decline', (_e, docId, userId) => drive.declineRequest(docId, userId))

  // Opening a document hands the window a full copy plus current presence.
  // From then on, updates flow both ways as small binary messages.
  ipcMain.handle('doc:open', (_e, docId, clientId) => {
    const doc = drive.getDoc(docId)
    if (!doc) throw new Error('This file is no longer in your Drive.')
    openDocs.add(docId)
    drive.setOpen(docId, true)
    drive.engine.registerLocalClient(docId, clientId)
    drive.touchPerson(docId)
    drive.markOpened(docId)
    try { forms.setup(docId) } catch {} // a form's owner makes its response key the first time
    const states = [...doc.awareness.getStates().keys()]
    return {
      state: Y.encodeStateAsUpdate(doc.ydoc),
      awareness: awarenessProtocol.encodeAwarenessUpdate(doc.awareness, states),
      file: drive.describe(docId)
    }
  })
  ipcMain.handle('doc:close', (_e, docId) => { openDocs.delete(docId); drive.setOpen(docId, false) })

  // Sharing and access (owner actions are checked again in the engine).
  ipcMain.handle('member:role', (_e, docId, userId, role) => drive.setMemberRole(docId, userId, role))
  ipcMain.handle('member:remove', (_e, docId, userId) => drive.removeMember(docId, userId))
  ipcMain.handle('member:transfer', (_e, docId, userId) => drive.transferOwnership(docId, userId))
  ipcMain.handle('invites:reset', (_e, docId) => drive.resetInvites(docId))
  ipcMain.handle('file:syncMode', (_e, docId, mode) => drive.setSyncMode(docId, mode))
  ipcMain.handle('history:list', (_e, docId) => drive.versions(docId))
  ipcMain.handle('history:get', (_e, docId, id) => drive.version(docId, id))
  ipcMain.handle('history:restore', (_e, docId, id) => drive.restoreVersion(docId, id))
  ipcMain.handle('history:name', (_e, docId, id, label) => drive.nameVersion(docId, id, label))
  ipcMain.handle('conflicts:list', (_e, docId) => drive.conflicts(docId))
  ipcMain.handle('conflicts:resolve', (_e, docId, id, choice) => drive.resolveConflict(docId, id, choice))

  // Linking another computer (both keep the Drive) or moving to it (this
  // one signs out once the other has everything).
  ipcMain.handle('move:start', (_e, { keep = false } = {}) => {
    if (move) move.abort()
    const code = newMoveCode()
    const controller = new AbortController()
    move = controller
    sendDrive({ code, drive, swarm: swarmOptions(), signal: controller.signal, leaving: !keep, onStatus: (s) => send('move:status', s) })
      .then(async ({ count }) => {
        move = null
        if (keep) { send('move:status', { phase: 'linked', count }); return }
        await signOutAndWipe()
        send('move:status', { phase: 'signed-out', count })
      })
      .catch((err) => { if (move === controller) move = null; send('move:status', { phase: 'error', message: err.message }) })
    return code
  })
  ipcMain.handle('move:cancel', () => { move?.abort(); move = null })
  ipcMain.handle('updates:state', () => updates?.state || null)
  ipcMain.handle('updates:install', () => updates?.install(() => app.quit()))
  ipcMain.handle('updates:open', () => { if (updates) shell.openExternal(updates.state.url) })
  ipcMain.handle('devices:list', () => drive.devices())
  ipcMain.handle('relays:mine', () => drive.myRelays())
  ipcMain.handle('relays:addMine', (_e, address, options) => drive.addMyRelay(address, options || {}))
  ipcMain.handle('relays:removeMine', (_e, key) => drive.removeMyRelay(key))
  ipcMain.handle('relays:add', (_e, docId, address) => drive.addRelay(docId, address))
  ipcMain.handle('relays:remove', (_e, docId, key) => drive.removeRelay(docId, key))
  ipcMain.handle('devices:unlink', (_e, id) => drive.unlinkDevice(id))
  ipcMain.handle('move:receive', async (_e, code) => {
    if (!drive.isEmpty) throw new Error('This computer already has files. A Drive can only be moved to a computer with an empty Drive.')
    const result = await receiveDrive({
      code,
      dataDir: app.getPath('userData'),
      isEmpty: () => drive.isEmpty,
      swarm: swarmOptions(),
      onStatus: (s) => send('move:status', s),
      beforeInstall: () => drive.stop()
    })
    await startDrive()
    win?.webContents.reload()
    return result
  })
  // Uploaded files. Size limits, approval and free-space checks are in
  // drive/files.js; here are the dialogs and opening them.
  const uploadAll = async (paths, folderId) => {
    const done = []
    const failed = []
    for (const p of paths.slice(0, 50)) {
      try { done.push(await drive.upload(p, { folderId })) } catch (err) { failed.push(`${path.basename(p)}: ${err.message}`) }
    }
    return { done, failed }
  }
  ipcMain.handle('files:upload', async (_e, folderId) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { title: 'Upload files', properties: ['openFile', 'multiSelections'] })
    return canceled ? null : uploadAll(filePaths, folderId)
  })
  ipcMain.handle('files:uploadPaths', (_e, paths, folderId) => uploadAll((paths || []).filter((p) => typeof p === 'string' && path.isAbsolute(p)), folderId))
  ipcMain.handle('files:uploadVersion', async (_e, docId) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { title: 'Upload a new version', properties: ['openFile'] })
    if (canceled || !filePaths[0]) return false
    await drive.uploadVersion(docId, filePaths[0])
    return true
  })
  ipcMain.handle('files:approve', (_e, docId) => drive.approveDownload(docId))
  ipcMain.handle('files:removeCopy', (_e, docId) => drive.removeDownloadedCopy(docId))
  ipcMain.handle('files:save', async (_e, docId) => {
    const st = drive.describe(docId)?.upload
    if (!st?.ready) throw new Error('This file isn’t on this computer yet.')
    const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), safeFileName(st.name)) })
    if (canceled || !filePath) return null
    await drive.uploads.saveTo(docId, filePath)
    return path.basename(filePath)
  })
  // Opens a copy with the program your computer uses for that kind of file.
  // Never for kinds that can run code: those can only be saved.
  ipcMain.handle('files:open', async (_e, docId) => {
    const st = drive.describe(docId)?.upload
    if (!st?.ready) throw new Error('This file isn’t on this computer yet.')
    if (fileKind(st.name).risky) throw new Error('This kind of file can run programs, so commonplace won’t open it. Save a copy instead, and open it only if you trust it.')
    const dir = path.join(app.getPath('temp'), 'commonplace-open', docId)
    await fs.mkdir(dir, { recursive: true })
    const target = await drive.uploads.saveTo(docId, path.join(dir, safeFileName(st.name)))
    const problem = await shell.openPath(target)
    if (problem) throw new Error(problem)
  })
  // A preview inside the window, for small images, text, audio and video.
  ipcMain.handle('files:preview', (_e, docId) => {
    const st = drive.describe(docId)?.upload
    if (!st?.ready) return null
    const { kind, ext } = fileKind(st.name)
    const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', opus: 'audio/ogg', aac: 'audio/aac' }
    if (kind === 'text') { const bytes = drive.uploads.read(docId, 512 * 1024); return bytes ? { kind, text: bytes.toString('utf8') } : null }
    if (!types[ext]) return null // SVG and the rest: no preview (SVG can carry scripts)
    const bytes = drive.uploads.read(docId, 25 * 1024 * 1024)
    return bytes ? { kind, src: `data:${types[ext]};base64,${bytes.toString('base64')}` } : null
  })
  ipcMain.handle('storage:usage', () => drive.storageUsage())
  ipcMain.handle('storage:settings', (_e, patch) => drive.setStorageSettings(patch || {}))
  ipcMain.handle('drive:keepSyncing', (_e, docId) => drive.keepSyncing(docId))
  ipcMain.handle('drive:keepSyncingFolder', (_e, folderId) => drive.keepSyncingFolder(folderId))
  ipcMain.handle('policy:get', () => ({ ...drive.policySettings(), fields: POLICY_FIELDS, groups: POLICY_GROUPS }))
  ipcMain.handle('policy:set', (_e, patch) => drive.setPolicy(patch))
  ipcMain.handle('policy:reset', () => drive.resetPolicy())
  ipcMain.handle('people:block', (_e, userId, name) => drive.block(userId, name))
  ipcMain.handle('people:unblock', (_e, userId) => drive.unblock(userId))
  ipcMain.handle('settings:get', () => ({ spellcheck: readSettings().spellcheck !== false }))
  ipcMain.handle('settings:set', (_e, patch) => {
    const next = writeSettings({ spellcheck: patch?.spellcheck !== false })
    win?.webContents.session.setSpellCheckerEnabled(next.spellcheck)
    return { spellcheck: next.spellcheck }
  })
  ipcMain.handle('templates:list', () => drive.templates.list())
  ipcMain.handle('templates:create', (_e, id, folderId) => drive.templates.create(id, { folderId }))
  ipcMain.handle('templates:save', (_e, docId, name, description) => drive.templates.save(docId, { name, description }))
  ipcMain.handle('templates:remove', (_e, id) => drive.templates.remove(id))
  ipcMain.handle('file:copy', (_e, docId) => drive.copy(docId))
  ipcMain.handle('activity:list', () => drive.activity.list())
  ipcMain.handle('activity:read', (_e, ids) => drive.activity.markRead(Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : null))

  // commonForms: the keys live here, so answers are sealed and opened here.
  ipcMain.handle('forms:submit', (_e, docId, answers) => forms.submit(docId, answers))
  ipcMain.handle('forms:responses', (_e, docId) => forms.responses(docId))
  ipcMain.handle('links:boards', () => links.boards())
  ipcMain.handle('links:calendars', () => links.calendars())
  ipcMain.handle('links:addCards', (_e, boardId, listId, items, from) => links.addCards(boardId, listId, items, from))
  ipcMain.handle('links:addEvent', (_e, calendarId, event) => links.addEvent(calendarId, event))
  ipcMain.handle('links:dueTasks', () => links.dueTasks())

  // Recovery: one backup file, kept up to date, opened by a recovery key.
  ipcMain.handle('backup:status', () => backups.status())
  ipcMain.handle('backup:create', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save your backup',
      defaultPath: path.join(app.getPath('documents'), 'commonplace backup.cpbackup'),
      filters: [{ name: 'commonplace backup', extensions: ['cpbackup'] }]
    })
    if (canceled || !filePath) return null
    return backups.create(filePath)
  })
  ipcMain.handle('backup:refresh', () => backups.refresh())
  ipcMain.handle('backup:stop', () => backups.stop())
  ipcMain.handle('backup:pick', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose your backup',
      properties: ['openFile'],
      filters: [{ name: 'commonplace backup', extensions: ['cpbackup'] }, { name: 'All files', extensions: ['*'] }]
    })
    return canceled || !filePaths[0] ? null : filePaths[0]
  })
  ipcMain.handle('backup:restore', async (_e, file, recoveryKey) => {
    if (!drive.isEmpty) throw new Error('This computer already has files. A backup can only be restored on a computer with an empty Drive.')
    const { payload, lock } = readBackupFile(file, recoveryKey)
    const result = await restoreBackup({ payload, dataDir: app.getPath('userData'), beforeInstall: () => { openDocs.clear(); return drive.stop() } })
    await startDrive()
    backups.adopt(file, lock)
    win?.webContents.reload()
    return result
  })
  ipcMain.on('doc:update', (_e, docId, update) => drive.engine.applyLocalUpdate(docId, update, 'renderer'))
  ipcMain.on('doc:awareness', (_e, docId, update) => drive.engine.applyLocalAwareness(docId, update, 'renderer'))
}

let move = null
let backups = null
let forms = null
let links = null
let reminders = null

// COMMONPLACE_BOOTSTRAP=host:port[,host:port] joins a private DHT instead of
// the public one (for testing, or a group running its own bootstrap node).
function swarmOptions () {
  const list = (process.env.COMMONPLACE_BOOTSTRAP || '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!list.length) return {}
  const bootstrap = list.map((hp) => { const [host, port] = hp.split(':'); return { host, port: Number(port) } })
  // COMMONPLACE_DHT_HOST binds this computer's DHT node to one address (e.g. 127.0.0.1).
  if (process.env.COMMONPLACE_DHT_HOST) return { dht: new DHT({ bootstrap, host: process.env.COMMONPLACE_DHT_HOST }) }
  return { bootstrap }
}

async function startDrive () {
  // COMMONPLACE_CHECKPOINT_SECONDS shortens the pause before a version is saved (for testing).
  const pause = Number(process.env.COMMONPLACE_CHECKPOINT_SECONDS) * 1000
  drive = new Drive({ dataDir: app.getPath('userData'), apps: APPS, swarm: swarmOptions(), history: pause ? { idleMs: pause } : {}, makeThumb })
  drive.on('error', (err) => console.error('[commonplace]', err))
  // Another of my computers unlinked this one: sign out and delete it all here.
  drive.on('unlinked', () => {
    pendingNotice = 'This computer was unlinked from your Drive on another computer, so its copy was deleted.'
    signOutAndWipe().catch((err) => console.error('[commonplace]', err))
  })
  drive.on('changed', () => send('drive:changed', drive.list(), drive.me(), drive.listFolders(), drive.activity.unread()))
  // Mentions, replies and comments on my files: a notification, unless I'm
  // looking at that very file.
  drive.activity.on('new', (items) => {
    for (const item of items) {
      if (item.kind === 'shared' || !Notification.isSupported()) continue
      if (win?.isFocused() && openDocs.has(item.docId)) continue
      const title = drive.files.get(item.docId)?.title || 'Untitled'
      const head = { mention: `${item.byName} mentioned you in “${title}”`, reply: `${item.byName} replied in “${title}”`, comment: `${item.byName} commented on “${title}”` }[item.kind]
      const n = new Notification({ title: head, body: item.text, icon: ICON })
      n.on('click', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus() } drive.activity.markRead([item.id]); send('activity:open', item.docId, item.threadId) })
      n.show()
    }
  })
  drive.engine.on('update', (docId, update, origin) => {
    if (origin !== 'renderer' && origin !== 'disk' && openDocs.has(docId)) send('doc:update', docId, update)
  })
  drive.engine.on('awareness', (docId, update, origin) => {
    if (origin !== 'renderer' && openDocs.has(docId)) send('doc:awareness', docId, update)
  })
  await drive.start()
  backups?.destroy()
  backups = new Backups({ drive, dataDir: app.getPath('userData') })
  forms = formServices(drive)
  links = linkServices(drive)
  forms.watch()
  reminders?.destroy()
  reminders = new Reminders({
    drive,
    dataDir: app.getPath('userData'),
    notify: ({ title, body }) => { if (Notification.isSupported()) new Notification({ title, body, icon: ICON }).show() }
  })
  backups.on('changed', (status) => send('backup:changed', status))
}

// After a move: this computer no longer holds the identity or any files.
async function signOutAndWipe () {
  const dir = app.getPath('userData')
  openDocs.clear()
  await drive.stop()
  await fs.rm(path.join(dir, 'files'), { recursive: true, force: true })
  await fs.rm(path.join(dir, 'identity.json'), { force: true })
  backups?.stop() // the backup belongs to the identity that left
  await startDrive() // a fresh, empty Drive with a new identity
  win?.webContents.reload()
}

// Anything that isn't the main window (the audience's window while
// presenting) never navigates or opens windows of its own.
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (e) => e.preventDefault())
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
})

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(ICON)
  updates = new Updates({
    root: app.isPackaged ? app.getAppPath() : path.resolve(here, '..', '..', '..'),
    version: app.getVersion(),
    packaged: app.isPackaged,
    logDir: app.getPath('logs'),
    onChange: (state) => send('updates:changed', state),
    enabled: () => drive?.policy.get('updateCheck') !== false
  })
  const last = updates.takeLastResult()
  if (last) pendingNotice = last.ok ? 'commonplace was updated to the newest version.' : `commonplace couldn’t update itself. Run the install command again, or see ${last.log}.`
  registerIpc()
  await startDrive()
  createWindow()
  updates.start()

  app.on('activate', () => { if (!win) createWindow() })
})

// Closing the window quits, on every platform. Files stop syncing until
// commonplace is opened again.
app.on('window-all-closed', () => app.quit())

let stopping = false
app.on('before-quit', (event) => {
  if (stopping || !drive) return
  event.preventDefault()
  stopping = true
  drive.stop().catch(() => {}).finally(() => app.quit())
})
