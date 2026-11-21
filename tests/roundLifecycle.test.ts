import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {Simulation} from '../src/game/simulation.ts';
import {EMPTY_INPUT} from '../src/game/types.ts';
import {setActiveMap} from '../src/game/map.ts';
import {setEquippedWeapon} from '../src/game/weaponSelection.ts';
import {resetWeaponSwitch} from '../src/game/weaponSwitch.ts';

const DT=1/60,HOLD={...EMPTY_INPUT,interact:true};

beforeEach(()=>setActiveMap('desert'));

// Deterministic objective sandbox: every actor is human-driven, so bots never
// move, shoot or steal the bomb; only the active player's input is simulated.
function sandbox(seed=21){
 const sim=new Simulation(seed);sim.start('demolition');
 for(const a of sim.state.actors)a.player=true;
 sim.state.roundTime=90;
 return sim;
}
function carrierOf(sim:Simulation){return sim.state.actors.find(a=>a.id===sim.state.bomb.carrierId)!;}
function frames(sim:Simulation,count:number,input=EMPTY_INPUT){for(let i=0;i<count;i++)sim.update(DT,input);}
function startPlant(sim:Simulation,holdFrames=90){
 const s=sim.state,t=carrierOf(sim);s.player=t;
 t.x=-10;t.z=-7.2;t.moving=false;t.shotTime=-10;
 frames(sim,holdFrames,HOLD);
 return t;
}
function completePlant(sim:Simulation){
 const t=startPlant(sim,179);
 assert.ok(sim.state.bomb.plantProgress!>.99);
 sim.update(DT,HOLD);
 assert.equal(sim.state.bomb.status,'planted');
 return t;
}
function startDefuse(sim:Simulation,holdFrames:number,kit=true){
 const s=sim.state,ct=s.actors.find(a=>a.faction==='ct')!;
 s.player=ct;ct.defuseKit=kit;ct.moving=false;ct.shotTime=-10;
 ct.x=s.bomb.x;ct.z=s.bomb.z-1;
 frames(sim,holdFrames,HOLD);
 return ct;
}
function internals(sim:Simulation){return sim as unknown as{
 interactionActors:Set<number>;meleePending:Map<number,unknown>;teamReports:Map<string,unknown>;
 pickupInteractHeld:boolean;queuedStab:unknown;brains:Array<{target:number;memory:unknown;path:unknown[];sensedId:number;goal:string}>;
};}

test('plant completes once: planted state, single plantStart/plantComplete and no duplicate events',()=>{
 const sim=sandbox();const t=completePlant(sim);const b=sim.state.bomb;
 assert.equal(b.status,'planted');assert.equal(b.site,'A');assert.equal(sim.state.phase,'planted');
 assert.equal(b.plantProgress,0);assert.equal(b.planterId,null);assert.equal(b.timer,40);
 assert.equal(sim.events.filter(e=>e.type==='plantStart').length,1);
 assert.equal(sim.events.filter(e=>e.type==='plantComplete').length,1);
 // Holding E after the bomb is planted must not start a second plant.
 frames(sim,60,HOLD);
 assert.equal(sim.events.filter(e=>e.type==='plantComplete').length,1);
 assert.equal(t.hasBomb,false);
});

test('defuse completes once: defused state, single defuseStart/defuseComplete and CT wins the round',()=>{
 const sim=sandbox();completePlant(sim);
 sim.events.length=0;
 const ct=startDefuse(sim,299,true);
 assert.equal(sim.state.bomb.status,'planted');assert.ok(sim.state.bomb.progress>.98);
 sim.update(DT,HOLD);
 const b=sim.state.bomb;
 assert.equal(b.status,'defused');assert.equal(sim.state.winner,'blue');
 assert.match(sim.state.roundReason!,/拆除/);
 assert.equal(sim.events.filter(e=>e.type==='defuseStart').length,1);
 assert.equal(sim.events.filter(e=>e.type==='defuseComplete').length,1);
 // The round is over; further frames cannot emit a second completion.
 frames(sim,30,HOLD);
 assert.equal(sim.events.filter(e=>e.type==='defuseComplete').length,1);
 assert.ok(ct.health>0);
});

