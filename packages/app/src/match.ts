// Glue: owns the Sim, the InputManager, and the Renderer, and drives them
// from the fixed-timestep loop. Iterates fighters by this.sim.numFighters (
// the sim) rather than assuming 2, so the app layer isn't what blocks a
// future N-fighter sim.
import {
  Sim,
  fixed as fx,
  hashStateBuffer,
  MAX_ITEMS,
  MAX_HAZARDS,
  botName,
  type StateBuffer,
  type CharacterData,
  type FighterSnapshot,
  type ItemSnapshot,
  type HazardSnapshot,
  type InputFrame,
  type MatchSettings,
  DEFAULT_ARENA,
} from '@bash-fighter/sim';
import { buildLocalBots, buildTickInputs, type BotController } from './local-crowd-bots.ts';
import { PLACEHOLDER_CHARACTER, createMatchSim, pickArenaId } from '@bash-fighter/content';
import { InputManager } from '@bash-fighter/input';
import {
  Renderer,
  arenaDataToStageBounds,
  computeEdgeDangerFrac,
  type RenderFighterState,
  type RenderItemState,
  type RenderHazardState,
  type RenderFrame,
  type StageBounds,
} from '@bash-fighter/render';
import { FixedTimestepLoop } from './loop.ts';
import { SpectateSession } from './spectator/session.ts';
import { AudioManager } from '@bash-fighter/audio';
import { detectFighterEvents, detectItemEvents } from './effects-events.ts';
import { EffectsAudioBridge } from './effects-audio.ts';
import { currentArenaBounds, previewArenaBounds } from './arena-preview.ts';

// Item HELD state id (mirrors packages/sim/src/sim.ts's private ItemState
// enum: 0=world, 1=held, 2=thrown, 3=armed). Not exported by the sim
// package, so duplicated here as a stable numeric constant rather than
// widening the sim's public surface for a render-only concern.
const ITEM_STATE_HELD = 1;
const ITEM_STATE_ARMED = 3;

// Stylized world-unit marker size for the hazard's ground-impact
// indicator — matches the general scale FighterSprite/ItemSprite use
// (BODY_WIDTH=14), not a pixel-exact readout of the sim's hazard hitbox.
const HAZARD_MARKER_HALF_WIDTH = 11;

// Kept for callers (main.ts's spectator fallback arena) that need a
// StageBounds before any Match/Sim exists. The Match instance itself
// always derives its Renderer's StageBounds from the actual Sim's arena
// below (this.sim.getArena()), never from this constant, so a match built
// with a different arena still renders correctly.
export const STAGE_BOUNDS: StageBounds = arenaDataToStageBounds(DEFAULT_ARENA);

