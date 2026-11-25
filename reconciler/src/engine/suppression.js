//! Alert de-duplication and flap suppression for recurring divergences.

/**
 * Tracks divergence identities across reconciliation cycles.
 *
 * A repeated diagnosis is suppressed during a cooldown. A diagnosis that keeps
 * clearing and reappearing is treated as flapping and suppressed for a longer
 * stabilization window so a shaky source cannot page on every cycle.
 */
export class DivergenceSuppressor {
  constructor(options = {}) {
    this.cooldownMs = options.cooldownMs ?? 5 * 60_000;
    this.flapWindowMs = options.flapWindowMs ?? 30 * 60_000;
    this.flapThreshold = options.flapThreshold ?? 3;
    this.now = options.now ?? (() => Date.now());
    this.state = new Map();
  }

  observe(key, present, metadata = {}) {
    const at = this.now();
    let entry = this.state.get(key);
    if (!entry) {
      entry = {
        active: false,
        firstSeenAt: null,
        lastSeenAt: null,
        lastNotifiedAt: null,
        clears: [],
        occurrences: 0,
        flappingUntil: 0,
        metadata,
      };
      this.state.set(key, entry);
    }

    if (!present) {
      if (entry.active) entry.clears.push(at);
      entry.active = false;
      entry.lastSeenAt = at;
      entry.clears = entry.clears.filter((time) => at - time <= this.flapWindowMs);
      return {
        suppressed: false,
        reason: null,
        occurrences: entry.occurrences,
        cleared: true,
      };
    }

    const wasInactive = !entry.active;
    entry.active = true;
    entry.lastSeenAt = at;
    entry.occurrences += 1;
    entry.metadata = metadata;
    if (wasInactive) {
      if (entry.firstSeenAt === null) entry.firstSeenAt = at;
      const recentClears = entry.clears.filter((time) => at - time <= this.flapWindowMs);
      if (recentClears.length >= this.flapThreshold) {
        entry.flappingUntil = Math.max(entry.flappingUntil, at + this.flapWindowMs);
      }
    }

    if (at < entry.flappingUntil) {
      return {
        suppressed: true,
        reason: "flapping",
        occurrences: entry.occurrences,
        suppressedUntil: new Date(entry.flappingUntil).toISOString(),
      };
    }

    if (entry.lastNotifiedAt !== null && at - entry.lastNotifiedAt < this.cooldownMs) {
      return {
        suppressed: true,
        reason: "cooldown",
        occurrences: entry.occurrences,
        suppressedUntil: new Date(entry.lastNotifiedAt + this.cooldownMs).toISOString(),
      };
    }

    entry.lastNotifiedAt = at;
    return {
      suppressed: false,
      reason: null,
      occurrences: entry.occurrences,
      firstSeenAt: new Date(entry.firstSeenAt).toISOString(),
    };
  }

  isActive(key) {
    return this.state.get(key)?.active === true;
  }

  clearStream(streamId) {
    const at = this.now();
    for (const entry of this.state.values()) {
      if (entry.metadata?.streamId === streamId && entry.active) {
        entry.active = false;
        entry.lastSeenAt = at;
        entry.clears.push(at);
        entry.clears = entry.clears.filter((time) => at - time <= this.flapWindowMs);
      }
    }
  }

  prune() {
    const at = this.now();
    for (const [key, entry] of this.state) {
      if (!entry.active && entry.lastSeenAt !== null && at - entry.lastSeenAt > this.flapWindowMs * 2) {
        this.state.delete(key);
      }
    }
  }
}