test('pause freezes plant progress, clocks and the held-interaction state',()=>{
 const sim=sandbox();startPlant(sim,60);
 const b=sim.state.bomb;assert.ok(b.plantProgress!>.25&&b.plantProgress!<.4);
 const progress=b.plantProgress!,snapshot={time:sim.state.time,roundTime:sim.state.roundTime,x:sim.state.player.x,z:sim.state.player.z};
 const events=sim.events.length;
 sim.setPaused(true);assert.equal(sim.state.paused,true);
 frames(sim,120,HOLD);
 assert.equal(sim.state.bomb.plantProgress,progress);
 assert.deepEqual({time:sim.state.time,roundTime:sim.state.roundTime,x:sim.state.player.x,z:sim.state.player.z},snapshot);
 assert.equal(sim.events.length,events);
 // Resuming with the button still held accumulates from the same point.
 sim.setPaused(false);frames(sim,30,HOLD);
 assert.ok(sim.state.bomb.plantProgress!>progress);
 assert.equal(sim.state.bomb.status,'carried');
});

test('pause freezes defuse progress and the planted bomb fuse (no timer ticks)',()=>{
 const sim=sandbox();completePlant(sim);startDefuse(sim,120,true);
 const progress=sim.state.bomb.progress,timer=sim.state.bomb.timer;
 assert.ok(progress>.3);
 const ticks=sim.events.filter(e=>e.type==='bombTick').length;
 sim.setPaused(true);
 frames(sim,180,HOLD);
 assert.equal(sim.state.bomb.progress,progress);
 assert.equal(sim.state.bomb.timer,timer);
 assert.equal(sim.events.filter(e=>e.type==='bombTick').length,ticks);
 sim.setPaused(false);frames(sim,60,HOLD);
 assert.ok(sim.state.bomb.progress>progress);
 assert.ok(sim.state.bomb.timer<timer);
});

test('killing the planter drops the bomb and zeroes plant progress permanently',()=>{
 const sim=sandbox();const t=startPlant(sim,60);
 assert.ok(sim.state.bomb.plantProgress!>.25);
 t.health=0;
 frames(sim,5,EMPTY_INPUT);
 const b=sim.state.bomb;
 assert.equal(b.status,'dropped');assert.equal(b.carrierId,null);assert.equal(b.planterId,null);
 assert.equal(b.plantProgress,0);assert.equal(t.hasBomb,false);
 assert.ok(sim.events.some(e=>e.type==='bombDrop'));
 // No actor is close enough to recover it; progress must never grow again.
 frames(sim,120,HOLD);
 assert.equal(sim.state.bomb.status,'dropped');
 assert.equal(sim.state.bomb.plantProgress,0);
 assert.equal(sim.state.bomb.planterId,null);
});

test('killing the defuser zeroes defuse progress and releases the defuser slot',()=>{
 const sim=sandbox();completePlant(sim);const ct=startDefuse(sim,120,true);
 assert.ok(sim.state.bomb.progress>.3);
 ct.health=0;
 frames(sim,5,EMPTY_INPUT);
 const b=sim.state.bomb;
 assert.equal(b.progress,0);assert.equal(b.defuserId,null);
 assert.equal(b.status,'planted');
 // The remaining CTs stand far away; holding E cannot restart progress here.
 frames(sim,120,HOLD);
 assert.equal(sim.state.bomb.progress,0);
 assert.equal(sim.state.bomb.defuserId,null);
});

test('leaving the bomb site while planting resets progress and blocks further growth',()=>{
 const sim=sandbox();const t=startPlant(sim,60);
 assert.ok(sim.state.bomb.plantProgress!>.25);
 t.x=-10;t.z=1; // outside site A (radius 2.6 around (-10,-5))
 frames(sim,60,HOLD);
 const b=sim.state.bomb;
 assert.equal(b.plantProgress,0);assert.equal(b.planterId,null);assert.equal(b.plantSite,null);
 assert.equal(b.status,'carried');
});