export interface MatchEvents {
  onStockLost?(fighterIndex: number, stocksRemaining: number): void;
  /** leaderboard is slots best-to-worst (Sim.getLeaderboard()) and
   * settings is this match's resolved MatchSettings -- both needed by
   * main.ts to tell a Timed Brawl finish from a Battle Royale one and
   * show the right end screen (see timed-brawl.ts, TimedBrawlEndScreen). */
  onMatchOver?(winnerIndex: number | null, leaderboard?: readonly number[], settings?: MatchSettings): void;
  /** Runs right before a frame is handed to the renderer. Lets the app
   * layer (spectator camera, elimination flags) rewrite the frame
   * without the Match/Renderer needing to know about spectate policy. */
  transformFrame?(frame: RenderFrame): RenderFrame;
  /** Fired once when the canvas's WebGL context is lost (see
   * packages/render/src/index.ts's Renderer.onContextLost) -- the sim
   * keeps ticking underneath regardless, this is presentation-only. */
  onContextLost?(): void;
  /** Fired once if/when the browser restores the context. */
  onContextRestored?(): void;
  /** Fired once if, a few seconds after the match started, the renderer
   * has not genuinely presented a single frame -- see Renderer.
   * getFramesPresented and the watchdog in start() below. Covers the
   * case webglcontextlost/restored cannot: a renderer that never
   * becomes able to draw in the first place (dead/blocklisted GPU
   * context, WebGL exhausted after a prior context died), which our own
   * contextLost flag has no event to catch. Never fires if onContextLost
   * already did, for the same underlying failure -- see start(). */
  onRenderStalled?(): void;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Runs one local match: fixed 60Hz sim + interpolated render + input
 * sampling. Fighter count comes from this.sim.numFighters, read once, not 2
 * literals scattered through this file. */
export class Match {
  readonly sim: Sim;
  readonly characters: CharacterData[];
  readonly input = new InputManager();
  readonly renderer: Renderer;
  private readonly loop: FixedTimestepLoop;
  private prevSnapshots: FighterSnapshot[];
  private currSnapshots: FighterSnapshot[];
  private prevItemSnapshots: ItemSnapshot[];
  private currItemSnapshots: ItemSnapshot[];
  private prevHazardSnapshots: HazardSnapshot[];
  private currHazardSnapshots: HazardSnapshot[];
  private lastStocks: number[];
  private over = false;
  private pendingEvents: import('./effects-events.ts').EffectEvent[] = [];
  // Debounce for the boundary-danger sound: only fires on the falling->
  // rising crossing of the threshold, never continuously while inside the
  // danger band (a player standing at the edge would otherwise get a
  // sound every frame -- the opposite of useful signal).
  private edgeDangerSounding = false;
  private ringDamageAudioCooldownTicks = 0;
  private readonly hashBuf: StateBuffer;

  private readonly numFighters: number;
  readonly audio: AudioManager;
  private readonly effectsBridge: EffectsAudioBridge;
  private readonly bots: Map<number, BotController>;
  // Which slots this local harness's InputManager drives (see the
  // localSeats constructor parameter). Everything else is bot-filled.
  private readonly localSeats: number[];
  // Generation-scoped lifecycle state shared with main.ts's spectator
  // wiring: which seats are frozen for good, whether we are spectating,
  // and the unacked input window that a reconnect must discard rather than
  // replay. See spectator/session.ts.
  readonly session: SpectateSession;
  // Local-play equivalent of NetMatch's server-broadcast names[] (see
  // packages/app/src/net-match.ts and the Player Names 2026-09-11 wiki
  // page): a local/?crowd20=1 match has no server to hand out names, so
  // bot slots get the same botName(slot) the server itself uses
  // (packages/sim/src/ai/bot.ts) and human slots are left unnamed --
  // matching how the local HUD/badges already read for a human ("#1",
  // no name line) before this feature existed. This is what makes
  // ?crowd20=1 a genuine stand-in for a crowded online match when
  // checking name-label legibility, rather than a silent no-op.
  private readonly names: string[];

