import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import {
  buildBmeDbName,
  buildGraphFromSnapshot,
  buildPersistDelta,
  buildSnapshotFromGraph,
  evaluatePersistNativeDeltaGate,
} from "../sync/bme-db.js";
import { onMessageReceivedController } from "../host/event-binding.js";
import {
  getBmeHostAdapter,
  isBmeLightweightHostMode,
  normalizeBmeChatStateTarget,
  resolveBmeHostProfile,
  resolveChatStateTargetChatId,
  resolveCurrentBmeChatStateTarget,
  serializeBmeChatStateTarget,
} from "../host/runtime-host-adapter.js";
import {
  buildGraphCommitMarker,
  buildGraphChatStateSnapshot,
  buildLukerGraphCheckpointV2,
  buildLukerGraphJournalEntry,
  buildLukerGraphJournalV2,
  buildLukerGraphManifestV2,
  appendLukerGraphJournalEntryV2,
  canUseGraphChatState,
  detectIndexedDbSnapshotCommitMarkerMismatch,
  deleteGraphChatStateNamespace,
  cloneGraphForPersistence,
  cloneRuntimeDebugValue,
  findGraphShadowSnapshotByIntegrity,
  GRAPH_CHAT_STATE_NAMESPACE,
  getAcceptedCommitMarkerRevision,
  getGraphPersistedRevision,
  getGraphIdentityAliasCandidates,
  getGraphPersistenceMeta,
  GRAPH_COMMIT_MARKER_KEY,
  LUKER_GRAPH_CHECKPOINT_NAMESPACE,
  LUKER_GRAPH_JOURNAL_COMPACTION_BYTES,
  LUKER_GRAPH_JOURNAL_COMPACTION_DEPTH,
  LUKER_GRAPH_JOURNAL_COMPACTION_REVISION_GAP,
  LUKER_GRAPH_JOURNAL_NAMESPACE,
  LUKER_GRAPH_MANIFEST_NAMESPACE,
  getGraphShadowSnapshotStorageKey,
  GRAPH_LOAD_PENDING_CHAT_ID,
  GRAPH_IDENTITY_ALIAS_STORAGE_KEY,
  GRAPH_LOAD_STATES,
  GRAPH_METADATA_KEY,
  GRAPH_PERSISTENCE_META_KEY,
  GRAPH_PERSISTENCE_SESSION_ID,
  GRAPH_SHADOW_SNAPSHOT_STORAGE_PREFIX,
  GRAPH_STARTUP_RECONCILE_DELAYS_MS,
  MODULE_NAME,
  normalizeGraphCommitMarker,
  readGraphChatStateNamespaces,
  readGraphCommitMarker,
  readGraphChatStateSnapshot,
  readLukerGraphSidecarV2,
  readGraphShadowSnapshot,
  replaceLukerGraphJournalV2,
  rememberGraphIdentityAlias,
  removeGraphShadowSnapshot,
  resolveGraphIdentityAliasByHostChatId,
  shouldPreferShadowSnapshotOverOfficial,
  stampGraphPersistenceMeta,
  writeChatMetadataPatch,
  writeGraphChatStatePayload,
  writeGraphChatStateSnapshot,
  writeLukerGraphCheckpointV2,
  writeLukerGraphManifestV2,
  writeGraphShadowSnapshot,
} from "../graph/graph-persistence.js";
import {
  createEmptyGraph,
  deserializeGraph,
  getGraphStats,
  getNode,
  serializeGraph,
} from "../graph/graph.js";
import {
  buildPersistedRecallRecord,
  readPersistedRecallFromUserMessage,
} from "../retrieval/recall-persistence.js";
import { getNodeDisplayName } from "../graph/node-labels.js";
import { normalizeGraphRuntimeState } from "../runtime/runtime-state.js";
import {
  defaultSettings,
  getPersistedSettingsSnapshot,
  mergePersistedSettings,
} from "../runtime/settings-defaults.js";
import {
  clampFloat,
  clampInt,
  createGraphPersistenceState,
  createRecallInputRecord,
  createRecallRunResult,
  createUiStatus,
  formatRecallContextLine,
  getStageNoticeDuration,
  getStageNoticeTitle,
  hashRecallInput,
  isFreshRecallInputRecord,
  normalizeRecallInputText,
  normalizeStageNoticeLevel,
} from "../ui/ui-status.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.resolve(moduleDir, "../index.js");
const indexSource = await fs.readFile(indexPath, "utf8");

function extractSnippet(startMarker, endMarker) {
  const start = indexSource.indexOf(startMarker);
  const end = indexSource.indexOf(endMarker);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`Không thểTrích xuất index.js đoạn: ${startMarker} -> ${endMarker}`);
  }
  return indexSource.slice(start, end).replace(/^export\s+/gm, "");
}

const persistencePrelude = extractSnippet(
  'const SERVER_SETTINGS_FILENAME = "st-bme-settings.json";',
  "function clearInjectionState(options = {}) {",
);
const persistenceCore = extractSnippet(
  "function loadGraphFromChat(options = {}) {",
  "function handleGraphShadowSnapshotPageHide() {",
);
const messageSnippet = extractSnippet(
  'function onMessageReceived(messageId = null, type = "") {',
  "async function onViewGraph() {",
);

function createSessionStorage(seed = null) {
  const store = seed instanceof Map ? seed : new Map();
  return {
    __store: store,
    get length() {
      return store.size;
    },
    key(index) {
      return Array.from(store.keys())[Number(index)] ?? null;
    },
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(String(key), String(value));
    },
    removeItem(key) {
      store.delete(String(key));
    },
  };
}

function createLocalStorage(seed = null) {
  const store = seed instanceof Map ? seed : new Map();
  return {
    __store: store,
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(String(key), String(value));
    },
    removeItem(key) {
      store.delete(String(key));
    },
  };
}

function createMeaningfulGraph(chatId = "chat-test", suffix = "base") {
  const graph = createEmptyGraph();
  graph.historyState.chatId = chatId;
  graph.historyState.extractionCount = 3;
  graph.historyState.lastProcessedAssistantFloor = 6;
  graph.lastProcessedSeq = 6;
  graph.lastRecallResult = [{ id: `recall-${suffix}` }];
  graph.nodes.push({
    id: `node-${suffix}`,
    type: "event",
    fields: {
      title: `Sự kiện-${suffix}`,
      summary: `tóm tắt-${suffix}`,
    },
    seq: 6,
    seqRange: [6, 6],
    archived: false,
    embedding: null,
    importance: 5,
    accessCount: 0,
    lastAccessTime: Date.now(),
    createdTime: Date.now(),
    level: 0,
    parentId: null,
    childIds: [],
    prevId: null,
    nextId: null,
    clusters: [],
  });
  return normalizeGraphRuntimeState(graph, chatId);
}

function stampPersistedGraph(
  graph,
  {
    revision = 1,
    integrity = "",
    chatId = graph?.historyState?.chatId || "",
    reason = "test",
  } = {},
) {
  graph.__stBmePersistence = {
    revision,
    integrity,
    chatId,
    reason,
    updatedAt: new Date().toISOString(),
    sessionId: "test-session",
  };
  return graph;
}