test('leaving defuse range resets progress and clears the defuser slot',()=>{
 const sim=sandbox();completePlant(sim);const ct=startDefuse(sim,120,true);
 assert.ok(sim.state.bomb.progress>.3);
 ct.x=sim.state.bomb.x;ct.z=sim.state.bomb.z+8; // beyond the 2.4 m reach
 frames(sim,30,HOLD);
 const b=sim.state.bomb;
 assert.equal(b.progress,0);assert.equal(b.defuserId,null);
 assert.equal(b.status,'planted');
});

test('round end immediately clears plant/defuse progress, held interaction, melee and reports',()=>{
 const sim=sandbox();const s=sim.state,inside=internals(sim);
 const t=startPlant(sim,90);
 // Seed every other transient that must die with the round.
 setEquippedWeapon(t,'knife');resetWeaponSwitch(t);
 sim.fire(t,'slash');
 assert.equal(inside.meleePending.size,1);
 inside.queuedStab={actor:t,shotTime:t.shotTime};
 inside.teamReports.set('blue',{x:1,z:2,until:s.time+99,targetId:3});
 assert.equal(inside.pickupInteractHeld,true);
 assert.equal(inside.interactionActors.has(t.id),true);
 // Round timeout resolves before the plant finishes.
 s.roundTime=.001;sim.update(DT,HOLD);
 assert.equal(s.phase,'roundEnd');assert.equal(s.winner,'blue');
 const b=s.bomb;
 assert.equal(b.plantProgress,0);assert.equal(b.planterId,null);assert.equal(b.plantSite,null);
 assert.equal(b.progress,0);assert.equal(b.defuserId,null);
 assert.equal(inside.interactionActors.size,0);
 assert.equal(inside.meleePending.size,0);
 assert.equal(inside.queuedStab,null);
 assert.equal(inside.teamReports.size,0);
 assert.equal(inside.pickupInteractHeld,false);
 // Holding E through the intermission cannot re-arm any interaction.
 frames(sim,60,HOLD);
 assert.equal(inside.interactionActors.size,0);
 assert.equal(s.bomb.plantProgress,0);
});

test('a new round starts with a fresh bomb, fresh bot brains and no cached target or report',()=>{
 const sim=new Simulation(33);sim.start('demolition');
 const s=sim.state,inside=internals(sim);
 const bot=s.actors[1],enemy=s.actors[3];
 // Poison the round-1 brain with an old target, memory, route and radio report.
 const oldBrain=inside.brains[bot.id];
 oldBrain.target=enemy.id;oldBrain.sensedId=enemy.id;
 oldBrain.memory={x:enemy.x,z:enemy.z,until:s.time+50};
 oldBrain.path=[{x:1,z:2}];oldBrain.goal='stale-goal';
 inside.teamReports.set(bot.team,{x:enemy.x,z:enemy.z,until:s.time+50,targetId:enemy.id,reportedAt:s.time});
 s.actors.filter(a=>a.team==='red').forEach(a=>a.health=0);
 sim.update(DT);
 assert.equal(s.phase,'roundEnd');
 frames(sim,241); // pass the four-second intermission
 assert.equal(s.phase,'playing');assert.equal(s.round,2);
 const b=s.bomb;
 assert.equal(b.status,'carried');assert.equal(b.plantProgress,0);assert.equal(b.planterId,null);
 assert.equal(b.progress,0);assert.equal(b.defuserId,null);assert.equal(b.plantSite,null);
 const carrier=s.actors.find(a=>a.hasBomb)!;
 assert.equal(carrier.faction,'t');
 const fresh=inside.brains[bot.id];
 assert.notEqual(fresh,oldBrain);
 assert.equal(fresh.target,-1);assert.equal(fresh.sensedId,-1);
 assert.equal(fresh.memory,null);assert.deepEqual(fresh.path,[]);assert.equal(fresh.goal,'');
 assert.equal(inside.teamReports.size,0);
 assert.equal(inside.interactionActors.size,0);
 assert.equal(inside.meleePending.size,0);
 assert.equal(inside.pickupInteractHeld,false);
});