  constructor(
    parent: HTMLElement,
    characters: CharacterData[] = new Array(2).fill(PLACEHOLDER_CHARACTER),
    seed: number = 1,
    private readonly events: MatchEvents = {},
    sim?: Sim,
    audio: AudioManager = new AudioManager(),
    // Local play (the 2-keyboard harness and the ?crowd20=1 debug/QA
    // harness alike) never had bot input sources: InputManager.poll()
    // always returns exactly 2 InputFrames (one per local slot), so any
    // extra fighter slots got no InputFrame at all and Sim.advance()
    // threw "expected N inputs, got 2" the moment a match had more than
    // 2 fighters -- this is exactly what made ?crowd20=1 throw every
    // tick. humanSlotCount says how many of the leading fighter slots
    // are driven by InputManager (2 for local play); every slot at or
    // beyond it gets a BotController, deterministically seeded from the
    // match seed exactly like the server does (see server/src/match.ts),
    // so a crowd match is reproducible for a given seed.
    humanSlotCount: number = 2,
    // Dev/QA override only (see ?arena=<id> in main.ts and issue #19):
    // pins this local match's stage instead of deriving it from the seed.
    // Ignored (stays seed-derived) when omitted/null, so this changes
    // nothing about ordinary local play or online play (which threads its
    // own server-assigned arenaId through a different path entirely).
    arenaIdOverride?: string | null,
    // Dev/QA override only (local-crowd Timed Brawl testing, see
    // ?mode=timedKO&timeLimit=<seconds> in main.ts and
    // docs/LOCAL_CROWD_TESTING.md): lets a local match run any
    // MatchSettings the sim supports instead of always defaulting to
    // battleRoyale. Ignored (stays battleRoyale) when omitted, so this
    // changes nothing about ordinary local play.
    settingsOverride?: Partial<MatchSettings>,
    // Which local slots this harness controls. Defaults to the leading
    // `humanSlotCount` seats (2 for ordinary local play, none for the
    // all-bot attract-mode demo), preserving the old wiring exactly.
    // ?crowd20=1&seat=<n> narrows it to one seat, so the player's own
    // fighter can be eliminated while a full 20-fighter field plays on --
    // the local stand-in for a real online elimination.
    localSeats: readonly number[] = Array.from({ length: humanSlotCount }, (_, i) => i),
  ) {
    this.characters = characters;
    this.audio = audio;
    // An explicitly empty localSeats (attract mode: every slot is a bot)
    // must stay empty -- inventing a seat here would take a slot away from
    // the bot fill below. An omitted list means "the leading humanSlotCount
    // seats", which is what the default parameter already produced.
    this.localSeats = [...localSeats];
    this.session = new SpectateSession();
    this.session.startGeneration((this.localSeats[0] ?? -1) as number);
    this.effectsBridge = new EffectsAudioBridge(audio);
    // Local play: the human is slot 0 by convention (the rest are bots).
    this.effectsBridge.setContext(characters, this.localSeats[0] ?? 0);
    // Local play must build its Sim through the same sanctioned path the
    // server and online clients use (createMatchSim) so it exercises the
    // real item set, hazard config, and arena resolution instead of the
    // bare Sim defaults -- see packages/content/src/match-sim.ts. Local
    // matches have no server dictating an arenaId, so we pick one
    // deterministically from the seed via the same pickArenaId helper the
    // server uses for its own random-arena selection, keeping local play
    // varied but reproducible for a given seed.
    this.sim = sim ?? createMatchSim(seed, characters.length, settingsOverride, characters, arenaIdOverride ?? pickArenaId(seed));
    this.numFighters = this.sim.numFighters;
    // Bot-fill every slot InputManager doesn't drive. Same construction
    // the server uses per-seat (BotDifficulty.EASY, matching production's
    // actual difficulty -- see "Bot Difficulty Correction" -- and
    // deriveBotSeed(seed, slot) for determinism), just decided locally by
    // slot index instead of a per-seat isBot flag.
    this.bots = buildLocalBots(seed, this.numFighters, humanSlotCount);
    // A slot this harness controls must not also have a bot decision
    // driving it -- exactly one owner per slot. Slots in localSeats at or
    // after humanSlotCount (the ?seat= narrowing of the crowd harness) are
    // therefore removed from the bot map.
    for (const slot of this.localSeats) this.bots.delete(slot);
    this.names = Array.from({ length: this.numFighters }, (_, slot) => (this.bots.has(slot) ? botName(slot) : ''));
    this.renderer = new Renderer(arenaDataToStageBounds(this.sim.getArena()));
    this.prevSnapshots = this.snapshotAll();
    this.currSnapshots = this.snapshotAll();
    this.prevItemSnapshots = this.snapshotItems();
    this.currItemSnapshots = this.snapshotItems();
    this.prevHazardSnapshots = this.snapshotHazards();
    this.currHazardSnapshots = this.snapshotHazards();
    this.lastStocks = this.currSnapshots.map((s) => s.stocks);
    this.hashBuf = this.sim.createStateBuffer();
    this.loop = new FixedTimestepLoop(
      () => this.tick(),
      (alpha) => this.renderFrame(alpha),
    );
    void parent;
  }

