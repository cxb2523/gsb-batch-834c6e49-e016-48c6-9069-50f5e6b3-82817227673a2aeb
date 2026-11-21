/**
 * Pure scoring. Implements `llm-knowledge/reference/tennis-scoring.md` — that
 * note is the specification; this file does not re-derive the rules, only
 * encodes them. No ball, no geometry, no timing here: `awardPoint` only ever
 * needs to know who won the point.
 *
 * The points ladder carries its own state: deuce is both sides at `40`,
 * advantage is one side at `"AD"` with the other still at `40`. That is
 * enough to drive the game state machine without a hidden raw point count.
 */

import type { Side } from "../protocol.ts";

export type PointValue = 0 | 15 | 30 | 40 | "AD";

export interface TiebreakState {
	readonly points: Readonly<Record<Side, number>>;
	/** Who served the tiebreak's first point — the rotation is computed from this. */
	readonly firstServer: Side;
}

export interface Score {
	readonly points: Readonly<Record<Side, PointValue>>;
	readonly games: Readonly<Record<Side, number>>;
	/** Who serves the next point. Derived by `awardPoint` — for a normal
	 * point from the two-point rotation (`servingSide`), during a tiebreak
	 * from the tiebreak's own rotation. */
	readonly server: Side;
	readonly tiebreak: TiebreakState | null;
	readonly setWinner: Side | null;
	/** Points completed in the set, tiebreak points included. The serve
	 * rotation is computed from this, so it is state, not presentation. */
	readonly pointsPlayed: number;
	/** Who served the set's first point. The rotation is relative to it. */
	readonly firstServer: Side;
}

export function initialScore(server: Side): Score {
	return {
		points: { near: 0, far: 0 },
		games: { near: 0, far: 0 },
		server,
		tiebreak: null,
		setWinner: null,
		pointsPlayed: 0,
		firstServer: server,
	};
}

/**
 * Who serves the point after `pointsPlayed` points: **the serve changes
 * after every second point**, starting with the set's first server. So the
 * same side serves points 1–2, the other points 3–4, and so on — the
 * rotation the match uses instead of changing only at a game boundary.
 *
 * In a tiebreak the tiebreak's own rotation rules (`tiebreakServer`), and
 * `score.server` already holds its answer. Once the set has a winner the
 * last server stands: nothing is served again.
 */
export function servingSide(score: Score): Side {
	if (score.setWinner !== null) return score.server;
	if (score.tiebreak !== null) return score.server;
	return rotationServer(score);
}

/** The two-point rotation, ignoring tiebreaks and a finished set. */
function rotationServer(score: Score): Side {
	const turn = Math.floor(score.pointsPlayed / 2);
	return turn % 2 === 0 ? score.firstServer : other(score.firstServer);
}

/** The side that is not `side`. Exported for `rally.ts`, which needs "the
 * other player" as often as scoring does. */
export function other(side: Side): Side {
	return side === "near" ? "far" : "near";
}

const LADDER: readonly PointValue[] = [0, 15, 30, 40];

export function awardPoint(score: Score, winner: Side): Score {
	const loser = other(winner);
	const played: Score = {
		...(score.tiebreak
			? awardTiebreakPoint(score, winner, loser)
			: awardGamePoint(score, winner, loser)),
		pointsPlayed: score.pointsPlayed + 1,
	};
	// The server is a consequence of the new count, never a field flipped by
	// hand at a game boundary: that is what makes the second serve of a fault
	// (no point played, no awardPoint) keep the same server for free. A set
	// that just ended keeps the server it finished on, and freezes there.
	return played.setWinner !== null
		? played
		: { ...played, server: servingSide(played) };
}

function awardGamePoint(score: Score, winner: Side, loser: Side): Score {
	const w = score.points[winner];
	const l = score.points[loser];

	if (w === "AD") {
		return winGame(score, winner, loser);
	}
	if (l === "AD") {
		return {
			...score,
			points: { [winner]: 40, [loser]: 40 } as Record<Side, PointValue>,
		};
	}
	if (w === 40) {
		return l === 40
			? { ...score, points: { ...score.points, [winner]: "AD" } }
			: winGame(score, winner, loser);
	}
	const next = LADDER[LADDER.indexOf(w) + 1];
	return { ...score, points: { ...score.points, [winner]: next } };
}

function winGame(score: Score, winner: Side, loser: Side): Score {
	const games = { ...score.games, [winner]: score.games[winner] + 1 };
	// Only the tiebreak branch needs a `server` here: entering a tiebreak
	// hands the rotation to `tiebreakServer`, whose first point is served by
	// whoever the set rotation had next. Every other branch leaves `server`
	// alone — `awardPoint` derives it from `pointsPlayed`.
	const nextServer = rotationServer({
		...score,
		pointsPlayed: score.pointsPlayed + 1,
	});
	const points: Record<Side, PointValue> = { near: 0, far: 0 };

	if (games[winner] >= 6 && games[winner] - games[loser] >= 2) {
		// The set is over: the last server stands, and `servingSide` freezes
		// there. There is no next point to rotate toward.
		return {
			...score,
			points,
			games,
			tiebreak: null,
			setWinner: winner,
		};
	}
	if (games.near === 6 && games.far === 6) {
		return {
			...score,
			points,
			games,
			server: nextServer,
			tiebreak: { points: { near: 0, far: 0 }, firstServer: nextServer },
		};
	}
	return { ...score, points, games };
}

/** Who serves tiebreak point `n` (1-indexed): one point, then alternates every two. */
function tiebreakServer(firstServer: Side, n: number): Side {
	if (n === 1) return firstServer;
	const pairIndex = Math.floor((n - 2) / 2);
	return pairIndex % 2 === 0 ? other(firstServer) : firstServer;
}

function awardTiebreakPoint(score: Score, winner: Side, loser: Side): Score {
	const tb = score.tiebreak;
	if (!tb)
		throw new Error("awardTiebreakPoint called without a tiebreak in progress");

	const points = { ...tb.points, [winner]: tb.points[winner] + 1 };
	if (points[winner] >= 7 && points[winner] - points[loser] >= 2) {
		const games = { ...score.games, [winner]: score.games[winner] + 1 };
		return {
			...score,
			points: { near: 0, far: 0 },
			games,
			tiebreak: null,
			setWinner: winner,
		};
	}

	// A tiebreak is one more point on the same set count; its own rotation
	// (`servingSide`) decides who serves next.
	const played = points.near + points.far;
	return {
		...score,
		tiebreak: { points, firstServer: tb.firstServer },
		server: tiebreakServer(tb.firstServer, played + 1),
	};
}
