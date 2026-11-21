import { describe, expect, it } from "vitest";
import type { Side, Swing } from "../protocol.ts";
import { createBot } from "./bot.ts";
import { BALL_RADIUS, BASELINE_Z, isInServiceBox } from "./court.ts";
import {
	createMatch,
	type MatchState,
	type RallyInput,
	tick,
} from "./rally.ts";
import { other } from "./scoring.ts";
import {
	handOf,
	heldBall,
	serveSetup,
	TOSS_APEX,
	TOSS_MIN_HIT,
} from "./serve.ts";
import {
	POWER_CAP,
	POWER_RALLY,
	TIMING_EARLY,
	TIMING_IDEAL,
	TIMING_LATE,
} from "./shot.ts";
import type { Ball } from "./state.ts";

const DT = 1 / 120;

const swing = (
	power: number,
	lag = 0,
	spin = 0,
	kind: Swing["kind"] = "forehand",
): Swing => ({
	kind,
	power,
	at: 0,
	lag,
	spin,
});

const input = (side: Side, s: MatchState, sw: Swing): RallyInput => ({
	side,
	swing: sw,
	time: s.time,
});

/** A `MatchState` for a test, built from a fresh match and overridden. */
function state(overrides: Partial<MatchState>): MatchState {
	return { ...createMatch("near"), ...overrides };
}

const still = (p: Ball["p"]): Ball => ({ p, v: { x: 0, y: -0.6, z: 0 } });

function until(
	s: MatchState,
	stop: (s: MatchState) => boolean,
	limit = 3000,
): MatchState {
	let current = s;
	for (let i = 0; i < limit && !stop(current); i++) {
		current = tick(current, [], DT);
	}
	if (!stop(current)) throw new Error("never happened");
	return current;
}

/** Tosses, waits for the top of the toss, and hits it. */
function serve(s: MatchState, power = 0.6, spin = 0): MatchState {
	const server = s.toHit;
	const tossed = tick(s, [input(server, s, swing(0.5))], DT);
	const top = until(tossed, (x) => x.time >= tossed.time - DT + TOSS_APEX);
	return tick(top, [input(server, top, swing(power, 0, spin))], DT);
}

/** `far` serves to `near`; returns the state once near's contact is fixed:
 * the serve has bounced in near's box and near is waiting on it. */
function awaitingReturn(): MatchState {
	const served = serve(createMatch("far"));
	return until(
		served,
		(x) => x.phase === "rally" && x.bounces === 1 && x.contact !== null,
	);
}

describe("createMatch", () => {
	it("starts waiting for the named server, ball in hand", () => {
		const s = createMatch("far");
		expect(s.phase).toBe("waiting-serve");
		expect(s.toHit).toBe("far");
		expect(s.toss).toBeNull();
		expect(s.ball.v).toEqual({ x: 0, y: 0, z: 0 });
	});
});

// Wii Tennis: one swing tosses the ball, the next one hits it.
describe("the serve", () => {
	it("tosses on the first swing and does not serve yet", () => {
		const s = createMatch("near");
		const after = tick(s, [input("near", s, swing(0.6))], DT);
		expect(after.phase).toBe("waiting-serve");
		expect(after.toss).not.toBeNull();
		expect(after.ball.v.y).toBeGreaterThan(0);
	});

	it("serves on the second swing, into the box", () => {
		const served = serve(createMatch("near"));
		expect(served.phase).toBe("serve-flight");
		expect(served.toHit).toBe("far");
		expect(served.stroke?.kind).toBe("serve");
		const landed = until(
			served,
			(x) => x.bounces > 0 || x.phase !== "serve-flight",
		);
		expect(landed.phase).toBe("rally");
		expect(isInServiceBox(landed.ball.p.x, landed.ball.p.z, "far")).toBe(true);
	});

	it("ignores a swing right after the toss — that is the toss's own tail", () => {
		const s = createMatch("near");
		const tossed = tick(s, [input("near", s, swing(0.6))], DT);
		const soon = until(tossed, (x) => x.time >= tossed.time + TOSS_MIN_HIT / 2);
		const after = tick(soon, [input("near", soon, swing(0.9))], DT);
		expect(after.phase).toBe("waiting-serve");
	});

	it("catches a toss nobody hits, without a fault", () => {
		const s = createMatch("near");
		const tossed = tick(s, [input("near", s, swing(0.6))], DT);
		const caught = until(tossed, (x) => x.toss === null);
		expect(caught.phase).toBe("waiting-serve");
		expect(caught.serveNumber).toBe(1);
		expect(caught.ball.v).toEqual({ x: 0, y: 0, z: 0 });
	});

	it("is faster struck at the top of the toss than on the way up", () => {
		const speedAt = (after: number): number => {
			const s = createMatch("near");
			const tossed = tick(s, [input("near", s, swing(0.5))], DT);
			const at = until(tossed, (x) => x.time >= tossed.time - DT + after);
			const v = tick(at, [input("near", at, swing(0.8))], DT).ball.v;
			return Math.hypot(v.x, v.y, v.z);
		};
		expect(speedAt(TOSS_APEX)).toBeGreaterThan(speedAt(TOSS_MIN_HIT + 0.02));
	});
});