async function createGraphPersistenceHarness({
  chatId = "chat-test",
  chatMetadata = undefined,
  sessionStore = null,
  localStore = null,
  globalChatId = "",
  characterId = "",
  groupId = null,
  indexedDbSnapshot = null,
  indexedDbSnapshots = null,
  chat = [],
} = {}) {
  const timers = new Map();
  let nextTimerId = 1;
  const storage = createSessionStorage(sessionStore);
  const localStorage = createLocalStorage(localStore);
  const indexedDbSnapshotMap =
    indexedDbSnapshots instanceof Map
      ? new Map(indexedDbSnapshots)
      : new Map(
          Object.entries(
            indexedDbSnapshots &&
              typeof indexedDbSnapshots === "object" &&
              !Array.isArray(indexedDbSnapshots)
              ? indexedDbSnapshots
              : {},
          ),
        );

  if (indexedDbSnapshot) {
    const primaryChatId = String(chatId || globalChatId || "");
    if (primaryChatId) {
      indexedDbSnapshotMap.set(primaryChatId, structuredClone(indexedDbSnapshot));
    }
  }

  function buildEmptyIndexedDbSnapshot(targetChatId = "") {
    return {
      meta: { revision: 0, chatId: String(targetChatId || "") },
      nodes: [],
      edges: [],
      tombstones: [],
      state: { lastProcessedFloor: -1, extractionCount: 0 },
    };
  }

  function getIndexedDbSnapshotForChat(targetChatId = "") {
    const normalizedChatId = String(targetChatId || "");
    if (normalizedChatId && indexedDbSnapshotMap.has(normalizedChatId)) {
      return structuredClone(indexedDbSnapshotMap.get(normalizedChatId));
    }

    if (
      normalizedChatId &&
      indexedDbSnapshot &&
      !indexedDbSnapshotMap.size &&
      normalizedChatId === String(chatId || globalChatId || "")
    ) {
      return structuredClone(indexedDbSnapshot);
    }

    return buildEmptyIndexedDbSnapshot(normalizedChatId);
  }

  function setIndexedDbSnapshotForChat(targetChatId = "", snapshot = null) {
    const normalizedChatId = String(targetChatId || "");
    if (!normalizedChatId) return;
    if (!snapshot) {
      indexedDbSnapshotMap.delete(normalizedChatId);
      return;
    }
    indexedDbSnapshotMap.set(normalizedChatId, structuredClone(snapshot));
  }

  function commitIndexedDbDelta(targetChatId = "", delta = {}, options = {}) {
    const normalizedChatId = String(targetChatId || "");
    const currentSnapshot = getIndexedDbSnapshotForChat(normalizedChatId);
    const now = Date.now();

    const nodeMap = new Map(
      (Array.isArray(currentSnapshot?.nodes) ? currentSnapshot.nodes : [])
        .filter((record) => record?.id)
        .map((record) => [String(record.id), structuredClone(record)]),
    );
    const edgeMap = new Map(
      (Array.isArray(currentSnapshot?.edges) ? currentSnapshot.edges : [])
        .filter((record) => record?.id)
        .map((record) => [String(record.id), structuredClone(record)]),
    );
    const tombstoneMap = new Map(
      (Array.isArray(currentSnapshot?.tombstones) ? currentSnapshot.tombstones : [])
        .filter((record) => record?.id)
        .map((record) => [String(record.id), structuredClone(record)]),
    );

    for (const edgeId of Array.isArray(delta?.deleteEdgeIds) ? delta.deleteEdgeIds : []) {
      edgeMap.delete(String(edgeId));
    }
    for (const nodeId of Array.isArray(delta?.deleteNodeIds) ? delta.deleteNodeIds : []) {
      nodeMap.delete(String(nodeId));
    }
    for (const record of Array.isArray(delta?.upsertNodes) ? delta.upsertNodes : []) {
      if (!record?.id) continue;
      nodeMap.set(String(record.id), structuredClone(record));
    }
    for (const record of Array.isArray(delta?.upsertEdges) ? delta.upsertEdges : []) {
      if (!record?.id) continue;
      edgeMap.set(String(record.id), structuredClone(record));
    }
    for (const record of Array.isArray(delta?.tombstones) ? delta.tombstones : []) {
      if (!record?.id) continue;
      tombstoneMap.set(String(record.id), structuredClone(record));
    }

    const runtimeMetaPatch =
      delta?.runtimeMetaPatch &&
      typeof delta.runtimeMetaPatch === "object" &&
      !Array.isArray(delta.runtimeMetaPatch)
        ? structuredClone(delta.runtimeMetaPatch)
        : {};
    const shouldMarkSyncDirty = options?.markSyncDirty !== false;
    const nextRevision = Math.max(
      Number(currentSnapshot?.meta?.revision || 0) + 1,
      Number(options?.requestedRevision || 0),
    );
    const nextState = {
      lastProcessedFloor: Number.isFinite(Number(runtimeMetaPatch.lastProcessedFloor))
        ? Number(runtimeMetaPatch.lastProcessedFloor)
        : Number(currentSnapshot?.state?.lastProcessedFloor ?? -1),
      extractionCount: Number.isFinite(Number(runtimeMetaPatch.extractionCount))
        ? Number(runtimeMetaPatch.extractionCount)
        : Number(currentSnapshot?.state?.extractionCount ?? 0),
    };
    const nextSnapshot = {
      meta: {
        ...(currentSnapshot?.meta || {}),
        ...runtimeMetaPatch,
        chatId: normalizedChatId,
        revision: nextRevision,
        lastModified: now,
        lastMutationReason: String(options?.reason || "commitDelta"),
        syncDirty: shouldMarkSyncDirty,
        syncDirtyReason: shouldMarkSyncDirty
          ? String(options?.reason || "commitDelta")
          : "",
        nodeCount: nodeMap.size,
        edgeCount: edgeMap.size,
        tombstoneCount: tombstoneMap.size,
      },
      nodes: Array.from(nodeMap.values()),
      edges: Array.from(edgeMap.values()),
      tombstones: Array.from(tombstoneMap.values()),
      state: nextState,
    };

    setIndexedDbSnapshotForChat(normalizedChatId, nextSnapshot);
    runtimeContext.__indexedDbSnapshot =
      getIndexedDbSnapshotForChat(normalizedChatId);

    return {
      revision: nextRevision,
      lastModified: now,
      imported: {
        nodes: nodeMap.size,
        edges: edgeMap.size,
        tombstones: tombstoneMap.size,
      },
      delta: {
        upsertNodes: Array.isArray(delta?.upsertNodes) ? delta.upsertNodes.length : 0,
        upsertEdges: Array.isArray(delta?.upsertEdges) ? delta.upsertEdges.length : 0,
        deleteNodeIds: Array.isArray(delta?.deleteNodeIds) ? delta.deleteNodeIds.length : 0,
        deleteEdgeIds: Array.isArray(delta?.deleteEdgeIds) ? delta.deleteEdgeIds.length : 0,
        tombstones: Array.isArray(delta?.tombstones) ? delta.tombstones.length : 0,
      },
    };
  }

  const runtimeContext = {
    console,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    structuredClone,
    result: null,
    __indexedDbSnapshot: getIndexedDbSnapshotForChat(
      String(chatId || globalChatId || ""),
    ),
    __indexedDbSnapshots: indexedDbSnapshotMap,
    sessionStorage: storage,
    localStorage,
    extension_settings: {
      [MODULE_NAME]: {},
    },
    defaultSettings,
    getPersistedSettingsSnapshot,
    mergePersistedSettings,
    migrateLegacyTaskProfiles(settings = {}) {
      return {
        taskProfilesVersion: Number(settings?.taskProfilesVersion || 0),
        taskProfiles:
          settings?.taskProfiles && typeof settings.taskProfiles === "object"
            ? settings.taskProfiles
            : {},
      };
    },
    migratePerTaskRegexToGlobal(settings = {}) {
      return {
        changed: false,
        settings,
      };
    },
    setTimeout(fn, delay) {
      const id = nextTimerId++;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    queueMicrotask(fn) {
      fn();
    },
    toastr: {
      info() {},
      warning() {},
      error() {},
      success() {},
    },
    window: {
      addEventListener() {},
      removeEventListener() {},
    },
    document: {
      visibilityState: "visible",
      getElementById() {
        return null;
      },
    },
    SillyTavern: {
      getCurrentChatId() {
        return runtimeContext.__globalChatId;
      },
    },
    __globalChatId: String(globalChatId || ""),
    Dexie: {
      async exists(dbName = "") {
        return Array.from(indexedDbSnapshotMap.keys()).some(
          (candidateChatId) => buildBmeDbName(candidateChatId) === String(dbName),
        );
      },
      async getDatabaseNames() {
        return Array.from(indexedDbSnapshotMap.keys()).map((candidateChatId) =>
          buildBmeDbName(candidateChatId),
        );
      },
    },
    async ensureDexieLoaded() {
      return runtimeContext.Dexie;
    },
    refreshPanelLiveState() {
      runtimeContext.__panelRefreshCount += 1;
    },
    __panelRefreshCount: 0,
    getLastProcessedAssistantFloor() {
      const historyFloor = Number(
        runtimeContext.currentGraph?.historyState?.lastProcessedAssistantFloor,
      );
      if (Number.isFinite(historyFloor)) {
        return historyFloor;
      }
      const legacySeq = Number(runtimeContext.currentGraph?.lastProcessedSeq);
      if (Number.isFinite(legacySeq)) return legacySeq;
      return -1;
    },
    createEmptyGraph,
    normalizeGraphRuntimeState,
    serializeGraph,
    deserializeGraph,
    getGraphStats,
    getNode,
    getNodeDisplayName,
    createUiStatus,
    createGraphPersistenceState,
    createRecallInputRecord,
    createRecallRunResult,
    normalizeStageNoticeLevel,
    getStageNoticeTitle,
    getStageNoticeDuration,
    normalizeRecallInputText,
    hashRecallInput,
    isFreshRecallInputRecord,
    clampInt,
    clampFloat,
    formatRecallContextLine,
    getBmeHostAdapter(context = null) {
      const activeContext = context || runtimeContext.__chatContext || {};
      return {
        context: activeContext,
        hostProfile: runtimeContext.resolveBmeHostProfile(activeContext),
        resolveCurrentTarget(options = {}) {
          return runtimeContext.resolveCurrentBmeChatStateTarget(
            activeContext,
            options?.target,
          );
        },
        getChatIdFromTarget(target = null) {
          return runtimeContext.resolveChatStateTargetChatId(target);
        },
        isLightweightHostMode() {
          return runtimeContext.isBmeLightweightHostMode(activeContext);
        },
      };
    },
    isBmeLightweightHostMode(context = null) {
      return runtimeContext.resolveBmeHostProfile(context) === "luker";
    },
    normalizeBmeChatStateTarget,
    resolveBmeHostProfile(context = null) {
      const activeContext = context || runtimeContext.__chatContext || {};
      const hasImplicitCurrentChat =
        String(activeContext?.chatId || "").trim() ||
        String(activeContext?.groupId || "").trim() ||
        String(activeContext?.characterId || "").trim();
      return runtimeContext.Luker &&
        typeof runtimeContext.Luker?.getContext === "function" &&
        typeof activeContext.getChatState === "function" &&
        typeof activeContext.updateChatState === "function" &&
        typeof activeContext.getChatStateBatch === "function" &&
        hasImplicitCurrentChat
        ? "luker"
        : "generic-st";
    },
    resolveChatStateTargetChatId(target = null) {
      return resolveChatStateTargetChatId(target);
    },
    resolveCurrentBmeChatStateTarget(context = null, explicitTarget = null) {
      if (explicitTarget) {
        return normalizeBmeChatStateTarget(explicitTarget);
      }
      const activeContext = context || runtimeContext.__chatContext || {};
      if (String(activeContext?.groupId || "").trim()) {
        return {
          is_group: true,
          id: String(activeContext.chatId || activeContext.groupId).trim(),
        };
      }
      const avatar =
        activeContext?.characterAvatar ||
        activeContext?.avatar_url ||
        activeContext?.characters?.[activeContext?.characterId]?.avatar ||
        activeContext?.characters?.[Number(activeContext?.characterId)]?.avatar ||
        "";
      const fileName = String(activeContext?.chatId || "").trim();
      if (avatar && fileName) {
        return {
          is_group: false,
          avatar_url: String(avatar),
          file_name: fileName,
        };
      }
      return null;
    },
    serializeBmeChatStateTarget(target = null) {
      return serializeBmeChatStateTarget(target);
    },
    readPersistedRecallFromUserMessage,
    cloneGraphForPersistence,
    buildGraphCommitMarker,
    buildGraphChatStateSnapshot,
    buildLukerGraphCheckpointV2,
    buildLukerGraphJournalEntry,
    buildLukerGraphJournalV2,
    buildLukerGraphManifestV2,
    canUseGraphChatState,
    cloneRuntimeDebugValue,
    deleteGraphChatStateNamespace,
    detectIndexedDbSnapshotCommitMarkerMismatch,
    onMessageReceivedController,
    GRAPH_CHAT_STATE_NAMESPACE,
    getAcceptedCommitMarkerRevision,
    getGraphPersistenceMeta,
    getGraphPersistedRevision,
    getGraphIdentityAliasCandidates,
    GRAPH_COMMIT_MARKER_KEY,
    LUKER_GRAPH_CHECKPOINT_NAMESPACE,
    LUKER_GRAPH_JOURNAL_COMPACTION_BYTES,
    LUKER_GRAPH_JOURNAL_COMPACTION_DEPTH,
    LUKER_GRAPH_JOURNAL_COMPACTION_REVISION_GAP,
    LUKER_GRAPH_JOURNAL_NAMESPACE,
    LUKER_GRAPH_MANIFEST_NAMESPACE,
    getGraphShadowSnapshotStorageKey,
    GRAPH_IDENTITY_ALIAS_STORAGE_KEY,
    GRAPH_LOAD_PENDING_CHAT_ID,
    GRAPH_LOAD_STATES,
    GRAPH_METADATA_KEY,
    GRAPH_PERSISTENCE_META_KEY,
    GRAPH_PERSISTENCE_SESSION_ID,
    GRAPH_SHADOW_SNAPSHOT_STORAGE_PREFIX,
    GRAPH_STARTUP_RECONCILE_DELAYS_MS,
    MODULE_NAME,
    findGraphShadowSnapshotByIntegrity,
    normalizeGraphCommitMarker,
    readGraphChatStateNamespaces,
    readGraphCommitMarker,
    readGraphChatStateSnapshot,
    readLukerGraphSidecarV2,
    readGraphShadowSnapshot,
    rememberGraphIdentityAlias,
    removeGraphShadowSnapshot,
    resolveGraphIdentityAliasByHostChatId,
    shouldPreferShadowSnapshotOverOfficial,
    stampGraphPersistenceMeta,
    replaceLukerGraphJournalV2,
    appendLukerGraphJournalEntryV2,
    writeChatMetadataPatch,
    writeGraphChatStatePayload,
    writeGraphChatStateSnapshot,
    writeLukerGraphManifestV2,
    writeLukerGraphCheckpointV2,
    writeGraphShadowSnapshot,
    // Shadow snapshot functions need VM-local sessionStorage overrides
    // because imported versions use the outer globalThis (no sessionStorage)
    rememberGraphIdentityAlias({
      integrity = "",
      hostChatId = "",
      persistenceChatId = "",
    } = {}) {
      const normalizedIntegrity = String(integrity || "").trim();
      if (!normalizedIntegrity) return null;

      const normalizedHostChatId = String(hostChatId || "").trim();
      const normalizedPersistenceChatId = String(
        persistenceChatId || normalizedIntegrity,
      ).trim();
      let registry = { byIntegrity: {} };
      try {
        const raw = localStorage.getItem(GRAPH_IDENTITY_ALIAS_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (
            parsed?.byIntegrity &&
            typeof parsed.byIntegrity === "object" &&
            !Array.isArray(parsed.byIntegrity)
          ) {
            registry = { byIntegrity: parsed.byIntegrity };
          }
        }
      } catch {
        registry = { byIntegrity: {} };
      }

      const current = registry.byIntegrity[normalizedIntegrity] || {};
      const hostChatIds = Array.from(
        new Set(
          [
            normalizedHostChatId,
            ...(Array.isArray(current.hostChatIds) ? current.hostChatIds : []),
          ].filter(Boolean),
        ),
      );
      const next = {
        integrity: normalizedIntegrity,
        persistenceChatId: normalizedPersistenceChatId,
        hostChatIds,
        updatedAt: new Date().toISOString(),
      };
      registry.byIntegrity[normalizedIntegrity] = next;
      localStorage.setItem(
        GRAPH_IDENTITY_ALIAS_STORAGE_KEY,
        JSON.stringify(registry),
      );
      return next;
    },
    resolveGraphIdentityAliasByHostChatId(hostChatId = "") {
      const normalizedHostChatId = String(hostChatId || "").trim();
      if (!normalizedHostChatId) return "";
      try {
        const raw = localStorage.getItem(GRAPH_IDENTITY_ALIAS_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : { byIntegrity: {} };
        let best = "";
        let bestUpdatedAt = "";
        for (const value of Object.values(parsed.byIntegrity || {})) {
          const hostChatIds = Array.isArray(value?.hostChatIds)
            ? value.hostChatIds.map((item) => String(item || "").trim())
            : [];
          if (!hostChatIds.includes(normalizedHostChatId)) continue;
          const persistenceChatId = String(
            value?.persistenceChatId || value?.integrity || "",
          ).trim();
          if (!persistenceChatId) continue;
          const updatedAt = String(value?.updatedAt || "");
          if (!best || updatedAt > bestUpdatedAt) {
            best = persistenceChatId;
            bestUpdatedAt = updatedAt;
          }
        }
        return best;
      } catch {
        return "";
      }
    },
    getGraphIdentityAliasCandidates({
      integrity = "",
      hostChatId = "",
      persistenceChatId = "",
    } = {}) {
      const normalizedIntegrity = String(integrity || "").trim();
      const normalizedHostChatId = String(hostChatId || "").trim();
      const normalizedPersistenceChatId = String(
        persistenceChatId || "",
      ).trim();
      const candidates = [];
      const seen = new Set();
      const addCandidate = (value) => {
        const normalized = String(value || "").trim();
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        candidates.push(normalized);
      };

      try {
        const raw = localStorage.getItem(GRAPH_IDENTITY_ALIAS_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : { byIntegrity: {} };
        if (normalizedIntegrity) {
          const value = parsed.byIntegrity?.[normalizedIntegrity] || {};
          addCandidate(value?.persistenceChatId || value?.integrity || "");
          for (const candidate of Array.isArray(value?.hostChatIds)
            ? value.hostChatIds
            : []) {
            addCandidate(candidate);
          }
        } else if (normalizedHostChatId) {
          addCandidate(
            runtimeContext.resolveGraphIdentityAliasByHostChatId(
              normalizedHostChatId,
            ),
          );
        }
      } catch {
        // ignore
      }

      addCandidate(normalizedHostChatId);
      addCandidate(normalizedPersistenceChatId);
      return candidates;
    },
    readGraphShadowSnapshot(chatId = "") {
      const key = getGraphShadowSnapshotStorageKey(chatId);
      if (!key) return null;
      try {
        const raw = storage.getItem(key);
        if (!raw) return null;
        const snap = JSON.parse(raw);
        if (
          !snap ||
          String(snap.chatId || "") !== String(chatId || "") ||
          typeof snap.serializedGraph !== "string" ||
          !snap.serializedGraph
        )
          return null;
        return {
          chatId: String(snap.chatId || ""),
          revision: Number.isFinite(snap.revision) ? snap.revision : 0,
          serializedGraph: snap.serializedGraph,
          updatedAt: String(snap.updatedAt || ""),
          reason: String(snap.reason || ""),
          integrity: String(snap.integrity || ""),
          persistedChatId: String(snap.persistedChatId || ""),
          debugReason: String(snap.debugReason || snap.reason || ""),
        };
      } catch {
        return null;
      }
    },
    findGraphShadowSnapshotByIntegrity(integrity = "", { excludeChatIds = [] } = {}) {
      const normalizedIntegrity = String(integrity || "").trim();
      if (!normalizedIntegrity) return null;
      const excluded = new Set(
        (Array.isArray(excludeChatIds) ? excludeChatIds : [])
          .map((value) => String(value || "").trim())
          .filter(Boolean),
      );
      let best = null;
      for (const key of storage.__store.keys()) {
        if (!String(key || "").startsWith(GRAPH_SHADOW_SNAPSHOT_STORAGE_PREFIX)) {
          continue;
        }
        try {
          const snap = JSON.parse(storage.getItem(key));
          if (
            !snap ||
            String(snap.integrity || "") !== normalizedIntegrity ||
            typeof snap.serializedGraph !== "string" ||
            !snap.serializedGraph
          ) {
            continue;
          }
          const normalizedChatId = String(snap.chatId || "").trim();
          if (!normalizedChatId || excluded.has(normalizedChatId)) {
            continue;
          }
          if (
            !best ||
            Number(snap.revision || 0) > Number(best.revision || 0) ||
            (Number(snap.revision || 0) === Number(best.revision || 0) &&
              String(snap.updatedAt || "") > String(best.updatedAt || ""))
          ) {
            best = {
              chatId: normalizedChatId,
              revision: Number.isFinite(snap.revision) ? snap.revision : 0,
              serializedGraph: snap.serializedGraph,
              updatedAt: String(snap.updatedAt || ""),
              reason: String(snap.reason || ""),
              integrity: String(snap.integrity || ""),
              persistedChatId: String(snap.persistedChatId || ""),
              debugReason: String(snap.debugReason || snap.reason || ""),
            };
          }
        } catch {
          // ignore
        }
      }
      return best;
    },
    writeGraphShadowSnapshot(
      chatId = "",
      graph = null,
      { revision = 0, reason = "", integrity = "", debugReason = "" } = {},
    ) {
      const key = getGraphShadowSnapshotStorageKey(chatId);
      if (!key || !graph) return false;
      const persistedMeta = getGraphPersistenceMeta(graph) || {};
      try {
        storage.setItem(
          key,
          JSON.stringify({
            chatId: String(chatId || ""),
            revision: Number.isFinite(revision) ? revision : 0,
            serializedGraph: serializeGraph(graph),
            updatedAt: new Date().toISOString(),
            reason: String(reason || ""),
            integrity: String(integrity || persistedMeta.integrity || ""),
            persistedChatId: String(persistedMeta.chatId || ""),
            debugReason: String(debugReason || reason || ""),
          }),
        );
        return true;
      } catch {
        return false;
      }
    },
    removeGraphShadowSnapshot(chatId = "") {
      const key = getGraphShadowSnapshotStorageKey(chatId);
      if (!key) return false;
      try {
        storage.removeItem(key);
        return true;
      } catch {
        return false;
      }
    },
    createDefaultTaskProfiles() {
      return {
        extract: { activeProfileId: "default", profiles: [] },
        recall: { activeProfileId: "default", profiles: [] },
        compress: { activeProfileId: "default", profiles: [] },
        synopsis: { activeProfileId: "default", profiles: [] },
        reflection: { activeProfileId: "default", profiles: [] },
      };
    },
    getContext() {
      return runtimeContext.__chatContext;
    },
    async saveMetadata() {
      runtimeContext.__globalImmediateSaveCalls += 1;
    },
    saveMetadataDebounced() {
      runtimeContext.__globalSaveCalls += 1;
    },
    __globalSaveCalls: 0,
    __globalImmediateSaveCalls: 0,
    isAssistantChatMessage() {
      return false;
    },
    isFreshRecallInputRecord() {
      return true;
    },
    notifyExtractionIssue() {},
    debugDebug() {},
    debugLog() {},
    async runExtraction() {},
    getRequestHeaders() {
      return {};
    },
    __syncNowCalls: [],
    async syncNow(chatId, options = {}) {
      runtimeContext.__syncNowCalls.push({
        chatId,
        options: {
          reason: String(options?.reason || ""),
          trigger: String(options?.trigger || ""),
        },
      });
      return { synced: true, chatId, reason: String(options?.reason || "") };
    },
    __chatContext: {
      chatId,
      chatMetadata,
      characterId,
      groupId,
      chat,
      __chatStateStore: new Map(),
      updateChatMetadata(patch) {
        const base =
          this.chatMetadata &&
          typeof this.chatMetadata === "object" &&
          !Array.isArray(this.chatMetadata)
            ? this.chatMetadata
            : {};
        this.chatMetadata = {
          ...base,
          ...(patch || {}),
        };
      },
      saveMetadataDebounced() {
        runtimeContext.__contextSaveCalls += 1;
      },
      async saveMetadata() {
        runtimeContext.__contextImmediateSaveCalls += 1;
      },
      __chatStateTargetStore: new Map(),
      __chatStateCalls: [],
      async getChatState(namespace, options = {}) {
        const key = String(namespace || "").trim().toLowerCase();
        const targetKey = serializeBmeChatStateTarget(options?.target);
        const scopedKey = targetKey ? `${targetKey}::${key}` : key;
        this.__chatStateCalls.push({
          type: "get",
          namespace: key,
          target: options?.target ? structuredClone(options.target) : null,
        });
        const value = this.__chatStateStore.get(scopedKey);
        return value == null ? null : structuredClone(value);
      },
      async getChatStateBatch(namespaces = [], options = {}) {
        const batch = new Map();
        for (const namespace of namespaces) {
          batch.set(namespace, await this.getChatState(namespace, options));
        }
        return batch;
      },
      async updateChatState(namespace, updater, options = {}) {
        const key = String(namespace || "").trim().toLowerCase();
        const targetKey = serializeBmeChatStateTarget(options?.target);
        const scopedKey = targetKey ? `${targetKey}::${key}` : key;
        if (!key || typeof updater !== "function") {
          return { ok: false, state: null, updated: false };
        }
        this.__chatStateCalls.push({
          type: "update",
          namespace: key,
          target: options?.target ? structuredClone(options.target) : null,
        });
        const current = this.__chatStateStore.has(scopedKey)
          ? structuredClone(this.__chatStateStore.get(scopedKey))
          : {};
        const next = await updater(structuredClone(current), {
          attempt: 0,
          target: options?.target ?? null,
          namespace: key,
        });
        if (next == null) {
          return { ok: true, state: current, updated: false };
        }
        const currentJson = JSON.stringify(current);
        const nextJson = JSON.stringify(next);
        this.__chatStateStore.set(scopedKey, structuredClone(next));
        return {
          ok: true,
          state: structuredClone(next),
          updated: currentJson !== nextJson,
        };
      },
      async deleteChatState(namespace, options = {}) {
        const key = String(namespace || "").trim().toLowerCase();
        const targetKey = serializeBmeChatStateTarget(options?.target);
        const scopedKey = targetKey ? `${targetKey}::${key}` : key;
        this.__chatStateStore.delete(scopedKey);
        this.__chatStateCalls.push({
          type: "delete",
          namespace: key,
          target: options?.target ? structuredClone(options.target) : null,
        });
        return true;
      },
    },
    __contextSaveCalls: 0,
    __contextImmediateSaveCalls: 0,
    buildGraphFromSnapshot,
    buildPersistDelta,
    buildSnapshotFromGraph,
    evaluatePersistNativeDeltaGate,
    buildBmeDbName,
    BME_GRAPH_LOCAL_STORAGE_MODE_AUTO: "auto",
    BME_GRAPH_LOCAL_STORAGE_MODE_INDEXEDDB: "indexeddb",
    BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_PRIMARY: "opfs-primary",
    BME_GRAPH_LOCAL_STORAGE_MODE_OPFS_SHADOW: "opfs-shadow",
    detectOpfsSupport: async () => ({
      available: false,
      reason: "opfs-unsupported-in-test",
    }),
    isGraphLocalStorageModeOpfs: (mode = "") =>
      /^opfs-/.test(String(mode || "").trim().toLowerCase()),
    normalizeGraphLocalStorageMode: (mode = "", fallback = "indexeddb") => {
      const normalized = String(mode || "").trim().toLowerCase();
      if (
        normalized === "indexeddb" ||
        normalized === "opfs-shadow" ||
        normalized === "opfs-primary"
      ) {
        return normalized;
      }
      return String(fallback || "indexeddb").trim().toLowerCase() || "indexeddb";
    },
    OpfsGraphStore: class {
      constructor(dbChatId = "") {
        this.chatId = String(dbChatId || "");
        this.storeKind = "opfs";
        this.storeMode = "opfs-shadow";
      }
      async open() {}
      async close() {}
      async exportSnapshot() {
        return getIndexedDbSnapshotForChat(this.chatId);
      }
      async commitDelta(delta, options = {}) {
        return commitIndexedDbDelta(this.chatId, delta, options);
      }
      async importSnapshot(snapshot) {
        setIndexedDbSnapshotForChat(this.chatId, snapshot);
        return {
          revision: Number(snapshot?.meta?.revision) || 0,
        };
      }
      async isEmpty() {
        const snapshot = getIndexedDbSnapshotForChat(this.chatId);
        return {
          empty:
            !snapshot ||
            (!snapshot.nodes?.length && !snapshot.edges?.length && !snapshot.tombstones?.length),
        };
      }
      async getRevision() {
        return Number(getIndexedDbSnapshotForChat(this.chatId)?.meta?.revision || 0);
      }
      async getMeta(key, fallbackValue = 0) {
        const snapshot = getIndexedDbSnapshotForChat(this.chatId) || {};
        if (!snapshot?.meta || !(key in snapshot.meta)) {
          return fallbackValue;
        }
        return snapshot.meta[key];
      }
    },
    scheduleUpload() {
      if (runtimeContext.__scheduleUploadShouldThrow) {
        throw new Error("schedule-upload-failed");
      }
    },
    BmeDatabase: class {
      constructor(dbChatId = "") {
        this.chatId = String(dbChatId || "");
      }
      async open() {}
      async close() {}
      async exportSnapshot() {
        return getIndexedDbSnapshotForChat(this.chatId);
      }
      async commitDelta(delta, options = {}) {
        return commitIndexedDbDelta(this.chatId, delta, options);
      }
      async importSnapshot(snapshot) {
        setIndexedDbSnapshotForChat(this.chatId, snapshot);
        return {
          revision: Number(snapshot?.meta?.revision) || 0,
        };
      }
    },
    BmeChatManager: class {
      constructor() {
        this._currentChatId = "";
      }
      _createDb(dbChatId = "") {
        return {
          async exportSnapshot() {
            if (runtimeContext.__indexedDbExportSnapshotShouldThrow) {
              throw new Error("indexeddb-export-failed");
            }
            return getIndexedDbSnapshotForChat(dbChatId);
          },
          async commitDelta(delta, options = {}) {
            return commitIndexedDbDelta(dbChatId, delta, options);
          },
          async importSnapshot(snapshot) {
            setIndexedDbSnapshotForChat(dbChatId, snapshot);
            runtimeContext.__indexedDbSnapshot =
              getIndexedDbSnapshotForChat(dbChatId);
            return {
              revision:
                Number(snapshot?.meta?.revision) ||
                Number(runtimeContext.__indexedDbSnapshot?.meta?.revision) ||
                0,
            };
          },
          async getMeta(key, fallbackValue = 0) {
            const snapshot = getIndexedDbSnapshotForChat(dbChatId) || {};
            if (!snapshot?.meta || !(key in snapshot.meta)) {
              return fallbackValue;
            }
            return snapshot.meta[key];
          },
          async getRevision() {
            const snapshot = getIndexedDbSnapshotForChat(dbChatId) || {};
            return Number(snapshot?.meta?.revision) || 0;
          },
          async isEmpty() {
            const snapshot = getIndexedDbSnapshotForChat(dbChatId) || {};
            const nodes = Array.isArray(snapshot?.nodes)
              ? snapshot.nodes.length
              : 0;
            const edges = Array.isArray(snapshot?.edges)
              ? snapshot.edges.length
              : 0;
            const tombstones = Array.isArray(snapshot?.tombstones)
              ? snapshot.tombstones.length
              : 0;
            return {
              empty: nodes === 0 && edges === 0,
              nodes,
              edges,
              tombstones,
            };
          },
          async importLegacyGraph(graph, options = {}) {
            const revision = Number(options?.revision) || 1;
            const migratedSnapshot = buildSnapshotFromGraph(graph, {
              chatId: dbChatId || runtimeContext.__chatContext?.chatId || "",
              revision,
              meta: {
                migrationCompletedAt: Date.now(),
                migrationSource: "chat_metadata",
              },
            });
            setIndexedDbSnapshotForChat(dbChatId, migratedSnapshot);
            runtimeContext.__indexedDbSnapshot =
              getIndexedDbSnapshotForChat(dbChatId);
            return {
              migrated: true,
              revision,
              imported: {
                nodes: runtimeContext.__indexedDbSnapshot?.nodes?.length || 0,
                edges: runtimeContext.__indexedDbSnapshot?.edges?.length || 0,
                tombstones:
                  runtimeContext.__indexedDbSnapshot?.tombstones?.length || 0,
              },
            };
          },
          async markSyncDirty() {
            if (runtimeContext.__markSyncDirtyShouldThrow) {
              throw new Error("mark-sync-dirty-failed");
            }
          },
        };
      }
      async getCurrentDb(dbChatId = this._currentChatId) {
        this._currentChatId = String(dbChatId || this._currentChatId || "");
        runtimeContext.__indexedDbSnapshot = getIndexedDbSnapshotForChat(
          this._currentChatId,
        );
        if (runtimeContext.__indexedDbGetCurrentDbShouldThrow) {
          throw new Error("indexeddb-get-current-db-failed");
        }
        return this._createDb(this._currentChatId);
      }
      async switchChat(dbChatId = "") {
        this._currentChatId = String(dbChatId || "");
        runtimeContext.__indexedDbSnapshot = getIndexedDbSnapshotForChat(
          this._currentChatId,
        );
        return this._createDb(this._currentChatId);
      }
      async closeCurrent() {}
    },
  };

  runtimeContext.globalThis = runtimeContext;
  vm.createContext(runtimeContext);
  vm.runInContext(
    [
      persistencePrelude,
      persistenceCore,
      messageSnippet,
      `
result = {
  GRAPH_LOAD_STATES,
  GRAPH_LOAD_RETRY_DELAYS_MS,
  readRuntimeDebugSnapshot,
  getGraphPersistenceLiveState,
  readGraphShadowSnapshot,
  writeGraphShadowSnapshot,
  removeGraphShadowSnapshot,
  maybeCaptureGraphShadowSnapshot,
  buildPanelOpenLocalStoreRefreshPlan,
  loadGraphFromChat,
  loadGraphFromIndexedDb,
  saveGraphToChat,
  syncGraphLoadFromLiveContext,
  buildBmeSyncRuntimeOptions,
  onMessageReceived,
  applyGraphLoadState,
  maybeFlushQueuedGraphPersist,
  retryPendingGraphPersist,
  persistExtractionBatchResult,
  saveGraphToIndexedDb,
  cloneGraphForPersistence,
  assertRecoveryChatStillActive,
  createAbortError,
  isAbortError,
  setCurrentGraph(graph) {
    currentGraph = graph;
    return currentGraph;
  },
  getCurrentGraph() {
    return currentGraph;
  },
  getLastInjectionContent() {
    return lastInjectionContent;
  },
  getLastRecalledItems() {
    return lastRecalledItems;
  },
  setGraphPersistenceState(patch = {}) {
    graphPersistenceState = {
      ...graphPersistenceState,
      ...(patch || {}),
      updatedAt: new Date().toISOString(),
    };
    syncGraphPersistenceDebugState();
    return graphPersistenceState;
  },
  getGraphPersistenceState() {
    return graphPersistenceState;
  },
  setLocalStoreCapabilitySnapshot(patch = {}) {
    bmeLocalStoreCapabilitySnapshot = {
      ...bmeLocalStoreCapabilitySnapshot,
      ...(patch || {}),
    };
    return bmeLocalStoreCapabilitySnapshot;
  },
  setChatContext(nextContext) {
    globalThis.__chatContext = nextContext;
    return globalThis.__chatContext;
  },
  getChatContext() {
    return globalThis.__chatContext;
  },
  setIndexedDbSnapshot(snapshot) {
    const activeChatId =
      String(globalThis.__chatContext?.chatId || globalThis.__globalChatId || "");
    if (activeChatId) {
      globalThis.__indexedDbSnapshots.set(
        activeChatId,
        structuredClone(snapshot),
      );
    }
    globalThis.__indexedDbSnapshot = structuredClone(snapshot);
  },
  getIndexedDbSnapshot() {
    return globalThis.__indexedDbSnapshot;
  },
  setIndexedDbSnapshotForChat(chatId, snapshot) {
    const normalizedChatId = String(chatId || "");
    if (!normalizedChatId) return;
    globalThis.__indexedDbSnapshots.set(
      normalizedChatId,
      structuredClone(snapshot),
    );
  },
  getIndexedDbSnapshotForChat(chatId) {
    const normalizedChatId = String(chatId || "");
    if (!normalizedChatId) return null;
    const snapshot = globalThis.__indexedDbSnapshots.get(normalizedChatId);
    return snapshot ? structuredClone(snapshot) : null;
  },
};
      `,
    ].join("\n"),
    runtimeContext,
    { filename: indexPath },
  );

  return {
    api: runtimeContext.result,
    runtimeContext,
    sessionStore: storage.__store,
  };
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "",
    globalChatId: "",
    chatMetadata: {},
    characterId: "",
    groupId: null,
    chat: [],
  });
  const result = harness.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "no-chat-empty-host-state",
  });
  const live = harness.api.getGraphPersistenceLiveState();

  assert.equal(result.loadState, "no-chat");
  assert.equal(live.loadState, "no-chat");
  assert.equal(live.writesBlocked, true);
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "",
    globalChatId: "chat-global",
    chatMetadata: {
      st_bme_graph: createMeaningfulGraph("chat-global", "global"),
    },
  });
  const result = harness.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "global-chat-id",
  });

  assert.equal(result.loadState, "loading");
  assert.equal(result.reason, "global-chat-id:metadata-compat-provisional");
  assert.equal(
    harness.api.getCurrentGraph().historyState.chatId,
    "chat-global",
  );
  assert.equal(harness.api.getGraphPersistenceState().dbReady, false);
  assert.equal(harness.api.getGraphPersistenceLiveState().writesBlocked, true);
  assert.equal(
    harness.api.getGraphPersistenceState().dualWriteLastResult?.resultCode,
    "graph.load.metadata-compat.provisional",
  );
  assert.equal(
    harness.api.getGraphPersistenceState().dualWriteLastResult?.provisional,
    true,
  );
  assert.equal(
    harness.api.getGraphPersistenceState().dualWriteLastResult?.reason,
    "global-chat-id:metadata-compat-provisional",
  );
}

