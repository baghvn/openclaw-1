import { getAgentRunContext } from "../infra/agent-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  countActiveDescendantRunsFromRuns,
  getSubagentRunByChildSessionKeyFromRuns,
  listDescendantRunsForRequesterFromRuns,
  listRunsForControllerFromRuns,
} from "./subagent-registry-queries.js";
import { getSubagentRunsSnapshotForRead } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isLiveUnendedSubagentRun } from "./subagent-run-liveness.js";
import {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  resolveSubagentSessionStatus,
} from "./subagent-session-metrics.js";

export {
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  resolveSubagentSessionStatus,
} from "./subagent-session-metrics.js";

/**
 * Request-scoped read indexes for subagent registry queries.
 *
 * Build one context for a bounded read operation (for example one sessions.list call)
 * and pass it through row construction. Do not cache this object globally: callers should
 * see one point-in-time registry snapshot per request, not cross-request state.
 */
export type SubagentRegistryReadContext = {
  listRunsForController(controllerSessionKey: string): SubagentRunRecord[];
  countActiveDescendantRuns(rootSessionKey: string): number;
  getSessionDisplayRunByChildSessionKey(childSessionKey: string): SubagentRunRecord | null;
};

type IndexedRun = { runId: string; entry: SubagentRunRecord };

type InMemoryDisplayCandidates = {
  latestActive: SubagentRunRecord | null;
  latestEnded: SubagentRunRecord | null;
};

function resolveControllerSessionKeyForReadContext(entry: SubagentRunRecord): string {
  return entry.controllerSessionKey?.trim() || entry.requesterSessionKey;
}

function updateLatestRunByCreatedAt(
  current: IndexedRun | undefined,
  candidate: IndexedRun,
): IndexedRun {
  if (!current || candidate.entry.createdAt > current.entry.createdAt) {
    return candidate;
  }
  return current;
}

function updateLatestDisplayRunByCreatedAt(
  current: SubagentRunRecord | null,
  candidate: SubagentRunRecord,
): SubagentRunRecord {
  if (!current || candidate.createdAt > current.createdAt) {
    return candidate;
  }
  return current;
}

export function createSubagentRegistryReadContextFromRuns(params: {
  runs: Map<string, SubagentRunRecord>;
  inMemoryRuns?: Map<string, SubagentRunRecord>;
}): SubagentRegistryReadContext {
  const runsByControllerSessionKey = new Map<string, SubagentRunRecord[]>();
  const latestRunByChildSessionKey = new Map<string, IndexedRun>();
  const latestRunsByRequesterSessionKey = new Map<string, Map<string, IndexedRun>>();
  const latestActiveDisplayRunByChildSessionKey = new Map<string, SubagentRunRecord>();
  const latestEndedDisplayRunByChildSessionKey = new Map<string, SubagentRunRecord>();

  for (const [runId, entry] of params.runs.entries()) {
    const controllerSessionKey = resolveControllerSessionKeyForReadContext(entry).trim();
    if (controllerSessionKey) {
      const runsForController = runsByControllerSessionKey.get(controllerSessionKey);
      if (runsForController) {
        runsForController.push(entry);
      } else {
        runsByControllerSessionKey.set(controllerSessionKey, [entry]);
      }
    }

    const displayChildSessionKey = entry.childSessionKey;
    const descendantChildSessionKey = entry.childSessionKey.trim();
    if (displayChildSessionKey) {
      latestRunByChildSessionKey.set(
        displayChildSessionKey,
        updateLatestRunByCreatedAt(latestRunByChildSessionKey.get(displayChildSessionKey), {
          runId,
          entry,
        }),
      );

      if (isLiveUnendedSubagentRun(entry)) {
        latestActiveDisplayRunByChildSessionKey.set(
          displayChildSessionKey,
          updateLatestDisplayRunByCreatedAt(
            latestActiveDisplayRunByChildSessionKey.get(displayChildSessionKey) ?? null,
            entry,
          ),
        );
      } else {
        latestEndedDisplayRunByChildSessionKey.set(
          displayChildSessionKey,
          updateLatestDisplayRunByCreatedAt(
            latestEndedDisplayRunByChildSessionKey.get(displayChildSessionKey) ?? null,
            entry,
          ),
        );
      }
    }

    // Preserve descendant traversal semantics from subagent-registry-queries.ts: the
    // requester key comparison is exact, while child traversal normalizes the child key.
    const requesterSessionKey = entry.requesterSessionKey;
    if (requesterSessionKey && descendantChildSessionKey) {
      let latestByChild = latestRunsByRequesterSessionKey.get(requesterSessionKey);
      if (!latestByChild) {
        latestByChild = new Map<string, IndexedRun>();
        latestRunsByRequesterSessionKey.set(requesterSessionKey, latestByChild);
      }
      latestByChild.set(
        descendantChildSessionKey,
        updateLatestRunByCreatedAt(latestByChild.get(descendantChildSessionKey), { runId, entry }),
      );
    }
  }

  const latestInMemoryDisplayCandidatesByChildSessionKey = new Map<
    string,
    InMemoryDisplayCandidates
  >();
  for (const entry of (params.inMemoryRuns ?? new Map<string, SubagentRunRecord>()).values()) {
    const childSessionKey = entry.childSessionKey;
    if (!childSessionKey) {
      continue;
    }
    const candidates = latestInMemoryDisplayCandidatesByChildSessionKey.get(childSessionKey) ?? {
      latestActive: null,
      latestEnded: null,
    };
    if (typeof entry.endedAt === "number") {
      candidates.latestEnded = updateLatestDisplayRunByCreatedAt(candidates.latestEnded, entry);
    } else {
      candidates.latestActive = updateLatestDisplayRunByCreatedAt(candidates.latestActive, entry);
    }
    latestInMemoryDisplayCandidatesByChildSessionKey.set(childSessionKey, candidates);
  }

  const activeDescendantCountByRootSessionKey = new Map<string, number>();

  const countActiveDescendantRunsFromIndex = (rootSessionKey: string): number => {
    const root = rootSessionKey.trim();
    if (!root) {
      return 0;
    }
    const cached = activeDescendantCountByRootSessionKey.get(root);
    if (cached !== undefined) {
      return cached;
    }

    let count = 0;
    const pending = [root];
    const visited = new Set<string>([root]);
    for (let index = 0; index < pending.length; index += 1) {
      const requester = pending[index];
      if (!requester) {
        continue;
      }
      const latestByChild = latestRunsByRequesterSessionKey.get(requester);
      if (!latestByChild) {
        continue;
      }
      for (const [childSessionKey, { runId, entry }] of latestByChild.entries()) {
        const latestForChildSession = latestRunByChildSessionKey.get(childSessionKey);
        if (
          !latestForChildSession ||
          latestForChildSession.runId !== runId ||
          latestForChildSession.entry.requesterSessionKey !== requester
        ) {
          continue;
        }
        if (isLiveUnendedSubagentRun(entry)) {
          count += 1;
        }
        const childKey = entry.childSessionKey.trim();
        if (!childKey || visited.has(childKey)) {
          continue;
        }
        visited.add(childKey);
        pending.push(childKey);
      }
    }

    activeDescendantCountByRootSessionKey.set(root, count);
    return count;
  };

  return {
    listRunsForController(controllerSessionKey: string): SubagentRunRecord[] {
      const key = controllerSessionKey.trim();
      if (!key) {
        return [];
      }
      return [...(runsByControllerSessionKey.get(key) ?? [])];
    },
    countActiveDescendantRuns(rootSessionKey: string): number {
      return countActiveDescendantRunsFromIndex(rootSessionKey);
    },
    getSessionDisplayRunByChildSessionKey(childSessionKey: string): SubagentRunRecord | null {
      const key = childSessionKey.trim();
      if (!key) {
        return null;
      }

      const inMemoryCandidates = latestInMemoryDisplayCandidatesByChildSessionKey.get(key);
      if (inMemoryCandidates) {
        const { latestActive, latestEnded } = inMemoryCandidates;
        if (latestEnded && (!latestActive || latestEnded.createdAt > latestActive.createdAt)) {
          return latestEnded;
        }
        return latestActive ?? latestEnded;
      }

      return (
        latestActiveDisplayRunByChildSessionKey.get(key) ??
        latestEndedDisplayRunByChildSessionKey.get(key) ??
        null
      );
    },
  };
}

