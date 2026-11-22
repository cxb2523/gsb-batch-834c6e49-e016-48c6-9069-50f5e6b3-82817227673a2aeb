import { Decision } from './types';

/**
 * Resolves the cue id that identifies a decision. Supports the current
 * `cueId` field as well as the legacy nested `cue.id` shape.
 */
export function getDecisionCueId(decision: Decision): string | null {
  const direct = decision.cueId;
  if (typeof direct === 'string' && direct.length > 0) return direct;

  const legacy = (decision as { cue?: { id?: unknown } }).cue;
  if (legacy && typeof legacy.id === 'string' && legacy.id.length > 0) {
    return legacy.id;
  }

  return null;
}

/**
 * Builds a stable identity for a decision.
 *
 * A decision is identified by the cue that produced it and the playback source
 * it was made in (plus the active segment when it was made inside a branch
 * segment). This lets the history keep exactly one entry for a given choice
 * while still distinguishing a main-video decision from a decision taken
 * inside a branch segment.
 *
 * @returns The identity key, or `null` when the decision cannot be identified
 *   (no cue id), in which case no deduplication is possible.
 */
export function decisionKey(decision: Decision): string | null {
  const cueId = getDecisionCueId(decision);
  if (!cueId) return null;

  const source = decision.metadata?.source ?? decision.source ?? 'main';
  const segment = decision.metadata?.segmentUrl ?? decision.segmentUrl ?? '';
  return `${cueId}|${source}|${segment}`;
}
