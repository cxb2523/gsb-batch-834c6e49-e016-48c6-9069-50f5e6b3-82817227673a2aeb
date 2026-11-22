/**
 * The video source a decision was made in.
 * - `main`: the decision was made while the main video was playing.
 * - `segment`: the decision was made while a branch segment was playing.
 */
export type DecisionSource = 'main' | 'segment';

/**
 * Describes the playback context that is active when an interaction is answered.
 */
export type DecisionSourceContext = {
  source: DecisionSource;
  segmentUrl?: string;
};

export type DecisionMetadata = {
  interactionType?: string;
  /** Playback source that was active when the decision was made. */
  source?: DecisionSource;
  /** Active branch segment URL, when the decision belongs to a segment. */
  segmentUrl?: string;
  /** Segment selected by a `choice-video-segment-change` interaction. */
  selectedSegment?: string;
  /** Time (in seconds) of the cue that produced the decision. */
  cueTime?: number;
  /** True when the decision selected a branch segment. */
  branch?: boolean;
  //eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

export type Decision = {
  cueId: string;
  choice: string;
  timestamp: number;
  /** Playback source that was active when the decision was made. */
  source?: DecisionSource;
  /** Target branch segment URL, if this decision selected one. */
  segmentUrl?: string;
  metadata?: DecisionMetadata;
};

export interface DecisionAdapter {
  saveDecision(decision: Decision): Promise<void>;
  getDecisionHistory(): Promise<Decision[]>;
  clearDecisionHistory(): Promise<void>;
}