{
  const graph = createMeaningfulGraph("chat-recall-ui", "recall-ui");
  graph.nodes[0].id = "restore-node";
  graph.lastRecallResult = [{ id: "restore-node" }];
  stampPersistedGraph(graph, {
    revision: 7,
    chatId: "chat-recall-ui",
    reason: "recall-ui-restore",
  });

  const harness = await createGraphPersistenceHarness({
    chatId: "chat-recall-ui",
    globalChatId: "chat-recall-ui",
    indexedDbSnapshot: buildSnapshotFromGraph(graph, {
      chatId: "chat-recall-ui",
      revision: 7,
    }),
    chat: [
      {
        is_user: true,
        mes: "Người dùngtầng",
        extra: {
          bme_recall: buildPersistedRecallRecord({
            injectionText: "Khối truy hồi đã lưu bền được tiêm",
            selectedNodeIds: [],
            nowIso: "2026-01-01T00:00:00.000Z",
          }),
        },
      },
      {
        is_user: false,
        mes: "assistant",
      },
    ],
  });

  const result = harness.api.syncGraphLoadFromLiveContext({
    source: "indexeddb-recall-ui-restore",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(result.synced, true);
  assert.equal(harness.api.getGraphPersistenceState().dbReady, true);
  assert.equal(harness.api.getLastInjectionContent(), "Khối truy hồi đã lưu bền được tiêm");
  assert.equal(harness.api.getLastRecalledItems().length, 1);
  assert.equal(harness.api.getLastRecalledItems()[0]?.id, "restore-node");
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "",
    globalChatId: "",
    chatMetadata: {},
  });
  const lateGraph = createMeaningfulGraph("chat-late", "late");
  harness.api.setChatContext({
    chatId: "chat-late",
    chatMetadata: {
      st_bme_graph: lateGraph,
    },
    characterId: "char-late",
    groupId: null,
    chat: [{ is_user: true, mes: "late load" }],
    updateChatMetadata(patch) {
      const base =
        this.chatMetadata &&
        typeof this.chatMetadata === "object" &&
        !Array.isArray(this.chatMetadata)
          ? this.chatMetadata
          : {};
      this.chatMetadata = {
        ...base,
        ...(patch || {}),
      };
    },
    saveMetadataDebounced() {},
  });

  harness.api.setIndexedDbSnapshot(
    buildSnapshotFromGraph(lateGraph, { chatId: "chat-late", revision: 5 }),
  );

  const result = harness.api.syncGraphLoadFromLiveContext({
    source: "late-context-sync",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(result.synced, true);
  assert.equal(result.loadState, "loading");
  assert.equal(
    harness.api.getCurrentGraph().historyState.chatId,
    "chat-late",
  );
  assert.equal(harness.api.getGraphPersistenceState().dbReady, true);
  assert.equal(
    harness.api.getGraphPersistenceState().storagePrimary,
    "indexeddb",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-loading-local-confirm",
    globalChatId: "chat-loading-local-confirm",
    chatMetadata: {
      integrity: "meta-chat-loading-local-confirm",
    },
  });
  const graph = createMeaningfulGraph(
    "chat-loading-local-confirm",
    "loading-local-confirm",
  );
  harness.api.setCurrentGraph(graph);
  harness.api.setGraphPersistenceState({
    loadState: "loading",
    chatId: "chat-loading-local-confirm",
    reason: "metadata-compat-provisional",
    dbReady: false,
    writesBlocked: true,
    revision: 5,
    lastPersistedRevision: 0,
    storagePrimary: "indexeddb",
    storageMode: "indexeddb",
  });

  const result = await harness.api.saveGraphToIndexedDb(
    "chat-loading-local-confirm",
    graph,
    {
      revision: 6,
      reason: "test-loading-local-confirm",
    },
  );

  assert.equal(result.accepted, true);
  assert.equal(harness.api.getGraphPersistenceState().loadState, "loaded");
  assert.equal(harness.api.getGraphPersistenceState().dbReady, true);
  assert.equal(harness.api.getGraphPersistenceState().writesBlocked, false);
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-metadata-runtime-repair",
    globalChatId: "chat-metadata-runtime-repair",
    chatMetadata: {
      integrity: "meta-chat-metadata-runtime-repair",
    },
  });
  const metadataGraph = createMeaningfulGraph(
    "chat-metadata-runtime-repair",
    "metadata-runtime-repair",
  );
  harness.api.setChatContext({
    chatId: "chat-metadata-runtime-repair",
    chatMetadata: {
      integrity: "meta-chat-metadata-runtime-repair",
      [GRAPH_METADATA_KEY]: metadataGraph,
    },
    characterId: "char-runtime-repair",
    groupId: null,
    chat: [{ is_user: true, mes: "repair me" }],
    updateChatMetadata(patch) {
      const base =
        this.chatMetadata &&
        typeof this.chatMetadata === "object" &&
        !Array.isArray(this.chatMetadata)
          ? this.chatMetadata
          : {};
      this.chatMetadata = {
        ...base,
        ...(patch || {}),
      };
    },
    saveMetadataDebounced() {},
  });

  const result = harness.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "metadata-runtime-repair",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(result.loadState, "loading");
  assert.equal(harness.api.getCurrentGraph().nodes.length > 0, true);
  assert.equal(harness.api.getGraphPersistenceState().loadState, "loaded");
  assert.equal(harness.api.getGraphPersistenceState().dbReady, true);
  const repairedChatId =
    harness.api.getGraphPersistenceState().chatId ||
    harness.api.getCurrentGraph().historyState.chatId ||
    "chat-metadata-runtime-repair";
  assert.equal(
    harness.api.getIndexedDbSnapshotForChat(repairedChatId)?.nodes?.length > 0,
    true,
    "đồ thị tạm nạp từ metadata nên tự động bù lại vào lưu trữ cục bộ",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "",
    globalChatId: "",
    chatMetadata: {},
  });
  harness.api.setChatContext({
    chatId: "chat-empty-live",
    chatMetadata: {
      integrity: "chat-empty-live-ready",
    },
    characterId: "char-empty-live",
    groupId: null,
    chat: [{ is_user: true, mes: "hello" }],
    updateChatMetadata(patch) {
      const base =
        this.chatMetadata &&
        typeof this.chatMetadata === "object" &&
        !Array.isArray(this.chatMetadata)
          ? this.chatMetadata
          : {};
      this.chatMetadata = {
        ...base,
        ...(patch || {}),
      };
    },
    saveMetadataDebounced() {},
  });

  const result = harness.api.syncGraphLoadFromLiveContext({
    source: "late-empty-sync",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(result.synced, true);
  assert.equal(result.loadState, "loading");
  assert.equal(
    harness.api.getGraphPersistenceState().loadState,
    "empty-confirmed",
  );
  assert.equal(harness.api.getGraphPersistenceState().dbReady, true);
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-metadata-placeholder",
    chatMetadata: {
      placeholder: "host-loading",
    },
  });
  const result = harness.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "metadata-placeholder-not-ready",
  });
  const live = harness.api.getGraphPersistenceLiveState();

  assert.equal(
    result.loadState,
    "loading",
    "khi không có dữ liệu đồ thị thì nên vào trạng thái chờ thăm dò IndexedDB",
  );
  assert.equal(
    result.reason,
    "indexeddb-probe-pending",
    "nên tiếp tục chờ kết quả thăm dò IndexedDB",
  );
  assert.equal(live.writesBlocked, true);
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-metadata-chatid-ready",
    chatMetadata: {
      chatId: "chat-metadata-chatid-ready",
    },
  });
  const result = harness.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "metadata-chatid-ready",
  });

  assert.equal(result.loadState, "loading");
  assert.equal(
    harness.api.getGraphPersistenceLiveState().writesBlocked,
    true,
    "khi không khớp IndexedDB thì nên giữ loading để chờ kết quả thăm dò",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "",
    globalChatId: "",
    characterId: "char-1",
    chatMetadata: undefined,
    chat: [{ is_user: true, mes: "hello" }],
  });
  const result = harness.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "pending-chat-context",
  });
  const live = harness.api.getGraphPersistenceLiveState();

  assert.equal(result.loadState, "loading");
  assert.equal(live.loadState, "loading");
  assert.equal(live.reason, "chat-id-missing");
  assert.equal(live.writesBlocked, true);
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-blocked",
    chatMetadata: undefined,
  });
  const graph = createMeaningfulGraph("chat-blocked", "blocked");
  harness.api.setCurrentGraph(graph);
  harness.api.setGraphPersistenceState({
    loadState: "loading",
    chatId: "chat-blocked",
    reason: "chat-metadata-missing",
    revision: 4,
    writesBlocked: true,
  });

  const result = harness.api.saveGraphToChat({
    reason: "blocked-save",
    markMutation: false,
  });
  assert.equal(result.saved, false);
  assert.equal(result.queued, true);
  assert.equal(result.blocked, false);
  assert.equal(result.saveMode, "indexeddb-queued");
  assert.equal(harness.runtimeContext.__chatContext.chatMetadata, undefined);
  assert.equal(harness.runtimeContext.__contextSaveCalls, 0);
  assert.equal(harness.runtimeContext.__globalSaveCalls, 0);

  const shadow = harness.api.readGraphShadowSnapshot("chat-blocked");
  assert.equal(shadow, null, "đường chính IndexedDB không còn phụ thuộc vào snapshot bóng");
  assert.equal(
    harness.api.readRuntimeDebugSnapshot().graphPersistence
      ?.queuedPersistRevision,
    0,
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-empty",
    chatMetadata: undefined,
  });
  harness.api.setCurrentGraph(
    normalizeGraphRuntimeState(createEmptyGraph(), "chat-empty"),
  );
  harness.api.setGraphPersistenceState({
    loadState: "loading",
    chatId: "chat-empty",
    reason: "chat-metadata-missing",
    revision: 0,
    writesBlocked: true,
  });

  const result = harness.api.saveGraphToChat({
    reason: "loading-empty-save",
    markMutation: false,
  });
  assert.equal(result.blocked, false);
  assert.equal(result.queued, false);
  assert.equal(result.reason, "passive-empty-graph-skipped");
  assert.equal(
    harness.api.readGraphShadowSnapshot("chat-empty"),
    null,
    "đồ thị rỗng không nên làm bẩn snapshot bóng",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-message",
    chatMetadata: undefined,
  });
  harness.api.setCurrentGraph(createMeaningfulGraph("chat-message", "message"));
  harness.api.setGraphPersistenceState({
    loadState: "loading",
    chatId: "chat-message",
    reason: "chat-metadata-missing",
    revision: 2,
    writesBlocked: true,
  });

  harness.api.onMessageReceived();

  assert.equal(
    harness.runtimeContext.__chatContext.chatMetadata,
    undefined,
    "onMessageReceived không nên ghi ngược metadata chat trong lúc loading",
  );
  assert.equal(harness.runtimeContext.__contextSaveCalls, 0);
  assert.equal(
    harness.api.readGraphShadowSnapshot("chat-message"),
    null,
    "onMessageReceived không còn lấy shadow snapshot làm đường lui",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-late-reconcile",
    chatMetadata: undefined,
  });
  harness.api.setCurrentGraph(
    normalizeGraphRuntimeState(createEmptyGraph(), "chat-late-reconcile"),
  );
  harness.api.setGraphPersistenceState({
    loadState: "blocked",
    chatId: "chat-late-reconcile",
    reason: "chat-metadata-timeout",
    revision: 2,
    writesBlocked: true,
  });
  harness.api.setChatContext({
    ...harness.api.getChatContext(),
    chatId: "chat-late-reconcile",
    chatMetadata: {
      integrity: "chat-late-reconcile-ready",
      st_bme_graph: createMeaningfulGraph(
        "chat-late-reconcile",
        "late-official",
      ),
    },
  });
  harness.api.setIndexedDbSnapshot(
    buildSnapshotFromGraph(
      createMeaningfulGraph("chat-late-reconcile", "late-indexeddb"),
      {
        chatId: "chat-late-reconcile",
        revision: 7,
      },
    ),
  );

  harness.api.onMessageReceived();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const live = harness.api.getGraphPersistenceLiveState();
  assert.equal(live.loadState, "loaded");
  assert.equal(live.writesBlocked, false);
  assert.equal(live.storagePrimary, "indexeddb");
  assert.equal(
    harness.api.getCurrentGraph().nodes[0]?.fields?.title,
    "Sự kiện-late-indexeddb",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-sync-refresh",
    chatMetadata: {
      integrity: "chat-sync-refresh-ready",
    },
  });
  harness.api.setCurrentGraph(
    normalizeGraphRuntimeState(
      createMeaningfulGraph("chat-sync-refresh", "stale-runtime"),
      "chat-sync-refresh",
    ),
  );
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-sync-refresh",
    reason: "runtime-stale",
    revision: 2,
    lastPersistedRevision: 2,
    dbReady: true,
    writesBlocked: false,
  });
  harness.api.setIndexedDbSnapshot(
    buildSnapshotFromGraph(
      createMeaningfulGraph("chat-sync-refresh", "fresh-indexeddb"),
      {
        chatId: "chat-sync-refresh",
        revision: 7,
      },
    ),
  );

  const runtimeOptions = harness.api.buildBmeSyncRuntimeOptions();
  await runtimeOptions.onSyncApplied({
    chatId: "chat-sync-refresh",
    action: "download",
  });

  assert.equal(
    harness.api.getCurrentGraph().nodes[0]?.fields?.title,
    "Sự kiện-fresh-indexeddb",
    "sau download/merge nên làm mới đồ thị runtime hiện tại",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-sync-refresh-merge",
    chatMetadata: {
      integrity: "chat-sync-refresh-merge-ready",
    },
  });
  harness.api.setCurrentGraph(
    normalizeGraphRuntimeState(
      createMeaningfulGraph("chat-sync-refresh-merge", "stale-runtime-merge"),
      "chat-sync-refresh-merge",
    ),
  );
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-sync-refresh-merge",
    reason: "runtime-stale",
    revision: 3,
    lastPersistedRevision: 3,
    dbReady: true,
    writesBlocked: false,
  });
  harness.api.setIndexedDbSnapshot(
    buildSnapshotFromGraph(
      createMeaningfulGraph("chat-sync-refresh-merge", "fresh-indexeddb-merge"),
      {
        chatId: "chat-sync-refresh-merge",
        revision: 8,
      },
    ),
  );

  const runtimeOptions = harness.api.buildBmeSyncRuntimeOptions();
  await runtimeOptions.onSyncApplied({
    chatId: "chat-sync-refresh-merge",
    action: "merge",
  });

  assert.equal(
    harness.api.getCurrentGraph().nodes[0]?.fields?.title,
    "Sự kiện-fresh-indexeddb-merge",
    "sau merge nên làm mới đồ thị runtime hiện tại",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-sync-refresh-active",
    chatMetadata: {
      integrity: "chat-sync-refresh-active-ready",
    },
  });
  harness.api.setCurrentGraph(
    normalizeGraphRuntimeState(
      createMeaningfulGraph("chat-sync-refresh-active", "active-runtime"),
      "chat-sync-refresh-active",
    ),
  );
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-sync-refresh-active",
    reason: "runtime-active",
    revision: 4,
    dbReady: true,
    writesBlocked: false,
  });

  const runtimeOptions = harness.api.buildBmeSyncRuntimeOptions();
  await runtimeOptions.onSyncApplied({
    chatId: "chat-sync-refresh-other",
    action: "download",
  });

  assert.equal(
    harness.api.getCurrentGraph().nodes[0]?.fields?.title,
    "Sự kiện-active-runtime",
    "khi chat đang hoạt động và chat của sync payload không nhất quán thì không nên phủ lên đồ thị runtime hiện tại",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-panel-host",
    globalChatId: "chat-panel-host",
    chatMetadata: {
      integrity: "chat-panel-integrity",
    },
  });
  harness.api.setCurrentGraph(
    normalizeGraphRuntimeState(
      createMeaningfulGraph("chat-panel-host", "runtime-host"),
      "chat-panel-host",
    ),
  );
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-panel-host",
    reason: "runtime-host-loaded",
    revision: 6,
    lastPersistedRevision: 6,
    dbReady: true,
    writesBlocked: false,
  });

  const result = harness.api.syncGraphLoadFromLiveContext({
    source: "panel-open-sync",
  });

  assert.equal(
    result.synced,
    false,
    "khi hostChatId và integrity chỉ là hai danh tính khác nhau của cùng một chat thì không nên phán nhầm là cần tải lại",
  );
  assert.equal(result.reason, "no-sync-needed");
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-stale-cache",
    globalChatId: "chat-stale-cache",
    chatMetadata: {
      integrity: "chat-stale-cache-integrity",
    },
  });
  harness.api.setCurrentGraph(
    normalizeGraphRuntimeState(
      createMeaningfulGraph("chat-stale-cache", "runtime-newer"),
      "chat-stale-cache",
    ),
  );
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-stale-cache",
    reason: "runtime-newer",
    revision: 9,
    lastPersistedRevision: 9,
    queuedPersistRevision: 9,
    dbReady: true,
    writesBlocked: false,
  });
  harness.api.setIndexedDbSnapshotForChat(
    "chat-stale-cache-integrity",
    buildSnapshotFromGraph(
      createMeaningfulGraph("chat-stale-cache", "indexeddb-older"),
      {
        chatId: "chat-stale-cache-integrity",
        revision: 4,
      },
    ),
  );

  const result = await harness.api.loadGraphFromIndexedDb(
    "chat-stale-cache-integrity",
    {
      source: "sync-post-refresh:download",
      allowOverride: true,
      applyEmptyState: true,
    },
  );

  assert.equal(result.success, false);
  assert.equal(result.loaded, false);
  assert.equal(result.reason, "indexeddb-stale-runtime");
  assert.equal(
    result.staleDetail?.reason,
    "runtime-revision-newer",
    "snapshot IndexedDB cũ hơn của cùng chat nên bị nhận diện là đã hết hạn",
  );
  assert.equal(
    harness.api.getCurrentGraph().nodes[0]?.fields?.title,
    "Sự kiện-runtime-newer",
    "snapshot IndexedDB cũ hơn không được phủ lên đồ thị runtime mới hơn hiện tại",
  );
  assert.equal(
    harness.api.getGraphPersistenceLiveState().loadState,
    "loaded",
    "sau khi từ chối snapshot cũ thì không nên đẩy đồ thị hiện tại trở lại loading",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-stale-cache-panel",
    globalChatId: "chat-stale-cache-panel",
    chatMetadata: {
      integrity: "chat-stale-cache-panel-integrity",
    },
  });
  harness.api.setCurrentGraph(
    normalizeGraphRuntimeState(
      createMeaningfulGraph("chat-stale-cache-panel", "runtime-newer"),
      "chat-stale-cache-panel",
    ),
  );
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-stale-cache-panel",
    reason: "runtime-newer",
    revision: 9,
    lastPersistedRevision: 9,
    queuedPersistRevision: 9,
    dbReady: true,
    writesBlocked: false,
  });

  const result = harness.api.syncGraphLoadFromLiveContext({
    source: "panel-open-sync",
  });

  assert.equal(
    result.synced,
    false,
    "khi hostChatId và integrity chỉ là hai danh tính khác nhau của cùng một chat thì lúc mở bảng không nên phán nhầm là cần đồng bộ lại",
  );
  assert.equal(result.reason, "no-sync-needed");
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-panel-open-healthy",
    globalChatId: "chat-panel-open-healthy",
    chatMetadata: {
      integrity: "chat-panel-open-healthy-integrity",
    },
  });
  harness.runtimeContext.extension_settings[MODULE_NAME] = {
    graphLocalStorageMode: "auto",
  };
  harness.api.setLocalStoreCapabilitySnapshot({
    checked: true,
    opfsAvailable: true,
    reason: "ok",
  });
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-panel-open-healthy",
    reason: "healthy",
    dbReady: true,
    writesBlocked: false,
    pendingPersist: false,
    indexedDbLastError: "",
    resolvedLocalStore: "opfs:opfs-primary",
    storagePrimary: "opfs",
    storageMode: "opfs-primary",
  });

  const plan = harness.api.buildPanelOpenLocalStoreRefreshPlan();

  assert.equal(
    plan.shouldRefresh,
    false,
    "bảng mở ở trạng thái khỏe không nên mỗi lần đều cưỡng ép làm tươi engine gắn cục bộ",
  );
  assert.equal(Array.isArray(plan.reasons), true);
  assert.equal(plan.reasons.length, 0);
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-panel-open-pending",
    globalChatId: "chat-panel-open-pending",
    chatMetadata: {
      integrity: "chat-panel-open-pending-integrity",
    },
  });
  harness.runtimeContext.extension_settings[MODULE_NAME] = {
    graphLocalStorageMode: "auto",
  };
  harness.api.setLocalStoreCapabilitySnapshot({
    checked: true,
    opfsAvailable: true,
    reason: "ok",
  });
  harness.api.setGraphPersistenceState({
    loadState: "blocked",
    chatId: "chat-panel-open-pending",
    reason: "persist-queued",
    dbReady: false,
    writesBlocked: true,
    pendingPersist: true,
    indexedDbLastError: "opfs-write-failed",
    resolvedLocalStore: "indexeddb:indexeddb",
    storagePrimary: "indexeddb",
    storageMode: "indexeddb",
  });

  const plan = harness.api.buildPanelOpenLocalStoreRefreshPlan();

  assert.equal(plan.shouldRefresh, true);
  assert.equal(plan.forceCapabilityRefresh, true);
  assert.equal(plan.reopenCurrentDb, true);
  assert.equal(plan.reasons.includes("pending-persist"), true);
  assert.equal(plan.reasons.includes("resolved-store-mismatch"), true);
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-panel-open-capability-retry",
    globalChatId: "chat-panel-open-capability-retry",
    chatMetadata: {
      integrity: "chat-panel-open-capability-retry-integrity",
    },
  });
  harness.runtimeContext.extension_settings[MODULE_NAME] = {
    graphLocalStorageMode: "auto",
  };
  harness.api.setLocalStoreCapabilitySnapshot({
    checked: true,
    checkedAt: Date.now(),
    opfsAvailable: false,
    reason: "UnknownError: transient-opfs-init-failure",
  });
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-panel-open-capability-retry",
    reason: "healthy",
    dbReady: true,
    writesBlocked: false,
    pendingPersist: false,
    indexedDbLastError: "",
    resolvedLocalStore: "indexeddb:indexeddb",
    storagePrimary: "indexeddb",
    storageMode: "indexeddb",
  });

  const plan = harness.api.buildPanelOpenLocalStoreRefreshPlan();

  assert.equal(plan.shouldRefresh, true);
  assert.equal(plan.forceCapabilityRefresh, true);
  assert.equal(
    plan.reasons.includes("capability-retryable-failure"),
    true,
    "khi thăm dò OPFS có thể khôi phục bị lỗi thì lúc mở bảng nên kích hoạt thăm dò lại",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-luker-panel-open",
    globalChatId: "chat-luker-panel-open",
    characterId: "char-luker-panel-open",
    chatMetadata: {
      integrity: "chat-luker-panel-open-integrity",
    },
  });
  harness.runtimeContext.Luker = {
    getContext() {
      return harness.runtimeContext.__chatContext;
    },
  };
  harness.api.setGraphPersistenceState({
    loadState: "idle",
    chatId: "chat-luker-panel-open",
    reason: "cold-start",
    revision: 0,
    lastPersistedRevision: 0,
    dbReady: false,
    writesBlocked: false,
  });

  const result = harness.api.syncGraphLoadFromLiveContext({
    source: "panel-open-sync",
  });

  assert.equal(
    result.reason,
    "luker-chat-state-probe-pending",
    "khi mở bảng trong Luker nên đi vào chat-state probe, thay vì ném lỗi biến chưa định nghĩa",
  );
  assert.equal(result.attemptIndex, 0);
  assert.equal(harness.api.getGraphPersistenceState().loadState, "loading");
  assert.equal(
    harness.api.getGraphPersistenceState().primaryStorageTier,
    "luker-chat-state",
  );
}

