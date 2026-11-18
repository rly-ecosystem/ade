import { Runtime } from './service.js';

interface Port {
  on(type: 'message', listener: (event: { data: { id: string; operation: string; input: unknown } }) => void): void;
  postMessage(message: unknown): void;
}

process.umask(0o077);
const port: Port | undefined = process.send ? {
  on(_type, listener) { process.on('message', data => listener({ data: data as Parameters<typeof listener>[0]['data'] })); },
  postMessage(message) { if (process.connected) process.send!(message as object, () => {}); },
} : (process as unknown as { parentPort: Port }).parentPort;
const filename = process.argv[2];
if (!port || !filename) throw new Error('Runtime requires a parent port and database path.');
const runtime = new Runtime(filename, {
  changed: taskId => port.postMessage({ changed: taskId }),
  process: (runId, pid, stamp) => port.postMessage({ agentProcess: { runId, pid, stamp } }),
  processGone: runId => port.postMessage({ agentGone: runId }),
});
let queue = Promise.resolve();

port.on('message', ({ data }) => {
  const handle = async () => {
    try {
      if (data.operation === 'shutdown') {
        await runtime.shutdown();
        port.postMessage({ id: data.id, ok: true, value: null });
        process.exit(0);
      }
      const value = data.operation === 'profile.login' && typeof data.input === 'string' ? await runtime.profiles.startLogin(data.input) : data.operation === 'project.add'
        ? await runtime.addProject(data.input as string)
        : await runtime.call(data.input);
      port.postMessage({ id: data.id, ok: true, value });
    } catch (error) {
      port.postMessage({ id: data.id, ok: false, error: error instanceof Error ? error.message : 'Ошибка локального ядра.' });
    }
  };
  const method = (data.input as { method?: string } | null)?.method;
  if (data.operation === 'call' && (method === 'usage.device' || method === 'usage.quota' || method === 'usage.sources')) void handle();
  else queue = queue.then(handle);
});
void runtime.initialize().then(() => port.postMessage({ ready: true })).catch(() => process.exit(1));
process.on('disconnect', () => { void runtime.shutdown().finally(() => process.exit(0)); });
