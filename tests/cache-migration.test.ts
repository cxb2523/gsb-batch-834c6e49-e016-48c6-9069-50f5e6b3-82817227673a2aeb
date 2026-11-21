import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,mkdir,readdir,readFile,writeFile,stat} from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {MediaCache} from '../src/main/media';
import {CacheManager} from '../src/main/cache-manager';

const ids=Array.from({length:6},(_,i)=>String(7695386527160863700n+BigInt(i)));
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
async function until(check:()=>boolean){for(let i=0;i<300;i++){if(check())return;await tick()}assert.fail('timed out waiting for migration condition')}
const work=(id:string,episodes:string[])=>({id,title:'迁移作品'+id,cover:'',description:'',total:episodes.length,episodes:episodes.map((episode,index)=>({id:episode,order:index+1}))});
const entryFiles=(names:string[])=>names.filter(name=>/^[a-f0-9]{32}\.mp4$/.test(name));

// hold 指定的分集：第一集完整缓存；held 分集先写出真实断点字节再被取消。
async function fixture(t:any,options:{hold?:string}={}){
 const profile=await mkdtemp(path.join(tmpdir(),'manju-migration-'));
 const directory=path.join(profile,'media-cache');
 const fetched:string[]=[],heldOnce=new Set<string>();
 const spawnMock=t.mock.method(childProcess,'spawn',(_exe:string,args:readonly string[])=>{
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{queueMicrotask(()=>child.emit('close',null));return true}});
  queueMicrotask(async()=>{await writeFile(args.at(-1)!,'prepared-video');child.stdout.write('out_time_us=1000000\n');child.emit('close',0)});
  return child;
 });
 const fetchMock=t.mock.method(globalThis,'fetch',async(url:string,init?:RequestInit)=>{
  const id=new URL(url).pathname.slice(1);fetched.push(id);
  if(id===options.hold&&!heldOnce.has(id)){
   heldOnce.add(id);
   return new Response(new ReadableStream<Uint8Array>({start(controller){
    controller.enqueue(Buffer.from('source'));
    init?.signal?.addEventListener('abort',()=>controller.error(Error('aborted')),{once:true});
   }}));
  }
  return new Response(Buffer.from('source'));
 });
 syncBuiltinESMExports();
 const media=new MediaCache(directory,'fake-ffmpeg',async id=>({episodeId:id,duration:1,definition:'540p',codec:'h264',encrypted:false,url:`https://example.com/${id}`,size:6}),{freeBytes:async()=>10*1024**3,concurrency:2});
 await media.init();
 const manager=new CacheManager(profile,media as any);
 await manager.init();
 t.after(async()=>{await media.close();spawnMock.mock.restore();fetchMock.mock.restore();syncBuiltinESMExports();await rm(profile,{recursive:true,force:true})});
 return {media,manager,profile,directory,fetched,target:path.join(profile,'target','HongguoManjuCache')};
}

test('迁移成功后条目、断点、容量与新写入都指向新目录，旧播放地址仍按范围可读',async t=>{
 const f=await fixture(t,{hold:ids[1]});
 const playback=await f.media.prepare(ids[0]);
 const pending=f.media.prepare(ids[1]);const cancelled=assert.rejects(pending,{code:'CANCELLED'});
 await until(()=>f.media.usedBytes>14);f.media.setBufferWindow([]);await cancelled;
 const retained=f.media.usedBytes;assert.ok(retained>14,'cancelled download must leave resumable bytes');
 const snapshot=await f.manager.migrate(f.target);
 assert.equal(snapshot.directory,path.resolve(f.target));assert.equal(f.media.location,path.resolve(f.target));
 // 已在播放的本地媒体迁移提交后仍能按范围读取，不返回 404
 assert.equal((await f.media.response(playback.url,null)).status,200);
 assert.equal((await f.media.response(playback.url,'bytes=0-3')).status,206);
 const names=await readdir(f.target);
 assert.equal(entryFiles(names).length,1);assert.ok(names.some(name=>name.endsWith('.partial.mp4')),'断点文件必须迁到新目录');
 assert.equal(f.media.usedBytes,retained,'容量统计在迁移前后一致');
 const saved=JSON.parse(await readFile(path.join(f.profile,'cache-settings.json'),'utf8'));
 assert.equal(saved.directory,path.resolve(f.target));
 await assert.rejects(stat(path.join(f.profile,'cache-migration.json')),{code:'ENOENT'},'迁移日志必须随成功提交清除');
 // 迁移期间被取消的前台播放重试时在新目录重新准备，而不是复用旧任务
 const retried=await f.media.prepare(ids[1]);
 assert.equal(retried.episodeId,ids[1]);
 assert.equal(f.fetched.filter(id=>id===ids[1]).length,2);
 assert.equal(entryFiles(await readdir(f.target)).length,2,'新缓存必须写入新目录');
 assert.equal(f.media.usedBytes,28);
 // 重启后仍指向新目录
 const reopened=new CacheManager(f.profile,f.media as any);await reopened.init();
 assert.equal((await reopened.snapshot()).directory,path.resolve(f.target));
});