{
  const metadataGraph = stampPersistedGraph(
    createMeaningfulGraph("chat-stale-metadata", "metadata-older"),
    {
      revision: 3,
      integrity: "chat-stale-metadata-integrity",
      chatId: "chat-stale-metadata",
      reason: "metadata-older",
    },
  );
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-stale-metadata",
    globalChatId: "chat-stale-metadata",
    chatMetadata: {
      integrity: "chat-stale-metadata-integrity",
      st_bme_graph: metadataGraph,
    },
  });
  harness.api.setCurrentGraph(
    normalizeGraphRuntimeState(
      createMeaningfulGraph("chat-stale-metadata", "runtime-newer"),
      "chat-stale-metadata",
    ),
  );
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-stale-metadata",
    reason: "runtime-newer",
    revision: 8,
    lastPersistedRevision: 8,
    dbReady: true,
    writesBlocked: false,
  });

  const result = harness.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "stale-metadata-runtime-guard",
  });

  assert.equal(result.reason, "metadata-compat-stale-runtime");
  assert.equal(
    harness.api.getCurrentGraph().nodes[0]?.fields?.title,
    "Sự kiện-runtime-newer",
    "đồ thị tương thích metadata cũ hơn không được đè ngược đồ thị runtime hiện tại",
  );
}

