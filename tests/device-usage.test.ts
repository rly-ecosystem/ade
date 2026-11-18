import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DeviceHistory, type HistoryRoot } from '../packages/runtime/src/device-history.js';
import { discoverUsageHomes } from '../packages/runtime/src/usage-homes.js';
import { decodeQuota } from '../packages/runtime/src/plan-quota.js';
import { Runtime } from '../packages/runtime/src/service.js';
import { parseRequest } from '../packages/contracts/src/index.js';

test('Codex reads current and legacy buckets, zero balances, weekly resets, and additional models', () => {
  const raw = { limitId:'codex', planType:'plus', primary:{ usedPercent:0, windowDurationMins:300, resetsAt:1900000000 }, secondary:{ usedPercent:75, windowDurationMins:10080 }, credits:{ hasCredits:false, balance:'0' } };
  const plain = decodeQuota('codex', { rateLimits:raw });
  const extra = decodeQuota('codex', { rateLimits:raw, rateLimitResetCredits:{availableCount:0}, rateLimitsByLimitId:{ codex:raw, other:{ limitName:'Review', primary:{usedPercent:10,windowDurationMins:60}, individualLimit:{remainingPercent:60,resetsAt:null} } } });
  assert.equal(extra.resetCredits,0); assert.equal(plain.plan,'plus'); assert.equal(plain.credits,'0');
  assert.deepEqual(extra.windows, [...plain.windows,{ label:'Review · Личный лимит', used:40, resetAt:null },{ label:'Review · 1 ч', used:10, resetAt:null }]);
  assert.deepEqual(plain.windows[0], { label:'5 ч', used:0, resetAt:new Date(1900000000000).toISOString() });
  assert.equal(plain.windows[1]?.label, 'Неделя');
});

test('Claude distinguishes measured zero from missing, includes scoped usage and extra spend', () => {
  const result = decodeQuota('claude',{subscription_type:'max',rate_limits_available:true,rate_limits:{
    five_hour:{utilization:0},seven_day:{utilization:null},seven_day_opus:{utilization:19},
    model_scoped:[{display_name:'Opus',utilization:19},{display_name:'Fable',utilization:32}],
    extra_usage:{is_enabled:true,utilization:50,used_credits:10000,monthly_limit:20000,currency:'USD'},
  }});
  assert.deepEqual(result.windows.map(w=>w.used),[0,19,32,50]);
  assert.match(result.extraSpend!,/100/);
  const missing=decodeQuota('claude',{rate_limits_available:false});
  assert.equal(missing.windows.length,0); assert.ok(missing.note);
});

