// SPDX-License-Identifier: GPL-3.0-only
const { contextBridge, ipcRenderer } = require('electron');
const subscribe = (channel, callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld(
  'capriMenuBar',
  Object.freeze({
    state: () => ipcRenderer.invoke('capri:menu-bar-panel', { action: 'state' }),
    act: (action, value) => ipcRenderer.invoke('capri:menu-bar-panel', { action, value }),
    onState: (callback) => subscribe('capri:menu-bar-panel-state', callback),
    onShown: (callback) => subscribe('capri:menu-bar-panel-shown', () => callback()),
  }),
);