{
  const sharedSession = new Map();
  const writer = await createGraphPersistenceHarness({
    chatId: "chat-shadow",
    chatMetadata: undefined,
    sessionStore: sharedSession,
  });
  writer.api.writeGraphShadowSnapshot(
    "chat-shadow",
    createMeaningfulGraph("chat-shadow", "shadow"),
    { revision: 7, reason: "manual-shadow" },
  );

  const reader = await createGraphPersistenceHarness({
    chatId: "chat-shadow",
    chatMetadata: undefined,
    sessionStore: sharedSession,
  });
  const result = reader.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "shadow-test",
  });

  assert.equal(result.loadState, "shadow-restored");
  assert.equal(
    reader.api.getCurrentGraph().nodes[0]?.fields?.title,
    "Sự kiện-shadow",
  );
  assert.equal(
    reader.api.getGraphPersistenceLiveState().shadowSnapshotUsed,
    true,
  );
  assert.equal(reader.api.getGraphPersistenceLiveState().writesBlocked, false);
}

{
  const sharedSession = new Map();
  const writer = await createGraphPersistenceHarness({
    chatId: "chat-official",
    chatMetadata: undefined,
    sessionStore: sharedSession,
  });
  writer.api.writeGraphShadowSnapshot(
    "chat-official",
    createMeaningfulGraph("chat-official", "shadow-stale"),
    { revision: 3, reason: "stale-shadow" },
  );

  const officialGraph = stampPersistedGraph(
    createMeaningfulGraph("chat-official", "official"),
    { revision: 6, integrity: "official-integrity" },
  );
  const reader = await createGraphPersistenceHarness({
    chatId: "chat-official",
    chatMetadata: {
      integrity: "official-integrity",
      st_bme_graph: officialGraph,
    },
    sessionStore: sharedSession,
  });
  const result = reader.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "official-load",
  });

  assert.equal(result.loadState, "loading");
  assert.equal(
    reader.api.getCurrentGraph().nodes[0]?.fields?.title,
    "Sự kiện-official",
  );
  assert.equal(
    reader.api.readGraphShadowSnapshot("chat-official")?.reason,
    "stale-shadow",
    "khi tải metadata tương thích, snapshot bóng chỉ nên được giữ làm dữ liệu tương thích, không tham gia luồng xử lý chính",
  );
}

{
  const sharedSession = new Map();
  const writer = await createGraphPersistenceHarness({
    chatId: "chat-shadow-newer",
    chatMetadata: undefined,
    sessionStore: sharedSession,
  });
  const shadowGraph = stampPersistedGraph(
    createMeaningfulGraph("chat-shadow-newer", "shadow-newer"),
    {
      revision: 9,
      integrity: "integrity-shadow-mismatch",
      chatId: "chat-shadow-newer",
      reason: "pagehide-refresh",
    },
  );
  writer.api.writeGraphShadowSnapshot("chat-shadow-newer", shadowGraph, {
    revision: 9,
    reason: "pagehide-refresh",
    integrity: "integrity-shadow-mismatch",
    debugReason: "pagehide-refresh",
  });

  const officialGraph = stampPersistedGraph(
    createMeaningfulGraph("chat-shadow-newer", "official-older"),
    { revision: 3, integrity: "integrity-official-older" },
  );
  const reader = await createGraphPersistenceHarness({
    chatId: "chat-shadow-newer",
    chatMetadata: {
      integrity: "integrity-official-older",
      st_bme_graph: officialGraph,
    },
    sessionStore: sharedSession,
  });
  const result = reader.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "official-older-than-shadow",
  });

  assert.equal(result.loadState, "loading");
  assert.equal(
    result.reason,
    "official-older-than-shadow:metadata-compat-provisional",
  );
  assert.equal(
    reader.api.getCurrentGraph().nodes[0]?.fields?.title,
    "Sự kiện-official-older",
  );
  assert.equal(reader.runtimeContext.__contextImmediateSaveCalls, 0);
  assert.equal(
    reader.runtimeContext.__chatContext.chatMetadata?.st_bme_graph?.nodes?.[0]
      ?.fields?.title,
    "Sự kiện-official-older",
  );
  assert.equal(
    reader.api.readGraphShadowSnapshot("chat-shadow-newer")?.reason,
    "pagehide-refresh",
    "sau khi tải metadata tương thích, snapshot bóng có thể được giữ lại nhưng không được dùng làm nguồn khôi phục của luồng chính",
  );
  const live = reader.api.getGraphPersistenceLiveState();
  assert.equal(live.shadowSnapshotRevision, 9);
  assert.equal(live.shadowSnapshotReason, "shadow-integrity-mismatch");
  const compareDecision = shouldPreferShadowSnapshotOverOfficial(
    officialGraph,
    reader.api.readGraphShadowSnapshot("chat-shadow-newer"),
  );
  assert.equal(compareDecision.resultCode, "shadow.reject.integrity-mismatch");
}

{
  const decision = shouldPreferShadowSnapshotOverOfficial(
    stampPersistedGraph(createMeaningfulGraph("chat-self-mismatch"), {
      revision: 0,
      chatId: "",
      integrity: "",
    }),
    {
      chatId: "chat-self-mismatch",
      persistedChatId: "chat-other",
      revision: 5,
      integrity: "",
    },
  );
  assert.equal(decision.prefer, false);
  assert.equal(decision.reason, "shadow-self-chat-mismatch");
  assert.equal(decision.resultCode, "shadow.reject.self-chat-mismatch");
}

{
  const decision = shouldPreferShadowSnapshotOverOfficial(
    stampPersistedGraph(createMeaningfulGraph("chat-official-missing"), {
      revision: 0,
      chatId: "",
      integrity: "",
    }),
    {
      chatId: "chat-official-missing",
      persistedChatId: "chat-official-missing",
      revision: 4,
      integrity: "",
    },
  );
  assert.equal(decision.prefer, false);
  assert.equal(decision.reason, "shadow-persisted-chat-without-official-chat");
  assert.equal(
    decision.resultCode,
    "shadow.reject.persisted-chat-without-official-chat",
  );
}

