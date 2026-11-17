import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI } from '../../../packages/contracts/src/index.js';

const api: DesktopAPI = {
  call: (method, params) => ipcRenderer.invoke('ade:call', { method, params }),
  pickProject: () => ipcRenderer.invoke('ade:pick-project'),
  copyText: text => ipcRenderer.invoke('ade:copy-text', text),
  openExternal: url => ipcRenderer.invoke('ade:open-external', url),
  signInProfile: profileId => ipcRenderer.invoke('ade:profile-login', profileId),
  onChange: listener => {
    const receive = (_event: Electron.IpcRendererEvent, taskId: unknown) => { if (typeof taskId === 'string') listener(taskId); };
    ipcRenderer.on('ade:changed', receive);
    return () => { ipcRenderer.removeListener('ade:changed', receive); };
  },
};
contextBridge.exposeInMainWorld('ade', api);