describe("the return — the swing path that broke", () => {
	it("has a contact planned, in the future, once the serve bounces", () => {
		const s = awaitingReturn();
		expect(s.contact?.side).toBe("near");
		expect(s.contact?.at).toBeGreaterThan(s.time);
	});

	// The regression. A perfectly timed swing that the phone announces
	// 250ms after the fact arrives when the ball is already past the
	// contact point. It used to be judged against a *new* prediction made
	// at arrival and read as 650ms early: a whiff. Back-dated by its lag it
	// must connect exactly as a prompt one does.
	it("connects a well-timed swing that arrives late but reports its lag, exactly as a prompt one", () => {
		const s = awaitingReturn();
		const ideal = until(
			s,
			(x) => x.time >= (s.contact?.at ?? 0) + TIMING_IDEAL,
		);

		const prompt = tick(ideal, [input("near", ideal, swing(0.7))], DT);
		const late = until(ideal, (x) => x.time >= ideal.time + 0.25 - 1e-9);
		const laggy = tick(late, [input("near", late, swing(0.7, 250))], DT);

		expect(prompt.toHit).toBe("far");
		expect(laggy.toHit).toBe("far");
		const caughtUp = until(prompt, (x) => x.time >= laggy.time - 1e-9);
		expect(laggy.ball.p.x).toBeCloseTo(caughtUp.ball.p.x, 2);
		expect(laggy.ball.p.y).toBeCloseTo(caughtUp.ball.p.y, 2);
		expect(laggy.ball.p.z).toBeCloseTo(caughtUp.ball.p.z, 2);
	});

	it("holds an early swing and strikes the ball at the contact point, not where it was", () => {
		const s = awaitingReturn();
		const c = s.contact;
		if (!c) throw new Error("no contact");
		const early = until(s, (x) => x.time >= c.at - 0.15);
		const armed = tick(early, [input("near", early, swing(0.7))], DT);
		expect(armed.toHit).toBe("near");
		expect(armed.armed).not.toBeNull();

		const hit = until(armed, (x) => x.toHit === "far");
		expect(hit.stroke?.at).toBeCloseTo(c.at, 6);
		expect(hit.stroke?.from).toEqual(c.ball);
	});

	it("leaves the ball alone when the swing is outside the window", () => {
		const s = awaitingReturn();
		const c = s.contact;
		if (!c) throw new Error("no contact");
		const late = until(
			s,
			(x) => x.time >= c.at + TIMING_IDEAL + TIMING_LATE + 0.05,
		);
		const after = tick(late, [input("near", late, swing(0.9))], DT);
		const control = tick(late, [], DT);
		expect(after.toHit).toBe("near");
		expect(after.ball).toEqual(control.ball);
		expect(after.whiffs.near).toBe(late.whiffs.near + 1);
	});

	it("does not count an early practice swing as a whiff", () => {
		// The serve is still in the air: contact is most of a second away.
		const s = until(serve(createMatch("far")), (x) => x.contact !== null);
		const c = s.contact;
		if (!c) throw new Error("no contact");
		expect(c.at - s.time).toBeGreaterThan(TIMING_EARLY + 0.1);
		const after = tick(s, [input("near", s, swing(0.9))], DT);
		expect(after.whiffs.near).toBe(s.whiffs.near);
		expect(after.armed).toBeNull();
	});

	// One real swing is several peaks on the phone: backswing, swing,
	// follow-through. The hardest of them is the swing.
	it("plays the harder of two swings in the window — the backswing does not steal the shot", () => {
		const s = awaitingReturn();
		const c = s.contact;
		if (!c) throw new Error("no contact");
		const back = until(s, (x) => x.time >= c.at - 0.25);
		const a = tick(back, [input("near", back, swing(0.3))], DT);
		const fwd = until(a, (x) => x.time >= c.at - 0.05);
		const b = tick(fwd, [input("near", fwd, swing(0.9))], DT);
		const hit = until(b, (x) => x.toHit === "far");
		expect(hit.stroke?.power).toBe(0.9);
	});

	it("upgrades a hit when the real swing lands just after a weaker peak already struck", () => {
		const s = awaitingReturn();
		const c = s.contact;
		if (!c) throw new Error("no contact");
		const at = until(s, (x) => x.time >= c.at + TIMING_IDEAL);
		const weak = tick(at, [input("near", at, swing(0.3))], DT);
		expect(weak.toHit).toBe("far");
		// Not much later: lateness costs pace now, and 100ms late is a
		// slower ball than a weak one dead on time.
		const later = until(weak, (x) => x.time >= at.time + 0.05);
		const strong = tick(later, [input("near", later, swing(0.9))], DT);
		expect(strong.stroke?.power).toBe(0.9);
		expect(strong.toHit).toBe("far");
		const speed = (b: Ball) => Math.hypot(b.v.x, b.v.y, b.v.z);
		expect(speed(strong.ball)).toBeGreaterThan(speed(tick(later, [], DT).ball));
	});

	// The real swing is announced after its peak and carried over the
	// network: it happened in the window but arrives well after it.
	it("upgrades a hit from a real swing that happened in the window but arrived after it", () => {
		const s = awaitingReturn();
		const c = s.contact;
		if (!c) throw new Error("no contact");
		const at = until(s, (x) => x.time >= c.at);
		const weak = tick(at, [input("near", at, swing(0.3))], DT);
		const later = until(weak, (x) => x.time >= c.at + TIMING_LATE + 0.08);
		// Swung 0.15s after contact, arriving 0.28s after it.
		const lag = (later.time - (c.at + 0.15)) * 1000;
		const strong = tick(later, [input("near", later, swing(0.9, lag))], DT);
		expect(strong.stroke?.power).toBe(0.9);
	});

	it("does not let a weaker follow-through undo a hit", () => {
		const s = awaitingReturn();
		const c = s.contact;
		if (!c) throw new Error("no contact");
		const at = until(s, (x) => x.time >= c.at + TIMING_IDEAL);
		const hit = tick(at, [input("near", at, swing(0.8))], DT);
		const later = until(hit, (x) => x.time >= at.time + 0.1);
		const after = tick(later, [input("near", later, swing(0.4))], DT);
		expect(after.ball).toEqual(tick(later, [], DT).ball);
	});
});

