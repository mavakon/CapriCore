// SPDX-License-Identifier: GPL-3.0-only
// Sandboxed bridge between the setup window and the launcher. It exposes only
// these calls; the page never gets Node.js or Electron objects.
const { contextBridge, ipcRenderer } = require('electron');

const call =
  (channel) =>
  (...args) =>
    ipcRenderer.invoke(channel, ...args);
const subscribe = (channel) => (listener) => {
  const handler = (_event, value) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('capriSetup', {
  state: call('setup:state'),
  retry: call('setup:retry'),
  refresh: call('setup:refresh'),
  run: call('setup:run'),
  cancel: call('setup:cancel'),
  move: call('setup:move'),
  openLogs: call('setup:open-logs'),
  showData: call('setup:show-data'),
  finish: call('setup:finish'),
  quit: call('setup:quit'),
  onState: subscribe('setup:state'),
  onEvent: subscribe('setup:event'),
});
