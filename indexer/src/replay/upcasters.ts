import { ALL_CONTRACT_EVENT_NAMES } from "../generated/events.js";
import type { EventValue } from "../types.js";

export type EventData = Record<string, EventValue>;

/**
 * Schema versions are wire versions of an event's `data` payload. They are
 * deliberately *not* the registry fingerprint: the registry describes the
 * current contract surface, while a journal can still hold rows written by any
 * earlier contract version.
 *
 * `0` is the pre-registry shape (#213): events emitted before the canonical
 * registry existed used shorter field names (`amount`, `total`, `start`). Every
 * registered event is at version 1 today; a future contract change appends a
 * `v1 -> v2` step here rather than editing v1.
 */
export const LEGACY_EVENT_SCHEMA_VERSION = 0;
export const CURRENT_EVENT_SCHEMA_VERSION = 1;

/** A journal row cannot have a negative version, and future versions are unreadable. */
export class UnknownEventSchemaError extends Error {
  constructor(readonly eventName: string, readonly version: number) {
    super(`event ${eventName} has no schema version ${version} (known: ${LEGACY_EVENT_SCHEMA_VERSION}..${CURRENT_EVENT_SCHEMA_VERSION})`);
    this.name = "UnknownEventSchemaError";
  }
}

/** Fail-closed: a version gap is never silently projected as-is. */
export class MissingUpcasterError extends Error {
  constructor(readonly eventName: string, readonly from: number) {
    super(`no upcaster registered for ${eventName} v${from} -> v${from + 1}`);
    this.name = "MissingUpcasterError";
  }
}

/** A journal row claiming a version newer than this tree understands. */
export class FutureSchemaVersionError extends Error {
  constructor(readonly eventName: string, readonly version: number, readonly current: number) {
    super(`event ${eventName} is at schema v${version}, newer than supported v${current}`);
    this.name = "FutureSchemaVersionError";
  }
}

export class InvalidUpcasterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidUpcasterError";
  }
}

/**
 * One step of a per-event chain. `to` is always `from + 1`: a chain is a
 * total function on consecutive versions, never a skip, so a payload can only
 * reach the current version by crossing every intermediate one.
 */
export interface UpcasterStep {
  from: number;
  to: number;
  upcast: (data: EventData) => EventData;
}

export interface UpcastResult {
  version: number;
  data: EventData;
}

export interface UpcasterRegistryOptions {
  /** Events the schema registry knows; registration of anything else is a bug. */
  knownEvents?: readonly string[];
  /** Version a projection expects for a given event. */
  currentVersion?: (eventName: string) => number;
}

/**
 * Chains of upcasters, keyed by registry event key. Registration happens next
 * to the schema registry (`schemas/events/registry.json`): a chain may only be
 * registered for an event the registry declares, and the default registry is
 * asserted against `ALL_CONTRACT_EVENT_NAMES` at module load, so a renamed or
 * removed event breaks typecheck/tests instead of silently leaving stale rows
 * unreadable.
 */
export class UpcasterRegistry {
  private readonly chains = new Map<string, Map<number, UpcasterStep>>();
  private readonly knownEvents: ReadonlySet<string>;
  private readonly currentVersionFor: (eventName: string) => number;

  constructor(options: UpcasterRegistryOptions = {}) {
    this.knownEvents = new Set(options.knownEvents ?? ALL_CONTRACT_EVENT_NAMES);
    this.currentVersionFor = options.currentVersion ?? (() => CURRENT_EVENT_SCHEMA_VERSION);
  }

  /** Registers one `from -> from + 1` step. Registering the same step twice is a bug. */
  register(eventName: string, step: UpcasterStep): this {
    if (!this.knownEvents.has(eventName)) {
      throw new InvalidUpcasterError(`upcaster registered for unknown event ${eventName}`);
    }
    if (!Number.isInteger(step.from) || step.from < LEGACY_EVENT_SCHEMA_VERSION) {
      throw new InvalidUpcasterError(`upcaster for ${eventName} has invalid source version ${step.from}`);
    }
    if (step.to !== step.from + 1) {
      throw new InvalidUpcasterError(`upcaster for ${eventName} must advance exactly one version (got v${step.from} -> v${step.to})`);
    }
    const chain = this.chains.get(eventName) ?? new Map<number, UpcasterStep>();
    if (chain.has(step.from)) {
      throw new InvalidUpcasterError(`duplicate upcaster for ${eventName} v${step.from}`);
    }
    chain.set(step.from, step);
    this.chains.set(eventName, chain);
    return this;
  }

  currentVersion(eventName: string): number {
    return this.currentVersionFor(eventName);
  }

