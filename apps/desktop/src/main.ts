import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, session, shell, type IpcMainInvokeEvent } from 'electron';
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseRequest, type Result } from '../../../packages/contracts/src/index.js';
import { terminateGroup, nodeExecutable } from '../../../packages/runtime/src/processes.js';

const APP_NAME = 'RLY ADE';
const INDEX = path.join(__dirname, 'index.html');
app.setName(APP_NAME);
app.setPath('userData', process.env.ADE_USER_DATA || path.join(app.getPath('appData'), APP_NAME));
let window: BrowserWindow | null = null;
let child: ChildProcess | null = null;
let starting: Promise<void> | null = null;
let recovering: Promise<unknown> | null = null;
const agents = new Map<string, { pid: number; stamp: string }>();
let quitting = false;
const pending = new Map<string, { resolve: (value: Result<unknown>) => void; timer: ReturnType<typeof setTimeout> }>();

function failPending(): void {
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.resolve({ ok: false, error: 'Связь с ядром потеряна. Обновите данные перед повтором операции.' });
  }
  pending.clear();
}

async function startRuntime(): Promise<void> {
  if (recovering) await recovering;
  if (starting) return starting;
  const worker = fork(path.join(__dirname, 'runtime.cjs'), [path.join(app.getPath('userData'), 'ade.sqlite')], {
    execPath: nodeExecutable(), execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  worker.stdout?.resume(); worker.stderr?.resume();
  child = worker;
  starting = new Promise<void>((resolve, reject) => {
    let ready = false;
    const timer = setTimeout(() => { reject(new Error('Локальное ядро не запустилось.')); worker.kill(); }, 10000);
    worker.on('message', (message: { ready?: boolean; id?: string; changed?: string; agentProcess?: { runId: string; pid: number; stamp: string }; agentGone?: string } & Result<unknown>) => {
      if (message.ready) { ready = true; clearTimeout(timer); resolve(); return; }
      if (message.agentProcess) { agents.set(message.agentProcess.runId, message.agentProcess); return; }
      if (message.agentGone) { agents.delete(message.agentGone); return; }
      if (message.changed) { if (window && !window.isDestroyed()) window.webContents.send('ade:changed', message.changed); return; }
      const item = message.id ? pending.get(message.id) : undefined;
      if (item && message.id) { clearTimeout(item.timer); pending.delete(message.id); item.resolve(message); }
    });
    worker.once('exit', () => {
      clearTimeout(timer);
      if (child === worker) {
        child = null; starting = null; failPending();
        const remaining = [...agents.entries()];
        if (remaining.length) {
          recovering = Promise.all(remaining.map(async ([runId, info]) => { await terminateGroup(info.pid, info.stamp, true); agents.delete(runId); }));
          void recovering.then(() => { recovering = null; }, () => {});
        }
      }
      if (!ready) reject(new Error('Не удалось открыть локальную базу ADE. Проверьте доступ и версию приложения.'));
    });
    worker.once('error', () => {
      clearTimeout(timer); if (child === worker) { child = null; starting = null; failPending(); }
      reject(new Error('Не удалось запустить отдельный Node runtime. Проверьте установленный Node.js.'));
    });
  });
  return starting;
}

async function runtimeCall(operation: string, input: unknown): Promise<Result<unknown>> {
  try { await startRuntime(); } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Ядро недоступно.' }; }
  return new Promise(resolve => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: 'Ядро не подтвердило операцию. Обновите данные перед повтором.' });
    }, operation === 'call' && (input as { method?: string })?.method === 'usage.device' ? 120000 : 30000);
    pending.set(id, { resolve, timer });
    try {
      if (!child) throw new Error('Runtime exited.');
      child.send({ id, operation, input }, error => { if (error) failPending(); });
    } catch {
      clearTimeout(timer); pending.delete(id);
      resolve({ ok: false, error: 'Связь с ядром потеряна. Обновите данные перед повтором операции.' });
    }
  });
}