test('迁移提交失败回滚：原目录可用、目标临时文件清理、设置与后续写入不变',async t=>{
 const f=await fixture(t);
 await f.manager.add(work('12345678',[ids[0]]));
 const playback=await f.media.prepare(ids[0]);
 await mkdir(path.join(f.profile,'cache-settings.json.tmp'));
 await assert.rejects(f.manager.migrate(f.target),{code:'CACHE_SETTINGS'});
 const snapshot=await f.manager.snapshot();
 assert.equal(snapshot.migrating,false);assert.equal(snapshot.directory,f.directory);assert.equal(f.media.location,f.directory);
 assert.deepEqual(await readdir(f.target),[],'已复制到目标目录的临时文件必须清理干净');
 await assert.rejects(stat(path.join(f.profile,'cache-migration.json')),{code:'ENOENT'});
 assert.equal((await f.media.response(playback.url,'bytes=0-3')).status,206,'原目录播放地址必须保持可用');
 const saved=JSON.parse(await readFile(path.join(f.profile,'cache-settings.json'),'utf8'));
 assert.equal(saved.directory,f.directory,'设置不能被半迁移状态污染');
 // 回滚后缓存与新的迁移仍可正常进行
 const next=await f.media.prepare(ids[1]);assert.equal(next.episodeId,ids[1]);
 assert.equal(entryFiles(await readdir(f.directory)).length,2);
 await rm(path.join(f.profile,'cache-settings.json.tmp'),{recursive:true});
 await f.manager.migrate(f.target);assert.equal(f.media.location,path.resolve(f.target));
 assert.equal((await f.media.response(playback.url,null)).status,200);
});

test('迁移期间播放与删除得到可区分的明确拒绝，已播放媒体仍可读',async t=>{
 const f=await fixture(t);
 const playback=await f.media.prepare(ids[0]);
 let releaseCommit!:()=>void;
 const relocation=f.media.relocate(f.target,()=>new Promise<void>(resolve=>{releaseCommit=resolve}));
 await until(()=>f.media.migrationPhase==='committing');
 await assert.rejects(f.media.prepare(ids[1]),{code:'CACHE_MOVING'});
 await assert.rejects(f.media.deleteEpisodes([ids[0]]),{code:'CACHE_BUSY'});
 assert.equal((await f.media.response(playback.url,'bytes=0-3')).status,206,'迁移期间已缓存媒体必须继续可读');
 releaseCommit();await relocation;
 assert.equal(f.media.migrationPhase,null);
 const prepared=await f.media.prepare(ids[1]);assert.equal(prepared.episodeId,ids[1]);
 await f.media.deleteEpisodes([ids[0]]);assert.equal(f.media.stateFor([ids[0]]).ready,0);
});

test('迁移期间删除任务与二次迁移被明确拒绝，迁移完成后删除基于新目录',async t=>{
 const f=await fixture(t);
 const series=work('12345678',[ids[0]]);
 await f.manager.add(series);await f.media.prepare(ids[0]);
 const original=f.media.relocate.bind(f.media);
 let releaseGate!:()=>void;const gate=new Promise<void>(resolve=>{releaseGate=resolve});
 f.media.relocate=async(destination:string,commit:()=>Promise<void>)=>{await gate;return original(destination,commit)};
 const migration=f.manager.migrate(f.target);
 await assert.rejects(f.manager.action(series.id,'delete'),{code:'CACHE_BUSY'},'迁移中删除必须明确拒绝');
 await assert.rejects(f.manager.migrate(path.join(f.profile,'other','HongguoManjuCache')),{code:'CACHE_BUSY'},'迁移不可重入');
 releaseGate();await migration;
 await f.manager.action(series.id,'delete');
 assert.equal(f.media.usedBytes,0);
 assert.equal(entryFiles(await readdir(f.target)).length,0,'删除必须作用于新目录');
 assert.equal((await f.manager.snapshot()).tasks.length,0);
});

