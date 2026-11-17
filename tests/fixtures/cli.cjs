#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const provider = path.basename(process.argv[1]);
const args = process.argv.slice(2);
if (args.includes('--version')) { const delay = provider === 'claude' && fs.existsSync(path.join(path.dirname(process.argv[1]), 'slow-claude')) ? 1200 : 0; setTimeout(() => { console.log(provider + ' fixture'); process.exit(0); }, delay); return; }
if (args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
if (args[0] === 'auth') {
  const strict = fs.existsSync(path.join(path.dirname(process.argv[1]), 'profiles-strict'));
  const config = process.env.CLAUDE_CONFIG_DIR;
  const file = config && path.join(config, 'fixture-account.json');
  if (strict && file && args[1] === 'login') {
    const finishLogin = () => { fs.mkdirSync(config, {recursive:true}); fs.writeFileSync(file, JSON.stringify({email:'fixture@example.invalid'})); console.log('Login successful'); process.exit(0); };
    if (fs.existsSync(path.join(path.dirname(process.argv[1]), 'hold-login'))) { console.log('Paste code here:'); createInterface({input:process.stdin}).on('line',line=>{if(line.trim()==='FIXTURE_AUTH_CODE')finishLogin()}); }
    else finishLogin();
    return;
  }
  if (strict && file && args[1] === 'logout') { fs.rmSync(file,{force:true}); console.log('Logged out'); process.exit(0); }
  console.log(JSON.stringify({ loggedIn: !fs.existsSync(path.join(path.dirname(process.argv[1]), 'disable-claude')) && (!strict || !file || fs.existsSync(file)), authMethod: 'claude.ai', apiProvider: 'firstParty' })); process.exit(0);
}
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let prompt = '', text = '', role = 'developer', iteration = 0, threadOptions = {};
function report() {
  if(!prompt.includes('ADE HANDOFF PROTOCOL:')||prompt.includes('[NO_HANDOFF]'))return;
  const lines=text.split('\n'),review=lines.at(-1)?.startsWith('ADE_REVIEW_RESULT ')?lines.pop():null;
  const summary={summary:lines.join('\n'),files:['codex-result.txt','claude-result.txt'].filter(name=>fs.existsSync(path.join(process.cwd(),name))),next:role==='reviewer'?'Run the user check and accept the result.':'Continue with the next ADE role.',blockers:[]};
  text=lines.join('\n')+'\nADE_HANDOFF '+JSON.stringify(summary)+(review?'\n\n'+review:'');
}
function usage(){
 if(prompt.includes('[NO_USAGE]'))return;
 if(provider==='codex')send({method:'thread/tokenUsage/updated',params:{threadId:'fixture-thread',turnId:'fixture-turn',tokenUsage:{total:{inputTokens:1000,outputTokens:80,cachedInputTokens:600,cacheWriteInputTokens:100,reasoningOutputTokens:20,totalTokens:1080}}}});
}
function reply(){
 report();usage();
 if(provider==='codex'){send({method:'item/completed',params:{item:{type:'agentMessage',id:'answer',text}}});send({method:'turn/completed',params:{turn:{status:'completed'}}});}
 else{send({type:'assistant',message:{id:'answer',content:[{type:'text',text}]}});send({type:'result',subtype:'success',result:text,...(!prompt.includes('[NO_USAGE]')?{usage:{input_tokens:200,output_tokens:70,cache_read_input_tokens:500,cache_creation_input_tokens:100}}:{})});}
}
function start(value) {
  prompt = value;
  role = /^\[ADE_ROLE:(\w+)\]/.exec(prompt)?.[1] || 'developer';
  iteration = Number(/\[ADE_ITERATION:(\d+)\]/.exec(prompt)?.[1] || 0);
  text = provider === 'codex' ? 'CODEX_FIXTURE_RESULT' : prompt.includes('CODEX_FIXTURE_RESULT') ? 'CLAUDE_CONTINUED_CODEX_CONTEXT' : 'CLAUDE_FIXTURE_RESULT';
  if (prompt.includes('[PROFILE_ECHO]')) text = 'PROFILE ' + path.basename(path.dirname(process.env.CLAUDE_CONFIG_DIR || process.env.CODEX_HOME || '/shared/config'));
  if (prompt.includes('[PROFILE_LEAK]')) text = 'DO_NOT_SAVE ' + process.env.ACCESS_TOKEN;
  if (prompt.includes('[FIXTURE_EXIT]')) { process.exit(0); }
  if (prompt.includes('[FIXTURE_UNKNOWN]')) { process.stdout.write('not json\n'); return; }
  const quota = prompt.includes('[FIXTURE_LIMIT]') || prompt.includes(provider === 'codex' ? '[LIMIT_CODEX]' : '[LIMIT_CLAUDE]') || provider === 'claude' && prompt.includes('[ASSISTANT_LIMIT]');
  if (quota && (role === 'developer' || prompt.includes('[ROLE_LIMIT:' + role + ']'))) {
    const id = 'quota-progress';
    const progress = provider === 'codex' ? 'CODEX_FIXTURE_RESULT' : 'CLAUDE_FIXTURE_RESULT';
    if(role==='developer')fs.writeFileSync(path.join(process.cwd(), provider + '-partial.txt'), progress);
    if (prompt.includes('[HUGE_AFTER_LIMIT]')) fs.writeFileSync(path.join(process.cwd(), 'large-artifact.dat'), Buffer.alloc(11 * 1024 * 1024));
    if (provider === 'codex') {
      send({ method: 'item/agentMessage/delta', params: { itemId: id, delta: progress } });
      if (prompt.includes('[UNFINISHED_COMMAND]')) send({ method: 'item/started', params: { item: { id: 'command-unknown', type: 'commandExecution', command: 'unknown-effect' } } });
      send({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'Fixture quota reached', codexErrorInfo: 'usageLimitExceeded' } } } });
    } else {
      send({ type: 'assistant', message: { id, content: [{ type: 'text', text: progress }] } });
      if (prompt.includes('[UNFINISHED_COMMAND]')) send({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'command-unknown', name: 'Bash', input: { command: 'unknown-effect' } }] } });
      if (prompt.includes('[ASSISTANT_LIMIT]')) { send({ type: 'assistant', error: 'rate_limit', message: { content: [] } }); send({ type: 'result', subtype: 'error_during_execution', errors: ['quota reached'] }); }
      else send({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 2000000000 } });
    }
    return;
  }
  if (role !== 'developer' && !prompt.includes('[TRY_WRITE_READONLY]')) {
    if(['orchestrator','researcher'].includes(role)&&prompt.includes('[PARALLEL_HOLD]')){
      if(provider==='codex')send({method:'item/agentMessage/delta',params:{itemId:'answer',delta:'PARALLEL_'+role+'_ACTIVE'}});
      else send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'PARALLEL_'+role+'_ACTIVE'}}});
      return;
    }
    const policy = provider === 'codex' ? threadOptions.sandbox + '/' + threadOptions.approvalPolicy : args[args.indexOf('--tools') + 1];
    text = 'ROLE_' + role.toUpperCase() + ' ' + policy + (prompt.includes('CODEX_FIXTURE_RESULT') ? ' CONTEXT_OK' : '');
    if (role === 'reviewer' && !prompt.includes('[NO_REVIEW_FORMAT]')) text += '\nADE_REVIEW_RESULT ' + JSON.stringify({ verdict: prompt.includes('[REVIEW_BLOCKED]') ? 'blocked' : prompt.includes('[ALWAYS_REJECT]') || prompt.includes('[REPAIR_ONCE]') && iteration === 0 ? 'changes_required' : 'ready', summary: 'Fixture review outcome' });
    if(prompt.includes('[HUGE_ANSWER]'))text='x'.repeat(70000);
    if(['orchestrator','researcher'].includes(role)&&prompt.includes('ADE HANDOFF PROTOCOL:'))setTimeout(reply,prompt.includes('[PARALLEL_DELAY]')?1400:500);
    else reply();
    return;
  }
  if (role === 'developer' && iteration === 0 && prompt.includes('[REPAIR_ONCE]')) {
    text = 'INITIAL_IMPLEMENTATION_INCOMPLETE';
    reply();
    return;
  }
  if (provider === 'claude' && prompt.includes('[QUOTA_WARNING]')) send({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } });
  if (prompt.includes('[GENERIC_429]') || prompt.includes('[AUTH_FAILURE]')) {
    if (provider === 'codex') send({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'usageLimitExceeded mentioned as arbitrary text; HTTP 429', codexErrorInfo: 'rateLimitExceeded' } } } });
    else { send({ type: 'assistant', error: prompt.includes('[AUTH_FAILURE]') ? 'authentication_failed' : 'overloaded_error', message: { content: [] } }); send({ type: 'result', subtype: 'error_during_execution', errors: ['HTTP 429'] }); }
    return;
  }
  if (prompt.includes('[FIXTURE_WAIT]')) {
    const helper = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(process.cwd(), 'fixture-helper.pid'), String(helper.pid));
    if (provider === 'codex') send({ method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: 'SAVED_PARTIAL_OUTPUT' } });
    else send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'SAVED_PARTIAL_OUTPUT' } } });
    return;
  }
  if (provider === 'codex') send({ id: 'fixture-permission', method: 'item/commandExecution/requestApproval', params: { command: 'Write codex-result.txt in the selected repository', cwd: process.cwd() } });
  else send({ type: 'control_request', request_id: 'fixture-permission', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: path.join(process.cwd(), 'claude-result.txt'), content: text } } });
}
function finish(allowed) {
  if (prompt.includes('[FIXTURE_STREAM]') && allowed && provider === 'codex') {
    const chunks = ['# Потоковый ответ\n\n**Статус:** идёт генерация.\n\n' + Array.from({ length: 22 }, (_, index) => `Параграф ${index + 1}: поток сохраняет уже показанный текст.\n\n`).join(''), '- Первый пункт\n- Второй пункт\n\n```js\nconst answer = 42;', '\nconsole.log(answer);\n```\n\n', '| Проверка | Итог |\n| --- | --- |\n| Markdown | Готово |\n\n> Цитата\n\n', '[Документация](https://example.com/docs)\n\n[Опасная ссылка](javascript:alert(1))\n\n<img src=x onerror="window.injected=true">\n\n![Проверка изображения](https://example.com/pixel.png)\n\nФинал: **ответ готов**.'];
    let index = 0, full = '';
    const timer = setInterval(() => {
      const chunk = chunks[index++]; full += chunk;
      send({ method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: chunk } });
      if (index === chunks.length) { clearInterval(timer); send({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'answer', text: full } } }); send({ method: 'turn/completed', params: { turn: { status: 'completed', error: null } } }); }
    }, 650);
    return;
  }
  if (allowed) fs.writeFileSync(path.join(process.cwd(), provider + '-result.txt'), text + '\n');
  else text = 'DECLINED_WITHOUT_WRITE';
  if (role === 'reviewer') text += '\nADE_REVIEW_RESULT ' + JSON.stringify({ verdict: 'ready', summary: 'Write request was denied' });
  report();usage();
  if (provider === 'codex') {
    send({ method: 'item/completed', params: { item: { id: 'fixture-permission', type: 'commandExecution', command: 'fixture local write', status: 'completed', exitCode: 0 } } });
    send({ method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: text.slice(0, 5) } });
    send({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'answer', text } } });
    send({ method: 'turn/completed', params: { turn: { status: 'completed', error: null } } });
  } else {
    send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'fixture-permission', content: 'done' }] } });
    send({ type: 'assistant', message: { id: 'answer', content: [{ type: 'text', text }] } });
    send({ type: 'result', subtype: 'success', is_error: false, result: text, ...(!prompt.includes('[NO_USAGE]')?{usage:{input_tokens:200,output_tokens:70,cache_read_input_tokens:500,cache_creation_input_tokens:100}}:{}) });
  }
}
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (provider === 'codex') {
    if (message.method === 'initialize') send({ id: message.id, result: {} });
    else if (message.method === 'account/read') send({ id: message.id, result: { account: { type: 'chatgpt' } } });
    else if (message.method === 'config/read') send({ id: message.id, result: { config: { mcp_servers: {} } } });
    else if (message.method === 'thread/start') {
      threadOptions = message.params;
      const permission = args.find(arg => arg.startsWith('permissions.' + threadOptions.permissions + '='));
      const parent = permission?.includes('extends=":read-only"') ? ':read-only' : ':workspace';
      if (permission) threadOptions.sandbox = parent === ':read-only' ? 'read-only' : 'workspace-write';
      send({ id: message.id, result: { thread: { id: 'fixture-thread' }, activePermissionProfile: permission?.includes('="deny"') ? { id: threadOptions.permissions, extends: parent } : null } });
    }
    else if (message.method === 'turn/start') { send({ id: message.id, result: { turn: { id: 'fixture-turn' } } }); start(message.params.input[0].text); }
    else if (message.id === 'fixture-permission') finish(message.result?.decision === 'accept');
  } else {
    if (message.type === 'control_request') send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } });
    else if (message.type === 'user') { send({ type: 'system', subtype: 'init', session_id: 'fixture-session' }); start(message.message.content); }
    else if (message.type === 'control_response') finish(message.response.response?.behavior === 'allow');
  }
});
