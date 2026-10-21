/**
 * TakeOne Brain — associative learning for suggestions.
 *
 * Based on fly-brain graded-MB research (EXP9 winner: hard cap κ=1.0).
 * The fly learns odor→reward associations via dopamine-modulated plasticity.
 * Here: context→action associations via the same principle.
 *
 * Context: simplified user situation (project type, prompt keywords, etc.)
 * Action: what to suggest (tool, workflow, next step)
 * Reward: +1 (user accepted), 0 (ignored), -1 (rejected)
 *
 * This is the distilled principle, not the full neuroscience sim.
 * The full sim continues in ~/workspace/fly-brain/ for research.
 */

class TakeOneBrain {
  constructor() {
    // weights[contextKey][actionKey] = strength (0..1, hard-capped)
    this.weights = {};
    this.KAPPA = 1.0; // hard cap (EXP9 winner)
    this.LEARNING_RATE = 0.1;
  }

  _w(ctx, act) {
    if (!this.weights[ctx]) this.weights[ctx] = {};
    if (!(act in this.weights[ctx])) this.weights[ctx][act] = 0.0;
    return this.weights[ctx][act];
  }

  _setW(ctx, act, v) {
    if (!this.weights[ctx]) this.weights[ctx] = {};
    // Hard cap: weight never exceeds KAPPA (prevents runaway)
    this.weights[ctx][act] = Math.max(0, Math.min(this.KAPPA, v));
  }

  /**
   * Learn from a user interaction.
   * @param {string} context - e.g. "prompt:cinematic", "project:history-doc"
   * @param {string} action - e.g. "suggest:sdxl-lightning", "suggest:upscaler"
   * @param {number} reward - +1 (accepted), 0 (ignored), -1 (rejected)
   */
  learn(context, action, reward) {
    const w = this._w(context, action);
    // Dopamine-modulated update: reward strengthens, punishment weakens
    // Δw = η * reward * (1 - w) for positive (diminishing returns near cap)
    // Δw = η * reward * w for negative (proportional weakening)
    let dw;
    if (reward > 0) {
      dw = this.LEARNING_RATE * reward * (1 - w);
    } else {
      dw = this.LEARNING_RATE * reward * w; // reward negative → dw negative
    }
    this._setW(context, action, w + dw);
  }

  /**
   * Suggest actions for a context, sorted by learned strength.
   * @returns {Array<{action, strength}>} top suggestions
   */
  suggest(context, topK = 3) {
    const acts = this.weights[context] || {};
    return Object.entries(acts)
      .map(([action, strength]) => ({ action, strength }))
      .filter((s) => s.strength > 0.05) // threshold: ignore weak associations
      .sort((a, b) => b.strength - a.strength)
      .slice(0, topK);
  }

  /** Export for persistence. */
  toJSON() { return { weights: this.weights, kappa: this.KAPPA }; }

  /** Import from persistence. */
  fromJSON(data) {
    if (data && data.weights) this.weights = data.weights;
    if (data && data.kappa) this.KAPPA = data.kappa;
  }
}

module.exports = { TakeOneBrain };