// The player is still set up by where the ball is — they turn for it
// before they swing — but what they swing is what the ball does.
describe("the stance is where the ball is", () => {
	const incoming = (x: number): MatchState =>
		tick(
			state({
				phase: "rally",
				toHit: "near",
				ball: { p: { x, y: 1.4, z: -3 }, v: { x: 0, y: 2, z: 14 } },
			}),
			[],
			DT,
		);

	it("sets up for a ball on the near player's right (+x) as a forehand", () => {
		expect(incoming(2.5).contact?.stroke).toBe("forehand");
	});

	it("sets up for a ball on their left as a backhand", () => {
		expect(incoming(-2.5).contact?.stroke).toBe("backhand");
	});
});

/** A high ball dropping in front of the near player, as a smash chance. */
function highBall(): MatchState {
	return until(
		tick(
			state({
				phase: "rally",
				toHit: "near",
				ball: { p: { x: 0, y: 4, z: -1 }, v: { x: 0, y: 1, z: 7 } },
				players: {
					near: { side: "near", x: 0, z: 6 },
					far: { side: "far", x: 0, z: -BASELINE_Z },
				},
			}),
			[],
			DT,
		),
		(x) => x.contact !== null,
	);
}

describe("the stroke you play is where the ball goes", () => {
	/** Swings `kind` on time at the contact `s` is waiting on, and flies the
	 * shot to its bounce. */
	function play(s: MatchState, kind: Swing["kind"]) {
		const c = s.contact;
		if (!c) throw new Error("no contact");
		const on = until(s, (x) => x.time >= c.at + TIMING_IDEAL);
		const hit = tick(on, [input("near", on, swing(0.7, 0, 0, kind))], DT);
		return { on, hit };
	}
	const bounce = (s: MatchState) =>
		until(s, (x) => x.bounces === 1 || x.phase === "point-over").ball.p;

	it("sends a backhand to the hitter's right, whichever side the ball came to", () => {
		for (const kind of ["forehand", "backhand"] as const) {
			const { hit } = play(awaitingReturn(), kind);
			expect(hit.toHit).toBe("far");
			expect(hit.stroke?.kind).toBe(kind);
			// The near player faces -z: their right is +x.
			const x = bounce(hit).x;
			if (kind === "backhand") expect(x).toBeGreaterThan(0.5);
			else expect(x).toBeLessThan(-0.5);
		}
	});

	it("gets nothing from an overhead at a ball that has already bounced", () => {
		const { on, hit } = play(awaitingReturn(), "overhead");
		expect(hit.toHit).toBe("near");
		expect(hit.whiffs.near).toBe(on.whiffs.near + 1);
	});

	it("smashes a high ball taken out of the air", () => {
		const s = highBall();
		expect(s.contact?.air).toBe(true);
		const { hit } = play(s, "overhead");
		expect(hit.toHit).toBe("far");
		expect(hit.stroke?.kind).toBe("overhead");
		const v = hit.ball.v;
		expect(Math.hypot(v.x, v.y, v.z)).toBeGreaterThan(20);
	});

	it("volleys the same high ball with a groundstroke, more slowly", () => {
		const { hit } = play(highBall(), "backhand");
		expect(hit.toHit).toBe("far");
		expect(hit.stroke?.kind).toBe("backhand");
		const v = hit.ball.v;
		expect(Math.hypot(v.x, v.y, v.z)).toBeLessThan(20);
	});
});