function authorize(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(INDEX).href) throw new Error('Недопустимый источник запроса.');
}

ipcMain.handle('ade:call', async (event, input: unknown) => {
  try { authorize(event); return await runtimeCall('call', parseRequest(input)); }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Некорректный запрос.' }; }
});
ipcMain.handle('ade:pick-project', async event => {
  try {
    authorize(event);
    const result = await dialog.showOpenDialog(window!, { title: 'Выберите папку проекта', properties: ['openDirectory'], buttonLabel: 'Подключить проект' });
    if (result.canceled || !result.filePaths[0]) return { ok: true, value: null };
    return await runtimeCall('project.add', result.filePaths[0]);
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Не удалось подключить проект.' }; }
});

ipcMain.handle('ade:copy-text', (event, value: unknown) => {
  try {
    authorize(event);
    if (typeof value !== 'string' || Buffer.byteLength(value) > 1024 * 1024) throw new Error('Текст превышает предел копирования 1 МиБ.');
    clipboard.writeText(value); return { ok: true, value: undefined };
  } catch (error) { return { ok: false, error: (error as Error).message }; }
});
ipcMain.handle('ade:profile-login', async (event, profileId: unknown) => {
  try {
    authorize(event);
    if (typeof profileId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(profileId)) throw new Error('Некорректный профиль.');
    const result = await runtimeCall('profile.login', profileId);
    if (!result.ok) return result;
    const launch = result.value as { url?: string };
    if (launch.url) {
      const url = new URL(launch.url);
      if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/api/accounts/authorize' || url.username || url.password) throw new Error('Неподдержанный адрес входа.');
      try { await shell.openExternal(url.href); }
      catch { await runtimeCall('call', { method: 'profile.cancel', params: { profileId } }); throw new Error('Не удалось открыть системный браузер. Повторите вход.'); }
    }
    return { ok: true, value: undefined };
  } catch { return { ok: false, error: 'Не удалось открыть вход профиля. Проверьте подключение и повторите.' }; }
});
ipcMain.handle('ade:open-external', async (event, value: unknown) => {
  try {
    authorize(event);
    if (typeof value !== 'string' || value.length > 4096) throw new Error('Некорректная ссылка.');
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Разрешены только обычные веб-ссылки.');
    await shell.openExternal(url.href); return { ok: true, value: undefined };
  } catch (error) { return { ok: false, error: (error as Error).message }; }
});

function createWindow(): void {
  const local = session.fromPartition('persist:rly-ade-local-v1');
  local.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  local.setPermissionCheckHandler(() => false);
  local.on('will-download', event => event.preventDefault());
  local.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      const url = new URL(details.url);
      if (url.protocol === 'file:') {
        const relative = path.relative(__dirname, fileURLToPath(url));
        allowed = relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
      }
    } catch {}
    callback({ cancel: !allowed });
  });
  window = new BrowserWindow({
    width: 1280, height: 860, minWidth: 700, minHeight: 560, title: APP_NAME, show: false,
    titleBarStyle: 'hiddenInset', backgroundColor: '#222222',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, partition: 'persist:rly-ade-local-v1' },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-redirect', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => { window = null; });
  void window.loadFile(INDEX);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  void app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: APP_NAME, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' },
      { label: 'Вид', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
      { role: 'windowMenu' },
    ]));
    if (process.platform === 'darwin') app.dock?.setIcon(nativeImage.createFromPath(path.join(__dirname, 'assets', 'rly-logo.png')));
    createWindow();
    app.on('activate', () => { if (!window) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (quitting || !child) return;
    event.preventDefault();
    quitting = true;
    const worker = child;
    const deadline = setTimeout(() => { worker.kill(); app.quit(); }, 3000);
    void runtimeCall('shutdown', null).finally(() => { clearTimeout(deadline); worker.kill(); app.quit(); });
  });
}