  async init(parent: HTMLElement): Promise<void> {
    this.renderer.onContextLost = () => this.events.onContextLost?.();
    this.renderer.onContextRestored = () => this.events.onContextRestored?.();
    await this.renderer.init(parent);
    // QA/automation hook only, mirrors the existing window.__debug*
    // convention in packages/render -- lets a browser-automation pass
    // force/verify a real webglcontextlost/restored round trip via
    // Renderer.debugForceContextLoss/Restore. Inert for a real player:
    // nothing in this codebase reads this global on its own.
    if (typeof window !== 'undefined') (window as unknown as Record<string, unknown>).__debugRenderer = this.renderer;
    this.input.attach(window);
  }

  // A slow-but-working device must never see this: the grace period is
  // generous (several seconds) and the trigger condition is "literally
  // zero frames drawn", not "few" -- a device managing even a single
  // frame in that window cancels it. Tuned against the watchdog test in
  // packages/app/test/webgl-context-loss.test.ts.
  private static readonly RENDER_WATCHDOG_MS = 6000;
  private renderWatchdogTimer: ReturnType<typeof setTimeout> | null = null;

  start(): void {
    this.loop.start();
    this.renderWatchdogTimer = setTimeout(() => {
      this.renderWatchdogTimer = null;
      // If onContextLost already fired for this renderer, that is the
      // same underlying failure by a different route -- do not also fire
      // onRenderStalled and do not show a second overlay for it (see
      // main.ts's showContextLostOverlay callers).
      if (this.renderer.isContextLost()) return;
      if (this.renderer.getFramesPresented() === 0) this.events.onRenderStalled?.();
    }, Match.RENDER_WATCHDOG_MS);
  }

  stop(): void {
    this.loop.stop();
    this.input.detach(window);
    // Leaving the match ends its generation: buffered state from it must
    // never be reachable by whatever starts next (a rematch, a reconnect,
    // the replay viewer). Idempotent by construction (see SpectateSession).
    this.session.invalidate();
    if (this.renderWatchdogTimer !== null) {
      clearTimeout(this.renderWatchdogTimer);
      this.renderWatchdogTimer = null;
    }
  }

  setDebug(on: boolean): void {
    this.renderer.setDebug(on);
  }

  toggleDebug(): void {
    this.renderer.setDebug(!this.renderer.isDebug());
  }

  private snapshotAll(): FighterSnapshot[] {
    const out: FighterSnapshot[] = [];
    for (let i = 0; i < this.numFighters; i++) out.push(this.sim.getFighter(i));
    return out;
  }

  private snapshotItems(): ItemSnapshot[] {
    const out: ItemSnapshot[] = [];
    for (let i = 0; i < MAX_ITEMS; i++) out.push(this.sim.getItem(i));
    return out;
  }

  private snapshotHazards(): HazardSnapshot[] {
    const out: HazardSnapshot[] = [];
    for (let i = 0; i < MAX_HAZARDS; i++) out.push(this.sim.getHazard(i));
    return out;
  }

