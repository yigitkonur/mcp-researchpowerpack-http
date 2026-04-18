import { createClient } from 'redis';

export interface WorkflowState {
  bootstrapped: boolean;
  bootstrappedAt?: string;
  redditWarningShown: boolean;
  orientationVersion: 1;
}

export interface WorkflowStateStore {
  get(key: string): Promise<WorkflowState>;
  patch(key: string, patch: Partial<WorkflowState>): Promise<WorkflowState>;
  size?(): number;
  close?(): Promise<void>;
}

const WORKFLOW_STATE_TTL_SECONDS = 60 * 60 * 24;
const WORKFLOW_STATE_PREFIX = 'research-pack:workflow:';
const SWEEP_INTERVAL_MS = 60_000;

export function emptyWorkflowState(): WorkflowState {
  return {
    bootstrapped: false,
    redditWarningShown: false,
    orientationVersion: 1,
  };
}

interface MemoryWorkflowStateOptions {
  /** Override the wall-clock source — for tests. Defaults to Date.now. */
  readonly now?: () => number;
  /** Minimum interval between sweeps. Defaults to 60s. */
  readonly sweepIntervalMs?: number;
  /** TTL in seconds. Defaults to 24h to match the Redis store. */
  readonly ttlSeconds?: number;
}

interface MemoryEntry {
  readonly value: WorkflowState;
  updatedAt: number;
}

/**
 * In-memory workflow state with TTL eviction. Mirrors the 24h TTL the
 * Redis store gets via `EX`. Without this, every anonymous client minted
 * a key the process could never reclaim — confirmed in production where
 * health://status reported 521 sessions at 31h uptime.
 *
 * See: docs/code-review/context/04-session-and-workflow-state.md (E7).
 */
export function createMemoryWorkflowStateStore(
  opts: MemoryWorkflowStateOptions = {},
): WorkflowStateStore {
  const now = opts.now ?? (() => Date.now());
  const sweepIntervalMs = opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
  const ttlMs = (opts.ttlSeconds ?? WORKFLOW_STATE_TTL_SECONDS) * 1000;
  const states = new Map<string, MemoryEntry>();
  let lastSweepAt = 0;

  function sweep(currentTime: number): void {
    if (currentTime - lastSweepAt < sweepIntervalMs) return;
    lastSweepAt = currentTime;
    const cutoff = currentTime - ttlMs;
    for (const [key, entry] of states) {
      if (entry.updatedAt < cutoff) states.delete(key);
    }
  }

  return {
    async get(key) {
      const entry = states.get(key);
      if (!entry) return emptyWorkflowState();
      // Per-entry expiry check — sweep is throttled, so a stale entry
      // could otherwise be returned in the gap between sweeps.
      if (now() - entry.updatedAt > ttlMs) {
        states.delete(key);
        return emptyWorkflowState();
      }
      return entry.value;
    },
    async patch(key, patch) {
      const t = now();
      sweep(t);
      const prev = states.get(key);
      const baseValue = prev && t - prev.updatedAt <= ttlMs
        ? prev.value
        : emptyWorkflowState();
      const next: WorkflowState = {
        ...baseValue,
        ...patch,
        orientationVersion: 1,
      };
      states.set(key, { value: next, updatedAt: t });
      return next;
    },
    size(): number {
      return states.size;
    },
  };
}

class RedisWorkflowStateStore implements WorkflowStateStore {
  constructor(
    private readonly client: {
      get(key: string): Promise<string | null>;
      set(
        key: string,
        value: string,
        options: { EX: number },
      ): Promise<unknown>;
      quit(): Promise<unknown>;
    },
    private readonly prefix = WORKFLOW_STATE_PREFIX,
  ) {}

  async get(key: string): Promise<WorkflowState> {
    const raw = await this.client.get(this.prefix + key);
    if (!raw) {
      return emptyWorkflowState();
    }

    const parsed = JSON.parse(raw) as Partial<WorkflowState>;
    return {
      ...emptyWorkflowState(),
      ...parsed,
      orientationVersion: 1,
    };
  }

  async patch(key: string, patch: Partial<WorkflowState>): Promise<WorkflowState> {
    const next: WorkflowState = {
      ...(await this.get(key)),
      ...patch,
      orientationVersion: 1,
    };

    await this.client.set(this.prefix + key, JSON.stringify(next), {
      EX: WORKFLOW_STATE_TTL_SECONDS,
    });

    return next;
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

let workflowStateStore: WorkflowStateStore | null = null;

export async function configureWorkflowStateStore(redisUrl: string | undefined): Promise<void> {
  if (workflowStateStore) {
    return;
  }

  if (!redisUrl) {
    workflowStateStore = createMemoryWorkflowStateStore();
    return;
  }

  const client = createClient({ url: redisUrl });
  await client.connect();
  workflowStateStore = new RedisWorkflowStateStore(client);
}

export function getWorkflowStateStore(): WorkflowStateStore {
  if (!workflowStateStore) {
    throw new Error('WorkflowStateStore not configured');
  }

  return workflowStateStore;
}

export async function closeWorkflowStateStore(): Promise<void> {
  await workflowStateStore?.close?.();
  workflowStateStore = null;
}
