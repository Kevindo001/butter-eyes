const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('butterApi', {
  getStore: () => ipcRenderer.invoke('store:get'),
  saveSettings: (patch) => ipcRenderer.invoke('store:settings', patch),
  saveCalibration: (cal) => ipcRenderer.invoke('store:calibration', cal),
  addVoiceExample: (text) => ipcRenderer.invoke('store:voiceExample', text),
  suggest: (conversation) => ipcRenderer.invoke('llm:suggest', conversation),
  transcribe: (wavArrayBuffer) => ipcRenderer.invoke('speech:transcribe', wavArrayBuffer),
  speak: (text) => ipcRenderer.invoke('speech:speak', text),
  clearTalk: () => ipcRenderer.invoke('store:clearTalk'),
  saveDebug: (name, data) => ipcRenderer.invoke('debug:save', name, data),
  drive: (dir) => ipcRenderer.invoke('butter:drive', dir),
  pulse: (dir, ms) => ipcRenderer.invoke('butter:pulse', dir, ms),
  butterStatus: () => ipcRenderer.invoke('butter:status'),
  onButterStatus: (fn) => ipcRenderer.on('butter:status', (_e, s) => fn(s)),
  e2e: !!process.env.BUTTER_E2E,
  calSpeed: Number(process.env.BUTTER_CAL_SPEED) || 1,
});