  private tick(): void {
    if (this.over) return;
    // Collect input only while this harness still has a live seat. Once
    // every local seat is frozen the session reports spectating and
    // pollSlots(0) stops sampling at the source (while still clearing the
    // keyboard's per-poll tap set), so nothing this harness reads can be
    // submitted or predicted afterwards. Per-seat freezing is enforced one
    // step later by buildTickInputs, so an ordinary 2-keyboard match keeps
    // player 2's controls alive after player 1 is out. See
    // spectator/session.ts rule 1.
    const polled = this.currentLocalSlot() !== null
      ? this.input.pollSlots(this.seatWriteLimit())
      : this.input.pollSlots(0);
    const inputs: InputFrame[] = buildTickInputs(
      this.sim,
      this.polledByFighterSlot(polled),
      this.bots,
      this.numFighters,
      this.session.frozenSeats(),
    );
    this.sim.advance(inputs);

    this.prevSnapshots = this.currSnapshots;
    this.currSnapshots = this.snapshotAll();
    this.prevItemSnapshots = this.currItemSnapshots;
    this.currItemSnapshots = this.snapshotItems();
    this.prevHazardSnapshots = this.currHazardSnapshots;
    this.currHazardSnapshots = this.snapshotHazards();

    const fighterEvents = detectFighterEvents(this.prevSnapshots, this.currSnapshots, this.numFighters);
    const itemEvents = detectItemEvents(this.prevItemSnapshots, this.currItemSnapshots, MAX_ITEMS);
    this.pendingEvents.push(...fighterEvents, ...itemEvents);

    for (let i = 0; i < this.numFighters; i++) {
      const stocks = (this.currSnapshots[i] as FighterSnapshot).stocks;
      if (stocks < (this.lastStocks[i] as number)) {
        this.events.onStockLost?.(i, stocks);
      }
      this.lastStocks[i] = stocks;
    }

    // Elimination handover, tick-exact: the sim state that first reports a
    // local seat eliminated is the last state that seat may have affected.
    // Freeze it here (not only in the render path) so even a burst of
    // catch-up ticks inside one animation frame can never submit another
    // input for it, and so the authority never sees it either.
    this.freezeEliminatedLocalSeats();

    if (this.sim.isMatchOver() && !this.over) {
      this.over = true;
      this.events.onMatchOver?.(this.sim.getWinner(), this.sim.getLeaderboard(), this.sim.getMatchSettings());
    }
  }

  /** Highest InputManager slot index this harness may still sample: the
   * greatest local seat that is not frozen, +1 (0 when none remain). */
  private seatWriteLimit(): number {
    let limit = 0;
    for (const slot of this.localSeats) {
      if (!this.session.isSeatFrozen(slot)) limit = Math.max(limit, slot + 1);
    }
    return limit;
  }

  /** InputManager polls its own slots 0..n-1 (keyboard/gamepad seats), but
   * a fighter slot is not necessarily an InputManager slot: ?seat=<n> puts
   * the one controlled fighter into the middle of the crowd while its
   * controls stay on InputManager slot 0. Map one onto the other here so
   * `polled[fighterSlot]` always means "the frame for that fighter". */
  private polledByFighterSlot(polled: readonly InputFrame[]): InputFrame[] {
    if (this.localSeats.length === 0) return [];
    if (this.localSeats.length === 1) {
      const single = this.localSeats[0] as number;
      const out: InputFrame[] = [];
      const frame = polled[0];
      if (frame) out[single] = frame;
      return out;
    }
    return [...polled];
  }

  private freezeEliminatedLocalSeats(): void {
    for (const slot of this.localSeats) {
      if (this.session.isSeatFrozen(slot)) continue;
      if (!(this.currSnapshots[slot] as FighterSnapshot).eliminated) continue;
      this.session.freezeSeat(slot);
    }
    const anyLiveSeat = this.localSeats.some((slot) => !this.session.isSeatFrozen(slot));
    if (!anyLiveSeat) {
      this.session.beginSpectating(this.session.generation);
      // Only once NO seat is left do we forget every held key. Doing it per
      // seat would wipe the other local player's controls the moment
      // player 1 is out of an ordinary two-keyboard match; per-seat
      // neutralisation is already guaranteed by buildTickInputs above.
      this.input.releaseAll();
    }
  }

