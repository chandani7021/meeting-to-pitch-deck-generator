const { app, BrowserWindow, ipcMain, desktopCapturer, shell, session } = require('electron')
const path = require('path')
const { spawn } = require('child_process')

const isDev = !app.isPackaged

let mainWindow
let serverProcess

function startServer() {
  const serverEntry = isDev
    ? path.join(__dirname, '../server/index.js')
    : path.join(process.resourcesPath, 'server', 'index.js')

  // Use Electron's own Node runtime with ELECTRON_RUN_AS_NODE=1
  // so the ESM server runs inside the packaged app without a separate Node install
  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: path.dirname(serverEntry),   // ensures dotenv finds server/.env
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: '3001', OFFLINE_MODE: OFFLINE ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  serverProcess.stdout.on('data', d => console.log('[server]', d.toString().trim()))
  serverProcess.stderr.on('data', d => {
    const msg = d.toString().trim()
    if (msg.includes('EADDRINUSE')) return  // port already held by an existing server
    console.error('[server]', msg)
  })
  serverProcess.on('exit', code => code && code !== 1 && console.error('[server] exited with code', code))
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#F8FAFC',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Always load the native renderer — no Vite, no React
  mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'))
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' })

  // Open external links in default browser, not inside the app
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

/**
 * Hard network jail.
 *
 * OFFLINE_MODE is the default. The renderer may reach only the local server and
 * the local inference host; every other request is cancelled at the session
 * layer, so a stray fetch, a webfont or an injected URL cannot exfiltrate a
 * transcript. This is layer 2 of 4 — see also the provider gate in routes/ai.js,
 * the boot assertion in server/index.js, and using the local Calendar instead
 * of Google's API.
 *
 * Note this guards the RENDERER. The server is a separate Node process, which
 * is why it carries its own checks.
 */
const OFFLINE = process.env.OFFLINE_MODE !== '0'

const ALLOWED_HOSTS = [
  '127.0.0.1:3001', 'localhost:3001',      // our own server
  '127.0.0.1:11434', 'localhost:11434',    // Ollama
]

function installNetworkJail() {
  if (!OFFLINE) {
    console.warn('[net] OFFLINE_MODE=0 — outbound requests are NOT restricted')
    return
  }
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url || ''
    // file:// and devtools are local by definition
    if (url.startsWith('file://') || url.startsWith('devtools://') || url.startsWith('blob:') || url.startsWith('data:')) {
      return callback({ cancel: false })
    }
    try {
      const { host } = new URL(url)
      if (ALLOWED_HOSTS.includes(host)) return callback({ cancel: false })
    } catch { /* unparseable — block it */ }
    console.warn('[net] blocked outbound request:', url.slice(0, 120))
    callback({ cancel: true })
  })
  console.log('[net] offline mode — renderer may only reach', ALLOWED_HOSTS.join(', '))
}

app.whenReady().then(() => {
  installNetworkJail()

  // Required for getDisplayMedia() to work in the renderer (Electron 17+)
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then(sources => {
      callback({ video: sources[0], audio: 'loopback' })
    }).catch(() => callback({}))
  }, { useSystemPicker: true })

  startServer()
  // In production give the server ~1.5s to bind before opening the window
  setTimeout(createWindow, isDev ? 0 : 1500)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (serverProcess) serverProcess.kill()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (serverProcess) serverProcess.kill()
})

// IPC: trigger a native download via Electron's download manager
ipcMain.handle('download-file', (_e, url) => {
  mainWindow.webContents.downloadURL(url)
})

// IPC: reveal a generated file in Finder / Explorer
ipcMain.handle('show-in-folder', (_e, filePath) => {
  shell.showItemInFolder(filePath)
})

// IPC: open a URL in the system browser (used for Google OAuth)
ipcMain.handle('open-external', (_e, url) => {
  shell.openExternal(url)
})

// IPC: let the UI state plainly whether the network jail is active
ipcMain.handle('net-status', () => ({ offline: OFFLINE, allowed: ALLOWED_HOSTS }))

// IPC: today's events from the LOCAL macOS Calendar — no Google API, no network
ipcMain.handle('local-calendar', async () => {
  const { execFile } = require('child_process')
  // AppleScript reads Calendar.app's own store; the user is prompted once by
  // macOS for Calendar access. Nothing leaves the machine.
  // `date as string` yields a locale string ("Sunday, September 21, 2026 at
  // 5:30:00 PM") that new Date() cannot parse, so emit the components as
  // YYYY-MM-DDTHH:MM:SS, which JS reads as local time.
  const script = `
    on pad(n)
      set s to n as string
      if length of s is 1 then return "0" & s
      return s
    end pad
    on iso(d)
      return (year of d as string) & "-" & pad(month of d as integer) & "-" & pad(day of d) & "T" & pad(hours of d) & ":" & pad(minutes of d) & ":" & pad(seconds of d)
    end iso

    set out to ""
    set today to current date
    set startOfDay to today - (time of today)
    set endOfDay to startOfDay + 86399
    tell application "Calendar"
      repeat with c in calendars
        repeat with e in (every event of c whose start date is greater than startOfDay and start date is less than endOfDay)
          set eSummary to summary of e
          set eStart to my iso(start date of e)
          set eEnd to my iso(end date of e)
          set out to out & eSummary & "\t" & eStart & "\t" & eEnd & "\n"
        end repeat
      end repeat
    end tell
    return out`
  return new Promise(resolve => {
    execFile('osascript', ['-e', script], { timeout: 15000 }, (err, stdout) => {
      if (err) {
        // -1743 is "Not authorised to send Apple events" — the Automation
        // permission, which lives in a different pane from Calendars, so name
        // it precisely rather than sending the user to the wrong setting.
        const denied = /-1743|not authoriz|not authoris/i.test(err.message)
        return resolve({ ok: false, denied, error: err.message, events: [] })
      }
      const events = (stdout || '').trim().split('\n').filter(Boolean).map((line, i) => {
        const [title, start, end] = line.split('\t')
        return { id: `local-${i}`, title, start, end, clientName: '', attendees: [] }
      })
      resolve({ ok: true, events })
    })
  })
})

// IPC: return desktop sources so the renderer can pick a screen/window for audio capture
ipcMain.handle('get-sources', async (_e, types) => {
  const sources = await desktopCapturer.getSources({
    types: types ?? ['screen', 'window'],
    thumbnailSize: { width: 160, height: 90 },
  })
  // Serialise thumbnails as dataURLs (NativeImage is not transferable over IPC)
  return sources.map(s => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
  }))
})
