import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ACTIVE_RUNS } from '../packages/contracts/src/index.js';
import { Runtime } from '../packages/runtime/src/service.js';

async function verify() {
  process.umask(0o077);
  const directory = mkdtempSync(path.join(tmpdir(), 'ade-siwc-live-'));
  const runtime = new Runtime(path.join(directory, 'ade.sqlite'));
  const profile = runtime.profiles.create('codex', 'SIWC release check', randomUUID()).profiles.at(-1)!;
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const current = () => runtime.profiles.list().profiles.find(p => p.id === profile.id)!;
  try {
    const login = await runtime.profiles.startLogin(profile.id);
    if (!login.url || new URL(login.url).origin !== 'https://auth.openai.com') throw new Error('Official authorization URL unavailable.');
    execFileSync('/usr/bin/open', [login.url], { stdio: 'ignore' });
    console.log('OPENED: approve RLY ADE in the system browser. Awaiting the OpenAI callback.');
    while (current().pending && !interrupted) await delay(300);
    if (interrupted) throw new Error('Live check stopped.');
    if (current().state !== 'connected') throw new Error(current().reason);
    console.log('PASS: verified identity and granted ChatGPT plan scope.');
    await runtime.profiles.select(profile.id);
    const workspace = path.join(directory, 'empty-project');
    mkdirSync(workspace);
    const project = await runtime.addProject(workspace);
    runtime.store.trust(project.id, true);
    const task = runtime.store.createTask(project.id, 'Reply with OK only. Do not use tools or modify files.', randomUUID()).task;
    await runtime.runner.execute(task.id, 'codex', '', randomUUID());
    const deadline = Date.now() + 90000;
    while (!interrupted && Date.now() < deadline) {
      const run = runtime.store.detail(task.id).runs.at(-1);
      if (run && !ACTIVE_RUNS.includes(run.status)) {
        if (run.status !== 'completed' || run.profileId !== profile.id) throw new Error('Live turn did not complete on the selected SIWC profile (' + run.status + ').');
        console.log('PASS: Codex completed one turn on the selected ChatGPT plan.');
        return;
      }
      await delay(400);
    }
    throw new Error('Live turn timed out or was interrupted.');
  } finally {
    try {
      await runtime.runner.shutdown();
      if (current().pending) await runtime.profiles.cancel(profile.id);
      if (current().state === 'connected' || current().state === 'plan_disabled') {
        const state = await runtime.profiles.logout(profile.id);
        console.log('Logout:', state.profiles.find(p => p.id === profile.id)?.reason);
      }
    } finally {
      await runtime.shutdown(); rmSync(directory, { recursive: true, force: true });
      process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    }
  }
}
void verify().catch(error => { console.error(error.message); process.exitCode = 1; });