test('先到达的删除在迁移前完成，迁移只复制剩余条目',async t=>{
 const f=await fixture(t);
 const first=work('12345678',[ids[0]]),second=work('23456789',[ids[1]]);
 await f.manager.add(first);await f.manager.add(second);
 await f.media.prepare(ids[0]);await f.media.prepare(ids[1]);
 const deletion=f.manager.action(first.id,'delete');
 const migration=f.manager.migrate(f.target);
 await deletion;await migration;
 assert.equal(f.media.stateFor([ids[0]]).ready,0,'删除的条目不能出现在新目录');
 assert.equal(f.media.stateFor([ids[1]]).ready,1);
 assert.equal(entryFiles(await readdir(f.target)).length,1);
 assert.deepEqual((await f.manager.snapshot()).tasks.map(task=>task.series.id),[second.id]);
});

test('应用退出中断迁移时等待回滚完成，目标目录不留临时文件',async t=>{
 const f=await fixture(t);
 await f.media.prepare(ids[0]);
 const original=fsPromises.copyFile;
 let copying=false,releaseCopy!:()=>void;
 const copyMock=t.mock.method(fsPromises,'copyFile',async(...args:any[])=>{copying=true;await new Promise<void>(resolve=>{releaseCopy=resolve});return (original as any)(...args)});
 syncBuiltinESMExports();
 const relocation=f.media.relocate(f.target,async()=>{});
 await until(()=>copying);
 const closing=f.media.close();
 releaseCopy();
 await assert.rejects(relocation,{code:'CACHE_MOVE'});
 await closing;
 assert.equal(f.media.location,f.directory,'退出中断的迁移不能切换目录');
 assert.deepEqual(await readdir(f.target),[],'退出中断时已复制的临时文件必须清理');
 copyMock.mock.restore();
});

test('迁移中断后重启：未提交的迁移回滚清理，已提交的迁移仅清除日志',async t=>{
 const key='a'.repeat(32);
 const metadata=JSON.stringify({key,episodeId:ids[0],duration:1,definition:'540p',touched:1,policy:'highest-resolution-crf20-v1'});
 const make=async(committed:boolean)=>{
  const profile=await mkdtemp(path.join(tmpdir(),'manju-migration-recovery-'));
  t.after(()=>rm(profile,{recursive:true,force:true}));
  const old=path.join(profile,'media-cache'),target=path.join(profile,'target','HongguoManjuCache');
  await mkdir(old,{recursive:true});await mkdir(target,{recursive:true});
  await writeFile(path.join(old,key+'.mp4'),'video');await writeFile(path.join(old,key+'.json'),metadata);
  await writeFile(path.join(target,key+'.mp4'),'video');await writeFile(path.join(target,key+'.json'),metadata);
  const settings={version:1,directory:committed?target:old,closeToTray:true,tasks:[],concurrency:4,knownSeries:[],limits:{maxGiB:20,bandwidthMiB:0}};
  await writeFile(path.join(profile,'cache-settings.json'),JSON.stringify(settings));
  await writeFile(path.join(profile,'cache-migration.json'),JSON.stringify({source:old,target,startedAt:1}));
  const media=new MediaCache(committed?target:old,'fake',async()=>{throw Error('unexpected lookup')});
  t.after(async()=>{await media.close()});
  await media.init();
  const manager=new CacheManager(profile,media as any);await manager.init();
  return {profile,old,target,media,manager};
 };
 // 未提交：原目录保持可用，目标目录的临时文件清理干净
 const rolledBack=await make(false);
 assert.equal((await rolledBack.manager.snapshot()).directory,rolledBack.old);
 assert.deepEqual(await readdir(rolledBack.target).catch((error:any)=>{assert.equal(error.code,'ENOENT');return []}),[]);
 await assert.rejects(stat(path.join(rolledBack.profile,'cache-migration.json')),{code:'ENOENT'});
 assert.ok((await rolledBack.manager.snapshot()).message.includes('迁移'));
 assert.equal(rolledBack.media.stateFor([ids[0]]).ready,1,'原目录缓存必须保持可用');
 // 已提交：迁移实际成功，仅清除残留日志，新目录文件保留
 const committed=await make(true);
 assert.equal((await committed.manager.snapshot()).directory,committed.target);
 assert.equal(entryFiles(await readdir(committed.target)).length,1);
 await assert.rejects(stat(path.join(committed.profile,'cache-migration.json')),{code:'ENOENT'});
 assert.equal(committed.media.stateFor([ids[0]]).ready,1);
});