  private renderFrame(alpha: number): void {
    const fighters: RenderFighterState[] = [];
    for (let i = 0; i < this.numFighters; i++) {
      const prev = this.prevSnapshots[i] as FighterSnapshot;
      const curr = this.currSnapshots[i] as FighterSnapshot;
      fighters.push({
        x: lerp(fx.toFloat(prev.posX), fx.toFloat(curr.posX), alpha),
        y: lerp(fx.toFloat(prev.posY), fx.toFloat(curr.posY), alpha),
        facing: curr.facing,
        state: curr.state,
        moveId: curr.moveId,
        moveFrame: curr.moveFrame,
        percent: curr.percent,
        stocks: curr.stocks,
        shieldHealth: curr.shieldHealth,
        hitstun: curr.hitstun,
        eliminated: curr.eliminated,
        inRingDanger: curr.inRingDanger,
      });
    }    const items: RenderItemState[] = [];
    for (let i = 0; i < MAX_ITEMS; i++) {
      const prev = this.prevItemSnapshots[i] as ItemSnapshot;
      const curr = this.currItemSnapshots[i] as ItemSnapshot;
      if (!curr.active) {
        items.push({ active: false, typeId: 0, x: 0, y: 0, held: false, holderFacing: 1, armed: false, fuseTicks: 0 });
        continue;
      }
      const held = curr.state === ITEM_STATE_HELD;
      // Held items snap to the holder's interpolated position instead of
      // lerping the item's own prev/curr (which jump when pickup/drop
      // changes ownership) so they never visually detach from the hand.
      let x: number;
      let y: number;
      let holderFacing: 1 | -1 = 1;
      if (held && curr.holder >= 0 && curr.holder < this.numFighters) {
        const hf = fighters[curr.holder] as RenderFighterState;
        x = hf.x;
        y = hf.y;
        holderFacing = hf.facing;
      } else if (prev.active) {
        x = lerp(fx.toFloat(prev.posX), fx.toFloat(curr.posX), alpha);
        y = lerp(fx.toFloat(prev.posY), fx.toFloat(curr.posY), alpha);
      } else {
        x = fx.toFloat(curr.posX);
        y = fx.toFloat(curr.posY);
      }
      items.push({
        active: true,
        typeId: curr.typeId,
        x,
        y,
        held,
        holderFacing,
        armed: curr.state === ITEM_STATE_ARMED,
        fuseTicks: curr.fuse,
      });
    }

    const hazards: RenderHazardState[] = [];
    for (let i = 0; i < MAX_HAZARDS; i++) {
      const prev = this.prevHazardSnapshots[i] as HazardSnapshot;
      const curr = this.currHazardSnapshots[i] as HazardSnapshot;
      if (!curr.active) {
        hazards.push({ active: false, x: 0, y: 0, halfWidth: HAZARD_MARKER_HALF_WIDTH });
        continue;
      }
      const x = prev.active ? lerp(fx.toFloat(prev.posX), fx.toFloat(curr.posX), alpha) : fx.toFloat(curr.posX);
      const y = prev.active ? lerp(fx.toFloat(prev.posY), fx.toFloat(curr.posY), alpha) : fx.toFloat(curr.posY);
      hazards.push({ active: true, x, y, halfWidth: HAZARD_MARKER_HALF_WIDTH });
    }

    const { hitEffects, eliminationEffects } = this.effectsBridge.consume(this.pendingEvents, this.currSnapshots);
    this.pendingEvents = [];

    // Hazard/boundary danger cue for the local player only (the seat this
    // harness is still playing -- see currentLocalSlot; null once it is
    // eliminated/spectating, which is exactly when the cue must stop).
    // Debounced on the threshold crossing so it announces "you're now in
    // danger", not a continuous alarm.
    const localSlot = this.currentLocalSlot();
    const localSnap = localSlot === null ? undefined : this.currSnapshots[localSlot];
    if (localSnap && !localSnap.eliminated) {
      const liveBounds = currentArenaBounds(this.sim.getCurrentBlastRect());
      const danger = computeEdgeDangerFrac(fx.toFloat(localSnap.posX), fx.toFloat(localSnap.posY), {
        platforms: [],
        blastMinX: liveBounds.minX,
        blastMaxX: liveBounds.maxX,
        blastMinY: liveBounds.minY,
        blastMaxY: liveBounds.maxY,
      });
      const inDanger = danger > 0.6;
      if (inDanger && !this.edgeDangerSounding) this.audio.playHazardWarning(true);
      this.edgeDangerSounding = inDanger;

      // Ring pressure (2026-09-10): the local player is actually taking accumulating
      // out-of-bounds damage, not just approaching the line. Distinct, throttled alarm so it
      // reads as "you are being hurt, move now" rather than a continuous drone.
      if (this.ringDamageAudioCooldownTicks > 0) this.ringDamageAudioCooldownTicks -= 1;
      if (localSnap.inRingDanger && this.ringDamageAudioCooldownTicks <= 0) {
        this.audio.playRingDamage(true);
        this.ringDamageAudioCooldownTicks = 18; // ~0.3s at 60tps: audible as a pulse, not a drone
      }
    }

    // Blast-zone shrink: local 2-human matches (this class) previously
    // never told the Renderer about the live/shrinking rect at all, so
    // it always drew the arena's original, never-shrinking footprint --
    // the arena-shrink sim logic ran correctly underneath but nothing
    // ever became visible. aliveCount comes from the snapshots already
    // built above rather than a new Sim method, since the sim's own
    // aliveCount() is private and this is exactly the count it would
    // return.
    const aliveCount = this.currSnapshots.filter((s) => !s.eliminated).length;
    const blastRect = this.sim.getCurrentBlastRect();

    const frame: RenderFrame = {
      fighters,
      characters: this.characters,
      items,
      hazards,
      tick: this.sim.getTick(),
      hash: this.currentHash(),
      hitEffects,
      eliminationEffects,
      crownSlot: this.sim.getCrownHolder(),
      liveArenaBounds: currentArenaBounds(blastRect),
      previewArenaBounds: previewArenaBounds(
        this.sim.getArena(),
        this.sim.getTick(),
        aliveCount,
        this.numFighters,
        this.sim.getMatchSettings(),
      ),
      names: this.names,
      // The local player's own fighter, or absent once their seat is
      // frozen — same contract as NetMatch's render(): the renderer uses
      // this for the "this is you" pointer and hit-shake attenuation, and
      // both must stop pointing at a seat that is no longer being played
      // (that pointer sticking to an eliminated fighter is one of the
      // visual symptoms the spectate lifecycle fixes).
      localPlayerIndex: this.currentLocalSlot() ?? undefined,
    };
    this.renderer.render(this.events.transformFrame ? this.events.transformFrame(frame) : frame);
  }