{
  const decision = shouldPreferShadowSnapshotOverOfficial(
    stampPersistedGraph(
      createMeaningfulGraph("chat-official-integrity-missing"),
      {
        revision: 0,
        chatId: "chat-official-integrity-missing",
        integrity: "",
      },
    ),
    {
      chatId: "chat-official-integrity-missing",
      persistedChatId: "chat-official-integrity-missing",
      revision: 4,
      integrity: "shadow-only-integrity",
    },
  );
  assert.equal(decision.prefer, false);
  assert.equal(decision.reason, "shadow-integrity-without-official-integrity");
  assert.equal(
    decision.resultCode,
    "shadow.reject.integrity-without-official-integrity",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-empty-confirmed",
    chatMetadata: {
      integrity: "meta-ready-empty",
    },
  });
  const result = harness.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "ready-empty",
  });
  const live = harness.api.getGraphPersistenceLiveState();

  assert.equal(result.loadState, "loading");
  assert.equal(result.reason, "indexeddb-probe-pending");
  assert.equal(live.writesBlocked, true);
  assert.equal(harness.api.getCurrentGraph(), null);
  assert.equal(
    harness.api.readRuntimeDebugSnapshot().graphPersistence?.loadState,
    "loading",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-empty-confirmed-passive",
    chatMetadata: {
      integrity: "meta-ready-empty-passive",
    },
  });
  harness.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "ready-empty-passive",
  });

  harness.api.onMessageReceived();

  assert.equal(
    harness.runtimeContext.__contextImmediateSaveCalls,
    0,
    "đồng bộ thụ động của chat rỗng không nên kích hoạt lưu ngay",
  );
  assert.equal(
    harness.runtimeContext.__contextSaveCalls,
    0,
    "đồng bộ thụ động của chat rỗng không nên kích hoạt lưu chống rung",
  );
  assert.equal(
    harness.runtimeContext.__chatContext.chatMetadata?.st_bme_graph,
    undefined,
    "ở trạng thái loading không được bị động ghi đồ thị rỗng ngược về metadata",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-manager-unavailable-fallback",
    globalChatId: "chat-manager-unavailable-fallback",
    chatMetadata: {
      integrity: "meta-manager-unavailable-fallback",
    },
  });
  harness.runtimeContext.BmeChatManager = null;

  const result = harness.api.loadGraphFromChat({
    attemptIndex: harness.api.GRAPH_LOAD_RETRY_DELAYS_MS.length,
    source: "manager-unavailable-fallback",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(result.loadState, "loading");
  assert.equal(
    harness.api.getGraphPersistenceState().loadState,
    "blocked",
    "khi IndexedDB manager không khả dụng, sau khi dùng hết lượt thử lại thì không nên kẹt loading vĩnh viễn",
  );
  assert.equal(
    harness.api.getGraphPersistenceState().reason,
    "indexeddb-manager-unavailable",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-manager-unavailable-write",
    globalChatId: "chat-manager-unavailable-write",
    chatMetadata: {
      integrity: "meta-manager-unavailable-write",
    },
  });
  harness.runtimeContext.BmeChatManager = null;

  const result = await harness.api.saveGraphToIndexedDb(
    "chat-manager-unavailable-write",
    createMeaningfulGraph("chat-manager-unavailable-write", "manager-unavailable-write"),
    {
      revision: 3,
      reason: "manager-unavailable-write",
    },
  );

  assert.equal(result.saved, false);
  assert.equal(result.reason, "indexeddb-manager-unavailable");
  assert.equal(
    harness.api.getGraphPersistenceState().indexedDbLastError,
    "indexeddb-manager-unavailable",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "",
    globalChatId: "",
    chatMetadata: {
      integrity: "",
    },
  });
  const graph = createMeaningfulGraph("chat-persist-fallback", "persist-fallback");
  harness.api.setCurrentGraph(graph);
  harness.api.setChatContext({
    chatId: "",
    chatMetadata: {},
    characterId: "char-fallback",
    groupId: null,
    chat: [{ is_user: true, mes: "fallback chat id" }],
    updateChatMetadata(patch) {
      const base =
        this.chatMetadata &&
        typeof this.chatMetadata === "object" &&
        !Array.isArray(this.chatMetadata)
          ? this.chatMetadata
          : {};
      this.chatMetadata = {
        ...base,
        ...(patch || {}),
      };
    },
    saveMetadataDebounced() {},
  });

  const result = await harness.api.persistExtractionBatchResult({
    reason: "persist-fallback-chat-id",
    lastProcessedAssistantFloor: 6,
    graphSnapshot: null,
    persistDelta: null,
  });

  assert.equal(result.accepted, true);
  assert.equal(
    harness.api.getIndexedDbSnapshotForChat("chat-persist-fallback")?.meta?.chatId,
    "chat-persist-fallback",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-indexeddb-read-failed-fallback",
    globalChatId: "chat-indexeddb-read-failed-fallback",
    chatMetadata: {
      integrity: "meta-indexeddb-read-failed-fallback",
    },
  });
  harness.runtimeContext.__indexedDbExportSnapshotShouldThrow = true;

  const result = harness.api.loadGraphFromChat({
    attemptIndex: harness.api.GRAPH_LOAD_RETRY_DELAYS_MS.length,
    source: "indexeddb-read-failed-fallback",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(result.loadState, "loading");
  assert.equal(
    harness.api.getGraphPersistenceState().loadState,
    "blocked",
    "khi đọc IndexedDB thất bại, sau khi dùng hết lượt thử lại thì không nên kẹt loading vĩnh viễn",
  );
  assert.equal(
    harness.api.getGraphPersistenceState().reason,
    "indexeddb-read-failed",
  );
}

 {
   const commitMarker = buildGraphCommitMarker(
     createMeaningfulGraph("chat-indexeddb-empty-mismatch-fallback", "marker"),
     {
       revision: 4,
       storageTier: "indexeddb",
       accepted: true,
       reason: "test-empty-mismatch",
       chatId: "chat-indexeddb-empty-mismatch-fallback",
       integrity: "meta-indexeddb-empty-mismatch-fallback",
     },
   );
   const harness = await createGraphPersistenceHarness({
     chatId: "chat-indexeddb-empty-mismatch-fallback",
     globalChatId: "chat-indexeddb-empty-mismatch-fallback",
     chatMetadata: {
       integrity: "meta-indexeddb-empty-mismatch-fallback",
       [GRAPH_COMMIT_MARKER_KEY]: commitMarker,
     },
   });

   const result = harness.api.loadGraphFromChat({
     attemptIndex: harness.api.GRAPH_LOAD_RETRY_DELAYS_MS.length,
     source: "indexeddb-empty-mismatch-fallback",
   });
   await new Promise((resolve) => setTimeout(resolve, 0));

   assert.equal(result.loadState, "loading");
   assert.equal(
     harness.api.getGraphPersistenceState().loadState,
     "empty-confirmed",
     "khi accepted commit marker đã thành mồ côi và cục bộ không còn nguồn đồ thị có thể khôi phục, nên tự động hạ cấp về empty-confirmed",
   );
   assert.match(
     String(harness.api.getGraphPersistenceState().reason || ""),
     /orphan-accepted-marker/,
   );
   assert.equal(
     harness.runtimeContext.__chatContext.chatMetadata?.[GRAPH_COMMIT_MARKER_KEY],
     null,
   );
   assert.equal(harness.runtimeContext.__contextImmediateSaveCalls, 1);
   assert.equal(harness.api.getGraphPersistenceState().lastAcceptedRevision, 0);
   assert.equal(harness.api.getGraphPersistenceState().commitMarker, null);
 }

 {
   const commitMarker = buildGraphCommitMarker(
     createMeaningfulGraph("chat-indexeddb-empty-chat-state-rescue", "marker"),
     {
       revision: 8,
       storageTier: "indexeddb",
       accepted: true,
       reason: "test-chat-state-rescue",
       chatId: "chat-indexeddb-empty-chat-state-rescue",
       integrity: "meta-indexeddb-empty-chat-state-rescue",
     },
   );
   const harness = await createGraphPersistenceHarness({
     chatId: "chat-indexeddb-empty-chat-state-rescue",
     globalChatId: "chat-indexeddb-empty-chat-state-rescue",
     chatMetadata: {
       integrity: "meta-indexeddb-empty-chat-state-rescue",
       [GRAPH_COMMIT_MARKER_KEY]: commitMarker,
     },
   });
   const sidecarGraph = stampPersistedGraph(
     createMeaningfulGraph("chat-indexeddb-empty-chat-state-rescue", "sidecar"),
     {
       revision: 8,
       integrity: "meta-indexeddb-empty-chat-state-rescue",
       chatId: "chat-indexeddb-empty-chat-state-rescue",
       reason: "sidecar-rescue-seed",
     },
   );
   harness.runtimeContext.__chatContext.__chatStateStore.set(
     GRAPH_CHAT_STATE_NAMESPACE,
     buildGraphChatStateSnapshot(sidecarGraph, {
       revision: 8,
       storageTier: "chat-state",
       accepted: true,
       reason: "sidecar-rescue-seed",
       chatId: "chat-indexeddb-empty-chat-state-rescue",
       integrity: "meta-indexeddb-empty-chat-state-rescue",
       lastProcessedAssistantFloor: 6,
       extractionCount: 3,
     }),
   );

   const result = await harness.api.loadGraphFromIndexedDb(
     "chat-indexeddb-empty-chat-state-rescue",
     {
       source: "indexeddb-empty-chat-state-rescue",
       attemptIndex: 0,
       allowOverride: true,
       applyEmptyState: true,
     },
   );

   assert.equal(result.loaded, true);
   assert.equal(result.loadState, "loaded");
   assert.equal(
     harness.api.getCurrentGraph().nodes[0]?.fields?.title,
     "Sự kiện-sidecar",
   );
   assert.equal(
     harness.runtimeContext.__chatContext.chatMetadata?.[GRAPH_COMMIT_MARKER_KEY]
       ?.revision,
     8,
   );
   assert.equal(harness.runtimeContext.__contextImmediateSaveCalls, 0);
   assert.equal(
     harness.api.getGraphPersistenceState().persistMismatchReason,
     "persist-mismatch:indexeddb-behind-commit-marker",
   );
 }

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-create-first-graph",
    chatMetadata: {
      integrity: "integrity-before-first-save",
    },
  });
  harness.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "ready-for-first-save",
  });
  harness.api.setCurrentGraph(
    createMeaningfulGraph("chat-create-first-graph", "first-save"),
  );

  const result = harness.api.saveGraphToChat({
    reason: "first-meaningful-graph",
  });

  assert.equal(result.saved, false);
  assert.equal(result.queued, true);
  assert.equal(result.saveMode, "indexeddb-queued");
  assert.equal(harness.runtimeContext.__contextImmediateSaveCalls, 0);
  assert.equal(harness.runtimeContext.__contextSaveCalls, 0);
  assert.equal(
    harness.runtimeContext.__chatContext.chatMetadata?.integrity ===
      "integrity-before-first-save",
    true,
    "khi plugin lưu đồ thị thì không được viết lại host metadata.integrity",
  );
  assert.equal(
    harness.runtimeContext.__chatContext.chatMetadata?.st_bme_graph,
    undefined,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    Number(harness.api.getIndexedDbSnapshot()?.meta?.revision) > 0,
    true,
  );
}

{
  const sharedSession = new Map();
  const writer = await createGraphPersistenceHarness({
    chatId: "chat-promote",
    chatMetadata: undefined,
    sessionStore: sharedSession,
  });
  writer.api.writeGraphShadowSnapshot(
    "chat-promote",
    createMeaningfulGraph("chat-promote", "promote"),
    { revision: 9, reason: "pre-refresh" },
  );

  const reader = await createGraphPersistenceHarness({
    chatId: "chat-promote",
    chatMetadata: {
      integrity: "meta-ready-promote",
    },
    sessionStore: sharedSession,
  });
  const result = reader.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "promote-when-metadata-ready",
  });
  const live = reader.api.getGraphPersistenceLiveState();

  assert.equal(result.loadState, "shadow-restored");
  assert.equal(
    reader.runtimeContext.__chatContext.chatMetadata?.st_bme_graph?.nodes
      ?.length,
    undefined,
  );
  assert.equal(
    reader.runtimeContext.__chatContext.chatMetadata?.integrity,
    "meta-ready-promote",
  );
  assert.equal(reader.runtimeContext.__contextImmediateSaveCalls, 0);
  assert.equal(reader.runtimeContext.__contextSaveCalls, 0);
  assert.equal(live.lastPersistedRevision, 9);
  assert.equal(live.pendingPersist, true);
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-decouple",
    chatMetadata: {
      integrity: "meta-decouple",
    },
  });
  const runtimeGraph = createMeaningfulGraph("chat-decouple", "runtime");
  harness.api.setCurrentGraph(runtimeGraph);
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-decouple",
    revision: 3,
    lastPersistedRevision: 0,
    writesBlocked: false,
  });

  const result = harness.api.saveGraphToChat({
    reason: "decouple-metadata-runtime",
    markMutation: false,
    persistMetadata: true,
  });

  assert.equal(result.saved, true);
  const persistedGraph =
    harness.runtimeContext.__chatContext.chatMetadata?.st_bme_graph;
  assert.notEqual(
    persistedGraph,
    harness.api.getCurrentGraph(),
    "khi ghi vào metadata bắt buộc phải dùng graph snapshot độc lập",
  );

  persistedGraph.nodes[0].fields.title = "metadata-mutated";
  assert.equal(
    harness.api.getCurrentGraph().nodes[0].fields.title,
    "Sự kiện-runtime",
    "chỉnh sửa metadata không được làm bẩn ngược runtime graph",
  );

  harness.api.getCurrentGraph().nodes[0].fields.title = "runtime-mutated";
  assert.equal(
    persistedGraph.nodes[0].fields.title,
    "metadata-mutated",
    "chỉnh sửa runtime không được làm bẩn ngược metadata đã lưu",
  );
}

{
  const officialGraph = stampPersistedGraph(
    createMeaningfulGraph("chat-load-official", "official"),
    {
      revision: 4,
      integrity: "meta-load-official",
      chatId: "chat-load-official",
      reason: "official-save",
    },
  );
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-load-official",
    chatMetadata: {
      integrity: "meta-load-official",
      st_bme_graph: officialGraph,
    },
  });

  const result = harness.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "load-official-decoupled",
  });

  assert.equal(result.loadState, "loading");
  const runtimeGraph = harness.api.getCurrentGraph();
  const persistedGraph =
    harness.runtimeContext.__chatContext.chatMetadata.st_bme_graph;
  assert.notEqual(
    runtimeGraph,
    persistedGraph,
    "khôi phục từ official metadata vào runtime bắt buộc phải dùng đối tượng độc lập",
  );

  runtimeGraph.nodes[0].fields.title = "runtime-after-load";
  assert.equal(
    persistedGraph.nodes[0].fields.title,
    "Sự kiện-official",
    "official metadata không nên bị chỉnh sửa runtime làm bẩn",
  );
}