  /** The registered steps between `from` and the current version, in order. */
  chain(eventName: string, from: number): UpcasterStep[] {
    const current = this.currentVersion(eventName);
    if (!Number.isInteger(from) || from < LEGACY_EVENT_SCHEMA_VERSION) {
      throw new UnknownEventSchemaError(eventName, from);
    }
    if (from > current) {
      throw new FutureSchemaVersionError(eventName, from, current);
    }
    const registered = this.chains.get(eventName);
    const steps: UpcasterStep[] = [];
    for (let version = from; version < current; version++) {
      const step = registered?.get(version);
      if (!step) throw new MissingUpcasterError(eventName, version);
      steps.push(step);
    }
    return steps;
  }

  /**
   * Applies the chain to one payload. A payload already at the current version
   * is returned untouched (same reference), which keeps the no-op path free and
   * makes "upcast is identity at the current version" testable.
   */
  upcast(eventName: string, version: number, data: EventData): UpcastResult {
    const steps = this.chain(eventName, version);
    let current = data;
    let currentVersion = version;
    for (const step of steps) {
      current = step.upcast(current);
      currentVersion = step.to;
    }
    return { version: currentVersion, data: current };
  }

  /** Event keys that have at least one registered step, sorted for stable output. */
  eventsWithUpcasters(): string[] {
    return [...this.chains.keys()].sort();
  }

  /** Every registered step, as `[eventName, from, to]`, sorted deterministically. */
  describe(): Array<{ eventName: string; from: number; to: number }> {
    return this.eventsWithUpcasters().flatMap((eventName) =>
      [...this.chains.get(eventName)!.values()]
        .sort((a, b) => a.from - b.from)
        .map((step) => ({ eventName, from: step.from, to: step.to })),
    );
  }
}

/** Drops `undefined` values so an upcast cannot introduce non-JSON keys. */
function compact(data: EventData): EventData {
  const out: EventData = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Pre-registry `stream_created` carried the deposit as `amount` and the window
 * as `start`/`end`; those streams predate the opt-out flag, so they were
 * cancelable. Current payloads are left byte-for-byte untouched by `upcast`.
 */
export const streamCreatedV0ToV1: UpcasterStep = {
  from: LEGACY_EVENT_SCHEMA_VERSION,
  to: 1,
  upcast: (data) =>
    compact({
      sender: data.sender ?? null,
      recipient: data.recipient ?? null,
      token: data.token ?? null,
      deposit: data.deposit ?? data.amount ?? "0",
      start_time: data.start_time ?? data.start ?? null,
      end_time: data.end_time ?? data.end ?? null,
      cancelable: data.cancelable ?? true,
    }),
};

/** Pre-registry `withdrawn` reported the running total as `total`. */
export const withdrawnV0ToV1: UpcasterStep = {
  from: LEGACY_EVENT_SCHEMA_VERSION,
  to: 1,
  upcast: (data) =>
    compact({
      recipient: data.recipient ?? null,
      amount: data.amount ?? "0",
      withdrawn_total: data.withdrawn_total ?? data.total ?? data.amount ?? "0",
    }),
};

/** Pre-registry `stream_topped_up` reported the new deposit as `deposit`. */
export const streamToppedUpV0ToV1: UpcasterStep = {
  from: LEGACY_EVENT_SCHEMA_VERSION,
  to: 1,
  upcast: (data) =>
    compact({
      sender: data.sender ?? null,
      amount: data.amount ?? null,
      new_deposit: data.new_deposit ?? data.deposit ?? null,
    }),
};

/** The chains this tree ships with: legacy journal shapes (v0) into registry v1. */
export function createDefaultUpcasterRegistry(): UpcasterRegistry {
  return new UpcasterRegistry()
    .register("stream_created", streamCreatedV0ToV1)
    .register("withdrawn", withdrawnV0ToV1)
    .register("stream_topped_up", streamToppedUpV0ToV1);
}

export const defaultUpcasterRegistry = createDefaultUpcasterRegistry();

/**
 * Asserts every registered chain belongs to the generated registry, and that
 * no chain advances past the version the projections expect. Called at module
 * load so a drift between the two registries fails loudly and early.
 */
export function assertUpcastersMatchSchemaRegistry(registry: UpcasterRegistry = defaultUpcasterRegistry): void {
  const known = new Set<string>(ALL_CONTRACT_EVENT_NAMES);
  for (const { eventName, from, to } of registry.describe()) {
    if (!known.has(eventName)) {
      throw new InvalidUpcasterError(`upcaster chain targets unknown event ${eventName}`);
    }
    if (to > registry.currentVersion(eventName)) {
      throw new InvalidUpcasterError(`upcaster chain for ${eventName} advances to v${to}, past current v${registry.currentVersion(eventName)}`);
    }
    if (from < LEGACY_EVENT_SCHEMA_VERSION) {
      throw new InvalidUpcasterError(`upcaster chain for ${eventName} starts below v${LEGACY_EVENT_SCHEMA_VERSION}`);
    }
  }
}

assertUpcastersMatchSchemaRegistry();