  /** The seat this harness is still playing, or null once frozen/
   * spectating. Read by the render frame and available to the app layer. */
  currentLocalSlot(): number | null {
    if (this.session.isSpectating) return null;
    for (const slot of this.localSeats) {
      if (!this.session.isSeatFrozen(slot)) return slot;
    }
    return null;
  }

  currentSnapshots(): readonly FighterSnapshot[] {
    return this.currSnapshots;
  }

  /** True once tick() has fired onMatchOver -- see NetMatch.isOver() for
   * why the hud tick loop in main.ts must check this instead of relying
   * on a "has it started" flag that never reverts. */
  isOver(): boolean {
    return this.over;
  }

  /** Per-slot display names, parallel to NetMatch.displayNames() -- bot
   * seats get botName(slot) (see the constructor), human seats are ''
   * (no local lobby name entry yet). Callers should go through nameFor()
   * for the '#N' fallback rather than indexing this directly. */
  displayNames(): readonly string[] {
    return this.names;
  }

  /** A slot's display name, or its slot label ('#N', 1-based) if that
   * seat has none -- the same fallback rule as NetMatch.nameFor(), kept
   * in one place per side. */
  nameFor(slot: number): string {
    const n = this.names[slot];
    return n && n.length > 0 ? n : `#${slot + 1}`;
  }

  /** This match's resolved settings, for the Timed Brawl clock/end screen
   * gating in main.ts (see isTimedBrawl in timed-brawl.ts). */
  getMatchSettings(): MatchSettings {
    return this.sim.getMatchSettings();
  }

  /** Sim ticks elapsed, for formatClock/ticksRemaining in timed-brawl.ts. */
  get currentTick(): number {
    return this.sim.getTick();
  }

  private currentHash(): string {
    this.sim.saveState(this.hashBuf);
    return hashStateBuffer(this.hashBuf);
  }
}