describe("split screen: each player's own screen", () => {
	/** `near` serves to `far`, far returns a forehand on time, and the
	 * return is flown to its bounce. */
	function farForehand(split: boolean) {
		const served = serve(createMatch("near", split));
		const s = until(
			served,
			(x) => x.phase === "rally" && x.bounces === 1 && x.contact !== null,
		);
		const c = s.contact;
		if (!c) throw new Error("no contact");
		const on = until(s, (x) => x.time >= c.at + TIMING_IDEAL);
		const hit = tick(on, [input("far", on, swing(0.7))], DT);
		expect(hit.toHit).toBe("near");
		return until(hit, (x) => x.bounces === 1 || x.phase === "point-over").ball
			.p;
	}

	// One shared screen: forehand is the screen's left, -x, from either end.
	it("sends the far forehand to -x when both players share one view", () => {
		expect(farForehand(false).x).toBeLessThan(-0.5);
	});

	// Split: the far player watches from behind their own baseline, where
	// the screen's left is +x. Their forehand must still go left on THEIR
	// screen, or the stroke they swing sends the ball the other way.
	it("sends the far forehand to +x when each player has their own view", () => {
		expect(createMatch("near", true).split).toBe(true);
		expect(farForehand(true).x).toBeGreaterThan(0.5);
	});
});

describe("reach", () => {
	it("whiffs when the player cannot get to the ball in time", () => {
		const s = tick(
			state({
				phase: "rally",
				toHit: "near",
				bounces: 1,
				ball: { p: { x: 4, y: 1, z: 9 }, v: { x: 0, y: 0, z: 12 } },
				players: {
					near: { side: "near", x: -4.5, z: BASELINE_Z },
					far: { side: "far", x: 0, z: -BASELINE_Z },
				},
			}),
			[],
			DT,
		);
		const c = s.contact;
		if (!c) throw new Error("no contact");
		const at = until(s, (x) => x.time >= c.at + TIMING_IDEAL);
		const after = tick(at, [input("near", at, swing(0.8))], DT);
		expect(after.toHit).toBe("near");
	});
});

