import { Decision, DecisionAdapter } from './types';
import { decisionKey } from './decisionUtils';

/**
 * The InMemoryDecisionAdapter class implements the DecisionAdapter interface
 * and stores decisions in memory.
 *
 * Saving a decision that identifies the same (cue, playback source, segment)
 * pair replaces the previous entry instead of appending a duplicate, so a
 * re-answered cue leaves exactly one record in the history.
 */
export class InMemoryDecisionAdapter implements DecisionAdapter {
  private decisions: Decision[] = [];

  /**
   * Saves a decision to the in-memory store.
   * @param decision - The decision to save.
   */
  async saveDecision(decision: Decision): Promise<void> {
    const key = decisionKey(decision);
    const existingIndex = key
      ? this.decisions.findIndex((saved) => decisionKey(saved) === key)
      : -1;
    if (existingIndex >= 0) {
      this.decisions[existingIndex] = decision;
      return;
    }
    this.decisions.push(decision);
  }

  /**
   * Retrieves the decision history from the in-memory store.
   * @returns A promise that resolves to an array of decisions.
   */
  async getDecisionHistory(): Promise<Decision[]> {
    return [...this.decisions];
  }

  /**
   * Clears the decision history in the in-memory store.
   */
  async clearDecisionHistory(): Promise<void> {
    this.decisions = [];
  }
}