export function createSubagentRegistryReadContext(): SubagentRegistryReadContext {
  const inMemoryRuns = new Map(subagentRuns);
  return createSubagentRegistryReadContextFromRuns({
    runs: getSubagentRunsSnapshotForRead(inMemoryRuns),
    inMemoryRuns,
  });
}
export function listSubagentRunsForController(controllerSessionKey: string): SubagentRunRecord[] {
  return listRunsForControllerFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    controllerSessionKey,
  );
}

export function countActiveDescendantRuns(rootSessionKey: string): number {
  return countActiveDescendantRunsFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

export function listDescendantRunsForRequester(rootSessionKey: string): SubagentRunRecord[] {
  return listDescendantRunsForRequesterFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    rootSessionKey,
  );
}

export function getSubagentRunByChildSessionKey(childSessionKey: string): SubagentRunRecord | null {
  return getSubagentRunByChildSessionKeyFromRuns(
    getSubagentRunsSnapshotForRead(subagentRuns),
    childSessionKey,
  );
}

export function isSubagentRunLive(
  entry: Pick<SubagentRunRecord, "runId" | "endedAt"> | null | undefined,
): boolean {
  if (!entry || typeof entry.endedAt === "number") {
    return false;
  }
  return Boolean(getAgentRunContext(entry.runId));
}

export function getSessionDisplaySubagentRunByChildSessionKey(
  childSessionKey: string,
): SubagentRunRecord | null {
  const key = childSessionKey.trim();
  if (!key) {
    return null;
  }

  let latestInMemoryActive: SubagentRunRecord | null = null;
  let latestInMemoryEnded: SubagentRunRecord | null = null;
  for (const entry of subagentRuns.values()) {
    if (entry.childSessionKey !== key) {
      continue;
    }
    if (typeof entry.endedAt === "number") {
      if (!latestInMemoryEnded || entry.createdAt > latestInMemoryEnded.createdAt) {
        latestInMemoryEnded = entry;
      }
      continue;
    }
    if (!latestInMemoryActive || entry.createdAt > latestInMemoryActive.createdAt) {
      latestInMemoryActive = entry;
    }
  }

  if (latestInMemoryEnded || latestInMemoryActive) {
    if (
      latestInMemoryEnded &&
      (!latestInMemoryActive || latestInMemoryEnded.createdAt > latestInMemoryActive.createdAt)
    ) {
      return latestInMemoryEnded;
    }
    return latestInMemoryActive ?? latestInMemoryEnded;
  }

  return getSubagentRunByChildSessionKey(key);
}

export function getLatestSubagentRunByChildSessionKey(
  childSessionKey: string,
): SubagentRunRecord | null {
  const key = childSessionKey.trim();
  if (!key) {
    return null;
  }

  let latest: SubagentRunRecord | null = null;
  for (const entry of getSubagentRunsSnapshotForRead(subagentRuns).values()) {
    if (entry.childSessionKey !== key) {
      continue;
    }
    if (!latest || entry.createdAt > latest.createdAt) {
      latest = entry;
    }
  }

  return latest;
}