describe("terminal conditions", () => {
	it("awards the point to the receiver when the hitter's shot lands out", () => {
		const s = state({
			phase: "rally",
			toHit: "far",
			bounces: 0,
			ball: still({ x: 10, y: BALL_RADIUS + 0.005, z: -5 }),
		});
		const next = tick(s, [], DT);
		expect(next.phase).toBe("point-over");
		expect(next.score.points.far).toBe(15);
		expect(next.lastPoint).toBe("far");
	});

	it("awards the point to the hitter when the receiver lets it bounce twice", () => {
		const s = state({
			phase: "rally",
			toHit: "far",
			bounces: 1,
			ball: still({ x: 0, y: BALL_RADIUS + 0.005, z: -5 }),
		});
		const next = tick(s, [], DT);
		expect(next.phase).toBe("point-over");
		expect(next.score.points.near).toBe(15);
	});

	it("awards the point to the receiver when the hitter puts it in the net", () => {
		const s = state({
			phase: "rally",
			toHit: "far",
			bounces: 0,
			ball: { p: { x: 0, y: 0.4, z: 0.2 }, v: { x: 0, y: 0, z: -30 } },
		});
		const next = tick(s, [], DT);
		expect(next.phase).toBe("point-over");
		expect(next.score.points.far).toBe(15);
	});

	it("an unreturned serve is the server's point", () => {
		const served = serve(createMatch("near"));
		const over = until(served, (x) => x.phase === "point-over");
		expect(over.score.points.near).toBe(15);
	});
});

describe("serve faults", () => {
	const serving = (ball: Ball, serveNumber: 1 | 2 = 1): MatchState =>
		state({ phase: "serve-flight", toHit: "far", ball, serveNumber });

	it("a serve past the service line is a fault, not a lost point", () => {
		const next = tick(
			serving(still({ x: 0, y: BALL_RADIUS + 0.005, z: -8 })),
			[],
			DT,
		);
		expect(next.phase).toBe("waiting-serve");
		expect(next.serveNumber).toBe(2);
		expect(next.toHit).toBe("near");
		expect(next.score.points).toEqual({ near: 0, far: 0 });
	});

	it("a serve into the net is a fault", () => {
		const next = tick(
			serving({ p: { x: 0, y: 0.4, z: 0.2 }, v: { x: 0, y: 0, z: -30 } }),
			[],
			DT,
		);
		expect(next.phase).toBe("waiting-serve");
		expect(next.serveNumber).toBe(2);
	});

	it("a second fault is a double fault", () => {
		const next = tick(
			serving(still({ x: 0, y: BALL_RADIUS + 0.005, z: -8 }), 2),
			[],
			DT,
		);
		expect(next.phase).toBe("point-over");
		expect(next.score.points.far).toBe(15);
	});
});

describe("serving positions", () => {
	it("serves from the deuce court on the first point and the ad court on the second", () => {
		const first = createMatch("near");
		// The near player faces -z: their right, the deuce court, is +x.
		expect(first.players.near.x).toBeGreaterThan(0);
		const served = serve(first);
		const next = tick(
			until(served, (x) => x.phase === "point-over"),
			[],
			DT,
		);
		expect(next.players.near.x).toBeLessThan(0);
	});
});