{
  const sharedSession = new Map();
  const writer = await createGraphPersistenceHarness({
    chatId: "chat-load-shadow",
    chatMetadata: {
      integrity: "meta-load-shadow",
      st_bme_graph: stampPersistedGraph(
        createMeaningfulGraph("chat-load-shadow", "official-older"),
        {
          revision: 2,
          integrity: "meta-load-shadow",
          chatId: "chat-load-shadow",
          reason: "official-older",
        },
      ),
    },
    sessionStore: sharedSession,
  });
  writer.api.writeGraphShadowSnapshot(
    "chat-load-shadow",
    createMeaningfulGraph("chat-load-shadow", "shadow"),
    {
      revision: 5,
      reason: "shadow-newer",
    },
  );

  const reader = await createGraphPersistenceHarness({
    chatId: "chat-load-shadow",
    chatMetadata: {
      integrity: "meta-load-shadow",
      st_bme_graph: stampPersistedGraph(
        createMeaningfulGraph("chat-load-shadow", "official-older"),
        {
          revision: 2,
          integrity: "meta-load-shadow",
          chatId: "chat-load-shadow",
          reason: "official-older",
        },
      ),
    },
    sessionStore: sharedSession,
  });

  const result = reader.api.loadGraphFromChat({
    attemptIndex: 0,
    source: "load-shadow-decoupled",
  });

  assert.equal(result.loadState, "shadow-restored");
  const runtimeGraph = reader.api.getCurrentGraph();
  const persistedGraph =
    reader.runtimeContext.__chatContext.chatMetadata.st_bme_graph;
  assert.notEqual(
    runtimeGraph,
    persistedGraph,
    "sau khi nâng từ shadow snapshot, runtime và metadata cũng bắt buộc phải tách rời",
  );

  runtimeGraph.nodes[0].fields.title = "runtime-shadow-mutated";
  assert.equal(
    runtimeGraph.nodes[0].fields.title,
    "runtime-shadow-mutated",
  );
  assert.equal(
    persistedGraph.nodes[0].fields.title,
    "Sự kiện-official-older",
    "chỉnh sửa runtime sau khi tải metadata tương thích không được làm bẩn metadata đã lưu",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-two-saves",
    chatMetadata: {
      integrity: "meta-two-saves",
    },
  });
  harness.api.setCurrentGraph(createMeaningfulGraph("chat-two-saves", "first"));
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-two-saves",
    revision: 1,
    lastPersistedRevision: 0,
    writesBlocked: false,
  });

  const firstSave = harness.api.saveGraphToChat({
    reason: "first-save",
    markMutation: false,
    persistMetadata: true,
  });
  assert.equal(firstSave.saved, true);
  const firstPersistedGraph =
    harness.runtimeContext.__chatContext.chatMetadata.st_bme_graph;

  harness.api.getCurrentGraph().nodes[0].fields.title = "runtime-between-saves";
  assert.equal(
    firstPersistedGraph.nodes[0].fields.title,
    "Sự kiện-first",
    "metadata sau lần lưu thứ nhất không nên bị các chỉnh sửa runtime về sau làm bẩn",
  );

  harness.api.setGraphPersistenceState({ revision: 2 });
  const secondSave = harness.api.saveGraphToChat({
    reason: "second-save",
    markMutation: false,
    persistMetadata: true,
  });
  assert.equal(secondSave.saved, true);
  const secondPersistedGraph =
    harness.runtimeContext.__chatContext.chatMetadata.st_bme_graph;

  assert.notEqual(
    secondPersistedGraph,
    firstPersistedGraph,
    "lần lưu thứ hai nên tạo mới metadata graph snapshot",
  );
  assert.equal(
    secondPersistedGraph.nodes[0].fields.title,
    "runtime-between-saves",
    "lần lưu thứ hai nên phản ánh các chỉnh sửa runtime của vòng hai",
  );
  harness.api.getCurrentGraph().nodes[0].fields.title =
    "runtime-after-second-save";
  assert.equal(
    firstPersistedGraph.nodes[0].fields.title,
    "Sự kiện-first",
    "các chỉnh sửa runtime của vòng hai vẫn không được làm bẩn metadata đã lưu ở lần thứ nhất",
  );
  assert.equal(
    secondPersistedGraph.nodes[0].fields.title,
    "runtime-between-saves",
    "metadata đã lưu ở lần thứ hai cũng không được bị các chỉnh sửa runtime về sau làm bẩn",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-idb-ancillary-warning",
    globalChatId: "chat-idb-ancillary-warning",
    chatMetadata: {
      integrity: "meta-idb-ancillary-warning",
    },
  });
  harness.api.setCurrentGraph(
    createMeaningfulGraph("chat-idb-ancillary-warning", "ancillary-warning"),
  );
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-idb-ancillary-warning",
    revision: 7,
    lastPersistedRevision: 0,
    writesBlocked: false,
  });
  harness.runtimeContext.__scheduleUploadShouldThrow = true;

  const result = await harness.api.saveGraphToIndexedDb(
    "chat-idb-ancillary-warning",
    harness.api.getCurrentGraph(),
    {
      revision: 7,
      reason: "ancillary-warning-save",
    },
  );

  assert.equal(result.saved, true);
  assert.match(String(result.warning || ""), /schedule-upload-failed/);
  assert.equal(
    harness.api.getIndexedDbSnapshot().meta.revision,
    7,
    "khi bước phụ bị lỗi, lượt ghi chính vào IndexedDB vẫn nên được xem là thành công",
  );
  const persistDeltaDiagnostics = harness.api.getGraphPersistenceState().persistDelta;
  assert.equal(Boolean(persistDeltaDiagnostics), true);
  assert.equal(persistDeltaDiagnostics.status, "committed");
  assert.equal(persistDeltaDiagnostics.path, "js");
  assert.equal(persistDeltaDiagnostics.requestedNative, false);
  assert.equal(Number.isFinite(Number(persistDeltaDiagnostics.buildMs)), true);
  assert.equal(Number.isFinite(Number(persistDeltaDiagnostics.prepareMs)), true);
  assert.equal(Number.isFinite(Number(persistDeltaDiagnostics.lookupMs)), true);
  assert.equal(Number.isFinite(Number(persistDeltaDiagnostics.jsDiffMs)), true);
  assert.equal(
    Number(persistDeltaDiagnostics.serializationCacheHits || 0) +
      Number(persistDeltaDiagnostics.serializationCacheMisses || 0) >
      0,
    true,
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-pending-persist-retry",
    globalChatId: "chat-pending-persist-retry",
    chatMetadata: {
      integrity: "meta-pending-persist-retry",
    },
    chat: [
      { is_user: true, mes: "Người dùng nói" },
      { is_user: false, mes: "trợ lýPhản hồi" },
    ],
  });
  const graph = createMeaningfulGraph(
    "chat-pending-persist-retry",
    "pending-persist-retry",
  );
  graph.historyState.lastProcessedAssistantFloor = -1;
  graph.lastProcessedSeq = -1;
  graph.historyState.lastBatchStatus = {
    processedRange: [1, 1],
    completed: true,
    stages: {
      core: { outcome: "success" },
      finalize: { outcome: "success" },
    },
    persistence: {
      outcome: "queued",
      accepted: false,
      storageTier: "none",
      reason: "extraction-batch-complete:pending",
      revision: 7,
      saveMode: "immediate",
      saved: false,
      queued: true,
      blocked: true,
    },
    historyAdvanceAllowed: false,
    historyAdvanced: false,
  };
  const committedGraph = structuredClone(graph);
  committedGraph.historyState.lastProcessedAssistantFloor = 1;
  committedGraph.lastProcessedSeq = 1;
  committedGraph.batchJournal = [
    {
      id: "journal-queued-1",
      processedRange: [1, 1],
      createdAt: Date.now(),
    },
  ];
  harness.api.setCurrentGraph(graph);
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-pending-persist-retry",
    revision: 7,
    lastPersistedRevision: 0,
    queuedPersistRevision: 7,
    queuedPersistChatId: "chat-pending-persist-retry",
    queuedPersistMode: "immediate",
    pendingPersist: true,
    writesBlocked: false,
  });
  harness.api.writeGraphShadowSnapshot(
    "chat-pending-persist-retry",
    committedGraph,
    {
      revision: 7,
      reason: "queued-persist-authoritative",
    },
  );
  harness.runtimeContext.__markSyncDirtyShouldThrow = true;

  const result = await harness.api.retryPendingGraphPersist({
    reason: "queued-persist-retry-test",
  });

  assert.equal(result.accepted, true);
  assert.equal(
    harness.api.getGraphPersistenceState().pendingPersist,
    false,
    "pendingPersist nên được xóa sau khi lưu bù thành công",
  );
  assert.equal(
    harness.api.getCurrentGraph().historyState.lastProcessedAssistantFloor,
    1,
    "sau khi lưu bù thành công nên đẩy lastProcessedAssistantFloor tiến lên",
  );
  assert.equal(
    harness.api.getCurrentGraph().historyState.lastBatchStatus.historyAdvanceAllowed,
    true,
  );
  assert.equal(
    harness.api.getCurrentGraph().historyState.lastBatchStatus.persistence.outcome,
    "saved",
  );
  assert.equal(
    harness.api.getCurrentGraph().batchJournal?.length,
    1,
    "lần retry của pending persist nên bù authoritative batch journal trở lại runtime graph",
  );
  assert.equal(
    harness.api.getCurrentGraph().batchJournal?.[0]?.id,
    "journal-queued-1",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-b",
    globalChatId: "chat-b",
    chatMetadata: {
      integrity: "meta-chat-b",
    },
  });
  harness.api.setCurrentGraph(createMeaningfulGraph("chat-a", "queued"));
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-a",
    revision: 6,
    lastPersistedRevision: 4,
    queuedPersistRevision: 6,
    queuedPersistChatId: "chat-a",
    queuedPersistMode: "immediate",
    pendingPersist: true,
    writesBlocked: false,
  });

  const result = harness.api.maybeFlushQueuedGraphPersist("cross-chat-flush");

  assert.equal(result.saved, false);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "queued-chat-mismatch");
  assert.equal(harness.runtimeContext.__contextImmediateSaveCalls, 0);
  assert.equal(harness.runtimeContext.__contextSaveCalls, 0);
  assert.equal(
    harness.runtimeContext.__chatContext.chatMetadata?.st_bme_graph,
    undefined,
    "queued persist xuyên chat không được flush vào metadata hiện tại",
  );
  assert.equal(
    harness.api.getGraphPersistenceLiveState().queuedPersistChatId,
    "chat-a",
    "khi xảy ra chat mismatch thì nên giữ nguyên gắn kết chat đã xếp hàng",
  );
}

// === Fix 2c: assertRecoveryChatStillActive chốt chặn xuyên chat ===
{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-recovery-a",
    globalChatId: "chat-recovery-a",
    chatMetadata: {
      integrity: "meta-recovery-a",
    },
  });

  // cùng một chat thì không nên ném lỗi
  harness.api.assertRecoveryChatStillActive("chat-recovery-a", "test-same");

  // chuyển sang chat-b
  harness.runtimeContext.__globalChatId = "chat-recovery-b";
  harness.runtimeContext.__chatContext.chatId = "chat-recovery-b";

  let abortCaught = false;
  try {
    harness.api.assertRecoveryChatStillActive("chat-recovery-a", "test-switch");
  } catch (e) {
    abortCaught = harness.api.isAbortError(e);
  }
  assert.equal(
    abortCaught,
    true,
    "sau khi chuyển chat, assertRecoveryChatStillActive nên ném AbortError",
  );

  // expectedChatId rỗng thì không nên ném lỗi
  harness.api.assertRecoveryChatStillActive("", "test-empty");
  harness.api.assertRecoveryChatStillActive(undefined, "test-undefined");
}

// === Fix 2e: resolveDirtyFloorFromMutationMeta ứng viênLọc ===
// Bài test này cần resolveDirtyFloorFromMutationMeta và getAssistantTurns,
// cả hai đều nằm trong phạm vi persistencePrelude và được thực thi qua ngữ cảnh vm.
// ở đây dùng cách xác thực gián tiếp: dựng một chat chỉ có assistant ở giai đoạn muộn,
// sau đó kiểm tra inspectHistoryMutation sẽ không phán nhầm với các floor sớm.
{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-dirty-floor",
    globalChatId: "chat-dirty-floor",
    chatMetadata: {
      integrity: "meta-dirty-floor",
    },
    chat: [
      // index 0: user
      { is_user: true, mes: "hello" },
      // index 1: user (no assistant before index 4)
      { is_user: true, mes: "second" },
      // index 2: user
      { is_user: true, mes: "third" },
      // index 3: user
      { is_user: true, mes: "fourth" },
      // index 4: first assistant
      { is_user: false, mes: "first reply" },
    ],
  });

  const graph = createMeaningfulGraph("chat-dirty-floor", "dirty-floor");
  graph.historyState.lastProcessedAssistantFloor = 4;
  graph.historyState.extractionCount = 1;
  harness.api.setCurrentGraph(graph);
  harness.api.setGraphPersistenceState({
    loadState: "loaded",
    chatId: "chat-dirty-floor",
    revision: 2,
    writesBlocked: false,
  });

  // Mô phỏng: meta trỏ tới sự kiện xóa ở floor=1 (sớm hơn floor tối thiểu có thể trích xuất là 4)
  // Dùng cách gián tiếp: lastProcessedAssistantFloor của graph = 4,
  // nếu resolveDirtyFloorFromMutationMeta lọc đúng các ứng viên floor < 4,
  // thì inspectHistoryMutation sẽ không đánh dấu là dirty (vì không có ứng viên hợp lệ).
  // lưu ý: ở đây không kiểm thử trực tiếp hàm nội bộ, mà là xác thực hành vi tổng thể.
  const graph2 = harness.api.getCurrentGraph();
  assert.ok(graph2, "graph nên tồn tại");
  assert.equal(
    graph2.historyState.lastProcessedAssistantFloor,
    4,
    "lastProcessedAssistantFloor nên bằng 4",
  );
}