test('restarting via start() and returning to the menu leave no objective residue',()=>{
 const sim=sandbox();const s=sim.state,inside=internals(sim);
 startPlant(sim,90);
 inside.teamReports.set('blue',{x:0,z:0,until:s.time+99});
 assert.ok(s.bomb.plantProgress!>.4);
 sim.menu();
 assert.equal(s.phase,'menu');
 assert.equal(s.bomb.plantProgress,0);assert.equal(s.bomb.planterId,null);
 assert.equal(s.bomb.progress,0);assert.equal(s.bomb.defuserId,null);
 assert.equal(inside.teamReports.size,0);
 assert.equal(inside.interactionActors.size,0);
 assert.equal(inside.meleePending.size,0);
 assert.equal(inside.pickupInteractHeld,false);
 // A brand new match begins at round 1 with a carried bomb and zero progress.
 sim.start('demolition');
 assert.equal(s.round,1);assert.equal(s.phase,'playing');
 assert.equal(s.bomb.status,'carried');assert.equal(s.bomb.plantProgress,0);assert.equal(s.bomb.progress,0);
 assert.equal(inside.teamReports.size,0);
});

test('a real knife swing pending at round end is discarded, not resolved next round',()=>{
 const sim=sandbox();const s=sim.state,inside=internals(sim);
 const t=carrierOf(sim);s.player=t;setEquippedWeapon(t,'knife');resetWeaponSwitch(t);
 t.x=-10;t.z=-7.2;
 assert.equal(sim.fire(t,'slash'),true);
 assert.equal(inside.meleePending.size,1);
 s.roundTime=.001;sim.update(DT);
 assert.equal(s.phase,'roundEnd');
 assert.equal(inside.meleePending.size,0);
 frames(sim,241);
 assert.equal(s.round,2);
 assert.equal(inside.meleePending.size,0);
 // The stale swing's delayed contact cannot resolve into damage next round.
 assert.equal(sim.events.filter(e=>e.type==='hit').length,0);
 assert.equal(sim.events.filter(e=>e.type==='kill').length,0);
 // Every actor of the new round is untouched at full health.
 assert.ok(s.actors.every(a=>a.health===100));
});

test('match point ending mid-plant clears every interaction transient before restart',()=>{
 const sim=sandbox();const s=sim.state,inside=internals(sim);
 s.blueScore=2; // the next blue win finishes the match
 startPlant(sim,90);
 assert.ok(s.bomb.plantProgress!>.4);
 inside.teamReports.set('red',{x:3,z:4,until:s.time+99,targetId:0,reportedAt:s.time});
 s.actors.filter(a=>a.team==='red').forEach(a=>a.health=0);
 sim.update(DT);
 assert.equal(s.phase,'matchEnd');assert.equal(s.blueScore,3);
 const b=s.bomb;
 assert.equal(b.plantProgress,0);assert.equal(b.planterId,null);assert.equal(b.plantSite,null);
 assert.equal(b.progress,0);assert.equal(b.defuserId,null);
 assert.equal(inside.interactionActors.size,0);
 assert.equal(inside.meleePending.size,0);
 assert.equal(inside.teamReports.size,0);
 assert.equal(inside.pickupInteractHeld,false);
 // Restarting the match begins clean with no remembered target.
 sim.start('demolition');
 assert.equal(s.phase,'playing');assert.equal(s.round,1);assert.equal(s.blueScore,0);
 assert.equal(s.bomb.status,'carried');assert.equal(s.bomb.plantProgress,0);
 assert.ok(inside.brains.every(brain=>brain.target===-1&&brain.memory===null));
});