describe("serve rotation through tick", () => {
	/** Ends a point with `winner`: an unreturned ball on the ground out of
	 * the receiver's reach, one tick short of a second bounce. */
	function pointTo(prev: MatchState, winner: Side): MatchState {
		const loser = winner === "near" ? "far" : "near";
		const s = until(prev, (x) => x.phase === "waiting-serve");
		const ending = tick(
			{
				...s,
				phase: "rally",
				toHit: loser,
				bounces: 1,
				ball: still({ x: 12, y: BALL_RADIUS + 0.005, z: -5 }),
			},
			[],
			DT,
		);
		expect(ending.phase).toBe("point-over");
		expect(ending.lastPoint).toBe(winner);
		return tick(ending, [], DT); // the point-over → next serve transition
	}

	/** The server's stance for the point just set up, against `serveSetup`. */
	function expectServerInPlace(s: MatchState) {
		const setup = serveSetup(s.score);
		expect(s.toHit).toBe(setup.serverSide);
		expect(s.players[s.toHit]).toEqual({
			side: s.toHit,
			...setup.server,
		});
		expect(s.players[s.toHit === "near" ? "far" : "near"]).toEqual({
			side: s.toHit === "near" ? "far" : "near",
			...setup.receiver,
		});
		expect(s.ball).toEqual(heldBall(handOf(s.toHit, s.players[s.toHit])));
		expect(s.players[s.toHit].z).toBe(
			s.toHit === "near" ? BASELINE_Z + 0.3 : -BASELINE_Z - 0.3,
		);
	}

	it("changes the server after every two points, through the real transition", () => {
		let s = createMatch("near");
		expect(s.toHit).toBe("near"); // point 1
		expectServerInPlace(s);

		s = pointTo(s, "near"); // played point 1; point 2 is still near's
		expect(s.toHit).toBe("near");
		expectServerInPlace(s);

		s = pointTo(s, "far"); // played point 2; point 3 is far's
		expect(s.toHit).toBe("far");
		expectServerInPlace(s);

		s = pointTo(s, "near"); // played point 3; point 4 is still far's
		expect(s.toHit).toBe("far");
		expectServerInPlace(s);

		s = pointTo(s, "far"); // played point 4; point 5 is near's
		expect(s.toHit).toBe("near");
		expectServerInPlace(s);
	});

	it("alternates the serve stance left and right across the change of server", () => {
		let s = createMatch("near");
		const xs: number[] = [s.players.near.x];
		s = pointTo(s, "near"); // point 2: still near, ad court
		xs.push(s.players.near.x);
		s = pointTo(s, "near"); // point 3: far serves from far's deuce court
		xs.push(s.players.far.x);
		expect(Math.sign(xs[0] ?? 0)).toBe(1); // near faces -z: deuce is +x
		expect(Math.sign(xs[1] ?? 0)).toBe(-1); // second point, ad court
		expect(Math.sign(xs[2] ?? 0)).toBe(-1); // far faces +z: deuce is -x
	});

	it("keeps the same server on a second serve after a first-serve fault", () => {
		const s = createMatch("near");
		const server = s.toHit;
		const faulted = tick(
			{
				...s,
				phase: "serve-flight",
				toHit: "far",
				ball: still({ x: 0, y: BALL_RADIUS + 0.005, z: -8 }),
			},
			[],
			DT,
		);
		expect(faulted.phase).toBe("waiting-serve");
		expect(faulted.serveNumber).toBe(2);
		expect(faulted.score.points).toEqual({ near: 0, far: 0 });
		expect(faulted.score.pointsPlayed).toBe(0);
		expect(faulted.toHit).toBe(server);
		expectServerInPlace(faulted);
		// The stance is still the first point's (deuce court), and while no
		// point has been awarded the rotation has not moved.
		expect(faulted.players[server]).toEqual({
			side: server,
			...serveSetup(s.score).server,
		});
	});

	it("resets the serve number at the next point after the faulted second serve", () => {
		// Get to point 2 — the last point of a pair, so a fault that wrongly
		// counted as a completed point would flip the server and be caught.
		const s = pointTo(createMatch("near"), "near");
		expect(s.toHit).toBe("near");
		expect(s.score.pointsPlayed).toBe(1);
		const server = s.toHit;
		const fault = (prev: MatchState) =>
			tick(
				{
					...prev,
					phase: "serve-flight",
					toHit: other(prev.toHit),
					ball: still({ x: 0, y: BALL_RADIUS + 0.005, z: -8 }),
				},
				[],
				DT,
			);
		const second = fault(s); // 1st fault
		expect(second.serveNumber).toBe(2);
		expect(second.toHit).toBe(server);
		expect(second.score.pointsPlayed).toBe(1);
		const over = fault(second); // double fault, point to the receiver
		expect(over.phase).toBe("point-over");
		expect(over.score.pointsPlayed).toBe(2);
		const next = tick(over, [], DT);
		expect(next.serveNumber).toBe(1);
		expect(next.score.pointsPlayed).toBe(2);
		// Two points played: the rotation has now moved to far.
		expect(next.toHit).toBe(other(server));
	});

	it("freezes the serve on a set already won — no rotation, no swap", () => {
		const s = state({
			phase: "point-over",
			score: { ...createMatch("near").score, setWinner: "near" },
		});
		expect(tick(s, [], DT)).toEqual(s);
		expect(tick(s, [input("near", s, swing(1))], DT)).toEqual(s);
	});
});

describe("spin", () => {
	it("carries the spin of the shot in flight, and clears it on a new point", () => {
		const served = serve(createMatch("near"), 0.5, 0.75);
		expect(served.spin).toBeCloseTo(0.75, 6);
		expect(createMatch("near").spin).toBe(0);
	});

	it("puts more arc on topspin than slice, for the same target", () => {
		const apex = (spin: number): number => {
			let s = serve(createMatch("near"), 0.5, spin);
			let top = s.ball.p.y;
			while (s.phase === "serve-flight") {
				s = tick(s, [], DT);
				top = Math.max(top, s.ball.p.y);
			}
			return top;
		};
		expect(apex(1)).toBeGreaterThan(apex(-1));
	});
});

