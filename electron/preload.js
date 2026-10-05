const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  // Returns [{id, name, thumbnail}] for screen/window sources
  getSources:     (types)     => ipcRenderer.invoke('get-sources', types),
  // Trigger a native file download via Electron's download manager
  downloadFile:   (url)       => ipcRenderer.invoke('download-file', url),
  // Reveal a local file path in Finder / Explorer
  showInFolder:   (filePath)  => ipcRenderer.invoke('show-in-folder', filePath),
  // Open a URL in the system browser (for OAuth flows)
  openExternal:   (url)       => ipcRenderer.invoke('open-external', url),
  // Whether the outbound-request jail is active
  netStatus:      ()          => ipcRenderer.invoke('net-status'),
  // Today's events straight from the local macOS Calendar — no network
  localCalendar:  ()          => ipcRenderer.invoke('local-calendar'),
})