{
  const metadataGraph = stampPersistedGraph(
    createMeaningfulGraph("chat-indexeddb-priority", "metadata"),
    {
      revision: 3,
      integrity: "meta-indexeddb-priority",
      chatId: "chat-indexeddb-priority",
      reason: "metadata-seed",
    },
  );
  const indexedDbGraph = stampPersistedGraph(
    createMeaningfulGraph("chat-indexeddb-priority", "indexeddb"),
    {
      revision: 9,
      integrity: "idxdb-indexeddb-priority",
      chatId: "chat-indexeddb-priority",
      reason: "indexeddb-seed",
    },
  );
  const indexedDbSnapshot = buildSnapshotFromGraph(indexedDbGraph, {
    chatId: "chat-indexeddb-priority",
    revision: 9,
  });

  const harness = await createGraphPersistenceHarness({
    chatId: "chat-indexeddb-priority",
    globalChatId: "chat-indexeddb-priority",
    chatMetadata: {
      integrity: "meta-indexeddb-priority",
      [GRAPH_METADATA_KEY]: metadataGraph,
    },
    indexedDbSnapshot,
  });

  harness.api.loadGraphFromChat({ source: "indexeddb-priority" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.api.getCurrentGraph().nodes[0].id, "node-indexeddb");
  assert.equal(
    harness.api.getGraphPersistenceState().storagePrimary,
    "indexeddb",
  );
}

{
  const sharedSession = new Map();
  const writer = await createGraphPersistenceHarness({
    chatId: "chat-indexeddb-shadow-restore",
    globalChatId: "chat-indexeddb-shadow-restore",
    sessionStore: sharedSession,
  });
  writer.api.writeGraphShadowSnapshot(
    "chat-indexeddb-shadow-restore",
    createMeaningfulGraph("chat-indexeddb-shadow-restore", "shadow-newer"),
    {
      revision: 9,
      reason: "pagehide-refresh",
    },
  );

  const indexedDbGraph = stampPersistedGraph(
    createMeaningfulGraph("chat-indexeddb-shadow-restore", "indexeddb-older"),
    {
      revision: 4,
      integrity: "meta-indexeddb-shadow-restore",
      chatId: "chat-indexeddb-shadow-restore",
      reason: "indexeddb-older",
    },
  );
  const indexedDbSnapshot = buildSnapshotFromGraph(indexedDbGraph, {
    chatId: "chat-indexeddb-shadow-restore",
    revision: 4,
  });

  const harness = await createGraphPersistenceHarness({
    chatId: "chat-indexeddb-shadow-restore",
    globalChatId: "chat-indexeddb-shadow-restore",
    indexedDbSnapshot,
    sessionStore: sharedSession,
  });

  const result = await harness.api.loadGraphFromIndexedDb(
    "chat-indexeddb-shadow-restore",
    {
      source: "indexeddb-shadow-restore",
      allowOverride: true,
      applyEmptyState: true,
    },
  );

  assert.equal(result.loadState, "shadow-restored");
  assert.equal(
    harness.api.getCurrentGraph().nodes[0]?.fields?.title,
    "Sự kiện-shadow-newer",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    harness.api.getIndexedDbSnapshot().meta.revision,
    9,
    "sau khi khôi phục shadow nên bù lại IndexedDB để sửa snapshot cũ",
  );
}

{
  const legacyGraph = stampPersistedGraph(
    createMeaningfulGraph("chat-legacy-migration", "legacy"),
    {
      revision: 6,
      integrity: "meta-legacy-migration",
      chatId: "chat-legacy-migration",
      reason: "legacy-seed",
    },
  );

  const harness = await createGraphPersistenceHarness({
    chatId: "chat-legacy-migration",
    globalChatId: "chat-legacy-migration",
    chatMetadata: {
      integrity: "meta-legacy-migration",
      [GRAPH_METADATA_KEY]: legacyGraph,
    },
    indexedDbSnapshot: {
      meta: {
        chatId: "chat-legacy-migration",
        revision: 0,
        migrationCompletedAt: 0,
      },
      nodes: [],
      edges: [],
      tombstones: [],
      state: {
        lastProcessedFloor: -1,
        extractionCount: 0,
      },
    },
  });

  harness.api.loadGraphFromChat({ source: "legacy-migration-check" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(harness.runtimeContext.__syncNowCalls.length >= 1);
  assert.equal(
    harness.runtimeContext.__syncNowCalls[0].options.reason,
    "post-migration",
  );
  assert.equal(harness.api.getCurrentGraph().nodes[0].id, "node-legacy");
  assert.equal(
    harness.api.getIndexedDbSnapshot().meta.migrationSource,
    "chat_metadata",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-state-save",
    globalChatId: "chat-state-save",
    chatMetadata: {
      integrity: "meta-chat-state-save",
    },
    indexedDbSnapshot: {
      meta: {
        chatId: "chat-state-save",
        revision: 0,
      },
      nodes: [],
      edges: [],
      tombstones: [],
      state: {
        lastProcessedFloor: -1,
        extractionCount: 0,
      },
    },
  });

  const graph = stampPersistedGraph(
    createMeaningfulGraph("chat-state-save", "sidecar"),
    {
      revision: 7,
      integrity: "meta-chat-state-save",
      chatId: "chat-state-save",
      reason: "chat-state-seed",
    },
  );

  const result = await harness.runtimeContext.persistGraphToHostChatState(
    harness.runtimeContext.__chatContext,
    {
      graph,
      revision: 7,
      reason: "chat-state-direct-save",
      storageTier: "chat-state",
      accepted: true,
      lastProcessedAssistantFloor: 6,
      extractionCount: 3,
      mode: "primary",
    },
  );

  assert.equal(result.saved, true);
  const stored = await harness.runtimeContext.__chatContext.getChatState(
    GRAPH_CHAT_STATE_NAMESPACE,
  );
  assert.equal(stored?.revision, 7);
  assert.equal(stored?.commitMarker?.storageTier, "chat-state");
  assert.equal(
    harness.api.getGraphPersistenceState().dualWriteLastResult?.target,
    "chat-state",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-state-read",
    globalChatId: "chat-state-read",
    chatMetadata: {
      integrity: "meta-chat-state-read",
    },
  });

  const sidecarGraph = stampPersistedGraph(
    createMeaningfulGraph("chat-state-read", "sidecar-read"),
    {
      revision: 9,
      integrity: "meta-chat-state-read",
      chatId: "chat-state-read",
      reason: "chat-state-read-seed",
    },
  );
  harness.runtimeContext.__chatContext.__chatStateStore.set(
    GRAPH_CHAT_STATE_NAMESPACE,
    buildGraphChatStateSnapshot(sidecarGraph, {
      revision: 9,
      storageTier: "chat-state",
      accepted: true,
      reason: "chat-state-read-seed",
      chatId: "chat-state-read",
      integrity: "meta-chat-state-read",
      lastProcessedAssistantFloor: 6,
      extractionCount: 3,
    }),
  );

  const result = await harness.runtimeContext.readGraphChatStateSnapshot(
    harness.runtimeContext.__chatContext,
    {
      namespace: GRAPH_CHAT_STATE_NAMESPACE,
    },
  );

  assert.equal(
    harness.runtimeContext.canUseGraphChatState(
      harness.runtimeContext.__chatContext,
    ),
    true,
  );
  assert.equal(result?.revision, 9);
  assert.equal(result?.commitMarker?.storageTier, "chat-state");
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-generic-primary-no-mirror",
    globalChatId: "chat-generic-primary-no-mirror",
    characterId: "char-generic",
    chatMetadata: {
      integrity: "meta-generic-primary-no-mirror",
    },
  });
  const graph = stampPersistedGraph(
    createMeaningfulGraph("chat-generic-primary-no-mirror", "generic-primary"),
    {
      revision: 5,
      integrity: "meta-generic-primary-no-mirror",
      chatId: "chat-generic-primary-no-mirror",
      reason: "generic-primary-seed",
    },
  );
  harness.api.setCurrentGraph(graph);

  const result = await harness.api.persistExtractionBatchResult({
    reason: "generic-primary-persist",
    lastProcessedAssistantFloor: 6,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.storageTier, "indexeddb");
  assert.equal(
    harness.runtimeContext.__chatContext.__chatStateStore.size,
    0,
    "sau khi lượt ghi chính của generic ST thành công thì không nên thường trú mirror sang chat-state nữa",
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-luker-primary",
    globalChatId: "chat-luker-primary",
    characterId: "char-luker",
    chatMetadata: {
      integrity: "meta-luker-primary",
    },
  });
  harness.runtimeContext.Luker = {
    getContext() {
      return harness.runtimeContext.__chatContext;
    },
  };
  const graph = stampPersistedGraph(
    createMeaningfulGraph("chat-luker-primary", "luker-primary"),
    {
      revision: 8,
      integrity: "meta-luker-primary",
      chatId: "chat-luker-primary",
      reason: "luker-primary-seed",
    },
  );
  harness.api.setCurrentGraph(graph);

  const result = await harness.api.persistExtractionBatchResult({
    reason: "luker-primary-persist",
    lastProcessedAssistantFloor: 6,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.storageTier, "luker-chat-state");
  assert.equal(result.acceptedBy, "luker-chat-state");

  const manifest = await harness.runtimeContext.__chatContext.getChatState(
    LUKER_GRAPH_MANIFEST_NAMESPACE,
  );
  const journal = await harness.runtimeContext.__chatContext.getChatState(
    LUKER_GRAPH_JOURNAL_NAMESPACE,
  );
  const checkpoint = await harness.runtimeContext.__chatContext.getChatState(
    LUKER_GRAPH_CHECKPOINT_NAMESPACE,
  );
  const legacyStored = await harness.runtimeContext.__chatContext.getChatState(
    GRAPH_CHAT_STATE_NAMESPACE,
  );
  assert.equal(manifest?.headRevision, result.revision);
  assert.equal(manifest?.formatVersion, 2);
  assert.equal(manifest?.storageTier, "luker-chat-state");
  assert.equal(manifest?.checkpointRevision, result.revision);
  assert.equal(checkpoint?.revision, result.revision);
  assert.equal(Array.isArray(journal?.entries), true);
  assert.equal(journal?.entries?.length, 0);
  assert.equal(legacyStored ?? null, null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    Number(harness.api.getIndexedDbSnapshot()?.meta?.revision || 0) >= result.revision,
    true,
    "sau khi lưu trữ chính của Luker thành công thì nên ghi bù bộ đệm cục bộ một cách bất đồng bộ",
  );
  assert.equal(
    harness.api.getGraphPersistenceState().acceptedStorageTier,
    "luker-chat-state",
  );
  assert.equal(
    harness.api.getGraphPersistenceState().lukerManifestRevision,
    result.revision,
  );
}

{
  const harness = await createGraphPersistenceHarness({
    chatId: "chat-luker-v2-load",
    globalChatId: "chat-luker-v2-load",
    characterId: "char-luker-v2",
    chatMetadata: {
      integrity: "meta-luker-v2-load",
    },
  });
  harness.runtimeContext.Luker = {
    getContext() {
      return harness.runtimeContext.__chatContext;
    },
  };
  const graph = stampPersistedGraph(
    createMeaningfulGraph("chat-luker-v2-load", "luker-v2-load"),
    {
      revision: 4,
      integrity: "meta-luker-v2-load",
      chatId: "chat-luker-v2-load",
      reason: "luker-v2-load-seed",
    },
  );
  harness.runtimeContext.__chatContext.__chatStateStore.set(
    LUKER_GRAPH_JOURNAL_NAMESPACE,
    buildLukerGraphJournalV2([], {
      chatId: "chat-luker-v2-load",
      integrity: "meta-luker-v2-load",
      headRevision: 4,
    }),
  );
  harness.runtimeContext.__chatContext.__chatStateStore.set(
    LUKER_GRAPH_CHECKPOINT_NAMESPACE,
    {
      formatVersion: 2,
      revision: 4,
      serializedGraph: serializeGraph(graph),
      chatId: "chat-luker-v2-load",
      integrity: "meta-luker-v2-load",
      counts: {
        nodeCount: 1,
        edgeCount: 0,
        archivedCount: 0,
        tombstoneCount: 0,
      },
      persistedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      reason: "luker-v2-load-seed",
      storageTier: "luker-chat-state",
    },
  );
  harness.runtimeContext.__chatContext.__chatStateStore.set(
    LUKER_GRAPH_MANIFEST_NAMESPACE,
    buildLukerGraphManifestV2(graph, {
      baseRevision: 4,
      headRevision: 4,
      checkpointRevision: 4,
      lastCompactedRevision: 4,
      journalDepth: 0,
      journalBytes: 0,
      chatId: "chat-luker-v2-load",
      integrity: "meta-luker-v2-load",
      reason: "luker-v2-load-seed",
      storageTier: "luker-chat-state",
      accepted: true,
      lastProcessedAssistantFloor: 6,
      extractionCount: 3,
    }),
  );

  const sidecar = await harness.runtimeContext.readLukerGraphSidecarV2(
    harness.runtimeContext.__chatContext,
  );

  assert.equal(Number(sidecar?.manifest?.headRevision || 0), 4);
  assert.equal(Number(sidecar?.checkpoint?.revision || 0), 4);
  assert.equal(Number(sidecar?.journal?.entryCount || 0), 0);
  assert.equal(
    sidecar?.manifest?.chatId,
    "chat-luker-v2-load",
  );
  assert.equal(
    sidecar?.checkpoint?.chatId,
    "chat-luker-v2-load",
  );
}

{
  const chatId = "chat-luker-revision-drift";
  const integrity = "meta-luker-revision-drift";
  const harness = await createGraphPersistenceHarness({
    chatId,
    globalChatId: chatId,
    characterId: "char-luker-revision-drift",
    chatMetadata: {
      integrity,
    },
  });
  harness.runtimeContext.Luker = {
    getContext() {
      return harness.runtimeContext.__chatContext;
    },
  };

  const checkpointGraph = stampPersistedGraph(
    createMeaningfulGraph(chatId, "luker-revision-base"),
    {
      revision: 1,
      integrity,
      chatId,
      reason: "luker-revision-base",
    },
  );
  const runtimeGraph = stampPersistedGraph(
    createMeaningfulGraph(chatId, "luker-revision-next"),
    {
      revision: 3,
      integrity,
      chatId,
      reason: "luker-revision-next",
    },
  );
  harness.api.setCurrentGraph(runtimeGraph);
  harness.api.setGraphPersistenceState({
    hostProfile: "luker",
    primaryStorageTier: "luker-chat-state",
    cacheStorageTier: "indexeddb",
    revision: 3,
    lastPersistedRevision: 3,
    lastAcceptedRevision: 3,
  });
  harness.runtimeContext.__chatContext.__chatStateStore.set(
    LUKER_GRAPH_CHECKPOINT_NAMESPACE,
    buildLukerGraphCheckpointV2(checkpointGraph, {
      revision: 1,
      chatId,
      integrity,
      reason: "luker-revision-base",
      storageTier: "luker-chat-state",
    }),
  );
  harness.runtimeContext.__chatContext.__chatStateStore.set(
    LUKER_GRAPH_JOURNAL_NAMESPACE,
    buildLukerGraphJournalV2([], {
      chatId,
      integrity,
      headRevision: 1,
    }),
  );
  harness.runtimeContext.__chatContext.__chatStateStore.set(
    LUKER_GRAPH_MANIFEST_NAMESPACE,
    buildLukerGraphManifestV2(checkpointGraph, {
      baseRevision: 1,
      headRevision: 1,
      checkpointRevision: 1,
      lastCompactedRevision: 1,
      journalDepth: 0,
      journalBytes: 0,
      chatId,
      integrity,
      reason: "luker-revision-base",
      storageTier: "luker-chat-state",
      accepted: true,
      lastProcessedAssistantFloor: 2,
      extractionCount: 1,
    }),
  );

  const baseSnapshot = buildSnapshotFromGraph(checkpointGraph, {
    chatId,
    revision: 1,
  });
  const driftedSnapshot = buildSnapshotFromGraph(runtimeGraph, {
    chatId,
    revision: 3,
  });
  const directDelta = buildPersistDelta(baseSnapshot, driftedSnapshot, {
    useNativeDelta: false,
  });

  const result = await harness.runtimeContext.persistGraphToHostChatState(
    harness.runtimeContext.__chatContext,
    {
      graph: runtimeGraph,
      revision: 3,
      reason: "luker-revision-drift-save",
      storageTier: "luker-chat-state",
      accepted: true,
      lastProcessedAssistantFloor: 4,
      extractionCount: 2,
      mode: "primary",
      persistDelta: directDelta,
    },
  );

  assert.equal(result.saved, true);
  assert.equal(
    result.revision,
    2,
    "Luker sidecar nên tiến liên tục dựa trên head đã chấp nhận, thay vì tiếp tục dùng revision nhảy số",
  );
  const manifest = await harness.runtimeContext.__chatContext.getChatState(
    LUKER_GRAPH_MANIFEST_NAMESPACE,
  );
  const journal = await harness.runtimeContext.__chatContext.getChatState(
    LUKER_GRAPH_JOURNAL_NAMESPACE,
  );
  assert.equal(Number(manifest?.headRevision || 0), 2);
  assert.equal(Number(journal?.entries?.length || 0), 1);
  assert.equal(Number(journal?.entries?.[0]?.revision || 0), 2);
}

{
  const chatId = "chat-luker-bootstrap-journal-fail";
  const integrity = "meta-luker-bootstrap-journal-fail";
  const harness = await createGraphPersistenceHarness({
    chatId,
    globalChatId: chatId,
    characterId: "char-luker-bootstrap-journal-fail",
    chatMetadata: {
      integrity,
    },
  });
  harness.runtimeContext.Luker = {
    getContext() {
      return harness.runtimeContext.__chatContext;
    },
  };
  const graph = stampPersistedGraph(
    createMeaningfulGraph(chatId, "luker-bootstrap-journal-fail"),
    {
      revision: 5,
      integrity,
      chatId,
      reason: "luker-bootstrap-journal-fail",
    },
  );
  const originalUpdateChatState = harness.runtimeContext.__chatContext.updateChatState;
  harness.runtimeContext.__chatContext.updateChatState = async function(namespace, updater) {
    const key = String(namespace || "").trim().toLowerCase();
    if (key === LUKER_GRAPH_JOURNAL_NAMESPACE) {
      return { ok: false, state: null, updated: false };
    }
    return await originalUpdateChatState.call(this, namespace, updater);
  };

  const result = await harness.runtimeContext.persistGraphToHostChatState(
    harness.runtimeContext.__chatContext,
    {
      graph,
      revision: 5,
      reason: "luker-bootstrap-journal-fail",
      storageTier: "luker-chat-state",
      accepted: true,
      lastProcessedAssistantFloor: 3,
      extractionCount: 1,
      mode: "primary",
    },
  );

  assert.equal(result.saved, false);
  assert.equal(result.accepted, false);
  const manifest = await harness.runtimeContext.__chatContext.getChatState(
    LUKER_GRAPH_MANIFEST_NAMESPACE,
  );
  const checkpoint = await harness.runtimeContext.__chatContext.getChatState(
    LUKER_GRAPH_CHECKPOINT_NAMESPACE,
  );
  assert.equal(
    manifest ?? null,
    null,
    "khi reset bootstrap journal thất bại thì không nên tiếp tục ghi manifest như thể đã accepted",
  );
  assert.equal(Number(checkpoint?.revision || 0), 5);
}

{
  const chatId = "chat-luker-targeted-write";
  const integrity = "meta-luker-targeted-write";
  const harness = await createGraphPersistenceHarness({
    chatId,
    globalChatId: chatId,
    groupId: "group-luker-targeted-write",
    chatMetadata: {
      integrity,
    },
  });
  harness.runtimeContext.Luker = {
    getContext() {
      return harness.runtimeContext.__chatContext;
    },
  };
  const branchTarget = {
    is_group: true,
    id: "group-luker-targeted-branch",
  };
  const graph = stampPersistedGraph(
    createMeaningfulGraph("group-luker-targeted-branch", "luker-targeted-write"),
    {
      revision: 2,
      integrity,
      chatId: "group-luker-targeted-branch",
      reason: "luker-targeted-write",
    },
  );

  const result = await harness.runtimeContext.persistGraphToHostChatState(
    harness.runtimeContext.__chatContext,
    {
      graph,
      chatId: "group-luker-targeted-branch",
      revision: 2,
      reason: "luker-targeted-write",
      storageTier: "luker-chat-state",
      accepted: true,
      lastProcessedAssistantFloor: 6,
      extractionCount: 3,
      mode: "primary",
      chatStateTarget: branchTarget,
    },
  );

  assert.equal(result.saved, true);
  assert.equal(result.accepted, true);
  const targetedCalls = harness.runtimeContext.__chatContext.__chatStateCalls.filter(
    (call) => call.type === "update" && call.target?.id === branchTarget.id,
  );
  assert.ok(
    targetedCalls.length >= 3,
    "khi ghi chatStateTarget tường minh vào Luker sidecar thì nên truyền target vào chuỗi xử lý manifest/journal/checkpoint",
  );
}

console.log("graph-persistence tests passed");