describe("match over", () => {
	it("freezes once the set has a winner: tick is a no-op", () => {
		const s = state({
			phase: "point-over",
			score: { ...createMatch("near").score, setWinner: "near" },
		});
		expect(tick(s, [input("near", s, swing(1))], DT)).toEqual(s);
	});
});

describe("a full set between two bots, replayed", () => {
	/**
	 * The regression net under every feel constant: the whole machine —
	 * toss, serve, contact planning, arming, rewinds, movement, scoring —
	 * driven by two deterministic bots. Same inputs, same set, every time.
	 */
	function playSet(): { final: MatchState; hits: number; points: number } {
		const near = createBot("near", 0.85);
		const far = createBot("far", 0.6);
		let s = createMatch("near");
		let hits = 0;
		let points = 0;
		for (let i = 0; i < 400_000; i++) {
			if (s.score.setWinner) return { final: s, hits, points };
			const inputs: RallyInput[] = [];
			const a = near.swing(s);
			if (a) inputs.push(input("near", s, a));
			const b = far.swing(s);
			if (b) inputs.push(input("far", s, b));
			const next = tick(s, inputs, DT);
			if (next.stroke !== s.stroke && next.stroke) hits++;
			if (next.score !== s.score) points++;
			s = next;
		}
		throw new Error("the set never finished");
	}

	it("finishes, and the better bot wins it", () => {
		const { final } = playSet();
		expect(final.score.setWinner).toBe("near");
	});

	it("has real rallies, not one shot per point", () => {
		const { hits, points } = playSet();
		expect(hits / points).toBeGreaterThan(3);
	});

	it("is the same run twice", () => {
		expect(JSON.stringify(playSet().final)).toBe(
			JSON.stringify(playSet().final),
		);
	});
});

describe("power shots are earned", () => {
	/** `near` returns the serve (or the ball in `from`) with a `kind` of
	 * `power`, swung `offset` seconds off the ideal moment — back-dated by
	 * `lag`, so early and late are exact. */
	function returnAt(
		offset: number,
		power: number,
		from = awaitingReturn(),
		kind: Swing["kind"] = "forehand",
	) {
		const c = from.contact;
		if (!c) throw new Error("no contact");
		const at = c.at + TIMING_IDEAL + offset;
		const now = until(from, (x) => x.time >= Math.max(at, c.at) + DT);
		const lag = (now.time - at) * 1000;
		return tick(now, [input("near", now, swing(power, lag, 0, kind))], DT);
	}
	const speed = (s: MatchState) =>
		Math.hypot(s.ball.v.x, s.ball.v.y, s.ball.v.z);

	it("counts the strokes of a point, and starts again at the next", () => {
		const served = serve(createMatch("far"));
		expect(served.rally).toBe(1);
		const returned = returnAt(0, 0.6);
		expect(returned.rally).toBe(2);
		const next = until(returned, (x) => x.phase === "point-over");
		expect(tick(next, [], DT).rally).toBe(0);
	});

	it("plays a hard swing that has not earned it as a capped one", () => {
		const hard = returnAt(-0.09, 1);
		expect(hard.stroke?.powerShot).toBe(false);
		const capped = returnAt(-0.09, POWER_CAP);
		expect(speed(hard)).toBeCloseTo(speed(capped), 6);
	});

	it("plays an overhead that has not earned it as a capped one too", () => {
		const overhead = (power: number) =>
			returnAt(-0.09, power, highBall(), "overhead");
		expect(overhead(1).stroke?.kind).toBe("overhead");
		expect(overhead(1).stroke?.powerShot).toBe(false);
		expect(speed(overhead(1))).toBeCloseTo(speed(overhead(POWER_CAP)), 6);
	});

	it("gives a perfectly timed hard swing its full power", () => {
		const perfect = returnAt(0, 1);
		expect(perfect.stroke?.powerShot).toBe(true);
		expect(speed(perfect)).toBeGreaterThan(speed(returnAt(0, POWER_CAP)) + 3);
	});

	it("gives every hard swing its full power once the rally is long", () => {
		const long = { ...awaitingReturn(), rally: POWER_RALLY };
		expect(returnAt(-0.09, 1, long).stroke?.powerShot).toBe(true);
	});
});