test('device history merges archives, shared transcript roots and ADE reports without duplicating sessions', async t => {
  const home = mkdtempSync(path.join(tmpdir(),'ade-history-'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const codex = path.join(home,'.codex'), claude = path.join(home,'.claude'), linked = path.join(home,'.claude-work');
  const roots: HistoryRoot[] = [{home:codex,provider:'codex',profileId:'shared-codex'},{home:claude,provider:'claude',profileId:'shared-claude'},{home:linked,provider:'claude',profileId:'cli-test'}];
  const now = new Date(); now.setHours(12,0,0,0);
  const stamp = (ago:number, hour=9) => new Date(now.getFullYear(),now.getMonth(),now.getDate()-ago,hour).toISOString();
  const log = (dir:string,name:string,rows:unknown[]) => {
    mkdirSync(dir,{recursive:true});
    const file = path.join(dir,name+'.jsonl'); writeFileSync(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\n'); return file;
  };
  const count = (ago:number, amount:number) => ({type:'event_msg',timestamp:stamp(ago),payload:{type:'token_count',info:{total_token_usage:{total_tokens:amount+10},last_token_usage:{input_tokens:amount,cached_input_tokens:10,output_tokens:10}}}});
  const meta = {type:'session_meta',payload:{id:'codex-a'}}, context = {type:'turn_context',payload:{model:'m-codex',turn_id:'turn-a'}};
  log(path.join(codex,'sessions','2026'),'a',[meta,context,count(1,100),count(1,100)]);
  log(path.join(codex,'archived_sessions'),'a-copy',[meta,context,count(1,100)]);
  log(path.join(codex,'archived_sessions'),'b',[{type:'session_meta',payload:{id:'b'}},count(10,200)]);
  const assistant = (id:string, out:number) => ({type:'assistant', timestamp:stamp(0), sessionId:'claude-a',requestId:id,message:{id,model:'m-claude',usage:{input_tokens:12,cache_read_input_tokens:4,cache_creation_input_tokens:4,output_tokens:out}}});
  const file=log(path.join(claude,'projects','app'),'c',[assistant('one',2),assistant('one',8)]);
  mkdirSync(linked); symlinkSync(path.join(claude,'projects'),path.join(linked,'projects'));
  // An exported profile may contain copies as well as links to the same conversation.
  const copy = path.join(home,'.claude-copy');
  log(path.join(copy,'projects','other'),'copy',[assistant('one',8)]);
  roots.push({home:copy,provider:'claude',profileId:'cli-copy'});
  const newRun = (sessionId:string) => ({id:sessionId,provider:'codex' as const,profileId:null,sessionId,model:'m-codex',startedAt:stamp(0),usageData:JSON.stringify({input:4,output:3,cachedInput:0,cacheWrite:0})});
  const dbRuns=[newRun('codex-a'),newRun('only-in-ade'),{...newRun('claude-a'),provider:'claude' as const,profileId:'cli-test'}];
  const history=new DeviceHistory();
  const [week,month] = await Promise.all([history.read(roots,7,dbRuns,now),history.read(roots,30,dbRuns,now)]);
  assert.deepEqual(week.totals,{input:124,output:21,cachedInput:14,cacheWrite:4,sessions:3});
  assert.equal(week.days.length,7); assert.equal(month.days.length,30);
  assert.equal(month.totals.input,324); assert.equal(week.partial,false);
  assert.equal(week.profiles.length,2); assert.equal(week.profiles.find(p=>p.provider==='claude')?.profileId,'cli-test'); assert.deepEqual(week.models.map(m=>m.model),['m-codex','m-claude']);
  appendFileSync(file,JSON.stringify(assistant('two',0))+'\n{"type":"assistant","usage":broken}\n');
  const changed=await history.read(roots,7,dbRuns,now);
  assert.equal(changed.totals.input,144); assert.equal(changed.totals.sessions,3); assert.equal(changed.partial,true);
});

test('secondary CLI catalogs can supply usage only; unknown paths and SIWC cannot use the shared quota', async t => {
  const home=mkdtempSync(path.join(tmpdir(),'ade-quota-homes-'));
  t.after(()=>rmSync(home,{recursive:true,force:true}));
  const codexHome=path.join(home,'.codex-team'), claudeHome=path.join(home,'.config','work');
  mkdirSync(codexHome); mkdirSync(claudeHome,{recursive:true});
  writeFileSync(path.join(codexHome,'auth.json'),'invalid fixture'); writeFileSync(path.join(claudeHome,'.claude.json'),'');
  const sources=await discoverUsageHomes(home,{CLAUDE_CONFIG_DIR:claudeHome},[]);
  assert.deepEqual(sources.map(s=>s.provider).sort(),['claude','codex']);
  const profileId=sources[0]!.profileId;
  assert.doesNotThrow(()=>parseRequest({method:'usage.quota',params:{profileId}}));
  assert.throws(()=>parseRequest({method:'profile.select',params:{profileId}}));
  assert.throws(()=>parseRequest({method:'usage.quota',params:{profileId:'../../etc'}}));
  const runtime=new Runtime(path.join(home,'data','ade.sqlite'));
  t.after(()=>runtime.close());
  const profile=runtime.profiles.create('codex','Test','fixture').profiles.at(-1)!;
  const result=await runtime.profiles.quota(profile.id);
  assert.equal(result.windows.length,0); assert.match(result.note!,/ChatGPT/);
  await assert.rejects(runtime.profiles.quota('cli-'+'0'.repeat(24)),/Каталог/);
});
